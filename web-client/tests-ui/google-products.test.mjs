import test from 'node:test';
import assert from 'node:assert/strict';
import { googleNoteBody } from '../public/google-note.js';
import { queuedActionApprovalLabel, queuedActionPreview } from '../public/workspace-adapters.js';

const noteArgs = {
  title: 'Research note', text: 'Keep this source.', sourceUrl: 'https://example.test/source',
  sourceTabOrRange: 'Sheet1!A1', quote: 'quoted source', sourceRevision: 'rev-2', operationId: 'op-note'
};
const base = {
  direct: {
    tool: 'talewisp_web_google_direct_edit', arguments: {
      documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 4, endIndex: 7,
      quote: 'old', replacement: 'new', operationId: 'op-edit',
      _review: { kind: 'direct_edit', before: 'old', after: 'new', documentTitle: 'Chapter' }
    }
  },
  insert: {
    tool: 'talewisp_web_google_insert', arguments: {
      documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', index: 2,
      text: 'X', operationId: 'op-insert', _review: { kind: 'insert', before: '', after: 'X', anchor: { index: 2, tabId: 'tab-1', before: 'left context', after: 'right context' } }
    }
  },
  note: {
    tool: 'talewisp_web_google_create_note', arguments: { ...noteArgs, _review: { kind: 'create_note', before: null, after: googleNoteBody(noteArgs) } }
  },
  reply: {
    tool: 'talewisp_web_google_reply', arguments: {
      documentId: 'doc-1', commentId: 'comment-1', commentHash: 'hash-1', text: 'Thanks.', operationId: 'op-reply',
      _review: { kind: 'reply', before: 'Please check.', after: 'Thanks.', commentText: 'Please check.', commentHash: 'hash-1', documentTitle: 'Chapter' }
    }
  }
};

test('all four Google writing products expose readable, verified before and after content', () => {
  const expected = [
    ['direct', 'googleDirectEdit', 'old', 'new'],
    ['insert', 'googleInsert', '', 'X'],
    ['note', 'googleCreateNote', null, googleNoteBody(noteArgs)],
    ['reply', 'googleReply', 'Please check.', 'Thanks.']
  ];
  for (const [key, kind, before, after] of expected) {
    const preview = queuedActionPreview(base[key]);
    assert.equal(preview.kind, kind);
    assert.equal(preview.valid, true, key);
    assert.equal(preview.before, before, key);
    assert.equal(preview.after, after, key);
  }
});

test('new Google products reject missing or mismatched host review metadata', () => {
  for (const key of Object.keys(base)) {
    const args = structuredClone(base[key].arguments);
    delete args._review;
    assert.equal(queuedActionPreview({ ...base[key], arguments: args }).valid, false, `${key}: missing review`);
  }
  const edit = structuredClone(base.direct.arguments); edit._review.after = 'different';
  assert.equal(queuedActionPreview({ ...base.direct, arguments: edit }).valid, false);
  const insert = structuredClone(base.insert.arguments); insert._review.after = 'wrong position';
  assert.equal(queuedActionPreview({ ...base.insert, arguments: insert }).valid, false);
  const noAnchor = structuredClone(base.insert.arguments); delete noAnchor._review.anchor;
  assert.equal(queuedActionPreview({ ...base.insert, arguments: noAnchor }).valid, false);
  const note = structuredClone(base.note.arguments); note._review.kind = 'reply';
  assert.equal(queuedActionPreview({ ...base.note, arguments: note }).valid, false);
  const reply = structuredClone(base.reply.arguments); reply._review.commentHash = 'stale-hash';
  assert.equal(queuedActionPreview({ ...base.reply, arguments: reply }).valid, false);
});

test('new Google proposals use action-specific approval labels', () => {
  assert.equal(queuedActionApprovalLabel('googleDirectEdit'), 'Заменить напрямую');
  assert.equal(queuedActionApprovalLabel('googleInsert'), 'Вставить текст');
  assert.equal(queuedActionApprovalLabel('googleCreateNote'), 'Создать документ заметок');
  assert.equal(queuedActionApprovalLabel('googleReply'), 'Ответить в ветке');
});
