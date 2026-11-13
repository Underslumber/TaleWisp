// Author tools for the web client: statistics and goals, chapter version history, timeline, continuity findings,
// book export, agent journal with undo, focus mode, loading and offline indicators, entity hover cards, first-run steps.
// The module owns its own drawer and talks to /api/tools/*; the host passes a few callbacks and nothing else is touched.
import { diffParagraphs, findEntityAt, formatNumber, pluralWords, streakLabel } from './author-tools-model.js';

const SVG = 'http://www.w3.org/2000/svg';
const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const MOMENT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function installAuthorTools({ document, window, api, notify, ask, chapters, openCard, openSearchResult, switchView, hasBook, resume }) {
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const remember = (key, value) => { try { storage?.setItem(key, value); } catch { /* private mode */ } };
  const recall = key => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const el = (tag, className = '', text = null) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== null) node.textContent = text; return node; };
  const button = (label, className, onClick) => { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', onClick); return node; };
  const icon = name => { const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS(SVG, 'use'); use.setAttribute('href', `/assets/icons/lucide-sprite.svg#${name}`); svg.append(use); return svg; };
  const emptyState = (head, text) => { const node = el('div', 'empty-state'); node.append(el('strong', '', head), el('span', '', text)); return node; };
  const skeleton = (rows = 4) => { const node = el('div', 'tw-skeleton-block'); node.setAttribute('aria-hidden', 'true'); node.append(el('div', 'tw-skeleton tw-skeleton-title')); for (let i = 0; i < rows; i += 1) node.append(el('div', `tw-skeleton${i === rows - 1 ? ' tw-skeleton-short' : ''}`)); return node; };
  const shell = document.querySelector('.app-shell');

  // ---- Drawer ---------------------------------------------------------------------------------------
  const drawer = el('aside', 'at-drawer'); drawer.hidden = true; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'false'); drawer.setAttribute('aria-labelledby', 'at-drawer-title');
  const drawerTitle = el('h2', 'at-drawer-title'); drawerTitle.id = 'at-drawer-title'; drawerTitle.tabIndex = -1;
  const drawerBody = el('div', 'at-drawer-body');
  const drawerHead = el('header', 'at-drawer-head');
  const closeButton = button('', 'icon-button', () => closeDrawer()); closeButton.setAttribute('aria-label', 'Закрыть панель'); closeButton.append(icon('x'));
  drawerHead.append(drawerTitle, closeButton); drawer.append(drawerHead, drawerBody); document.body.append(drawer);
  let returnFocus = null, panelToken = 0, openPanel = '';
  function closeDrawer() { if (drawer.hidden) return; drawer.hidden = true; openPanel = ''; panelToken += 1; returnFocus?.focus?.({ preventScroll: true }); returnFocus = null; }
  /** Opens a panel and renders it; `render(body, isCurrent)` may be async and must check isCurrent() after awaits. */
  async function show(id, title, render) {
    if (drawer.hidden) returnFocus = document.activeElement;
    const token = ++panelToken; openPanel = id;
    drawerTitle.textContent = title; drawerBody.replaceChildren(skeleton()); drawer.hidden = false; drawerTitle.focus({ preventScroll: true });
    const body = el('div', 'at-panel');
    try { await render(body, () => token === panelToken); if (token === panelToken) drawerBody.replaceChildren(body); }
    catch (error) { if (token === panelToken) drawerBody.replaceChildren(emptyState('Не удалось открыть', error.message || 'Попробуйте ещё раз.')); }
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !drawer.hidden && !event.defaultPrevented) { event.preventDefault(); closeDrawer(); } });

  // ---- Launcher -------------------------------------------------------------------------------------
  const PANELS = [
    ['stats', 'Статистика и цели', 'Слова за день, прогресс книги', () => showStats()],
    ['history', 'История версий главы', 'Сравнить и восстановить', () => showHistory()],
    ['continuity', 'Проверка непрерывности', 'Сверить открытую главу с каноном', () => showContinuity()],
    ['timeline', 'Хронология', 'События книги и персонажей', () => showTimeline()],
    ['export', 'Сборка книги', 'EPUB, DOCX, FB2', () => showExport()],
    ['journal', 'Журнал агента', 'Что изменено в базе, с отменой', () => showJournal()],
    ['focus', 'Режим фокуса', 'Только текст, F9', () => toggleFocus()],
    ['start', 'С чего начать', 'Три шага для новой книги', () => showStart()],
  ];
  const launcher = el('div', 'theme-picker at-launcher');
  const toggle = button('', 'theme-picker-toggle at-launcher-toggle', () => (menu.hidden ? openMenu() : closeMenu(false)));
  toggle.title = 'Инструменты автора'; toggle.setAttribute('aria-label', 'Инструменты автора'); toggle.setAttribute('aria-haspopup', 'true'); toggle.setAttribute('aria-expanded', 'false'); toggle.append(icon('layout-grid'));
  const badge = el('span', 'at-badge'); badge.hidden = true; toggle.append(badge);
  const menu = el('div', 'theme-menu at-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Инструменты автора'); menu.hidden = true;
  const menuItems = PANELS.map(([id, name, note, run]) => { const item = button('', 'theme-option', () => { closeMenu(false); run(); }); item.setAttribute('role', 'menuitem'); item.dataset.panel = id; const label = el('span', '', name); label.append(el('small', '', note)); item.append(label); menu.append(item); return item; });
  function openMenu() { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); menuItems[0].focus(); }
  function closeMenu(refocus) { if (menu.hidden) return; menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (refocus) toggle.focus(); }
  menu.addEventListener('keydown', event => { const index = menuItems.indexOf(document.activeElement); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); } else if (event.key === 'ArrowDown') { event.preventDefault(); menuItems[(index + 1) % menuItems.length].focus(); } else if (event.key === 'ArrowUp') { event.preventDefault(); menuItems[(index - 1 + menuItems.length) % menuItems.length].focus(); } });
  document.addEventListener('click', event => { if (!launcher.contains(event.target)) closeMenu(false); });
  launcher.append(toggle, menu);
  document.querySelector('.masthead-actions')?.prepend(launcher);

  const needBook = body => { if (hasBook()) return true; body.append(emptyState('Сначала выберите книгу', 'Откройте колоду в шапке и выберите автора, серию и книгу.')); return false; };

  // ---- Statistics -----------------------------------------------------------------------------------
  function showStats() {
    return show('stats', 'Статистика и цели', async (body, isCurrent) => {
      if (!needBook(body)) return;
      const stats = await api('/api/tools/stats'); if (!isCurrent()) return;
      const tiles = el('div', 'at-tiles');
      const tile = (value, label, note = '') => { const node = el('div', 'at-tile'); node.append(el('strong', '', value), el('span', '', label)); if (note) node.append(el('small', '', note)); return node; };
      tiles.append(tile(formatNumber(stats.totalWords), 'слов в книге', stats.source === 'documents' ? 'по локальным черновикам' : 'по рабочей рукописи'),
        tile((stats.today > 0 ? '+' : '') + formatNumber(stats.today), 'сегодня', stats.dailyGoal ? `цель ${formatNumber(stats.dailyGoal)}` : ''),
        tile(String(stats.streak), streakLabel(stats.streak), stats.streak ? 'дней подряд с новым текстом' : 'серия начнётся с первого дня'));
      body.append(tiles);
      const meter = (label, value, goal) => { const wrap = el('div', 'at-meter'); const share = goal ? Math.max(0, Math.min(1, value / goal)) : 0; const bar = el('div', 'at-meter-bar'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(goal)); bar.setAttribute('aria-valuenow', String(Math.max(0, Math.min(value, goal)))); bar.setAttribute('aria-label', label); const fill = el('i'); fill.style.width = `${(share * 100).toFixed(1)}%`; bar.append(fill); wrap.append(el('div', 'at-meter-label', `${label}: ${formatNumber(Math.max(0, value))} из ${formatNumber(goal)} (${Math.round(share * 100)}%)`), bar); return wrap; };
      if (stats.targetWords) body.append(meter('Книга', stats.totalWords, stats.targetWords));
      if (stats.dailyGoal) body.append(meter('Сегодня', stats.today, stats.dailyGoal));
      const goals = el('form', 'at-goals');
      const field = (label, value) => { const wrap = el('label', 'at-field', label); const input = el('input'); input.type = 'number'; input.min = '0'; input.step = '100'; input.inputMode = 'numeric'; input.value = value ? String(value) : ''; input.placeholder = 'не задана'; wrap.append(input); return [wrap, input]; };
      const [targetWrap, target] = field('Цель по книге, слов', stats.targetWords), [dailyWrap, daily] = field('Цель на день, слов', stats.dailyGoal);
      const save = el('button', 'button button-primary', 'Сохранить цели'); save.type = 'submit';
      goals.append(targetWrap, dailyWrap, save);
      goals.addEventListener('submit', async event => { event.preventDefault(); const number = input => Math.max(0, Math.round(Number(input.value) || 0)); save.disabled = true; try { await api('/api/tools/stats/goals', { method: 'POST', body: { targetWords: number(target), dailyGoal: number(daily) } }); notify('Цели сохранены.'); showStats(); } catch (error) { notify(error.message, true); save.disabled = false; } });
      body.append(goals);
      body.append(el('h3', 'at-heading', 'Последние 30 дней'));
      const days = stats.days.slice(-30);
      if (!days.some(day => day.written !== 0)) body.append(el('p', 'at-note', 'График появится, когда в рукописи будут сохранены изменения в разные дни.'));
      else {
        const peak = Math.max(1, ...days.map(day => Math.abs(day.written))), chart = el('div', 'at-chart'); chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', 'Слова по дням: ' + days.map(day => `${DAY.format(new Date(day.day))} ${day.written}`).join(', '));
        for (const day of days) { const column = el('div', 'at-chart-day' + (day.written < 0 ? ' is-negative' : '')); const bar = el('i'); bar.style.height = `${Math.max(2, Math.round(Math.abs(day.written) / peak * 100))}%`; column.title = `${DAY.format(new Date(day.day))}: ${day.written > 0 ? '+' : ''}${formatNumber(day.written)}`; column.append(bar); chart.append(column); }
        body.append(chart);
      }
      body.append(el('h3', 'at-heading', 'Главы'));
      if (!stats.chapters.length) body.append(el('p', 'at-note', 'В книге пока нет глав с текстом.'));
      const list = el('ol', 'at-chapters'); const widest = Math.max(1, ...stats.chapters.map(row => row.words));
      for (const row of stats.chapters) { const item = el('li'); const bar = el('i'); bar.style.width = `${Math.round(row.words / widest * 100)}%`; item.append(el('span', 'at-chapter-title', row.title), el('span', 'at-chapter-words', pluralWords(row.words)), bar); list.append(item); }
      body.append(list);
    });
  }

  // ---- Chapter history ------------------------------------------------------------------------------
  function showHistory() {
    return show('history', 'История версий главы', async (body, isCurrent) => {
      if (!needBook(body)) return;
      const key = chapters()?.currentKey?.();
      if (!key) { body.append(emptyState('Откройте главу', 'История ведётся для глав рабочей рукописи. Версии локальных черновиков находятся во вкладке «История» справа.')); return; }
      const { versions } = await api('/api/tools/history?chapter=' + encodeURIComponent(key)); if (!isCurrent()) return;
      body.append(el('p', 'at-note', 'Версия создаётся при сохранении рабочей рукописи. Правки в течение десяти минут дополняют одну версию.'));
      if (!versions.length) { body.append(emptyState('Версий пока нет', 'Они появятся после первого сохранения этой главы.')); return; }
      const list = el('div', 'at-versions'), detail = el('div', 'at-version-detail');
      let selected = null;
      const select = async (item, node) => {
        selected = item; for (const other of list.children) other.classList.toggle('selected', other === node);
        detail.replaceChildren(skeleton(3));
        try {
          const full = await api('/api/tools/history/version?id=' + item.id); if (!isCurrent() || selected !== item) return;
          const current = chapters()?.currentBody?.() ?? '', rows = diffParagraphs(full.body, current), changed = rows.filter(row => row.type !== 'same').length;
          const actions = el('div', 'at-actions'), labelInput = el('input'); labelInput.type = 'text'; labelInput.maxLength = 120; labelInput.placeholder = 'Подпись закреплённой версии'; labelInput.setAttribute('aria-label', 'Подпись закреплённой версии'); labelInput.value = item.label === 'Из Google' ? '' : item.label; labelInput.hidden = item.pinned;
          actions.append(button('Восстановить эту версию', 'button button-primary', async () => {
            if (await ask('Восстановить версию?', 'Текст главы в редакторе заменится выбранной версией. Текущий текст останется в истории.', 'Восстановить') !== 'confirm') return;
            try { await chapters()?.flushWorking?.(); } catch { /* the current text stays in the browser and is saved on the next attempt */ }
            if (chapters()?.replaceBody?.(full.body)) { notify('Версия восстановлена. Изменение сохранится как новая версия.'); closeDrawer(); } else notify('Глава сейчас недоступна для правки.', true);
          }), button(item.pinned ? 'Снять закрепление' : 'Закрепить', 'button button-quiet', async () => {
            try { await api('/api/tools/history/pin', { method: 'POST', body: { id: item.id, pinned: !item.pinned, label: item.pinned ? '' : labelInput.value.trim().slice(0, 120) } }); showHistory(); } catch (error) { notify(error.message, true); }
          }));
          const diff = el('div', 'at-diff'); diff.setAttribute('aria-label', 'Отличия версии от текущего текста');
          if (!changed) diff.append(el('p', 'at-note', 'Эта версия совпадает с текущим текстом.'));
          else for (const row of rows) { if (row.type === 'same') { if (row.text.trim()) diff.append(el('p', 'at-diff-same', row.text.length > 160 ? row.text.slice(0, 160) + '…' : row.text)); continue; } const line = el('p', row.type === 'removed' ? 'at-diff-removed' : 'at-diff-added'); line.append(el('span', 'at-diff-mark', row.type === 'removed' ? 'было в версии' : 'сейчас'), document.createTextNode(row.text)); diff.append(line); }
          actions.append(labelInput);
          detail.replaceChildren(el('p', 'at-note', changed ? `Отличается абзацев: ${changed}. Слева отмечено, что было в версии и что в тексте сейчас.` : ''), actions, diff);
        } catch (error) { detail.replaceChildren(emptyState('Версия недоступна', error.message)); }
      };
      for (const item of versions) {
        const node = button('', 'at-version', () => select(item, node));
        node.append(el('strong', '', MOMENT.format(new Date(item.updatedAt))), el('span', '', [pluralWords(item.words), item.label, item.pinned && !item.label ? 'закреплена' : ''].filter(Boolean).join(' · ')));
        list.append(node);
      }
      body.append(list, detail);
      select(versions[0], list.firstElementChild);
    });
  }

  // ---- Continuity -----------------------------------------------------------------------------------
  const CONTINUITY_AUTO = 'talewisp.tools.continuity.auto';
  let continuityTimer = 0, lastChecked = '';
  const severityLabel = { fail: 'Противоречие', hint: 'Проверьте', incomplete: 'Неполные данные' };
  async function runContinuity() { const text = chapters()?.currentBody?.() ?? ''; const report = await api('/api/tools/continuity', { method: 'POST', body: { text } }); lastChecked = text; const serious = report.findings.filter(item => item.severity !== 'incomplete').length; badge.hidden = !serious; badge.textContent = serious ? String(serious) : ''; toggle.title = serious ? `Инструменты автора. Замечаний по непрерывности: ${serious}` : 'Инструменты автора'; return report; }
  function showContinuity() {
    return show('continuity', 'Проверка непрерывности', async (body, isCurrent) => {
      if (!needBook(body)) return;
      if (!chapters()?.currentKey?.()) { body.append(emptyState('Откройте главу', 'Проверка сверяет открытую главу рабочей рукописи с записями канона.')); return; }
      const report = await runContinuity(); if (!isCurrent()) return;
      const auto = el('label', 'at-check'); const box = el('input'); box.type = 'checkbox'; box.checked = recall(CONTINUITY_AUTO) === '1'; box.addEventListener('change', () => { remember(CONTINUITY_AUTO, box.checked ? '1' : '0'); scheduleContinuity(); }); auto.append(box, el('span', '', 'Проверять сама после паузы в наборе'));
      body.append(auto);
      if (!report.contracts.length) { body.append(emptyState('В базе нет записей непрерывности', 'Проверка опирается на контракты непрерывности серии (сцены, персонажи, факты). Попросите агента извлечь их из глав: сценарий «Проверить текст и источники».')); return; }
      body.append(el('p', 'at-note', 'Проверяются только записи, внесённые в контракты. Отсутствие замечаний не означает, что весь канон сверен.'));
      const contracts = el('ul', 'at-contracts');
      for (const contract of report.contracts) { const item = el('li'); item.append(el('span', 'at-chip at-chip-' + (contract.status === 'FAIL' ? 'fail' : contract.status === 'UNAVAILABLE' ? 'muted' : contract.status.startsWith('PASS') ? 'good' : 'warn'), contract.status === 'FAIL' ? 'есть противоречия' : contract.status === 'UNAVAILABLE' ? 'не проверен' : contract.status.startsWith('PASS') ? 'без противоречий' : 'неполный'), el('span', '', contract.path)); if (contract.error) item.append(el('small', '', contract.error)); contracts.append(item); }
      body.append(contracts);
      if (!report.findings.length) { body.append(emptyState('Замечаний к этой главе нет', 'В записях канона не найдено противоречий, связанных с текстом главы.')); return; }
      const list = el('div', 'at-findings');
      for (const finding of report.findings) {
        const card = el('article', 'at-finding at-finding-' + finding.severity);
        card.append(el('span', 'at-chip at-chip-' + (finding.severity === 'fail' ? 'fail' : finding.severity === 'hint' ? 'warn' : 'muted'), severityLabel[finding.severity]), el('p', '', finding.message));
        if (finding.evidence?.quote) { const quote = el('blockquote', '', finding.evidence.quote); card.append(quote, el('small', '', `Источник: ${finding.evidence.path} · запись ${finding.record}`)); }
        if (finding.range) card.append(button('Показать в тексте', 'button button-quiet', () => { const editor = chapters()?.richEditor?.(); if (editor && (chapters()?.currentBody?.() ?? '') === lastChecked) { editor.select(finding.range.start, finding.range.end); if (window.matchMedia('(max-width: 899px)').matches) closeDrawer(); } else notify('Текст изменился после проверки. Запустите её ещё раз.', true); }));
        list.append(card);
      }
      body.append(list, button('Проверить ещё раз', 'button button-quiet', () => showContinuity()));
    });
  }
  function scheduleContinuity() {
    window.clearInterval(continuityTimer); continuityTimer = 0;
    if (recall(CONTINUITY_AUTO) !== '1') return;
    let seen = '', stableFor = 0;
    continuityTimer = window.setInterval(async () => {
      if (!hasBook() || document.hidden || !chapters()?.currentKey?.()) return;
      const text = chapters()?.currentBody?.() ?? '';
      if (text !== seen) { seen = text; stableFor = 0; return; }
      stableFor += 1;
      if (stableFor !== 2 || text === lastChecked) return;
      try { await runContinuity(); if (openPanel === 'continuity') showContinuity(); } catch { /* silent: the manual check reports errors */ }
    }, 4000);
  }
  scheduleContinuity();

  // ---- Timeline -------------------------------------------------------------------------------------
  function showTimeline(axis = 'story', entity = '') {
    return show('timeline', 'Хронология', async (body, isCurrent) => {
      const data = await api(`/api/tools/timeline?axis=${axis}&entity=${encodeURIComponent(entity)}`); if (!isCurrent()) return;
      if (!data.contracts.length) { body.append(emptyState('Событий пока нет', 'Хронология строится из контрактов непрерывности серии: сцен с порядком и подтверждённых событий. Попросите агента извлечь их из глав.')); return; }
      const controls = el('div', 'at-controls');
      const axisGroup = el('div', 'at-segment'); axisGroup.setAttribute('role', 'group'); axisGroup.setAttribute('aria-label', 'Порядок событий');
      for (const [id, label] of [['story', 'Как было в мире'], ['narrative', 'Как рассказано']]) { const item = button(label, 'at-segment-item', () => showTimeline(id, entity)); item.setAttribute('aria-pressed', String(data.axis === id)); axisGroup.append(item); }
      const filter = el('select'); filter.setAttribute('aria-label', 'Персонаж или объект'); const all = el('option', '', 'Все участники'); all.value = ''; filter.append(all);
      for (const row of data.entities) { const option = el('option', '', row.name); option.value = row.id; option.selected = row.id === entity; filter.append(option); }
      filter.addEventListener('change', () => showTimeline(data.axis, filter.value));
      controls.append(axisGroup, filter); body.append(controls);
      if (!data.events.length) { body.append(emptyState('Для этого участника событий нет', 'Выберите другого участника или покажите всех.')); return; }
      const list = el('ol', 'at-timeline');
      for (const event of data.events) {
        const item = el('li', 'at-event' + (event.status !== 'confirmed' ? ' is-draft' : ''));
        const head = el('div', 'at-event-head'); head.append(el('span', 'at-event-order', event.order === null ? '?' : String(event.order)), el('strong', '', event.title)); if (event.status !== 'confirmed') head.append(el('span', 'at-chip at-chip-muted', 'черновик'));
        item.append(head);
        if (event.evidence?.quote) item.append(el('blockquote', '', event.evidence.quote));
        for (const row of event.items) { const line = el('p', 'at-event-item'); line.append(el('span', 'at-chip at-chip-kind', row.label), document.createTextNode(' ' + [row.entityName, row.fact].filter(Boolean).join(': '))); if (row.evidence?.quote) line.title = row.evidence.quote; item.append(line); }
        if (event.evidence?.path) item.append(el('small', '', event.evidence.path));
        list.append(item);
      }
      body.append(list);
    });
  }

  // ---- Export ---------------------------------------------------------------------------------------
  function showExport() {
    return show('export', 'Сборка книги', async body => {
      if (!needBook(body)) return;
      body.append(el('p', 'at-note', 'Файл собирается из рабочей рукописи книги в текущем порядке глав. Жирный, курсив, подчёркивание и зачёркивание сохраняются.'));
      const formats = [['epub', 'EPUB', 'для читалок и площадок'], ['docx', 'DOCX', 'для редактора и бета-читателей'], ['fb2', 'FB2', 'для русскоязычных библиотек']];
      const list = el('div', 'at-exports');
      for (const [format, name, note] of formats) {
        const item = button('', 'at-export', async () => {
          item.disabled = true; item.setAttribute('aria-busy', 'true');
          try {
            await chapters()?.flushWorking?.().catch(() => {});
            const response = await fetch('/api/tools/export?format=' + format, { credentials: 'same-origin' });
            if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Сборка не удалась.'); }
            const blob = await response.blob(), url = URL.createObjectURL(blob), link = el('a'); const match = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') || '');
            link.href = url; link.download = match ? decodeURIComponent(match[1]) : `book.${format}`; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 2000);
            notify(`Файл ${name} собран.`);
          } catch (error) { notify(error.message, true); } finally { item.disabled = false; item.removeAttribute('aria-busy'); }
        });
        item.append(el('strong', '', name), el('span', '', note)); list.append(item);
      }
      body.append(list);
    });
  }

  // ---- Journal --------------------------------------------------------------------------------------
  function showJournal() {
    return show('journal', 'Журнал агента', async (body, isCurrent) => {
      if (!needBook(body)) return;
      const { entries } = await api('/api/tools/journal'); if (!isCurrent()) return;
      body.append(el('p', 'at-note', 'Здесь изменения базы знаний, которые вы применили из предложений агента. Отмена возвращает файл к состоянию до применения, если он с тех пор не менялся.'));
      if (!entries.length) { body.append(emptyState('Изменений пока нет', 'Применённые предложения агента появятся здесь.')); return; }
      const list = el('div', 'at-journal');
      for (const entry of entries) {
        const card = el('article', 'at-entry');
        card.append(el('strong', '', entry.title), el('span', 'at-entry-meta', [entry.appliedAt ? MOMENT.format(new Date(entry.appliedAt)) : '', entry.path || (entry.tool ? 'действие плагина' : 'локальный черновик'), entry.created ? 'создан файл' : ''].filter(Boolean).join(' · ')), el('p', '', entry.summary));
        if (entry.state === 'reverted') card.append(el('span', 'at-chip at-chip-muted', 'отменено ' + (entry.revertedAt ? MOMENT.format(new Date(entry.revertedAt)) : '')));
        else if (entry.undoable) card.append(button('Отменить изменение', 'button button-quiet', async () => { if (await ask('Отменить изменение?', entry.created ? 'Созданный файл будет удалён.' : 'Файл вернётся к тексту до применения предложения.', 'Отменить изменение') !== 'confirm') return; try { await api('/api/tools/journal/undo', { method: 'POST', body: { id: entry.id } }); notify('Изменение отменено.'); showJournal(); } catch (error) { notify(error.message, true); } }));
        else card.append(el('small', '', entry.reason));
        list.append(card);
      }
      body.append(list);
    });
  }

  // ---- First run ------------------------------------------------------------------------------------
  const START_SEEN = 'talewisp.tools.start.seen';
  function showStart() {
    remember(START_SEEN, '1');
    return show('start', 'С чего начать', async body => {
      const steps = [
        ['Подключите книгу', 'Откройте колоду в шапке и выберите автора, серию и книгу. Новую книгу можно создать в настройках проекта.', 'Открыть колоду', () => { closeDrawer(); document.getElementById('deck-toggle')?.click(); }],
        ['Соберите базу знаний', 'Импортируйте уже написанные книги серии. Агент разберёт персонажей, места и события в карточки.', 'К базе знаний', () => { closeDrawer(); switchView('knowledge'); }],
        ['Откройте главу', 'Привяжите рукопись из Google Docs или начните локальный черновик и пишите. Статистика и история версий заработают сами.', 'К тексту', () => { closeDrawer(); switchView('documents'); }],
      ];
      const list = el('ol', 'at-steps');
      steps.forEach(([head, text, action, run], index) => { const item = el('li'); item.append(el('span', 'at-step-number', String(index + 1)), el('strong', '', head), el('p', '', text), button(action, 'button button-quiet', run)); list.append(item); });
      body.append(list, el('p', 'at-note', 'Эту памятку всегда можно открыть в меню инструментов.'));
    });
  }

  // ---- Focus mode -----------------------------------------------------------------------------------
  const focusExit = button('Выйти из фокуса', 'at-focus-exit', () => toggleFocus(false)); focusExit.hidden = true; document.body.append(focusExit);
  let focusFrame = 0;
  const keepCaretSteady = () => {
    if (!shell.classList.contains('at-focus')) return;
    window.cancelAnimationFrame(focusFrame);
    focusFrame = window.requestAnimationFrame(() => {
      const selection = window.getSelection(), scroller = document.getElementById('editor-scroll');
      if (!selection?.rangeCount || !scroller || !scroller.contains(selection.anchorNode)) return;
      const rect = selection.getRangeAt(0).getClientRects()[0] ?? selection.anchorNode.parentElement?.getBoundingClientRect(); if (!rect) return;
      const box = scroller.getBoundingClientRect(), wanted = box.top + box.height * .42, delta = rect.top - wanted;
      if (Math.abs(delta) > 24) scroller.scrollBy({ top: delta, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  };
  function toggleFocus(on = !shell.classList.contains('at-focus')) {
    shell.classList.toggle('at-focus', on); focusExit.hidden = !on; closeDrawer();
    if (on) { notify('Режим фокуса. Выход: F9 или Esc.'); chapters()?.richEditor?.()?.focus?.(); keepCaretSteady(); }
  }
  document.addEventListener('selectionchange', keepCaretSteady);
  document.addEventListener('keydown', event => {
    if (event.key === 'F9') { event.preventDefault(); toggleFocus(); }
    else if (event.key === 'Escape' && shell.classList.contains('at-focus') && drawer.hidden && !document.querySelector('dialog[open]')) toggleFocus(false);
  });

  // ---- Loading bar and offline banner -----------------------------------------------------------------
  const progress = el('div', 'at-progress'); progress.hidden = true; progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', 'Идёт загрузка'); document.body.append(progress);
  const offline = el('div', 'at-offline'); offline.hidden = true; offline.setAttribute('role', 'status'); offline.append(el('span', '', 'Нет связи с сервером. Текст остаётся в браузере и будет сохранён, когда связь вернётся.')); document.body.append(offline);
  let pending = 0, progressTimer = 0, isOffline = false, probeTimer = 0;
  const setOffline = value => {
    if (value === isOffline) return; isOffline = value; offline.hidden = !value; shell.classList.toggle('at-is-offline', value);
    window.clearInterval(probeTimer); probeTimer = 0;
    if (value) probeTimer = window.setInterval(() => { nativeFetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(() => setOffline(false), () => {}); }, 8000);
    else { notify('Связь восстановлена. Сохраняем изменения.'); try { resume?.(); } catch { /* the regular save loop retries */ } }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '', tracked = url.startsWith('/api/') || url.startsWith(window.location.origin + '/api/');
    if (!tracked) return nativeFetch(input, init);
    pending += 1; if (!progressTimer) progressTimer = window.setTimeout(() => { if (pending > 0) progress.hidden = false; }, 400);
    try { const response = await nativeFetch(input, init); setOffline(false); return response; }
    catch (error) { if (error?.name !== 'AbortError') setOffline(true); throw error; }
    finally { pending -= 1; if (pending <= 0) { pending = 0; window.clearTimeout(progressTimer); progressTimer = 0; progress.hidden = true; } }
  };
  window.addEventListener('offline', () => setOffline(true));
  window.addEventListener('online', () => nativeFetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(() => setOffline(false), () => {}));

  // ---- Entity hover card ------------------------------------------------------------------------------
  const hover = el('div', 'at-hover'); hover.hidden = true; hover.setAttribute('role', 'tooltip'); document.body.append(hover);
  let entityCache = null, entityLoadedAt = 0, entityRequest = null, hoverTimer = 0, hoverName = '';
  async function loadEntities() {
    if (entityCache && Date.now() - entityLoadedAt < 5 * 60_000) return entityCache;
    entityRequest ??= api('/api/tools/entities').then(data => { entityCache = data.entities; entityLoadedAt = Date.now(); return entityCache; }).finally(() => { entityRequest = null; });
    return entityRequest;
  }
  const hideHover = () => { window.clearTimeout(hoverTimer); hover.hidden = true; hoverName = ''; };
  const caretAt = (x, y) => { if (document.caretPositionFromPoint) { const position = document.caretPositionFromPoint(x, y); return position ? { node: position.offsetNode, offset: position.offset } : null; } const range = document.caretRangeFromPoint?.(x, y); return range ? { node: range.startContainer, offset: range.startOffset } : null; };
  document.addEventListener('mousemove', event => {
    if (hover.contains(event.target)) return;
    const line = event.target.closest?.('#editor-scroll .cm-line');
    window.clearTimeout(hoverTimer);
    if (!line || !hasBook()) { if (!hover.hidden) hoverTimer = window.setTimeout(hideHover, 250); return; }
    const { clientX, clientY } = event;
    hoverTimer = window.setTimeout(async () => {
      const caret = caretAt(clientX, clientY); if (!caret || caret.node.nodeType !== 3 || !line.contains(caret.node)) return hideHover();
      let offset = caret.offset; const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && node !== caret.node; node = walker.nextNode()) offset += node.data.length;
      let entities; try { entities = await loadEntities(); } catch { return; }
      const found = findEntityAt(line.textContent, offset, entities);
      if (!found) return hideHover();
      if (found.entity.name === hoverName && !hover.hidden) return;
      hoverName = found.entity.name;
      const entity = found.entity, head = el('div', 'at-hover-head'); head.append(el('strong', '', entity.aliasOf || entity.name), el('span', 'at-chip at-chip-kind', entity.type === 'entity' ? 'канон' : entity.type));
      hover.replaceChildren(head);
      if (entity.excerpt) hover.append(el('p', '', entity.excerpt));
      if (entity.knows?.length) { hover.append(el('span', 'at-hover-label', 'Что знает по записям канона')); const list = el('ul'); for (const row of entity.knows.slice(0, 5)) list.append(el('li', '', row.fact)); hover.append(list); }
      if (entity.path) hover.append(button('Открыть карточку', 'text-action', () => { hideHover(); openCard(entity.path); }));
      hover.hidden = false;
      const width = Math.min(340, window.innerWidth - 24); hover.style.width = `${width}px`;
      hover.style.left = `${Math.max(12, Math.min(clientX - 24, window.innerWidth - width - 12))}px`;
      const below = clientY + 22, height = hover.offsetHeight; hover.style.top = `${below + height > window.innerHeight - 12 ? Math.max(12, clientY - height - 14) : below}px`;
    }, 450);
  });
  document.addEventListener('scroll', hideHover, true);
  document.addEventListener('keydown', hideHover);

  if (recall(START_SEEN) !== '1') window.setTimeout(() => { if (!hasBook() && drawer.hidden && !document.querySelector('dialog[open]')) showStart(); }, 2500);

  /** Project-wide search for the Ctrl+K palette. */
  const search = async query => { const data = await api('/api/tools/search?q=' + encodeURIComponent(query)); return data.results; };
  return { showStats, showHistory, showContinuity, showTimeline, showExport, showJournal, showStart, toggleFocus, search, close: closeDrawer, invalidateEntities() { entityCache = null; } };
}
