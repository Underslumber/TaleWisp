import test from 'node:test';
import assert from 'node:assert/strict';
import { createChapterWorkspace } from '../public/chapter-workspace.js';

// Wiring tests of the real chapter workspace against a minimal fake DOM and a disposable fake TaleWisp API.
// No browser, no Google: every response below is synthetic.
class FakeElement {
  constructor(tag, owner) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], listeners: {}, attributes: {}, dataset: {}, hidden: false, value: '', textContent: '', disabled: false, readOnly: false, checked: false, id: '', className: '', selectionStart: 0, selectionEnd: 0 });
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); } };
    owner?.created.push(this);
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  after(node) { this.sibling = node; }
  replaceChildren(...nodes) { this.children = nodes; }
  remove() {}
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  click() { this.dispatch('click'); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  showModal() {}
  getBoundingClientRect() { return { width: 1200 }; }
}
globalThis.Option = class extends FakeElement {
  constructor(text = '', value = '', defaultSelected = false, selected = false) { super('option'); this.textContent = text; this.value = value; this.selected = selected; }
};

function* walk(node) { yield node; for (const child of node?.children ?? []) yield* walk(child); }
const all = root => [...walk(root)];
const findButton = (root, prefix) => all(root).find(n => n.tagName === 'BUTTON' && n.textContent.startsWith(prefix));
const loadedTitles = h => all(h.elements.rail).filter(n => n.className === 'loaded-open').map(n => n.textContent);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const SECTIONS = [['h:t:prolog', 'Пролог'], ['h:t:one', 'Глава 1. Начало'], ['h:t:two', 'Глава 2']].map(([sectionId, title], order) => ({
  sectionId, order, tabId: 't', tabTitle: 'Книга', tabPath: ['Книга'], tabDepth: 0, detection: 'heading', level: 1, hasHeading: true, headingId: 'h' + order,
  namedStyleType: 'HEADING_1', title, label: title, startIndex: 1, endIndex: 2, paragraphCount: 1, wordCount: 3, lockedCount: 0, hash: 'hash-' + sectionId,
}));

// The reply is computed when the request is sent (as the server would answer for the book active then);
// paths in `hold` are delivered only when the test releases them.
function fakeServer() {
  const server = { book: 'book-a', hold: new Set(), waiting: [] };
  const reply = (path, body) => {
    const documentId = 'doc-' + server.book, binding = { attachmentId: 'att-' + server.book, documentId, name: 'Рукопись ' + server.book };
    if (path === '/api/manuscript') return { bookId: server.book, binding, candidates: [{ attachmentId: binding.attachmentId, name: binding.name }] };
    if (path === '/api/manuscript/read') return { binding, manuscript: { documentId, title: binding.name, revisionId: 'rev-1', headingsFound: true, pendingOperations: [], tabs: [{ tabId: 't', title: 'Книга', depth: 0, path: ['Книга'], detection: 'heading', sectionCount: 3 }], sections: SECTIONS } };
    if (path === '/api/manuscript/sections') return { documentId, title: binding.name, revisionId: 'rev-1', missing: [], sections: SECTIONS.filter(item => body.sectionIds.includes(item.sectionId)).map(item => ({ ...item, body: `Текст «${item.title}» из ${documentId}.`, locked: [] })) };
    throw new Error('unexpected ' + path);
  };
  server.api = async (path, options = {}) => {
    const result = reply(path, options.body);
    if (!server.hold.has(path)) return result;
    return new Promise(resolve => server.waiting.push({ path, release: () => resolve(result) }));
  };
  server.release = async ({ reverse = false } = {}) => {
    const batch = server.waiting.splice(0);
    for (const item of reverse ? batch.reverse() : batch) { item.release(); await flush(); }
  };
  return server;
}

const memoryStorage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }; };
const quotaStorage = () => ({ getItem: () => null, setItem: () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); } });

function harness(server, storage = memoryStorage()) {
  const document = { created: [], visibilityState: 'visible', addEventListener() {}, createElement(tag) { return new FakeElement(tag, this); }, createTextNode: text => ({ textContent: text }) };
  document.body = new FakeElement('body');
  const window = { addEventListener() {}, crypto: { randomUUID: () => 'id' + Math.random().toString(36).slice(2) } };
  const el = tag => new FakeElement(tag);
  const elements = { toggle: el('button'), rail: el('aside'), body: el('div'), scroll: el('div'), documentEditor: el('div'), pane: el('section'), kindLabel: el('span'), crumbTitle: el('span'), historyButton: el('button'), readonlyBadge: el('span') };
  const notices = [], routes = { showEditor: 0 };
  const ws = createChapterWorkspace({
    document, window, storage, api: server.api, notify: (message, error = false) => notices.push({ message, error }), ask: async () => 'confirm', elements,
    onActiveChange() {}, onSelection() {}, onTextChange() {}, openSettings() {},
    // The app's showChapterEditor() calls navState(), which reports a route change back to the workspace.
    showEditor: () => { routes.showEditor++; ws.noteRoute(); },
  });
  const textarea = () => document.created.find(n => n.id === 'chapter-text');
  return { ws, elements, notices, routes, textarea, document };
}

function pickAndLoad(h, titles) {
  for (const title of titles) {
    const item = all(h.elements.rail).find(n => n.className === 'toc-item' && all(n).some(c => c.className === 'toc-title' && c.textContent === title));
    assert.ok(item, `«${title}» is in the table of contents`);
    const check = item.children[0]; check.checked = true; check.dispatch('change');
  }
  findButton(h.elements.rail, 'Загрузить выбранные').click();
}
function edit(h, value) { const area = h.textarea(); area.value = value; area.dispatch('input'); }

test('a late chapter read never navigates back after the author left, including leave → return and an exit before the first open', async () => {
  const server = fakeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  server.hold.add('/api/manuscript/sections');

  pickAndLoad(h, ['Глава 1. Начало']);
  h.ws.noteRoute(); // the author opens Settings while the read is pending (app navState)
  await server.release();
  assert.equal(h.routes.showEditor, 0, 'the late response does not switch the app back to the editor');
  assert.equal(h.ws.active(), false);
  assert.deepEqual(loadedTitles(h), ['Глава 1. Начало'], 'the loaded chapter is kept for later');
  assert.ok(h.notices.some(n => /Главы загружены/.test(n.message)));

  pickAndLoad(h, ['Глава 2']);
  h.ws.noteRoute(); h.ws.noteRoute(); // Settings → back to the editor (A → B → A)
  await server.release();
  assert.equal(h.routes.showEditor, 0, 'returning to the same route does not revive the old request');

  pickAndLoad(h, ['Пролог']);
  h.ws.deactivate(); // the app opens a local draft while no chapter was open yet
  await server.release();
  assert.equal(h.routes.showEditor, 0, 'leaving chapter mode cancels pending navigation even when nothing was open');
  assert.deepEqual(loadedTitles(h), ['Пролог', 'Глава 1. Начало', 'Глава 2']);

  server.hold.clear();
  pickAndLoad(h, ['Глава 2']); await flush();
  assert.equal(h.routes.showEditor, 1, 'an undisturbed read opens the chapter; the app route change for that open is not a leave');
  assert.equal(h.ws.active(), true);
  assert.equal(h.elements.crumbTitle.textContent, 'Глава 2');
});

test('a book switch drops late reads (A → B → A) and an old binding read never suppresses the new book', async () => {
  const server = fakeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  server.hold.add('/api/manuscript/sections');
  pickAndLoad(h, ['Пролог']);
  server.book = 'book-b'; await h.ws.syncBook('book-b'); await flush();
  server.book = 'book-a'; await h.ws.syncBook('book-a'); await flush();
  await server.release();
  assert.deepEqual(loadedTitles(h), [], 'the response requested before the A → B → A switch is discarded');
  assert.equal(h.routes.showEditor, 0);
  assert.equal(findButton(h.elements.rail, 'Загрузить').textContent.startsWith('Загружаю'), false, 'the dropped read leaves no busy state');

  server.hold.clear(); server.hold.add('/api/manuscript');
  server.book = 'book-c'; const first = h.ws.syncBook('book-c');
  server.book = 'book-d'; const second = h.ws.syncBook('book-d');
  await server.release({ reverse: true });
  await Promise.all([first, second]); await flush();
  const picked = all(h.elements.rail).filter(n => n.tagName === 'STRONG').map(n => n.textContent);
  assert.deepEqual(picked, ['Рукопись book-d'], 'the new book got its own binding read; the late one for the old book was ignored');
  assert.ok(all(h.elements.rail).some(n => n.className === 'toc-title' && n.textContent === 'Пролог'), 'the new book’s table of contents was read');
});

test('quota-exceeded or missing browser storage never loses unsaved chapter text across book switches and blocks a silent unload', async () => {
  for (const [label, storage] of [['quota', quotaStorage()], ['no storage', null]]) {
    const server = fakeServer(), h = harness(server, storage);
    await h.ws.syncBook('book-a'); await flush();
    pickAndLoad(h, ['Пролог']); await flush();
    edit(h, 'Мой несохранённый пролог.');
    server.book = 'book-b'; await h.ws.syncBook('book-b'); await flush();
    assert.ok(h.notices.some(n => n.error && /не сохраняет правки глав/.test(n.message)), label + ': the author is told');
    assert.equal(h.ws.hasUnsafeDrafts(), true, label + ': the app beforeunload guard refuses a silent unload');
    assert.ok(findButton(h.elements.rail, 'Скачать незаписанные правки'), label + ': an explicit recovery download is offered');
    server.book = 'book-a'; await h.ws.syncBook('book-a'); await flush();
    assert.deepEqual(loadedTitles(h), ['● Пролог'], label + ': the dirty chapter is back after switch → return');
    assert.match(h.ws.currentText(), /Мой несохранённый пролог\./, label + ': with the unsaved text');
  }
  const ok = harness(fakeServer());
  await ok.ws.syncBook('book-a'); await flush();
  pickAndLoad(ok, ['Пролог']); await flush(); edit(ok, 'Правка.');
  assert.equal(ok.ws.hasUnsafeDrafts(), false, 'working storage does not block unloading');
});

test('reading another chapter never shows the review/apply busy state and review stays usable for a dirty chapter', async () => {
  const server = fakeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  pickAndLoad(h, ['Пролог']); await flush();
  edit(h, 'Пролог, исправленный.');
  const review = () => findButton(h.elements.rail, 'Проверить и записать в Google');
  assert.equal(review().disabled, false);
  server.hold.add('/api/manuscript/sections');
  pickAndLoad(h, ['Глава 1. Начало']);
  assert.equal(findButton(h.elements.rail, 'Загружаю').disabled, true, 'the load button shows the read');
  assert.ok(review() && !review().disabled, 'the review button is untouched by a read');
  await server.release();
  assert.equal(h.elements.crumbTitle.textContent, 'Глава 1. Начало', 'the newly read chapter is open');
  assert.ok(review() && !review().disabled, 'review is usable after the read completes');
  assert.ok(!findButton(h.elements.rail, 'Готовлю проверку'), 'no stale review status');
  assert.ok(findButton(h.elements.rail, 'Загрузить выбранные'), 'the load button is back to normal');
  assert.deepEqual(loadedTitles(h), ['● Пролог', 'Глава 1. Начало'], 'the dirty Prologue is kept');
});

// A disposable fake of the chapter API with a mutable document. Each reply is computed when the request is
// sent, so a held read carries the document as it was then (e.g. the text before a write).
function writeServer() {
  // `applyFail`: 'lost' (batch applied, reply lost), 'review' (batch applied, readback mismatch) — both leave a
  // pending operation until the author reconciles; 'conflict' (refused before any write). `titleGuard` mirrors
  // the server's CHAPTER_TITLE_EXISTS refusal.
  const server = { rev: 1, created: 0, failSections: false, applyFail: null, titleGuard: false, pending: [], holdOnce: [], waiting: [], calls: [], chapters: [{ id: 'h:t:prolog', title: 'Пролог', body: 'Старый пролог.' }, { id: 'h:t:one', title: 'Глава 1', body: 'Старая глава.' }] };
  server.binding = { attachmentId: 'att-a', documentId: 'doc-a', name: 'Рукопись' }; // replaceable: another manuscript of the same book
  const publicSection = (chapter, order) => ({ sectionId: chapter.id, order, tabId: 't', tabTitle: 'Книга', tabPath: ['Книга'], tabDepth: 0, detection: 'heading', level: 1, hasHeading: true, headingId: chapter.id, namedStyleType: 'HEADING_1', title: chapter.title, label: chapter.title, startIndex: 1, endIndex: 2, paragraphCount: 1, wordCount: 2, lockedCount: 0, hash: `${chapter.title}|${chapter.body}` });
  const reply = (path, body) => {
    server.calls.push({ path, body: structuredClone(body ?? null) });
    const revisionId = 'rev-' + server.rev, sections = server.chapters.map(publicSection), binding = { ...server.binding };
    if (path === '/api/manuscript') return { bookId: 'book-a', binding, candidates: [binding] };
    if (path === '/api/manuscript/read') return { binding, manuscript: { documentId: binding.documentId, title: 'Рукопись', revisionId, headingsFound: true, pendingOperations: structuredClone(server.pending), tabs: [{ tabId: 't', title: 'Книга', depth: 0, path: ['Книга'], detection: 'heading', sectionCount: sections.length }], sections } };
    if (path === '/api/manuscript/sections') {
      if (server.failSections) throw Object.assign(new Error('Google временно недоступен. Повторите позже.'), { code: 'google_unavailable' });
      return { documentId: binding.documentId, title: 'Рукопись', revisionId, missing: [], sections: sections.filter(item => body.sectionIds.includes(item.sectionId)).map(item => ({ ...item, body: server.chapters.find(chapter => chapter.id === item.sectionId).body, locked: [] })) };
    }
    const titleTaken = () => server.titleGuard && body.newChapters.some((chapter, i) => server.chapters.some(item => item.title === chapter.title.trim()) || body.newChapters.slice(0, i).some(other => other.title.trim() === chapter.title.trim()));
    const titleExists = () => Object.assign(new Error('Глава уже есть во вкладке — возможно, она уже записана. Ничего не записано.'), { code: 'chapter_title_exists' });
    if (path === '/api/google/reconcile') { server.pending = server.pending.filter(item => item.operationId !== body.operationId); return { ok: true }; }
    if (path === '/api/manuscript/stage' && titleTaken()) throw titleExists();
    if (path === '/api/manuscript/stage') return { review: { documentTitle: 'Рукопись', revisionId, planHash: 'a'.repeat(64), requestCount: 2, warnings: [], changes: [] }, pendingOperations: [] };
    if (path === '/api/manuscript/apply') {
      if (server.pending.length) throw Object.assign(new Error('Предыдущая запись ждёт проверки.'), { code: 'operation_pending' });
      if (titleTaken()) throw titleExists();
      if (server.applyFail === 'conflict') throw Object.assign(new Error('Документ изменился в Google после проверки. Ничего не записано.'), { code: 'revision_conflict' });
      for (const edit of body.edits) Object.assign(server.chapters.find(chapter => chapter.id === edit.sectionId), { title: edit.title ?? '', body: edit.body });
      for (const chapter of body.newChapters) {
        const at = server.chapters.findIndex(item => item.id === chapter.anchorSectionId) + (chapter.where === 'after' ? 1 : 0);
        server.chapters.splice(at, 0, { id: 'h:t:new' + ++server.created, title: chapter.title.trim(), body: chapter.body });
      }
      server.rev++;
      if (server.applyFail === 'lost' || server.applyFail === 'review') {
        server.pending.push({ operationId: body.operationId, active: false });
        throw Object.assign(new Error(server.applyFail === 'lost' ? 'Результат записи в Google неизвестен.' : 'Google принял запись, но проверка результата не совпала с планом.'), { code: 'outcome_unknown' });
      }
      return { result: { operationId: body.operationId, verified: true, revisionId: 'rev-' + server.rev, editedSections: body.edits.map(edit => edit.sectionId), newChapters: body.newChapters.map(chapter => chapter.key) } };
    }
    throw new Error('unexpected ' + path);
  };
  server.api = async (path, options = {}) => {
    let value, error = null;
    try { value = reply(path, options.body); } catch (failure) { error = failure; }
    const index = server.holdOnce.indexOf(path);
    if (index < 0) { if (error) throw error; return value; }
    server.holdOnce.splice(index, 1);
    return new Promise((resolve, reject) => server.waiting.push({ path, release: () => (error ? reject(error) : resolve(value)) }));
  };
  server.release = async ({ reverse = false } = {}) => {
    const batch = server.waiting.splice(0);
    for (const item of reverse ? batch.reverse() : batch) { item.release(); await flush(); }
  };
  return server;
}
function createChapter(h, title, anchorSectionId) {
  const form = all(h.elements.rail).find(n => n.tagName === 'FORM');
  assert.ok(form, 'the new-chapter form is in the chapter rail');
  Object.assign(form, { title: { value: title, focus() {} }, where: { value: 'after' }, anchor: { value: anchorSectionId }, reset() {} });
  form.dispatch('submit');
}
const lastDialog = h => h.document.body.children.filter(n => n.tagName === 'DIALOG').at(-1);
async function confirmReview(h) {
  const dialog = lastDialog(h);
  assert.ok(dialog, 'the exact review is shown before any write');
  const check = all(dialog).find(n => n.tagName === 'INPUT' && n.type === 'checkbox');
  check.checked = true; check.dispatch('change');
  dialog.returnValue = 'apply'; dialog.dispatch('close');
  await flush();
}
const switchTo = (h, key) => { const select = h.document.created.find(n => n.className === 'chapter-switch'); select.value = key; select.dispatch('change'); };
const noticeBox = h => h.document.created.find(n => n.className === 'chapter-notice');
const writeButton = h => findButton(h.elements.rail, 'Проверить и записать в Google');
const stages = server => server.calls.filter(call => call.path === '/api/manuscript/stage').map(call => call.body);

test('typing while the review and the write are pending is kept as a dirty edit of the created chapter, never a second insertion', async () => {
  const server = writeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  pickAndLoad(h, ['Глава 1']); await flush();
  edit(h, 'Новая глава один.');
  createChapter(h, 'Встреча', 'h:t:one'); await flush();
  const newKey = h.ws.agentContext().sectionId;
  edit(h, 'Первый абзац.');
  server.holdOnce.push('/api/manuscript/stage', '/api/manuscript/apply');
  writeButton(h).click(); await flush();
  edit(h, 'Первый абзац.\nДописано во время проверки.'); // while the review is being prepared
  await server.release(); await confirmReview(h);
  assert.ok(server.waiting.some(item => item.path === '/api/manuscript/apply'), 'the write is pending');
  switchTo(h, 'h:t:one'); edit(h, 'Новая глава один. И ещё строка.'); // while the write is pending
  switchTo(h, newKey); edit(h, 'Первый абзац.\nДописано во время проверки.\nИ во время записи.');
  await server.release(); await flush();

  const applied = server.calls.find(call => call.path === '/api/manuscript/apply').body;
  assert.deepEqual(applied.newChapters.map(chapter => [chapter.title, chapter.body]), [['Встреча', 'Первый абзац.']], 'exactly the reviewed snapshot was written');
  assert.deepEqual(applied.edits.map(item => item.body), ['Новая глава один.']);
  assert.ok(h.notices.some(n => /записаны в Google и проверены/.test(n.message)));
  assert.deepEqual(loadedTitles(h), ['● Глава 1', '● Встреча'], 'later typing stays unsaved in both chapters; the new one is now a Google chapter');
  const context = h.ws.agentContext();
  assert.equal(context.sectionId, 'h:t:new1', 'the open chapter is the created Google chapter');
  assert.equal(context.text, 'Первый абзац.\nДописано во время проверки.\nИ во время записи.', 'nothing typed after the snapshot is lost');
  assert.equal(context.revisionId, 'rev-2');
  assert.equal(h.elements.crumbTitle.textContent, 'Встреча');
  assert.ok(!all(h.elements.rail).some(n => n.className === 'loaded-flag'), 'no false «changed in Google» conflict');

  writeButton(h).click(); await flush();
  const second = stages(server).at(-1);
  assert.deepEqual(second.newChapters, [], 'the written new chapter is never inserted again');
  assert.deepEqual(second.edits.map(item => [item.sectionId, item.body]), [['h:t:one', 'Новая глава один. И ещё строка.'], ['h:t:new1', 'Первый абзац.\nДописано во время проверки.\nИ во время записи.']]);
  assert.equal(second.edits[1].baseHash, 'Встреча|Первый абзац.', 'its base is the text that is in Google now');
  lastDialog(h).dispatch('close'); await flush(); // the author cancels the second review
});

test('if the written chapter cannot be re-read or is ambiguous, later typing stays as a never-resent draft the author ties to the created chapter', async () => {
  const server = writeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  createChapter(h, 'Встреча', 'h:t:one'); await flush();
  edit(h, 'Первый абзац.');
  server.holdOnce.push('/api/manuscript/apply');
  writeButton(h).click(); await flush(); await confirmReview(h);
  edit(h, 'Первый абзац.\nДописано во время записи.');
  server.failSections = true; // the re-read after the verified write fails
  await server.release(); await flush();
  assert.deepEqual(loadedTitles(h), ['● Записана: Встреча']);
  assert.equal(h.ws.currentText(), 'Встреча\nПервый абзац.\nДописано во время записи.');
  assert.ok(h.notices.some(n => n.error && /перечитать главы/.test(n.message)));
  writeButton(h).click(); await flush();
  assert.equal(stages(server).length, 1, 'the written chapter is not sent again');
  assert.ok(h.notices.some(n => /Нет правок/.test(n.message)));

  server.failSections = false;
  findButton(noticeBox(h), 'Связать с этой главой').click(); await flush();
  assert.deepEqual(loadedTitles(h), ['● Встреча']);
  assert.equal(h.ws.agentContext().sectionId, 'h:t:new1');
  assert.equal(h.ws.agentContext().text, 'Первый абзац.\nДописано во время записи.');

  // Ambiguous: the new chapter has the title of an existing one, so nothing is guessed.
  createChapter(h, 'Глава 1', 'h:t:one'); await flush();
  edit(h, 'Двойник.');
  server.holdOnce.push('/api/manuscript/apply');
  writeButton(h).click(); await flush(); await confirmReview(h);
  edit(h, 'Двойник. Ещё.');
  await server.release(); await flush();
  assert.deepEqual(stages(server).at(-1).newChapters.map(chapter => chapter.title), ['Глава 1']);
  assert.deepEqual(loadedTitles(h), ['Встреча', '● Записана: Глава 1'], 'the edited chapter settled clean; the ambiguous one waits for the author');
  const select = all(noticeBox(h)).find(n => n.className === 'chapter-link-select');
  assert.equal(select.children.length, 2, 'both same-titled chapters are offered');
  select.value = 'h:t:new2';
  findButton(noticeBox(h), 'Связать с этой главой').click(); await flush();
  assert.equal(h.ws.agentContext().sectionId, 'h:t:new2');
  assert.equal(h.ws.agentContext().text, 'Двойник. Ещё.');
  assert.equal(server.calls.filter(call => call.path === '/api/manuscript/apply').length, 2, 'every chapter was written exactly once');
});

test('table-of-contents and chapter reads started before a write never overwrite the settled state, and the newest read wins', async () => {
  const server = writeServer(), h = harness(server);
  await h.ws.syncBook('book-a'); await flush();
  pickAndLoad(h, ['Пролог']); await flush();
  edit(h, 'Новый пролог.');
  server.holdOnce.push('/api/manuscript/read');
  findButton(h.elements.rail, 'Обновить оглавление').click(); await flush(); // pre-write TOC read, delayed
  server.holdOnce.push('/api/manuscript/sections');
  pickAndLoad(h, ['Пролог']); await flush(); // pre-write chapter read, delayed
  writeButton(h).click(); await flush(); await confirmReview(h); await flush();
  assert.ok(h.notices.some(n => /записаны в Google и проверены/.test(n.message)), 'the pending reads did not cancel the write or its settlement');
  assert.deepEqual(loadedTitles(h), ['Пролог'], 'the written chapter is clean');
  await server.release(); await flush(); // the old TOC, then the old chapter text arrive
  assert.equal(h.ws.currentText(), 'Пролог\nНовый пролог.', 'the pre-write chapter read does not bring back the old text');
  assert.deepEqual(loadedTitles(h), ['Пролог'], 'and the chapter stays clean');
  assert.ok(!all(h.elements.rail).some(n => n.className === 'loaded-flag'), 'the pre-write table of contents does not mark it as changed in Google');
  assert.equal(h.ws.agentContext().revisionId, 'rev-2');

  // Two later reads answered out of order: the newer one wins for the TOC and for the chapter text.
  server.holdOnce.push('/api/manuscript/read', '/api/manuscript/read');
  findButton(h.elements.rail, 'Обновить оглавление').click();
  server.chapters[0].body = 'Пролог из Google.';
  findButton(h.elements.rail, 'Обновить оглавление').click();
  await server.release({ reverse: true });
  assert.ok(all(h.elements.rail).some(n => n.className === 'loaded-flag'), 'the newer TOC (chapter changed in Google) is not replaced by the older one');
  server.holdOnce.push('/api/manuscript/sections', '/api/manuscript/sections');
  const reload = findButton(noticeBox(h), 'Загрузить актуальную версию');
  reload.click();
  server.chapters[0].body = 'Пролог позже.';
  reload.click();
  await server.release({ reverse: true });
  assert.equal(h.ws.currentText(), 'Пролог\nПролог позже.', 'the older chapter read does not replace the newer one');
});

const STORE_KEY = 'talewisp.chapters.v1.book-a.doc-a';
const storedItems = storage => JSON.parse(storage.map.get(STORE_KEY)).loaded;
const applies = server => server.calls.filter(call => call.path === '/api/manuscript/apply').map(call => call.body);
const inGoogle = (server, title) => server.chapters.filter(chapter => chapter.title === title).length;
const editTitle = (h, value) => { const input = h.document.created.find(n => n.id === 'chapter-title'); input.value = value; input.dispatch('input'); };
const reconcileButton = h => findButton(h.elements.rail, 'Я проверил(а) документ');
const flakyStorage = () => {
  const storage = memoryStorage(), setItem = storage.setItem;
  storage.fail = false;
  storage.setItem = (key, value) => { if (storage.fail) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); setItem(key, value); };
  return storage;
};

test('a new chapter whose write result is unknown (lost reply, readback mismatch) is quarantined before Apply and never inserted again — after edits, reconciliation or reload', async () => {
  for (const mode of ['lost', 'review']) {
    const storage = memoryStorage(), server = writeServer(), h = harness(server, storage);
    server.titleGuard = true;
    await h.ws.syncBook('book-a'); await flush();
    createChapter(h, 'Встреча', 'h:t:one'); await flush();
    const key = h.ws.agentContext().sectionId;
    edit(h, 'Первый абзац.');
    server.applyFail = mode; server.holdOnce.push('/api/manuscript/apply');
    writeButton(h).click(); await flush(); await confirmReview(h);
    const sent = applies(server)[0], saved = storedItems(storage).find(item => item.key === key);
    assert.deepEqual([saved.write.state, saved.write.operationId], ['inflight', sent.operationId], mode + ': the quarantine is saved before the Apply request');
    assert.deepEqual(saved.write.sent, { title: 'Встреча', body: 'Первый абзац.', anchorSectionId: 'h:t:one', where: 'after' });
    assert.deepEqual(saved.write.scope, { bookId: 'book-a', documentId: 'doc-a' });

    // While the reply is pending: the author renames and rewrites it and starts another new chapter.
    editTitle(h, 'Встреча у реки'); edit(h, 'Первый абзац, переписанный.');
    createChapter(h, 'Глава 5', 'h:t:prolog'); await flush(); edit(h, 'Другая глава.');
    await server.release(); await flush();
    assert.equal(inGoogle(server, 'Встреча'), 1, mode + ': Google holds the chapter once');
    assert.ok(!h.notices.some(n => /записаны в Google и проверены/.test(n.message)), 'no success is claimed');
    assert.ok(h.notices.some(n => n.error && /результат записи неизвестен/.test(n.message)));
    assert.ok(loadedTitles(h).includes('● Результат неизвестен: Встреча у реки'));
    assert.ok(!loadedTitles(h).some(title => /Записана/.test(title)), 'never labelled as written');
    switchTo(h, key);
    assert.equal(h.ws.currentText(), 'Встреча у реки\nПервый абзац, переписанный.', 'the latest text is kept');
    assert.equal(storedItems(storage).find(item => item.key === key).write.state, 'unknown');

    reconcileButton(h).click(); await flush();
    assert.deepEqual(server.pending, [], 'the author reconciled the operation');
    writeButton(h).click(); await flush();
    assert.deepEqual(stages(server).at(-1).newChapters.map(chapter => chapter.title), ['Глава 5'], 'only the unsent new chapter is offered after reconciliation');
    lastDialog(h).dispatch('close'); await flush();

    h.ws.hasUnsafeDrafts(); // flushes the debounced save before the reload
    const again = harness(server, storage);
    await again.ws.syncBook('book-a'); await flush();
    assert.ok(loadedTitles(again).includes('● Результат неизвестен: Встреча у реки'), 'the quarantine survives a reload');
    writeButton(again).click(); await flush();
    assert.deepEqual(stages(server).at(-1).newChapters.map(chapter => chapter.title), ['Глава 5'], 'and still excludes it');
    lastDialog(again).dispatch('close'); await flush();

    switchTo(again, key);
    const select = all(noticeBox(again)).find(n => n.className === 'chapter-link-select');
    assert.equal(select.value, 'h:t:new1', 'the chapter carrying the sent title is offered for an explicit link');
    findButton(noticeBox(again), 'Связать с этой главой').click(); await flush();
    const context = again.ws.agentContext();
    assert.deepEqual([context.sectionId, context.title, context.text, context.edited], ['h:t:new1', 'Встреча у реки', 'Первый абзац, переписанный.', true], 'the latest text becomes an unsaved edit of the existing chapter');
    assert.equal(applies(server).length, 1, mode + ': Apply ran exactly once');
    assert.equal(inGoogle(server, 'Встреча'), 1);
  }
});

test('without durable storage a new chapter is never sent; a storage failure after sending keeps the saved quarantine across reload', async () => {
  for (const label of ['quota', 'no storage']) {
    const storage = label === 'quota' ? flakyStorage() : null, server = writeServer(), h = harness(server, storage);
    await h.ws.syncBook('book-a'); await flush();
    if (storage) storage.fail = true;
    createChapter(h, 'Встреча', 'h:t:one'); await flush(); edit(h, 'Абзац.');
    writeButton(h).click(); await flush(); await confirmReview(h);
    assert.equal(applies(server).length, 0, label + ': no Apply without a saved quarantine');
    assert.ok(h.notices.some(n => n.error && /Новые главы не отправлены/.test(n.message)));
    assert.deepEqual(loadedTitles(h), ['● Новая: Встреча'], label + ': the chapter stays an unsent draft with its text');
    assert.equal(h.ws.currentText(), 'Встреча\nАбзац.');
    assert.equal(h.ws.hasUnsafeDrafts(), true, label + ': the unload guard holds');
    assert.ok(findButton(h.elements.rail, 'Скачать незаписанные правки'));
    if (storage) {
      storage.fail = false;
      writeButton(h).click(); await flush(); await confirmReview(h);
      assert.equal(applies(server).length, 1, 'with storage back the chapter is written once');
      assert.equal(inGoogle(server, 'Встреча'), 1);
    }
  }

  const storage = flakyStorage(), server = writeServer(), h = harness(server, storage);
  await h.ws.syncBook('book-a'); await flush();
  createChapter(h, 'Встреча', 'h:t:one'); await flush(); edit(h, 'Абзац.');
  server.applyFail = 'lost'; server.holdOnce.push('/api/manuscript/apply');
  writeButton(h).click(); await flush(); await confirmReview(h);
  storage.fail = true; // storage breaks after the quarantine was saved and the request was sent
  edit(h, 'Абзац. Дописано после отправки.');
  await server.release(); await flush();
  assert.match(h.ws.currentText(), /Дописано после отправки/, 'later typing is kept in the tab');
  assert.equal(h.ws.hasUnsafeDrafts(), true, 'the unload guard holds');
  assert.ok(findButton(h.elements.rail, 'Скачать незаписанные правки'), 'and the export is offered');

  const again = harness(server, storage);
  await again.ws.syncBook('book-a'); await flush();
  assert.deepEqual(loadedTitles(again), ['● Результат неизвестен: Встреча'], 'the in-flight quarantine saved before sending is restored as unknown');
  reconcileButton(again).click(); await flush();
  writeButton(again).click(); await flush();
  assert.equal(stages(server).length, 1, 'nothing is staged or sent again');
  assert.ok(again.notices.some(n => /повторно не отправляются/.test(n.message)));
  assert.equal(applies(server).length, 1);
  assert.equal(inGoogle(server, 'Встреча'), 1);
});

test('the quarantine belongs to the manuscript it was sent from: an unknown result after A → B or A → B → A, then a reload, never re-inserts', async () => {
  for (const back of [false, true]) {
    const storage = memoryStorage(), server = writeServer(), h = harness(server, storage);
    await h.ws.syncBook('book-a'); await flush();
    createChapter(h, 'Встреча', 'h:t:one'); await flush(); edit(h, 'Абзац.');
    server.applyFail = 'lost'; server.holdOnce.push('/api/manuscript/apply');
    writeButton(h).click(); await flush(); await confirmReview(h);
    await h.ws.syncBook('book-b'); await flush();
    if (back) { await h.ws.syncBook('book-a'); await flush(); }
    await server.release(); await flush();
    assert.equal(storedItems(storage).find(item => item.kind === 'new').write.state, 'unknown', `${back ? 'A → B → A' : 'A → B'}: the original manuscript's copy is quarantined`);
    if (!back) { await h.ws.syncBook('book-a'); await flush(); }
    assert.deepEqual(loadedTitles(h), ['● Результат неизвестен: Встреча']);
    assert.ok(!h.notices.some(n => /записаны в Google и проверены/.test(n.message)));
    reconcileButton(h).click(); await flush();
    createChapter(h, 'Глава 5', 'h:t:prolog'); await flush(); edit(h, 'Другая.');
    writeButton(h).click(); await flush();
    assert.deepEqual(stages(server).at(-1).newChapters.map(chapter => chapter.title), ['Глава 5']);
    lastDialog(h).dispatch('close'); await flush();
    h.ws.hasUnsafeDrafts();
    const again = harness(server, storage);
    await again.ws.syncBook('book-a'); await flush();
    writeButton(again).click(); await flush();
    assert.deepEqual(stages(server).at(-1).newChapters.map(chapter => chapter.title), ['Глава 5'], 'after a reload too');
    lastDialog(again).dispatch('close'); await flush();
    assert.equal(applies(server).length, 1);
    assert.equal(inGoogle(server, 'Встреча'), 1);
  }
});

test('a refusal before any write releases exactly the sent new chapters; a duplicate-title refusal on stage is not a sent attempt', async () => {
  const storage = memoryStorage(), server = writeServer(), h = harness(server, storage);
  server.titleGuard = true;
  await h.ws.syncBook('book-a'); await flush();
  createChapter(h, 'Встреча', 'h:t:one'); await flush(); edit(h, 'Абзац.');
  server.applyFail = 'conflict';
  writeButton(h).click(); await flush(); await confirmReview(h);
  assert.equal(applies(server).length, 1);
  assert.deepEqual(loadedTitles(h), ['● Новая: Встреча'], 'nothing was written, so the chapter is sendable again');
  assert.equal(storedItems(storage)[0].write, undefined);
  assert.equal(h.ws.currentText(), 'Встреча\nАбзац.');

  editTitle(h, 'Глава 1');
  writeButton(h).click(); await flush();
  assert.ok(h.notices.some(n => n.error && /уже есть во вкладке/.test(n.message)), 'the duplicate title is refused before writing');
  assert.deepEqual(loadedTitles(h), ['● Новая: Глава 1'], 'a stage error quarantines nothing');
  assert.equal(applies(server).length, 1);

  server.applyFail = null; editTitle(h, 'Встреча');
  writeButton(h).click(); await flush(); await confirmReview(h);
  assert.ok(h.notices.some(n => /записаны в Google и проверены/.test(n.message)));
  assert.deepEqual(loadedTitles(h), ['Встреча'], 'a verified result settles normally and clears the quarantine');
  assert.equal(storedItems(storage).some(item => item.write), false);
  assert.equal(inGoogle(server, 'Встреча'), 1);
  assert.equal(applies(server).length, 2);
});
