import { xmindCurveHorizon, xmindPlaceAttachedTopics, xmindPlaceMainTopics, xmindRightSideCount } from './vendor/xmind-layout.js';
import rough from './vendor/roughjs-4.6.6.js';

const text = value => String(value ?? '');
const norm = value => text(value).toLocaleLowerCase('ru');
const nodeLabel = node => node?.title || node?.id || 'Без названия';
export function conceptMapLabel(node) {
  const title = nodeLabel(node);
  return title.length <= 48 ? title : title.slice(0, 45).replace(/\s+\S*$/, '') + '…';
}
export const conceptHasExplanation = node => !!node && (node.kind !== 'category' || !!node.definition?.trim() || (node.definitions || []).some(item => !!item.text?.trim()) || !!node.sourceRefs?.length);
const make = (tag, cls, label) => { const e = document.createElement(tag); if (cls) e.className = cls; if (label != null) e.textContent = label; return e; };
const sketchSeed = value => { let hash = 2166136261; for (const char of String(value)) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); } return (hash >>> 0) || 1; };

/** parentId is the sole containment contract; related edges stay outside this tree. */
export function buildConceptHierarchy(graph = {}) {
  const source = Array.isArray(graph.nodes) ? graph.nodes : [];
  const byId = new Map(source.map(node => [node.id, { ...node, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = byId.get(node.parentId);
    (parent && parent.id !== node.id ? parent.children : roots).push(node);
  }
  const byPath = new Map();
  for (const node of source) for (const ref of node.sourceRefs || []) {
    if (typeof ref?.path !== 'string' || !ref.path.trim()) continue;
    if (!byPath.has(ref.path)) byPath.set(ref.path, []);
    byPath.get(ref.path).push(node);
  }
  return { roots, byId, byPath };
}

/** Drawing style of the map. The values below are the original hand-drawn look; a colour theme overrides them through --cm-* custom properties. */
export const CONCEPT_MAP_DEFAULT_STYLE = Object.freeze({
  sketch: 1, node: 'ellipse', edge: 'curve', echo: true,
  hueLock: null, hueSpread: 1,
  fillS: 32, fillL: 76, fillStep: -1.5, strokeS: 37, strokeL: 74, strokeStep: -1, leafS: 43, leafL: 84,
  ink: '#15212e', coreFill: '#d3ae70', coreStroke: '#d3ae70', coreEcho: '#d3b779', overviewFrame: '#f2cf8f',
});
const STYLE_KEYS = { sketch: 'number', node: 'word', edge: 'word', echo: 'flag', hueLock: 'number', hueSpread: 'number', fillS: 'number', fillL: 'number', fillStep: 'number', strokeS: 'number', strokeL: 'number', strokeStep: 'number', leafS: 'number', leafL: 'number', ink: 'color', coreFill: 'color', coreStroke: 'color', coreEcho: 'color', overviewFrame: 'color' };
const cssName = key => '--cm-' + key.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
/** Reads --cm-sketch, --cm-node, --cm-fill-s ... from computed style; anything unset keeps the default. */
export function conceptMapStyle(element) {
  const style = { ...CONCEPT_MAP_DEFAULT_STYLE };
  if (!element || typeof getComputedStyle !== 'function') return style;
  const computed = getComputedStyle(element);
  for (const [key, type] of Object.entries(STYLE_KEYS)) {
    const raw = computed.getPropertyValue(cssName(key)).trim().replace(/^["']|["']$/g, '');
    if (!raw) continue;
    if (type === 'number') { const value = Number(raw); if (Number.isFinite(value)) style[key] = value; }
    else if (type === 'flag') style[key] = !['0', 'false', 'none', 'off'].includes(raw);
    else style[key] = raw;
  }
  return style;
}

/** Visual semantics come from the complete tree, never the current search/fold view. */
export function conceptMapAppearance(graph = {}, look = CONCEPT_MAP_DEFAULT_STYLE) {
  const s = { ...CONCEPT_MAP_DEFAULT_STYLE, ...look };
  // A theme can pull every branch hue toward its own colour while keeping branches distinguishable.
  const themedHue = hue => s.hueLock == null ? hue : (s.hueLock + (((hue - s.hueLock + 540) % 360) - 180) * s.hueSpread + 360) % 360;
  const { roots } = buildConceptHierarchy(graph), result = new Map();
  const thematicHues = new Map([
    ['category:world', 212], ['category:rules', 225], ['category:entities', 172],
    ['category:history', 136], ['category:plot', 38], ['category:characters', 282],
    ['concept:magic', 260], ['concept:aura', 185], ['concept:gods', 45],
  ]);
  const visit = (node, parent, depth) => {
    const hasChildren = node.children.length > 0;
    const explicitHue = thematicHues.get(node.id);
    const isCategory = explicitHue !== undefined || node.kind === 'category' || node.id.startsWith('category:');
    const offset = isCategory ? sketchSeed(node.id) % 37 - 18 : hasChildren ? sketchSeed(node.id) % 13 - 6 : 0;
    const hue = ((explicitHue ?? ((parent?.hue ?? 40) + offset)) + 360) % 360;
    const shade = Math.min(depth, 6), shown = Math.round(themedHue(hue) * 10) / 10;
    const style = {
      shape: hasChildren ? (depth === 0 ? 'circle' : 'oval') : 'terminal-unenclosed', hasChildren, depth, hue,
      categoryId: isCategory ? node.id : parent?.categoryId || node.id,
      fill: depth === 0 ? s.coreFill : `hsl(${shown} ${s.fillS}% ${s.fillL + shade * s.fillStep}%)`,
      stroke: depth === 0 ? s.coreStroke : `hsl(${shown} ${s.strokeS}% ${s.strokeL + shade * s.strokeStep}%)`,
      text: hasChildren ? s.ink : `hsl(${shown} ${s.leafS}% ${s.leafL}%)`,
    };
    result.set(node.id, style);
    node.children.forEach(child => visit(child, style, depth + 1));
  };
  roots.forEach(root => visit(root, null, 0));
  return result;
}
export function filterConceptIds(graph, query = '') {
  const { byId } = buildConceptHierarchy(graph), q = norm(query.trim()), visible = new Set();
  for (const node of byId.values()) if (!q || [node.title, node.originalTitle, ...(node.aliases || []).map(alias=>alias.title), node.summary, node.definition, ...(node.definitions || []).map(d => d.text)].some(value => norm(value).includes(q))) {
    let cursor = node;
    while (cursor) { visible.add(cursor.id); cursor = byId.get(cursor.parentId); }
  }
  return visible;
}

export const CONCEPT_MAP_MIN_SCALE = .5;
export const CONCEPT_MAP_MAX_SCALE = 3;

export function conceptMapAvailableHeight(viewportHeight, stageTop) {
  return Math.max(320, viewportHeight - Math.max(0, stageTop) - 16);
}

/** Fits visible content when possible and otherwise keeps the core centered at a readable scale. */
export function fitConceptMapViewport(bounds, viewport, core, minScale = CONCEPT_MAP_MIN_SCALE, padding = 36) {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height), aspect = width / height;
  const contentWidth = Math.max(1, bounds.right - bounds.left + padding * 2);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top + padding * 2);
  const idealWidth = Math.max(contentWidth, contentHeight * aspect, width);
  const viewWidth = Math.min(idealWidth, width / minScale), viewHeight = viewWidth / aspect;
  const clipped = idealWidth > viewWidth;
  const centerX = clipped ? core.x : (bounds.left + bounds.right) / 2;
  const centerY = clipped ? core.y : (bounds.top + bounds.bottom) / 2;
  return { x: centerX - viewWidth / 2, y: centerY - viewHeight / 2, width: viewWidth, height: viewHeight, scale: width / viewWidth, clipped };
}

/** Constrains every view change to the readable and useful zoom range. */
export function constrainConceptMapViewport(view, viewport, minScale = CONCEPT_MAP_MIN_SCALE, maxScale = CONCEPT_MAP_MAX_SCALE) {
  const widthPx = Math.max(1, viewport.width), heightPx = Math.max(1, viewport.height), aspect = widthPx / heightPx;
  const viewWidth = Math.min(widthPx / minScale, Math.max(widthPx / maxScale, view.width));
  const centerX = view.x + view.width / 2, centerY = view.y + view.height / 2, viewHeight = viewWidth / aspect;
  return { x: centerX - viewWidth / 2, y: centerY - viewHeight / 2, width: viewWidth, height: viewHeight, scale: widthPx / viewWidth };
}

/** Recenters a viewport on a node after a layout change while preserving its scale. */
export function focusConceptMapViewport(view, viewport, point) {
  const aspect = viewport.width / Math.max(1, viewport.height), height = view.width / aspect;
  return constrainConceptMapViewport({ x: point.x - view.width / 2, y: point.y - height / 2, width: view.width, height }, viewport);
}

/** XMind's measured-bounds bilateral map, retaining parentId as containment. */
export function layoutConceptTree(graph, expandedIds = [], viewportWidth = 1000, visibleIds = null) {
  const { roots } = buildConceptHierarchy(graph), expanded = expandedIds instanceof Set ? expandedIds : new Set(expandedIds);
  const rootWidth = 240, rootHeight = 240, topicWidth = 150;
  const mainGap = 32, detailGap = 40, siblingGap = 12;
  const positions = new Map(), visibleNodes = [], edges = [], leafCounts = new Map();
  const visible = visibleIds instanceof Set ? visibleIds : null;
  const childrenFor = node => node.children.filter(child => !visible || visible.has(child.id));
  const rootId = graph.rootId && roots.some(root => root.id === graph.rootId) ? graph.rootId : roots[0]?.id;
  const primaryRoot = roots.find(root => root.id === rootId);
  const cache = (node, depth) => {
    const children = expanded.has(node.id) ? childrenFor(node) : [];
    const count = children.length ? children.reduce((sum, child) => sum + cache(child, depth + 1), 0) : 1;
    leafCounts.set(node.id, count);
    return count;
  };
  if (primaryRoot) cache(primaryRoot, 0);
  const disconnected = roots.filter(root => root !== primaryRoot);
  for (const root of disconnected) cache(root, 1);
  const rootChildren = primaryRoot && expanded.has(primaryRoot.id) ? childrenFor(primaryRoot) : [];
  const originalRootChildren = primaryRoot?.children || [];
  const visibleRootIds = new Set(rootChildren.map(node => node.id));
  const dimensions = new Map();
  const metrics = (node, depth) => {
    const hasChildren = node.children.length > 0;
    const lines = wrapConceptTitle(conceptMapLabel(node), depth === 0 ? 112 : 142);
    const measured = Math.max(0, ...lines.map(estimateConceptTextWidth));
    const ratio = 1 + depth * .5;
    const ovalWidth = Math.max(depth === 1 ? 160 : 148, measured * 1.3, (lines.length * 18 + 28) * ratio);
    const width = depth === 0 ? rootWidth : hasChildren ? ovalWidth : Math.min(166, Math.max(topicWidth, measured + 18));
    const height = depth === 0 ? rootHeight : hasChildren ? ovalWidth / ratio : Math.max(32, lines.length * 20 + 10);
    return { width, height, lines, hasChildren };
  };
  const roughHeight = (node, depth = 0) => {
    const size = metrics(node, depth).height;
    const children = node.children;
    return Math.max(size, children.reduce((sum, child) => sum + roughHeight(child, depth + 1), 0) + Math.max(0, children.length - 1) * siblingGap);
  };
  const roughRoots = originalRootChildren.map(node => ({ bounds: { height: roughHeight(node, 1) } }));
  const rootRightCount = originalRootChildren.length === 2 ? 1 : xmindRightSideCount(roughRoots, rootHeight);
  const sideById = new Map();
  const bilateralOrder = originalRootChildren.length === 2 ? [originalRootChildren[1], originalRootChildren[0]] : originalRootChildren;
  bilateralOrder.slice(0, rootRightCount).forEach(node => sideById.set(node.id, 1));
  bilateralOrder.slice(rootRightCount).forEach(node => sideById.set(node.id, -1));
  disconnected.forEach((node, index) => sideById.set(node.id, index % 2 ? 1 : -1));
  const measure = (node, depth = 0, side = 1) => {
    const { width, height, lines, hasChildren } = metrics(node, depth);
    const children = expanded.has(node.id) ? childrenFor(node) : [];
    const childSizes = children.map(child => measure(child, depth + 1, side));
    const childrenHeight = childSizes.reduce((sum, item) => sum + item.bounds.height, 0) + Math.max(0, childSizes.length - 1) * siblingGap;
    const subtreeHeight = Math.max(height, childrenHeight);
    const childWidth = childSizes.length ? Math.max(...childSizes.map(item => item.bounds.width)) : 0;
    const subtreeWidth = childSizes.length ? width + detailGap + childWidth : width;
    const bounds = {
      x: side < 0 && childSizes.length ? -width / 2 - detailGap - childWidth : -width / 2,
      y: -subtreeHeight / 2,
      width: subtreeWidth,
      height: subtreeHeight,
    };
    const topicBounds = { x: -width / 2, y: -height / 2, width, height };
    const data = { width, height, lines, hasChildren, children, childSizes, bounds, topicBounds, subtreeHeight, subtreeWidth, depth };
    dimensions.set(node.id, data);
    return data;
  };
  const rootSize = primaryRoot ? measure(primaryRoot, 0, 1) : null;
  const rightSpecs = bilateralOrder.slice(0, rootRightCount).filter(node => visibleRootIds.has(node.id)).map(node => ({ node, ...measure(node, 1, 1), endAnchorY: 0 }));
  const leftSpecs = bilateralOrder.slice(rootRightCount).filter(node => visibleRootIds.has(node.id)).reverse().map(node => ({ node, ...measure(node, 1, -1), endAnchorY: 0 }));
  disconnected.forEach(node => measure(node, 1, sideById.get(node.id)));
  const rootTopicBounds = { x: -rootWidth / 2, y: -rootHeight / 2, width: rootWidth, height: rootHeight };
  const rootBounds = { x: -rootWidth / 2, y: -rootHeight / 2, width: rootWidth, height: rootHeight };
  const rightPositions = xmindPlaceMainTopics(rightSpecs, { direction: 'right', parentTopicBounds: rootTopicBounds, spacingMajor: mainGap, spacingMinor: siblingGap, isUpToDown: true });
  const leftPositions = xmindPlaceMainTopics(leftSpecs, { direction: 'left', parentTopicBounds: rootTopicBounds, spacingMajor: mainGap, spacingMinor: siblingGap, isUpToDown: false });
  const coreY = 0;
  let minX = -rootWidth / 2, maxX = rootWidth / 2, minY = -rootHeight / 2, maxY = rootHeight / 2;
  const placeSubtree = (node, x, y, side, depth, parent = null) => {
    const size = dimensions.get(node.id);
    positions.set(node.id, { x, y, side, depth, width: size.width, height: size.height, lines: size.lines, hasChildren: size.hasChildren });
    visibleNodes.push(node);
    if (parent) edges.push({ source: parent.id, target: node.id, kind: 'contains' });
    minX = Math.min(minX, x + size.bounds.x); maxX = Math.max(maxX, x + size.bounds.x + size.bounds.width);
    minY = Math.min(minY, y + size.bounds.y); maxY = Math.max(maxY, y + size.bounds.y + size.bounds.height);
    const children = size.children;
    if (!children.length) return;
    const direction = side < 0 ? 'left' : 'right';
    const childSpecs = size.childSizes.map(child => ({
      bounds: child.bounds,
      topicBounds: child.topicBounds,
      endAnchorY: 0,
    }));
    const childPoints = xmindPlaceAttachedTopics({ bounds: { x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height } }, childSpecs, direction, detailGap, siblingGap, 0);
    children.forEach((child, index) => {
      const point = childPoints[index];
      const childX = x + point.x + (direction === 'right' ? 0 : 0);
      const childY = y + point.y;
      placeSubtree(child, childX, childY, side, depth + 1, node);
    });
  };
  if (primaryRoot) {
    const rootPosition = { x: 0, y: coreY, side: 0, depth: 0, width: rootWidth, height: rootHeight, lines: dimensions.get(primaryRoot.id).lines, hasChildren: primaryRoot.children.length > 0 };
    positions.set(primaryRoot.id, rootPosition); visibleNodes.push(primaryRoot);
    minX = Math.min(minX, -rootWidth / 2); maxX = Math.max(maxX, rootWidth / 2);
    minY = Math.min(minY, coreY - rootHeight / 2); maxY = Math.max(maxY, coreY + rootHeight / 2);
    rightSpecs.forEach((spec, index) => placeSubtree(spec.node, rightPositions[index].x, coreY + rightPositions[index].y, 1, 1, primaryRoot));
    leftSpecs.forEach((spec, index) => placeSubtree(spec.node, leftPositions[index].x, coreY + leftPositions[index].y, -1, 1, primaryRoot));
  }
  disconnected.forEach((node, index) => placeSubtree(node, index % 2 ? rootWidth : -rootWidth, coreY, index % 2 ? 1 : -1, 1));
  const centerX = 32 - minX, centerY = 32 - minY;
  for (const point of positions.values()) { point.x += centerX; point.y += centerY; }
  const width = Math.ceil(maxX - minX + 64), height = Math.ceil(maxY - minY + 64);
  return { positions, visibleNodes, edges, width, height, nodeWidth: topicWidth, nodeHeight: 128, centerX, centerY, xGap: detailGap, yGap: siblingGap };
}

function wrapConceptTitle(title, maxChars = 24) {
  const lines = []; let line = '';
  for (const word of String(title).split(/\s+/)) {
    if (line && estimateConceptTextWidth(`${line} ${word}`) > maxChars) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length > 3 ? [...lines.slice(0, 2), `${lines[2].replace(/[.…]*$/, '')}…`] : lines;
}

function estimateConceptTextWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    if (/\s/.test(char)) width += 4.5;
    else if (/[ilІіӏ.,:;!'|]/u.test(char)) width += 4.6;
    else if (/[жшщфмюъыЖШЩФМЮЪЫ@%&]/u.test(char)) width += 9.2;
    else if (/[A-ZА-ЯЁ]/u.test(char)) width += 9;
    else width += 8;
  }
  return width;
}

export function createConceptMap({ container, graph = {}, onSelect = () => {} }) {
  if (!container) throw new TypeError('container is required');
  const hierarchy = buildConceptHierarchy(graph), nodes = hierarchy.byId;
  let look = conceptMapStyle(container), appearance = conceptMapAppearance(graph, look);
  const rootId = nodes.has(graph.rootId) ? graph.rootId : hierarchy.roots[0]?.id;
  const expanded = new Set(rootId ? [rootId] : []);
  for (const root of hierarchy.roots) if (root.id === rootId) for (const child of root.children) expanded.add(child.id);
  const model = { selected: nodes.has(graph.selection) ? graph.selection : rootId, query: '', related: false, mentions: false };
  const shell = make('section', 'cm'); shell.setAttribute('aria-label', 'Иерархия понятий');
  const header = make('header', 'cm-header');
  const intro = make('div', 'cm-intro'); intro.append(make('div', 'cm-eyebrow', 'СТРУКТУРА БАЗЫ'), make('h2', '', 'Карта понятий'), make('p', '', 'От центрального ядра — к разделам и вложенным понятиям. Связи показаны отдельно от структуры.'));
  const tools = make('div', 'cm-tools'), searchLabel = make('label', 'cm-search'); searchLabel.append(make('span', '', 'Поиск по всей базе'));
  const search = make('input'); search.type = 'search'; search.placeholder = 'Название, тип или описание'; search.setAttribute('aria-label', 'Поиск по всей базе понятий'); searchLabel.append(search);
  const relatedLabel = make('label', 'cm-related-toggle'), related = make('input'); related.type = 'checkbox'; related.disabled = !(graph.edges || []).some(edge => edge.kind === 'related'); relatedLabel.append(related, make('span', '', 'Показать связи по источникам'));
  const mentionLabel = make('label', 'cm-related-toggle'), mentions = make('input'); mentions.type = 'checkbox'; mentionLabel.append(mentions, make('span', '', 'Показать упоминания'));
  const listToggle = make('button', 'cm-list-toggle', 'Список понятий'); listToggle.type = 'button';
  tools.append(searchLabel, relatedLabel, mentionLabel, listToggle); header.append(intro, tools);
  const notice = make('div', 'cm-notice'); notice.setAttribute('role', 'status');
  const body = make('div', 'cm-body');
  const treePane = make('aside', 'cm-tree-pane'), treeHeading = make('div', 'cm-tree-heading'); treeHeading.append(make('strong', '', 'Вся структура'), make('span', 'cm-tree-count', `${nodes.size} узлов`));
  const tree = make('div', 'cm-tree'); tree.setAttribute('role', 'tree'); treePane.append(treeHeading, tree);
  const content = make('main', 'cm-content'), branch = make('section', 'cm-branch'); content.append(branch); body.append(treePane, content); shell.append(header, notice, body); container.replaceChildren(shell);
  shell.classList.toggle('cm-list-closed', window.matchMedia('(max-width:900px)').matches);
  const fullscreenWorkspace = container.closest('.knowledge-concept-workspace');
  const setFullscreen = active => {
    shell.classList.toggle('cm-map-fullscreen', active);
    fullscreenWorkspace?.classList.toggle('is-map-fullscreen', active);
  };
  listToggle.setAttribute('aria-expanded', String(!shell.classList.contains('cm-list-closed')));
  listToggle.addEventListener('click', () => { shell.classList.toggle('cm-list-closed'); listToggle.setAttribute('aria-expanded', String(!shell.classList.contains('cm-list-closed'))); render(); });
  const focusKey = () => shell.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
  const restoreFocus = key => { if (key) [...shell.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === key)?.focus(); };
  const ancestors = id => { const out = []; let cursor = nodes.get(id); while (cursor) { out.unshift(cursor); cursor = nodes.get(cursor.parentId); } return out; };
  function choose(id, notify = true) {
    if (!nodes.has(id)) return false;
    if (model.query) { model.query = ''; search.value = ''; shell.classList.toggle('cm-list-closed', listBeforeSearch); listToggle.setAttribute('aria-expanded', String(!listBeforeSearch)); }
    model.selected = id; for (const ancestor of ancestors(id)) if (ancestor.children.length) expanded.add(ancestor.id);
    if (model.related) revealRelated(id);
    if (notify) onSelect(nodes.get(id));
    pendingFocusId = id;
    mapInteracted = true;
    render();
    return true;
  }
  function revealRelated(id) {
    for (const edge of graph.edges || []) if (edge.kind === 'related' && edge.basis?.startsWith('[Отношение] ') && (edge.source === id || edge.target === id)) for (const ancestor of ancestors(edge.source === id ? edge.target : edge.source)) if (ancestor.children.length) expanded.add(ancestor.id);
  }
  function renderTree() {
    const activeKey = focusKey(), visible = filterConceptIds(graph, model.query); tree.replaceChildren();
    const add = (node, depth) => {
      if (!visible.has(node.id)) return;
      const hasChildren = node.children.length > 0, open = expanded.has(node.id) || !!model.query;
      const row = make('div', `cm-tree-row${model.selected === node.id ? ' is-selected' : ''}`); row.style.setProperty('--depth', Math.min(depth, 6)); row.dataset.hasChildren = String(hasChildren); row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(model.selected === node.id)); row.setAttribute('aria-expanded', String(hasChildren && open));
      const expander = make('button', 'cm-expander', hasChildren ? (open ? '⌄' : '›') : '·'); expander.type = 'button'; expander.disabled = !hasChildren; expander.setAttribute('aria-label', `${open ? 'Свернуть' : 'Развернуть'} ${nodeLabel(node)}`); expander.dataset.focusKey = `tree-toggle:${node.id}`; expander.addEventListener('click', () => { expanded.has(node.id) ? expanded.delete(node.id) : expanded.add(node.id); pendingFocusId = node.id; mapInteracted = true; render(); });
      const label = make('button', 'cm-tree-label', nodeLabel(node)); label.type = 'button'; label.dataset.focusKey = `tree:${node.id}`; label.title = nodeLabel(node); label.addEventListener('click', () => choose(node.id));
      row.append(expander, make('span', `cm-kind cm-kind-${node.kind || 'concept'}`, node.kind === 'category' ? 'Раздел' : 'Понятие'), label); tree.append(row);
      if (open) node.children.forEach(child => add(child, depth + 1));
    };
    hierarchy.roots.forEach(root => add(root, 0)); if (!visible.size) tree.append(make('p', 'cm-empty', 'Совпадений нет.')); restoreFocus(activeKey);
  }
  const svg = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attrs).forEach(([key, value]) => e.setAttribute(key, String(value))); return e; };
  let mapView = null, mapInteracted = false, pendingFocusId = null, resizeObserver = null, zoomPercent = 92;
  let resizeStage = null;
  const refreshStage = () => resizeStage?.();
  window.addEventListener('resize', refreshStage);
  window.addEventListener('scroll', refreshStage, true);
  // A colour theme also changes how the map is drawn, so redraw it when the theme switches.
  const redrawForTheme = () => renderMap();
  window.addEventListener('talewisp:themechange', redrawForTheme);
  const exitFullscreenOnEscape = event => { if (event.key === 'Escape' && shell.classList.contains('cm-map-fullscreen')) { setFullscreen(false); renderMap(); } };
  document.addEventListener('keydown', exitFullscreenOnEscape);
  function renderMap() {
    branch.replaceChildren();
    look = conceptMapStyle(container); appearance = conceptMapAppearance(graph, look);
    const rr = value => value * look.sketch, clean = look.sketch <= 0.05;
    // Topic and core outlines in the theme's shape, centred on 0,0 inside a w×h box.
    const outline = (w, h) => {
      const x = w / 2, y = h / 2, c = Math.min(w, h) * .22, r = Math.min(14, h / 3);
      switch (look.node) {
        case 'rect': return `M ${-x} ${-y} H ${x} V ${y} H ${-x} Z`;
        case 'plate': return `M ${-x + r} ${-y} H ${x - r} Q ${x} ${-y} ${x} ${-y + r} V ${y - r} Q ${x} ${y} ${x - r} ${y} H ${-x + r} Q ${-x} ${y} ${-x} ${y - r} V ${-y + r} Q ${-x} ${-y} ${-x + r} ${-y} Z`;
        case 'chamfer': return `M ${-x + c} ${-y} H ${x - c} L ${x} ${-y + c} V ${y - c} L ${x - c} ${y} H ${-x + c} L ${-x} ${y - c} V ${-y + c} Z`;
        case 'arch': return `M ${-x} ${y} V ${-y * .2} C ${-x} ${-y * .75} ${-x * .45} ${-y * .9} 0 ${-y} C ${x * .45} ${-y * .9} ${x} ${-y * .75} ${x} ${-y * .2} V ${y} Z`;
        default: return null;
      }
    };
    const drawShape = (sketch, w, h, options) => {
      const d = outline(w, h), opts = { ...options, roughness: rr(options.roughness), bowing: rr(options.bowing ?? 0), ...(clean ? { disableMultiStroke: true } : {}) };
      return d ? sketch.path(d, opts) : sketch.ellipse(0, 0, w, h, opts);
    };
    const edgePath = (start, control, end) => {
      if (look.edge === 'elbow') { const midX = (start.x + end.x) / 2; return `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`; }
      if (look.edge === 'straight') { const bendX = start.x + (end.x - start.x) * .35; return `M ${start.x} ${start.y} L ${bendX} ${end.y} L ${end.x} ${end.y}`; }
      return xmindCurveHorizon({ start, control, end });
    };
    const searchVisible = model.query ? filterConceptIds(graph, model.query) : null;
    const displayExpanded = searchVisible ? searchVisible : expanded;
    const plan = layoutConceptTree(graph, displayExpanded, branch.clientWidth || 1000, searchVisible);
    const controls = make('div', 'cm-map-controls');
    const zoomOut = make('button', '', '−'), zoomIn = make('button', '', '+'), scaleLabel = make('span', 'cm-map-scale', '92%'), fitButton = make('button', '', '◎'), fullscreenButton = make('button', '', '⛶');
    for (const [button, label] of [[zoomOut, 'Уменьшить масштаб'], [zoomIn, 'Увеличить масштаб'], [fitButton, 'Центрировать ядро, сохраняя читаемый масштаб'], [fullscreenButton, 'Переключить полноэкранную карту']]) { button.type = 'button'; button.setAttribute('aria-label', label); }
    const stage = make('div', 'cm-map-stage'); stage.setAttribute('role', 'region'); stage.setAttribute('tabindex', '0'); stage.setAttribute('aria-label', 'Область карты: колесо мыши меняет масштаб, перетаскивание перемещает схему');
    const canvas = svg('svg', { class: 'cm-map', role: 'group', 'aria-label': 'Раскрываемая иерархия понятий', viewBox: `0 0 ${plan.width} ${plan.height}`, preserveAspectRatio: 'xMidYMid meet', focusable: 'false' });
    const sketch = rough.svg(canvas);
    const edges = svg('g', { class: 'cm-map-edges', 'aria-hidden': 'true' }), nodeGroup = svg('g', { class: 'cm-map-nodes' }), toggleOverlay = svg('g', { class: 'cm-map-toggles' });
    const textHalfWidth = node => {
      const pos = plan.positions.get(node.id);
      return pos.hasChildren ? pos.width / 2 : Math.min(pos.width / 2, Math.max(12, ...pos.lines.map(line => estimateConceptTextWidth(line) / 2)));
    };
    const sourceHalfWidth = node => {
      const pos = plan.positions.get(node.id);
      return pos.hasChildren ? pos.width / 2 - 3 : textHalfWidth(node) + 8;
    };
    const targetHalfWidth = node => {
      const pos = plan.positions.get(node.id);
      return pos.hasChildren ? pos.width / 2 - 3 : textHalfWidth(node) + 8;
    };
    const railY = pos => !pos.hasChildren ? 12 + (pos.lines.length - 1) * 10 : 0;
    for (const edge of plan.edges) {
      const a = plan.positions.get(edge.source), b = plan.positions.get(edge.target), side = b.side || a.side || 1;
      const source = nodes.get(edge.source), target = nodes.get(edge.target);
      const startX = a.x + side * sourceHalfWidth(source), endX = b.x - side * targetHalfWidth(target);
      const startY = a.y + railY(a), endY = b.y + railY(b);
      const control = { x: startX + side * Math.min(30, Math.max(14, Math.abs(endX - startX) * .42)), y: startY };
      const color = appearance.get(target.id).stroke;
      const path = sketch.path(edgePath({ x: startX, y: startY }, control, { x: endX, y: endY }), { seed: sketchSeed(`${edge.source}:${edge.target}`), roughness: rr(.65), bowing: rr(.45), stroke: color, strokeWidth: a.depth === 0 ? 3.5 : 1.7, fill: 'none', ...(clean ? { disableMultiStroke: true } : {}) });
      path.setAttribute('class', `cm-map-edge cm-map-edge-${a.depth === 0 ? 'main' : 'detail'}`);
      edges.append(path);
    }
    if ((model.related || model.mentions) && model.selected) for (const edge of (graph.edges || []).filter(item => item.kind === 'related' && (item.source === model.selected || item.target === model.selected) && (item.basis?.startsWith('[Отношение] ') ? model.related : model.mentions))) {
      const a = plan.positions.get(edge.source), b = plan.positions.get(edge.target); if (!a || !b) continue;
      const path = svg('path', { d: `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 - 28} ${b.x} ${b.y}`, class: 'cm-map-edge cm-map-edge-related' + (edge.basis?.startsWith('[Отношение] ') ? ' cm-map-edge-semantic' : ' cm-map-edge-mention') });
      const tip = svg('title'); tip.textContent = [edge.basis, edge.sourceTitle, edge.version, edge.evidence].filter(Boolean).join(' · '); path.append(tip); edges.append(path);
      if (edge.basis?.startsWith('[Отношение] ')) { const label = svg('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 34, class: 'cm-map-related-label' }); label.textContent = edge.label || 'Связано'; edges.append(label); }
    }
    for (const node of plan.visibleNodes) {
      const pos = plan.positions.get(node.id), side = pos.side;
      const isCore = node.id === rootId;
      const branchClass = side < 0 ? 'cm-map-branch-left' : side > 0 ? 'cm-map-branch-right' : '';
      const color = appearance.get(node.id);
      const group = svg('g', { class: `cm-map-node ${branchClass}${model.selected === node.id ? ' is-selected' : ''}${isCore ? ' cm-map-core' : ''}`, transform: `translate(${pos.x} ${pos.y})`, 'data-placement-status': node.status || '', 'data-concept-id': node.id, 'data-node-shape': color.shape, 'data-has-children': String(color.hasChildren), 'data-category-id': color.categoryId, 'data-depth': pos.depth, role: 'button', tabindex: '0', 'aria-label': nodeLabel(node) });
      group.style.setProperty('--branch', color.stroke); group.style.setProperty('--branch-soft', color.fill); group.style.setProperty('--node-text', color.text);
      group.append(svg('rect', { x: -pos.width / 2 - 8, y: -pos.height / 2 - 8, width: pos.width + 16, height: pos.height + 16, rx: pos.hasChildren ? pos.width / 2 + 8 : 18, class: 'cm-map-hit-area' }));
      if (isCore) {
        const circle = drawShape(sketch, pos.width - 6, pos.height - 6, { seed: sketchSeed(`${node.id}:core`), roughness: 1.6, bowing: .8, stroke: look.coreStroke, strokeWidth: 2.2, fill: look.coreFill, fillStyle: 'solid' });
        circle.setAttribute('class', 'cm-map-sketch-shape cm-map-core-circle'); group.append(circle);
        if (look.echo) {
          const coreEcho = sketch.path('M 63 -87 C 116 -56 119 26 74 77 C 31 125 -50 106 -85 63', { seed: sketchSeed(`${node.id}:echo`), roughness: rr(1.1), stroke: look.coreEcho, strokeWidth: 2.3, fill: 'none', disableMultiStroke: true });
          coreEcho.setAttribute('class', 'cm-map-contour-echo'); coreEcho.setAttribute('transform', `scale(${pos.width / 204})`); group.append(coreEcho);
        }
        const emblem = svg('g', { class: 'cm-map-core-emblem', transform: 'translate(0 -8) scale(1.55)', 'aria-hidden': 'true' });
        emblem.append(svg('path', { d: 'M -23 -19 Q -11 -25 0 -16 L 0 5 Q -11 -3 -23 1 Z M 0 -16 Q 11 -25 23 -19 L 23 1 Q 11 -3 0 5 Z M 0 -16 L 0 5', class: 'cm-map-core-book' }));
        emblem.append(svg('path', { d: 'M 0 -47 L 4 -37 L 14 -33 L 4 -29 L 0 -19 L -4 -29 L -14 -33 L -4 -37 Z', class: 'cm-map-core-spark' }));
        group.append(emblem);
      } else if (pos.hasChildren) {
        const topic = drawShape(sketch, pos.width - 6, pos.height - 6, { seed: sketchSeed(`${node.id}:topic`), roughness: 1.3, bowing: .7, stroke: color.stroke, strokeWidth: 1.8, fill: color.fill, fillStyle: 'solid' });
        topic.setAttribute('class', 'cm-map-sketch-shape cm-map-topic-ellipse'); group.append(topic);
        if (look.echo) {
          const topicEcho = sketch.path('M 63 -87 C 116 -56 119 26 74 77 C 31 125 -50 106 -85 63', { seed: sketchSeed(`${node.id}:echo`), roughness: rr(.8), stroke: color.stroke, strokeWidth: 1.8, fill: 'none', disableMultiStroke: true });
          topicEcho.setAttribute('transform', `scale(${pos.width / 204} ${pos.height / 204})`);
          topicEcho.setAttribute('class', 'cm-map-contour-echo'); group.append(topicEcho);
        }
      }
      const label = svg('text', { x: 0, class: 'cm-map-label', 'text-anchor': 'middle' });
      const lines = pos.lines;
      const labelSize = isCore ? 22 : 18;
      const firstLineY = isCore ? 62 - (lines.length - 1) * 11 : pos.hasChildren ? 6 - (lines.length - 1) * labelSize / 2 : 3 - (lines.length - 1) * 10;
      lines.forEach((line, index) => { const span = svg('tspan', { x: 0, y: firstLineY + index * labelSize }); span.textContent = line; label.append(span); });
      group.append(label);
      if (!pos.hasChildren) {
        const half = textHalfWidth(node), towardParent = side || 1;
        const rail = sketch.line(-half - 8, railY(pos), half + 8, railY(pos), { seed: sketchSeed(`${node.id}:rail`), roughness: rr(.6), bowing: rr(.3), stroke: color.stroke, strokeWidth: 1.35, ...(clean ? { disableMultiStroke: true } : {}) });
        rail.setAttribute('class', 'cm-map-sketch-rail cm-map-leaf-rail'); group.append(rail);
      }
      const titleTip = svg('title'); titleTip.textContent = nodeLabel(node); group.append(titleTip);
      group.addEventListener('keydown', event => { if (event.target === group && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose(node.id); } });
      group.addEventListener('click', event => { if (event.target.closest?.('.cm-map-expand')) return; choose(node.id); });
      if (!model.query && node.children.length) {
        const half = pos.hasChildren ? pos.width / 2 : textHalfWidth(node) + 24;
        const toggleX = side === 0 ? 0 : side * (half + 18), toggleY = side === 0 ? pos.height / 2 + 14 : railY(pos);
        const toggle = svg('g', { class: 'cm-map-expand', transform: `translate(${pos.x} ${pos.y})`, role: 'button', tabindex: '0', 'aria-label': `${expanded.has(node.id) ? 'Свернуть' : 'Развернуть'} ${nodeLabel(node)}`, 'data-focus-key': `map-toggle:${node.id}` });
        toggle.style.setProperty('--branch', color.stroke);
        toggle.append(svg('circle', { cx: toggleX, cy: toggleY, r: 10, class: 'cm-map-toggle-circle' }));
        const glyph = svg('text', { x: toggleX, y: toggleY + 4, class: 'cm-map-toggle-label' }); glyph.textContent = expanded.has(node.id) ? '−' : '+'; toggle.append(glyph);
        if (!expanded.has(node.id)) { const count = svg('text', { x: toggleX + (side < 0 ? -15 : 15), y: toggleY + 4, class: 'cm-map-hidden-count', 'text-anchor': side < 0 ? 'end' : 'start' }); count.textContent = node.children.length; toggle.append(count); }
        const flip = event => { event.stopPropagation(); expanded.has(node.id) ? expanded.delete(node.id) : expanded.add(node.id); pendingFocusId = node.id; mapInteracted = true; render(); };
        toggle.addEventListener('click', flip); toggle.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(event); } }); toggleOverlay.append(toggle);
      }
      nodeGroup.append(group);
    }
    // Keep the complete expanded hierarchy visible as orientation while the main
    // canvas stays at a readable scale. This is a navigator, not a second tree.
    const overview = svg('svg', { class: 'cm-map-overview', viewBox: `0 0 ${plan.width} ${plan.height}`, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Обзор раскрытой схемы и текущая область карты' });
    for (const edge of plan.edges) {
      const a = plan.positions.get(edge.source), b = plan.positions.get(edge.target);
      overview.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: appearance.get(edge.target).stroke, 'stroke-width': 4 }));
    }
    for (const node of plan.visibleNodes) {
      const p = plan.positions.get(node.id), color = appearance.get(node.id);
      overview.append(svg('ellipse', { cx: p.x, cy: p.y, rx: Math.max(12, p.width / 2), ry: Math.max(10, p.height / 2), fill: color.fill, stroke: color.stroke, 'stroke-width': 3 }));
    }
    const overviewFrame = svg('rect', { class: 'cm-map-overview-frame', fill: 'none', stroke: look.overviewFrame, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
    overview.append(overviewFrame);
    canvas.append(edges, nodeGroup, toggleOverlay); stage.append(canvas, overview, controls);
    fullscreenButton.addEventListener('click', () => { setFullscreen(!shell.classList.contains('cm-map-fullscreen')); renderMap(); });
    controls.append(zoomOut, zoomIn, scaleLabel, fitButton, fullscreenButton); branch.append(stage);
    const fillAvailableHeight = () => {
      if (shell.classList.contains('cm-map-fullscreen')) { treePane.style.height = ''; return; }
      const top = Math.max(0, stage.getBoundingClientRect().top);
      const height = `${conceptMapAvailableHeight(window.innerHeight, top)}px`;
      if (stage.style.height !== height) stage.style.height = height;
      treePane.style.height = height;
    };
    resizeStage = fillAvailableHeight;
    fillAvailableHeight();
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const setView = (view, mark = true) => {
      const rect = stage.getBoundingClientRect();
      mapView = constrainConceptMapViewport(view, { width: Math.max(120, rect.width), height: Math.max(120, rect.height) });
      canvas.setAttribute('viewBox', `${mapView.x} ${mapView.y} ${mapView.width} ${mapView.height}`);
      for (const [key, value] of Object.entries({ x: mapView.x, y: mapView.y, width: mapView.width, height: mapView.height })) overviewFrame.setAttribute(key, value);
      zoomPercent = Math.round(Math.max(120, rect.width) / mapView.width * 100); scaleLabel.textContent = `${zoomPercent}%`;
      if (mark) mapInteracted = true;
    };
    const contentBounds = points => ({ left: Math.min(...points.map(p => p.x - p.width / 2 - 28)), right: Math.max(...points.map(p => p.x + p.width / 2 + 28)), top: Math.min(...points.map(p => p.y - p.height / 2 - 28)), bottom: Math.max(...points.map(p => p.y + p.height / 2 + 28)) });
    const updateScaleLabel = () => { scaleLabel.textContent = `${zoomPercent}%`; };
    const fitAll = () => {
      const rect = stage.getBoundingClientRect(), bounds = contentBounds([...plan.positions.values()]);
      const core = plan.positions.get(rootId) || { x: plan.centerX, y: plan.centerY };
      setView(fitConceptMapViewport(bounds, { width: Math.max(120, rect.width), height: Math.max(120, rect.height) }, core), false);
    };
    const focusNode = id => {
      const pos = plan.positions.get(id); if (!pos) return;
      const rect = stage.getBoundingClientRect(), width = mapView?.width || Math.max(rect.width, plan.width);
      const children = (nodes.get(id)?.children || []).map(node => plan.positions.get(node.id)).filter(Boolean);
      const parent = nodes.get(id), isCore = id === rootId;
      let centerX = pos.x, centerY = pos.y;
      if (children.length && !isCore) { centerX = pos.x; centerY = pos.y; }
      else if (children.length && isCore) { centerX = pos.x; centerY = pos.y; }
      setView(focusConceptMapViewport({ x: mapView?.x || 0, y: mapView?.y || 0, width }, { width: rect.width, height: rect.height }, { x: centerX, y: centerY }), true);
    };
    const fitVisible = (readableFloor = false) => {
      fitAll();
      mapInteracted = false;
      updateScaleLabel();
    };
    if (!mapView || !mapInteracted) fitVisible(true);
    else setView({ ...mapView, x: clamp(mapView.x, -plan.width, plan.width), y: clamp(mapView.y, -plan.height, plan.height) }, false);
    if (pendingFocusId) { focusNode(pendingFocusId); pendingFocusId = null; }
    const zoomAt = (factor, px = .5, py = .5) => {
      const current = mapView || { x: 0, y: 0, width: plan.width, height: plan.height };
      const rect = stage.getBoundingClientRect(), aspect = rect.width / Math.max(1, rect.height);
      const constrained = constrainConceptMapViewport({ ...current, width: current.width * factor, height: current.width * factor / aspect }, { width: Math.max(120, rect.width), height: Math.max(120, rect.height) });
      const width = constrained.width, height = constrained.height;
      const anchorX = current.x + current.width * px, anchorY = current.y + current.height * py;
      setView({ x: anchorX - width * px, y: anchorY - height * py, width, height });
      updateScaleLabel();
    };
    fitButton.addEventListener('click', () => focusNode(rootId));
    zoomIn.addEventListener('click', () => zoomAt(.8)); zoomOut.addEventListener('click', () => zoomAt(1.25)); updateScaleLabel();
    stage.addEventListener('wheel', event => { event.preventDefault(); const rect = stage.getBoundingClientRect(); zoomAt(event.deltaY < 0 ? .9 : 1.1, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height); }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', event => { if (event.target.closest?.('.cm-map-node,.cm-map-expand,.cm-map-controls')) return; drag = { x: event.clientX, y: event.clientY, view: { ...mapView } }; stage.setPointerCapture(event.pointerId); stage.classList.add('is-panning'); });
    stage.addEventListener('pointermove', event => { if (!drag) return; const rect = stage.getBoundingClientRect(), dx = (event.clientX - drag.x) * drag.view.width / rect.width, dy = (event.clientY - drag.y) * drag.view.height / rect.height; setView({ ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy }); });
    const stopDrag = () => { drag = null; stage.classList.remove('is-panning'); }; stage.addEventListener('pointerup', stopDrag); stage.addEventListener('pointercancel', stopDrag);
    if (typeof ResizeObserver !== 'undefined') { resizeObserver?.disconnect(); resizeObserver = new ResizeObserver(() => { fillAvailableHeight(); if (!mapInteracted) fitVisible(true); else { const rect = stage.getBoundingClientRect(); if (!rect.width || !rect.height || !mapView) return; const height = mapView.width * rect.height / rect.width, centerY = mapView.y + mapView.height / 2; setView({ ...mapView, y: centerY - height / 2, height }, false); } }); resizeObserver.observe(stage); }
    notice.hidden = !graph.diagnostics?.status && !graph.truncated;
    notice.textContent = graph.diagnostics?.status === 'unassigned' ? 'Для источников без привязки отдельная иерархия терминов пока не построена.' : graph.diagnostics?.status === 'outline-missing' ? 'Индекс терминов этой серии пока не построен.' : graph.truncated ? `Источник содержит ${nodes.size} узлов из ограниченной выборки.` : '';
  }
  function render() { const active = focusKey(); renderTree(); renderMap(); restoreFocus(active); }
  let listBeforeSearch = shell.classList.contains('cm-list-closed');
  search.addEventListener('input', () => {
    if (!model.query && search.value) listBeforeSearch = shell.classList.contains('cm-list-closed');
    model.query = search.value.trim();
    if (model.query) {
      const query = norm(model.query);
      const candidates = [...nodes.values()];
      const match = candidates.find(node => [node.title, node.originalTitle, ...(node.aliases || []).map(alias=>alias.title)].some(value => norm(value) === query)) || candidates.find(node => [node.title, node.originalTitle, ...(node.aliases || []).map(alias=>alias.title), node.summary, node.definition, ...(node.definitions || []).map(item => item.text)].some(value => norm(value).includes(query)));
      pendingFocusId = match?.id || rootId;
      mapInteracted = true;
    }
    shell.classList.toggle('cm-list-closed', model.query ? false : listBeforeSearch);
    listToggle.setAttribute('aria-expanded', String(!shell.classList.contains('cm-list-closed')));
    render();
  });
  mentions.addEventListener('change', () => { model.mentions = mentions.checked; render(); });
  related.addEventListener('change', () => { model.related = related.checked; if (model.related && model.selected) revealRelated(model.selected); render(); });
  render();
  return { select(idOrPath) { if (idOrPath == null) return false; const value = text(idOrPath), redirected = graph.redirects?.[value]; let id = nodes.has(value) ? value : nodes.has(redirected) ? redirected : null; if (!id) { const matches = hierarchy.byPath.get(value) || []; if (matches.length === 1) id = matches[0].id; } return id ? choose(id, false) : false; }, destroy() { resizeObserver?.disconnect(); window.removeEventListener('resize', refreshStage); window.removeEventListener('scroll', refreshStage, true); window.removeEventListener('talewisp:themechange', redrawForTheme); resizeStage = null; document.removeEventListener('keydown', exitFullscreenOnEscape); setFullscreen(false); container.replaceChildren(); } };
}

