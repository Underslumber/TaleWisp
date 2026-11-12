import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../server.mjs';
import { AgentService } from '../agent.mjs';
import {fixturePreflight} from './fixtures/narrative-preflight.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const ONE = 'Глава один. Кай нашёл ключ под камнем. Он решил вернуться домой.';
const TWO = 'Глава два. Мира ждёт у ворот и молчит.';

// The HTTP layer is real; the agent is a real AgentService behind a thin holder so the runner input can be inspected.
class HolderAgent extends EventEmitter {
  status() { return { available: true, authenticated: true, account: { type: 'chatgpt' }, limits: null, error: null, running: false, models: [{ id: 'fixture', displayName: 'Fixture' }], messages: [] }; }
  async connect() { return this.status(); }
  async message(input) { this.lastMessage = input; return this.real ? this.real.message(input) : { accepted: true }; }
  async stop() { return { stopped: true }; }
  shutdown() {}
}
const fakeGoogle = { status: async () => ({ configured: false, authenticated: false, requiresClientConfiguration: true }), configure: async () => ({}), beginLogin: async () => ({}), callback: async () => ({ ok: true }), disconnect: async () => ({ disconnected: true }), readDocument: async () => ({}), suggest: async () => ({}), comment: async () => ({}) };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tw-narrative-http-')), vault = join(root, 'vault'); mkdirSync(vault); writeFileSync(join(vault, 'source.md'), 'Источник.\n');
  const sections = [['one', 'Глава 1', ONE], ['two', 'Глава 2', TWO]].map(([sectionId, title, body], order) => ({ sectionId, order, tabId: 't', tabTitle: 'Книга', title, label: title, hasHeading: true, hash: sectionId, body, locked: [] }));
  const manuscript = { documentId: 'fixture_doc', title: 'Книга', revisionId: 'rev1', tabs: [], sections };
  const holder = new HolderAgent();
  const app = await createApplication({ dataDir: join(root, 'data'), host: '127.0.0.1', port: 8787, vaultPath: vault, agent: holder, googleService: { ...fakeGoogle, readWorkingManuscript: async () => ({ manuscript, source: {} }) }, googleAgentService: fakeGoogle });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  let cookie = '';
  const api = async (method, path, body) => {
    const headers = { ...(body ? { 'content-type': 'application/json' } : {}), origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787', ...(cookie ? { cookie } : {}) };
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.url = path; req.headers = headers; req.socket = { remoteAddress: '127.0.0.1' };
    const response = await new Promise(resolve => app.server.emit('request', req, { statusCode: 200, headers: {}, body: '', destroyed: false, writeHead(status, h = {}) { this.statusCode = status; this.headers = h; return this; }, write(chunk) { this.body += String(chunk); return true; }, end(chunk = '') { this.body += String(chunk); resolve(this); } }));
    if (response.headers['set-cookie']) cookie = response.headers['set-cookie'].split(';')[0];
    return { status: response.statusCode, data: response.body ? JSON.parse(response.body) : {} };
  };
  await api('POST', '/api/session', { local: true });
  const project = app.workspaceService.project;
  const authorId = (await project.createAuthor({ name: 'Автор', expectedRevision: project.view().revision })).created.id;
  const seriesId = (await project.createSeries({ name: 'Серия', authorId, expectedRevision: project.view().revision })).created.id;
  const bookId = (await project.createBook({ name: 'Книга', seriesId, googleDocument: 'fixture_doc', expectedRevision: project.view().revision })).created.id;
  assert.equal((await api('POST', '/api/workspace/select', { authorId, seriesId, bookId })).status, 200);
  const attachment = project.view().attachments.find(item => item.bookId === bookId);
  assert.equal((await api('POST', '/api/manuscript/bind', { bookId, attachmentId: attachment.id })).status, 200);
  assert.equal((await api('POST', '/api/manuscript/working/import', { bookId, documentId: 'fixture_doc', version: 0 })).status, 200);
  const base = `/api/books/${bookId}/narrative`;
  let n = 0; const op = () => 'http-op-' + String(++n).padStart(4, '0');
  return { root, app, api, holder, bookId, base, op };
}

async function approvedFramework(f) {
  const stages = [{ id: 'stage-key', lineId: 'line-main', title: 'Находка ключа', expectedChange: 'Кай находит ключ', closureCriterion: 'Ключ в руках героя', disclosureConstraints: 'Не раскрывать, чей это ключ' }, { id: 'stage-home', lineId: 'line-main', title: 'Возвращение', expectedChange: 'Кай идёт домой', prerequisites: ['stage-key'] }];
  let r = await f.api('PUT', `${f.base}/book-plan-1/draft`, { expectedVersion: 0, kind: 'book', draft: { title: 'Линия Кая', intent: 'Взросление', lines: [{ id: 'line-main', title: 'Основная', primary: true }], stages }, operationId: f.op() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const plan = r.data.narrative.book;
  r = await f.api('POST', `${f.base}/book-plan-1/approve`, { expectedDraftVersion: plan.draftVersion, shownHash: plan.draftHash, expectedActiveSnapshotId: null, operationId: f.op() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await f.api('POST', `${f.base}/chapters`, { title: 'Глава 1', operationId: f.op() });
  const chapterId = r.data.receipt.chapterId;
  r = await f.api('POST', `${f.base}/chapters/${chapterId}/bind`, { expectedBindingVersion: 0, binding: { kind: 'google', key: 'one' }, operationId: f.op() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { chapterId, snapshot: r.data.narrative.book.activeSnapshot };
}

test('framework API persists plans, refuses another book and forged context, and survives reload', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('GET', f.base)).data.book, null);
  const { chapterId } = await approvedFramework(f);
  const reloaded = (await f.api('GET', f.base)).data;
  assert.deepEqual(reloaded.book.activeSnapshot.payload.stages.map(stage => stage.id), ['stage-key', 'stage-home']);
  assert.equal(reloaded.chapters[0].chapterId, chapterId); assert.equal(reloaded.chapters[0].source.status, 'bound');
  assert.equal((await f.api('GET', '/api/books/other_book/narrative')).status, 409);
  assert.equal((await f.api('POST', '/api/agent/message', { model:'fixture', text: 'x', narrativeContext: 'forged' })).status, 400);
  assert.equal((await f.api('POST', '/api/agent/message', { model:'fixture', text: 'x', narrative: { mode: 'write' }, importJobId: '00000000-0000-0000-0000-000000000000', mode: 'series_base' })).status, 400);
  assert.equal((await f.api('POST', '/api/agent/message', { model:'fixture', text: 'x', narrative: { mode: 'write' }, manuscriptChapter: { bookId: f.bookId } })).status, 400);
  const exported = (await f.api('POST', '/api/export', {})).data;
  assert.equal(exported.narrative.plans.length, 1);
});

test('write-by-framework: approved context reaches the real runner prompt in order; preview matches; mismatched text never starts a turn', async t => {
  const f = await fixture(t);
  const { chapterId, snapshot } = await approvedFramework(f);
  const calls = [];
  let beforeThread = null;
  const real = new AgentService({ dataDir: join(f.root, 'agent-data'), store: f.app.store, vaultPath: null, narrativeService: f.app.narrativeService, narrativePreflight:fixturePreflight });
  real.runner = { closed: false, async request(method, params) {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ id: 'fixture' }] };
    if (method === 'account/rateLimits/read') return {};
    if (method === 'thread/start' || method === 'thread/resume') { await beforeThread?.(); beforeThread = null; return { thread: { id: 'narrative-thread' } }; }
    if (method === 'turn/start') return { turn: { id: 'turn-' + calls.length } };
    throw new Error('Unexpected ' + method);
  } };
  f.holder.real = real;
  const narrative = { mode: 'write', chapterId, sources: [{ kind: 'google', documentId: 'fixture_doc', key: 'one', textHash: sha(ONE) }] };
  const preview = await f.api('POST', `${f.base}/context-preview`, { narrative });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const identity = JSON.stringify([f.bookId, 'fixture_doc', 'one']);
  const sent = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Напиши продолжение по каркасу', narrative, textReview: { id: 'review-1', identity, start: 0, end: 11 } });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  assert.equal(f.holder.lastMessage.narrativeContext, preview.data.narrativeContext, 'preview equals the server-staged context');
  assert.equal(f.holder.lastMessage.narrative, undefined, 'client references are replaced by server context');
  const thread = calls.find(call => call.method === 'thread/start');
  assert.ok(thread.params.dynamicTools.some(tool => tool.name === 'talewisp_propose_stage_closure'));
  const prompt = calls.filter(call => call.method === 'turn/start').at(-1).params.input.find(item => item.type === 'text').text;
  const at = marker => prompt.indexOf(marker);
  assert.ok(at('AUTHOR REQUEST:') >= 0 && at('AUTHOR REQUEST:') < at('APPROVED NARRATIVE FRAMEWORK'));
  assert.ok(at('APPROVED NARRATIVE FRAMEWORK') < at('TEXT REVIEW TARGET') && at('TEXT REVIEW TARGET') < at('READ-ONLY MANUSCRIPT CONTEXT'), 'framework precedes text review and manuscript');
  assert.ok(prompt.includes(preview.data.narrativeContext));
  for (const fact of ['Находка ключа', 'Ключ в руках героя', 'Не раскрывать, чей это ключ', 'FUTURE DISCLOSURE CONSTRAINTS', snapshot.id, `"version":1`]) assert.ok(prompt.includes(fact), 'prompt contains ' + fact);
  assert.ok(prompt.includes(ONE) && !prompt.includes(TWO), 'only the selected chapter text, read from the saved working file');
  const state = (await f.api('GET', f.base)).data;
  const request = state.requests[0];
  assert.equal(request.status, 'running'); assert.equal(request.accounting.tokenWindow, 'verified'); assert.ok(request.accounting.total > 0);
  // The proposal tool is bound to the active turn, receipt-based and cannot close.
  const receipt = await real._handleDynamicToolCall({ arguments: { stageId: 'stage-key', contentRevision: 1, snapshotId: snapshot.id, chapterId, textHash: sha(ONE), quotes: [{ quote: 'Кай нашёл ключ под камнем.' }], rationale: 'Ключ найден.' }, callId: 'call-1', threadId: real.threadId, tool: 'talewisp_propose_stage_closure', turnId: real.activeTurnId });
  assert.equal(receipt.state, 'pending');
  let view = (await f.api('GET', f.base)).data;
  assert.equal(view.book.statuses['stage-key'].state, 'proposed'); assert.equal(view.progress.length, 0, 'nothing is closed by the agent');
  real._notification({ method: 'turn/completed', params: { turn: { id: real.activeTurnId, status: 'completed' } } });
  view = (await f.api('GET', f.base)).data;
  assert.equal(view.requests[0].status, 'completed');
  await assert.rejects(real._handleDynamicToolCall({ arguments: {}, callId: 'call-2', threadId: real.threadId, tool: 'talewisp_propose_stage_closure', turnId: 'turn-old' }), /outside the active TaleWisp turn/);
  // Browser text that was not saved is refused before the runner.
  const turnsBefore = calls.filter(call => call.method === 'turn/start').length;
  const unsaved = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Ещё', narrative: { ...narrative, sources: [{ kind: 'google', documentId: 'fixture_doc', key: 'one', textHash: sha(ONE + ' несохранённая правка') }] } });
  assert.equal(unsaved.status, 409); assert.equal(unsaved.data.code, 'save_first');
  // An approval that lands between staging and turn/start cancels the start.
  beforeThread = async () => {
    const book = (await f.api('GET', f.base)).data.book;
    await f.api('PUT', `${f.base}/book-plan-1/draft`, { expectedVersion: book.draftVersion, draft: { ...book.draft, intent: 'Новый замысел' }, operationId: f.op() });
    const next = (await f.api('GET', f.base)).data.book;
    await f.api('POST', `${f.base}/book-plan-1/approve`, { expectedDraftVersion: next.draftVersion, shownHash: next.draftHash, expectedActiveSnapshotId: next.activeSnapshot.id, operationId: f.op() });
  };
  const raced = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Ещё раз', narrative });
  assert.equal(raced.status, 409); assert.equal(raced.data.code, 'narrative_changed');
  assert.equal(calls.filter(call => call.method === 'turn/start').length, turnsBefore, 'no turn started for a stale or unsaved request');
  // Ordinary requests without the framework keep their existing path and tool set.
  const plain = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Обычный вопрос' });
  assert.equal(plain.status, 202);
  const plainPrompt = calls.filter(call => call.method === 'turn/start').at(-1).params.input.find(item => item.type === 'text').text;
  assert.doesNotMatch(plainPrompt, /APPROVED NARRATIVE FRAMEWORK/);
  const plainThread = calls.filter(call => call.method === 'thread/start').at(-1);
  assert.equal(plainThread.params.dynamicTools.some(tool => tool.name === 'talewisp_propose_stage_closure'), false);
  real._notification({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
});

test('framework budget overflow returns 413 with blocks and never reaches the runner', async t => {
  const f = await fixture(t);
  const huge = Array.from({ length: 60 }, (_, i) => ({ id: 'stage-' + String(i).padStart(3, '0'), lineId: 'line-main', title: 'Этап ' + i, expectedChange: 'ж'.repeat(3900) }));
  let r = await f.api('PUT', `${f.base}/book-plan-1/draft`, { expectedVersion: 0, kind: 'book', draft: { lines: [{ id: 'line-main', title: 'Основная', primary: true }], stages: huge }, operationId: f.op() });
  const plan = r.data.narrative.book;
  r = await f.api('POST', `${f.base}/book-plan-1/approve`, { expectedDraftVersion: plan.draftVersion, shownHash: plan.draftHash, expectedActiveSnapshotId: null, operationId: f.op() });
  assert.equal(r.status, 200);
  let started = false;
  f.holder.real = { message: async () => { started = true; return { accepted: true }; } };
  const sent = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Пиши', narrative: { mode: 'write' } });
  assert.equal(sent.status, 413); assert.equal(sent.data.code, 'agent_context_too_large');
  assert.ok(sent.data.details.blocks.some(block => block.name === 'narrativeContext' && block.size > block.limit));
  assert.equal(started, false);
  const narrowed = await f.api('POST', '/api/agent/message', { model:'fixture', text: 'Пиши', narrative: { mode: 'write', focusStageIds: ['stage-001'] } });
  assert.equal(narrowed.status, 202, 'an explicitly smaller task fits');
});

test('HTTP narrative requests accept a title-only version change by text hash while ordinary stale requests still conflict',async t=>{
  const f=await fixture(t);await approvedFramework(f);
  const made=await f.api('POST','/api/documents',{title:'До',text:'Локальный текст'}),doc=made.data.document;
  assert.equal((await f.api('PUT',`/api/documents/${doc.id}`,{title:'После',text:doc.text,version:doc.version})).status,200);
  const body={text:'Обсудим',documentId:doc.id,documentVersion:doc.version,narrative:{mode:'discuss',documentHash:sha(doc.text)}};
  const result=await f.api('POST','/api/agent/message',body);
  assert.equal(result.status,202,JSON.stringify(result.data));
  assert.equal(f.holder.lastMessage.documentVersion,2);assert.equal(f.holder.lastMessage.documentSnapshot.text,doc.text);
  const {narrative,...ordinary}=body;
  assert.equal((await f.api('POST','/api/agent/message',ordinary)).status,409);
});
