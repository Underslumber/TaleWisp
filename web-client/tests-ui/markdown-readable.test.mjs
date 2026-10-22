import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSafeMarkdown } from '../public/markdown.js';

class FixtureNode {
  constructor(tagName, text = '') { this.tagName = tagName.toUpperCase(); this.data = text; this.childNodes = []; this.listeners = new Map(); this.className = ''; this.disabled = false; this.dataset = {}; this.classList = { add: name => { this.className += (this.className ? ' ' : '') + name; } }; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = [...nodes]; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  click() { this.listeners.get('click')?.(); }
  querySelectorAll(selector) { const descendants = []; for (const child of this.childNodes) { descendants.push(child); if (child.querySelectorAll) descendants.push(...child.querySelectorAll(selector)); } return descendants.filter(child => selector.split(',').includes(child.tagName.toLowerCase())); }
  get textContent() { return this.tagName === '#TEXT' ? this.data : this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) { this.data = ''; this.childNodes = [new FixtureNode('#text', String(value))]; }
}

globalThis.document = { createElement: tag => new FixtureNode(tag), createTextNode: value => new FixtureNode('#text', String(value)) };

test('GFM tables render safely with wiki-link pipes, code pipes, and escaped cell pipes', () => {
  const container = new FixtureNode('article'), calls = [];
  renderSafeMarkdown(container, [
    'Обычный абзац до таблицы.',
    '',
    '| [[chapter|Глава | первая]] | Значение |',
    '| --- | --- |',
    '| Код | `a|b` |',
    '| Экранировано | left\\|right |',
    '',
    '- пункт после таблицы'
  ].join('\n'), [{ target: 'chapter', path: 'chapter.md', label: 'Глава' }], link => calls.push(link));

  const table = container.querySelectorAll('table');
  assert.equal(table.length, 1);
  assert.equal(container.querySelectorAll('thead').length, 1);
  assert.equal(container.querySelectorAll('tbody').length, 1);
  assert.equal(container.querySelectorAll('th').length, 2);
  assert.equal(container.querySelectorAll('tr').length, 3);
  assert.deepEqual(container.querySelectorAll('code').map(code => code.textContent), ['a|b']);
  assert.deepEqual(container.querySelectorAll('button').map(button => button.textContent), ['Глава | первая']);
  assert.deepEqual(calls, []);
  container.querySelectorAll('button')[0].click();
  assert.equal(calls[0].target, 'chapter');
  assert.equal(container.querySelectorAll('td').at(-1).textContent, 'left|right');
  assert.equal(container.querySelectorAll('p')[0].textContent, 'Обычный абзац до таблицы.');
  assert.equal(container.querySelectorAll('li')[0].textContent, 'пункт после таблицы');
});

test('inline code and table cell HTML stay literal text, without parsing elements', () => {
  const container = new FixtureNode('article');
  renderSafeMarkdown(container, 'Пример ` <img src=x onerror=alert(1)> `\n\n| Поле | Текст |\n| --- | --- |\n| html | <script>alert(2)</script> |');
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.equal(container.querySelectorAll('script').length, 0);
  assert.equal(container.querySelectorAll('code')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.match(container.querySelectorAll('td').at(-1).textContent, /<script>alert\(2\)<\/script>/);
});
