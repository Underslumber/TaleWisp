import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual app handler with a previously opened, now hidden local draft.
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handler = app.slice(app.indexOf('  function insertProposal(value) {'), app.indexOf('  function friendlyAgentError('));

test('Google native editor never inserts assistant output into the hidden local draft', () => {
  const writes = [], prompts = [], notices = [];
  const text = { value: 'Existing local manuscript' };
  const insert = runInNewContext('(' + handler.trim() + ')', {
    state: { googleNativeOpen: true, current: { kind: 'document', id: 'previous-local' } },
    draft: () => ({ readonly: false }), text,
    notify: message => notices.push(message),
    prompt: (...args) => { prompts.push(args); return 'Assistant text'; },
    scheduleSave: () => writes.push(text.value)
  });
  insert('Assistant text');
  assert.equal(text.value, 'Existing local manuscript');
  assert.deepEqual(writes, []);
  assert.deepEqual(prompts, []);
  assert.match(notices[0], /Откройте локальный черновик/);
});

test('assistant insertion still saves after the author explicitly opens a local draft', () => {
  const writes = [], text = { value: 'Existing local manuscript' };
  const insert = runInNewContext('(' + handler.trim() + ')', {
    state: { googleNativeOpen: false, current: { kind: 'document', id: 'previous-local' } },
    draft: () => ({ readonly: false }), text,
    notify: () => {}, prompt: () => 'Approved assistant text',
    scheduleSave: () => writes.push(text.value)
  });
  insert('Assistant text');
  assert.deepEqual(writes, ['Existing local manuscript\n\nApproved assistant text']);
});
