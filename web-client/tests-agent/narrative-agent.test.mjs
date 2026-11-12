import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../agent.mjs';
import {fixturePreflight} from '../tests/fixtures/narrative-preflight.mjs';

function setup(t, { narrativeService = { proposeClosure: (...args) => ({ args }) }, preflight=fixturePreflight } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-narrative-agent-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new Map(), calls = [];
  const store = { getSetting: k => settings.get(k), setSetting: (k, v) => settings.set(k, v), listMessages: () => [], addMessage: (role, text) => ({ id: 'msg-' + calls.length, role, text }) };
  const agent = new AgentService({ dataDir: root, store, vaultPath: null, narrativeService, narrativePreflight:preflight });
  agent.runner = { closed: false, async request(method, params) {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'fixture-model' }] };
    if (method === 'account/rateLimits/read') return {};
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'fixture-thread' } };
    if (method === 'turn/start') return { turn: { id: 'fixture-turn-' + calls.length } };
    throw new Error('Unexpected ' + method);
  } };
  return { agent, calls };
}
const request = (events, overrides = {}) => ({ requestId: 'req-1', mode: 'write', beforeTurnStart: () => events.push('recheck'), onPreflight: accounting => events.push(['preflight', accounting]), onTurnStarted: info => events.push(['started', info]), onAssistantMessage: id => events.push(['assistant', id]), onFinished: status => events.push(['finished', status]), ...overrides });
const CONTEXT = 'APPROVED NARRATIVE FRAMEWORK (fixture)\nEND APPROVED NARRATIVE FRAMEWORK';

test('narrative context is server-owned, rejected in import and host workflows, and follows the author request', async t => {
  const { agent, calls } = setup(t), events = [];
  await assert.rejects(agent.message({ model:'fixture-model', text: 'x', narrativeContext: CONTEXT }), /server-owned/);
  await assert.rejects(agent.message({ model:'fixture-model', text: 'x', narrativeContext: CONTEXT, narrativeRequest: request(events), mode: 'storyart' }), /writing and discussion/);
  await assert.rejects(agent.message({ model:'fixture-model', text: 'x', narrativeContext: CONTEXT, narrativeRequest: request(events), importJobId: 'job', mode: 'series_base', importJobContext: {} }), /narrative/);
  await agent.message({ model:'fixture-model', text: 'Пиши по плану', narrativeContext: CONTEXT, narrativeRequest: request(events), textReviewContext: 'TEXT REVIEW TARGET fixture', manuscriptContext: 'READ-ONLY MANUSCRIPT CONTEXT fixture' });
  const prompt = calls.find(call => call.method === 'turn/start').params.input.find(item => item.type === 'text').text;
  assert.ok(prompt.indexOf('AUTHOR REQUEST:\nПиши по плану') < prompt.indexOf(CONTEXT));
  assert.ok(prompt.indexOf(CONTEXT) < prompt.indexOf('TEXT REVIEW TARGET') && prompt.indexOf('TEXT REVIEW TARGET') < prompt.indexOf('READ-ONLY MANUSCRIPT CONTEXT'));
  assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), ['preflight', 'recheck', 'started'], 'accounting and recheck run before turn/start; the user message id is linked after it');
  assert.equal(events[0][1].tokenWindow, 'verified'); assert.equal(events[0][1].reserves.applied,true); assert.equal(events[0][1].tokenizer,'fixture-byte-tokenizer-v1');
  assert.equal(events[2][1].userMessageId.startsWith('msg-'), true);
  const thread = calls.find(call => call.method === 'thread/start');
  assert.ok(thread.params.dynamicTools.some(tool => tool.name === 'talewisp_propose_stage_closure'));
  assert.match(agent.dynamicToolsVersion, /host-workflow:narrative;/);
  agent._notification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Ответ' } } });
  agent._notification({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  assert.deepEqual(events.slice(-2), [['assistant', 'msg-' + calls.length], ['finished', 'completed']]);
});

test('the proposal tool takes requestId from the active turn only and is unavailable outside narrative threads', async t => {
  const seen = [];
  const { agent } = setup(t, { narrativeService: { proposeClosure: (requestId, args, call) => { seen.push({ requestId, args, call }); return { proposalId: 'p1', state: 'pending' }; } } });
  await agent.message({ model:'fixture-model', text: 'Пиши', narrativeContext: CONTEXT, narrativeRequest: request([], { requestId: 'server-request' }) });
  const result = await agent._handleDynamicToolCall({ arguments: { requestId: 'forged', stageId: 'stage-a' }, callId: 'c1', threadId: agent.threadId, tool: 'talewisp_propose_stage_closure', turnId: agent.activeTurnId });
  assert.equal(result.proposalId, 'p1'); assert.equal(seen[0].requestId, 'server-request', 'model arguments cannot choose the request');
  agent._notification({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await assert.rejects(agent._handleDynamicToolCall({ arguments: {}, callId: 'c2', threadId: agent.threadId, tool: 'talewisp_propose_stage_closure', turnId: 'old' }), /outside the active TaleWisp turn/);
  await agent.message({ model:'fixture-model', text: 'Обычный вопрос' });
  await assert.rejects(agent._handleDynamicToolCall({ arguments: {}, callId: 'c3', threadId: agent.threadId, tool: 'talewisp_propose_stage_closure', turnId: agent.activeTurnId }), /approved narrative framework/);
  agent._notification({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
});

test('a failed recheck or an oversized assembled prompt never starts a turn', async t => {
  const { agent, calls } = setup(t);
  await assert.rejects(agent.message({ model:'fixture-model', text: 'Пиши', narrativeContext: CONTEXT, narrativeRequest: request([], { beforeTurnStart: () => { throw Object.assign(new Error('changed'), { status: 409, code: 'narrative_changed' }); } }) }), /changed/);
  await assert.rejects(agent.message({ model:'fixture-model', text: 'Пиши', narrativeContext: CONTEXT, narrativeRequest: request([]), textReviewContext: 'x'.repeat(490_000) }), error => error.status === 413 && error.code === 'agent_context_too_large');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(agent.inTurn, false);
  await agent.message({ model:'fixture-model', text: 'Обсудим', narrativeContext: CONTEXT, narrativeRequest: request([], { mode: 'discuss' }), textReviewContext: 'x'.repeat(490_000) });
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1, 'the write-mode ceiling does not apply to discussion');
  agent._notification({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
});

test('unknown native preflight blocks writing before the runner but approved discussion remains available',async t=>{
  const {agent,calls}=setup(t,{preflight:null});
  await assert.rejects(agent.message({model:'fixture-model',text:'Пиши',narrativeContext:CONTEXT,narrativeRequest:request([])}),e=>e.code==='narrative_preflight_unavailable'&&e.status===503);
  assert.equal(calls.filter(c=>c.method==='turn/start').length,0);assert.equal(agent.inTurn,false);
  await agent.message({model:'fixture-model',text:'Обсудим',narrativeContext:CONTEXT,narrativeRequest:request([],{mode:'discuss'})});
  assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
  agent._notification({method:'turn/completed',params:{turn:{status:'completed'}}});
});

test('preflight proof must cover this model, prompt and hidden context and preserve response reserves',async t=>{
  for(const corrupt of [p=>({...p,model:'other-model'}),p=>({...p,promptHash:'wrong'}),p=>({...p,includesHiddenContext:false}),p=>({...p,hiddenTokens:-1}),p=>({...p,contextWindow:10})]){
    const {agent,calls}=setup(t,{preflight:async input=>corrupt(await fixturePreflight(input))});
    await assert.rejects(agent.message({model:'fixture-model',text:'Пиши',narrativeContext:CONTEXT,narrativeRequest:request([])}),e=>['narrative_preflight_unavailable','agent_context_too_large'].includes(e.code));
    assert.equal(calls.filter(c=>c.method==='turn/start').length,0);
  }
});
