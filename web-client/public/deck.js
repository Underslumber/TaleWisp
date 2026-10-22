import {
  LEVEL_LIST_LABELS, LEVEL_NAMES, LEVEL_NUMERALS, activate, browseAt, confirmedPath, emptySeriesCommit,
  hasConfirmedWorkspace, initialBrowse, levelView, parentLevel, reconcileBrowse, sameSelection, scrollKey
} from './deck-model.js';

const SPRITE = '/assets/icons/tarot-sprite.svg#';
const DIVE_MS = 380, DEAL_MS = 280, DEAL_STEP = 35, LEAVE_MS = 220, FADE_MS = 120;
const EASE_OUT = 'cubic-bezier(.2,.75,.25,1)';

// The top card rail: author → series → book, with a shared-card "dive" between levels.
// Browsing is local; only onCommit() reaches the existing workspace selection flow.
export function createDeck({ document, window, elements, onCommit, onOpenImports, onRetryCatalog, onOpenUnassigned }) {
  const { root, body, trail, rail, anchorSlot, status, prev, next, toggle, toggleLabel, path, foot } = elements;
  let catalog = null, catalogError = '', browse = { level: 'authors', authorId: null, seriesId: null };
  let open = false, initialized = false, pending = null, frame = 0;
  const scrollMemory = new Map(), running = new Set(), ghosts = new Set();
  const ghostLayer = document.createElement('div');
  ghostLayer.className = 'deck-ghosts'; ghostLayer.setAttribute('aria-hidden', 'true');
  document.body.append(ghostLayer);

  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  function icon(name, cls = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', SPRITE + name); svg.append(use); return svg;
  }

  // ---- Motion bookkeeping: every effect can be cancelled, nothing blocks input. ----
  function track(animation) {
    running.add(animation);
    animation.finished.catch(() => {}).then(() => running.delete(animation));
    return animation;
  }
  function settle() {
    for (const animation of running) animation.cancel();
    running.clear();
    for (const ghost of ghosts) ghost.remove();
    ghosts.clear();
  }
  function canAnimate(el) { return typeof el?.animate === 'function'; }

  function flip(el, from, arc) {
    if (!canAnimate(el) || !from) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = from.left - to.left, dy = from.top - to.top, sx = from.width / to.width, sy = from.height / to.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01) return;
    el.style.transformOrigin = '0 0';
    const animation = track(el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: `translate(${dx * .42}px, ${dy * .42 - arc}px) scale(${(sx + 1) / 2}, ${(sy + 1) / 2})`, offset: .5 },
      { transform: 'none' }
    ], { duration: DIVE_MS, easing: EASE_OUT }));
    animation.finished.catch(() => {}).then(() => { el.style.transformOrigin = ''; });
  }

  function leaveAsGhosts(buttons) {
    const viewport = rail.getBoundingClientRect();
    buttons.slice(0, 14).forEach((button, index) => {
      const rect = button.getBoundingClientRect();
      if (!rect.width || rect.right < viewport.left || rect.left > viewport.right) return;
      const ghost = button.cloneNode(true);
      ghost.removeAttribute('id'); ghost.removeAttribute('aria-busy'); ghost.tabIndex = -1;
      ghost.classList.add('tcard-ghost');
      Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
      ghostLayer.append(ghost); ghosts.add(ghost);
      if (!canAnimate(ghost)) { ghost.remove(); ghosts.delete(ghost); return; }
      const animation = track(ghost.animate([
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'translateY(18px) scale(.94)' }
      ], { duration: LEAVE_MS, delay: Math.min(index, 5) * 18, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' }));
      animation.finished.catch(() => {}).then(() => { ghost.remove(); ghosts.delete(ghost); });
    });
  }

  function deal(buttons, skip) {
    if (!buttons.length) return;
    if (reduced()) { buttons.forEach(button => canAnimate(button) && track(button.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS }))); return; }
    buttons.filter(button => button !== skip).slice(0, 10).forEach((button, index) => {
      if (!canAnimate(button)) return;
      track(button.animate([
        { opacity: 0, transform: 'translateY(14px) scale(.96)' },
        { opacity: 1, transform: 'none' }
      ], { duration: DEAL_MS, delay: 90 + index * DEAL_STEP, easing: EASE_OUT, fill: 'backwards' }));
    });
  }

  // ---- Rendering ----
  function cardButton(item, extraClass = '') {
    const button = node('button', 'tcard tcard--' + item.level + extraClass);
    button.type = 'button'; button.dataset.level = item.level; button.dataset.id = item.id;
    const numeral = node('span', 'tcard-numeral', LEVEL_NUMERALS[item.level]); numeral.setAttribute('aria-hidden', 'true');
    const emblem = node('span', 'tcard-emblem'); emblem.append(icon('emblem-' + item.level, 'tcard-glyph'));
    const name = node('span', 'tcard-name', item.name);
    const meta = node('span', 'tcard-meta', item.meta);
    button.append(numeral, emblem, name, meta);
    if (item.current) { button.classList.add('is-current'); button.append(node('span', 'tcard-mark', 'Открыта сейчас')); }
    if (item.empty) button.classList.add('is-empty');
    if (pending && item.level === 'books' && pending.bookId === item.id) button.setAttribute('aria-busy', 'true');
    return button;
  }

  function emptyRow(title, copy, actionLabel, action) {
    const li = node('li', 'deck-empty');
    li.append(node('strong', '', title), node('span', '', copy));
    if (actionLabel) { const b = node('button', 'button button-quiet', actionLabel); b.type = 'button'; b.dataset.focusKey = 'empty-action'; b.addEventListener('click', action); li.append(b); }
    return li;
  }

  function renderTrail(view) {
    const list = node('ol', 'deck-trail-list');
    const crumb = (label, level, current, numeral) => {
      const li = node('li');
      const b = node('button', 'deck-crumb', ''); b.type = 'button';
      if (numeral) { const n = node('span', 'deck-crumb-numeral', numeral); n.setAttribute('aria-hidden', 'true'); b.append(n); }
      b.append(node('span', 'deck-crumb-label', label));
      if (current) b.setAttribute('aria-current', 'location');
      b.dataset.focusKey = 'trail-' + level;
      b.addEventListener('click', () => ascendTo(level));
      li.append(b); list.append(li);
    };
    crumb('Авторы', 'authors', view.browse.level === 'authors');
    if (view.author) crumb(view.author.name || 'Автор', 'series', view.browse.level === 'series', LEVEL_NUMERALS.authors);
    if (view.series) crumb(view.series.name || 'Серия', 'books', view.browse.level === 'books', LEVEL_NUMERALS.series);
    trail.replaceChildren(list);
  }

  function renderPath() {
    const confirmed = confirmedPath(catalog);
    const list = node('ol', 'book-path-list');
    const crumb = (level, label, target) => {
      const li = node('li', 'book-path-step book-path-' + level);
      const b = node('button', 'book-path-button'); b.type = 'button';
      const numeral = node('span', 'book-path-numeral', LEVEL_NUMERALS[level]); numeral.setAttribute('aria-hidden', 'true');
      b.append(numeral, node('span', 'book-path-label', label));
      b.setAttribute('aria-label', LEVEL_NAMES[level] + ': ' + label + '. Показать выбор');
      b.dataset.focusKey = 'path-' + level;
      b.addEventListener('click', () => openAt(target, confirmed));
      li.append(b); list.append(li);
    };
    if (confirmed.author) crumb('authors', confirmed.author.name || 'Автор', 'authors');
    if (confirmed.series) crumb('series', confirmed.series.name || 'Серия', 'series');
    if (confirmed.book) crumb('books', confirmed.book.name || 'Книга', 'books');
    else if (confirmed.emptySeries) crumb('books', 'Без книги', 'books');
    if (!list.childNodes.length) {
      const li = node('li', 'book-path-step book-path-none');
      li.append(node('span', 'book-path-label', catalogError ? 'Каталог недоступен' : catalog ? 'Книга не выбрана' : 'Загружаю каталог…'));
      list.append(li);
    }
    path.replaceChildren(list);
    path.classList.toggle('has-book', !!confirmed.book || confirmed.emptySeries);
  }

  function renderFoot(view) {
    foot.replaceChildren();
    const count = Number(catalog?.unassigned?.cardCount) || 0;
    if (view.browse.level === 'authors' && count > 0) {
      foot.append(node('span', '', 'Записей без привязки к автору: ' + count + '.'));
      const b = node('button', 'text-action', 'Открыть в базе знаний'); b.type = 'button'; b.addEventListener('click', () => onOpenUnassigned?.()); foot.append(b);
    }
    foot.hidden = !foot.childNodes.length;
  }

  // Re-rendering must not drop keyboard focus: remember what was focused by a stable key.
  function focusKeyOf(element) {
    if (!element || !(root.contains(element) || path.contains(element))) return null;
    if (anchorSlot.contains(element)) return 'anchor';
    if (element.dataset?.focusKey) return element.dataset.focusKey;
    return element.dataset?.id ? 'card-' + element.dataset.id : null;
  }
  function restoreFocusKey(key) {
    if (!key) return;
    let target = null;
    if (key === 'anchor') target = anchorSlot.querySelector('.tcard');
    else if (key.startsWith('card-')) target = rail.querySelector(`[data-id="${CSS.escape(key.slice(5))}"]`);
    else target = root.querySelector(`[data-focus-key="${key}"]`) || path.querySelector(`[data-focus-key="${key}"]`);
    target?.focus({ preventScroll: true });
  }

  function render() {
    const focusKey = focusKeyOf(document.activeElement);
    const view = levelView(catalog, browse);
    browse = view.browse;
    root.dataset.level = browse.level;
    rail.setAttribute('aria-label', LEVEL_LIST_LABELS[browse.level]);
    renderTrail(view); renderFoot(view);
    anchorSlot.replaceChildren();
    if (view.anchor) {
      const anchor = cardButton({ ...view.anchor, current: false }, ' tcard--anchor');
      anchor.id = 'deck-anchor-card';
      const back = parentLevel(browse.level);
      anchor.append(node('span', 'tcard-return', back === 'authors' ? 'К авторам' : 'К сериям'));
      anchor.prepend(icon('return', 'tcard-return-icon'));
      anchor.setAttribute('aria-label', LEVEL_NAMES[view.anchor.level] + ': ' + view.anchor.name + '. Вернуться к списку: ' + LEVEL_LIST_LABELS[back].toLocaleLowerCase('ru'));
      anchor.addEventListener('click', () => ascendTo(back));
      anchorSlot.append(anchor);
    }
    const items = [];
    if (catalogError && !catalog) items.push(emptyRow('Каталог книг недоступен', catalogError, 'Повторить загрузку', () => onRetryCatalog?.()));
    else if (!catalog) items.push(emptyRow('Загружаю каталог', 'Получаю авторов, серии и книги с сервера.'));
    else if (!view.items.length) {
      if (browse.level === 'authors') items.push(emptyRow('Авторов пока нет', 'Создайте базу серии из книг, чтобы автор и серия появились здесь.', 'Импорт книг', () => onOpenImports?.()));
      if (browse.level === 'series') items.push(emptyRow('У автора пока нет серий', 'Выберите другого автора или создайте базу серии через импорт.', 'Импорт книг', () => onOpenImports?.()));
      if (browse.level === 'books') {
        const ids = emptySeriesCommit(catalog, browse);
        const opened = ids && sameSelection(catalog, ids);
        items.push(emptyRow('В серии пока нет книг', opened ? 'Серия уже открыта как рабочая область. Черновики и заметки будут относиться к ней.' : 'Серию можно открыть как рабочую область без книги: черновики и заметки будут привязаны к ней.',
          ids && !opened ? 'Открыть серию без книги' : '', () => ids && commit(ids, null, view.series?.name || 'серию')));
      }
    } else view.items.forEach(item => { const li = node('li', 'deck-slot'); const b = cardButton(item); b.addEventListener('click', () => choose(item, b)); li.append(b); items.push(li); });
    rail.replaceChildren(...items);
    rail.classList.toggle('is-single', view.items.length === 1);
    renderPath();
    restoreFocusKey(focusKey);
    queueArrows();
    return view;
  }

  // ---- Scrolling ----
  function queueArrows() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const max = rail.scrollWidth - rail.clientWidth;
      prev.disabled = rail.scrollLeft <= 2; next.disabled = rail.scrollLeft >= max - 2;
      root.classList.toggle('has-overflow', max > 2);
    });
  }
  function restoreScroll(focusId) {
    const remembered = scrollMemory.get(scrollKey(browse));
    if (remembered !== undefined) rail.scrollLeft = remembered;
    else {
      rail.scrollLeft = 0;
      const current = rail.querySelector('.tcard.is-current');
      if (current) reveal(current);
    }
    if (focusId) { const target = rail.querySelector(`[data-id="${CSS.escape(focusId)}"]`); if (target) reveal(target); }
    queueArrows();
  }
  function reveal(button) {
    const r = button.getBoundingClientRect(), v = rail.getBoundingClientRect();
    if (r.left < v.left) rail.scrollLeft -= v.left - r.left + 16;
    else if (r.right > v.right) rail.scrollLeft += r.right - v.right + 16;
  }
  function page(direction) {
    rail.scrollBy({ left: direction * Math.max(160, rail.clientWidth * .8), behavior: reduced() ? 'auto' : 'smooth' });
  }

  // ---- Navigation ----
  function focusCard(id) {
    const target = (id && rail.querySelector(`[data-id="${CSS.escape(id)}"]`)) || rail.querySelector('.tcard.is-current') || rail.querySelector('.tcard') || rail.querySelector('.deck-empty button') || anchorSlot.querySelector('.tcard');
    target?.focus({ preventScroll: true });
    if (target && rail.contains(target)) reveal(target);
  }

  function choose(item, button) {
    const result = activate(catalog, browse, item.id);
    if (result.kind === 'commit') { commit(result.ids, button, item.name); return; }
    if (result.kind !== 'browse') { say('Этот элемент больше не найден в каталоге. Список обновлён.'); render(); return; }
    settle();
    const from = button.getBoundingClientRect();
    const siblings = [...rail.querySelectorAll('.tcard')].filter(b => b !== button);
    const motion = !reduced();
    if (motion) leaveAsGhosts(siblings);
    browse = result.browse;
    const view = render();
    restoreScroll();
    const anchor = anchorSlot.querySelector('.tcard');
    if (motion) flip(anchor, from, 18);
    deal([...rail.querySelectorAll('.tcard')]);
    focusCard();
    say(LEVEL_LIST_LABELS[view.browse.level] + ': ' + view.items.length + (view.items.length ? '' : '. Список пуст'));
  }

  function ascendTo(level) {
    if (!level || level === browse.level) { focusCard(); return; }
    settle();
    const before = levelView(catalog, browse);
    const anchor = anchorSlot.querySelector('.tcard');
    const from = anchor?.getBoundingClientRect();
    const returningTo = level === 'authors' ? browse.authorId : level === 'series' ? browse.seriesId : null;
    const motion = !reduced();
    if (motion) leaveAsGhosts([...rail.querySelectorAll('.tcard')]);
    browse = browseAt(catalog, level, browse);
    render();
    restoreScroll(returningTo);
    const target = returningTo && rail.querySelector(`[data-id="${CSS.escape(returningTo)}"]`);
    // Only the card the author came from travels back; it keeps its identity on screen.
    if (motion && target && before.anchor?.id === returningTo) flip(target, from, -10);
    deal([...rail.querySelectorAll('.tcard')], target);
    focusCard(returningTo);
    say(LEVEL_LIST_LABELS[browse.level]);
  }

  async function commit(ids, button, label) {
    if (pending) { say('Книга уже открывается. Дождитесь результата.'); return; }
    if (sameSelection(catalog, ids) && hasConfirmedWorkspace(catalog)) { say('Эта область уже открыта.'); setOpen(false, { focusToggle: true }); return; }
    pending = ids;
    button?.setAttribute('aria-busy', 'true');
    root.classList.add('is-committing');
    say('Открываю: ' + label + '…');
    let result;
    try { result = await onCommit(ids); } catch (error) { result = { ok: false, error: error?.message }; }
    pending = null;
    root.classList.remove('is-committing');
    rail.querySelectorAll('[aria-busy]').forEach(b => b.removeAttribute('aria-busy'));
    if (result?.ok) {
      browse = initialBrowse(catalog);
      render(); restoreScroll();
      say('Открыто: ' + label + '.');
      const active = document.activeElement;
      setOpen(false, { focusToggle: !active || active === document.body || root.contains(active) });
    } else say(result?.error || 'Не удалось открыть выбранную область. Текущая книга не изменилась.', true);
  }

  function say(message, error = false) {
    status.classList.toggle('is-error', error);
    status.textContent = '';
    window.requestAnimationFrame(() => { status.textContent = message; });
  }

  // ---- Open / close ----
  function setOpen(value, { focusToggle = false, focusRail = false } = {}) {
    open = value;
    root.dataset.open = String(value);
    body.inert = !value;
    toggle.setAttribute('aria-expanded', String(value));
    toggleLabel.textContent = value ? 'Свернуть выбор' : hasConfirmedWorkspace(catalog) ? 'Сменить книгу' : 'Выбрать книгу';
    if (!value) { settle(); if (focusToggle) toggle.focus({ preventScroll: true }); }
    else { restoreScroll(); if (focusRail) focusCard(); }
  }

  function openAt(level, confirmed) {
    settle();
    const ids = { authorId: confirmed?.author?.id, seriesId: confirmed?.series?.id };
    browse = browseAt(catalog, level, ids);
    render();
    const focusId = level === 'authors' ? ids.authorId : level === 'series' ? ids.seriesId : confirmed?.book?.id;
    setOpen(true);
    restoreScroll(focusId);
    focusCard(focusId);
    if (!reduced()) deal([...rail.querySelectorAll('.tcard')]);
  }

  // ---- Events ----
  toggle.addEventListener('click', () => {
    if (open) setOpen(false, { focusToggle: true });
    else { browse = reconcileBrowse(catalog, browse); render(); setOpen(true, { focusRail: true }); }
  });
  prev.addEventListener('click', () => page(-1));
  next.addEventListener('click', () => page(1));
  rail.addEventListener('scroll', () => { scrollMemory.set(scrollKey(browse), rail.scrollLeft); queueArrows(); }, { passive: true });
  window.addEventListener('resize', queueArrows, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open && hasConfirmedWorkspace(catalog)) { event.preventDefault(); setOpen(false, { focusToggle: true }); return; }
    const card = event.target.closest?.('.tcard');
    if (!card) return;
    if (event.key === 'Backspace' && parentLevel(browse.level)) { event.preventDefault(); ascendTo(parentLevel(browse.level)); return; }
    if (!rail.contains(card)) return;
    const cards = [...rail.querySelectorAll('.tcard')], index = cards.indexOf(card);
    let target = null;
    if (event.key === 'ArrowRight') target = cards[index + 1];
    if (event.key === 'ArrowLeft') target = index > 0 ? cards[index - 1] : anchorSlot.querySelector('.tcard');
    if (event.key === 'Home') target = cards[0];
    if (event.key === 'End') target = cards.at(-1);
    if (target) { event.preventDefault(); target.focus({ preventScroll: true }); if (rail.contains(target)) reveal(target); }
  });
  anchorSlot.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { const first = rail.querySelector('.tcard'); if (first) { event.preventDefault(); first.focus({ preventScroll: true }); reveal(first); } }
  });

  render();
  root.dataset.open = 'false'; body.inert = true;

  return {
    update(nextCatalog, { error = '' } = {}) {
      if (nextCatalog) catalog = nextCatalog;
      catalogError = error || '';
      if (!initialized && (catalog || catalogError)) {
        initialized = true;
        browse = initialBrowse(catalog);
        render();
        setOpen(!hasConfirmedWorkspace(catalog));
        return;
      }
      browse = reconcileBrowse(catalog, browse);
      render();
      if (!open) toggleLabel.textContent = hasConfirmedWorkspace(catalog) ? 'Сменить книгу' : 'Выбрать книгу';
    },
    open(level) { openAt(level || browse.level, confirmedPath(catalog)); },
    close() { setOpen(false); },
    isOpen: () => open
  };
}
