import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createGoogleNativeEditor } from '../public/google-native-editor.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../public/project-settings.js', import.meta.url), 'utf8');
const opener = app.slice(app.indexOf('  // Opens a companion Google Doc from its attachment tile'), app.indexOf('  async function flushAllDrafts() {'));
const showNative = app.slice(app.indexOf('  function showGoogleNativeEditor(doc) {'), app.indexOf('  async function readGoogle('));
const navStateStart = app.indexOf('  function navState() {');
const navStateSource = app.slice(navStateStart, app.indexOf('\n', navStateStart));
const applyProjectSource = app.slice(app.indexOf('  async function applyProjectResult(result) {'), app.indexOf('  let reportedAgentContext'));
const attachment ={ id: 'att-1', name: 'Мир под гнетом магии — заметки', kind: 'google-doc', googleDocumentId: 'abc_DEF-123' };

// Companion Docs open from their tile: no /api/google/read and no prior "google" route are required.
function harness({ flush = async () => {}, drafts = new Map(), view = 'overview' } = {}) {
  const events = [], opened = [];
  const state = { view, mainRoute: view, settingsPane: view === 'settings' ? 'project' : undefined, drafts, catalog: { active: { authorId: 'a', seriesId: 's', bookId: 'b' } } };
  const context = {
    state, knowledgeWorkspaceChanging: false, navigationRevision: 0, chapters: { noteRoute() {} },
    // Stubs for the DOM side of the real navState(); its navigationRevision++ runs unchanged.
    $: () => ({}), $$: () => [], queueMicrotask: () => {}, rememberNavigation: () => {},
    stash: () => events.push('stash'),
    saveQueue: { flush: async key => { events.push('flush:' + key); await flush(key); } },
    notify: (message, error) => events.push((error ? 'error:' : 'note:') + message),
    api: async path => { throw Error('Companion open must not call ' + path); },
    showGoogleNativeEditor: doc => { opened.push(doc); return true; },
  };
  const open = runInNewContext(navStateSource + '\n' + opener + '\nopenCompanionGoogleDocument', context);
  // Same route change as showPrimaryView(): set the view, then the real navState().
  const navigate = view => { state.view = state.mainRoute = view; context.navState(); };
  return { open, state, events, opened, context, navigate };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('overview and project settings both hand the attachment (ID and title) to the companion opener', () => {
  assert.match(app, /btn\('Открыть в Google Docs', 'button button-quiet', \(\) => openCompanionGoogleDocument\(item\)\)/);
  assert.match(app, /openGoogleDocument: item => openCompanionGoogleDocument\(item\),/);
  assert.match(settings, /openGoogleDocument\?\.\(\{ googleDocumentId: item\.googleDocumentId, name: item\.name \}\)/);
  assert.doesNotMatch(opener, /readGoogle|\/api\/google/);
});

for (const view of ['overview', 'settings']) {
  test(`from ${view}: drafts are flushed, then the native editor opens the selected document with its title`, async () => {
    const h = harness({ view, drafts: new Map([['document:local', { dirty: false }]]) });
    assert.equal(await h.open(attachment), true);
    assert.deepEqual(h.events, ['stash', 'flush:document:local']);
    assert.deepEqual(h.opened.map(doc => [doc.documentId, doc.title]), [['abc_DEF-123', attachment.name]]);
  });
}

test('an unsaved draft keeps the current screen and shows an error', async () => {
  const h = harness({ drafts: new Map([['document:local', { dirty: true }]]) });
  assert.equal(await h.open(attachment), false);
  assert.equal(h.opened.length, 0);
  assert.ok(h.events.some(e => e.startsWith('error:') && /сохраните/i.test(e)));
});

test('a failing flush keeps the current screen and shows an error', async () => {
  const h = harness({ drafts: new Map([['document:local', { dirty: true }]]), flush: async () => { throw Error('Сеть недоступна'); } });
  assert.equal(await h.open(attachment), false);
  assert.equal(h.opened.length, 0);
  assert.ok(h.events.includes('error:Сеть недоступна'));
});

for (const [name, change] of [
  ['the open book changed', state => { state.catalog.active.bookId = 'other'; }],
  ['the series scope changed', state => { state.catalog.active.seriesId = 'other'; }],
  ['the author left the screen', state => { state.view = state.mainRoute = 'knowledge'; }],
]) {
  test(`a late flush does not open the document when ${name}`, async () => {
    const gate = deferred(), h = harness({ drafts: new Map([['document:local', { dirty: false }]]), flush: () => gate.promise });
    const pending = h.open(attachment);
    change(h.state); gate.resolve();
    assert.equal(await pending, false);
    assert.equal(h.opened.length, 0);
  });
}

test('leaving settings and returning while the flush is pending does not open the old document', async () => {
  const gate = deferred(), h = harness({ view: 'settings', drafts: new Map([['document:local', { dirty: false }]]), flush: () => gate.promise });
  const pending = h.open(attachment);
  h.navigate('knowledge'); h.navigate('settings');
  assert.equal(h.context.navigationRevision, 2);
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.opened.length, 0);
  assert.ok(!h.events.some(e => e.startsWith('error:')));
});

test('switching the book and back while the flush is pending does not open the old document', async () => {
  const gate = deferred(), h = harness({ view: 'settings', drafts: new Map([['document:local', { dirty: false }]]), flush: () => gate.promise });
  const pending = h.open(attachment);
  h.state.catalog.active.bookId = 'other'; h.context.invalidateCompanionOpen();
  h.state.catalog.active.bookId = 'b'; h.context.invalidateCompanionOpen();
  gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.opened.length, 0);
  assert.match(applyProjectSource, /if \(result\?\.activeChanged[^\n]*\n\s*openController\.invalidate\(\); invalidateCompanionOpen\(\);/);
});

test('a pending flush without any navigation still opens the document', async () => {
  const gate = deferred(), h = harness({ view: 'settings', drafts: new Map([['document:local', { dirty: false }]]), flush: () => gate.promise });
  const pending = h.open(attachment);
  gate.resolve();
  assert.equal(await pending, true);
  assert.equal(h.context.navigationRevision, 0);
  assert.deepEqual(h.opened.map(doc => [doc.documentId, doc.title]), [['abc_DEF-123', attachment.name]]);
});

test('a newer click wins over an older one still waiting for its flush', async () => {
  const gates = [deferred(), deferred()];
  const h = harness({ drafts: new Map([['document:local', { dirty: false }]]), flush: () => gates.shift().promise });
  const first = gates[0], second = gates[1];
  const older = h.open(attachment);
  const newer = h.open({ ...attachment, name: 'Второй файл', googleDocumentId: 'second_ID' });
  second.resolve(); first.resolve();
  assert.equal(await newer, true);
  assert.equal(await older, false);
  assert.deepEqual(h.opened.map(doc => doc.documentId), ['second_ID']);
});

test('an invalid Google ID is rejected by the native editor validator before the current view closes', async () => {
  const events = [], state = { view: 'settings', mainRoute: 'settings', settingsPane: 'project', drafts: new Map(), catalog: { active: { bookId: 'b' } } };
  const fail = name => () => { throw Error(name + ' must not run for an invalid ID'); };
  const context = {
    state, knowledgeWorkspaceChanging: false, navigationRevision: 0, document: null, createGoogleNativeEditor,
    stash: () => {}, saveQueue: { flush: async () => {} },
    notify: (message, error) => events.push((error ? 'error:' : 'note:') + message),
    switchView: fail('switchView'), openController: { invalidate: fail('invalidate') }, closeWorkspace: fail('closeWorkspace'), restorePortal: fail('restorePortal'),
  };
  const open = runInNewContext(showNative + '\n' + opener + '\nopenCompanionGoogleDocument', context);
  assert.equal(await open({ ...attachment, googleDocumentId: 'bad/id?x' }), false);
  assert.equal(state.view, 'settings');
  assert.notEqual(state.googleNativeOpen, true);
  assert.ok(events.some(e => e.startsWith('error:') && /некорректный ID/.test(e)));
});
