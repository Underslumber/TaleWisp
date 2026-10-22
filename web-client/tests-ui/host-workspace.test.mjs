import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStoryArtRequests, storyArtArtifactUrl, storyArtStatusLabel } from '../public/host-workspace.js';

class ElementFixture {
  constructor(tagName) { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); }
  append(...items) { this.children.push(...items); }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) || []; listeners.push(callback); this.listeners.set(type, listeners); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  dispatch(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback({ preventDefault() {}, ...event }); }
  get textContent() { return (this.value || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.value = String(value); this.children = []; }
  querySelectorAll(tagName) { const matches = []; const visit = item => { for (const child of item.children) { if (child.tagName === tagName.toUpperCase()) matches.push(child); visit(child); } }; visit(this); return matches; }
}

const fixtureDocument = { createElement: tagName => new ElementFixture(tagName) };

test('StoryArt image URLs are constrained to same-origin artifact route and their request id', () => {
  const origin = 'https://tale.example';
  assert.equal(storyArtArtifactUrl('/api/storyart/artifact?requestId=req-1&index=0', 'req-1', origin), `${origin}/api/storyart/artifact?requestId=req-1&index=0`);
  assert.equal(storyArtArtifactUrl('https://elsewhere.example/api/storyart/artifact?requestId=req-1&index=0', 'req-1', origin), '');
  assert.equal(storyArtArtifactUrl('/api/storyart/artifact?requestId=other&index=0', 'req-1', origin), '');
  assert.equal(storyArtArtifactUrl('/api/storyart/artifact-extra?requestId=req-1&index=0', 'req-1', origin), '');
  assert.equal(storyArtArtifactUrl('/api/storyart/artifact?requestId=req-1&index=../secret', 'req-1', origin), '');
});

test('StoryArt workspace renders saved service data as text and exposes explicit actions', async () => {
  const operations = [], refreshes = [];
  const root = renderStoryArtRequests(fixtureDocument, [{
    requestId: 'req-1', status: 'completed', title: '<img src=x onerror=alert(1)>', result: 'Результат кандидата', error: '', threadId: 'thread-1',
    artifacts: [
      { url: '/api/storyart/artifact?requestId=req-1&index=0', label: 'Кандидат 1' },
      { url: 'https://evil.example/pixel.png' }
    ]
  }], {
    origin: 'https://tale.example',
    onRefresh: () => refreshes.push(true),
    onOperation: async (...args) => { operations.push(args); return true; }
  });

  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(root.textContent, /Результат кандидата/);
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(root.querySelectorAll('img')[0].src, 'https://tale.example/api/storyart/artifact?requestId=req-1&index=0');
  assert.equal(root.querySelectorAll('script').length, 0);

  const buttons = root.querySelectorAll('button');
  buttons[0].dispatch('click');
  buttons[1].dispatch('click');
  buttons[2].dispatch('click');
  const correction = root.querySelectorAll('textarea')[0];
  correction.value = 'Сделай фон светлее';
  const form = root.querySelectorAll('form')[0];
  form.dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(refreshes, [true]);
  assert.deepEqual(operations, [['read', 'req-1'], ['wait', 'req-1'], ['send', 'req-1', 'Сделай фон светлее']]);
  assert.equal(correction.value, '');
});

test('StoryArt correction remains available if sending fails', async () => {
  const root = renderStoryArtRequests(fixtureDocument, [{ requestId: 'req-2', status: 'running' }], {
    origin: 'https://tale.example', onOperation: async () => false
  });
  const correction = root.querySelectorAll('textarea')[0];
  correction.value = 'Сохранить эту правку';
  root.querySelectorAll('form')[0].dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(correction.value, 'Сохранить эту правку');
});

test('StoryArt status labels describe actual chat state without declaring artwork approval',()=>{assert.equal(storyArtStatusLabel('completed'),'Ответ получен');assert.equal(storyArtStatusLabel('created'),'Чат создан');assert.equal(storyArtStatusLabel('running'),'Выполняется');assert.equal(storyArtStatusLabel('error'),'Ошибка');assert.equal(storyArtStatusLabel('unrecognized'),'Статус уточняется');});
