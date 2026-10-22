import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSafeMarkdown } from '../public/markdown.js';

class FixtureNode {
  constructor(tagName, text = '') {
    this.tagName = tagName.toUpperCase();
    this.data = text;
    this.childNodes = [];
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.dataset = {};
    this.classList = { add: name => { this.className += (this.className ? ' ' : '') + name; } };
  }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = [...nodes]; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { this.listeners.get('click')?.(); }
  querySelectorAll(selector) { const descendants = []; for (const child of this.childNodes) { descendants.push(child); if (child.querySelectorAll) descendants.push(...child.querySelectorAll(selector)); } return descendants.filter(child => selector.split(',').includes(child.tagName.toLowerCase())); }
  get textContent() { return this.tagName === '#TEXT' ? this.data : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.data = ''; this.childNodes = [new FixtureNode('#text', String(value))]; }
}

globalThis.document = {
  createElement: tag => new FixtureNode(tag),
  createTextNode: value => new FixtureNode('#text', String(value))
};

test('wiki targets allow single closing brackets and retain aliases and anchors', () => {
  const container = new FixtureNode('article'), calls = [];
  const target = '01 Книги/Book [2026]/00 Навигация#Глава 1';
  renderSafeMarkdown(container, `[[${target}]] · [[target/path#section|Короткое имя]]`, [
    { target, path: 'resolved/navigation.md', label: 'Оглавление', status: 'resolved' },
    { target: 'target/path#section', path: 'resolved/target.md', label: 'Цель', status: 'resolved' }
  ], link => calls.push(link));

  const buttons = container.querySelectorAll('button');
  assert.deepEqual(buttons.map(button => button.textContent), ['Оглавление', 'Короткое имя']);
  buttons[0].click(); buttons[1].click();
  assert.equal(calls[0].target, target);
  assert.equal(calls[0].anchor, 'Глава 1');
  assert.equal(calls[0].label, 'Оглавление');
  assert.equal(calls[1].anchor, 'section');
  assert.equal(calls[1].label, 'Короткое имя');
});

test('headings, ordered and unordered lists, emphasis, and hostile HTML render as safe DOM', () => {
  const container = new FixtureNode('article');
  renderSafeMarkdown(container, '# Заголовок\n\n- **жирный**\n- *курсив*\n\n1. первый\n2. второй\n\n<script>alert(1)</script>');

  assert.equal(container.querySelectorAll('h1').length, 1);
  assert.equal(container.querySelectorAll('ul').length, 1);
  assert.equal(container.querySelectorAll('ol').length, 1);
  assert.equal(container.querySelectorAll('strong').length, 1);
  assert.equal(container.querySelectorAll('em').length, 1);
  assert.equal(container.querySelectorAll('script').length, 0);
  assert.match(container.textContent, /<script>alert\(1\)<\/script>/);
});

test('unsafe external targets never become navigable links', () => {
  const container = new FixtureNode('article');
  renderSafeMarkdown(container, '[[javascript:alert(1)]] [внешняя](https://example.test)', [], () => assert.fail('unsafe link was routed'));
  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(button => button.disabled));
});

test('fenced source diagrams preserve lines and literal markup without creating links', () => {
  const container = new FixtureNode('article');
  renderSafeMarkdown(container, 'До\n\n```text\nМана → Домен\n    ↓\n<script>literal</script> [[Мана]]\n```\n\nПосле');
  const pre = container.querySelectorAll('pre');
  assert.equal(pre.length, 1);
  assert.equal(pre[0].textContent, 'Мана → Домен\n    ↓\n<script>literal</script> [[Мана]]');
  assert.equal(pre[0].querySelectorAll('button').length, 0);
  assert.ok(container.textContent.endsWith('После'));
});
