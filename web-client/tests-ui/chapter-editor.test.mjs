import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createScopeGuard, scopeKeyOf, storageKeyOf, isDirty, loadedFromSection, mergeLoaded, rebaseOnRemote, newChapterItem,
  buildWritePayload, writeSnapshot, settleAfterWrite, serializeState, parseState, googleDocUrl, detectionLabel,
  quarantineNew, markAttempt,
} from '../public/manuscript-model.js';
import { clampInspectorWidth, createWorkspaceSplitter, SPLITTER_DEFAULTS } from '../public/workspace-splitter.js';

const section = (id, body, hash = 'hash-' + body) => ({ sectionId: id, label: id, tabId: 't', tabTitle: 'Книга', level: 1, detection: 'heading', hasHeading: true, headingId: 'h', title: 'Глава ' + id, body, hash });

test('scope guard drops responses after leaving and re-entering the same book (ABA) and after a newer request', () => {
  const guard = createScopeGuard();
  guard.enter(scopeKeyOf('book-a', 'doc-1'));
  const early = guard.begin();
  guard.enter(scopeKeyOf('book-b', 'doc-2'));
  guard.enter(scopeKeyOf('book-a', 'doc-1'));
  assert.equal(guard.isCurrent(early), false, 'A → B → A must not accept the first A response');
  const first = guard.begin(); guard.bump(); const second = guard.begin();
  assert.equal(guard.isCurrent(first), false); assert.equal(guard.isCurrent(second), true);
  assert.notEqual(storageKeyOf('book-a', 'doc-1'), storageKeyOf('book-a', 'doc-2'), 'drafts are stored per book and manuscript');
});

test('a fresh Google copy never overwrites unsaved chapter text; a conflict is flagged and rebased only on request', () => {
  const loaded = loadedFromSection(section('s1', 'Текст.'), 'rev-1');
  assert.equal(isDirty(loaded), false);
  const clean = mergeLoaded(loaded, loadedFromSection(section('s1', 'Новое из Google.'), 'rev-2'));
  assert.equal(clean.body, 'Новое из Google.', 'clean chapters follow Google');
  const dirty = { ...loaded, body: 'Моя правка.' };
  const same = mergeLoaded(dirty, loadedFromSection(section('s1', 'Текст.'), 'rev-3'));
  assert.equal(same.body, 'Моя правка.'); assert.equal(same.baseRevision, 'rev-3'); assert.equal(same.conflict, false);
  const conflict = mergeLoaded(dirty, loadedFromSection(section('s1', 'Чужая правка.'), 'rev-4'));
  assert.equal(conflict.body, 'Моя правка.'); assert.equal(conflict.conflict, true); assert.equal(conflict.remote.body, 'Чужая правка.');
  const rebased = rebaseOnRemote(conflict);
  assert.equal(rebased.body, 'Моя правка.'); assert.equal(rebased.baseBody, 'Чужая правка.'); assert.equal(rebased.baseRevision, 'rev-4'); assert.equal(rebased.conflict, false);
});

test('one or several selected chapters and new chapters become an exact write payload', () => {
  const a = { ...loadedFromSection(section('s1', 'Один.'), 'rev'), body: 'Один, исправлен.' };
  const b = loadedFromSection(section('s2', 'Два.'), 'rev');
  const c = { ...loadedFromSection(section('s3', 'Три.'), 'rev'), title: 'Глава новая' };
  const fresh = { ...newChapterItem({ key: 'k1', title: 'Новая', anchorSectionId: 's2', where: 'after', anchorLabel: 'Глава s2', tabTitle: 'Книга' }), body: 'Абзац 1.\nАбзац 2.' };
  const untitled = newChapterItem({ key: 'k2', title: '   ', anchorSectionId: 's1', where: 'before' });
  const payload = buildWritePayload([a, b, c, fresh, untitled]);
  assert.deepEqual(payload.edits.map(edit => edit.sectionId), ['s1', 's3']);
  assert.equal(payload.edits[0].baseHash, 'hash-Один.');
  assert.deepEqual(payload.newChapters, [{ key: 'k1', title: 'Новая', body: 'Абзац 1.\nАбзац 2.', anchorSectionId: 's2', where: 'after' }]);
});

test('after a verified write only matching chapters become clean and written new chapters disappear', () => {
  const a = { ...loadedFromSection(section('s1', 'Один.'), 'rev-1'), body: 'Один!' };
  const b = { ...loadedFromSection(section('s2', 'Два.'), 'rev-1'), body: 'Два — ещё пишу.' };
  const fresh = newChapterItem({ key: 'k1', title: 'Новая', anchorSectionId: 's1', where: 'after' });
  const kept = newChapterItem({ key: 'k2', title: 'Ещё', anchorSectionId: 's1', where: 'after' });
  const freshById = new Map([['s1', loadedFromSection(section('s1', 'Один!'), 'rev-2')], ['s2', loadedFromSection(section('s2', 'Два.'), 'rev-2')]]);
  const settled = settleAfterWrite([a, b, fresh, kept], freshById, { newChapters: ['k1'] });
  assert.deepEqual(settled.map(item => item.key), ['s1', 's2', 'new:k2']);
  assert.equal(isDirty(settled[0]), false); assert.equal(settled[0].baseRevision, 'rev-2');
  assert.equal(settled[1].body, 'Два — ещё пишу.'); assert.equal(isDirty(settled[1]), true);
});

test('settlement is bound to the sent snapshot: later typing stays dirty on the written base and a written new chapter is never resent', () => {
  const a = { ...loadedFromSection(section('s1', 'Один.'), 'rev-1'), body: 'Один!' };
  const fresh = { ...newChapterItem({ key: 'k1', title: 'Новая', anchorSectionId: 's1', where: 'after', tabId: 't' }), body: 'Абзац.' };
  const snapshot = writeSnapshot([a, fresh]);
  const typed = [{ ...a, body: 'Один! И ещё.' }, { ...fresh, body: 'Абзац. Дальше.' }];
  const freshById = new Map([['s1', loadedFromSection(section('s1', 'Один!'), 'rev-2')]]);
  const created = new Map([['k1', loadedFromSection({ ...section('s9', 'Абзац.'), title: 'Новая' }, 'rev-2')]]);
  const settled = settleAfterWrite(typed, freshById, { newChapters: ['k1'] }, snapshot, created);
  assert.deepEqual(settled.map(item => [item.key, item.body, item.baseBody, item.conflict]), [['s1', 'Один! И ещё.', 'Один!', false], ['s9', 'Абзац. Дальше.', 'Абзац.', false]]);
  assert.deepEqual(buildWritePayload(settled).newChapters, []);
  const unresolved = settleAfterWrite(typed, new Map(), { newChapters: ['k1'] }, snapshot);
  assert.deepEqual(unresolved.map(item => [item.kind, item.stale ?? false]), [['section', true], ['written', false]]);
  assert.deepEqual(buildWritePayload(unresolved).newChapters, [], 'a written new chapter is never sent again');
  assert.equal(isDirty(unresolved[1]), true, 'its later typing stays unsaved');
});

test('quarantined new chapters are never sent again, survive reload as unknown and settle only with their own operation', () => {
  const a = { ...newChapterItem({ key: 'k1', title: 'Новая', anchorSectionId: 's1', where: 'after', tabId: 't' }), body: 'Абзац.' };
  const b = newChapterItem({ key: 'k2', title: 'Другая', anchorSectionId: 's1', where: 'before', tabId: 't' });
  const snapshot = writeSnapshot([a, b]), payload = buildWritePayload([a, b]);
  const { items, missing } = quarantineNew([a, b], payload.newChapters.slice(0, 1), { operationId: 'op-1', scope: { bookId: 'book', documentId: 'doc' } });
  assert.deepEqual(missing, []);
  assert.deepEqual(items[0].write, { state: 'inflight', operationId: 'op-1', scope: { bookId: 'book', documentId: 'doc' }, sent: { title: 'Новая', body: 'Абзац.', anchorSectionId: 's1', where: 'after' } });
  assert.equal(items[1].write, undefined, 'a chapter outside the attempt is untouched');
  const typed = [{ ...items[0], title: 'Новая, иначе', body: 'Абзац. Ещё.', anchorSectionId: 's2' }, items[1]];
  assert.deepEqual(buildWritePayload(typed).newChapters.map(chapter => chapter.key), ['k2'], 'changed title, body or anchor never make it sendable');
  assert.equal(isDirty(typed[0]), true, 'it stays an unsaved, exportable draft');
  assert.deepEqual(writeSnapshot(typed).has('new:k1'), false);
  const restored = parseState(serializeState({ loaded: typed, activeKey: null }));
  assert.equal(restored.loaded[0].write.state, 'unknown', 'a restored in-flight attempt is unknown');
  assert.equal(restored.loaded[0].body, 'Абзац. Ещё.');
  assert.deepEqual(buildWritePayload(restored.loaded).newChapters.map(chapter => chapter.key), ['k2']);
  assert.deepEqual(quarantineNew(typed, [{ key: 'k9', title: 'x', body: '', anchorSectionId: 's1', where: 'after' }], { operationId: 'op-2', scope: {} }).missing, ['k9']);
  const unknown = markAttempt(typed, 'op-1', 'unknown');
  assert.equal(unknown[0].write.state, 'unknown');
  assert.equal(markAttempt(typed, 'op-other', 'release')[0].write.operationId, 'op-1', 'another attempt never releases it');
  const released = markAttempt(typed, 'op-1', 'release');
  assert.deepEqual([released[0].write, released[0].title, released[0].body], [undefined, 'Новая, иначе', 'Абзац. Ещё.'], 'release keeps the latest text');
  assert.deepEqual(settleAfterWrite(unknown, new Map(), { operationId: 'op-2', newChapters: ['k1'] }, snapshot).map(item => [item.kind, item.write?.state]), [['new', 'unknown'], ['new', undefined]], 'the result of another operation never settles it');
  const settled = settleAfterWrite(unknown, new Map(), { operationId: 'op-1', newChapters: ['k1'] }, snapshot);
  assert.deepEqual([settled[0].kind, settled[0].write, settled[0].body], ['written', undefined, 'Абзац. Ещё.'], 'its own verified result settles it and clears the quarantine');
});

test('unsaved chapter drafts survive serialisation (reload, route or book switch) and corrupt storage is ignored', () => {
  const dirty = { ...loadedFromSection(section('s1', 'Один.'), 'rev'), body: 'Правка.' };
  const restored = parseState(serializeState({ loaded: [dirty], activeKey: 's1', checked: new Set(['s1', 's2']) }));
  assert.equal(restored.loaded[0].body, 'Правка.'); assert.equal(restored.activeKey, 's1'); assert.deepEqual(restored.checked, ['s1', 's2']);
  assert.equal(parseState('{broken'), null); assert.equal(parseState(JSON.stringify({ v: 2, loaded: [] })), null);
  assert.equal(googleDocUrl('doc/1', { tabId: 't.1', headingId: 'h.a' }), 'https://docs.google.com/document/d/doc%2F1/edit?tab=t.1#heading=h.a');
  assert.match(detectionLabel({ detection: 'plain' }), /Глава\/Пролог\/Эпилог/);
});

test('inspector width is clamped by both minima and the viewport', () => {
  assert.equal(clampInspectorWidth(1440, 432), 432);
  assert.equal(clampInspectorWidth(1440, 5000), SPLITTER_DEFAULTS.maxInspector);
  assert.equal(clampInspectorWidth(1440, 10), SPLITTER_DEFAULTS.minInspector);
  assert.equal(clampInspectorWidth(1024, 900), 1024 - 10 - SPLITTER_DEFAULTS.minEditor, 'the editor keeps its minimum');
  assert.equal(clampInspectorWidth(600, 900), SPLITTER_DEFAULTS.minInspector);
});

function fakeSplitterDom(width) {
  const listeners = {}, attrs = {}, styles = {}, classes = new Set(), bodyClasses = new Set();
  const grid = { width, getBoundingClientRect() { return { width: this.width, right: this.width }; }, style: { setProperty: (key, value) => { styles[key] = value; } } };
  const handle = { addEventListener: (type, fn) => { listeners[type] = fn; }, setAttribute: (key, value) => { attrs[key] = value; }, classList: { add: c => classes.add(c), remove: c => classes.delete(c) }, focus() {}, setPointerCapture() {} };
  const document = { body: { classList: { add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c) } } };
  const window = { addEventListener() {}, removeEventListener() {} };
  const fire = (type, extra = {}) => { let prevented = false; listeners[type]?.({ key: '', button: 0, pointerId: 1, shiftKey: false, preventDefault: () => { prevented = true; }, ...extra }); return prevented; };
  return { grid, handle, document, window, attrs, styles, classes, bodyClasses, fire };
}
const memoryStorage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }; };

test('splitter keyboard and pointer resize persist the ratio, restore it after reload and re-clamp on resize', () => {
  const storage = memoryStorage(), dom = fakeSplitterDom(1440);
  const splitter = createWorkspaceSplitter({ window: dom.window, document: dom.document, grid: dom.grid, handle: dom.handle, storage, key: 'ratio' });
  assert.equal(splitter.width(), 432); assert.equal(dom.styles['--inspector-width'], '432px');
  assert.equal(dom.attrs['aria-valuemin'], '300'); assert.equal(dom.attrs['aria-valuenow'], '432');
  assert.equal(dom.fire('keydown', { key: 'ArrowLeft' }), true);
  assert.equal(splitter.width(), 456, 'ArrowLeft widens the inspector');
  dom.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(splitter.width(), 336);
  dom.fire('keydown', { key: 'Home' }); assert.equal(splitter.width(), 300);
  dom.fire('keydown', { key: 'End' }); assert.equal(splitter.width(), 960);
  assert.equal(dom.fire('keydown', { key: 'a' }), false, 'other keys are left alone');
  dom.fire('pointerdown'); assert.ok(dom.classes.has('is-dragging')); assert.ok(dom.bodyClasses.has('is-resizing-workspace'));
  dom.fire('pointermove', { clientX: 1000 }); dom.fire('pointerup');
  assert.equal(splitter.width(), 435); assert.ok(!dom.classes.has('is-dragging'));
  assert.equal(Number(storage.map.get('ratio')).toFixed(4), (435 / 1440).toFixed(4));

  const reloaded = fakeSplitterDom(1440);
  const again = createWorkspaceSplitter({ window: reloaded.window, document: reloaded.document, grid: reloaded.grid, handle: reloaded.handle, storage, key: 'ratio' });
  assert.equal(again.width(), 435, 'the proportion is restored after reload');
  reloaded.grid.width = 1000; again.sync();
  assert.equal(again.width(), Math.round((435 / 1440) * 1000));
  reloaded.grid.width = 800; again.sync();
  assert.equal(again.width(), 300, 'a narrow grid keeps the inspector minimum while the editor keeps ≥ 420px');
  reloaded.grid.width = 1100; reloaded.fire('keydown', { key: 'End' });
  assert.equal(again.width(), 1100 - 10 - SPLITTER_DEFAULTS.minEditor, 'the inspector can never squeeze the editor below its minimum');
  dom.fire('keydown', { key: 'Enter' }); assert.equal(splitter.width(), 432, 'Enter restores the default');
});

test('splitter is inert while the inspector is hidden (mobile, focus mode)', () => {
  const dom = fakeSplitterDom(1440);
  let active = false;
  const splitter = createWorkspaceSplitter({ window: dom.window, document: dom.document, grid: dom.grid, handle: dom.handle, storage: memoryStorage(), key: 'r', isActive: () => active });
  assert.equal(splitter.width(), null);
  assert.equal(dom.fire('keydown', { key: 'ArrowLeft' }), false);
  dom.fire('pointerdown'); assert.ok(!dom.classes.has('is-dragging'));
  active = true; splitter.sync(); assert.equal(splitter.width(), 432);
});

test('app wiring: chapter controls live in the editor pane, the splitter sits before the inspector, the 47rem cap is gone', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const pane = html.slice(html.indexOf('id="editor-pane"'), html.indexOf('id="agent-pane"'));
  for (const id of ['chapter-toggle', 'chapter-rail', 'editor-body', 'editor-scroll', 'document-editor']) assert.ok(pane.includes(`id="${id}"`), id + ' is inside the editor pane');
  assert.ok(!html.slice(html.indexOf('id="agent-pane"')).includes('chapter-rail'), 'chapter controls are not in the agent panel');
  assert.match(html, /id="workspace-splitter" role="separator" aria-orientation="vertical"[^>]*tabindex="0"><\/div>\s*<aside class="desktop-inspector"/);
  assert.ok(!/min\(100%,\s*47rem\)/.test(css), 'no fixed 47rem sheet');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 10px var\(--inspector-width/);
  assert.match(css, /\.app-shell\.focus-mode [^{]*\.workspace-splitter/);
  assert.match(app, /body\.manuscriptChapter = capturedChapter/);
  assert.match(app, /chapters\?\.deactivate\(\);\s*if \(state\.current/, 'opening a local draft leaves chapter mode');
});
