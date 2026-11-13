// Sample page: every component in the chosen style and palette. Reads the same tokens as the client.
const api = window.TaleWispThemes;
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const svg = (tag, attrs = {}) => { const node = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };

function choices(host, items, isCurrent, choose) {
  const buttons = items.map(item => {
    const button = el('button', 'sg-choice');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    if (item.sw) { const swatch = el('span', 'theme-swatch'); for (const colour of item.sw) { const dot = el('i'); dot.style.background = colour; swatch.append(dot); } button.append(swatch); }
    button.append(el('span', '', item.name));
    button.title = item.note || '';
    button.addEventListener('click', () => { choose(item.id); sync(); });
    host.append(button);
    return [item, button];
  });
  const sync = () => { for (const [item, button] of buttons) button.setAttribute('aria-checked', String(isCurrent(item.id))); };
  sync();
  return sync;
}

function cards(host) {
  const samples = [['I', 'author', 'Анна Вересова', '2 серии'], ['II', 'series', 'Хроники перевала', '3 книги'], ['III', 'book', 'Зимняя тропа', '14 глав', true], ['III', 'book', 'Долгая вода', 'черновик']];
  for (const [numeral, level, name, meta, current] of samples) {
    const item = el('li');
    const card = el('button', `tcard tcard--${level}${current ? ' is-current' : ''}`);
    card.type = 'button';
    const emblem = el('span', 'tcard-emblem');
    const glyph = svg('svg', { class: 'tcard-glyph', 'aria-hidden': 'true' });
    glyph.append(svg('use', { href: `/assets/icons/tarot-sprite.svg#emblem-${level}` }));
    emblem.append(glyph);
    card.append(el('span', 'tcard-numeral', numeral), emblem, el('span', 'tcard-name', name), el('span', 'tcard-meta', meta));
    if (current) card.append(el('span', 'tcard-mark', 'Открыта сейчас'));
    item.append(card);
    host.append(item);
  }
}

// A small map drawn from the same --cm-* tokens the real concept map reads.
function drawMap(host) {
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const number = (name, fallback) => { const value = Number.parseFloat(token(name, '')); return Number.isFinite(value) ? value : fallback; };
  const sketch = number('--cm-sketch', 1), shape = token('--cm-node', 'ellipse'), edge = token('--cm-edge', 'curve'), echo = number('--cm-echo', 0);
  const hue = number('--cm-hue-lock', 250), fill = `hsl(${hue} ${number('--cm-fill-s', 30)}% ${number('--cm-fill-l', 19)}%)`, stroke = `hsl(${hue} ${number('--cm-stroke-s', 42)}% ${number('--cm-stroke-l', 66)}%)`;
  const ink = token('--cm-ink', '#ddd'), coreFill = token('--cm-core-fill', '#222'), coreStroke = token('--cm-core-stroke', '#ca6');
  let seed = 7; const jitter = () => { seed = (seed * 16807) % 2147483647; return ((seed / 2147483647) - .5) * 2 * sketch * 1.6; };
  const root = svg('svg', { viewBox: '0 0 900 300', preserveAspectRatio: 'xMidYMid meet' });
  const nodes = [{ x: 450, y: 150, w: 170, h: 62, label: 'Зимняя тропа', core: true }, { x: 170, y: 80, w: 140, h: 48, label: 'Марта' }, { x: 170, y: 225, w: 140, h: 48, label: 'Перевал' }, { x: 735, y: 80, w: 150, h: 48, label: 'Архив' }, { x: 735, y: 225, w: 150, h: 48, label: 'Ключ' }];
  const outline = (n, pad = 0) => {
    const w = n.w / 2 + pad, h = n.h / 2 + pad, x = n.x, y = n.y, j = jitter;
    if (shape === 'rect') return `M${x - w + j()} ${y - h + j()}L${x + w + j()} ${y - h + j()}L${x + w + j()} ${y + h + j()}L${x - w + j()} ${y + h + j()}Z`;
    if (shape === 'chamfer') { const c = 12; return `M${x - w + c} ${y - h + j()}L${x + w - c} ${y - h + j()}L${x + w + j()} ${y - h + c}L${x + w + j()} ${y + h - c}L${x + w - c} ${y + h + j()}L${x - w + c} ${y + h + j()}L${x - w + j()} ${y + h - c}L${x - w + j()} ${y - h + c}Z`; }
    if (shape === 'plate') { const r = 14; return `M${x - w + r} ${y - h}H${x + w - r}Q${x + w} ${y - h} ${x + w} ${y - h + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x - w + r}Q${x - w} ${y + h} ${x - w} ${y + h - r}V${y - h + r}Q${x - w} ${y - h} ${x - w + r} ${y - h}Z`; }
    if (shape === 'arch') return `M${x - w} ${y + h}V${y - h * .2}Q${x - w} ${y - h} ${x} ${y - h * 1.15}Q${x + w} ${y - h} ${x + w} ${y - h * .2}V${y + h}Z`;
    const k = .5523; return `M${x - w + j()} ${y + j()}C${x - w} ${y - h * k} ${x - w * k} ${y - h + j()} ${x + j()} ${y - h + j()}C${x + w * k} ${y - h} ${x + w} ${y - h * k} ${x + w + j()} ${y + j()}C${x + w} ${y + h * k} ${x + w * k} ${y + h + j()} ${x + j()} ${y + h + j()}C${x - w * k} ${y + h} ${x - w} ${y + h * k} ${x - w + j()} ${y + j()}Z`;
  };
  const core = nodes[0];
  for (const n of nodes.slice(1)) {
    const fromX = core.x + Math.sign(n.x - core.x) * core.w / 2, toX = n.x - Math.sign(n.x - core.x) * n.w / 2, mid = (fromX + toX) / 2;
    const d = edge === 'straight' ? `M${fromX} ${core.y}L${toX} ${n.y}` : edge === 'elbow' ? `M${fromX} ${core.y}H${mid}V${n.y}H${toX}` : `M${fromX} ${core.y + jitter()}C${mid} ${core.y + jitter()} ${mid} ${n.y + jitter()} ${toX} ${n.y + jitter()}`;
    root.append(svg('path', { d, fill: 'none', stroke, 'stroke-width': 2, class: 'cm-map-edge cm-map-edge-main' }));
  }
  for (const n of nodes) {
    const group = svg('g', { class: `cm-map-node${n.core ? ' cm-map-core' : ''}` });
    if (echo) group.append(svg('path', { d: outline(n, 4), fill: 'none', stroke: n.core ? coreStroke : stroke, 'stroke-width': 1, opacity: .5, class: 'cm-map-contour-echo' }));
    group.append(svg('path', { d: outline(n), fill: n.core ? coreFill : fill, stroke: n.core ? coreStroke : stroke, 'stroke-width': n.core ? 2.4 : 1.8, class: 'cm-map-sketch-shape' }));
    const label = svg('text', { x: n.x, y: n.y, fill: ink }); label.textContent = n.label; group.append(label);
    root.append(group);
  }
  host.replaceChildren(root);
}

if (api) {
  const syncStyles = choices(document.getElementById('sg-styles'), api.styles, id => api.current().styleChoice === id, id => api.setStyle(id));
  const syncPalettes = choices(document.getElementById('sg-palettes'), api.themes, id => api.current().theme === id, id => api.setTheme(id));
  cards(document.getElementById('sg-cards'));
  const map = document.getElementById('sg-map');
  const redraw = () => { syncStyles(); syncPalettes(); requestAnimationFrame(() => drawMap(map)); };
  window.addEventListener('talewisp:themechange', redraw);
  redraw();
}
