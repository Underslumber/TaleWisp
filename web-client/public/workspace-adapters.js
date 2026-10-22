import { googleNoteBody } from './google-note.js';

export const normalizeTargetWords = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.trunc(Number(value)) : 0;
export const PRIMARY_VIEWS = new Set(['notes','knowledge','google','settings','proposals','overview']);
export const queuedActionApprovalLabel = kind => ({
  googleDirectEdit: 'Заменить напрямую',
  googleInsert: 'Вставить текст',
  googleCreateNote: 'Создать документ заметок',
  googleReply: 'Ответить в ветке'
}[kind] || 'Применить это изменение');

export function buildWorkspaceSelectionRequest(catalog, authorId, seriesId, bookId) {
  if (typeof authorId !== 'string' || !authorId || typeof seriesId !== 'string' || !seriesId) return null;
  const author = catalog?.authors?.find(item => item.id === authorId);
  const series = author?.series?.find(item => item.id === seriesId);
  if (!series || !Array.isArray(series.books)) return null;
  if (series.books.length === 0) return { authorId, seriesId, bookId: null };
  if (typeof bookId !== 'string' || !bookId || !series.books.some(book => book.id === bookId)) return null;
  return { authorId, seriesId, bookId };
}

export function unwrapProposalResponse(response) {
  return response?.proposal && typeof response.proposal === 'object' ? response.proposal : response;
}

export function queuedActionPreview(proposal) {
  const tool = typeof proposal?.tool === 'string' ? proposal.tool : '';
  const args = proposal?.arguments && typeof proposal.arguments === 'object' && !Array.isArray(proposal.arguments) ? proposal.arguments : {};
  if (tool === 'talewisp_apply_proposal') {
    const review = args._review;
    const source = review?.source;
    const nativeProposal = review?.proposal;
    const target = source?.path || source?.targetPath || args.target_path || nativeProposal?.source_path || '';
    const valid = !!review && typeof review === 'object' && typeof review.after === 'string' &&
      !!source && typeof source === 'object' && !Array.isArray(source) &&
      !!nativeProposal && typeof nativeProposal === 'object' && !Array.isArray(nativeProposal) &&
      (source.before === null || typeof source.before === 'string') && typeof target === 'string' && !!target;
    return { kind: 'native', valid, tool, target, before: source?.before, after: review?.after, arguments: args };
  }
  if (tool === 'talewisp_web_google_suggest' || tool === 'talewisp_web_google_comment') {
    return {
      kind: 'google', valid: true, tool,
      documentId: args.documentId,
      startIndex: args.startIndex,
      endIndex: args.endIndex,
      quote: args.quote,
      replacement: tool.endsWith('_suggest') ? args.replacement : undefined,
      comment: tool.endsWith('_comment') ? args.text : undefined,
      arguments: args
    };
  }
  const review = args._review && typeof args._review === 'object' && !Array.isArray(args._review) ? args._review : null;
  const hasId = value => typeof value === 'string' && value.trim().length > 0;
  const optionalTitleValid = () => !review || review.documentTitle === undefined || typeof review.documentTitle === 'string';
  const validReview = (kind, shape) => !!review && review.kind === kind && (review.before === null || typeof review.before === 'string') && typeof review.after === 'string' && optionalTitleValid() && shape;
  if (tool === 'talewisp_web_google_direct_edit') {
    const indexShape = Number.isInteger(args.startIndex) && Number.isInteger(args.endIndex) && args.startIndex >= 0 && args.endIndex > args.startIndex && typeof args.quote === 'string' && args.endIndex - args.startIndex === args.quote.length;
    const valid = hasId(args.documentId) && hasId(args.tabId) && hasId(args.revisionId) && indexShape && typeof args.quote === 'string' && typeof args.replacement === 'string' && hasId(args.operationId) && validReview('direct_edit', review?.before === args.quote && review?.after === args.replacement);
    return { kind: 'googleDirectEdit', valid, tool, documentId: args.documentId, tabId: args.tabId, revisionId: args.revisionId, startIndex: args.startIndex, endIndex: args.endIndex, quote: args.quote, replacement: args.replacement, before: review?.before, after: review?.after, documentTitle: review?.documentTitle, arguments: args };
  }
  if (tool === 'talewisp_web_google_insert') {
    const indexShape = Number.isInteger(args.index) && args.index >= 0;
    const anchor = review?.anchor && typeof review.anchor === 'object' && !Array.isArray(review.anchor) ? review.anchor : null;
    const anchorValid = !!anchor && anchor.index === args.index && anchor.tabId === args.tabId && typeof anchor.before === 'string' && typeof anchor.after === 'string';
    const valid = hasId(args.documentId) && hasId(args.tabId) && hasId(args.revisionId) && indexShape && typeof args.text === 'string' && !!args.text && hasId(args.operationId) && validReview('insert', review?.before === '' && review?.after === args.text && anchorValid);
    return { kind: 'googleInsert', valid, tool, documentId: args.documentId, tabId: args.tabId, revisionId: args.revisionId, index: args.index, text: args.text, before: review?.before, after: review?.after, anchor, documentTitle: review?.documentTitle, arguments: args };
  }
  if (tool === 'talewisp_web_google_create_note') {
    const sourceFields = ['sourceUrl', 'sourceTabOrRange', 'quote', 'sourceRevision'];
    const optionalSourcesValid = sourceFields.every(key => args[key] === undefined || typeof args[key] === 'string');
    const body = hasId(args.title) && typeof args.text === 'string' && optionalSourcesValid ? googleNoteBody(args) : null;
    const valid = hasId(args.title) && typeof args.text === 'string' && !!args.text.trim() && optionalSourcesValid && hasId(args.operationId) && validReview('create_note', review?.before === null && review?.after === body);
    return { kind: 'googleCreateNote', valid, tool, title: args.title, text: args.text, sourceUrl: args.sourceUrl, sourceTabOrRange: args.sourceTabOrRange, quote: args.quote, sourceRevision: args.sourceRevision, before: review?.before, after: review?.after, documentTitle: review?.documentTitle, arguments: args };
  }
  if (tool === 'talewisp_web_google_reply') {
    const valid = hasId(args.documentId) && hasId(args.commentId) && hasId(args.commentHash) && typeof args.text === 'string' && !!args.text.trim() && hasId(args.operationId) && validReview('reply', hasId(review?.commentText) && review?.commentHash === args.commentHash && review?.after === args.text && (review?.before === null || review?.before === review?.commentText));
    return { kind: 'googleReply', valid, tool, documentId: args.documentId, commentId: args.commentId, commentHash: args.commentHash, text: args.text, commentText: review?.commentText, before: review?.before, after: review?.after, documentTitle: review?.documentTitle, arguments: args };
  }
  if (tool === 'talewisp_web_sheets_update') {
    const beforeValues = Array.isArray(args.beforeValues) ? args.beforeValues : null;
    const values = Array.isArray(args.values) ? args.values : null;
    const rectangular = rows => Array.isArray(rows) && rows.length > 0 && rows.every(row => Array.isArray(row) && row.length > 0 && row.length === rows[0].length);
    const sameShape = rectangular(beforeValues) && rectangular(values) && beforeValues.length === values.length && beforeValues.every((row, index) => row.length === values[index].length);
    return {
      kind: 'googleSheet',
      valid: typeof args.spreadsheetId === 'string' && !!args.spreadsheetId && typeof args.range === 'string' && !!args.range &&
        sameShape && typeof args.beforeHash === 'string' && !!args.beforeHash &&
        typeof args.operationId === 'string' && !!args.operationId,
      tool,
      spreadsheetId: args.spreadsheetId,
      range: args.range,
      beforeValues,
      values,
      beforeHash: args.beforeHash,
      operationId: args.operationId,
      arguments: args
    };
  }
  return { kind: 'generic', valid: true, tool, arguments: args };
}
