import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { AgentService, JsonlRunner } from '../agent.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'talewisp-agent-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new Map([['agent.threadId', 'old-thread']]);
  const messages = [];
  const scopes = [];
  const store = { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value), listMessages: () => messages, addMessage() {}, setMessageScope: value => scopes.push(value) };
  const inventory = Array.from({ length: 33 }, (_, index) => ({ name: `talewisp_tool_${index}` }));
  const workspaceCalls = [];
  const workspaceService = {
    revision: async () => 'workspace-revision-4',
    catalog: async () => ({ authors: [{ id: 'a1', name: 'Author', series: [{ id: 's1', name: 'Series', books: [{ id: 'b1', name: 'Book' }] }] }] }),
    selection: async () => ({ authorId: 'a1', seriesId: 's1', bookId: 'b1' }),
    overview: async () => ({ style: { available: true, excluded: true, exclusionReason: 'Author style excluded by author instruction.', paths: ['confirmed/author-style.md'], lexicalRules: ['04 Analysis/lexical dictionary.md'] } })
  };
  const pluginService = { tools: async () => inventory, setWorkspace: async () => workspaceCalls.push('closed') };
  const agent = new AgentService({ dataDir: join(root, 'data'), store, vaultPath: join(root, 'vault-a'), workspaceService, pluginService, internalToolUrl: 'http://127.0.0.1:4444/api/internal/agent-tool', internalToolToken: 'secret-random-token-value-1234567890' });
  return { root, agent, store, settings, scopes, messages, inventory, workspaceCalls, workspaceService };
}

test('runtime config enables the full dynamic inventory through the private Node bridge', async t => {
  const { root, agent, inventory } = fixture(t);
  const tools = await agent._writeRuntimeConfig();
  const config = readFileSync(join(root, 'data', 'codex-home', 'config.toml'), 'utf8');
  assert.deepEqual(tools, inventory.map(tool => tool.name));
  assert.match(config, /command = .*node/i);
  assert.match(config, /agent-bridge\.mjs/);
  assert.match(config, /TALEWISP_INTERNAL_TOOL_TOKEN = "secret-random-token-value-1234567890"/);
  assert.match(config, /TALEWISP_WORKSPACE_REVISION = "workspace-revision-4"/);
  assert.equal((config.match(/talewisp_tool_/g) ?? []).length, inventory.length);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /shell_tool = false/);
  assert.match(config, /apps = false/);
  assert.match(config, /multi_agent = false/);
  assert.equal(agent.status().security.totalTaleWispTools, inventory.length);
  assert.equal(agent.status().security.writeMode, 'author-approved-proposals');
  assert.equal(Object.hasOwn(agent.status().security, 'readOnlyTaleWispTools'), false);
});

test('Google queue tools are excluded from MCP approval inventory', async t => {
  const { root, agent, inventory } = fixture(t);
  agent.pluginService.tools = async () => [...inventory, { name: 'talewisp_web_google_suggest' }, { name: 'talewisp_web_google_comment' }];
  const enabled = await agent._writeRuntimeConfig();
  const config = readFileSync(join(root, 'data', 'codex-home', 'config.toml'), 'utf8');
  assert.equal(enabled.length, inventory.length);
  assert.equal(agent.status().security.totalTaleWispTools, inventory.length + 2);
  assert.doesNotMatch(config, /talewisp_web_google_(?:suggest|comment)/);
});

test('cold workspace startup refreshes scenario capabilities after account and model discovery', async t => {
  const { agent, inventory } = fixture(t);
  inventory.push({ name: 'talewisp_knowledge_at_scene' }, { name: 'talewisp_roleplay_readiness' });
  agent.pluginService.tools = async () => inventory;
  agent.pluginService.capabilities = async () => ({ configured: true, authenticated: true, connected: true });
  agent.runnerFactory = () => {
    const runner = new EventEmitter();
    const enabledTools = inventory.map(tool => tool.name).filter(name => !name.startsWith('talewisp_web_google_'));
    runner.closed = false;
    runner.exited = false;
    runner.effectiveConfig = { config: { approval_policy: 'never', sandbox_mode: 'read-only', features: { shell_tool: false, apps: false, multi_agent: false }, agents: { enabled: false }, mcp_servers: { talewisp: { enabled: true, required: true, enabled_tools: enabledTools } } } };
    runner.initialize = async () => {};
    runner.stop = async () => { runner.closed = true; runner.exited = true; return true; };
    runner.request = async method => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
      if (method === 'model/list') return { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: ['high'] }] };
      if (method === 'account/rateLimits/read') return {};
      throw new Error(`Unexpected request ${method}`);
    };
    return runner;
  };

  await agent.setWorkspace({ vaultPath: agent.vaultPath, selection: { authorId: 'a1', seriesId: 's1', bookId: 'b1' }, revision: 'workspace-revision-4' });
  const beforeConnect = agent.status();
  assert.equal(beforeConnect.scenarios.ordinary_writing.available, false);
  const status = await agent.connect();
  for (const id of ['ordinary_writing', 'continuation', 'revision', 'canon_research', 'knowledge_audit', 'onboarding', 'roleplay', 'calibration', 'google_workspace']) {
    assert.equal(status.scenarios[id].available, true, `${id} is enabled from the connected startup snapshot`);
  }
  assert.deepEqual(agent.googleCapabilities, { configured: true, authenticated: true, connected: true });
  assert.equal(agent.hostCapabilities.subagentDispatch, 'available');
  assert.equal(agent.turnText, '', 'no first user message is needed to refresh scenario capabilities');

  const workingFactory = agent.runtimeContractFactory;
  agent.runtimeContractFactory = async () => { throw new Error('contract refresh failed'); };
  const failedStatus = await agent.connect();
  assert.match(failedStatus.error, /contract refresh failed/);
  assert.equal(failedStatus.contractVersion, null);
  assert.equal(failedStatus.hostCapabilities.subagentDispatch, 'unavailable');
  assert.equal(failedStatus.hostCapabilities.googleNativeTools, 'unavailable');
  assert.deepEqual(failedStatus.scenarios, {}, 'failed refresh clears stale scenario availability');

  agent.runtimeContractFactory = workingFactory;
  agent._notification({ method: 'account/login/completed', params: { success: true } });
  await agent.refreshPromise;
  const loginRefreshed = agent.status();
  assert.equal(loginRefreshed.scenarios.ordinary_writing.available, true);
  assert.equal(loginRefreshed.scenarios.google_workspace.available, true);
});

test('the connected import profile continues to report Google-native tools unavailable', async t => {
  const { agent } = fixture(t);
  agent.importService = {};
  agent.activeImportJobId = 'job-1';
  agent.activeThreadProfile = 'import';
  agent.pluginService.capabilities = async () => ({ configured: true, authenticated: true, connected: true });
  agent.runnerFactory = () => {
    const runner = new EventEmitter();
    runner.closed = false;
    runner.exited = false;
    runner.effectiveConfig = { config: { approval_policy: 'never', sandbox_mode: 'read-only', features: { shell_tool: false, apps: false, multi_agent: false }, agents: { enabled: false }, mcp_servers: {} } };
    runner.initialize = async () => {};
    runner.stop = async () => { runner.closed = true; runner.exited = true; return true; };
    runner.request = async method => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: ['high'] }] };
      if (method === 'account/rateLimits/read') return {};
      throw new Error(`Unexpected request ${method}`);
    };
    return runner;
  };
  const status = await agent.connect({ profile: 'import-bootstrap' });
  assert.equal(agent.googleCapabilities, null);
  assert.equal(agent.hostCapabilities.googleNativeTools, 'unavailable');
  assert.equal(status.scenarios.google_workspace.available, false);
});

test('failed replacement runner startup clears availability from the previous connected snapshot', async t => {
  const { agent, inventory } = fixture(t);
  inventory.push({ name: 'talewisp_knowledge_at_scene' }, { name: 'talewisp_roleplay_readiness' });
  agent.pluginService.capabilities = async () => ({ configured: true, authenticated: true, connected: true });
  let starts = 0;
  agent.runnerFactory = () => {
    const runner = new EventEmitter();
    const enabledTools = inventory.map(tool => tool.name).filter(name => !name.startsWith('talewisp_web_google_'));
    runner.closed = false;
    runner.exited = false;
    runner.effectiveConfig = { config: { approval_policy: 'never', sandbox_mode: 'read-only', features: { shell_tool: false, apps: false, multi_agent: false }, agents: { enabled: false }, mcp_servers: { talewisp: { enabled: true, required: true, enabled_tools: enabledTools } } } };
    runner.initialize = async () => { starts++; if (starts === 2) throw new Error('replacement runner failed to initialize'); };
    runner.stop = async () => { runner.closed = true; runner.exited = true; return true; };
    runner.request = async method => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'plus' } };
      if (method === 'model/list') return { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: ['high'] }] };
      if (method === 'account/rateLimits/read') return {};
      throw new Error(`Unexpected request ${method}`);
    };
    return runner;
  };
  await agent.setWorkspace({ vaultPath: agent.vaultPath, selection: { authorId: 'a1', seriesId: 's1', bookId: 'b1' }, revision: 'workspace-revision-4' });
  const connected = await agent.connect();
  assert.equal(connected.scenarios.ordinary_writing.available, true);
  assert.equal(connected.scenarios.canon_research.available, true);
  assert.equal(connected.scenarios.roleplay.available, true);
  assert.equal(connected.scenarios.google_workspace.available, true);

  agent.runner.closed = true;
  const failed = await agent.connect();
  assert.equal(failed.available, false);
  assert.equal(failed.authenticated, true);
  assert.deepEqual(failed.models, []);
  assert.equal(failed.hostCapabilities.subagentDispatch, 'unavailable');
  assert.equal(failed.hostCapabilities.googleNativeTools, 'unavailable');
  for (const scenario of Object.values(failed.scenarios)) assert.equal(scenario.available, false);
});

test('Google queue client tools are attached to new threads and stage pending proposals only', async t => {
  const { agent, settings } = fixture(t);
  const calls = [];
  agent.pluginService.call = async (name, args, revision) => {
    calls.push({ name, args, revision });
    return { status: 'pending_author_review', proposal: { id: 'pending-1' } };
  };
  agent.workspaceRevision = 'workspace-revision-4';
  agent.workspaceSelection = { authorId: 'a1', seriesId: 's1', bookId: 'b1' };
  agent.runner = { request: async (method, params) => { calls.push({ method, params }); return { thread: { id: 'new-thread' } }; } };
  const threadId = await agent._ensureThread('model-1');
  assert.equal(threadId, 'new-thread');
  const start = calls.find(call => call.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.sandbox, 'read-only');
  assert.deepEqual(start.params.dynamicTools.map(tool => tool.name), ['talewisp_web_google_suggest', 'talewisp_web_google_comment', 'talewisp_runtime_resource', 'talewisp_delegate']);
  assert.match(settings.get('agent.dynamicToolsVersion'), /^google-proposal-queue-v1;runtime-contract:.+;roleplay:disabled$/);

  agent._notification({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
  const suggestion = { documentId: 'doc-1', tabId: '', revisionId: 'rev-5', startIndex: 11, endIndex: 19, quote: 'a sentence', replacement: 'a revised sentence', operationId: 'operation-0001' };
  const result = await agent._handleDynamicToolCall({ callId: 'call-1', namespace: null, turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_web_google_suggest', arguments: suggestion });
  assert.equal(result.status, 'pending_author_review');
  assert.deepEqual(calls.at(-1), { name: 'talewisp_web_google_suggest', args: suggestion, revision: 'workspace-revision-4' });
  const comment = { documentId: 'doc-1', tabId: '', revisionId: 'rev-5', startIndex: 11, endIndex: 19, quote: 'a sentence', text: 'Please review this sentence.', operationId: 'operation-0002' };
  const commentResult = await agent._handleDynamicToolCall({ callId: 'call-comment', turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_web_google_comment', arguments: comment });
  assert.equal(commentResult.status, 'pending_author_review');
  assert.deepEqual(calls.at(-1), { name: 'talewisp_web_google_comment', args: comment, revision: 'workspace-revision-4' });
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-null-tab', turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_web_google_suggest', arguments: { ...suggestion, tabId: null } }), /tabId must be a string/);
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-2', turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_arbitrary', arguments: suggestion }), /not permitted/);
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-3', turnId: 'turn-other', threadId: 'new-thread', tool: 'talewisp_web_google_suggest', arguments: suggestion }), /outside the active/);
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-4', turnId: 'turn-1', threadId: 'other-thread', tool: 'talewisp_web_google_suggest', arguments: suggestion }), /outside the active/);
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-5', turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_web_google_suggest', arguments: { ...suggestion, unexpected: true } }), /fields/i);
  assert.equal(calls.filter(call => call.name === 'talewisp_web_google_suggest').length, 1);
  agent._notification({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  await assert.rejects(agent._handleDynamicToolCall({ callId: 'call-6', turnId: 'turn-1', threadId: 'new-thread', tool: 'talewisp_web_google_suggest', arguments: suggestion }), /outside the active/);
});

test('legacy turns keep an ephemeral thread in memory after persistence cleanup and replace a failed resume', async t => {
  const { agent, settings } = fixture(t);
  agent.workspaceService = null;
  agent.pluginService = null;
  agent.workspaceSelection = null;
  agent.workspaceRevision = null;
  const calls = [];
  let turn = 0;
  let failResume = false;
  agent.runner = { closed: false, async request(method, params) {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'model-1', displayName: 'Model' }] };
    if (method === 'account/rateLimits/read') return {};
    if (method === 'thread/resume' && failResume) { failResume = false; throw new Error('resume failed'); }
    if (method === 'thread/resume') return {};
    if (method === 'thread/start') return { thread: { id: `live-thread-${calls.filter(call => call.method === 'thread/start').length}` } };
    if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
    throw new Error(`Unexpected request ${method}`);
  } };
  const complete = () => agent._notification({ method: 'turn/completed', params: { turn: { id: `turn-${turn}`, status: 'completed' } } });

  await agent.message({ text: 'first' });
  assert.equal(agent.threadId, 'live-thread-1');
  assert.equal(settings.get('agent.threadId'), '');
  assert.equal(settings.get('agent.threadBinding'), '');
  assert.equal(calls.find(call => call.method === 'turn/start').params.threadId, 'live-thread-1');
  complete();

  await agent.message({ text: 'second' });
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(calls.at(-1).method, 'turn/start');
  assert.equal(calls.at(-1).params.threadId, 'live-thread-1');
  complete();

  failResume = true;
  await agent.message({ text: 'third' });
  assert.equal(agent.threadId, 'live-thread-2');
  assert.equal(calls.at(-1).method, 'turn/start');
  assert.equal(calls.at(-1).params.threadId, 'live-thread-2');
  complete();
  await agent.message({ text: 'fourth' });
  assert.equal(calls.filter(call => call.method === 'thread/resume').length, 3);
  assert.equal(calls.at(-1).params.threadId, 'live-thread-2');
});

test('a failed persisted-binding cleanup prevents starting a turn', async t => {
  const { agent, settings } = fixture(t);
  agent.dynamicToolsVersion = null;
  settings.set('agent.threadId', 'stale-thread');
  const setSetting = agent.store.setSetting;
  agent.store.setSetting = (key, value) => {
    if (key === 'agent.threadId' && value === '') throw new Error('storage cleanup failed');
    setSetting(key, value);
  };
  const calls = [];
  agent.runner = { closed: false, async request(method, params) { calls.push({ method, params }); return { account: { type: 'chatgpt' }, data: [{ id: 'model-1' }] }; } };
  await assert.rejects(agent.message({ text: 'must not start' }), /storage cleanup failed/);
  assert.equal(calls.some(call => call.method === 'thread/start' || call.method === 'turn/start'), false);
});

test('failed persistence cleanup invalidates the live thread before a repeated request can resume it', async t => {
  const { agent } = fixture(t);
  agent.pluginService = null;
  agent.workspaceService = null;
  agent.workspaceSelection = null;
  agent.workspaceRevision = null;
  agent.threadId = null;
  agent.dynamicToolsVersion = '';
  const setSetting = agent.store.setSetting;
  agent.store.setSetting = (key, value) => {
    if (key === 'agent.threadId' && value === '') throw new Error('storage cleanup failed');
    setSetting(key, value);
  };
  const calls = [];
  agent.runner = { closed: false, async request(method, params) {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'model-1' }] };
    if (method === 'account/rateLimits/read') return {};
    if (method === 'thread/start') return { thread: { id: `created-${calls.filter(call => call.method === 'thread/start').length}` } };
    if (method === 'thread/resume') return {};
    throw new Error(`Unexpected request ${method}`);
  } };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(agent.message({ text: `attempt ${attempt + 1}` }), /storage cleanup failed/);
    assert.equal(agent.threadId, null);
  }
  assert.equal(calls.filter(call => call.method === 'thread/start').length, 2);
  assert.equal(calls.filter(call => call.method === 'thread/resume' || call.method === 'turn/start').length, 0);
});

test('app-server dynamic request handler accepts only the queue call and rejects command, file, and unknown requests', async t => {
  const root = mkdtempSync(join(tmpdir(), 'talewisp-agent-jsonl-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writes = [];
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString())); callback(); } });
  proc.kill = () => { proc.emit('exit', 0, null); };
  let staged = 0;
  const runner = new JsonlRunner({ codexHome: join(root, 'home'), cwd: join(root, 'work'), spawnImpl: () => proc, dynamicToolHandler: async params => {
    assert.equal(params.tool, 'talewisp_web_google_suggest');
    staged += 1;
    return { status: 'pending_author_review', proposal: { id: 'pending-1' } };
  } });
  t.after(() => runner.stop());
  const invoke = async message => {
    runner._line(JSON.stringify(message));
    await new Promise(resolve => setImmediate(resolve));
    return writes.at(-1);
  };
  const queued = await invoke({ id: 'server-1', method: 'item/tool/call', params: { callId: 'call-1', turnId: 'turn-1', threadId: 'thread-1', tool: 'talewisp_web_google_suggest', arguments: {} } });
  assert.equal(queued.result.success, true);
  assert.match(queued.result.contentItems[0].text, /pending_author_review/);
  assert.equal(staged, 1);

  for (const [id, method] of [['server-2', 'item/commandExecution/requestApproval'], ['server-3', 'item/fileChange/requestApproval'], ['server-4', 'unknown/request']]) {
    const rejected = await invoke({ id, method, params: {} });
    assert.equal(rejected.error.code, -32601);
    assert.equal(typeof rejected.error.message, 'string');
  }
  const unknownTool = await invoke({ id: 'server-5', method: 'item/tool/call', params: { callId: 'call-2', turnId: 'turn-1', threadId: 'thread-1', tool: 'talewisp_arbitrary', arguments: {} } });
  assert.equal(unknownTool.result.success, false);
  assert.equal(staged, 1);
});

test('app-server handshake requests the experimental capability required for thread dynamicTools', async () => {
  const runner = Object.create(JsonlRunner.prototype);
  const requests = [];
  const notifications = [];
  runner.request = async (method, params) => { requests.push({ method, params }); return method === 'config/read' ? { config: {} } : {}; };
  runner.notify = (method, params) => notifications.push({ method, params });
  await runner.initialize();
  assert.equal(requests[0].method, 'initialize');
  assert.deepEqual(requests[0].params.capabilities, { experimentalApi: true });
  assert.deepEqual(notifications, [{ method: 'initialized', params: {} }]);
  assert.equal(requests[1].method, 'config/read');
});

test('workspace rebinding shuts down old runtime, drops thread binding, scopes history, and retains login', async t => {
  const { agent, settings, scopes, workspaceCalls } = fixture(t);
  const oldRunner = { closed: false, exited: false, async stop() { this.closed = true; this.exited = true; return true; } };
  agent.runner = oldRunner;
  agent.threadId = 'old-thread';
  agent.account = { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' };
  agent.turnText = 'old private response';
  const result = await agent.setWorkspace({ vaultPath: 'C:\\vault\\other-series', selection: { authorId: 'a2', seriesId: 's2', bookId: 'b2' }, revision: 'revision-5' });
  assert.equal(result.changed, true);
  assert.equal(agent.runner, null);
  assert.equal(agent.threadId, null);
  assert.equal(settings.get('agent.threadId'), '');
  assert.deepEqual(scopes, ['["a2","s2","b2"]']);
  assert.deepEqual(workspaceCalls, ['closed']);
  assert.equal(agent.turnText, '');
  assert.equal(agent.status().account.email, 'owner@example.test');
});

test('an exact persisted thread binding survives first workspace startup', async t => {
  const { agent, settings } = fixture(t);
  const contract = await agent._getRuntimeContract();
  const binding = { threadId: 'old-thread', authorId: 'a1', seriesId: 's1', bookId: 'b1', vaultPath: agent.vaultPath, revision: 'workspace-revision-4', dynamicToolsVersion: `google-proposal-queue-v1;runtime-contract:${contract.version};roleplay:disabled`, runtimeContractVersion: contract.version };
  settings.set('agent.threadBinding', JSON.stringify(binding));
  const result = await agent.setWorkspace({ vaultPath: binding.vaultPath, selection: { authorId: 'a1', seriesId: 's1', bookId: 'b1' }, revision: binding.revision });
  assert.equal(result.changed, true);
  assert.equal(agent.threadId, 'old-thread');
  assert.equal(settings.get('agent.threadBinding'), JSON.stringify(binding));
  assert.equal(agent.dynamicToolsVersion, binding.dynamicToolsVersion);
});

test('an exact persisted thread binding survives a verified source-only series selection', async t => {
  const { agent, settings, workspaceService } = fixture(t);
  workspaceService.catalog = async () => ({ authors: [{ id: 'a1', name: 'Author', series: [{ id: 's1', name: 'Source-only series', books: [] }] }] });
  const contract = await agent._getRuntimeContract();
  const dynamicToolsVersion = `google-proposal-queue-v1;runtime-contract:${contract.version};roleplay:disabled`;
  agent.threadId = 'source-only-thread';
  settings.set('agent.threadId', 'source-only-thread');
  settings.set('agent.threadBinding', JSON.stringify({ threadId: 'source-only-thread', authorId: 'a1', seriesId: 's1', bookId: null, vaultPath: agent.vaultPath, revision: 'source-only-revision', dynamicToolsVersion, runtimeContractVersion: contract.version }));
  await agent.setWorkspace({ vaultPath: agent.vaultPath, selection: { authorId: 'a1', seriesId: 's1', bookId: null }, revision: 'source-only-revision' });
  assert.equal(agent.threadId, 'source-only-thread');
  assert.equal(agent.dynamicToolsVersion, dynamicToolsVersion);
  agent.threadId = 'new-source-only-thread';
  assert.equal(agent._persistThreadBinding(), true);
  assert.equal(JSON.parse(settings.get('agent.threadBinding')).bookId, null);
});

test('missing, malformed, or mismatched persisted bindings fail closed at startup', async t => {
  const fields = ['threadId', 'authorId', 'seriesId', 'bookId', 'vaultPath', 'revision', 'dynamicToolsVersion', 'runtimeContractVersion'];
  const cases = [null, '{bad json', ...fields];
  for (const mismatch of cases) {
    const { agent, settings } = fixture(t);
    const contract = await agent._getRuntimeContract();
    const binding = { threadId: 'old-thread', authorId: 'a1', seriesId: 's1', bookId: 'b1', vaultPath: agent.vaultPath, revision: 'workspace-revision-4', dynamicToolsVersion: `google-proposal-queue-v1;runtime-contract:${contract.version};roleplay:disabled`, runtimeContractVersion: contract.version };
    if (mismatch === '{bad json') settings.set('agent.threadBinding', mismatch);
    else if (mismatch) settings.set('agent.threadBinding', JSON.stringify({ ...binding, [mismatch]: `${binding[mismatch]}-other` }));
    await agent.setWorkspace({ vaultPath: binding.vaultPath, selection: { authorId: 'a1', seriesId: 's1', bookId: 'b1' }, revision: binding.revision });
    assert.equal(agent.threadId, null);
    assert.equal(settings.get('agent.threadBinding'), '');
    assert.equal(settings.get('agent.threadId'), '');
  }
});

test('workspace cannot change while a turn is active and prompt names active scope and exclusions', async t => {
  const { agent } = fixture(t);
  agent.inTurn = true;
  await assert.rejects(agent.setWorkspace({ vaultPath: 'C:\\vault\\other', selection: { seriesId: 'other' }, revision: 'r2' }), /Wait for the current response/);
  agent.inTurn = false;
  const prompt = await agent._workspacePromptContext('revision');
  assert.match(prompt, /ACTIVE AUTHOR: Author/);
  assert.match(prompt, /ACTIVE SERIES: Series/);
  assert.match(prompt, /ACTIVE BOOK: Book/);
  assert.match(prompt, /REQUEST MODE: revision/);
  assert.match(prompt, /AUTHOR STYLE EXCLUDED: true/);
  assert.match(prompt, /STYLE EXCLUSION REASON: Author style excluded by author instruction\./);
  assert.match(prompt, /APPROVED STYLE PATHS \(excluded; do not activate\): confirmed\/author-style\.md/);
  assert.match(prompt, /LEXICAL DICTIONARY PATHS \(separate from style\): 04 Analysis\/lexical dictionary\.md/);
  assert.match(prompt, /not active; never auto-activate/);
});
