// Colour theme: applied before first paint (classic script in <head>), picker added to the masthead once the DOM is ready.
(() => {
  const KEY = 'talewisp.theme';
  const THEMES = [
    { id: 'night', name: 'Ночная арка', note: 'глубокая ночь, золото', sw: ['#0d0b18', '#cea661', '#a0c0e9'] },
    { id: 'grimoire', name: 'Изумрудный гримуар', note: 'хвоя и латунь', sw: ['#0b1512', '#c9a24c', '#9fe0c4'] },
    { id: 'oxblood', name: 'Бордо и сургуч', note: 'винный бархат', sw: ['#1a0d10', '#d9a07a', '#f2b8a8'] },
    { id: 'moon', name: 'Лунное серебро', note: 'графит и серебро', sw: ['#0e1419', '#c8d3de', '#8fdbe8'] },
    { id: 'obsidian', name: 'Обсидиан и медь', note: 'строгий нейтральный', sw: ['#111012', '#e08a4f', '#ffc58a'] },
    { id: 'parchment', name: 'Старый пергамент', note: 'светлая', sw: ['#f3ead8', '#a8741f', '#2f5d8a'] },
    { id: 'scifi', name: 'Sci-fi', note: 'карбон, голубое свечение', sw: ['#07090c', '#3fc8ff', '#5fe1ff'] },
    { id: 'hitech', name: 'Hi-tech', note: 'сталь, оранжевое свечение', sw: ['#1a1c1f', '#ff7a1a', '#f4f6f8'] },
    { id: 'wasteland', name: 'Пустошь', note: 'пост-апокалипсис: ржавчина и пыль', sw: ['#16130f', '#c8662e', '#b5d65a'] },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id);

  function read() { try { return localStorage.getItem(KEY); } catch { return null; } }
  function write(id) { try { localStorage.setItem(KEY, id); } catch { /* private mode: theme lasts for this page only */ } }

  function apply(id) {
    const theme = byId(id) || THEMES[0];
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    const light = theme.id === 'parchment';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', light ? 'light' : 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.sw[0]);
    window.dispatchEvent(new CustomEvent('talewisp:themechange', { detail: { theme: theme.id } }));
    return theme;
  }

  apply(read());

  function buildPicker() {
    const host = document.querySelector('.masthead-actions');
    if (!host || host.querySelector('.theme-picker')) return;
    const wrap = document.createElement('div');
    wrap.className = 'theme-picker';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'theme-picker-toggle';
    toggle.id = 'theme-picker-toggle';
    toggle.title = 'Тема оформления';
    toggle.setAttribute('aria-label', 'Тема оформления');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'theme-menu');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'theme-menu';
    menu.id = 'theme-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Тема оформления');
    menu.hidden = true;
    const title = document.createElement('div');
    title.className = 'theme-menu-title';
    title.textContent = 'Тема';
    menu.append(title);

    const options = THEMES.map((theme) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'theme-option';
      option.dataset.theme = theme.id;
      option.setAttribute('role', 'menuitemradio');
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      for (const colour of theme.sw) { const dot = document.createElement('i'); dot.style.background = colour; swatch.append(dot); }
      const label = document.createElement('span');
      label.textContent = theme.name;
      const note = document.createElement('small');
      note.textContent = theme.note;
      label.append(note);
      option.append(swatch, label);
      option.addEventListener('click', () => { write(apply(theme.id).id); sync(); close(true); });
      menu.append(option);
      return option;
    });

    function sync() {
      const current = document.documentElement.dataset.theme;
      for (const option of options) option.setAttribute('aria-checked', String(option.dataset.theme === current));
    }
    function open() {
      sync();
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      (options.find((o) => o.getAttribute('aria-checked') === 'true') || options[0]).focus();
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (refocus) toggle.focus();
    }

    toggle.addEventListener('click', () => (menu.hidden ? open() : close(false)));
    menu.addEventListener('keydown', (event) => {
      const index = options.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); options[(index + 1) % options.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); options[(index - 1 + options.length) % options.length].focus(); }
    });
    document.addEventListener('click', (event) => { if (!wrap.contains(event.target)) close(false); });

    wrap.append(toggle, menu);
    host.prepend(wrap);
  }

  // Another tab changed the theme.
  window.addEventListener('storage', (event) => { if (event.key === KEY) apply(event.newValue); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPicker, { once: true });
  else buildPicker();
})();
