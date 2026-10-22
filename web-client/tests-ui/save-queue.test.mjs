import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveQueue } from '../public/save-queue.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a dirty draft is saved by its captured key after switching to another document', async () => {
  const queue = createSaveQueue();
  const saved = [];
  const drafts = new Map([
    ['document:A', { text: 'draft A', dirty: true }],
    ['document:B', { text: 'draft B', dirty: true }]
  ]);
  let active = 'document:A';
  const save = key => queue.schedule(key, async () => {
    const draft = drafts.get(key);
    saved.push([key, draft.text]);
    draft.dirty = false;
  }, 8);

  save('document:A');
  active = 'document:B';
  save('document:B');
  await wait(30);

  assert.equal(active, 'document:B');
  assert.deepEqual(saved.sort(), [['document:A', 'draft A'], ['document:B', 'draft B']]);
  assert.equal(drafts.get('document:A').dirty, false);
  assert.equal(drafts.get('document:B').dirty, false);
});

test('edits arriving during a save run again sequentially with the newest value', async () => {
  const queue = createSaveQueue();
  const draft = { text: 'first', dirty: true };
  const saved = [];
  let releaseFirst;
  let startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let calls = 0;
  const saveDraft = async () => {
    const snapshot = draft.text;
    calls++;
    saved.push(snapshot);
    if (calls === 1) { startedFirst(); await firstGate; }
    draft.dirty = draft.text !== snapshot;
  };

  queue.schedule('document:A', saveDraft, 1);
  await firstStarted;
  draft.text = 'second';
  draft.dirty = true;
  queue.schedule('document:A', saveDraft, 1);
  releaseFirst();
  await wait(30);

  assert.deepEqual(saved, ['first', 'second']);
  assert.equal(draft.dirty, false);
  assert.equal(queue.hasPending(), false);
});

test('a failed save leaves the draft dirty and reports no saved completion', async () => {
  const queue = createSaveQueue();
  const draft = { text: 'still here', dirty: true };
  let savedSignal = false;
  queue.schedule('document:A', async () => {
    const snapshot = draft.text;
    try {
      await Promise.reject(new Error('offline'));
      draft.savedText = snapshot;
      draft.dirty = draft.text !== snapshot;
    } catch (error) {
      draft.dirty = true;
      throw error;
    }
  }, 1);
  await wait(20);
  if (!draft.dirty) savedSignal = true;

  assert.equal(draft.text, 'still here');
  assert.equal(draft.dirty, true);
  assert.equal(savedSignal, false);
  assert.equal(queue.hasPending(), false);
});

test('a retained draft can be rescheduled after authentication becomes available', async () => {
  const queue = createSaveQueue();
  const draft = { text: 'typed before session', dirty: true, saveError: false };
  let authenticated = false;
  const persisted = [];
  const save = async () => {
    if (!authenticated) {
      draft.saveError = true;
      draft.dirty = true;
      throw new Error('unauthorized');
    }
    persisted.push(draft.text);
    draft.saveError = false;
    draft.dirty = false;
  };

  queue.schedule('document:local-1', save, 1);
  await wait(20);
  assert.equal(draft.dirty, true);
  assert.equal(draft.text, 'typed before session');
  authenticated = true;
  queue.schedule('document:local-1', save, 1);
  await wait(20);

  assert.deepEqual(persisted, ['typed before session']);
  assert.equal(draft.dirty, false);
});
