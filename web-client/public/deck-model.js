import { buildWorkspaceSelectionRequest } from './workspace-adapters.js';

// Pure navigation model for the top card rail. It never talks to the server:
// browsing is local until the author picks a book (or explicitly opens an empty series).
export const LEVELS = ['authors', 'series', 'books'];
export const LEVEL_NUMERALS = { authors: 'I', series: 'II', books: 'III' };
export const LEVEL_NAMES = { authors: 'Автор', series: 'Серия', books: 'Книга' };
export const LEVEL_LIST_LABELS = { authors: 'Авторы', series: 'Серии автора', books: 'Книги серии' };

export function pluralRu(n, one, few, many) {
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';

export function findAuthor(catalog, authorId) {
  return list(catalog?.authors).find(item => item?.id === authorId) || null;
}

export function findSeries(catalog, authorId, seriesId) {
  return list(findAuthor(catalog, authorId)?.series).find(item => item?.id === seriesId) || null;
}

export function findBook(catalog, authorId, seriesId, bookId) {
  return list(findSeries(catalog, authorId, seriesId)?.books).find(item => item?.id === bookId) || null;
}

// The server-confirmed workspace. Only `catalog.active` counts; a browse position never does.
export function confirmedPath(catalog) {
  const active = catalog?.active || {};
  const author = findAuthor(catalog, active.authorId);
  const series = author ? findSeries(catalog, author.id, active.seriesId) : null;
  const book = series ? findBook(catalog, author.id, series.id, active.bookId) : null;
  return { author, series, book, emptySeries: !!series && list(series.books).length === 0 };
}

export function hasConfirmedWorkspace(catalog) {
  const path = confirmedPath(catalog);
  return !!(path.author && path.series && (path.book || path.emptySeries));
}

// Where browsing starts when the rail is opened: the confirmed book's siblings, or the authors.
export function initialBrowse(catalog) {
  const path = confirmedPath(catalog);
  if (path.author && path.series) return { level: 'books', authorId: path.author.id, seriesId: path.series.id };
  if (path.author) return { level: 'series', authorId: path.author.id, seriesId: null };
  return { level: 'authors', authorId: null, seriesId: null };
}

export function browseAt(catalog, level, from = {}) {
  if (level === 'authors') return { level, authorId: null, seriesId: null };
  if (level === 'series') return findAuthor(catalog, from.authorId) ? { level, authorId: from.authorId, seriesId: null } : browseAt(catalog, 'authors');
  if (level === 'books') return findSeries(catalog, from.authorId, from.seriesId) ? { level, authorId: from.authorId, seriesId: from.seriesId } : browseAt(catalog, 'series', from);
  return browseAt(catalog, 'authors');
}

// Keeps a browse position valid after the catalog changes (import, rename, removal).
export function reconcileBrowse(catalog, browse) {
  return browseAt(catalog, LEVELS.includes(browse?.level) ? browse.level : 'authors', browse || {});
}

export function parentLevel(level) {
  const index = LEVELS.indexOf(level);
  return index > 0 ? LEVELS[index - 1] : null;
}

function authorMeta(author) {
  const n = list(author.series).length;
  return n ? n + ' ' + pluralRu(n, 'серия', 'серии', 'серий') : 'Серий пока нет';
}

function seriesMeta(series) {
  const n = list(series.books).length;
  return n ? n + ' ' + pluralRu(n, 'книга', 'книги', 'книг') : 'Книг пока нет';
}

function bookMeta(book) {
  const n = list(book.attachments).length;
  return n ? n + ' ' + pluralRu(n, 'связанный файл', 'связанных файла', 'связанных файлов') : 'Без связанных файлов';
}

export function itemName(item, level) {
  const name = text(item?.name).trim();
  if (name) return name;
  return level === 'authors' ? 'Автор без имени' : level === 'series' ? 'Серия без названия' : 'Книга без названия';
}

// Cards for the current browse level, plus the parent card that becomes the anchor.
export function levelView(catalog, browse) {
  const state = reconcileBrowse(catalog, browse);
  const active = catalog?.active || {};
  const author = findAuthor(catalog, state.authorId);
  const series = findSeries(catalog, state.authorId, state.seriesId);
  let source = [], anchor = null;
  if (state.level === 'authors') source = list(catalog?.authors);
  if (state.level === 'series') { source = list(author?.series); anchor = author ? { level: 'authors', id: author.id, name: itemName(author, 'authors'), meta: authorMeta(author) } : null; }
  if (state.level === 'books') { source = list(series?.books); anchor = series ? { level: 'series', id: series.id, name: itemName(series, 'series'), meta: seriesMeta(series) } : null; }
  const items = source.filter(item => item && typeof item.id === 'string' && item.id).map(item => {
    const base = { id: item.id, level: state.level, name: itemName(item, state.level) };
    if (state.level === 'authors') return { ...base, meta: authorMeta(item), current: item.id === active.authorId, empty: !list(item.series).length };
    if (state.level === 'series') return { ...base, meta: seriesMeta(item), current: state.authorId === active.authorId && item.id === active.seriesId, empty: !list(item.books).length };
    return { ...base, meta: bookMeta(item), current: state.authorId === active.authorId && state.seriesId === active.seriesId && item.id === active.bookId, attachmentCount: list(item.attachments).length };
  });
  return { browse: state, items, anchor, author, series };
}

// Result of activating a card: either a deeper browse position or a commit request.
export function activate(catalog, browse, id) {
  const state = reconcileBrowse(catalog, browse);
  if (state.level === 'authors') {
    if (!findAuthor(catalog, id)) return { kind: 'invalid' };
    return { kind: 'browse', browse: { level: 'series', authorId: id, seriesId: null } };
  }
  if (state.level === 'series') {
    if (!findSeries(catalog, state.authorId, id)) return { kind: 'invalid' };
    return { kind: 'browse', browse: { level: 'books', authorId: state.authorId, seriesId: id } };
  }
  const ids = buildWorkspaceSelectionRequest(catalog, state.authorId, state.seriesId, id);
  return ids && ids.bookId === id ? { kind: 'commit', ids } : { kind: 'invalid' };
}

// Explicit opening of a series that has no books yet.
export function emptySeriesCommit(catalog, browse) {
  const state = reconcileBrowse(catalog, browse);
  if (state.level !== 'books') return null;
  const ids = buildWorkspaceSelectionRequest(catalog, state.authorId, state.seriesId, null);
  return ids && ids.bookId === null ? ids : null;
}

export function sameSelection(catalog, ids) {
  const active = catalog?.active || {};
  return !!ids && active.authorId === ids.authorId && active.seriesId === ids.seriesId && (active.bookId ?? null) === (ids.bookId ?? null);
}

export function scrollKey(browse) {
  return [browse?.level || 'authors', browse?.authorId || '', browse?.seriesId || ''].join('|');
}
