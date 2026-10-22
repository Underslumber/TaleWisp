import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegationManager, DELEGATE_MODEL, DELEGATE_EFFORT, supportsEffort } from '../delegation.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const events = [];
  let next = 0;
  const runner = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') {
        const id = `child-${++next}`;
        return { thread: { id }, model: DELEGATE_MODEL, reasoningEffort: DELEGATE_EFFORT, approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
      }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}` } };
      return {};
    }
  };
  const contract = {
    version: 'contract-v1', instructions: 'FULL CONTRACT', ROOT_WORKFLOW_INSTRUCTIONS: 'ROOT WORKFLOW',
    roles: { style_editor: { instructions: 'One finished passage.' } },
    resources: [{ id: 'project/skill/SKILL.md', title: 'skill', sourceHash: 'source-hash', hash: 'content-hash' }],
    readResource(id) { if (id !== 'project/skill/SKILL.md') throw new Error('Unknown resource'); return '# exact skill'; }
  };
  const manager = createDelegationManager({
    runner,
    contractProvider: async () => contract,
    resolveModel: async () => ({ scope: 'once', model: DELEGATE_MODEL, effort: DELEGATE_EFFORT }),
    getModelCatalog: () => [{ id: DELEGATE_MODEL, supportedReasoningEfforts: [DELEGATE_EFFORT] }],
    getWorkspaceRevision: () => 'revision-1',
    getParentBinding: () => ({ threadId: 'parent', turnId: 'parent-turn', cwd: 'D:/project' }),
    authorizeRole: () => true,
    emit: event => events.push(event),
    ...overrides
  });
  return { manager, runner, calls, events, contract };
}

const request = (extra = {}) => ({ role: 'style_editor', task: 'Write the requested scene.', input: 'Only this source packet.', maxOutputChars: 1000, parentThreadId: 'parent', parentTurnId: 'parent-turn', parentCallId: 'call-1', contractVersion: 'contract-v1', workspaceRevision: 'revision-1', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('child thread uses the same runner with a fresh resource-only read-only MCP-disabled boundary', async () => {
  const f = fixture();
  const pending = f.manager.delegate(request());
  await tick(); await tick();
  const start = f.calls.find(call => call.method === 'thread/start');
  assert.ok(start);
  assert.equal(f.manager.status().active[0].status,'running','confirmed turn/start must expose an actual running state');
  assert.deepEqual(start.params.config, { 'mcp_servers.talewisp.enabled': false, model_reasoning_effort: 'high', web_search: 'disabled' });
  assert.deepEqual(start.params.dynamicTools.map(tool => tool.name), ['talewisp_runtime_resource']);
  assert.match(start.params.developerInstructions, /FULL CONTRACT/);
  assert.match(start.params.developerInstructions, /ROOT WORKFLOW/);
  const inventory = f.calls.find(call => call.method === 'mcpServerStatus/list');
  assert.equal(inventory.params.threadId, 'child-1');
  const turn = f.calls.find(call => call.method === 'turn/start');
  assert.equal(turn.params.threadId, 'child-1');
  assert.equal(turn.params.model, DELEGATE_MODEL);
  assert.equal(turn.params.effort, 'high');
  assert.equal(turn.params.sandboxPolicy.networkAccess, false);
  assert.deepEqual(turn.params.input.map(item => item.type), ['text']);
  const receipt = await f.manager.handleResourceTool({ threadId: 'child-1', turnId: 'turn-child-1', callId: 'resource-call', tool: 'talewisp_runtime_resource', arguments: { id: 'project/skill/SKILL.md' } });
  assert.equal(receipt.content, '# exact skill');
  await assert.rejects(f.manager.handleResourceTool({ threadId: 'child-1', turnId: 'turn-child-1', callId: 'resource-call-2', tool: 'talewisp_runtime_resource', arguments: { id: 'C:/vault/secret.md' } }), /Unknown resource/);
  f.manager.routeNotification({ method: 'turn/started', params: { threadId: 'child-1', turn: { id: 'turn-child-1' } } });
  f.manager.routeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'child-1', delta: 'Finished prose.' } });
  f.manager.routeNotification({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'turn-child-1', status: 'completed' } } });
  const result = await pending;
  assert.deepEqual(result.receipt, { id: result.receipt.id, role: 'style_editor', model: DELEGATE_MODEL, effort: DELEGATE_EFFORT, threadId: 'child-1', status: 'completed', complete: true, result: 'Finished prose.', error: null });
  assert.equal(f.events.some(event => event.type === 'delegation' && event.phase === 'completed'), true);
});

test('model selection, catalog, parent binding, workspace, and per-turn caps fail closed', async () => {
  assert.equal(supportsEffort({supportedReasoningEfforts:['high']},'high'),true);
  assert.equal(supportsEffort({supportedReasoningEfforts:[{reasoningEffort:'high'}]},'high'),true);
  assert.equal(supportsEffort({supportedReasoningEfforts:[{reasoningEffort:'medium'}]},'high'),false);
  const wrongModel = fixture({ resolveModel: async () => ({ scope: 'once', model: 'gpt-6.1-sol', effort: 'high' }) });
  const wrongModelReceipt = await wrongModel.manager.delegate(request());
  assert.equal(wrongModelReceipt.receipt.status, 'failed');
  assert.match(wrongModelReceipt.receipt.error, /resolver did not confirm/);

  const unavailable = fixture({ getModelCatalog: () => [{ id: DELEGATE_MODEL, supportedReasoningEfforts: ['medium'] }] });
  await assert.rejects(unavailable.manager.delegate(request()), /unavailable in the account catalog/);

  const stale = fixture({ getWorkspaceRevision: () => 'changed' });
  await assert.rejects(stale.manager.delegate(request()), /Workspace changed/);

  const badParent = fixture({ getParentBinding: () => ({ threadId: 'other', turnId: 'parent-turn' }) });
  await assert.rejects(badParent.manager.delegate(request()), /outside the active parent thread/);

  const capped = fixture();
  const first = capped.manager.delegate(request());
  await tick(); await tick();
  const second = capped.manager.delegate(request({ parentCallId: 'call-2' }));
  await tick(); await tick();
  await assert.rejects(capped.manager.delegate(request({ parentCallId: 'call-3' })), /concurrent child-thread limit/);
  await capped.manager.cancelAll('test cleanup');
  assert.equal(capped.manager.status().active.length,2,'an interrupt acknowledgement alone does not release either reserved slot');
  assert.ok(capped.manager.status().active.every(child=>child.status==='cancel_requested'));
  for(const [threadId,turnId] of [['child-1','turn-child-1'],['child-2','turn-child-2']])capped.manager.routeNotification({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'cancelled'}}});
  assert.equal((await first).receipt.status, 'cancelled');
  assert.equal((await second).receipt.status, 'cancelled');
});

test('notifications stay inside the child registry and overflow is returned as incomplete without partial output', async () => {
  const f = fixture();
  const pending = f.manager.delegate(request({ maxOutputChars: 8 }));
  await tick(); await tick();
  assert.equal(f.manager.routeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'child-1', delta: 'too-long-result' } }), true);
  f.manager.routeNotification({ method: 'turn/started', params: { threadId: 'child-1', turn: { id: 'turn-child-1' } } });
  f.manager.routeNotification({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'turn-child-1', status: 'completed' } } });
  const result = await pending;
  assert.equal(result.receipt.status, 'incomplete');
  assert.equal(result.receipt.result, '');
  assert.match(result.receipt.error, /no partial result/);
  assert.equal(f.manager.routeNotification({ method: 'item/agentMessage/delta', params: { threadId: 'child-1', delta: 'late child data' } }), true);
});


test('isolated import reviewer never recreates a transport-less MCP entry', async () => {
  const f = fixture({ runtimeProfile: 'import-bootstrap' });
  const pending = f.manager.delegate(request({ role: 'continuity_reviewer' }));
  await tick(); await tick();
  const start = f.calls.find(call => call.method === 'thread/start');
  assert.ok(start);
  assert.deepEqual(start.params.config, { model_reasoning_effort: 'high', web_search: 'disabled' });
  assert.ok(f.calls.some(call => call.method === 'mcpServerStatus/list' && call.params.threadId === 'child-1'));
  f.manager.routeNotification({ method: 'turn/completed', params: { threadId: 'child-1', turn: { id: 'turn-child-1', status: 'completed', items: [{ type: 'agentMessage', text: 'PASS' }] } } });
  assert.equal((await pending).receipt.status, 'completed');
});

test('only an authorized import reviewer receives the bounded reader and emits hash-bound read receipts', async () => {
  const readerCalls=[];
  const f=fixture({runtimeProfile:'import-bootstrap'});
  const manifest={jobId:'job-1',sessionId:'session-1',candidateSha256:'candidate-1',files:[{path:'Sources/book.fb2',sha256:'sha-source',bytes:90_000}],requiredFiles:[{path:'Sources/book.fb2',sha256:'sha-source',bytes:90_000}],excludedFiles:[]};
  const pending=f.manager.delegate(request({role:'continuity_reviewer',input:'Review this exact candidate using the pinned manifest.',importReviewReader:async range=>{readerCalls.push(range);return{path:range.path,sha256:'sha-source',range:{start:range.startChar,end:range.startChar+4},eof:false,totalChars:90_000,complete:false,text:'book'};},importReviewManifest:manifest}));
  await tick();await tick();
  const start=f.calls.find(call=>call.method==='thread/start');
  assert.deepEqual(start.params.dynamicTools.map(tool=>tool.name),['talewisp_runtime_resource','talewisp_import_review_read']);
  assert.match(start.params.developerInstructions,/"jobId":"job-1"/);
  assert.match(start.params.developerInstructions,/Host boundary: you receive only this task packet and allowlisted operational resources plus the explicitly authorized pinned import review reader/);
  assert.match(start.params.developerInstructions,/Return exactly one JSON object/);
  assert.ok(f.calls.some(call=>call.method==='mcpServerStatus/list'&&call.params.threadId==='child-1'));
  await assert.rejects(f.manager.handleImportReviewRead({threadId:'unrelated',turnId:'turn-child-1',callId:'forged',tool:'talewisp_import_review_read',arguments:{path:'Sources/book.fb2',startChar:0,maxChars:64000}}),/outside an authorized/);
  await assert.rejects(f.manager.handleImportReviewRead({threadId:'child-1',turnId:'wrong-turn',callId:'forged-2',tool:'talewisp_import_review_read',arguments:{path:'Sources/book.fb2',startChar:0,maxChars:64000}}),/outside an authorized/);
  const read=await f.manager.handleImportReviewRead({threadId:'child-1',turnId:'turn-child-1',callId:'read-1',tool:'talewisp_import_review_read',arguments:{path:'Sources/book.fb2',startChar:0,maxChars:64000}});
  assert.equal(read.text,'book');assert.equal(readerCalls.length,1);
  f.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{id:'turn-child-1',status:'completed',items:[{type:'agentMessage',text:'{"status":"PASS"}'}]}}});
  const receipt=(await pending).receipt;
  assert.deepEqual(receipt.importReviewBinding,{jobId:'job-1',sessionId:'session-1',candidateSha256:'candidate-1',requiredManifest:[{path:'Sources/book.fb2',sha256:'sha-source',bytes:90_000}],excludedManifest:[]});
  assert.deepEqual(receipt.importReviewReadAudit,{calls:1,attempts:1,chars:4,reads:[{path:'Sources/book.fb2',startChar:0,endChar:4,totalChars:90_000,eof:false,sha256:'sha-source',charCount:4,complete:false}]});
});

test('ordinary child threads cannot invoke the import review reader and range budgets fail closed', async()=>{
  const ordinary=fixture();const pending=ordinary.manager.delegate(request());await tick();await tick();
  await assert.rejects(ordinary.manager.handleImportReviewRead({threadId:'child-1',turnId:'turn-child-1',callId:'read',tool:'talewisp_import_review_read',arguments:{path:'secret',startChar:0,maxChars:10}}),/outside an authorized/);
  ordinary.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{id:'turn-child-1',status:'completed'}}});await pending;
  const limited=fixture({runtimeProfile:'import-bootstrap'});const limitedManifest={jobId:'j',sessionId:'s',candidateSha256:'c',files:[{path:'x',sha256:'h',bytes:0}],requiredFiles:[{path:'x',sha256:'h',bytes:0}],excludedFiles:[]};const review=limited.manager.delegate(request({role:'continuity_reviewer',importReviewReader:async()=>({path:'x',sha256:'h',range:{start:0,end:0},eof:true,totalChars:0,complete:true,text:''}),importReviewManifest:limitedManifest}));await tick();await tick();
  await assert.rejects(limited.manager.handleImportReviewRead({threadId:'child-1',turnId:'turn-child-1',callId:'bad',tool:'talewisp_import_review_read',arguments:{path:'x',startChar:0,maxChars:64001}}),/arguments are invalid/);
  await limited.manager.cancelAll('test cleanup');limited.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{id:'turn-child-1',status:'cancelled'}}});await review;
});
