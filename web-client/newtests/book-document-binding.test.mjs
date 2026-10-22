import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore } from '../store.mjs';
import { createWorkspaceService } from '../workspace.mjs';

function fixture(t) {
  const root = mkdtempSync(join(resolve('.'), '.book-document-binding-'));
  const catalog = join(root, 'vault');
  const series = join(catalog, '00 Автор', 'Writer', 'Series');
  const booksRoot = join(series, '01 Книги');
  const sources = join(series, '00 Источники');
  const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value, 'utf8'); };
  put(join(catalog, '00 Автор', 'Writer', 'Автор.md'), '---\ntitle: Writer\n---\n# Writer');
  put(join(series, '00 Паспорт серии.md'), '---\ntitle: Series\n---\n# Series');
  const addBook = (folder, text) => { const dir = join(booksRoot, folder); mkdirSync(dir, { recursive: true }); put(join(dir, `${folder}.md`), text); return dir; };
  const addSource = (file, { book_id, title, origin, legacyOrigin }) => {
    const value={
      book_id,
      metadata: { title, document_id: '', source_path: 'private/source/snapshot.json', provenance: { origin, extractor: 'fixture' } },
      chapters: []
    };
    if(legacyOrigin!==undefined)value.provenance={origin:legacyOrigin};
    put(join(sources, file), JSON.stringify(value));
  };
  const store = openStore(join(root, 'data'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const workspace = () => createWorkspaceService({ catalogVaultPath: catalog, initialVaultPath: series, store, dataDir: join(root, 'data') });
  const book = (folder, catalogData = workspace().catalog()) => catalogData.authors[0].series[0].books.find(row => row.name === folder);
  return { root, catalog, series, booksRoot, sources, addBook, addSource, workspace, book };
}
// A Google Doc is a companion file of the book, never the book itself.
const googleIds = book => (book.attachments ?? []).filter(item => item.kind === 'google-doc').map(item => item.googleDocumentId);
const assertNoGoogleCompanion = (book, message) => { assert.equal(Object.hasOwn(book, 'googleDocumentId'), false, message); assert.deepEqual(googleIds(book), [], message); };

test('navigation without frontmatter attaches a unique source by title provenance only', t => {
  const f = fixture(t);
  f.addBook('Book B08 [Google Docs 2026]', '# Book B08 [Google Docs 2026]');
  f.addSource('B08-corpus.json', {
    book_id: 'B08', title: 'Book B08 [Google Docs 2026]',
    origin: 'https://docs.google.com/document/d/1zkh9VFPHxB-CyXTvgMrWPU4eIoFviTHdDsfCJ6QPuLA/edit'
  });
  const books = f.workspace().catalog().authors[0].series[0].books;
  assert.equal(Object.hasOwn(books[0], 'googleDocumentId'), false, 'the book entity carries no Google Doc identity');
  assert.deepEqual(googleIds(books[0]), ['1zkh9VFPHxB-CyXTvgMrWPU4eIoFviTHdDsfCJ6QPuLA']);
});

test('explicit logical book ID binds despite a display alias mismatch', t => {
  const f = fixture(t);
  f.addBook('B08 display alias', '---\ntype: book\ntitle: Friendly alias\nbook_id: B08\n---\n# Friendly alias');
  f.addSource('B08.json', {
    book_id: 'B08', title: 'Canonical source title',
    origin: 'https://docs.google.com/document/d/Doc_08-abc/edit'
  });
  const books = f.workspace().catalog().authors[0].series[0].books;
  assert.deepEqual(googleIds(books[0]), ['Doc_08-abc']);
});

test('ambiguous title matches and contradictory duplicate logical sources omit the optional binding', t => {
  const f = fixture(t);
  f.addBook('Book B08', '# Book B08');
  f.addSource('one.json', { book_id: 'B08', title: 'Book B08', origin: 'https://docs.google.com/document/d/doc-one/edit' });
  f.addSource('two.json', { book_id: 'B09', title: 'Book B08', origin: 'https://docs.google.com/document/d/doc-two/edit' });
  let books = f.workspace().catalog().authors[0].series[0].books;
  assertNoGoogleCompanion(books[0]);

  const explicit = fixture(t);
  explicit.addBook('Book B08', '---\ntype: book\nbook_id: B08\n---\n# Book B08');
  explicit.addSource('one.json', { book_id: 'B08', title: 'Book B08', origin: 'https://docs.google.com/document/d/doc-one/edit' });
  explicit.addSource('two.json', { book_id: 'B08', title: 'Other name', origin: 'https://docs.google.com/document/d/doc-two/edit' });
  books = explicit.workspace().catalog().authors[0].series[0].books;
  assertNoGoogleCompanion(books[0]);
});

test('conflicting root-level legacy provenance cannot override metadata provenance', t => {
  const f = fixture(t);
  f.addBook('Book B08', '---\ntype: book\nbook_id: B08\n---\n# Book B08');
  f.addSource('conflict.json', { book_id: 'B08', title: 'Book B08', origin: 'https://docs.google.com/document/d/doc-nested/edit', legacyOrigin: 'https://docs.google.com/document/d/doc-legacy/edit' });
  const books = f.workspace().catalog().authors[0].series[0].books;
  assertNoGoogleCompanion(books[0]);
});

test('non-document, non-HTTPS, and untrusted host origins are rejected without leaking source metadata', t => {
  for (const [name, origin] of [
    ['Sheets', 'https://docs.google.com/spreadsheets/d/sheet-id/edit'],
    ['external host', 'https://evil.example/document/d/evil-id/edit'],
    ['HTTP', 'http://docs.google.com/document/d/http-id/edit']
  ]) {
    const f = fixture(t);
    f.addBook('Book B08', '# Book B08');
    f.addSource('source.json', { book_id: 'B08', title: 'Book B08', origin });
    const catalog = f.workspace().catalog();
    const data = JSON.stringify(catalog);
    assertNoGoogleCompanion(catalog.authors[0].series[0].books[0], name);
    assert.doesNotMatch(data, /source_path|private\/source|snapshot\.json/, name);
  }
});
