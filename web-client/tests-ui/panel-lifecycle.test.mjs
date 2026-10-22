import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelLifecycle } from '../public/panel-lifecycle.js';

function container() {
  return {
    children: [],
    insertBefore(child, before) {
      const previousParent = child.parentNode;
      if (previousParent) {
        const oldIndex = previousParent.children.indexOf(child);
        if (oldIndex >= 0) previousParent.children.splice(oldIndex, 1);
      }
      const index = before ? this.children.indexOf(before) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentNode = this;
      this.children.forEach((item, i) => { item.nextSibling = this.children[i + 1] || null; });
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('restores the same live panel to its first registered parent and sibling', () => {
  const lifecycle = createPanelLifecycle();
  const home = container(), slot = container();
  const before = { parentNode: null }, panel = { parentNode: null }, after = { parentNode: null };
  home.insertBefore(before, null); home.insertBefore(panel, null); home.insertBefore(after, null);
  lifecycle.rememberHome(panel);
  slot.insertBefore(panel, null);
  lifecycle.rememberHome(panel);

  assert.equal(lifecycle.restoreHome(panel), true);
  assert.deepEqual(home.children, [before, panel, after]);
  assert.deepEqual(slot.children, []);
  assert.equal(panel.parentNode, home);
});

test('Google main reads survive inspector changes but go stale after main-route navigation', async () => {
  const mainRoute = createPanelLifecycle(), toolDialog = createPanelLifecycle();
  const prior = { id: 'old-google-view' }, panel = { children: [prior], replaceChildren(...children) { this.children = children; } };
  const googleView = mainRoute.beginView('google');
  assert.equal(mainRoute.replaceView(panel, 'google'), true);
  assert.deepEqual(panel.children, []);
  const nextGoogleView = mainRoute.beginView('google');
  assert.equal(mainRoute.replaceView(panel, 'google', [{ id: 'new-google-view' }]), true);
  assert.deepEqual(panel.children, [{ id: 'new-google-view' }]);
  assert.equal(mainRoute.isCurrentView(googleView, 'google'), false);

  toolDialog.beginView('agent');
  toolDialog.beginView('context');
  assert.equal(mainRoute.isCurrentView(nextGoogleView, 'google'), true);

  const response = deferred();
  let rendered = false;
  const pendingRead = response.promise.then(() => {
    if (mainRoute.isCurrentView(nextGoogleView, 'google')) rendered = true;
  });
  toolDialog.beginView('tools');
  response.resolve();
  await pendingRead;
  assert.equal(rendered, true, 'Google read completes after agent/context/tool-palette inspector changes');

  const lateResponse = deferred();
  let lateRendered = false;
  const lateRead = lateResponse.promise.then(() => {
    if (mainRoute.isCurrentView(nextGoogleView, 'google')) lateRendered = true;
  });
  mainRoute.beginView('settings');
  lateResponse.resolve();
  await lateRead;
  assert.equal(lateRendered, false, 'main-route navigation rejects a late Google read');
});

test('history results go stale after a tool, palette, close, or breakpoint generation change', () => {
  for (const invalidate of ['tool', 'palette', 'close', 'breakpoint']) {
    const lifecycle = createPanelLifecycle();
    const generation = lifecycle.begin();
    const request = lifecycle.beginHistory({ generation, key: 'document:1', draftId: '1' });
    lifecycle.begin();
    assert.equal(lifecycle.isCurrentHistory(request, { generation: lifecycle.currentGeneration(), key: 'document:1', draftId: '1' }), false, invalidate);
  }
});

test('a newer history request wins, and a response for a changed document is ignored', () => {
  const lifecycle = createPanelLifecycle();
  const generation = lifecycle.begin();
  const first = lifecycle.beginHistory({ generation, key: 'document:1', draftId: '1' });
  const second = lifecycle.beginHistory({ generation, key: 'document:1', draftId: '1' });
  assert.equal(lifecycle.isCurrentHistory(first, { generation, key: 'document:1', draftId: '1' }), false);
  assert.equal(lifecycle.isCurrentHistory(second, { generation, key: 'document:2', draftId: '2' }), false);
  assert.equal(lifecycle.isCurrentHistory(second, { generation, key: 'document:1', draftId: '1' }), true);
});

test('deferred mobile history and breakpoint history commit only the latest request in either response order', async () => {
  for (const responseOrder of [['A', 'B'], ['B', 'A']]) {
    const lifecycle = createPanelLifecycle();
    let generation = lifecycle.begin();
    const context = { key: 'document:1', draftId: '1' };
    const requests = { A: lifecycle.beginHistory({ ...context, generation }), B: null };
    const responses = { A: deferred(), B: deferred() };
    generation = lifecycle.begin(); // resize invalidates mobile A
    requests.B = lifecycle.beginHistory({ ...context, generation }); // desktop history reload
    const committed = [];
    const commitWhenResolved = async name => {
      const value = await responses[name].promise;
      const request = requests[name];
      if (lifecycle.isCurrentHistory(request, { ...context, generation: lifecycle.currentGeneration() })) committed.push(value);
    };
    const commits = ['A', 'B'].map(commitWhenResolved);
    for (const name of responseOrder) responses[name].resolve(name);
    await Promise.all(commits);
    assert.deepEqual(committed, ['B'], responseOrder.join(' then '));
  }
});
