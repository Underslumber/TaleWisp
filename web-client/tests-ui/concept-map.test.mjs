import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConceptHierarchy, conceptMapAppearance, conceptMapAvailableHeight, filterConceptIds, layoutConceptTree, conceptMapLabel, conceptHasExplanation, fitConceptMapViewport, constrainConceptMapViewport, focusConceptMapViewport } from '../public/concept-map.js';

const graph = {
  mode: 'concepts', rootId: 'knowledge:root',
  nodes: [
    { id: 'knowledge:root', title: 'Ядро', kind: 'category', parentId: null },
    { id: 'category:world', title: 'Мир', kind: 'category', parentId: 'knowledge:root' },
    { id: 'category:rules', title: 'Правила', kind: 'category', parentId: 'category:world' },
    { id: 'term:aura', title: 'Аура', kind: 'concept', parentId: 'category:rules', summary: 'Световое поле', sourceRefs: [{ path: 'world/aura.md' }] },
    { id: 'category:history', title: 'История', kind: 'category', parentId: 'knowledge:root' },
    { id: 'term:plot', title: 'Завязка', kind: 'concept', parentId: 'category:history', sourceRefs: [{ path: 'plot.md' }] }
  ],
  edges: [{ source: 'term:aura', target: 'term:plot', kind: 'related' }]
};

test('display preserves author titles rather than inventing shorter terminology', () => {
  for (const title of ['Уровень мага по его магическим кругам','Сила магии по уровню разрушительного воздействия']) {
    assert.equal(conceptMapLabel({title}),title);
    const data={nodes:[{id:'term',title}]};
    assert.ok(filterConceptIds(data,conceptMapLabel({title})).has('term'));
  }
});

test('parentId alone defines containment; a related edge never becomes a parent', () => {
  const { roots, byId } = buildConceptHierarchy(graph);
  assert.deepEqual(roots.map(node => node.id), ['knowledge:root']);
  assert.deepEqual(roots[0].children.map(node => node.id), ['category:world', 'category:history']);
  assert.deepEqual(byId.get('category:rules').children.map(node => node.id), ['term:aura']);
  assert.equal(byId.get('term:aura').children.length, 0);
});

test('search returns matching nodes and their full containment paths', () => {
  assert.deepEqual([...filterConceptIds(graph, 'световое')].sort(), ['category:rules', 'category:world', 'knowledge:root', 'term:aura']);
  assert.deepEqual([...filterConceptIds(graph, 'завязка')].sort(), ['category:history', 'knowledge:root', 'term:plot']);
  assert.equal(filterConceptIds(graph, 'несуществующий').size, 0);
});

test('XMind geometry fixture keeps World left, History right, and Russian core text inside two measured lines', () => {
  const fixture = { rootId: 'root', nodes: [
    { id: 'root', title: 'Мир под гнетом магии', parentId: null },
    { id: 'world', title: 'World', parentId: 'root' },
    { id: 'history', title: 'History', parentId: 'root' }
  ] };
  const layout = layoutConceptTree(fixture, new Set(['root']), 1000);
  const core = layout.positions.get('root'), world = layout.positions.get('world'), history = layout.positions.get('history');
  assert.deepEqual(core.lines, ['Мир под гнетом', 'магии']);
  assert.equal(core.width, 240);
  assert.equal(core.height, 240);
  assert.equal(core.x, 334);
  assert.equal(world.x, 107);
  assert.equal(world.y, 213);
  assert.equal(history.x, 561);
  assert.equal(history.y, 91);
});

test('collapsed parents retain progressively flatter ovals and only full-tree leaves stay unenclosed', () => {
  const appearance=conceptMapAppearance(graph);
  assert.equal(appearance.get('category:rules').shape,'oval');
  assert.equal(appearance.get('term:aura').shape,'terminal-unenclosed');
  const layout=layoutConceptTree(graph,new Set(['knowledge:root','category:world']));
  const rules=layout.positions.get('category:rules');
  assert.equal(rules.hasChildren,true);
  assert.equal(rules.width/rules.height,2);
  const world=layout.positions.get('category:world'),core=layout.positions.get('knowledge:root');
  assert.equal(core.width/core.height,1);
  assert.equal(world.width/world.height,1.5);
  assert.ok(rules.width/rules.height>world.width/world.height);
  assert.equal(layout.positions.has('term:aura'),false);
});

test('thematic spectrum follows full category identity independently of node order and view', () => {
  const palette=conceptMapAppearance(graph);
  assert.notEqual(palette.get('category:world').hue,palette.get('category:history').hue);
  assert.notEqual(palette.get('category:world').hue,palette.get('category:rules').hue);
  const reordered=conceptMapAppearance({...graph,nodes:[...graph.nodes].reverse()});
  for(const node of graph.nodes) assert.deepEqual(reordered.get(node.id),palette.get(node.id));
  const visible=new Set(['knowledge:root','category:world','category:rules','term:aura']);
  layoutConceptTree(graph,visible,1000,visible);
  assert.deepEqual(conceptMapAppearance(graph),palette);
});

test('reported tall desktop viewport fills available height beyond the old 620px cap', () => {
  const viewportHeight=1219,stageTop=323.671875;
  const height=conceptMapAvailableHeight(viewportHeight,stageTop);
  assert.ok(height>620);
  assert.equal(stageTop+height,viewportHeight-16);
  assert.ok(conceptMapAvailableHeight(720,358.671875)>=320);
});

test('expanded tree keeps every sibling with independent vertical lanes on both sides', () => {
  const many = { rootId: 'r', nodes: [{ id: 'r', parentId: null, title: 'Root' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `term:${i}`, title: `Term ${i}`, parentId: 'r' }))] };
  const layout = layoutConceptTree(many, new Set(['r']), 1000);
  assert.equal(layout.visibleNodes.length, 31);
  assert.equal(layout.edges.length, 30);
  assert.equal(new Set([...layout.positions.values()].map(point => `${point.x},${point.y}`)).size, 31);
  assert.equal(layout.positions.get('r').y, layout.centerY);
  for (const side of [-1, 1]) {
    const ys = layout.visibleNodes.filter(node => layout.positions.get(node.id).side === side).map(node => layout.positions.get(node.id).y).sort((a, b) => a - b);
    assert.ok(ys.length > 0);
    const sideNodes = layout.visibleNodes.filter(node => layout.positions.get(node.id).side === side).map(node => layout.positions.get(node.id)).sort((a, b) => a.y - b.y);
    assert.ok(sideNodes.slice(1).every((point, index) => point.y - sideNodes[index].y >= (point.height + sideNodes[index].height) / 2));
  }
  assert.ok(layout.height < 1300);
});

test('root is centered and top-level branches grow outward on both sides', () => {
  const expanded = new Set(['knowledge:root', 'category:world', 'category:history', 'category:rules']);
  const layout = layoutConceptTree(graph, expanded, 1000);
  assert.deepEqual(layout.visibleNodes.map(node => node.id), ['knowledge:root', 'category:history', 'term:plot', 'category:world', 'category:rules', 'term:aura']);
  assert.equal(layout.positions.get('knowledge:root').x, layout.centerX);
  assert.equal(layout.positions.get('knowledge:root').y, layout.centerY);
  assert.ok(layout.positions.get('category:world').x < layout.centerX);
  assert.ok(layout.positions.get('category:history').x > layout.centerX);
  assert.notEqual(layout.positions.get('category:world').y, layout.positions.get('category:history').y);
  assert.ok(layout.positions.get('term:aura').x < layout.positions.get('category:rules').x);
  assert.ok(layout.positions.get('term:plot').x > layout.positions.get('category:history').x);
  assert.equal(layout.positions.get('term:aura').y, layout.positions.get('category:rules').y);
  assert.equal(layout.positions.get('term:plot').y, layout.positions.get('category:history').y);
  assert.equal(layout.edges.length, 5);
  assert.equal(layout.nodeWidth, 150);
});

test('uneven child clusters stay centered on their own parent nodes', () => {
  const asymmetric = { rootId: 'r', nodes: [
    { id: 'r', parentId: null, title: 'Core' },
    { id: 'left', parentId: 'r', title: 'Left' },
    { id: 'right', parentId: 'r', title: 'Right' },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `l${i}`, parentId: 'left', title: `Left ${i}` })),
    { id: 'r1', parentId: 'right', title: 'Right child' }
  ] };
  const layout = layoutConceptTree(asymmetric, new Set(['r', 'left', 'right']), 1000);
  const leftYs = asymmetric.nodes.filter(node => node.parentId === 'left').map(node => layout.positions.get(node.id).y);
  const leftY = layout.positions.get('left').y;
  assert.ok(Math.abs((Math.min(...leftYs) + Math.max(...leftYs)) / 2 - leftY) < 1);
  assert.equal(layout.positions.get('r1').y, layout.positions.get('right').y);
});

test('fit and every viewport constraint preserve readable scale on large graphs and resize', () => {
  const viewport = { width: 900, height: 400 }, core = { x: 0, y: 0 };
  const huge = fitConceptMapViewport({ left: -10000, right: 10000, top: -20000, bottom: 20000 }, viewport, core);
  assert.equal(huge.scale, .5);
  assert.ok(huge.scale <= 1);
  assert.equal(huge.x + huge.width / 2, core.x);
  assert.equal(huge.y + huge.height / 2, core.y);
  const ordinary = fitConceptMapViewport({ left: -100, right: 100, top: -60, bottom: 60 }, viewport, core);
  assert.ok(ordinary.scale >= .5);
  assert.ok(ordinary.width >= viewport.width);
  const zoomedOut = constrainConceptMapViewport({ x: -5000, y: -3000, width: 9000, height: 4000 }, viewport);
  assert.equal(zoomedOut.scale, .5);
  const zoomedIn = constrainConceptMapViewport({ x: -10, y: -10, width: 10, height: 10 }, viewport);
  assert.equal(zoomedIn.scale, 3);
  const resized = constrainConceptMapViewport(zoomedOut, { width: 500, height: 500 });
  assert.equal(resized.scale, .5);
  assert.equal(resized.height, resized.width);
});

test('collapsing a deep chain keeps the root position stable and preserves camera scale', () => {
  const nodes = Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, parentId: index ? `n${index - 1}` : null, title: `Node ${index}` }));
  const deep = { rootId: 'n0', nodes }, viewport = { width: 500, height: 330 };
  const expanded = layoutConceptTree(deep, new Set(nodes.slice(0, -1).map(node => node.id)), viewport.width);
  const collapsed = layoutConceptTree(deep, new Set(), viewport.width);
  const previous = expanded.positions.get('n0'), next = collapsed.positions.get('n0');
  assert.equal(previous.x, next.x);
  const beforeCollapse = focusConceptMapViewport({ x: 0, y: 0, width: 500 }, viewport, previous);
  const afterCollapse = focusConceptMapViewport(beforeCollapse, viewport, next);
  assert.equal(afterCollapse.x + afterCollapse.width / 2, next.x);
  assert.equal(afterCollapse.y + afterCollapse.height / 2, next.y);
  assert.equal(afterCollapse.width, beforeCollapse.width);
});

test('search visibility keeps the original branch side and ancestor links', () => {
  const visible = new Set(['knowledge:root', 'category:history', 'term:plot']);
  const layout = layoutConceptTree(graph, visible, 1000, visible);
  assert.deepEqual(layout.visibleNodes.map(node => node.id), ['knowledge:root', 'category:history', 'term:plot']);
  assert.ok(layout.positions.get('category:history').x > layout.centerX);
  assert.ok(layout.positions.get('term:plot').x > layout.positions.get('category:history').x);
  assert.deepEqual(layout.edges, [
    { source: 'knowledge:root', target: 'category:history', kind: 'contains' },
    { source: 'category:history', target: 'term:plot', kind: 'contains' }
  ]);
  const worldPath = new Set(['knowledge:root', 'category:world', 'category:rules', 'term:aura']);
  const worldOnly = layoutConceptTree(graph, worldPath, 1000, worldPath);
  assert.equal(worldOnly.positions.get('category:world').side, -1);
  assert.ok(worldOnly.positions.get('category:world').x < worldOnly.positions.get('knowledge:root').x);
});

test('filtering uneven multi-branch trees preserves each original branch side', () => {
  const nodes = [{ id: 'r', title: 'Root' }, ...['a','b','c','d'].map(id => ({ id, title: id, parentId: 'r' })),
    ...Array.from({length:12}, (_,i) => ({id:`a${i}`,title:`a child ${i}`,parentId:'a'})),
    {id:'b1',title:'b child',parentId:'b'}, {id:'c1',title:'c child',parentId:'c'}, {id:'d1',title:'d child',parentId:'d'}];
  const data = {rootId:'r',nodes};
  const all = new Set(nodes.map(n=>n.id));
  const baseline = layoutConceptTree(data,all);
  for (const branch of ['a','b','c','d']) {
    const visible = new Set(['r',branch,...nodes.filter(n=>n.parentId===branch).map(n=>n.id)]);
    const filtered = layoutConceptTree(data,visible,1000,visible);
    assert.equal(filtered.positions.get(branch).side,baseline.positions.get(branch).side);
    assert.equal(Math.sign(filtered.positions.get(branch).x-filtered.positions.get('r').x),baseline.positions.get(branch).side);
  }
  const shallow = new Set(['r','a','b','c','d']);
  const filtered = layoutConceptTree(data,shallow,1000,shallow);
  for (const branch of ['a','b','c','d']) assert.equal(filtered.positions.get(branch).side,baseline.positions.get(branch).side);
});

test('source-path lookup retains ambiguous bindings', () => {
  const duplicate = buildConceptHierarchy({ nodes: [
    { id: 'a', parentId: null, sourceRefs: [{ path: 'same.md' }] },
    { id: 'b', parentId: null, sourceRefs: [{ path: 'same.md' }] }
  ] });
  assert.deepEqual(duplicate.byPath.get('same.md').map(node => node.id), ['a', 'b']);
  assert.equal(buildConceptHierarchy({ nodes: [{ id: 'no-path', sourceRefs: [{}] }] }).byPath.size, 0);
});

test('terms with explanation data remain actionable even when their kind is category', () => {
  assert.equal(conceptHasExplanation({ kind: 'category', definition: 'Literal definition' }), true);
  assert.equal(conceptHasExplanation({ kind: 'category', definitions: [{ text: 'Versioned explanation' }] }), true);
  assert.equal(conceptHasExplanation({ kind: 'category', sourceRefs: [{ path: 'Source.md' }] }), true);
  assert.equal(conceptHasExplanation({ kind: 'category', definition: '', sourceRefs: [] }), false);
  assert.equal(conceptHasExplanation({ kind: 'concept', definition: '' }), true);
});
