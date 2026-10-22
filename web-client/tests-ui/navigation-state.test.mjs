import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNavigation, readNavigation, writeNavigation } from '../public/navigation-state.js';

test('a fresh client restores the last section, document and knowledge selection without storing prose', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  writeNavigation(storage, { view: 'knowledge', current: { kind: 'document', id: 'doc-1' }, knowledgeScope: 'unassigned', knowledgeSelectedConceptId: 'concept:aura', text: 'private prose', drafts: ['private draft'] });
  assert.equal(readNavigation(storage).view, 'knowledge');
  assert.equal(readNavigation(storage).knowledgeSelectedConceptId, 'concept:aura');
  assert.deepEqual(readNavigation(storage).current, { kind: 'document', id: 'doc-1' });
  assert.equal([...values.values()].join('').includes('private'), false);
});

test('corrupt, removed routes and unavailable storage do not break startup', () => {
  assert.equal(readNavigation({ getItem: () => '{' }), null);
  assert.equal(normalizeNavigation({ view: 'removed-view' }), null);
  const blocked = { getItem() { throw Error('disabled'); }, setItem() { throw Error('full'); } };
  assert.equal(readNavigation(blocked), null);
  assert.doesNotThrow(() => writeNavigation(blocked, { view: 'settings' }));
});

test('unsaved temporary documents cannot become a stale restore target; note list and editor remain distinct', () => {
  assert.equal(normalizeNavigation({ view: 'documents', current: { kind: 'document', id: 'local-temporary' } }).current, null);
  assert.equal(normalizeNavigation({ view: 'notes', editor: true }).editor, true);
  assert.equal(normalizeNavigation({ view: 'notes', editor: false }).editor, false);
});

test('restores a native Google editor separately from the document picker and local editor', () => {
  const native = normalizeNavigation({ view: 'google', googleNativeOpen: true, googleDocumentId: 'google-1' });
  assert.equal(native.googleNativeOpen, true);
  assert.equal(native.googleDocumentId, 'google-1');
  assert.equal(normalizeNavigation({ view: 'google' }).googleNativeOpen, false);
  assert.equal(normalizeNavigation({ view: 'documents', googleNativeOpen: true }).googleNativeOpen, true);
  assert.equal(normalizeNavigation({ view: 'knowledge', googleNativeOpen: true }).googleNativeOpen, false);
});
