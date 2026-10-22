import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CODE_REVIEW_EFFORT, CODE_REVIEW_MODEL, CODE_REVIEW_TOOL, createCodeReviewService } from '../code-review.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fake app-server request.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const context = () => ({ mode: 'code_review', parentThreadId: 'parent-1', parentTurnId: 'parent-turn-1', parentCallId: 'call-1', workspaceRevision: 'revision-1' });
const before = 'export function calculate(a, b) {\n  return a + b;\n}\n';
const after = before.replace('a + b', 'a - b');

function fixture({ model = CODE_REVIEW_MODEL, effort = CODE_REVIEW_EFFORT, syntaxCheck = null, beforeReviewResponse = null } = {}) {
  const calls = []; const events = []; let reviewService; let activeContext = context();
  const runner = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'review-thread-1' }, model, reasoningEffort: effort, approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null };
      if (method === 'review/start') {
        if (syntaxCheck) syntaxCheck(params);
        if (beforeReviewResponse) beforeReviewResponse(reviewService);
        return { turn: { id: 'review-turn-1', status: 'inProgress' }, reviewThreadId: 'review-thread-1' };
      }
      if (method === 'turn/interrupt') return {};
      return {};
    },
    async stop() { return true; }
  };
  reviewService = createCodeReviewService({
    runner,
    resolveModel: async () => ({ model, effort }),
    getModelCatalog: () => [{ id: model, supportedReasoningEfforts: [effort] }],
    getActiveContext: () => activeContext,
    cwd: 'D:/TaleWisp',
    emit: event => events.push(event)
  });
  return { runner, calls, events, service: reviewService, setContext: value => { activeContext = value; } };
}

const request = (overrides = {}) => ({ task: 'Review the changed arithmetic behavior.', files: [{ path: 'src/calc.mjs', before, after }], ...overrides });

test('native independent review receives only a computed, hash-bound supplied-source packet', async () => {
  let service; let target;
  const f = fixture({ syntaxCheck: params => { target = params.target; } }); service = f.service;
  const pending = service.execute(request(), context());
  await waitFor(() => f.calls.some(call => call.method === 'review/start'));
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false, 'uses native review/start, not a summary-only generated turn');
  const thread = f.calls.find(call => call.method === 'thread/start');
  assert.equal(thread.params.model, CODE_REVIEW_MODEL);
  assert.equal(thread.params.config.model_reasoning_effort, CODE_REVIEW_EFFORT);
  assert.equal(thread.params.config.review_model, CODE_REVIEW_MODEL);
  assert.equal(thread.params.config['features.shell_tool'], false);
  assert.equal(thread.params.config['features.apps'], false);
  assert.equal(thread.params.config['features.multi_agent'], false);
  assert.equal(thread.params.config['agents.enabled'], false);
  assert.equal(thread.params.config['mcp_servers.talewisp.enabled'], false);
  assert.deepEqual(thread.params.dynamicTools, []);
  const reviewCall = f.calls.find(call => call.method === 'review/start');
  assert.equal(reviewCall.params.target.type, 'custom');
  assert.match(target.instructions, /PROVENANCE: Every before\/after body below is literal source text explicitly supplied/);
  assert.match(target.instructions, /--- HOST-COMPUTED UNIFIED DIFF ---/);
  assert.match(target.instructions, /return a \+ b/);
  assert.match(target.instructions, /return a - b/);
  assert.match(target.instructions, /BEFORE SHA-256: [a-f0-9]{64}/);
  assert.match(target.instructions, /AFTER SHA-256: [a-f0-9]{64}/);
  service.routeNotification({ method: 'turn/started', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1' } } });
  service.routeNotification({ method: 'item/completed', params: { threadId: 'review-thread-1', item: { type: 'exitedReviewMode', review: 'P1: calculate now subtracts, reversing the requested operation.' } } });
  service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1', status: 'completed' } } });
  const result = await pending;
  assert.equal(result.receipt.status, 'completed');
  assert.match(result.receipt.result, /P1: calculate now subtracts/);
  assert.equal(result.receipt.role, 'sol_review');
  assert.equal(result.receipt.model, CODE_REVIEW_MODEL);
  assert.equal(result.receipt.effort, CODE_REVIEW_EFFORT);
  assert.equal(result.receipt.machineChecks[0].kind, 'node-check-module-syntax');
  assert.equal(result.receipt.manifest[0].path, 'src/calc.mjs');
  assert.match(result.receipt.gate, /SOL_GATE: role sol_review/);
  assert.ok(f.events.some(event => event.type === 'delegation' && event.role === 'sol_review' && event.phase === 'completed'));
});

test('terminal review notifications received before review/start response remain terminal', async () => {
  const f = fixture({ beforeReviewResponse: service => {
    service.routeNotification({ method: 'turn/started', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1' } } });
    service.routeNotification({ method: 'item/completed', params: { threadId: 'review-thread-1', item: { type: 'exitedReviewMode', review: 'P1: the arithmetic operation is reversed.' } } });
    service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1', status: 'completed' } } });
  } });
  const result = await f.service.execute(request(), context());
  const delegationEvents = f.events.filter(event => event.type === 'delegation');
  assert.equal(result.receipt.status, 'completed');
  assert.match(result.receipt.result, /arithmetic operation is reversed/);
  assert.equal(f.service.status().recent.at(-1).status, 'completed');
  assert.equal(delegationEvents.at(-1).phase, 'completed');
  assert.equal(delegationEvents.slice(delegationEvents.findIndex(event => event.phase === 'completed') + 1).some(event => event.phase === 'running'), false);
});

test('rejects unavailable Sol route before any reviewer thread is created', async () => {
  const f = fixture({ model: 'gpt-6-luna', effort: 'high' });
  await assert.rejects(f.service.execute(request(), context()), /Sol 6\.1 medium/);
  assert.equal(f.calls.length, 0);
});

test('rejects a route resolver mismatch even when catalog claims Sol is available', async () => {
  const f = fixture();
  f.service = createCodeReviewService({ runner: f.runner, resolveModel: async () => ({ model: 'gpt-6-luna', effort: 'high' }), getModelCatalog: () => [{ id: CODE_REVIEW_MODEL, supportedReasoningEfforts: [CODE_REVIEW_EFFORT] }], getActiveContext: () => context() });
  const result = await f.service.execute(request(), context());
  assert.equal(result.receipt.status, 'failed');
  assert.match(result.receipt.error, /resolver did not select Sol 6\.1 medium/);
  assert.equal(f.calls.some(call => call.method === 'thread/start'), false);
});

test('fails closed on app-server model/effort mismatch and any exposed MCP tool', async () => {
  const wrongHost = fixture();
  const originalRequest = wrongHost.runner.request.bind(wrongHost.runner);
  wrongHost.runner.request = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: 'review-thread-1' }, model: CODE_REVIEW_MODEL, reasoningEffort: 'high', approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
    return originalRequest(method, params);
  };
  wrongHost.service = createCodeReviewService({ runner: wrongHost.runner, resolveModel: async () => ({ model: CODE_REVIEW_MODEL, effort: CODE_REVIEW_EFFORT }), getModelCatalog: () => [{ id: CODE_REVIEW_MODEL, supportedReasoningEfforts: [CODE_REVIEW_EFFORT] }], getActiveContext: () => context() });
  const wrongRoute = await wrongHost.service.execute(request(), context());
  assert.equal(wrongRoute.receipt.status, 'failed');
  assert.match(wrongRoute.receipt.error, /did not confirm Sol 6\.1 medium/);
  assert.equal(wrongHost.calls.some(call => call.method === 'mcpServerStatus/list' || call.method === 'review/start'), false);

  const exposed = fixture();
  exposed.runner.request = async (method, params) => {
    exposed.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'review-thread-1' }, model: CODE_REVIEW_MODEL, reasoningEffort: CODE_REVIEW_EFFORT, approvalPolicy: 'never', sandbox: { type: 'readOnly' } };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'talewisp', tools: { read_file: {} } }], nextCursor: null };
    return {};
  };
  const denied = await exposed.service.execute(request(), context());
  assert.equal(denied.receipt.status, 'failed');
  assert.match(denied.receipt.error, /exposes MCP tools/);
  assert.equal(exposed.calls.some(call => call.method === 'review/start'), false);
});

test('rejects incomplete, unchanged, over-limit, unsupported, and traversal source packets before provider dispatch', async () => {
  const f = fixture();
  const invalid = [
    request({ files: [{ path: 'src/calc.mjs', before, after: `${before}\n// ... unchanged ...` }] }),
    request({ files: [{ path: 'src/calc.mjs', before, after: before }] }),
    request({ files: [{ path: '../calc.mjs', before, after }] }),
    request({ files: [{ path: 'src/calc.py', before, after }] }),
    request({ files: [{ path: 'src/calc.mjs', before, after }, { path: 'src/other.mjs', before: 'x'.repeat(50_000), after: 'y'.repeat(50_000) }] })
  ];
  for (const args of invalid) await assert.rejects(f.service.execute(args, context()));
  assert.equal(f.calls.length, 0);
});

test('host syntax failure prevents dispatch and cannot be replaced by reviewer approval', async () => {
  const f = fixture();
  const result = await f.service.execute(request({ files: [{ path: 'src/broken.mjs', before: 'export const x = 1;', after: 'export const = ;' }] }), context());
  assert.equal(result.receipt.status, 'failed');
  assert.match(result.receipt.error, /Host syntax check failed/);
  assert.equal(f.calls.length, 0);
});

test('rejects non-review context and parent binding drift before dispatch', async () => {
  const wrongMode = fixture();
  await assert.rejects(wrongMode.service.execute(request(), { ...context(), mode: 'ordinary_writing' }), /only available inside the active code_review/);
  assert.equal(wrongMode.calls.length, 0);

  const drift = fixture(); drift.setContext({ ...context(), workspaceRevision: 'revision-2' });
  await assert.rejects(drift.service.execute(request(), context()), /context changed/);
  assert.equal(drift.calls.length, 0);
});

test('cancels reviewer and rejects completion from a foreign turn id', async () => {
  const f = fixture(); const pending = f.service.execute(request(), context());
  await waitFor(() => f.calls.some(call => call.method === 'review/start'));
  f.service.routeNotification({ method: 'turn/started', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1' } } });
  await f.service.cancelAll('parent stopped');
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'review-turn-1'), true);
  f.service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'foreign-turn', status: 'completed' } } });
  assert.equal(f.service.status().active.length, 1);
  f.service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1', status: 'interrupted' } } });
  const result = await pending;
  assert.equal(result.receipt.status, 'cancelled');
  assert.equal(result.receipt.result, '');
});

test('rejects reviewer tool and approval activity instead of accepting a purported review', async () => {
  const f = fixture(); const pending = f.service.execute(request(), context());
  await waitFor(() => f.calls.some(call => call.method === 'review/start'));
  f.service.routeNotification({ method: 'turn/started', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1' } } });
  f.service.routeNotification({ method: 'item/started', params: { threadId: 'review-thread-1', item: { type: 'commandExecution' } } });
  f.service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1', status: 'completed' } } });
  const result = await pending;
  assert.equal(result.receipt.status, 'cancelled');
  assert.match(result.receipt.error, /prohibited tool/);
});

test('reserves the single-review slot before asynchronous syntax checks can race', async () => {
  const f = fixture();
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end: () => setTimeout(() => child.emit('close', 0), 60) }; child.kill = () => {};
    return child;
  };
  f.service = createCodeReviewService({ runner: f.runner, resolveModel: async () => ({ model: CODE_REVIEW_MODEL, effort: CODE_REVIEW_EFFORT }), getModelCatalog: () => [{ id: CODE_REVIEW_MODEL, supportedReasoningEfforts: [CODE_REVIEW_EFFORT] }], getActiveContext: () => context(), spawnImpl });
  const first = f.service.execute(request(), context());
  await assert.rejects(f.service.execute(request(), { ...context(), parentCallId: 'call-2' }), /Only one independent code review may run/);
  await waitFor(() => f.calls.some(call => call.method === 'review/start'));
  f.service.routeNotification({ method: 'turn/started', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1' } } });
  f.service.routeNotification({ method: 'item/completed', params: { threadId: 'review-thread-1', item: { type: 'exitedReviewMode', review: 'No actionable defect found.' } } });
  f.service.routeNotification({ method: 'turn/completed', params: { threadId: 'review-thread-1', turn: { id: 'review-turn-1', status: 'completed' } } });
  assert.equal((await first).receipt.status, 'completed');
});

test('cancellation during host checks prevents resolver and reviewer dispatch', async () => {
  const f = fixture(); let resolverCalls = 0;
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end: () => setTimeout(() => child.emit('close', 0), 60) }; child.kill = () => {};
    return child;
  };
  f.service = createCodeReviewService({ runner: f.runner, resolveModel: async () => { resolverCalls++; return { model: CODE_REVIEW_MODEL, effort: CODE_REVIEW_EFFORT }; }, getModelCatalog: () => [{ id: CODE_REVIEW_MODEL, supportedReasoningEfforts: [CODE_REVIEW_EFFORT] }], getActiveContext: () => context(), spawnImpl });
  const pending = f.service.execute(request(), context());
  await f.service.cancelAll('parent stopped during syntax check');
  const result = await pending;
  assert.equal(result.receipt.status, 'cancelled');
  assert.equal(resolverCalls, 0);
  assert.equal(f.calls.some(call => call.method === 'thread/start' || call.method === 'review/start'), false);
});

test('tool schema binds input to supplied complete source rather than arbitrary file paths', () => {
  assert.equal(CODE_REVIEW_TOOL.name, 'talewisp_code_review');
  assert.deepEqual(CODE_REVIEW_TOOL.inputSchema.required, ['task', 'files']);
  assert.deepEqual(CODE_REVIEW_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(CODE_REVIEW_TOOL.inputSchema.properties.files.items.required, ['path', 'before', 'after']);
  assert.equal(CODE_REVIEW_TOOL.inputSchema.properties.files.items.additionalProperties, false);
});

