import test from 'node:test';
import assert from 'node:assert/strict';
import { createNarrativePanel, sha256Hex } from '../public/narrative-panel.js';

// Minimal DOM: enough for the panel's rendering, forms and buttons.
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class FakeNode {
  constructor(doc, tag) {
    Object.assign(this, { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, dataset: {}, style: {}, hidden: false, listeners: {}, className: '', ownText: '', value: '', checked: false, disabled: false, type: '', name: '', title: '', open: false });
    const self = this;
    this.classList = {
      contains: c => self.className.split(/\s+/).includes(c),
      add: (...list) => list.forEach(c => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); }),
      remove: (...list) => list.forEach(c => { self.className = self.className.split(/\s+/).filter(x => x && x !== c).join(' '); }),
      toggle: (c, force) => { const on = force ?? !self.classList.contains(c); if (on) self.classList.add(c); else self.classList.remove(c); return on; },
    };
  }
  setAttribute(name, value) { if (name === 'class') this.className = String(value); else if (name === 'id') this.id = String(value); else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value); else this.attrs[name] = String(value); }
  getAttribute(name) { if (name === 'class') return this.className; if (name === 'id') return this.id ?? null; if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null; return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...nodes) { for (const n of nodes) { if (n.parent) n.parent.children = n.parent.children.filter(x => x !== n); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra = {}) { const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra }; for (const fn of this.listeners[type] || []) fn(event); return event; }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') { this.checked = !this.checked; this.dispatch('change'); return; }
    if (this.tagName === 'INPUT' && this.type === 'radio') { this.checked = true; this.dispatch('change'); return; }
    this.dispatch('click');
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) { const m = /^([a-z]*)(?:\.([\w-]+))?$/i.exec(selector); return !!m && (!m[1] || this.tagName === m[1].toUpperCase()) && (!m[2] || this.classList.contains(m[2])) && !!(m[1] || m[2]); }
  querySelector(selector) { for (const n of this.walk()) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { return [...this.walk()].filter(n => n.matches(selector)); }
}
let currentDoc = null;
globalThis.Option = function Option(text = '', value = '', _defaultSelected = false, selected = false) { const n = new FakeNode(currentDoc, 'option'); n.textContent = text; n.value = value; n.selected = selected; return n; };

const H = c => c.repeat(64);
const all = (rootNode, pred) => [...rootNode.walk()].filter(pred);
const buttonStarting = (rootNode, prefix) => all(rootNode, n => n.tagName === 'BUTTON' && n.textContent.startsWith(prefix))[0];
const selectLabeled = (rootNode, label) => all(rootNode, n => n.tagName === 'SELECT' && n.attrs['aria-label'] === label)[0];
const choose = (select, value) => { select.value = value; select.dispatch('change'); };
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

const stage = (id, title, expectedChange, extra = {}) => ({ id, lineId: 'line-main1', title, expectedChange, closureCriterion: '', participants: [], prerequisites: [], disclosureConstraints: '', causality: '', parentStageIds: [], archived: false, contentRevision: 1, ...extra });
const status = (state = 'not_started') => state === 'closed' ? { state, stored: state, tone: 'current', label: 'Закрыт · фрагмент актуален', icon: '✓', closure: 'current', progressVersion: 2 } : { state, stored: state, tone: 'none', label: 'Не начат', icon: '○', progressVersion: 0 };
function bookPlan({ id = 'plan-book1', draftHash = H('d'), draftVersion = 3, intent = 'Новый замысел' } = {}) {
  const active = { kind: 'book', title: 'Линия', intent: 'Старый замысел', outcome: '', constraints: '', lines: [{ id: 'line-main1', title: 'Основная', primary: true }], stages: [stage('stage-aa1', 'Встреча', 'Кай встречает Лину', { closureCriterion: 'Они говорят' }), stage('stage-bb2', 'Ссора', 'Они ссорятся')] };
  const draft = { ...structuredClone(active), intent, stages: [stage('stage-aa1', 'Встреча', 'Кай спасает Лину', { closureCriterion: 'Лина благодарит' }), stage('stage-cc3', 'Побег', 'Они бегут из города')] };
  return { id, kind: 'book', chapterId: null, activeSnapshot: { id: 'snap-1', version: 1, hash: H('a'), approvedAt: '2026-10-01T10:00:00Z', payload: active }, draft, draftVersion, draftHash, draftStatus: 'draft', draftDiffersFromActive: true, snapshots: [{ id: 'snap-1', version: 1, approvedAt: '2026-10-01T10:00:00Z' }], statuses: { 'stage-aa1': status('closed'), 'stage-bb2': status() } };
}
const chapterRow = (chapterId, title, extra = {}) => ({ chapterId, title, order: 0, archived: false, version: 1, binding: null, bindingVersion: 0, sourceIdentity: null, transferReceipt: null, source: { status: 'planned', hash: null }, compatibility: null, counter: { label: 'План не согласован', approved: false, stale: false },
  plan: { id: 'plan-' + chapterId, kind: 'chapter', chapterId, activeSnapshot: null, draft: { kind: 'chapter', chapterId, title: 'Сюжетка ' + title, goal: 'Цель ' + title, outcome: '', knowledgeBounds: '', stages: [] }, draftVersion: 2, draftHash: H('e'), draftStatus: 'draft', draftDiffersFromActive: true, snapshots: [], statuses: {} }, ...extra });
const narrative = (extra = {}) => ({ book: bookPlan(), chapters: [], textSources: { google: { documentId: 'doc-new', chapters: [] }, documents: [] }, evidence: [], proposals: [], progress: [], requests: [], strict: false, prefsVersion: 0, ...extra });

function setup({ routes = {}, ask = async () => 'confirm', flushSource = async () => {}, captureAgentContext = () => ({ chapters: [] }), getEditor } = {}) {
  const doc = currentDoc = { activeElement: null };
  doc.createElement = tag => new FakeNode(doc, tag);
  doc.createTextNode = text => { const n = new FakeNode(doc, '#text'); n.ownText = String(text); return n; };
  doc.body = new FakeNode(doc, 'body');
  const root = doc.createElement('aside'), attach = doc.createElement('div');
  const map = new Map(), storage = { map, getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
  const calls = [], notes = [], asked = [];
  const api = async (url, opts = {}) => {
    const method = opts.method ?? 'GET', handler = routes[`${method} ${url}`];
    calls.push({ url, method, body: opts.body });
    if (!handler) throw Object.assign(new Error(`unexpected ${method} ${url}`), { status: 500 });
    return handler(opts.body);
  };
  const panel = createNarrativePanel({ document: doc, window: { crypto: globalThis.crypto }, storage, api, notify: (text, error) => notes.push({ text, error: !!error }), ask: async (...args) => { asked.push(args); return ask(...args); }, root, attachRoot: attach, flushSource, captureAgentContext, getEditor });
  return { doc, root, attach, storage, map, calls, notes, asked, panel };
}

test('a late draft-save reply touches only its own editor: book switch keeps B input, recovery and open form', async () => {
  const pending = deferred();
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'GET /api/books/book-2/narrative': () => narrative({ book: bookPlan({ id: 'plan-book2' }) }),
    'PUT /api/books/book-1/narrative/plan-book1/draft': () => pending.promise,
  } });
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Изменить черновик').click();
  const formA = t.root.querySelector('form'), titleA = formA.querySelector('input');
  titleA.value = 'Ввод A'; titleA.dispatch('input');
  formA.dispatch('submit');
  await settle();
  assert.ok(t.map.has('talewisp.narrative.v1.book-1.book'), 'A keeps a recovery copy while its save is in flight');

  await t.panel.load('book-2');
  buttonStarting(t.root, 'Изменить черновик').click();
  const formB = t.root.querySelector('form'), titleB = formB.querySelector('input');
  titleB.value = 'Ввод B'; titleB.dispatch('input');
  await wait(350);
  assert.equal(JSON.parse(t.map.get('talewisp.narrative.v1.book-2.book')).draft.title, 'Ввод B');

  pending.resolve({ receipt: { draftVersion: 4 }, narrative: narrative() });
  await settle();
  assert.equal(t.map.has('talewisp.narrative.v1.book-1.book'), false, 'A clears only its own book key');
  assert.equal(JSON.parse(t.map.get('talewisp.narrative.v1.book-2.book')).draft.title, 'Ввод B', 'B recovery input survives');
  assert.equal(t.root.querySelector('form'), formB, 'B form stays open');
  assert.equal(formB.querySelector('input').value, 'Ввод B');
  assert.equal(t.panel.hasUnsavedDraft(), true);
  assert.ok(t.notes.some(note => note.text.includes('Черновик сохранён (версия 4)')));
});

test('a late save of a cancelled editor does not remove a newer editor of the same plan', async () => {
  const pending = deferred();
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'PUT /api/books/book-1/narrative/plan-book1/draft': () => pending.promise,
  } });
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Изменить черновик').click();
  let form = t.root.querySelector('form'); const a = form.querySelector('input'); a.value = 'Ввод A'; a.dispatch('input');
  form.dispatch('submit'); await settle();
  buttonStarting(form, 'Отменить').click(); await settle();
  assert.equal(t.root.querySelector('form'), null);
  buttonStarting(t.root, 'Изменить черновик').click();
  form = t.root.querySelector('form'); const b = form.querySelector('input'); b.value = 'Ввод B'; b.dispatch('input');
  await wait(350);
  pending.resolve({ receipt: { draftVersion: 4 }, narrative: narrative() });
  await settle();
  assert.equal(JSON.parse(t.map.get('talewisp.narrative.v1.book-1.book')).draft.title, 'Ввод B', 'the record now owned by B is kept');
  // The same-book reply refreshes data and re-renders, but B stays the open editor with its input.
  assert.equal(t.root.querySelector('form').querySelector('input').value, 'Ввод B');
  assert.equal(t.panel.hasUnsavedDraft(), true);
});

test('a late 409 of an editor from an earlier opening (A → B → A) does not overwrite the restored, newer input', async () => {
  const pending = deferred();
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'GET /api/books/book-2/narrative': () => narrative({ book: bookPlan({ id: 'plan-book2' }) }),
    'PUT /api/books/book-1/narrative/plan-book1/draft': () => pending.promise,
  } });
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Изменить черновик').click();
  const formA = t.root.querySelector('form'), a = formA.querySelector('input'); a.value = 'Ввод A'; a.dispatch('input');
  formA.dispatch('submit'); await settle();
  await t.panel.load('book-2');
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Изменить черновик').click();
  const form = t.root.querySelector('form'), input = form.querySelector('input');
  assert.equal(input.value, 'Ввод A', 'the reopened editor restores the recovery copy');
  input.value = 'Ввод A2'; input.dispatch('input');
  await wait(350);
  const gets = t.calls.filter(call => call.method === 'GET').length;

  pending.reject(Object.assign(new Error('Черновик изменён на сервере.'), { status: 409 }));
  await settle();
  assert.equal(JSON.parse(t.map.get('talewisp.narrative.v1.book-1.book')).draft.title, 'Ввод A2', 'the new editor keeps its recovery record');
  assert.equal(t.root.querySelector('form'), form, 'the open form is not re-rendered or replaced');
  assert.equal(form.querySelector('input').value, 'Ввод A2');
  assert.equal(t.root.querySelector('.narr-conflict'), null, 'the old conflict is not shown on the new editor');
  assert.equal(t.calls.filter(call => call.method === 'GET').length, gets, 'the obsolete reply does not reload the book');
  assert.equal(t.panel.hasUnsavedDraft(), true);
  assert.ok(t.notes.some(note => note.error && note.text.includes('Черновик изменён на сервере.')));
});

test('an operation reply from an earlier opening of the same book (A → B → A) is not applied; its receipt is kept', async () => {
  const pending = deferred();
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'GET /api/books/book-2/narrative': () => narrative(),
    'PUT /api/books/book-1/narrative/prefs': () => pending.promise,
  } });
  await t.panel.load('book-1');
  const strict = all(t.root, n => n.tagName === 'INPUT' && n.type === 'checkbox' && n.parent?.textContent.includes('Строгая проверка'))[0];
  strict.click(); await settle();
  await t.panel.load('book-2');
  await t.panel.load('book-1');
  const gets = t.calls.filter(call => call.url === '/api/books/book-1/narrative').length;

  pending.resolve({ receipt: { prefsVersion: 1 }, narrative: narrative({ strict: true, prefsVersion: 1 }) });
  await settle();
  assert.equal(strict.checked, false, 'the reply snapshot of the first opening does not replace the current data');
  assert.equal(t.calls.filter(call => call.url === '/api/books/book-1/narrative').length, gets + 1, 'the current opening re-reads the book instead');
  assert.ok(t.notes.some(note => !note.error && note.text.includes('Строгая проверка включена')), 'the server receipt is still reported');
});

test('a context preview or prepared request from an earlier opening of the same book (A → B → A) is discarded', async () => {
  const pending = deferred();
  let onFlush = async () => {};
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'GET /api/books/book-2/narrative': () => narrative(),
    'POST /api/books/book-1/narrative/context-preview': () => pending.promise,
  }, flushSource: async () => onFlush() });
  await t.panel.load('book-1');
  all(t.root, n => n.dataset.tab === 'agent')[0].click();
  choose(selectLabeled(t.root, 'Каркас в запросе агенту'), 'discuss');
  buttonStarting(t.root, 'Показать контекст для агента').click(); await settle();
  await t.panel.load('book-2');
  await t.panel.load('book-1');
  pending.resolve({ manifest: { mode: 'discuss', blocks: [], sources: [], contextHash: H('c'), book: { version: 1 }, chapter: null, draftDiscussion: null }, narrativeContext: 'STALE-CTX' });
  await settle();
  assert.equal(t.root.querySelector('.narr-preview'), null, 'the old preview is not shown for the new opening');
  assert.ok(!t.root.textContent.includes('STALE-CTX'));

  onFlush = async () => { await t.panel.load('book-2'); await t.panel.load('book-1'); };
  await assert.rejects(t.panel.prepareAgentRequest({ chapters: [{ bookId: 'book-1', documentId: 'doc-new', sectionId: 'sec-1', text: 'Глава.' }] }), /Книга сменилась/);
});

test('approval review shows exact old/new values, removed and added stages, the full candidate and sends its server hash', async () => {
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => narrative(),
    'POST /api/books/book-1/narrative/plan-book1/approve': () => ({ receipt: { version: 2 }, narrative: narrative() }),
  } });
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Проверить и согласовать').click();
  const review = t.root.querySelector('.narr-review');
  assert.ok(review, 'the review opens before any approval');
  for (const text of ['Старый замысел', 'Новый замысел', 'Кай встречает Лину', 'Кай спасает Лину', 'Они говорят', 'Лина благодарит', '«Ссора» — удалён из черновика', 'Они ссорятся', '«Побег» — добавлен', 'Они бегут из города', 'черновик 3 · sha256 dddddddddddd'])
    assert.ok(review.textContent.includes(text), 'review shows: ' + text);
  const candidate = review.querySelector('.narr-candidate').textContent;
  assert.ok(candidate.includes('Новый замысел') && candidate.includes('Кай спасает Лину') && candidate.includes('Лина благодарит') && candidate.includes('Они бегут из города'));
  assert.ok(!candidate.includes('Они ссорятся') && !candidate.includes('Кай встречает Лину'), 'the candidate is the new version only');
  assert.equal(t.calls.filter(call => call.url.endsWith('/approve')).length, 0, 'opening the review sends nothing');
  buttonStarting(review, 'Согласовать эту версию').click(); await settle();
  assert.ok(t.asked[0][1].includes('sha256 dddddddddddd'));
  const approve = t.calls.find(call => call.url.endsWith('/approve'));
  assert.deepEqual({ ...approve.body, operationId: undefined }, { expectedDraftVersion: 3, shownHash: H('d'), expectedActiveSnapshotId: 'snap-1', operationId: undefined });
});

test('approval refuses when the server draft changed after it was shown', async () => {
  let current = narrative();
  const t = setup({
    routes: { 'GET /api/books/book-1/narrative': () => current, 'POST /api/books/book-1/narrative/plan-book1/approve': () => ({ receipt: { version: 2 }, narrative: current }) },
    ask: async () => { current = narrative({ book: bookPlan({ draftHash: H('f'), draftVersion: 4, intent: 'Третий замысел' }) }); await t.panel.refresh(); return 'confirm'; },
  });
  await t.panel.load('book-1');
  buttonStarting(t.root, 'Проверить и согласовать').click();
  buttonStarting(t.root.querySelector('.narr-review'), 'Согласовать эту версию').click(); await settle();
  assert.equal(t.calls.filter(call => call.url.endsWith('/approve')).length, 0, 'nothing unseen is approved');
  assert.ok(t.notes.some(note => note.error && note.text.includes('Ничего не согласовано')));
  assert.ok(t.root.querySelector('.narr-review').textContent.includes('Третий замысел'), 'the review now shows the new server draft');
});

test('discussion draft target is an explicit choice fixed to its chapter, the same for preview and send', async () => {
  const data = narrative({ chapters: [chapterRow('chap-0001', 'Глава 1'), chapterRow('chap-0002', 'Глава 2')] });
  const t = setup({ routes: {
    'GET /api/books/book-1/narrative': () => data,
    'POST /api/books/book-1/narrative/context-preview': body => ({ manifest: { mode: body.narrative.mode, blocks: [], sources: [], contextHash: H('c'), book: { version: 1 }, chapter: { chapterId: body.narrative.chapterId, version: null }, draftDiscussion: { kind: body.narrative.includeDraft, draftVersion: 2 } }, narrativeContext: 'CTX' }),
  } });
  await t.panel.load('book-1');
  all(t.root, n => n.dataset.tab === 'chapter')[0].click();
  choose(selectLabeled(t.root, 'Глава каркаса'), 'chap-0001');
  all(t.root, n => n.dataset.tab === 'agent')[0].click();
  choose(selectLabeled(t.root, 'Каркас в запросе агенту'), 'discuss');
  const radio = value => all(t.root, n => n.tagName === 'INPUT' && n.name === 'narr-draft-target' && n.value === value)[0];
  assert.equal(radio('chapter').disabled, false);
  assert.ok(radio('chapter').parent.textContent.includes('«Глава 1»'));
  radio('chapter').click();

  buttonStarting(t.root, 'Показать контекст для агента').click(); await settle();
  const preview = t.calls.find(call => call.url.endsWith('/context-preview')).body.narrative;
  assert.equal(preview.includeDraft, 'chapter'); assert.equal(preview.chapterId, 'chap-0001');
  assert.ok(t.root.textContent.includes('Черновик для обсуждения: сюжетка «Глава 1», версия 2'));
  const notice = t.root.querySelector('.narr-preview').textContent;
  assert.ok(notice.includes('каркас — до 24 000 знаков, главы — до 120 000') && notice.includes('Окно модели и полный объём запроса не проверяются'), 'discussion states only its real block limits');
  assert.ok(!notice.includes('480 000'), 'the write-only prompt ceiling is not claimed for discussion');

  // Sending reads the same captured choice — not the visible tab (the Agent tab used to force the book draft).
  const sent = await t.panel.prepareAgentRequest({ chapters: [] });
  assert.deepEqual({ includeDraft: sent.includeDraft, chapterId: sent.chapterId }, { includeDraft: 'chapter', chapterId: 'chap-0001' });
  all(t.root, n => n.dataset.tab === 'book')[0].click();
  assert.equal((await t.panel.prepareAgentRequest({ chapters: [] })).includeDraft, 'chapter');
  assert.ok(t.attach.textContent.includes('черновик сюжетки «Глава 1»'));

  // Another chapter is not silently substituted.
  all(t.root, n => n.dataset.tab === 'chapter')[0].click();
  choose(selectLabeled(t.root, 'Глава каркаса'), 'chap-0002');
  await assert.rejects(t.panel.prepareAgentRequest({ chapters: [] }), /другой главы/);
  all(t.root, n => n.dataset.tab === 'agent')[0].click();
  assert.ok(t.root.textContent.includes('Выберите черновик заново'));
  radio('book').click();
  assert.equal((await t.panel.prepareAgentRequest({ chapters: [] })).includeDraft, 'book');
  radio('').click();
  assert.equal((await t.panel.prepareAgentRequest({ chapters: [] })).includeDraft, undefined);
});

test('Google sources carry the captured manuscript documentId; a switched book fails closed', async () => {
  let onFlush = async () => {};
  const t = setup({ routes: { 'GET /api/books/book-1/narrative': () => narrative(), 'GET /api/books/book-2/narrative': () => narrative() }, flushSource: async () => onFlush() });
  await t.panel.load('book-1');
  choose(t.attach.querySelector('select'), 'discuss');
  const text = 'Глава один.', hash = await sha256Hex(text);
  const sent = await t.panel.prepareAgentRequest({ chapters: [{ bookId: 'book-1', documentId: 'doc-old', sectionId: 'sec-1', text }] });
  assert.deepEqual(sent.sources, [{ kind: 'google', documentId: 'doc-old', key: 'sec-1', textHash: hash }], 'captured doc-old, not the active doc-new');
  await assert.rejects(t.panel.prepareAgentRequest({ chapters: [{ bookId: 'book-1', sectionId: 'sec-1', text }] }), /документ рукописи/);
  await assert.rejects(t.panel.prepareAgentRequest({ chapters: [{ bookId: 'book-2', documentId: 'doc-old', sectionId: 'sec-1', text }] }), /Книга сменилась/);
  onFlush = () => t.panel.load('book-2');
  await assert.rejects(t.panel.prepareAgentRequest({ chapters: [{ bookId: 'book-1', documentId: 'doc-old', sectionId: 'sec-1', text }] }), /Книга сменилась/);
});

test('a local draft is saved before its hash is taken; typing, another draft or a book switch during the save fail closed', async () => {
  const flushed = [], saved = 'Черновик главы.';
  let editor = { identity: 'document:doc-7', text: saved }, onFlush = async () => {};
  const t = setup({ routes: { 'GET /api/books/book-1/narrative': () => narrative(), 'GET /api/books/book-2/narrative': () => narrative() },
    flushSource: async source => { flushed.push(source); await onFlush(); }, getEditor: () => ({ get: () => editor }) });
  await t.panel.load('book-1');
  choose(t.attach.querySelector('select'), 'discuss');

  const sent = await t.panel.prepareAgentRequest({ document: { id: 'doc-7', text: saved } });
  assert.deepEqual(flushed, [{ kind: 'document', id: 'doc-7' }], 'the local draft itself is flushed, not the Google working file');
  assert.equal(sent.documentHash, await sha256Hex(saved));

  onFlush = async () => { editor = { ...editor, text: saved + ' Ещё.' }; };
  await assert.rejects(t.panel.prepareAgentRequest({ document: { id: 'doc-7', text: saved } }), /изменился во время сохранения/, 'text typed during the save');
  onFlush = async () => { editor = { identity: 'document:doc-8', text: saved }; };
  await assert.rejects(t.panel.prepareAgentRequest({ document: { id: 'doc-7', text: saved } }), /изменился во время сохранения/, 'another draft opened during the save');
  onFlush = async () => { throw new Error('Черновик не сохранён на сервере.'); };
  await assert.rejects(t.panel.prepareAgentRequest({ document: { id: 'doc-7', text: saved } }), /не сохранён/, 'a failed save is not hashed');
  await assert.rejects(t.panel.prepareAgentRequest({ document: { text: saved } }), /ещё не сохранён/, 'a draft without a server id');
  editor = { identity: 'document:doc-7', text: saved };
  onFlush = () => t.panel.load('book-2');
  await assert.rejects(t.panel.prepareAgentRequest({ document: { id: 'doc-7', text: saved } }), /Книга сменилась/);
});

test('write mode explains the fail-closed host preflight and keeps discussion distinct', async () => {
  const t = setup({ routes: { 'GET /api/books/book-1/narrative': () => narrative() } });
  await t.panel.load('book-1');
  all(t.root, n => n.dataset.tab === 'agent')[0].click();
  choose(selectLabeled(t.root, 'Каркас в запросе агенту'), 'write');
  const note = t.root.querySelector('.narr-preflight');
  assert.ok(note && note.textContent.includes('доверенным адаптером хоста') && note.textContent.includes('«Обсудить план»'));
  assert.ok(t.attach.textContent.includes('нужна проверка окна модели хостом'));
  choose(selectLabeled(t.root, 'Каркас в запросе агенту'), 'discuss');
  assert.equal(t.root.querySelector('.narr-preflight'), null);
  assert.ok(!t.attach.textContent.includes('проверка окна'));
});

test('a write receipt offers explicit manual mapping instead of a title-based transfer', async () => {
  const chapter = chapterRow('chap-0001', 'Новая глава', { binding: { kind: 'google', documentId: 'doc-new', key: 'new:k1' }, transferReceipt: 'apply-op-1', source: { status: 'missing', hash: null } });
  const t = setup({ routes: { 'GET /api/books/book-1/narrative': () => narrative({ chapters: [chapter], textSources: { google: { documentId: 'doc-new', chapters: [{ key: 'sec-9', title: 'Новая глава' }] }, documents: [] } }) } });
  await t.panel.load('book-1');
  all(t.root, n => n.dataset.tab === 'chapter')[0].click();
  choose(selectLabeled(t.root, 'Глава каркаса'), 'chap-0001');
  assert.equal(buttonStarting(t.root, 'Перенести привязку по квитанции'), undefined);
  const hint = t.root.querySelector('.narr-manual-map');
  assert.ok(hint && hint.textContent.includes('Выберите записанную главу') && hint.textContent.includes('не переносятся'));
  assert.ok(selectLabeled(t.root, 'Выберите записанную главу Google вручную'), 'the manual chapter picker is offered');
  assert.equal(t.calls.some(call => call.body?.receiptOperationId), false);
});
