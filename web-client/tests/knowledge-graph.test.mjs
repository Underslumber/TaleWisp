import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKnowledgeGraph } from '../knowledge-graph.mjs';
import { createWorkspaceService } from '../workspace.mjs';

test('graph uses stable relative ids, folders, resolved wikilinks, and reports unresolved and ambiguous targets', () => {
  const files = [
    { path: 'deep/one/Source.md', text: '---\ntitle: Shared\ntype: person\nstatus: confirmed\nrecord_kind: entity\n---\n[[Target]] [[Target]] [[Missing]] [[Thing]] [[Source]]' },
    { path: 'deep/one/Twin.md', text: '# Twin' },
    { path: 'deep/two/Twin.md', text: '# Twin' },
    { path: 'deep/one/Target.md', text: '# Target' },
    { path: 'deep/one/sub/Thing.md', text: '# Thing' },
    { path: 'deep/two/Thing.md', text: '# Thing' }
  ];
  const index = new Map(files.map(file => [file.path, file]));
  const graph = buildKnowledgeGraph({ files, resolveTarget(target, from) {
    const normalized = target.replace(/^\.\//, '');
    const sameFolder = from.slice(0, from.lastIndexOf('/') + 1) + normalized + '.md';
    if (index.has(sameFolder)) return { status: 'resolved', path: sameFolder };
    const matches = files.filter(file => file.path.endsWith(`/${normalized}.md`));
    return matches.length === 1 ? { status: 'resolved', path: matches[0].path } : { status: matches.length ? 'ambiguous' : 'missing' };
  } });
  assert.deepEqual(graph.nodes.map(node => node.id), [...files.map(file => file.path)].sort((a, b) => a.localeCompare(b, 'ru')));
  assert.equal(graph.nodes[0].title, 'Shared');
  assert.equal(graph.nodes[0].type, 'person');
  assert.equal(graph.nodes[0].recordKind, 'entity');
  assert.equal(graph.nodes[0].status, 'confirmed');
  assert.equal(graph.nodes[0].linksCount, 5);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].source, 'deep/one/Source.md');
  assert.equal(graph.edges[0].target, 'deep/one/Target.md');
  assert.equal(graph.edges[0].kind, 'wikilink');
  assert.equal(graph.unresolvedCount, 1);
  assert.equal(graph.ambiguousCount, 1);
  assert.ok(graph.nodes.some(node => node.id === 'deep/one/Twin.md'));
  assert.ok(graph.groups.some(group => group.id === 'folder:deep/one' && group.parentId === 'folder:deep'));
  assert.equal(graph.nodes[0].groupId, 'folder:deep/one');
});

test('graph bounds nodes and edges and does not invent links or self loops', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, text: `[[f${(i + 1) % 5}]] [[f${(i + 1) % 5}]] [[f${i}]]` }));
  const graph = buildKnowledgeGraph({ files, maxNodes: 4, maxEdges: 2, resolveTarget: target => ({ status: 'resolved', path: `${target}.md` }) });
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.totalNodes, 5);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.truncated, true);
  assert.ok(graph.edges.every(edge => edge.source !== edge.target));
});

test('workspace graph respects selected book, unassigned scope, private paths, and leaves sources unchanged', async () => {
  const base = mkdtempSync(join(tmpdir(), 'talewisp-knowledge-'));
  const catalogRoot = join(base, 'vault');
  const series = join(catalogRoot, '00 Автор', 'Author', 'Series');
  const write = (relative, text) => {
    const path = join(series, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
    return path;
  };
  try {
    write('00 Паспорт серии.md', '# Series');
    write('01 Книги/Book One/Book One.md', '---\ntitle: Book One\nbook_id: b1\n---\n[[Hero]]');
    write('01 Книги/Book Two/Book Two.md', '---\ntitle: Book Two\nbook_id: b2\n---\n[[Hero]]');
    write('01 Книги/Book One/Hero.md', '---\ntitle: Shared Hero\nbook_id: b1\n---\n# One');
    write('01 Книги/Book Two/Hero.md', '---\ntitle: Shared Hero\nbook_id: b2\n---\n# Two');
    write('World.md', '# Shared world');
    write('World Bound.md', '---\nbook_id: b2\n---\n# Other book detail');
    write('Shared/First/Twin.md', '# First twin');
    write('Shared/Second/Twin.md', '# Second twin');
    write('Shared/Reference.md', '[[Twin]]');
    write('Secrets/Private.md', '# Private');
    const unassigned = join(catalogRoot, 'Legacy');
    mkdirSync(unassigned, { recursive: true });
    writeFileSync(join(unassigned, 'Legacy.md'), '# Legacy record\n[[Missing]]', 'utf8');
    mkdirSync(join(unassigned, '.hidden'), { recursive: true });
    writeFileSync(join(unassigned, '.hidden', 'Hidden.md'), '# Hidden', 'utf8');
    const sourceFiles = [
      join(series, '00 Паспорт серии.md'), join(series, '01 Книги/Book One/Book One.md'),
      join(series, '01 Книги/Book Two/Book Two.md'), join(series, '01 Книги/Book One/Hero.md'),
      join(series, '01 Книги/Book Two/Hero.md'), join(series, 'World.md'), join(series, 'World Bound.md'),
      join(series, 'Secrets/Private.md'), join(unassigned, 'Legacy.md')
    ];
    const before = sourceFiles.map(path => readFileSync(path, 'utf8'));
    const values = new Map();
    const store = { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => values.set(key, value), listWorkspaceProposals: () => [] };
    const service = createWorkspaceService({ catalogVaultPath: catalogRoot, initialVaultPath: null, store, dataDir: join(base, 'data') });
    const catalog = service.catalog();
    const author = catalog.authors[0], seriesEntry = author.series[0], book = seriesEntry.books.find(item => item.name === 'Book One');
    await service.select({ authorId: author.id, seriesId: seriesEntry.id, bookId: book.id });
    const activeGraph = service.graph();
    assert.equal(activeGraph.mode, 'concepts');
    assert.equal(activeGraph.diagnostics.status, 'outline-missing');
    assert.ok(activeGraph.nodes.some(node => node.id === 'category:world'));
    assert.ok(activeGraph.nodes.every(node => !node.path));
    assert.deepEqual(activeGraph.selection, { authorId: author.id, seriesId: seriesEntry.id, bookId: book.id });
    const legacyGraph = service.graph({ scope: 'unassigned' });
    assert.deepEqual(legacyGraph.nodes, []);
    assert.equal(legacyGraph.diagnostics.status, 'unassigned');
    assert.equal(legacyGraph.selection, null);
    assert.ok(!JSON.stringify(activeGraph).includes(series));
    assert.ok(!JSON.stringify(activeGraph).includes(catalogRoot));
    assert.deepEqual(sourceFiles.map(path => readFileSync(path, 'utf8')), before);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
