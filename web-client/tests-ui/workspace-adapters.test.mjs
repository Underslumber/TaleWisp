import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkspaceSelectionRequest, normalizeTargetWords, PRIMARY_VIEWS, queuedActionPreview, unwrapProposalResponse } from '../public/workspace-adapters.js';

test('proposal detail adapter unwraps the actual API response envelope', () => {
  const proposal = { id: 'p-1', title: 'Example', state: 'pending' };
  assert.equal(unwrapProposalResponse({ proposal }), proposal);
  assert.deepEqual(unwrapProposalResponse(proposal), proposal);
});

test('document target words normalize null, empty, and valid values to persisted integers', () => {
  assert.equal(normalizeTargetWords(null), 0);
  assert.equal(normalizeTargetWords(''), 0);
  assert.equal(normalizeTargetWords('12'), 12);
  assert.equal(normalizeTargetWords(-1), 0);
  assert.equal(normalizeTargetWords(undefined), 0);
});

test('main workspace routes are centrally rendered rather than tool-panel routes', () => {
  for (const route of ['overview', 'knowledge', 'notes', 'proposals', 'google', 'settings']) assert.equal(PRIMARY_VIEWS.has(route), true);
  for (const tool of ['agent', 'context', 'history']) assert.equal(PRIMARY_VIEWS.has(tool), false);
});

test('workspace selection permits a null book only for a real series with no books', () => {
  const catalog = { authors: [{ id: 'author-1', series: [
    { id: 'empty-series', books: [] },
    { id: 'series-with-books', books: [{ id: 'book-1' }] }
  ] }] };
  assert.deepEqual(buildWorkspaceSelectionRequest(catalog, 'author-1', 'empty-series', ''), {
    authorId: 'author-1', seriesId: 'empty-series', bookId: null
  });
  assert.deepEqual(buildWorkspaceSelectionRequest(catalog, 'author-1', 'series-with-books', 'book-1'), {
    authorId: 'author-1', seriesId: 'series-with-books', bookId: 'book-1'
  });
  assert.equal(buildWorkspaceSelectionRequest(catalog, 'author-1', 'series-with-books', ''), null);
  assert.equal(buildWorkspaceSelectionRequest(catalog, 'author-1', 'series-with-books', 'invented-book'), null);
  assert.equal(buildWorkspaceSelectionRequest(catalog, 'author-1', 'missing-series', ''), null);
});

test('native apply preview requires and returns the complete saved source snapshot', () => {
  const p = { tool: 'talewisp_apply_proposal', arguments: { proposal_path: 'pending/id.json', _review: { proposal: { title: 'Edit' }, source: { path: 'chapter.md', before: 'old' }, after: 'new' } } };
  assert.deepEqual(queuedActionPreview(p), { kind: 'native', valid: true, tool: p.tool, target: 'chapter.md', before: 'old', after: 'new', arguments: p.arguments });
  const create = { tool: p.tool, arguments: { _review: { proposal: { title: 'Create' }, source: { path: null, before: null, targetPath: 'new.md' }, after: 'new file' } } };
  assert.equal(queuedActionPreview(create).valid, true);
  assert.equal(queuedActionPreview({ tool: p.tool, arguments: { _review: { after: 'new' } } }).valid, false);
});

test('queued Google actions expose saved quote, UTF-16 range, and replacement or comment', () => {
  const suggest = queuedActionPreview({ tool: 'talewisp_web_google_suggest', arguments: { documentId: 'doc-1', startIndex: 4, endIndex: 10, quote: 'before', replacement: 'after' } });
  assert.deepEqual([suggest.documentId, suggest.startIndex, suggest.endIndex, suggest.quote, suggest.replacement], ['doc-1', 4, 10, 'before', 'after']);
  const comment = queuedActionPreview({ tool: 'talewisp_web_google_comment', arguments: { documentId: 'doc-2', startIndex: 1, endIndex: 3, quote: 'q', text: 'comment' } });
  assert.deepEqual([comment.quote, comment.comment], ['q', 'comment']);
});

test('queued Sheets updates require complete same-shaped before and after values', () => {
  const valid = queuedActionPreview({ tool: 'talewisp_web_sheets_update', arguments: {
    spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', beforeValues: [['Name', 'Count'], ['old', 1]],
    values: [['Name', 'Count'], ['new', 2]], beforeHash: 'sha256:abc', operationId: 'op-1'
  } });
  assert.equal(valid.kind, 'googleSheet');
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.beforeValues[1], ['old', 1]);
  assert.deepEqual(valid.values[1], ['new', 2]);
  const incomplete = queuedActionPreview({ tool: 'talewisp_web_sheets_update', arguments: {
    spreadsheetId: 'sheet-1', range: 'Sheet1!A1:B2', beforeValues: [['old']], values: [['new', 2]], beforeHash: 'h', operationId: 'op-1'
  } });
  assert.equal(incomplete.valid, false);
});

test('other queued actions retain every argument for technical review', () => {
  const args = { mode: 'read', nested: { path: 'chapter.md' } };
  assert.deepEqual(queuedActionPreview({ tool: 'talewisp_search', arguments: args }).arguments, args);
});
