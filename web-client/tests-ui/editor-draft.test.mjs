import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureEditableDocument } from '../public/editor-draft.js';

test('first input creates a dirty draft synchronously from the visible editor values', () => {
  const state = { current: null, drafts: new Map(), view: 'documents' };
  const visible = { title: 'First title', text: 'Text typed before any document was selected.' };

  const result = ensureEditableDocument(state, visible, 'local-first');

  assert.equal(result.created, true);
  assert.equal(state.current.id, 'local-first');
  assert.equal(state.drafts.get('document:local-first'), result.draft);
  assert.equal(result.draft.title, visible.title);
  assert.equal(result.draft.text, visible.text);
  assert.equal(result.draft.dirty, true);
  assert.equal(result.draft.savedText, '');
});

test('typing into an existing current draft does not replace its binding', () => {
  const existing = { id: 'server-1', text: 'existing', dirty: true };
  const state = { current: { kind: 'document', id: 'server-1' }, drafts: new Map([['document:server-1', existing]]) };
  const result = ensureEditableDocument(state, { title: 'ignored', text: 'ignored' }, 'local-other');

  assert.equal(result.created, false);
  assert.equal(result.draft, existing);
  assert.equal(state.drafts.size, 1);
});
