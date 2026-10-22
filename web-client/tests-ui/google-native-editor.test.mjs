import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleNativeEditor, googleDocumentEditUrl } from '../public/google-native-editor.js';

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

test('Google Docs URL validates IDs and uses the full editable document route', () => {
  assert.equal(googleDocumentEditUrl('abc_DEF-123'), 'https://docs.google.com/document/d/abc_DEF-123/edit');
  for (const invalid of ['', '../secret', 'id?x=1', 'a'.repeat(257), 123, null]) {
    assert.throws(() => googleDocumentEditUrl(invalid), TypeError);
  }
});

test('native editor embeds the original Google Docs UI with safe title and explicit navigation', () => {
  let backCount = 0;
  const title = '<img src=x onerror=alert(1)>';
  const root = createGoogleNativeEditor({
    document: fixtureDocument,
    googleDocument: { documentId: 'doc-1', title, accessToken: 'must-not-leak' },
    onBack: () => backCount++
  });

  assert.equal(root.tagName, 'SECTION');
  assert.equal(root.className, 'google-native-editor');
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.doesNotMatch(root.textContent, /must-not-leak/);

  const buttons = root.querySelectorAll('button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, 'Закрыть документ');
  buttons[0].dispatch('click');
  assert.equal(backCount, 1);

  const link = root.querySelectorAll('a')[0];
  assert.equal(link.textContent, 'Открыть в Google Docs');
  assert.equal(link.href, 'https://docs.google.com/document/d/doc-1/edit');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');

  const frame = root.querySelectorAll('iframe')[0];
  assert.ok(frame);
  assert.equal(frame.src, 'https://docs.google.com/document/d/doc-1/edit');
  assert.equal(frame.title, `Редактор Google Docs: ${title}`);
  assert.equal(frame.allowFullscreen, true);
  assert.equal(frame.allow, 'clipboard-read; clipboard-write; microphone; camera; fullscreen');
  assert.equal(frame.sandbox, undefined);
  assert.match(root.querySelectorAll('p')[0].textContent, /войдите в Google/);
  assert.match(root.querySelectorAll('p')[0].textContent, /в отдельной вкладке/);
  assert.doesNotMatch(root.querySelectorAll('p')[0].textContent, /Изменения сохраняются/);
});
