import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginService } from '../plugin-service.mjs';
import { queuedActionPreview } from '../public/workspace-adapters.js';

test('once model selection executes as a read-only resolution while project choice stays queued', async () => {
  const calls = [];
  let queued = 0;
  const service = new PluginService({ workspaceService: { revision: async () => 'workspace-r1' } });
  service.tools = async () => [{ name: 'talewisp_model_selection', inputSchema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'], additionalProperties: false }, annotations: { readOnlyHint: false } }];
  service._client = async () => ({ request: async (method, params) => { calls.push({ method, params }); return { structuredContent: { scope: params.arguments.choice } }; } });
  service._proposalAction = async (name, args) => { queued++; return { status: 'pending_author_review', name, args }; };

  const once = await service.call('talewisp_model_selection', { choice: 'once' });
  assert.deepEqual(once.structuredContent, { scope: 'once' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'tools/call');
  assert.equal(queued, 0);

  const project = await service.call('talewisp_model_selection', { choice: 'project' });
  assert.equal(project.status, 'pending_author_review');
  assert.equal(queued, 1);
});

test('queued preview bridge preserves exact host review before/after data for four Google products', () => {
  const cases = [
    ['talewisp_web_google_direct_edit', { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'r1', startIndex: 4, endIndex: 7, quote: 'old', replacement: 'new', operationId: 'op-direct' }, { kind: 'direct_edit', before: 'old', after: 'new', documentTitle: 'Draft' }],
    ['talewisp_web_google_insert', { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'r1', index: 4, text: 'new', operationId: 'op-insert' }, { kind: 'insert', before: '', after: 'new', documentTitle: 'Draft', anchor: { index: 4, tabId: 'tab-1', before: 'left', after: 'right' } }],
    ['talewisp_web_google_create_note', { title: 'Source note', text: 'Body', operationId: 'op-note' }, { kind: 'create_note', before: null, after: 'Source note\n\nСтатус: черновая заметка\n\nBody\n' }],
    ['talewisp_web_google_reply', { documentId: 'doc-1', commentId: 'comment-1', commentHash: 'a'.repeat(64), text: 'Reply', operationId: 'op-reply' }, { kind: 'reply', before: 'Existing comment', after: 'Reply', documentTitle: 'Draft', commentText: 'Existing comment', commentHash: 'a'.repeat(64) }],
  ];
  for (const [tool, payload, review] of cases) {
    const preview = queuedActionPreview({ tool, arguments: { ...payload, _review: review } });
    assert.equal(preview.valid, true, tool);
    assert.equal(preview.before, review.before, tool);
    assert.equal(preview.after, review.after, tool);
    assert.equal(preview.arguments._review.kind, review.kind, tool);
  }
});
