import { createConceptMap } from './concept-map.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = { character: '#83a9df', event: '#d7a86b', location: '#82b8a1', world: '#b49bd2', plot: '#df8c89', default: '#8f9eb4' };

const normalized = value => String(value ?? '').toLocaleLowerCase('ru');
const el = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
};
const svg = (tag, attrs = {}) => {
  const item = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  return item;
};

export function buildKnowledgeTree(graph) {
  const groups = new Map((graph?.groups || []).map(group => [group.id, { ...group, children: [], records: [] }]));
  const roots = [];
  for (const group of groups.values()) {
    const parent = groups.get(group.parentId);
    (parent ? parent.children : roots).push(group);
  }
  const byPath = new Map();
  for (const record of graph?.nodes || []) {
    const leaf = { ...record, children: [], records: [] };
    (groups.get(record.groupId)?.records || roots).push(leaf);
    byPath.set(record.path, leaf);
  }
  const sort = items => {
    items.sort((a, b) => normalized(a.label || a.title).localeCompare(normalized(b.label || b.title), 'ru'));
    items.forEach(item => { sort(item.children); sort(item.records); });
  };
  sort(roots);
  return { roots, byPath };
}

export function filterKnowledgePaths(graph, query, type = '') {
  const q = normalized(query).trim();
  return new Set((graph?.nodes || []).filter(node => (!type || node.type === type) && (!q || [node.title, node.path, node.type, node.status].some(value => normalized(value).includes(q)))).map(node => node.path));
}

export function knowledgeNeighbors(graph, path) {
  const result = new Set();
  if (!path) return result;
  for (const edge of graph?.edges || []) {
    if (edge.source === path) result.add(edge.target);
    if (edge.target === path) result.add(edge.source);
  }
  return result;
}

export function layoutKnowledgeGraph(graph) {
  const nodes = graph?.nodes || [];
  const { roots } = buildKnowledgeTree(graph);
  const groups = new Map((graph?.groups || []).map(group => [group.id, group]));
  const clusterFor = node => {
    let group = groups.get(node.groupId);
    while (group?.parentId && groups.has(group.parentId)) group = groups.get(group.parentId);
    return group?.id || 'ungrouped';
  };
  const clusterKeys = [...new Set(nodes.map(clusterFor))].sort();
  const width = Math.max(1100, Math.ceil(Math.sqrt(nodes.length || 1) * 205));
  const height = Math.max(760, Math.ceil((nodes.length || 1) / Math.max(1, clusterKeys.length) * 120));
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusterKeys.length)));
  const cellW = width / columns, rows = Math.max(1, Math.ceil(clusterKeys.length / columns));
  const cellH = height / rows;
  const clusterPositions = new Map(clusterKeys.map((key, index) => [key, { x: cellW * (index % columns + .5), y: cellH * (Math.floor(index / columns) + .5) }]));
  const members = new Map();
  nodes.forEach(node => { const key = clusterFor(node); if (!members.has(key)) members.set(key, []); members.get(key).push(node); });
  const positions = new Map();
  for (const [key, items] of members) {
    items.sort((a, b) => a.path.localeCompare(b.path));
    const center = clusterPositions.get(key);
    const radius = Math.min(cellW, cellH) * Math.min(.39, .09 + Math.sqrt(items.length) * .045);
    items.forEach((item, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * (3 - Math.sqrt(5));
      const r = radius * Math.sqrt((index + .5) / items.length);
      positions.set(item.path, { x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r, group: key });
    });
  }
  return { width, height, positions, clusters: clusterPositions, clusterLabels: roots };
}

export function fitKnowledgeView(layout, viewportWidth, viewportHeight, paths = null) {
  if (!viewportWidth || !viewportHeight) return null;
  const points = paths ? [...paths].map(path => layout.positions.get(path)).filter(Boolean) : [...layout.positions.values()];
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  const minX = points.length ? Math.min(...xs) : 0, maxX = points.length ? Math.max(...xs) : layout.width;
  const minY = points.length ? Math.min(...ys) : 0, maxY = points.length ? Math.max(...ys) : layout.height;
  const pad = Math.max(105, Math.max(maxX - minX, maxY - minY) * .12), aspect = viewportWidth / viewportHeight;
  let width = Math.max(360, maxX - minX + pad * 2), height = Math.max(300, maxY - minY + pad * 2);
  if (width / height < aspect) width = height * aspect; else height = width / aspect;
  return { x: (minX + maxX - width) / 2, y: (minY + maxY - height) / 2, width, height };
}

export function createKnowledgeMap({ container, graph, onSelect = () => {} }) {
  if (!container) throw new TypeError('container is required');
  if (graph?.mode === 'concepts') return createConceptMap({ container, graph, onSelect });
  const originalGraph = graph || { nodes: [], edges: [], groups: [] };
  const initialLayout = layoutKnowledgeGraph(originalGraph);
  const model = { graph: originalGraph, selected: '', query: '', type: '', expanded: new Set((originalGraph.groups || []).map(group => group.id)), view: { x: 0, y: 0, width: initialLayout.width, height: initialLayout.height }, fitWidth: initialLayout.width, dragging: false, didDrag: false, start: null, mobileTree: false };
  const root = el('section', 'km'); root.setAttribute('aria-label', 'Карта знаний');
  const head = el('div', 'km-head');
  const titleBlock = el('div', 'km-title'); titleBlock.append(el('span', 'km-kicker', originalGraph.scope === 'unassigned' ? 'БАЗА · БЕЗ ПРИВЯЗКИ' : 'КАРТА СВЯЗЕЙ'), el('h2', '', 'Карта знаний'), el('p', '', 'Выберите запись на схеме или в дереве, чтобы проследить её окружение.'));
  const toolbar = el('div', 'km-toolbar');
  const count = el('span', 'km-count'); count.setAttribute('aria-live', 'polite');
  const fitButton = el('button', 'km-tool', 'Вписать'); fitButton.type = 'button'; fitButton.setAttribute('aria-label', 'Вписать карту в область');
  const resetButton = el('button', 'km-tool', 'Сбросить фокус'); resetButton.type = 'button'; resetButton.setAttribute('aria-label', 'Сбросить выбор и вписать всю карту');
  const zoomOut = el('button', 'km-tool km-square', '−'); zoomOut.type = 'button'; zoomOut.setAttribute('aria-label', 'Уменьшить карту');
  const zoomLabel = el('span', 'km-zoom', '100%');
  const zoomIn = el('button', 'km-tool km-square', '+'); zoomIn.type = 'button'; zoomIn.setAttribute('aria-label', 'Увеличить карту');
  const treeToggle = el('button', 'km-tool km-mobile-toggle', 'Список записей'); treeToggle.type = 'button'; treeToggle.setAttribute('aria-expanded', 'false');
  toolbar.append(count, treeToggle, fitButton, resetButton, zoomOut, zoomLabel, zoomIn); head.append(titleBlock, toolbar);
  const notices = el('div', 'km-notices');
  const search = el('label', 'km-search'); search.append(el('span', '', 'Поиск записей')); const searchInput = el('input'); searchInput.type = 'search'; searchInput.placeholder = 'Название или путь'; searchInput.setAttribute('aria-label', 'Поиск по записям карты'); search.append(searchInput);
  const typeFilter = el('select'); typeFilter.setAttribute('aria-label', 'Фильтр по типу записи');
  [['', 'Все типы'], ['character', 'Персонажи'], ['event', 'События'], ['location', 'Места'], ['world', 'Мир'], ['plot', 'Сюжет']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; typeFilter.append(option); });
  const filterRow = el('div', 'km-filter-row'); filterRow.append(search, typeFilter);
  const layout = el('div', 'km-layout');
  const treePane = el('aside', 'km-tree-pane'); const treeSummary = el('div', 'km-tree-summary'); const tree = el('div', 'km-tree'); tree.setAttribute('role', 'tree'); treePane.append(treeSummary, tree);
  const mapPane = el('div', 'km-map-pane'); mapPane.setAttribute('aria-label', 'Схема связей');
  const stage = el('div', 'km-stage'); const canvas = svg('svg', { class: 'km-canvas', role: 'img', 'aria-label': 'Интерактивная карта связей записей' }); const content = svg('g', { class: 'km-content' }); canvas.append(content); stage.append(canvas); mapPane.append(stage);
  const legend = el('div', 'km-legend');
  Object.entries({ character: 'Персонажи', event: 'События', location: 'Места', world: 'Мир', plot: 'Сюжет', default: 'Прочее' }).forEach(([type, label]) => { const item = el('span', 'km-legend-item'); item.append(el('i', `km-dot km-${type}`), el('span', '', label)); legend.append(item); });
  layout.append(treePane, mapPane); root.append(head, notices, filterRow, layout, legend); container.replaceChildren(root);

  const treeModel = () => buildKnowledgeTree(model.graph);
  const visiblePaths = () => filterKnowledgePaths(model.graph, model.query, model.type);
  function setSelection(path, notify = false) {
    if (path && !model.graph.nodes.some(node => node.path === path)) return;
    model.selected = path || '';
    let groupId = model.graph.nodes.find(node => node.path === model.selected)?.groupId;
    const groups = new Map((model.graph.groups || []).map(group => [group.id, group]));
    while (groupId && groups.has(groupId)) { model.expanded.add(groupId); groupId = groups.get(groupId).parentId; }
    renderTree();
    if (model.selected) focusNode(model.selected); else renderMap();
    if (notify && model.selected) onSelect(model.graph.nodes.find(node => node.path === model.selected));
  }
  function renderNotices() {
    notices.replaceChildren();
    if (!model.graph.nodes.length) notices.append(el('div', 'km-notice', 'В этой области пока нет записей для карты.'));
    if (model.graph.truncated) notices.append(el('div', 'km-notice km-notice-warn', 'Показана ограниченная часть базы; связи за пределами списка могут отсутствовать.'));
    const unresolved = Number(model.graph.unresolvedCount || 0), ambiguous = Number(model.graph.ambiguousCount || 0);
    if (unresolved || ambiguous) notices.append(el('div', 'km-notice', `Не разрешено ссылок: ${unresolved} · неоднозначных: ${ambiguous}`));
  }
  function renderTree() {
    const { roots: treeRoots } = treeModel(), paths = visiblePaths(); tree.replaceChildren();
    treeSummary.textContent = `${paths.size} из ${model.graph.nodes.length} записей`;
    const addGroup = (group, depth) => {
      const visibleChildren = group.children.filter(child => hasVisible(child));
      const visibleRecords = group.records.filter(record => paths.has(record.path));
      if (!visibleChildren.length && !visibleRecords.length) return;
      const row = el('div', 'km-tree-row'); row.style.setProperty('--depth', depth); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(model.expanded.has(group.id)));
      const toggle = el('button', 'km-tree-toggle', model.expanded.has(group.id) ? '⌄' : '›'); toggle.type = 'button'; toggle.setAttribute('aria-label', `${model.expanded.has(group.id) ? 'Свернуть' : 'Развернуть'} ${group.label}`); toggle.addEventListener('click', () => { model.expanded.has(group.id) ? model.expanded.delete(group.id) : model.expanded.add(group.id); renderTree(); });
      const label = el('button', 'km-tree-folder', group.label); label.type = 'button'; label.title = group.label; label.addEventListener('click', () => { model.expanded.add(group.id); const first = descendants(group).find(record => paths.has(record.path)); if (first) setSelection(first.path, true); else renderTree(); }); row.append(toggle, el('span', 'km-folder-mark', '▱'), label, el('small', '', `${visibleRecords.length || visibleChildren.length}`)); row.setAttribute('tabindex', '0'); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); model.expanded.has(group.id) ? model.expanded.delete(group.id) : model.expanded.add(group.id); renderTree(); } }); tree.append(row);
      if (model.expanded.has(group.id)) { visibleChildren.forEach(child => addGroup(child, depth + 1)); visibleRecords.forEach(record => addRecord(record, depth + 1)); }
    };
    const hasVisible = item => item.path ? paths.has(item.path) : item.records.some(record => paths.has(record.path)) || item.children.some(hasVisible);
    const addRecord = (record, depth) => {
      const node = model.graph.nodes.find(item => item.path === record.path); const button = el('button', `km-tree-record${record.path === model.selected ? ' is-selected' : ''}`); button.type = 'button'; button.setAttribute('role', 'treeitem'); button.setAttribute('aria-selected', String(record.path === model.selected)); button.dataset.treeRecord = record.path; button.style.setProperty('--depth', depth);
      button.append(el('i', `km-dot km-${node.type || 'default'}`), el('span', 'km-record-title', record.title || record.path), el('small', '', String(node.linksCount ?? ''))); button.title = record.path; button.addEventListener('click', () => setSelection(record.path, true)); tree.append(button);
    };
    treeRoots.forEach(item => item.path ? paths.has(item.path) && addRecord(item, 0) : addGroup(item, 0));
    if (!paths.size && model.graph.nodes.length) tree.append(el('div', 'km-empty', 'Совпадений нет.'));
  }
  function descendants(group) { return [...group.records, ...group.children.flatMap(descendants)]; }
  function renderMap() {
    const graph = model.graph, layoutData = initialLayout, paths = visiblePaths();
    const view = model.view;
    canvas.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`); canvas.setAttribute('preserveAspectRatio', 'xMidYMid meet'); content.replaceChildren();
    const transform = svg('g'); content.append(transform);
    const { positions, clusters } = layoutData;
    for (const [key, center] of clusters) {
      const circle = svg('circle', { cx: center.x, cy: center.y, r: 10, class: 'km-cluster' }); transform.append(circle);
    }
    const neighbors = knowledgeNeighbors(graph, model.selected); const focus = model.selected ? new Set([model.selected, ...neighbors]) : null;
    graph.edges.forEach(edge => {
      const a = positions.get(edge.source), b = positions.get(edge.target); if (!a || !b) return;
      const visible = paths.has(edge.source) && paths.has(edge.target);
      const related = !focus || (focus.has(edge.source) && focus.has(edge.target)); const line = svg('path', { d: `M${a.x},${a.y} Q${(a.x+b.x)/2 + (b.y-a.y)*.08},${(a.y+b.y)/2 + (a.x-b.x)*.08} ${b.x},${b.y}`, class: `km-edge${related ? ' is-related' : ' is-dim'}${visible ? '' : ' is-filtered'}` }); transform.append(line);
    });
    graph.nodes.forEach(node => {
      const point = positions.get(node.path); if (!point) return;
      const match = paths.has(node.path), related = !focus || focus.has(node.path), selected = model.selected === node.path;
      const group = svg('g', { class: `km-node${selected ? ' is-selected' : ''}${related ? '' : ' is-dim'}${match ? '' : ' is-filtered'}`, tabindex: '0', role: 'button', 'aria-label': `${node.title || node.path}, ${node.type || 'запись'}, ${node.linksCount ?? 0} связей`, 'data-map-node': node.path });
      group.setAttribute('transform', `translate(${point.x} ${point.y})`);
      group.append(svg('circle', { r: selected ? 15 : Math.min(12, 8 + Math.sqrt(Number(node.linksCount) || 0) * .5), class: 'km-node-halo' }), svg('circle', { r: selected ? 8 : 6, class: 'km-node-core', fill: COLORS[node.type] || COLORS.default }));
      const showLabel = selected || (focus && focus.has(node.path)) || Number(node.linksCount) >= 4 || (model.query && match);
      const label = svg('text', { x: 12, y: 5, class: `km-node-label${showLabel ? ' is-label-visible' : ''}` }); label.textContent = node.title || node.path; group.append(label);
      const select = () => { if (!model.didDrag) setSelection(node.path, true); }; group.addEventListener('click', select); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelection(node.path, true); } }); transform.append(group);
    });
    count.textContent = `${graph.nodes.length} записей · ${graph.edges.length} связей`;
  }
  function fit() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const view = fitKnowledgeView(initialLayout, rect.width, rect.height);
    model.fitWidth = view.width; model.view = view;
    updateZoomLabel(); renderMap();
  }
  function focusNode(path) {
    const point = initialLayout.positions.get(path), rect = stage.getBoundingClientRect();
    if (!point || !rect.width || !rect.height) { renderMap(); return; }
    const neighborhood = knowledgeNeighbors(model.graph, path); neighborhood.add(path);
    const view = fitKnowledgeView(initialLayout, rect.width, rect.height, neighborhood);
    model.view = view;
    updateZoomLabel(); renderMap();
  }
  function updateZoomLabel() { zoomLabel.textContent = `${Math.round(model.fitWidth / model.view.width * 100)}%`; }
  const zoom = factor => {
    const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const nextWidth = Math.max(model.fitWidth / 3, Math.min(model.fitWidth * 1.6, model.view.width / factor));
    const centerX = model.view.x + model.view.width / 2, centerY = model.view.y + model.view.height / 2, height = nextWidth * rect.height / rect.width;
    model.view = { x: centerX - nextWidth / 2, y: centerY - height / 2, width: nextWidth, height };
    updateZoomLabel(); renderMap();
  };
  searchInput.addEventListener('input', () => { model.query = searchInput.value; renderTree(); renderMap(); });
  typeFilter.addEventListener('change', () => { model.type = typeFilter.value; renderTree(); renderMap(); });
  fitButton.addEventListener('click', fit); resetButton.addEventListener('click', () => { model.selected = ''; renderTree(); fit(); }); zoomOut.addEventListener('click', () => zoom(.82)); zoomIn.addEventListener('click', () => zoom(1.22));
  treeToggle.addEventListener('click', () => { model.mobileTree = !model.mobileTree; layout.classList.toggle('tree-open', model.mobileTree); treeToggle.setAttribute('aria-expanded', String(model.mobileTree)); });
  canvas.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.08 : .92); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (event.target.closest?.('[data-map-node]')) return; model.dragging = true; model.didDrag = false; model.start = { x: event.clientX, y: event.clientY, x0: model.view.x, y0: model.view.y }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => { if (!model.dragging) return; const dx = event.clientX - model.start.x, dy = event.clientY - model.start.y; if (Math.hypot(dx, dy) > 3) model.didDrag = true; if (!model.didDrag) return; const rect = canvas.getBoundingClientRect(); model.view.x = model.start.x0 - dx * model.view.width / rect.width; model.view.y = model.start.y0 - dy * model.view.height / rect.height; renderMap(); });
  canvas.addEventListener('pointerup', () => { model.dragging = false; setTimeout(() => { model.didDrag = false; }, 0); }); canvas.addEventListener('pointercancel', () => { model.dragging = false; model.didDrag = false; });
  renderNotices(); renderTree(); renderMap(); fit();
  return { select(path) { const found = path == null || model.graph.nodes.some(node => node.path === path); setSelection(found ? path : '', false); return found; }, destroy() { container.replaceChildren(); } };
}
