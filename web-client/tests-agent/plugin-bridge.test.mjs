import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createPluginService } from '../plugin-service.mjs';
import { createBridge } from '../agent-bridge.mjs';

const sourceTools = [
  { name: 'talewisp_read_file', description: 'Read a source.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'talewisp_save_proposal', description: 'Prepare a proposal.', inputSchema: { type: 'object', properties: { proposal_type: { type: 'string' }, title: { type: 'string' }, source_path: { type: 'string' }, replacement_text: { type: 'string' }, summary: { type: 'string' } }, required: ['proposal_type', 'title', 'replacement_text'], additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'talewisp_apply_proposal', description: 'Apply only after approval.', inputSchema: { type: 'object', properties: { proposal_path: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['proposal_path', 'confirmed'], additionalProperties: false }, annotations: { readOnlyHint: false } },
  { name: 'talewisp_select_vault', description: 'Select vault.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'talewisp_fullworkflow_action', description: 'Mutating operation with native guard.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['action', 'confirmed'], additionalProperties: false }, annotations: { readOnlyHint: false } }
];

function nativeSpawn(log) {
  return (...spawnArgs) => {
    log.invocations.push(spawnArgs.slice(0, 3));
    const proc = new EventEmitter();
    proc.stdin = { write(line) {
      const request = JSON.parse(line);
      let result = {};
      if (request.method === 'tools/list') result = { tools: sourceTools };
      if (request.method === 'tools/call') { log.calls.push(request.params); result = { content: [{ type: 'text', text: 'native result' }], structuredContent: { ok: true } }; }
      if (request.id != null) setImmediate(() => proc.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)));
      return true;
    } };
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => { proc.emit('exit', 0); };
    log.processes.push(proc);
    return proc;
  };
}

function workspaceFixture() {
  const calls = [];
  const workspaceService = {
    root: async () => 'C:\\vault\\Author\\Series', revision: async () => 'rev-1',
    prepareProposal: async payload => { calls.push({ kind: 'prepare', payload }); return { id: 'proposal-1', ...payload }; },
    queueAction: async payload => { calls.push({ kind: 'queue', payload }); return { id: 'action-1', ...payload }; }
  };
  return { workspaceService, calls };
}

test('plugin inventory and read-only calls come from the installed MCP; writes stop at review proposals', async t => {
  const log = { calls: [], processes: [], invocations: [] };
  const { workspaceService, calls } = workspaceFixture();
  const service = createPluginService({ workspaceService, dataDir: 'unused', pythonExecutable: 'fixed-python', talewispMcpPath: 'fixed-plugin.py', spawnImpl: nativeSpawn(log) });
  t.after(() => service.shutdown());

  const tools = await service.tools();
  assert.deepEqual(tools.map(tool => tool.name), [...sourceTools.map(tool => tool.name), 'talewisp_web_google_list', 'talewisp_web_google_read', 'talewisp_web_google_suggest', 'talewisp_web_google_comment', 'talewisp_web_google_direct_edit', 'talewisp_web_google_insert', 'talewisp_web_google_create_note', 'talewisp_web_google_reply', 'talewisp_web_sheets_list', 'talewisp_web_sheets_read', 'talewisp_web_sheets_update']);
  assert.equal(tools.find(tool => tool.name === 'talewisp_web_google_list').annotations.readOnlyHint, true);
  assert.deepEqual(log.invocations[0].slice(0, 2), ['fixed-python', ['-u', 'fixed-plugin.py']]);
  assert.equal(log.invocations[0][2].shell, false);
  const read = await service.call('talewisp_read_file', { path: 'canon.md' }, 'rev-1');
  assert.equal(read.structuredContent.ok, true);
  assert.deepEqual(log.calls[0], { name: 'talewisp_read_file', arguments: { path: 'canon.md' } });

  const proposal = await service.call('talewisp_save_proposal', { proposal_type: 'revision', title: 'Revise scene', source_path: 'scene.md', replacement_text: 'new full text', summary: 'approved change' }, 'rev-1');
  assert.equal(proposal.status, 'pending_author_review');
  assert.deepEqual(calls.at(-1), { kind: 'prepare', payload: { path: 'scene.md', text: 'new full text', title: 'Revise scene', summary: 'approved change' } });

  await assert.rejects(service.call('talewisp_apply_proposal', { proposal_path: 'pending.md', confirmed: true }, 'rev-1'));
  assert.equal((await service.call('talewisp_select_vault', { path: 'C:\\outside' }, 'rev-1')).status, 'catalog_selection_required');
  assert.equal(log.calls.some(call => call.name === 'talewisp_select_vault' || call.name === 'talewisp_apply_proposal'), false);
  assert.equal((await service.call('talewisp_fullworkflow_action', { action: 'bind', confirmed: false }, 'rev-1')).status, 'pending_author_review');
  assert.deepEqual(calls.at(-1).payload.arguments, { action: 'bind', confirmed: false });
});

test('native Google reads require OAuth; suggestion and comment writes queue exact payloads and apply only through the UI callback', async t => {
  const log = { calls: [], processes: [], invocations: [] };
  const { workspaceService, calls } = workspaceFixture();
  const googleCalls = [];
  const googleService = {
    status: async () => ({ configured: true, authenticated: true }),
    readDocument: async documentId => { googleCalls.push({ kind: 'read', documentId }); return { documentId, revisionId: 'google-r1', tabs: [] }; },
    suggest: async payload => { googleCalls.push({ kind: 'suggest', payload }); return { state: 'succeeded', operationId: payload.operationId }; },
    comment: async payload => { googleCalls.push({ kind: 'comment', payload }); return { state: 'succeeded', operationId: payload.operationId }; }
  };
  const service = createPluginService({ workspaceService, dataDir: 'unused', pythonExecutable: 'fixed-python', talewispMcpPath: 'fixed-plugin.py', spawnImpl: nativeSpawn(log), googleService });
  t.after(() => service.shutdown());
  const fullRange = { documentId: 'doc-1', tabId: '', revisionId: 'rev-5', startIndex: 11, endIndex: 19, quote: 'a sentence', operationId: 'operation-0001' };
  const comment = { ...fullRange, text: 'Please review this claim.' };
  const suggestion = { ...fullRange, replacement: 'a revised sentence' };

  const read = await service.call('talewisp_web_google_read', { documentId: 'doc-1' }, 'rev-1');
  assert.equal(read.revisionId, 'google-r1');
  const queuedSuggestion = await service.call('talewisp_web_google_suggest', suggestion, 'rev-1');
  const queuedComment = await service.call('talewisp_web_google_comment', comment, 'rev-1');
  assert.equal(queuedSuggestion.status, 'pending_author_review');
  assert.equal(queuedComment.status, 'pending_author_review');
  assert.deepEqual(calls.slice(-2).map(call => call.payload.arguments), [suggestion, comment]);
  assert.equal(googleCalls.length, 1, 'a model tool call cannot write to Google');

  await service.applyAction({ tool: 'talewisp_web_google_suggest', arguments: suggestion, workspaceRevision: 'rev-1' });
  await service.applyAction({ tool: 'talewisp_web_google_comment', arguments: comment, workspaceRevision: 'rev-1' });
  assert.deepEqual(googleCalls.slice(1), [{ kind: 'suggest', payload: suggestion }, { kind: 'comment', payload: comment }]);
});

test('agent bridge fetches the actual catalog and binds every private call to its configured revision', async () => {
  const requests = [];
  const bridge = createBridge({ url: new URL('http://127.0.0.1:7777/api/internal/agent-tool'), token: 'x'.repeat(48), workspaceRevision: 'rev-9', fetchImpl: async (url, options) => {
    requests.push({ url: url.href, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => requests.at(-1).body.name === '__list_tools' ? { tools: sourceTools } : { content: [{ type: 'text', text: 'ok' }] } };
  } });
  assert.deepEqual(await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'talewisp-private-bridge', version: '0.1.0' } } });
  const listed = await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.result.tools.length, sourceTools.length);
  const called = await bridge.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'talewisp_read_file', arguments: { path: 'card.md' } } });
  assert.equal(called.result.content[0].text, 'ok');
  assert.deepEqual(requests.map(request => request.body.name), ['__list_tools', 'talewisp_read_file']);
  assert.ok(requests.every(request => request.body.workspaceRevision === 'rev-9'));
  assert.ok(requests.every(request => request.options.headers.authorization === `Bearer ${'x'.repeat(48)}`));
  assert.equal((await bridge.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'talewisp_forged', arguments: {} } })).error.code, -32602);
});

test('installed TaleWisp bridge exposes all source tools and reads only the selected temporary fixture', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'talewisp-agent-plugin-fixture-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  writeFileSync(join(fixtureRoot, 'fixture.md'), 'Temporary source fixture for tool execution.', 'utf8');
  const proposals = [];
  const workspaceService = {
    root: async () => fixtureRoot, revision: async () => 'fixture-revision-1',
    prepareProposal: async payload => { proposals.push(payload); return { id: 'fixture-proposal', ...payload }; },
    queueAction: async payload => { proposals.push(payload); return { id: 'fixture-action', ...payload }; }
  };
  const service = createPluginService({ workspaceService, dataDir: fixtureRoot, pythonExecutable: 'python', talewispMcpPath: fileURLToPath(new URL('../../plugin/scripts/talewisp_mcp.py', import.meta.url)) });
  t.after(() => service.shutdown());
  const inventory = await service.tools();
  assert.equal(inventory.length, 47);
  const read = await service.call('talewisp_read_file', { path: 'fixture.md' }, 'fixture-revision-1');
  assert.match(read.content[0].text, /Temporary source fixture/);
  const pending = await service.call('talewisp_save_proposal', { proposal_type: 'revision', title: 'Fixture proposal', source_path: 'fixture.md', replacement_text: 'Proposed full fixture replacement.' }, 'fixture-revision-1');
  assert.equal(pending.status, 'pending_author_review');
  const staged = await service.call('talewisp_storyart_stage_art', { request: { pair_id: 'fixture-pair', generation_id: 'fixture-generation' } }, 'fixture-revision-1');
  assert.equal(staged.status, 'pending_author_review');
  assert.deepEqual(proposals.at(-1).tool, 'talewisp_storyart_stage_art');
  assert.equal(proposals.length, 2);
  await assert.rejects(service.call('talewisp_web_google_read', { documentId: 'doc-1' }, 'fixture-revision-1'), /Google Workspace is not connected/);
  await assert.rejects(service.call('talewisp_web_google_list', { query: 'fixture' }, 'fixture-revision-1'), /Google Workspace is not connected/);
});

test('model-selection and series-base queued paths stay within the project and active data roots', async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'talewisp-path-guard-fixture-'));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const input = join(fixtureRoot, 'book.md');
  writeFileSync(input, 'A supplied fixture source.\n', 'utf8');
  const queued = [];
  const workspaceService = { root: async () => fixtureRoot, revision: async () => 'fixture-revision-paths', queueAction: async payload => { queued.push(payload); return { id: `action-${queued.length}`, ...payload }; } };
  const service = createPluginService({ workspaceService, dataDir: fixtureRoot, pythonExecutable: 'python', talewispMcpPath: fileURLToPath(new URL('../../plugins/talewisp/scripts/talewisp_mcp.py', import.meta.url)) });
  t.after(() => service.shutdown());
  await assert.rejects(service.call('talewisp_model_selection', { choice: 'project', model: 'gpt-6-luna', effort: 'high', project_root: tmpdir() }, 'fixture-revision-paths'), /escapes the current project/);
  await service.call('talewisp_model_selection', { choice: 'project', model: 'gpt-6-luna', effort: 'high', project_root: process.cwd() }, 'fixture-revision-paths');
  await assert.rejects(service.call('talewisp_build_series_base', { action: 'prepare', files: [fileURLToPath(new URL('../../plugins/talewisp/scripts/talewisp_mcp.py', import.meta.url))] }, 'fixture-revision-paths'), /must stay inside/);
  await service.call('talewisp_build_series_base', { action: 'prepare', files: [input] }, 'fixture-revision-paths');
  assert.equal(queued.length, 2);
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
function projectFixture(prefix) {
  const parent = join(process.cwd(), '.agent', 'tests-agent');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}

test('native saved proposal is previewed with hashes and only trusted UI apply changes source with backup', async t => {
  const fixtureRoot = projectFixture('talewisp-native-apply-fixture-');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const sourceText = 'Original complete scene text.\n';
  writeFileSync(join(fixtureRoot, 'scene.md'), sourceText, 'utf8');
  const queued = [];
  const workspaceService = {
    root: async () => fixtureRoot,
    revision: async () => 'fixture-revision-1',
    queueAction: async payload => { const row = { id: `action-${queued.length + 1}`, ...payload, workspaceRevision: 'fixture-revision-1' }; queued.push(row); return row; }
  };
  const service = createPluginService({ workspaceService, dataDir: fixtureRoot, pythonExecutable: 'python', talewispMcpPath: fileURLToPath(new URL('../../plugins/talewisp/scripts/talewisp_mcp.py', import.meta.url)) });
  t.after(() => service.shutdown());
  await service.tools();
  const nativeClient = await service._client();
  const replacement = 'Complete revised scene text.\n';
  const native = await nativeClient.request('tools/call', { name: 'talewisp_save_proposal', arguments: { proposal_type: 'revision', title: 'Fixture revision', source_path: 'scene.md', replacement_text: replacement, summary: 'Exact test change' } });
  const proposalPath = native.structuredContent.proposal;
  assert.ok(proposalPath);
  const beforeHash = sha256(sourceText);
  const staged = await service.call('talewisp_apply_proposal', { proposal_path: proposalPath, confirmed: true }, 'fixture-revision-1');
  assert.equal(staged.status, 'pending_author_review');
  const action = queued.at(-1);
  assert.equal(action.arguments.confirmed, false, 'model-provided confirmation is discarded');
  assert.equal(action.arguments._review.source.before, sourceText);
  assert.equal(action.arguments._review.source.beforeSha256, beforeHash);
  assert.equal(action.arguments._review.after, replacement);
  assert.equal(action.arguments._review.proposalSha256, sha256(readFileSync(join(fixtureRoot, proposalPath))));
  assert.equal(readFileSync(join(fixtureRoot, 'scene.md'), 'utf8'), sourceText, 'preparation must not apply the change');

  let applied;
  try { applied = await service.applyAction(action); } catch (error) { throw new Error(`${error.message}\n${nativeClient.stderr}`); }
  assert.ok(applied.structuredContent.applied.endsWith('.json'));
  const appliedSource = readFileSync(join(fixtureRoot, 'scene.md'), 'utf8').replace(/\r\n?/g, '\n');
  assert.equal(appliedSource, replacement);
  assert.equal(applied.structuredContent.new_sha256, sha256(appliedSource));
  assert.ok(applied.structuredContent.backup);
  const backupPath = join(fixtureRoot, ...applied.structuredContent.backup.split('/'));
  assert.equal(readFileSync(backupPath, 'utf8'), sourceText);
  assert.equal(sha256(readFileSync(backupPath)), beforeHash);
});

test('native continuity stage is queued with its receipt and exact preview before trusted UI apply', async t => {
  const fixtureRoot = projectFixture('talewisp-native-continuity-fixture-');
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const sourceText = 'Scene 1: Lev learned the key is under the stone.\nScene 2: Lev took the key.\n';
  writeFileSync(join(fixtureRoot, 'source.md'), sourceText, 'utf8');
  const queued = [];
  const workspaceService = {
    root: async () => fixtureRoot,
    revision: async () => 'fixture-revision-2',
    queueAction: async payload => { const row = { id: `action-${queued.length + 1}`, ...payload, workspaceRevision: 'fixture-revision-2' }; queued.push(row); return row; }
  };
  const service = createPluginService({ workspaceService, dataDir: fixtureRoot, pythonExecutable: 'python', talewispMcpPath: fileURLToPath(new URL('../../plugins/talewisp/scripts/talewisp_mcp.py', import.meta.url)) });
  t.after(() => service.shutdown());
  await service.tools();
  const nativeClient = await service._client();
  const prepared = await nativeClient.request('tools/call', { name: 'talewisp_prepare_continuity_extraction', arguments: { source_paths: ['source.md'] } });
  const packet = prepared.structuredContent;
  const evidence = { path: 'source.md', sha256: packet.sources[0].sha256, quote: sourceText };
  const row = (id, claim, extra = {}) => ({ id, claim, evidence: structuredClone(evidence), status: 'proposal', ...extra });
  const candidate = {
    version: 1, source_packet_sha256: packet.source_packet_sha256, extractor_id: 'fixture-extractor',
    coverage: { scope: 'supplied_sources_only', complete: true, omissions: [] },
    scenes: [row('s1', 'Lev learned about the key.', { story_order: 1, narrative_order: 1 }), row('s2', 'Lev took the key.', { story_order: 2, narrative_order: 2 })],
    entities: [row('hero', 'Lev')],
    facts: [row('key', 'The key is under the stone.', { text: 'The key is under the stone.', truth: 'true' })],
    assertions: [row('learn', 'Lev learns the key location in the first scene.', { kind: 'learn', scene_id: 's1', entity_id: 'hero', fact_id: 'key' }), row('reveal', 'The reader learns the key location in the first scene.', { kind: 'reveal', scene_id: 's1', fact_id: 'key' }), row('use', 'Lev uses the knowledge in the second scene.', { kind: 'knowledge_use', scene_id: 's2', entity_id: 'hero', fact_id: 'key' })]
  };
  const collections = ['scenes', 'entities', 'facts', 'assertions'];
  const review = { type: 'independent_semantic_review', reviewer_id: 'fixture-reviewer', source_packet_sha256: packet.source_packet_sha256, candidate_sha256: sha256(canonical(candidate)), records: collections.flatMap(kind => candidate[kind].map(record => ({ record: `${kind}:${record.id}`, record_sha256: sha256(canonical(record)), verdict: 'supported', reason: 'Supported by the supplied source.' }))) };
  const staged = await nativeClient.request('tools/call', { name: 'talewisp_stage_continuity_extraction', arguments: { source_paths: ['source.md'], source_packet_sha256: packet.source_packet_sha256, candidate, review, target_path: 'continuity.json' } });
  assert.equal(staged.isError, false, JSON.stringify(staged.content));
  const proposalPath = staged.structuredContent.proposal;
  const queuedApply = await service.call('talewisp_apply_proposal', { proposal_path: proposalPath, target_path: 'continuity.json', confirmed: true }, 'fixture-revision-2');
  assert.equal(queuedApply.status, 'pending_author_review');
  const action = queued.at(-1);
  assert.equal(action.arguments.confirmed, false);
  assert.equal(action.arguments._review.source.before, null);
  assert.equal(action.arguments._review.source.targetPath, 'continuity.json');
  assert.equal(action.arguments._review.proposalSha256, sha256(readFileSync(join(fixtureRoot, proposalPath))));
  assert.equal(existsSync(join(fixtureRoot, 'continuity.json')), false);
  let applied;
  try { applied = await service.applyAction(action); } catch (error) { throw new Error(`${error.message}\n${nativeClient.stderr}`); }
  assert.ok(applied.structuredContent.applied.endsWith('.json'));
  const appliedContract = JSON.parse(readFileSync(join(fixtureRoot, 'continuity.json'), 'utf8'));
  assert.equal(applied.structuredContent.new_sha256, sha256(action.arguments._review.after));
  assert.equal(sha256(canonical(appliedContract)), action.arguments._review.proposal.continuity_extraction.replacement_sha256);
  assert.equal(readFileSync(join(fixtureRoot, 'source.md'), 'utf8'), sourceText);
});
