import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createGoogleService } from '../google.mjs';
import { queuedActionPreview } from '../public/workspace-adapters.js';

const clientId = 'products-test.apps.googleusercontent.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'products-test-key'; jwk.alg = 'RS256';
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(['GOOGLE_AGENT_CLIENT_ID', 'GOOGLE_AGENT_CLIENT_SECRET', 'GOOGLE_AGENT_REDIRECT_URI'].map(key => [key, process.env[key]]));

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function idToken(nonce) {
  const input = `${b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${b64({ iss: 'https://accounts.google.com', aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce })}`;
  const signer = createSign('RSA-SHA256'); signer.update(input); signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}
function document(text, revisionId) {
  const endIndex = 1 + text.length;
  return { documentId: 'doc-1', title: 'Draft', revisionId, tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Text' }, documentTab: { body: { content: [{ startIndex: 1, endIndex, paragraph: { elements: [{ startIndex: 1, endIndex, textRun: { content: text, textStyle: { bold: true } } }] } }] } } }], comments: [], suggestions: [] };
}

test('direct edit and insertion stage exact review data, send guarded Docs payloads, and verify readback', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'talewisp-google-products-'));
  process.env.GOOGLE_AGENT_CLIENT_ID = clientId;
  process.env.GOOGLE_AGENT_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_AGENT_REDIRECT_URI = 'http://127.0.0.1:8787/api/google/agent/callback';
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', credentialNamespace: 'agent' });
  const docs = new Map([['doc-1', document('A😀BC\n', 'rev-1')]]);
  const comments = new Map([['doc-1', [{ id: 'comment-1', content: 'Existing comment', replies: [] }]]]);
  const batches = [];
  let loseNextBatchResponse = false;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const auth = new URL((await service.beginLogin({ includeDriveFile: true })).authUrl);
  assert.match(auth.searchParams.get('scope'), /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  const nonce = auth.searchParams.get('nonce');
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token') return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file', id_token: idToken(nonce) }), { status: 200 });
    if (parsed.hostname === 'www.googleapis.com' && parsed.pathname === '/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token') return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }), { status: 200 });
    if (parsed.pathname === '/v1/documents' && options.method === 'POST') {
      docs.set('note-1', document('\n', 'note-rev-1')); comments.set('note-1', []);
      return new Response(JSON.stringify({ documentId: 'note-1', title: JSON.parse(options.body).title }), { status: 200 });
    }
    const docRead = parsed.pathname.match(/^\/v1\/documents\/([^:]+)$/);
    if (docRead) return new Response(JSON.stringify(docs.get(docRead[1])), { status: 200 });
    const commentRead = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/comments$/);
    if (commentRead) return new Response(JSON.stringify({ comments: comments.get(commentRead[1]) ?? [] }), { status: 200 });
    const replyWrite = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/comments\/([^/]+)\/replies$/);
    if (replyWrite && options.method === 'POST') {
      const reply = { id: 'reply-1', content: JSON.parse(options.body).content };
      const thread = (comments.get(replyWrite[1]) ?? []).find(item => item.id === replyWrite[2]);
      thread.replies.push(reply);
      return new Response(JSON.stringify(reply), { status: 200 });
    }
    if (parsed.pathname.endsWith(':batchUpdate')) {
      const body = JSON.parse(options.body);
      batches.push(body);
      const documentId = parsed.pathname.match(/^\/v1\/documents\/([^:]+)/)[1];
      const live = docs.get(documentId);
      if (body.writeControl) assert.equal(body.writeControl.requiredRevisionId, live.revisionId);
      let text = live.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content;
      const deletion = body.requests.find(request => request.deleteContentRange)?.deleteContentRange.range;
      const insertion = body.requests.find(request => request.insertText)?.insertText;
      const offset = (deletion?.startIndex ?? insertion.location.index) - 1;
      text = deletion ? text.slice(0, offset) + insertion.text + text.slice(deletion.endIndex - 1) : text.slice(0, offset) + insertion.text + text.slice(offset);
      docs.set(documentId, document(text, documentId === 'doc-1' ? `rev-${batches.length + 1}` : 'note-rev-2'));
      if (loseNextBatchResponse) { loseNextBatchResponse = false; throw new Error('simulated lost response after commit'); }
      return new Response(JSON.stringify({ replies: [] }), { status: 200 });
    }
    throw new Error(`Unexpected Google request: ${parsed}`);
  };
  await service.callback(`${auth.searchParams.get('redirect_uri')}?code=unused&state=${encodeURIComponent(auth.searchParams.get('state'))}`);

  const direct = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: 'product-direct-0001' };
  const stagedDirect = await service.stageProduct('direct_edit', direct);
  assert.deepEqual(stagedDirect.review, { kind: 'direct_edit', before: '😀', after: 'XYZ', documentTitle: 'Draft' });
  const directPreview = queuedActionPreview({ tool: 'talewisp_web_google_direct_edit', arguments: { ...direct, _review: stagedDirect.review } });
  assert.equal(directPreview.valid, true);
  assert.equal(directPreview.before, '😀'); assert.equal(directPreview.after, 'XYZ');
  assert.equal(batches.length, 0, 'staging must not mutate Google Docs');
  const directResult = await service.applyProduct('direct_edit', { ...direct, _review: stagedDirect.review });
  assert.equal(directResult.verified, true);
  assert.deepEqual(batches[0].writeControl, { requiredRevisionId: 'rev-1' });
  assert.deepEqual(batches[0].requests[0].deleteContentRange.range, { startIndex: 2, endIndex: 4, tabId: 'tab-1' });
  assert.equal(docs.get('doc-1').tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content, 'AXYZBC\n');

  const insert = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-2', index: 4, text: '!', operationId: 'product-insert-0001' };
  const stagedInsert = await service.stageProduct('insert', insert);
  assert.equal(stagedInsert.review.before, '');
  assert.equal(stagedInsert.review.after, '!');
  assert.equal(stagedInsert.review.anchor.index, 4);
  const insertPreview = queuedActionPreview({ tool: 'talewisp_web_google_insert', arguments: { ...insert, _review: stagedInsert.review } });
  assert.equal(insertPreview.valid, true);
  assert.equal(insertPreview.before, ''); assert.equal(insertPreview.after, '!');
  const insertResult = await service.applyProduct('insert', { ...insert, _review: stagedInsert.review });
  assert.equal(insertResult.verified, true);
  assert.deepEqual(batches[1].requests, [{ insertText: { location: { index: 4, tabId: 'tab-1' }, text: '!' } }]);
  assert.equal(docs.get('doc-1').tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content, 'AXY!ZBC\n');

  const existingThread = (await service.readDocument('doc-1')).comments.find(comment => comment.id === 'comment-1');
  const commentHash = existingThread.commentHash;
  assert.match(commentHash, /^[a-f0-9]{64}$/);
  const reply = { documentId: 'doc-1', commentId: 'comment-1', commentHash, text: 'Reviewed', operationId: 'product-reply-0001' };
  const stagedReply = await service.stageProduct('reply', reply);
  assert.equal(stagedReply.review.before, 'Existing comment');
  assert.equal(stagedReply.review.commentHash, commentHash);
  const replyPreview = queuedActionPreview({ tool: 'talewisp_web_google_reply', arguments: { ...reply, _review: stagedReply.review } });
  assert.equal(replyPreview.valid, true);
  assert.equal(replyPreview.before, 'Existing comment'); assert.equal(replyPreview.after, 'Reviewed');
  const replyResult = await service.applyProduct('reply', { ...reply, _review: stagedReply.review });
  assert.equal(replyResult.replyId, 'reply-1');
  assert.equal(comments.get('doc-1')[0].replies[0].content, 'Reviewed');

  const uncertain = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-3', index: 5, text: '?', operationId: 'product-unknown-0001' };
  const stagedUncertain = await service.stageProduct('insert', uncertain);
  loseNextBatchResponse = true;
  await assert.rejects(service.applyProduct('insert', { ...uncertain, _review: stagedUncertain.review }), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  const blocked = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-4', index: 5, text: 'blocked', operationId: 'product-blocked-0001' };
  const stagedBlocked = await service.stageProduct('insert', blocked);
  const batchesBeforeBlockedRetry = batches.length;
  await assert.rejects(service.applyProduct('insert', { ...blocked, _review: stagedBlocked.review }), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  assert.equal(batches.length, batchesBeforeBlockedRetry, 'an unresolved write must block later writes without retrying');

  const note = { title: 'Source note', text: 'A readable note.', sourceUrl: 'https://example.test/source', operationId: 'product-note-0001' };
  const stagedNote = await service.stageProduct('create_note', note);
  assert.equal(stagedNote.review.before, null);
  assert.match(stagedNote.review.after, /^Source note\n\nСтатус: черновая заметка\n\nA readable note\./);
  const notePreview = queuedActionPreview({ tool: 'talewisp_web_google_create_note', arguments: { ...note, _review: stagedNote.review } });
  assert.equal(notePreview.valid, true);
  assert.equal(notePreview.before, null); assert.equal(notePreview.after, stagedNote.review.after);
  const noteResult = await service.applyProduct('create_note', { ...note, _review: stagedNote.review });
  assert.equal(noteResult.state, 'draft');
  assert.equal(noteResult.verified, true);
  assert.ok(docs.get('note-1').tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content.includes('Статус: черновая заметка'));
});
