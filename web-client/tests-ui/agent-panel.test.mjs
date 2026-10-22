import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentPanel } from '../public/agent-panel.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// Minimal DOM: enough for the panel's own rendering and keyboard logic.
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class FakeElement {
  constructor(doc, tag) {
    Object.assign(this, { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, dataset: {}, style: {}, hidden: false, listeners: {}, className: '', ownText: '', isConnected: true });
    this.classList = {
      contains: c => this.className.split(/\s+/).includes(c),
      add: c => { if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: c => { this.className = this.className.split(/\s+/).filter(x => x && x !== c).join(' '); }
    };
  }
  setAttribute(name, value) {
    if (name === 'class') this.className = String(value);
    else if (name === 'id') this.id = String(value);
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
    else this.attrs[name] = String(value);
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id ?? null;
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    return this.attrs[name] ?? null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))]; else delete this.attrs[name]; }
  toggleAttribute(name, force) { force ? this.setAttribute(name, '') : this.removeAttribute(name); }
  append(...nodes) { nodes.forEach(n => { n.parent = this; this.children.push(n); }); }
  replaceChildren(...nodes) { this.children = []; this.ownText = ''; this.append(...nodes); }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(' '); }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    (this.listeners[type] || []).forEach(fn => fn(event));
    return event;
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  matches(selector) {
    let m;
    if ((m = /^#(.+)$/.exec(selector))) return this.id === m[1];
    if ((m = /^\.(.+)$/.exec(selector))) return this.classList.contains(m[1]);
    if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector))) { const v = this.getAttribute(m[1]); return m[2] === undefined ? v !== null : v === m[2]; }
    throw Error('unsupported selector ' + selector);
  }
  querySelector(selector) { for (const n of this.walk()) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { return [...this.walk()].filter(n => n.matches(selector)); }
}

function setup({ reduce = true } = {}) {
  const doc = { activeElement: null, listeners: {} };
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.createElementNS = (_, tag) => new FakeElement(doc, tag);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  const el = (tag, id, attrs = {}, parent) => { const n = doc.createElement(tag); if (id) n.id = id; Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); parent?.append(n); return n; };
  const shell = el('div'), root = el('aside', 'agent-pane', { 'data-state': 'offline' }, shell);
  el('button', 'agent-status-pill', {}, root); el('div', 'agent-limit', {}, root).hidden = true;
  ['skills', 'tasks', 'storyart'].forEach(name => el('button', '', { 'data-drawer-target': name, 'aria-expanded': 'false' }, root));
  el('button', 'agent-refresh', {}, root);
  const account = el('div', 'agent-account-pop', {}, root); account.hidden = true; el('button', 'agent-account-close', {}, account);
  const drawer = el('div', 'agent-drawer', {}, root); drawer.hidden = true;
  el('h3', 'agent-drawer-title', {}, drawer); el('button', 'agent-drawer-close', {}, drawer);
  ['skills', 'tasks', 'storyart'].forEach(name => { el('section', '', { 'data-drawer': name }, drawer).hidden = true; });
  el('button', 'chat-context-chip', {}, root); el('textarea', 'chat-input', {}, root);
  const tab = el('button', '', { 'data-inspector': 'agent', class: 'inspector-tab selected' }, shell);
  doc.querySelectorAll = selector => shell.querySelectorAll(selector);
  const window = { matchMedia: () => ({ matches: reduce }), MutationObserver: class { observe() {} } };
  const opened = [], contexts = [];
  const panel = createAgentPanel({ document: doc, window, root, onOpenContext: () => contexts.push(1), onDrawerOpen: name => opened.push(name) });
  return { doc, root, panel, opened, contexts, tab, $: s => root.querySelector(s) };
}

const codex = { codex: { limitId: 'codex', primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: 1761040800 }, secondary: { usedPercent: 12, windowDurationMins: 10080 }, credits: { hasCredits: true, unlimited: true }, planType: 'plus' } };

test('gauge shows remaining (53%), not used (47%), and names the chosen window', () => {
  const { $, panel } = setup();
  panel.renderLimits(codex, { authenticated: true, now: 1761040800000 - 3600000 });
  const gauge = $('#agent-quota-toggle');
  assert.equal($('#agent-limit').hidden, false);
  assert.equal(gauge.querySelector('.quota-label').textContent, 'Осталось 53%');
  assert.equal(gauge.dataset.level, 'ok');
  assert.match(gauge.getAttribute('aria-label'), /^Осталось 53% — Codex · окно: 5 ч, самое строгое из окон/);
  const offset = Number(gauge.querySelector('.ring-fill').getAttribute('stroke-dashoffset'));
  const length = Number(gauge.querySelector('.ring-fill').getAttribute('stroke-dasharray'));
  assert.ok(Math.abs(offset - length * 0.47) < 0.01, 'ring is 53% filled');
  assert.doesNotMatch(gauge.textContent, /47|usedPercent|planType|plus/);
});

test('details popover lists every window with period and reset; opens and closes by keyboard with focus return', () => {
  const { $, panel, root, doc } = setup();
  panel.renderLimits(codex, { authenticated: true, now: 1761040800000 - 3600000 });
  const gauge = $('#agent-quota-toggle'), pop = $('#agent-quota-pop');
  assert.equal(pop.hidden, true);
  gauge.click();
  assert.equal(pop.hidden, false); assert.equal(gauge.getAttribute('aria-expanded'), 'true'); assert.equal(doc.activeElement, pop);
  const windows = pop.querySelectorAll('.quota-window');
  assert.equal(windows.length, 2);
  assert.ok(windows[0].classList.contains('chosen'));
  assert.match(pop.textContent, /Период окна: 5 ч/);
  assert.match(pop.textContent, /Период окна: неделя/);
  assert.match(pop.textContent, /через 1 ч/);
  assert.match(pop.textContent, /Время сброса не передано/);
  assert.match(pop.textContent, /окна лимитов при этом действуют/, 'unlimited credits are not shown as unlimited quota');
  assert.doesNotMatch(pop.textContent, /usedPercent|windowDurationMins|resetsAt|planType|limitId/);
  const esc = root.dispatch('keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, true, 'Escape is consumed so the mobile sheet stays open');
  assert.equal(pop.hidden, true); assert.equal(gauge.getAttribute('aria-expanded'), 'false'); assert.equal(doc.activeElement, gauge);
});

test('missing data while signed in is unknown (dashed), never 0%; signed out hides the gauge', () => {
  const { $, panel } = setup();
  panel.renderLimits(null, { authenticated: true });
  const gauge = $('#agent-quota-toggle');
  assert.equal(gauge.querySelector('.quota-label').textContent, 'Остаток неизвестен');
  assert.equal(gauge.dataset.level, 'unknown');
  assert.doesNotMatch(gauge.getAttribute('aria-label'), /0%/);
  assert.match($('#agent-quota-pop').textContent, /это не ноль/);
  panel.renderLimits(null, { authenticated: false });
  assert.equal($('#agent-limit').hidden, true);
});

test('fully spent and fresh windows render 0% and 100% remaining', () => {
  const { $, panel } = setup();
  panel.renderLimits({ primary: { usedPercent: 100 } }, { authenticated: true });
  assert.equal($('#agent-quota-toggle').querySelector('.quota-label').textContent, 'Осталось 0%');
  assert.equal($('#agent-quota-toggle').dataset.level, 'critical');
  panel.renderLimits({ primary: { usedPercent: 0 } }, { authenticated: true });
  assert.equal($('#agent-quota-toggle').querySelector('.quota-label').textContent, 'Осталось 100%');
});

test('drawer opens from an arcana chip, Escape closes it and returns focus; popover closes first', () => {
  const { $, panel, root, doc, opened } = setup();
  const skills = $('[data-drawer-target="skills"]'), drawer = $('#agent-drawer');
  skills.click();
  assert.equal(drawer.hidden, false); assert.equal(skills.getAttribute('aria-expanded'), 'true');
  assert.equal($('[data-drawer="skills"]').hidden, false); assert.equal($('[data-drawer="tasks"]').hidden, true);
  assert.deepEqual(opened, ['skills']);
  $('[data-drawer-target="storyart"]').click();
  assert.equal($('[data-drawer="storyart"]').hidden, false); assert.deepEqual(opened, ['skills', 'storyart']);
  assert.equal(panel.drawer, 'storyart');
  const account = $('#agent-account-pop'), pill = $('#agent-status-pill');
  pill.click(); assert.equal(account.hidden, false);
  root.dispatch('keydown', { key: 'Escape' });
  assert.equal(account.hidden, true); assert.equal(drawer.hidden, false, 'innermost layer closes first');
  root.dispatch('keydown', { key: 'Escape' });
  assert.equal(drawer.hidden, true); assert.equal(doc.activeElement, $('[data-drawer-target="storyart"]'));
  const idle = root.dispatch('keydown', { key: 'Escape' });
  assert.equal(idle.defaultPrevented, false, 'with nothing open Escape reaches the sheet');
});

test('animated drawer: double close then reopen leaves no forwards-filled exit animation', () => {
  const { $, panel } = setup({ reduce: false });
  const drawer = $('#agent-drawer'), runs = [];
  drawer.animate = (keyframes, options) => { const run = { keyframes, options, cancelled: false, finished: false, cancel() { this.cancelled = true; }, finish() { this.finished = true; this.onfinish?.(); } }; runs.push(run); return run; };
  const stuckHidden = () => runs.some(run => run.finished && !run.cancelled && run.options.fill === 'forwards' && run.keyframes.at(-1).opacity === 0);
  panel.openDrawer('skills');
  panel.closeDrawer(); panel.closeDrawer();
  runs.forEach(run => { if (!run.finished && !run.cancelled) run.finish(); });
  assert.equal(drawer.hidden, true);
  panel.openDrawer('tasks');
  runs.forEach(run => { if (!run.finished && !run.cancelled) run.finish(); });
  assert.equal(drawer.hidden, false);
  assert.equal(stuckHidden(), false, 'no finished exit animation keeps opacity 0');
  assert.equal(runs.filter(run => run.options.fill === 'forwards').length, 1, 'second close is ignored');
});

test('states are distinct and loading keeps the last known state', () => {
  const { root, panel, $ } = setup();
  panel.markLoading(); assert.equal(root.dataset.state, 'loading'); assert.equal($('#agent-refresh').getAttribute('aria-busy'), 'true');
  panel.syncState({ authenticated: true, available: true }); assert.equal(root.dataset.state, 'online'); assert.equal($('#agent-refresh').getAttribute('aria-busy'), null);
  panel.markLoading(); assert.equal(root.dataset.state, 'online');
  panel.syncState({ authenticated: true, available: false }); assert.equal(root.dataset.state, 'disconnected');
  panel.syncState({ authenticated: true, running: true }); assert.equal(root.dataset.state, 'running');
  panel.syncState({ loginPending: true }); assert.equal(root.dataset.state, 'pending');
  panel.syncState({ error: 'boom', authenticated: true }); assert.equal(root.dataset.state, 'error');
  panel.syncState({}); assert.equal(root.dataset.state, 'offline');
});

test('arcana labels and attention marks are set through describeToggle', () => {
  const { $, panel } = setup();
  panel.describeToggle('tasks', 'Делегированные задачи: 3, выполняется 1', { attention: 'running' });
  const tasks = $('[data-drawer-target="tasks"]');
  assert.equal(tasks.getAttribute('aria-label'), 'Делегированные задачи: 3, выполняется 1');
  assert.equal(tasks.dataset.attention, 'running');
  panel.describeToggle('tasks', 'Делегированные задачи: 3');
  assert.equal(tasks.dataset.attention, undefined);
});

test('context chip only opens the context panel', () => {
  const { $, contexts } = setup();
  $('#chat-context-chip').click();
  assert.deepEqual(contexts, [1]);
});

test('shell and app integration: raw limit dump removed, panel stylesheet linked, controls kept', () => {
  const html = read('../public/index.html'), app = read('../public/app.js'), css = read('../public/agent-panel.css');
  assert.doesNotMatch(app, /rateLimitLabel/);
  assert.match(app, /agentPanel\.renderLimits\(a\.limits/);
  assert.match(html, /<link rel="stylesheet" href="\/agent-panel\.css/);
  for (const id of ['model-select', 'agent-connect', 'agent-refresh', 'agent-stop', 'chat-send', 'agent-mode', 'review-request', 'agent-login-status',
    'agent-availability-content', 'agent-delegation-content', 'storyart-request-content', 'chat-context-chip', 'agent-limit'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /https?:\/\//);
  // Choosing a scenario in the drawer only sets the select; it never submits.
  const at = app.indexOf('scenario-choose');
  assert.ok(at > 0);
  const choose = app.slice(at, at + 400);
  assert.doesNotMatch(choose, /sendMessage|requestSubmit|\/api\/agent\/message/);
  // Browser login is offered alongside device code in the unauthenticated banner.
  assert.match(app, /'Войти через ChatGPT'/);
  assert.match(app, /'Войти кодом устройства'/);
});
