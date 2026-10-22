import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenController } from '../public/open-controller.js';

test('out-of-order document responses cannot replace the latest selection or unlock it', () => {
  const locks = [];
  const controller = createOpenController(value => locks.push(value));
  const requestB = controller.begin();
  const requestC = controller.begin();
  let opened = null;

  assert.equal(controller.finish(requestC, () => { opened = 'C'; }), true);
  assert.equal(controller.finish(requestB, () => { opened = 'B'; }), false);
  assert.equal(opened, 'C');
  assert.deepEqual(locks, [true, true, false]);
});

test('latest failed load restores the prior editor state and unlocks input', () => {
  const locks = [];
  const controller = createOpenController(value => locks.push(value));
  const editor = { title: 'Existing', text: 'Keep this', titleDisabled: false, textReadOnly: false };
  const before = { ...editor };
  const token = controller.begin();
  editor.titleDisabled = true;
  editor.textReadOnly = true;

  assert.equal(controller.finish(token, () => Object.assign(editor, before)), true);
  assert.deepEqual(editor, before);
  assert.deepEqual(locks, [true, false]);
});

test('a cached open invalidates a pending fetch so its late response cannot commit', () => {
  const controller = createOpenController();
  const pendingFetch = controller.begin();
  let opened = null;
  const cachedOpen = controller.begin();
  assert.equal(controller.finish(cachedOpen, () => { opened = 'cached'; }), true);
  assert.equal(controller.finish(pendingFetch, () => { opened = 'stale'; }), false);
  assert.equal(opened, 'cached');
});

test('starting a new draft invalidates a pending open before its response can commit', () => {
  const controller = createOpenController();
  const pendingOpen = controller.begin();
  let current = 'old';
  controller.invalidate();
  current = 'new-draft';

  assert.equal(controller.finish(pendingOpen, () => { current = 'late-document'; }), false);
  assert.equal(current, 'new-draft');
});
