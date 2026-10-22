import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeTree, filterKnowledgePaths, fitKnowledgeView, knowledgeNeighbors, layoutKnowledgeGraph } from '../public/knowledge-map.js';

const graph = {
  scope: 'active',
  groups: [
    { id: 'folder:Люди', label: 'Люди', parentId: null },
    { id: 'folder:Люди/Дом', label: 'Дом', parentId: 'folder:Люди' },
    { id: 'folder:Места', label: 'Места', parentId: null }
  ],
  nodes: [
    { id: 'Люди/Дом/Лея.md', path: 'Люди/Дом/Лея.md', title: 'Лея', type: 'character', groupId: 'folder:Люди/Дом', linksCount: 2 },
    { id: 'Люди/Дом/Марк.md', path: 'Люди/Дом/Марк.md', title: 'Марк', type: 'character', groupId: 'folder:Люди/Дом', linksCount: 2 },
    { id: 'Места/Дом.md', path: 'Места/Дом.md', title: 'Дом', type: 'location', groupId: 'folder:Места', linksCount: 1 },
    { id: 'Мир/Правила.md', path: 'Мир/Правила.md', title: '<img src=x onerror=alert(1)>', type: 'world', groupId: null, linksCount: 0 }
  ],
  edges: [
    { id: 'a', source: 'Люди/Дом/Лея.md', target: 'Люди/Дом/Марк.md', kind: 'wikilink' },
    { id: 'b', source: 'Люди/Дом/Марк.md', target: 'Места/Дом.md', kind: 'wikilink' },
    { id: 'c', source: 'Места/Дом.md', target: 'Люди/Дом/Лея.md', kind: 'wikilink' }
  ]
};

test('folder tree preserves real hierarchy and duplicate display labels by path', () => {
  const { roots, byPath } = buildKnowledgeTree(graph);
  const people = roots.find(item => item.id === 'folder:Люди');
  const places = roots.find(item => item.id === 'folder:Места');
  assert.equal(people.children[0].records[0].path, 'Люди/Дом/Лея.md');
  assert.equal(byPath.get('Люди/Дом/Лея.md').title, 'Лея');
  assert.equal(places.records[0].title, people.children[0].label);
});

test('search matches title and path and can combine record-type filters', () => {
  assert.deepEqual([...filterKnowledgePaths(graph, 'дом')].sort(), ['Люди/Дом/Лея.md', 'Люди/Дом/Марк.md', 'Места/Дом.md']);
  assert.deepEqual([...filterKnowledgePaths(graph, 'Люди/Дом', 'character')].sort(), ['Люди/Дом/Лея.md', 'Люди/Дом/Марк.md']);
  assert.equal(filterKnowledgePaths(graph, 'не существует').size, 0);
});

test('neighbor focus is one hop even when links form a cycle', () => {
  assert.deepEqual([...knowledgeNeighbors(graph, 'Люди/Дом/Лея.md')].sort(), ['Люди/Дом/Марк.md', 'Места/Дом.md']);
  assert.deepEqual([...knowledgeNeighbors(graph, 'нет записи')], []);
});

test('layout is deterministic, unique, bounded, and safe for a larger graph', () => {
  const larger = {
    groups: [{ id: 'folder:Notes', label: 'Notes', parentId: null }],
    nodes: Array.from({ length: 500 }, (_, index) => ({ path: `Notes/${index}.md`, groupId: 'folder:Notes', linksCount: index % 11 })),
    edges: []
  };
  const first = layoutKnowledgeGraph(larger), second = layoutKnowledgeGraph(larger);
  assert.equal(first.positions.size, 500);
  assert.deepEqual(first.positions.get('Notes/249.md'), second.positions.get('Notes/249.md'));
  const points = [...first.positions.values()];
  assert.equal(new Set(points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`)).size, 500);
  assert.ok(points.every(point => point.x >= 0 && point.x <= first.width && point.y >= 0 && point.y <= first.height));
});

test('fit uses occupied node bounds and preserves the viewport aspect ratio', () => {
  const layout = layoutKnowledgeGraph({ nodes: [{ path: 'only.md' }, { path: 'near.md' }, { path: 'far.md' }], groups: [], edges: [] });
  const view = fitKnowledgeView(layout, 700, 480);
  const point = layout.positions.get('only.md');
  assert.ok(point.x > view.x && point.x < view.x + view.width);
  assert.ok(point.y > view.y && point.y < view.y + view.height);
  assert.ok(Math.abs(view.width / view.height - 700 / 480) < 1e-9);
  assert.equal(fitKnowledgeView(layout, 0, 480), null);
  const subset = fitKnowledgeView(layout, 700, 480, ['only.md', 'near.md']);
  assert.ok(subset.width < view.width);
  for (const path of ['only.md', 'near.md']) {
    const neighbor = layout.positions.get(path);
    assert.ok(neighbor.x > subset.x && neighbor.x < subset.x + subset.width);
    assert.ok(neighbor.y > subset.y && neighbor.y < subset.y + subset.height);
  }
});
