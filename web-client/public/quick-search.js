// Quick search (Ctrl+K / Cmd+K): one field over the knowledge cards of the open series.
// The module owns the dialog and keyboard handling; the app supplies the search call and what
// opening a result means. Pure logic lives in createQuickSearchModel so it can be tested without a DOM.

export function createQuickSearchModel({ search, debounceMs = 180, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
  const state = { query: '', results: [], active: 0, status: 'idle', matched: 0 };
  let timer = null, request = 0;
  const emit = () => onChange({ ...state });
  async function run(query, token) {
    try {
      const data = await search(query);
      if (token !== request) return;
      state.results = Array.isArray(data?.cards) ? data.cards.slice(0, 20) : [];
      state.matched = Number.isInteger(data?.matchedCount) ? data.matchedCount : state.results.length;
      state.active = 0; state.status = state.results.length ? 'ready' : 'empty';
    } catch (error) {
      if (token !== request) return;
      state.results = []; state.matched = 0; state.active = 0; state.status = 'error'; state.error = error?.message || 'Поиск не удался.';
    }
    emit();
  }
  function setQuery(value) {
    state.query = String(value ?? '');
    const query = state.query.trim(), token = ++request;
    if (timer !== null) clearTimer(timer); timer = null;
    if (query.length < 2) { state.results = []; state.matched = 0; state.active = 0; state.status = 'idle'; emit(); return; }
    state.status = 'loading'; emit();
    timer = setTimer(() => { timer = null; run(query, token); }, debounceMs);
  }
  function move(step) {
    if (!state.results.length) return;
    state.active = (state.active + step + state.results.length) % state.results.length; emit();
  }
  const current = () => state.results[state.active] ?? null;
  function reset() { request++; if (timer !== null) clearTimer(timer); timer = null; Object.assign(state, { query: '', results: [], active: 0, status: 'idle', matched: 0 }); emit(); }
  return { setQuery, move, current, reset, snapshot: () => ({ ...state }) };
}

const TYPE_LABELS = { character: 'Персонаж', location: 'Место', event: 'Событие', note: 'Заметка', book: 'Книга', passport: 'Паспорт', rule: 'Правило', thread: 'Линия' };

export function createQuickSearch({ document, search, open, isAvailable = () => true }) {
  const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const dialog = make('dialog', 'quick-search');
  dialog.setAttribute('aria-label', 'Поиск по базе знаний');
  const input = make('input', 'quick-search-input');
  input.type = 'search'; input.placeholder = 'Найти персонажа, место, главу или заметку…'; input.autocomplete = 'off'; input.spellcheck = false;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', 'quick-search-list'); input.setAttribute('aria-autocomplete', 'list');
  const status = make('div', 'quick-search-status'); status.setAttribute('role', 'status');
  const list = make('ul', 'quick-search-list'); list.id = 'quick-search-list'; list.setAttribute('role', 'listbox');
  const hint = make('div', 'quick-search-hint', '↑ ↓ выбрать · Enter открыть · Esc закрыть');
  dialog.append(input, status, list, hint);

  function render(state) {
    const messages = { idle: state.query.trim().length ? 'Введите хотя бы два символа.' : 'Поиск идёт по карточкам открытой серии.', loading: 'Ищу…', empty: 'Ничего не найдено.', error: state.error, ready: state.matched > state.results.length ? `Показано ${state.results.length} из ${state.matched}. Уточните запрос.` : '' };
    status.textContent = messages[state.status] ?? ''; status.hidden = !status.textContent;
    status.classList.toggle('error', state.status === 'error');
    list.replaceChildren(...state.results.map((card, index) => {
      const item = make('li', 'quick-search-item' + (index === state.active ? ' active' : ''));
      item.id = `quick-search-option-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === state.active));
      const head = make('div', 'quick-search-item-head');
      head.append(make('span', 'quick-search-title', card.title || card.path), make('span', 'quick-search-type', TYPE_LABELS[card.type] || card.type || ''));
      item.append(head, make('div', 'quick-search-path', card.path));
      if (card.excerpt) item.append(make('div', 'quick-search-excerpt', card.excerpt.slice(0, 160)));
      item.addEventListener('mousemove', () => { if (model.snapshot().active !== index) model.move(index - model.snapshot().active); });
      item.addEventListener('click', () => choose(card));
      return item;
    }));
    input.setAttribute('aria-expanded', String(state.results.length > 0));
    if (state.results.length) input.setAttribute('aria-activedescendant', `quick-search-option-${state.active}`); else input.removeAttribute('aria-activedescendant');
    list.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  }
  const model = createQuickSearchModel({ search, onChange: render });
  function close() { if (dialog.open) dialog.close(); }
  function choose(card) { if (!card) return; close(); open(card); }
  function show() {
    if (dialog.open || !isAvailable()) return;
    if (!dialog.isConnected) document.body.append(dialog);
    model.reset(); input.value = ''; dialog.showModal(); input.focus();
  }
  input.addEventListener('input', () => model.setQuery(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); model.move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); model.move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(model.current()); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  const onKey = event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 'k' || event.key === 'K' || event.key === 'л' || event.key === 'Л')) { event.preventDefault(); if (dialog.open) close(); else show(); }
  };
  document.addEventListener('keydown', onKey);
  return { show, close, destroy: () => { document.removeEventListener('keydown', onKey); close(); dialog.remove(); } };
}
