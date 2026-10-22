import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activate, browseAt, confirmedPath, emptySeriesCommit, hasConfirmedWorkspace, initialBrowse, levelView,
  parentLevel, pluralRu, reconcileBrowse, sameSelection, scrollKey
} from '../public/deck-model.js';

const catalog = () => ({
  active: { authorId: 'a1', seriesId: 's1', bookId: 'b2' },
  unassigned: { cardCount: 3 },
  authors: [
    { id: 'a1', name: 'Первый автор', series: [
      { id: 's1', name: 'Серия с книгами', books: [{ id: 'b1', name: 'Книга без связанных файлов', attachments: [] }, { id: 'b2', name: 'Открытая книга', attachments: [{ id: 'att-1', name: 'Черновик в Google Docs', kind: 'google-doc', googleDocumentId: 'doc-2' }, { id: 'att-2', name: 'Глава 2', kind: 'vault-book' }] }] },
      { id: 's2', name: 'Пустая серия', books: [] }
    ] },
    { id: 'a2', name: '', series: [] }
  ]
});

test('browsing starts at the confirmed book siblings and never at an invented book', () => {
  assert.deepEqual(initialBrowse(catalog()), { level: 'books', authorId: 'a1', seriesId: 's1' });
  assert.deepEqual(initialBrowse({ authors: [] }), { level: 'authors', authorId: null, seriesId: null });
  assert.deepEqual(initialBrowse(null), { level: 'authors', authorId: null, seriesId: null });
  assert.equal(hasConfirmedWorkspace(catalog()), true);
  assert.equal(hasConfirmedWorkspace({ ...catalog(), active: {} }), false);
});

test('author and series activation only changes the local browse position', () => {
  const c = catalog();
  const toSeries = activate(c, browseAt(c, 'authors'), 'a1');
  assert.deepEqual(toSeries, { kind: 'browse', browse: { level: 'series', authorId: 'a1', seriesId: null } });
  const toBooks = activate(c, toSeries.browse, 's2');
  assert.deepEqual(toBooks, { kind: 'browse', browse: { level: 'books', authorId: 'a1', seriesId: 's2' } });
  assert.deepEqual(c.active, catalog().active, 'browsing must not touch the confirmed selection');
});

test('only a book card produces a validated commit request', () => {
  const c = catalog();
  assert.deepEqual(activate(c, { level: 'books', authorId: 'a1', seriesId: 's1' }, 'b1'), { kind: 'commit', ids: { authorId: 'a1', seriesId: 's1', bookId: 'b1' } });
  assert.equal(activate(c, { level: 'books', authorId: 'a1', seriesId: 's1' }, 'missing').kind, 'invalid');
  assert.equal(activate(c, { level: 'authors' }, 'missing').kind, 'invalid');
});

test('an empty series is opened only through an explicit request with a null book', () => {
  const c = catalog();
  assert.deepEqual(emptySeriesCommit(c, { level: 'books', authorId: 'a1', seriesId: 's2' }), { authorId: 'a1', seriesId: 's2', bookId: null });
  assert.equal(emptySeriesCommit(c, { level: 'books', authorId: 'a1', seriesId: 's1' }), null);
  assert.equal(emptySeriesCommit(c, { level: 'series', authorId: 'a1' }), null);
  const view = levelView(c, { level: 'books', authorId: 'a1', seriesId: 's2' });
  assert.equal(view.items.length, 0);
  assert.equal(view.anchor.name, 'Пустая серия');
});

test('cards carry only catalog facts: names, counts, current marker and bound original', () => {
  const c = catalog();
  const authors = levelView(c, browseAt(c, 'authors'));
  assert.deepEqual(authors.items.map(x => [x.name, x.meta, x.current]), [['Первый автор', '2 серии', true], ['Автор без имени', 'Серий пока нет', false]]);
  const books = levelView(c, { level: 'books', authorId: 'a1', seriesId: 's1' });
  // A book is its own entity: companion files are counted, never presented as the book's "original".
  assert.deepEqual(books.items.map(x => [x.id, x.meta, x.current, x.attachmentCount]), [['b1', 'Без связанных файлов', false, 0], ['b2', '2 связанных файла', true, 2]]);
  assert.ok(books.items.every(x => !/оригинал/i.test(x.meta)));
  assert.equal(books.anchor.level, 'series');
  const series = levelView(c, { level: 'series', authorId: 'a1' });
  assert.deepEqual(series.items.map(x => x.meta), ['2 книги', 'Книг пока нет']);
});

test('browse positions survive catalog changes by stepping up to the nearest valid level', () => {
  const c = catalog();
  c.authors[0].series.pop();
  assert.deepEqual(reconcileBrowse(c, { level: 'books', authorId: 'a1', seriesId: 's2' }), { level: 'series', authorId: 'a1', seriesId: null });
  assert.deepEqual(reconcileBrowse(c, { level: 'series', authorId: 'gone' }), { level: 'authors', authorId: null, seriesId: null });
  assert.deepEqual(reconcileBrowse(c, { level: 'nonsense' }), { level: 'authors', authorId: null, seriesId: null });
});

test('confirmed path, equality and helpers', () => {
  const c = catalog();
  const path = confirmedPath(c);
  assert.equal(path.book.name, 'Открытая книга');
  assert.equal(sameSelection(c, { authorId: 'a1', seriesId: 's1', bookId: 'b2' }), true);
  assert.equal(sameSelection(c, { authorId: 'a1', seriesId: 's1', bookId: 'b1' }), false);
  const empty = { ...c, active: { authorId: 'a1', seriesId: 's2', bookId: null } };
  assert.equal(confirmedPath(empty).emptySeries, true);
  assert.equal(hasConfirmedWorkspace(empty), true);
  assert.equal(sameSelection(empty, { authorId: 'a1', seriesId: 's2', bookId: null }), true);
  assert.equal(parentLevel('books'), 'series');
  assert.equal(parentLevel('authors'), null);
  assert.notEqual(scrollKey({ level: 'books', authorId: 'a1', seriesId: 's1' }), scrollKey({ level: 'books', authorId: 'a1', seriesId: 's2' }));
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map(n => pluralRu(n, 'книга', 'книги', 'книг')), ['книга', 'книги', 'книг', 'книг', 'книга', 'книги', 'книг']);
});
