// Interaction layer for the right-hand agent workspace: the arcana drawer
// (skills, delegated tasks, StoryArt), the account and quota popovers, the
// quota ring, composer autosize and inspector-tab state. It never sends a
// message, changes the configured model or starts a runtime action itself.
import { formatResetRelative, formatWindowPeriod, limitLevel, normalizeRateLimits, remainingLabel, windowTitle } from './agent-limits.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 8;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const DRAWER_TITLES = { skills: 'Навыки и сценарии', tasks: 'Делегированные задачи', storyart: 'Иллюстрации StoryArt' };

export function createAgentPanel({ document, window, root, onOpenContext = () => {}, onDrawerOpen = () => {} }) {
  const $ = (selector, scope = root) => scope.querySelector(selector);
  const $$ = (selector, scope = root) => [...scope.querySelectorAll(selector)];
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drawer = $('#agent-drawer'), drawerTitle = $('#agent-drawer-title'), limitHost = $('#agent-limit');
  const popovers = new Map(); // popover element -> toggle button
  let drawerName = '', drawerOpener = null, quota = null;

  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const animate = (element, keyframes, duration = 180, fill = 'none') => {
    if (!element || reducedMotion() || typeof element.animate !== 'function') return null;
    return element.animate(keyframes, { duration, fill, easing: 'cubic-bezier(.2, .75, .25, 1)' });
  };
  let closing = null;
  const ring = cls => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', cls); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'circle'), fill = document.createElementNS(SVG_NS, 'circle');
    [track, fill].forEach(circle => { circle.setAttribute('cx', '10'); circle.setAttribute('cy', '10'); circle.setAttribute('r', String(RING_RADIUS)); });
    track.setAttribute('class', 'ring-track'); fill.setAttribute('class', 'ring-fill');
    fill.setAttribute('stroke-dasharray', RING_LENGTH.toFixed(3)); fill.setAttribute('transform', 'rotate(-90 10 10)');
    svg.append(track, fill);
    return svg;
  };
  const setRing = (svg, remaining) => {
    const fill = svg.querySelector('.ring-fill');
    const known = typeof remaining === 'number';
    fill.setAttribute('stroke-dashoffset', (known ? RING_LENGTH * (1 - remaining / 100) : RING_LENGTH).toFixed(3));
  };

  // ---------- Drawer ----------
  function openDrawer(name, opener = null) {
    if (!DRAWER_TITLES[name]) return;
    if (closing) { closing.cancel(); closing = null; drawer.hidden = true; }
    const wasOpen = !drawer.hidden;
    drawerName = name; drawerOpener = opener || $(`[data-drawer-target="${name}"]`);
    $$('[data-drawer]').forEach(section => { section.hidden = section.dataset.drawer !== name; });
    $$('[data-drawer-target]').forEach(toggle => toggle.setAttribute('aria-expanded', String(toggle.dataset.drawerTarget === name)));
    drawerTitle.textContent = DRAWER_TITLES[name];
    root.dataset.drawer = name;
    drawer.hidden = false;
    if (!wasOpen) animate(drawer, [{ opacity: 0, transform: 'translateY(-10px)', clipPath: 'inset(0 0 100% 0 round 18px)' }, { opacity: 1, transform: 'none', clipPath: 'inset(0 0 0 0 round 18px)' }], 220);
    else animate($(`[data-drawer="${name}"]`), [{ opacity: 0, transform: 'translateX(8px)' }, { opacity: 1, transform: 'none' }], 160);
    drawerTitle.focus({ preventScroll: true });
    onDrawerOpen(name);
  }
  function closeDrawer({ restoreFocus = true } = {}) {
    // A repeated close while the exit animation runs is ignored: a second forwards-filled
    // animation would outlive the first and keep the drawer invisible on the next open.
    if (drawer.hidden || closing) return;
    const opener = drawerOpener;
    drawerName = ''; drawerOpener = null; delete root.dataset.drawer;
    $$('[data-drawer-target]').forEach(toggle => toggle.setAttribute('aria-expanded', 'false'));
    const motion = animate(drawer, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], 140, 'forwards');
    if (motion) {
      closing = motion;
      motion.onfinish = () => { if (closing !== motion) return; closing = null; drawer.hidden = true; motion.cancel(); };
    } else drawer.hidden = true;
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  }

  // ---------- Popovers (account, quota) ----------
  function openPopover(popover, toggle) {
    [...popovers.keys()].forEach(other => { if (other !== popover) closePopover(other, false); });
    popovers.set(popover, toggle);
    popover.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    animate(popover, [{ opacity: 0, transform: 'translateY(-4px) scale(.98)' }, { opacity: 1, transform: 'none' }], 150);
    popover.focus({ preventScroll: true });
  }
  function closePopover(popover, restoreFocus = true) {
    const toggle = popovers.get(popover); if (!toggle) return;
    popovers.delete(popover);
    popover.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus && toggle.isConnected) toggle.focus({ preventScroll: true });
  }
  function togglePopover(popover, toggle) { popovers.has(popover) ? closePopover(popover) : openPopover(popover, toggle); }

  // ---------- Quota gauge ----------
  function ensureQuota() {
    if (quota) return quota;
    const button = node('button', 'quota-gauge'); button.type = 'button'; button.id = 'agent-quota-toggle';
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'agent-quota-pop');
    const gaugeRing = ring('quota-ring'), label = node('span', 'quota-label');
    button.append(gaugeRing, label);
    const pop = node('div', 'agent-pop quota-pop'); pop.id = 'agent-quota-pop'; pop.hidden = true; pop.tabIndex = -1;
    pop.setAttribute('role', 'region'); pop.setAttribute('aria-labelledby', 'agent-quota-title');
    const head = node('div', 'agent-pop-head'), title = node('h3', '', 'Лимиты аккаунта'); title.id = 'agent-quota-title';
    const close = node('button', 'icon-button agent-pop-close'); close.type = 'button'; close.setAttribute('aria-label', 'Закрыть лимиты');
    close.append(spriteIcon('x')); close.addEventListener('click', () => closePopover(pop));
    head.append(title, close);
    const body = node('div', 'quota-body');
    pop.append(head, body);
    button.addEventListener('click', () => togglePopover(pop, button));
    limitHost.replaceChildren(button, pop);
    quota = { button, ring: gaugeRing, label, pop, body };
    return quota;
  }
  function spriteIcon(name, sprite = 'lucide-sprite') {
    const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use'); use.setAttribute('href', `/assets/icons/${sprite}.svg#${name}`); svg.append(use);
    return svg;
  }
  function formatResetAbsolute(ms) {
    try { return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); } catch { return ''; }
  }
  function windowRow(win, chosen, now) {
    const row = node('article', 'quota-window' + (chosen ? ' chosen' : ''));
    row.dataset.level = limitLevel(win.remainingPercent);
    const top = node('div', 'quota-window-top');
    const r = ring('quota-ring'); setRing(r, win.remainingPercent);
    const name = node('strong', '', windowTitle(win));
    top.append(r, name);
    if (chosen) top.append(node('span', 'quota-chosen', 'в заголовке'));
    row.append(top);
    const value = node('p', 'quota-value');
    value.textContent = win.remainingPercent === null ? 'Остаток неизвестен: runtime не передал процент.' : `${remainingLabel(win.remainingPercent)} · использовано ${100 - win.remainingPercent}%`;
    row.append(value);
    const bar = node('div', 'quota-bar'); bar.setAttribute('aria-hidden', 'true');
    const barFill = node('span'); barFill.style.inlineSize = (win.remainingPercent ?? 0) + '%'; bar.append(barFill);
    if (win.remainingPercent !== null) row.append(bar);
    const facts = [];
    const period = formatWindowPeriod(win.windowMinutes);
    facts.push(period ? `Период окна: ${period}.` : 'Период окна не передан.');
    if (win.resetsAt !== null) facts.push(`Сброс ${formatResetAbsolute(win.resetsAt)} (${formatResetRelative(win.resetsAt, now)}).`);
    else facts.push('Время сброса не передано.');
    row.append(node('p', 'quota-facts', facts.join(' ')));
    return row;
  }
  function renderLimits(limits, { authenticated = false, now = Date.now() } = {}) {
    const data = normalizeRateLimits(limits, { now });
    if (!authenticated && data.status === 'unknown' && !data.windows.length) {
      if (quota) closePopover(quota.pop, false);
      limitHost.hidden = true; return data;
    }
    limitHost.hidden = false;
    const q = ensureQuota(), summary = data.summary;
    const remaining = summary ? summary.remainingPercent : null;
    q.button.dataset.level = data.spendControlReached && limitLevel(remaining) === 'ok' ? 'low' : limitLevel(remaining);
    setRing(q.ring, remaining);
    q.label.textContent = remainingLabel(remaining);
    const where = summary ? windowTitle(summary) : '';
    const accessible = summary
      ? `${remainingLabel(remaining)} — ${where}${data.summaryReason === 'most-restrictive' ? ', самое строгое из окон' : ''}. Подробнее о лимитах`
      : 'Остаток лимита неизвестен. Подробнее о лимитах';
    q.button.setAttribute('aria-label', accessible); q.button.dataset.tip = summary ? where : 'Данные о лимитах не получены';
    q.body.replaceChildren();
    if (summary) {
      q.body.append(node('p', 'quota-lede', data.summaryReason === 'most-restrictive'
        ? `В заголовке показано самое строгое окно: ${where}. Остальные окна — ниже.`
        : `В заголовке показано окно: ${where}.`));
    } else {
      q.body.append(node('p', 'quota-lede', data.windows.length
        ? 'Runtime передал окна лимитов без процента использования. Остаток неизвестен, это не ноль.'
        : 'Runtime пока не передал данные о лимитах аккаунта. Остаток неизвестен, это не ноль. Обновите статус агента.'));
    }
    const ordered = data.windows.slice().sort((a, b) => (a === summary ? -1 : b === summary ? 1 : 0));
    ordered.forEach(win => q.body.append(windowRow(win, win === summary, now)));
    if (data.spendControlReached) q.body.append(node('p', 'quota-note warn', 'Достигнут установленный лимит расходов аккаунта. Новые запросы могут быть отклонены, даже если окно не исчерпано.'));
    data.credits.forEach(credit => {
      const parts = [];
      if (credit.hasCredits !== null) parts.push(credit.hasCredits ? 'кредиты есть' : 'кредитов нет');
      if (credit.balance !== null) parts.push('баланс ' + new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(credit.balance));
      if (credit.unlimited === true) parts.push('кредиты без ограничения (окна лимитов при этом действуют)');
      if (parts.length) q.body.append(node('p', 'quota-note', `${credit.limitLabel}: ${parts.join(', ')}.`));
    });
    return data;
  }

  // ---------- Status, toggles ----------
  // States: loading (request in flight), error, running, pending (login), disconnected
  // (account known but runtime unavailable), online, offline (login needed).
  function syncState(agent = {}) {
    root.removeAttribute('aria-busy'); $('#agent-refresh')?.removeAttribute('aria-busy');
    root.dataset.state = agent.error ? 'error' : agent.running ? 'running' : agent.loginPending ? 'pending'
      : agent.authenticated && agent.available === false ? 'disconnected' : agent.authenticated ? 'online' : 'offline';
  }
  function markLoading() {
    // Keep the last known state visible; only flag that a status request is in flight.
    if (!root.dataset.state || root.dataset.state === 'offline' && !root.dataset.loaded) root.dataset.state = 'loading';
    root.dataset.loaded = '1';
    root.setAttribute('aria-busy', 'true'); $('#agent-refresh')?.setAttribute('aria-busy', 'true');
  }
  /** attention: '' | 'running' | 'error' — a small mark on the arcana chip. */
  function describeToggle(name, label, { attention = '' } = {}) {
    const toggle = $(`[data-drawer-target="${name}"]`); if (!toggle) return;
    toggle.setAttribute('aria-label', label); toggle.dataset.tip = label;
    if (attention) toggle.dataset.attention = attention; else delete toggle.dataset.attention;
  }

  // ---------- Wiring ----------
  $$('[data-drawer-target]').forEach(toggle => toggle.addEventListener('click', () => {
    drawerName === toggle.dataset.drawerTarget ? closeDrawer() : openDrawer(toggle.dataset.drawerTarget, toggle);
  }));
  $('#agent-drawer-close').addEventListener('click', () => closeDrawer());
  const accountPop = $('#agent-account-pop'), accountToggle = $('#agent-status-pill');
  accountToggle.addEventListener('click', () => togglePopover(accountPop, accountToggle));
  $('#agent-account-close').addEventListener('click', () => closePopover(accountPop));
  $('#chat-context-chip').addEventListener('click', () => onOpenContext());

  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = [...popovers.keys()].at(-1);
    if (open) { event.preventDefault(); event.stopPropagation(); closePopover(open); return; }
    if (!drawer.hidden) { event.preventDefault(); event.stopPropagation(); closeDrawer(); }
  });
  document.addEventListener('pointerdown', event => {
    for (const [popover, toggle] of popovers) if (!popover.contains(event.target) && !toggle.contains(event.target)) closePopover(popover, false);
  });

  const input = $('#chat-input');
  const autosize = () => { input.style.blockSize = 'auto'; input.style.blockSize = Math.min(input.scrollHeight + 2, 220) + 'px'; };
  input.addEventListener('input', autosize);
  // Programmatic fills (quick actions) do not fire "input"; resize on focus as well.
  input.addEventListener('focus', autosize);

  $$('[data-inspector]', document).forEach(tab => {
    const sync = () => tab.setAttribute('aria-pressed', String(tab.classList.contains('selected')));
    sync(); new window.MutationObserver(sync).observe(tab, { attributes: true, attributeFilter: ['class'] });
  });

  return { renderLimits, syncState, markLoading, describeToggle, openDrawer, closeDrawer, get drawer() { return drawerName; } };
}
