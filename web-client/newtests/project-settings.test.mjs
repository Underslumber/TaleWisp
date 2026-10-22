import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { openStore } from '../store.mjs';
import { applyBookMigration, createWorkspaceService, planBookMigration, rollbackBookMigration, scanVaultCatalog } from '../workspace.mjs';
import { scopeKey } from '../workspace-scope.mjs';
import { createApplication } from '../server.mjs';
import { checkConfirmedAllocation, parseArgs } from '../scripts/migrate-book-attachments.mjs';

const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text, 'utf8'); };
const vaultFiles = dir => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).filter(path => statSync(join(dir, path)).isFile()).sort().map(path => [path, readFileSync(join(dir, path), 'utf8')]));
const JOURNAL = 'storyart.partnerJournal.v1';

// Vault: author Writer with series "Series" (books) and "Other" (one book). Optional Google bindings by logical book ID.
function fixture(t, { books = ['Part 1', 'Part 2'], google = {}, initial = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tw-project-settings-'));
  const vault = join(root, 'vault'), dataDir = join(root, 'data');
  const author = join(vault, '00 Автор', 'Writer'), series = join(author, 'Series'), other = join(author, 'Other');
  put(join(author, 'Автор.md'), '---\ntitle: Writer\n---\n# Writer');
  put(join(series, '00 Паспорт серии.md'), '---\ntitle: Series\n---\n# Series');
  put(join(other, '00 Паспорт серии.md'), '---\ntitle: Other\n---\n# Other');
  books.forEach((name, i) => put(join(series, '01 Книги', name, name + '.md'), `---\ntitle: ${name}\nbook_id: B${i + 1}\n---\n# ${name}\n\nText of ${name}.`));
  put(join(other, '01 Книги', 'Side book', 'Side book.md'), '---\ntitle: Side book\nbook_id: S1\n---\n# Side book');
  for (const [logical, documentId] of Object.entries(google)) put(join(series, '00 Источники', logical + '.json'), JSON.stringify({ book_id: logical, metadata: { title: logical, document_id: '', source_path: '', provenance: { origin: `https://docs.google.com/document/d/${documentId}/edit`, extractor: 'fixture' } }, chapters: [] }));
  const calls = { select: [], detach: 0 }, flags = { busy: false, failSelect: null };
  const f = { root, vault, dataDir, series, other, calls, flags, store: openStore(dataDir) };
  f.workspace = () => createWorkspaceService({ catalogVaultPath: vault, initialVaultPath: initial ? series : undefined, store: f.store, dataDir,
    isAgentRunning: () => false, isAgentBusy: () => flags.busy,
    onSelect: async workspace => { if (flags.failSelect) throw new Error(flags.failSelect); calls.select.push(workspace); },
    onDetach: () => { calls.detach++; } });
  f.reopen = () => { f.store.close(); f.store = openStore(dataDir); return f.workspace(); };
  t.after(() => { try { f.store.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return f;
}
const rev = ws => ws.project.view().revision;
const named = (rows, name) => rows.find(row => row.name === name);

test('a standalone book exists without Google Docs, keeps its ID on rename, survives reopening and selects with no vault', async t => {
  const f = fixture(t, { initial: false }); let ws = f.workspace();
  const author = (await ws.project.createAuthor({ name: 'Новый автор', expectedRevision: rev(ws) })).created;
  const series = (await ws.project.createSeries({ name: 'Новая серия', authorId: author.id, expectedRevision: rev(ws) })).created;
  const book = (await ws.project.createBook({ name: 'Самостоятельная книга', seriesId: series.id, expectedRevision: rev(ws) })).created;
  await ws.project.updateBook(book.id, { name: 'Переименованная книга', expectedRevision: rev(ws) });

  ws = f.reopen();
  const view = ws.project.view();
  const stored = view.books.find(row => row.id === book.id);
  assert.deepEqual([stored.name, stored.origin, stored.seriesId, stored.attachmentCount, stored.archivedCount], ['Переименованная книга', 'logical', series.id, 0, 0]);
  assert.equal(view.books.filter(row => row.origin === 'logical').length, 1, 'rename does not create another entity');
  assert.equal(view.series.find(row => row.id === series.id).hasKnowledgeBase, false);
  const catalogBook = ws.catalog().authors.find(row => row.id === author.id).series[0].books[0];
  assert.deepEqual(catalogBook.attachments, []);
  assert.equal(Object.hasOwn(catalogBook, 'googleDocumentId'), false);

  const catalog = await ws.select({ authorId: author.id, seriesId: series.id, bookId: book.id });
  assert.equal(catalog.active.bookId, book.id);
  const call = f.calls.select.at(-1);
  assert.equal(call.vaultPath, null, 'a book without a vault knowledge base never reuses an old vault');
  assert.equal(call.selection.bookId, book.id);
  assert.equal(ws.root(), null);
  assert.equal(ws.agentContext().status, 'ready');
  const overview = await ws.overview();
  assert.deepEqual([overview.attachments, overview.manuscripts, overview.notes], [[], [], []]);
  assert.deepEqual(ws.cards().cards, []);
  assert.equal(ws.graph().diagnostics.status, 'outline-missing');
  assert.throws(() => ws.prepareProposal({ path: 'Глава.md', text: 'x' }), { status: 409 });
  assert.deepEqual(JSON.parse(f.store.getSetting('workspace.selection')), { authorId: author.id, seriesId: series.id, bookId: book.id });
});

test('companion files attach, rename, move, archive and restore one link at a time and persist', async t => {
  const f = fixture(t, { initial: false }); let ws = f.workspace();
  const before = vaultFiles(f.vault);
  const v = ws.project.view(), part1 = named(v.books, 'Part 1'), part2 = named(v.books, 'Part 2');
  const url = 'https://docs.google.com/document/d/SharedDoc_1234567/edit';
  const first = (await ws.project.attach({ bookId: part1.id, googleDocument: url, expectedRevision: rev(ws) })).created.id;
  const second = (await ws.project.attach({ bookId: part2.id, googleDocument: 'SharedDoc_1234567', name: 'Общий план', expectedRevision: rev(ws) })).created.id;
  await assert.rejects(ws.project.attach({ bookId: part1.id, googleDocument: url, expectedRevision: rev(ws) }), { status: 409, code: 'attachment_exists' });
  await assert.rejects(ws.project.attach({ bookId: part1.id, googleDocument: 'https://evil.example/document/d/SharedDoc_1234567/edit', expectedRevision: rev(ws) }), { status: 400 });
  await assert.rejects(ws.project.attach({ bookId: 'missing', googleDocument: url, expectedRevision: rev(ws) }), { status: 400 });
  const file = (await ws.project.attach({ bookId: part1.id, sourcePath: '00 Паспорт серии.md', expectedRevision: rev(ws) })).created.id;
  await assert.rejects(ws.project.attach({ bookId: part1.id, sourcePath: '../Other/00 Паспорт серии.md', expectedRevision: rev(ws) }));
  await ws.project.updateAttachment(first, { name: 'Черновик в Google Docs', expectedRevision: rev(ws) });

  const archived = await ws.project.archiveAttachment(first, { expectedRevision: rev(ws) });
  assert.deepEqual(archived.project.archived.map(row => [row.id, row.name, row.bookName, row.seriesName]), [[first, 'Черновик в Google Docs', 'Part 1', 'Series']]);
  assert.ok(archived.project.attachments.some(row => row.id === second && row.googleDocumentId === 'SharedDoc_1234567'), 'the same Google Doc linked to another book stays visible');
  const catalogPart1 = archived.catalog.authors[0].series.find(row => row.name === 'Series').books.find(row => row.id === part1.id);
  assert.deepEqual(catalogPart1.attachments.map(row => row.id), [file], 'an archived link leaves the working list');
  await assert.rejects(ws.project.archiveAttachment(first, { expectedRevision: rev(ws) }), { status: 409, code: 'already_archived' });
  await assert.rejects(ws.project.attach({ bookId: part1.id, googleDocument: url, expectedRevision: rev(ws) }), { status: 409, code: 'attachment_exists' });

  ws = f.reopen();
  let view = ws.project.view();
  assert.deepEqual(view.archived.map(row => row.id), [first], 'the archive survives a reopened database');
  const fileRow = view.attachments.find(row => row.id === file);
  assert.deepEqual([fileRow.kind, fileRow.path, fileRow.sourcePath], ['vault-file', '00 Автор/Writer/Series/00 Паспорт серии.md', '00 Паспорт серии.md']);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(f.root) && !text.includes(JSON.stringify(f.root).slice(1, -1)), 'no absolute paths are exposed');

  await ws.project.restoreAttachment(first, { expectedRevision: rev(ws) });
  await assert.rejects(ws.project.restoreAttachment(first, { expectedRevision: rev(ws) }), { status: 409, code: 'not_archived' });
  view = ws.project.view();
  assert.deepEqual(view.archived, []);
  assert.equal(view.attachments.find(row => row.id === first).name, 'Черновик в Google Docs');

  await ws.project.updateAttachment(file, { bookId: part2.id, expectedRevision: rev(ws) });
  await assert.rejects(ws.project.updateAttachment(first, { bookId: part2.id, expectedRevision: rev(ws) }), { status: 409, code: 'attachment_exists' });
  view = ws.project.view();
  assert.equal(view.attachments.find(row => row.id === file).bookId, part2.id);
  assert.deepEqual([named(view.books, 'Part 1').attachmentCount, named(view.books, 'Part 2').attachmentCount], [1, 2]);
  assert.deepEqual(vaultFiles(f.vault), before, 'vault files are never written, moved or renamed');
});

test('stale revisions, foreign IDs, unknown fields and a busy agent are refused before any write', async t => {
  const f = fixture(t); const ws = f.workspace(), windowB = f.workspace();
  const before = ws.project.view(), book = named(before.books, 'Part 1'), series = named(before.series, 'Series');
  await assert.rejects(ws.project.updateBook(book.id, { name: 'X', expectedRevision: before.revision + 5 }), { status: 409, code: 'project_conflict' });
  await assert.rejects(ws.project.updateBook(book.id, { seriesId: 'not-a-series', expectedRevision: before.revision }), { status: 400 });
  await assert.rejects(ws.project.updateBook('missing-book', { name: 'X', expectedRevision: before.revision }), { status: 400 });
  await assert.rejects(ws.project.updateBook(book.id, { name: 'X', path: '/etc', expectedRevision: before.revision }), { status: 400 });
  await assert.rejects(ws.project.updateBook(book.id, { name: 'X' }), { status: 400 });
  await assert.rejects(ws.project.updateBook(book.id, { name: '   ', expectedRevision: before.revision }), { status: 400 });
  await assert.rejects(ws.project.createSeries({ name: 'S', authorId: 'foreign', expectedRevision: before.revision }), { status: 400 });
  await assert.rejects(ws.project.updateSeries(series.id, { authorId: 'foreign', expectedRevision: before.revision }), { status: 400 });
  f.flags.busy = true;
  await assert.rejects(ws.project.updateBook(book.id, { name: 'X', expectedRevision: before.revision }), { status: 409, code: 'agent_busy' });
  await assert.rejects(ws.select({ authorId: series.authorId, seriesId: series.id, bookId: named(before.books, 'Part 2').id }), { status: 409 });
  f.flags.busy = false;
  assert.deepEqual(ws.project.view(), before);
  assert.deepEqual(f.store.project.exportData().changes, []);

  // Two windows edit the same revision: the second save is a conflict, not a silent overwrite.
  await ws.project.updateBook(book.id, { name: 'Из первого окна', expectedRevision: before.revision });
  await assert.rejects(windowB.project.updateBook(book.id, { name: 'Из второго окна', expectedRevision: before.revision }), { status: 409, code: 'project_conflict' });
  assert.equal(named(windowB.project.view().books, 'Из первого окна').id, book.id);
});

test('moving the open book needs confirmation, moves every scoped row in one transaction and switches context after commit', async t => {
  const f = fixture(t); const ws = f.workspace();
  const v = ws.project.view(), series = named(v.series, 'Series'), other = named(v.series, 'Other'), book = named(v.books, 'Part 1');
  assert.equal(ws.catalog().active.bookId, book.id);
  const from = { authorId: series.authorId, seriesId: series.id, bookId: book.id }, to = { ...from, seriesId: other.id };
  const neighbour = { ...from, bookId: named(v.books, 'Part 2').id };
  const doc = f.store.createDocument({ title: 'Draft', text: 'draft text', ...from });
  const kept = f.store.createDocument({ title: 'Neighbour', text: 'other book', ...neighbour });
  const note = f.store.createNote({ title: 'Note', text: 'note', ...from });
  f.store.addMessage('user', 'hello', scopeKey(from));
  f.store.saveWorkspaceProposal({ id: 'p1', state: 'pending', ...from, path: null, text: 'x' });
  f.store.setSetting('agent.delegations.' + scopeKey(from), JSON.stringify([{ id: 'd1' }]));
  f.store.setSetting(JOURNAL, JSON.stringify({ version: 1, requests: { r1: { scope: scopeKey(from), status: 'done' }, r2: { scope: scopeKey(neighbour), status: 'done' } } }));
  const selectCalls = f.calls.select.length, revisionBefore = ws.revision();

  await assert.rejects(ws.project.updateBook(book.id, { seriesId: other.id, expectedRevision: v.revision }), { status: 409, code: 'active_confirmation_required' });
  assert.equal(f.store.getDocument(doc.id).seriesId, series.id);
  assert.equal(rev(ws), v.revision);
  assert.equal(f.calls.select.length, selectCalls);

  const result = await ws.project.updateBook(book.id, { seriesId: other.id, expectedRevision: v.revision, confirmActive: true });
  assert.deepEqual([result.activeChanged, result.warning, result.agentContext.status], [true, null, 'ready']);
  assert.deepEqual(result.moved[0].counts, { documents: 1, notes: 1, messages: 1, proposals: 1, delegations: 1, storyart: 1 });
  assert.equal(f.store.getDocument(doc.id).seriesId, other.id);
  assert.equal(f.store.documentHistory(doc.id).length, 1, 'draft history stays with the draft');
  assert.equal(f.store.getNote(note.id).seriesId, other.id);
  assert.deepEqual(f.store.getDocument(kept.id).bookId, neighbour.bookId);
  assert.equal(f.store.getDocument(kept.id).seriesId, series.id, 'another book of the series is not touched');
  assert.equal(f.store.listMessages(100, scopeKey(to)).length, 1);
  assert.equal(f.store.listMessages(100, scopeKey(from)).length, 0);
  assert.equal(JSON.parse(f.store.getWorkspaceProposal('p1').payload).seriesId, other.id);
  assert.deepEqual(JSON.parse(f.store.getSetting('agent.delegations.' + scopeKey(to))), [{ id: 'd1' }]);
  const journal = JSON.parse(f.store.getSetting(JOURNAL));
  assert.deepEqual([journal.requests.r1.scope, journal.requests.r2.scope], [scopeKey(to), scopeKey(neighbour)], 'StoryArt pairing follows the book; others stay');
  assert.deepEqual(JSON.parse(f.store.getSetting('workspace.selection')), to);
  const call = f.calls.select.at(-1);
  assert.deepEqual([call.selection.seriesId, call.vaultPath], [other.id, f.other]);
  assert.notEqual(ws.revision(), revisionBefore);
  assert.equal((await ws.overview()).progress.draftCount, 1);

  const reopened = f.reopen();
  assert.deepEqual(reopened.catalog().active, to);
  assert.ok(reopened.catalog().authors[0].series.find(row => row.id === other.id).books.some(row => row.id === book.id));
});

test('workspace revision includes the overlay of the open book', async t => {
  const f = fixture(t); const ws = f.workspace();
  const book = named(ws.project.view().books, 'Part 1'), revision = ws.revision();
  await ws.project.attach({ bookId: book.id, googleDocument: 'CompanionDoc_99', expectedRevision: rev(ws) });
  assert.notEqual(ws.revision(), revision);
  assert.deepEqual((await ws.overview()).attachments.map(row => [row.kind, row.googleDocumentId]), [['google-doc', 'CompanionDoc_99']]);
});

test('the first book of an open empty series only becomes the selection; series-scope rows keep bookId null', async t => {
  const f = fixture(t, { books: [], initial: false }); const ws = f.workspace();
  const series = named(ws.project.view().series, 'Series'), scope = { authorId: series.authorId, seriesId: series.id, bookId: null };
  await ws.select(scope);
  const note = f.store.createNote({ title: 'Series note', text: 'shared', ...scope });
  f.store.addMessage('user', 'series hello', scopeKey(scope));
  f.store.setSetting(JOURNAL, JSON.stringify({ version: 1, requests: { r1: { scope: scopeKey(scope), status: 'done' } } }));
  await assert.rejects(ws.project.createBook({ name: 'Первая', seriesId: series.id, expectedRevision: rev(ws) }), { status: 409, code: 'active_confirmation_required' });
  const result = await ws.project.createBook({ name: 'Первая', seriesId: series.id, expectedRevision: rev(ws), confirmActive: true });
  assert.deepEqual(result.moved, []);
  assert.equal(f.store.getNote(note.id).bookId, null);
  assert.equal(f.store.listMessages(100, scopeKey(scope)).length, 1);
  assert.equal(JSON.parse(f.store.getSetting(JOURNAL)).requests.r1.scope, scopeKey(scope));
  const selected = { ...scope, bookId: result.created.id };
  assert.deepEqual(JSON.parse(f.store.getSetting('workspace.selection')), selected);
  assert.deepEqual([result.activeChanged, f.calls.select.at(-1).selection.bookId], [true, result.created.id]);
});

test('renaming the open author, series and vault book changes the revision and the agent names, keeping IDs', async t => {
  const f = fixture(t); const ws = f.workspace();
  const v = ws.project.view(), book = named(v.books, 'Part 1'), series = named(v.series, 'Series'), ids = ws.catalog().active;
  assert.equal(ids.bookId, book.id);
  const note = f.store.createNote({ title: 'Book note', text: 'n', ...ids });
  const steps = [['authorName', 'Автор 2', () => ws.project.updateAuthor(series.authorId, { name: 'Автор 2', expectedRevision: rev(ws) })],
    ['seriesName', 'Серия 2', () => ws.project.updateSeries(series.id, { name: 'Серия 2', expectedRevision: rev(ws) })],
    ['bookName', 'Книга 2', () => ws.project.updateBook(book.id, { name: 'Книга 2', expectedRevision: rev(ws) })]];
  for (const [key, name, run] of steps) {
    const revision = ws.revision(), calls = f.calls.select.length;
    await run();
    assert.notEqual(ws.revision(), revision, key);
    assert.equal(f.calls.select.length, calls + 1, key);
    const call = f.calls.select.at(-1);
    assert.equal(call.selection[key], name);
    assert.equal(call.revision, ws.revision());
    assert.deepEqual(ws.catalog().active, ids, 'stable IDs');
  }
  assert.deepEqual([f.store.getNote(note.id).bookId, f.store.getNote(note.id).seriesId], [book.id, series.id]);
});

test('a local companion file stays readable by attachment ID after its book moves to another series, without joining that series', async t => {
  const f = fixture(t, { initial: false }); const ws = f.workspace(), before = vaultFiles(f.vault);
  const v = ws.project.view(), part1 = named(v.books, 'Part 1'), other = named(v.series, 'Other');
  const file = (await ws.project.attach({ bookId: part1.id, sourcePath: '00 Паспорт серии.md', expectedRevision: rev(ws) })).created.id;
  const google = (await ws.project.attach({ bookId: part1.id, googleDocument: 'CompanionDoc_42', expectedRevision: rev(ws) })).created.id;
  await ws.project.updateBook(part1.id, { seriesId: other.id, expectedRevision: rev(ws) });
  const row = ws.project.view().attachments.find(item => item.id === file);
  assert.deepEqual([row.sourcePath, row.sourceAvailable, row.seriesId], [null, true, other.id]);
  const source = ws.project.attachmentSource(file);
  assert.deepEqual([source.path, source.title, source.readOnly], ['00 Автор/Writer/Series/00 Паспорт серии.md', 'Series', true]);
  assert.match(source.body, /# Series/);
  assert.ok(!JSON.stringify(source).includes(JSON.stringify(f.root).slice(1, -1)) && !JSON.stringify(source).includes(f.root), 'no absolute path');
  await ws.select({ authorId: other.authorId, seriesId: other.id, bookId: part1.id });
  assert.ok(!ws.cards().cards.some(card => card.title === 'Series'), 'the companion source is not merged into the other series knowledge');
  assert.throws(() => ws.project.attachmentSource(google), { status: 404 });
  assert.throws(() => ws.project.attachmentSource('att-unknown'), { status: 404 });
  assert.throws(() => ws.project.attachmentSource('../00 Паспорт серии.md'), { status: 404 });
  await ws.project.archiveAttachment(file, { expectedRevision: rev(ws) });
  assert.throws(() => ws.project.attachmentSource(file), { status: 404 });
  assert.deepEqual(vaultFiles(f.vault), before, 'reading never writes vault files');
});

test('a failed agent switch fails closed instead of keeping the previous book context', async t => {
  const f = fixture(t); const ws = f.workspace();
  const v = ws.project.view(), series = named(v.series, 'Series'), other = named(v.series, 'Other');
  const part1 = named(v.books, 'Part 1'), part2 = named(v.books, 'Part 2');
  const persisted = f.store.getSetting('workspace.selection');
  f.flags.failSelect = 'runtime unavailable';
  await assert.rejects(ws.select({ authorId: series.authorId, seriesId: series.id, bookId: part2.id }), /runtime unavailable/);
  assert.equal(ws.agentContext().status, 'detached');
  assert.equal(ws.catalog().agentContext.status, 'detached');
  assert.equal(f.calls.detach, 1);
  assert.equal(f.store.getSetting('workspace.selection'), persisted, 'a failed choice is not persisted');

  const result = await ws.project.updateBook(part1.id, { seriesId: other.id, expectedRevision: v.revision, confirmActive: true });
  assert.match(result.warning, /не переключились/);
  assert.equal(result.agentContext.status, 'detached');
  assert.equal(f.calls.detach, 2);

  f.flags.failSelect = null;
  await ws.select({ authorId: other.authorId, seriesId: other.id, bookId: part1.id });
  assert.equal(ws.agentContext().status, 'ready');
});

// ---- Explicit, author-confirmed migration: eight legacy "books" become companion files of one book.
const SOURCES = Array.from({ length: 8 }, (_, i) => `Источник ${i + 1}`);
function migrationFixture(t) {
  const f = fixture(t, { books: SOURCES, google: { B1: 'GoogleDocSource1', B2: 'GoogleDocSource2' } });
  const author = scanVaultCatalog(f.vault)[0], series = author.series.find(row => row.name === 'Series');
  const map = { authorId: author.id, authorName: author.name, seriesId: series.id, seriesName: series.name, bookName: 'Мир под гнетом магии', preferredStableBookId: series.books[0].id,
    sourceBooks: series.books.map(row => ({ id: row.id, name: row.name, googleDocumentId: row.googleDocumentId ?? null })) };
  const scope = book => ({ authorId: author.id, seriesId: series.id, bookId: book.id });
  const otherBook = author.series.find(row => row.name === 'Other').books[0];
  return { f, author, series, map, scope, otherBook, target: scope(series.books[0]) };
}
const logRows = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));

test('the 8→1 migration is dry-run by default, checks identity exactly and refuses wrong maps', t => {
  const { f, map, series, otherBook } = migrationFixture(t);
  assert.equal(f.workspace().catalog().authors[0].series.find(row => row.name === 'Series').books.length, 8, 'no heuristic merge happens by itself');
  assert.deepEqual(checkConfirmedAllocation(map, { expectBookName: 'Мир под гнетом магии', expectCount: 8 }), []);
  assert.equal(checkConfirmedAllocation({ ...map, sourceBooks: map.sourceBooks.slice(1) }, { expectBookName: 'Мир под гнетом магии', expectCount: 8 }).length, 1);
  assert.equal(parseArgs(['--data', 'd', '--vault', 'v', '--map', 'm.json']).apply, false, 'the CLI is a dry run unless --apply is given');
  assert.throws(() => parseArgs(['--data', 'd', '--rollback', 'x', '--apply']));

  const plan = planBookMigration({ map, store: f.store, catalogRoot: f.vault });
  assert.equal(plan.status, 'ready', plan.errors.join(' '));
  assert.deepEqual([plan.attachments.length, plan.moves.length, plan.vaultWrites, plan.aliases.length], [8, 7, 0, 8]);
  assert.deepEqual(plan.attachments.slice(0, 2).map(row => row.googleDocumentId), ['GoogleDocSource1', 'GoogleDocSource2']);
  assert.equal(f.store.project.revision(), 0, 'dry run writes nothing');
  assert.deepEqual(f.store.project.migrations(), []);

  for (const wrong of [
    { ...map, seriesName: 'Другая серия' },
    { ...map, sourceBooks: map.sourceBooks.map((row, i) => i === 3 ? { ...row, name: 'Похожее название' } : row) },
    { ...map, sourceBooks: map.sourceBooks.map((row, i) => i === 0 ? { ...row, googleDocumentId: 'ForgedDocId123' } : row) },
    { ...map, sourceBooks: [...map.sourceBooks, { id: otherBook.id, name: otherBook.name, googleDocumentId: null }] },
    { ...map, preferredStableBookId: series.id },
  ]) {
    const result = planBookMigration({ map: wrong, store: f.store, catalogRoot: f.vault });
    assert.equal(result.status, 'invalid');
    assert.ok(result.errors.length > 0);
    assert.throws(() => applyBookMigration({ map: wrong, store: f.store, catalogRoot: f.vault }), { status: 400 });
  }
  assert.equal(f.store.project.revision(), 0);
});

test('applying the 8→1 map keeps every source, draft, message, delegation log and StoryArt pairing reachable and is idempotent and reversible', async t => {
  const { f, author, series, map, scope, otherBook, target } = migrationFixture(t);
  const before = vaultFiles(f.vault);
  const docs = series.books.map((book, i) => f.store.createDocument({ title: `D${i}`, text: `draft ${i}`, ...scope(book) }));
  series.books.forEach((book, i) => f.store.addMessage('user', `m${i}`, scopeKey(scope(book))));
  const seriesNote = f.store.createNote({ title: 'Series note', text: 'series scope', authorId: author.id, seriesId: series.id, bookId: null });
  const otherDoc = f.store.createDocument({ title: 'Other', text: 'other series', authorId: author.id, seriesId: otherBook.id ? scanVaultCatalog(f.vault)[0].series.find(row => row.name === 'Other').id : null, bookId: otherBook.id });
  // Delegation logs are capped per write, so merging must not concatenate and drop rows: 3 × 20 rows stay reachable.
  for (const i of [0, 1, 2]) f.store.setSetting('agent.delegations.' + scopeKey(scope(series.books[i])), JSON.stringify(logRows('log' + i, 20)));
  f.store.setSetting(JOURNAL, JSON.stringify({ version: 1, requests: { own: { scope: scopeKey(target), status: 'done' }, legacy: { scope: scopeKey(scope(series.books[3])), status: 'done' } } }));

  const applied = applyBookMigration({ map, store: f.store, catalogRoot: f.vault });
  assert.equal(applied.status, 'applied');
  assert.deepEqual(vaultFiles(f.vault), before, 'no vault file is written, moved or deleted');
  assert.equal(applyBookMigration({ map, store: f.store, catalogRoot: f.vault }).status, 'already-applied');
  assert.equal(f.store.project.revision(), applied.revision, 'a second apply changes nothing');

  const ws = f.workspace(), catalog = ws.catalog();
  const seriesRow = catalog.authors[0].series.find(row => row.id === series.id);
  assert.deepEqual(seriesRow.books.map(row => [row.id, row.name]), [[map.preferredStableBookId, 'Мир под гнетом магии']]);
  assert.deepEqual(seriesRow.books[0].attachments.map(row => row.name).sort(), [...SOURCES].sort());
  assert.ok(seriesRow.books[0].attachments.every(row => row.kind === 'vault-book'));
  assert.deepEqual(seriesRow.books[0].attachments.filter(row => row.googleDocumentId).map(row => row.googleDocumentId), ['GoogleDocSource1', 'GoogleDocSource2']);
  assert.deepEqual(catalog.authors[0].series.find(row => row.name === 'Other').books.map(row => row.id), [otherBook.id], 'the other series is not merged');

  for (const doc of docs) assert.deepEqual([f.store.getDocument(doc.id).seriesId, f.store.getDocument(doc.id).bookId], [series.id, map.preferredStableBookId]);
  for (const doc of docs) assert.equal(f.store.documentHistory(doc.id).length, 1);
  assert.equal(f.store.getNote(seriesNote.id).bookId, null, 'series-scope knowledge stays at series scope');
  assert.equal(f.store.getDocument(otherDoc.id).bookId, otherBook.id);
  assert.deepEqual(f.store.listMessages(100, scopeKey(target)).map(row => row.text).sort(), SOURCES.map((_, i) => `m${i}`));

  // A legacy ID resolves only together with its own legacy author and series.
  await assert.rejects(ws.select({ authorId: author.id, seriesId: catalog.authors[0].series.find(row => row.name === 'Other').id, bookId: series.books[3].id }), { status: 400 });
  const selected = await ws.select({ authorId: author.id, seriesId: series.id, bookId: series.books[3].id });
  assert.equal(selected.active.bookId, map.preferredStableBookId);
  const history = ws.delegationHistory();
  assert.equal(history.current.length, 20);
  assert.equal(history.moved.length, 2);
  assert.equal(history.current.length + history.moved.reduce((sum, row) => sum + row.rows.length, 0), 60, 'no delegation row is dropped');
  assert.deepEqual(history.moved.map(row => row.sourceScopeKey).sort(), [scopeKey(scope(series.books[1])), scopeKey(scope(series.books[2]))].sort());
  const journal = JSON.parse(f.store.getSetting(JOURNAL));
  assert.deepEqual([journal.requests.own.scope, journal.requests.legacy.scope], [scopeKey(target), scopeKey(target)]);

  const overview = await ws.overview();
  assert.equal(overview.attachments.length, 8);
  assert.ok(overview.attachments.every(row => row.sourcePath && !row.sourcePath.includes(f.root)));
  assert.equal(overview.progress.draftCount, 8);
  assert.equal(overview.sourceWords, 0, 'companion files are not counted as the book text');

  // Archiving one migrated link hides only that link.
  const firstLink = seriesRow.books[0].attachments[0].id;
  await ws.project.archiveAttachment(firstLink, { expectedRevision: rev(ws) });
  assert.equal(ws.project.view().books.find(row => row.id === map.preferredStableBookId).attachmentCount, 7);
  assert.throws(() => rollbackBookMigration({ store: f.store, migrationId: applied.migrationId }), { status: 409 }, 'rollback after later edits needs the backup');
  await ws.project.restoreAttachment(firstLink, { expectedRevision: rev(ws) });
});

test('rolling back the migration returns rows and delegation logs to their original books', t => {
  const { f, series, map, scope } = migrationFixture(t);
  const docs = series.books.map((book, i) => f.store.createDocument({ title: `D${i}`, text: `draft ${i}`, ...scope(book) }));
  for (const i of [0, 1]) f.store.setSetting('agent.delegations.' + scopeKey(scope(series.books[i])), JSON.stringify(logRows('log' + i, 5)));
  const applied = applyBookMigration({ map, store: f.store, catalogRoot: f.vault });
  assert.equal(f.store.getSetting('agent.delegations.' + scopeKey(scope(series.books[1]))), null);
  assert.deepEqual(rollbackBookMigration({ store: f.store, migrationId: applied.migrationId }).status, 'rolled-back');
  docs.forEach((doc, i) => assert.equal(f.store.getDocument(doc.id).bookId, series.books[i].id));
  assert.equal(JSON.parse(f.store.getSetting('agent.delegations.' + scopeKey(scope(series.books[1])))).length, 5);
  assert.deepEqual(f.store.project.movedDelegationHistory(scopeKey(scope(series.books[0]))), []);
  assert.equal(f.workspace().catalog().authors[0].series.find(row => row.id === series.id).books.length, 8);
  assert.equal(planBookMigration({ map, store: f.store, catalogRoot: f.vault }).status, 'ready', 'the map can be applied again after a rollback');
  const exported = f.store.project.exportData();
  assert.ok(exported.migrations[0].rolledBackAt);
  assert.ok(exported.moves.length > 0, 'the move journal is kept for audit and export');
});

test('project HTTP routes require a session and a same-origin request and expose no absolute paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tw-project-http-')), vault = join(root, 'vault');
  const series = join(vault, '00 Автор', 'Writer', 'Series');
  put(join(vault, '00 Автор', 'Writer', 'Автор.md'), '---\ntitle: Writer\n---\n# Writer');
  put(join(series, '00 Паспорт серии.md'), '---\ntitle: Series\n---\n# Series');
  put(join(series, '01 Книги', 'Part 1', 'Part 1.md'), '---\ntitle: Part 1\n---\n# Part 1');
  const agent = new EventEmitter(); Object.assign(agent, { inTurn: false, pendingMessage: false, status: () => ({ authenticated: true, running: false }), message: async () => ({ accepted: true }), shutdown: async () => {} });
  const google = { status: async () => ({ configured: false, authenticated: false }) };
  const app = await createApplication({ dataDir: join(root, 'data'), vaultPath: series, catalogVaultPath: vault, port: 0, lock: false, agent, pluginService: { tools: async () => [] }, googleService: google, googleAgentService: google, importService: { list: async () => ({ jobs: [] }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/project')).status, 401);
  assert.equal((await fetch(base + '/api/project/authors', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', expectedRevision: 0 }) })).status, 401);
  const session = await fetch(base + '/api/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ local: true }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (path, body, origin = base) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(origin ? { origin } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  assert.equal((await request('/api/project/authors', { name: 'Evil', expectedRevision: 0 }, 'http://evil.example')).status, 403);
  assert.ok((await request('/api/project/authors', { name: 'No origin', expectedRevision: 0 }, null)).status >= 400);
  const view = await (await request('/api/project')).json();
  assert.equal(view.revision, 0, 'refused requests wrote nothing');
  const created = await request('/api/project/authors', { name: 'Новый автор', expectedRevision: 0 });
  assert.equal(created.status, 201);
  const text = await created.text(), body = JSON.parse(text);
  assert.ok(body.project.authors.some(row => row.name === 'Новый автор'));
  assert.ok(!text.includes(root) && !text.includes(JSON.stringify(root).slice(1, -1)), 'no absolute paths in the response');
  const stale = await request('/api/project/authors', { name: 'Again', expectedRevision: 0 });
  assert.deepEqual([stale.status, (await stale.json()).code], [409, 'project_conflict']);
  assert.equal((await request(`/api/project/authors/${body.created.id}/archive`, { expectedRevision: 1 })).status, 404);
  agent.inTurn = true;
  const busy = await request('/api/project/authors', { name: 'Busy', expectedRevision: 1 });
  assert.deepEqual([busy.status, (await busy.json()).code], [409, 'agent_busy']);
  agent.inTurn = false;
  const book = (await (await request('/api/project')).json()).books[0];
  const attached = await request('/api/project/attachments', { bookId: book.id, googleDocument: 'https://docs.google.com/document/d/HttpCompanionDoc/edit', expectedRevision: 1 });
  assert.equal(attached.status, 201);
  const attachment = (await attached.json()).created.id;
  assert.equal((await request(`/api/project/attachments/${attachment}/archive`, { expectedRevision: 2 })).status, 200);
  const archived = await (await request('/api/project')).json();
  assert.deepEqual(archived.archived.map(row => row.id), [attachment]);
  assert.equal((await request(`/api/project/attachments/${attachment}/restore`, { expectedRevision: 3 })).status, 200);
  assert.equal((await fetch(base + `/api/project/attachments/${attachment}/source`)).status, 401);
  assert.equal((await request(`/api/project/attachments/${attachment}/source`)).status, 404, 'a Google Doc has no local source');
  const file = (await (await request('/api/project/attachments', { bookId: book.id, sourcePath: '00 Паспорт серии.md', expectedRevision: 4 })).json()).created.id;
  const source = await request(`/api/project/attachments/${file}/source`), sourceText = await source.text();
  assert.equal(source.status, 200); assert.match(sourceText, /Series/);
  assert.ok(!sourceText.includes(root) && !sourceText.includes(JSON.stringify(root).slice(1, -1)), 'no absolute paths in the source response');
});
