import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createSign, createHash, createCipheriv, randomBytes } from 'node:crypto';
import { createGoogleService } from '../google.mjs';

const clientId = 'test-client.apps.googleusercontent.com';
const clientSecret = 'never-print-this-secret';
const originalFetch = globalThis.fetch;
const originalEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI };
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'test-key';
jwk.alg = 'RS256';

function b64(value) { return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url'); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
async function writeEncryptedFixture(file, value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await writeFile(file, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
}
function makeIdToken(nonce, audience = clientId) {
  const head = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: audience, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), nonce });
  const signingInput = `${head}.${body}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function fixtureDocument({ revisionId = 'rev-1', text = 'A😀BC\n', suggestion = false } = {}) {
  const run = { startIndex: 1, endIndex: 1 + text.length, textRun: { content: text, textStyle: { bold: true } } };
  if (suggestion) run.textRun.suggestedInsertionIds = ['suggest-new-1'];
  return {
    documentId: 'doc-1', title: 'Fixture', revisionId,
    tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Draft' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: 1 + text.length, paragraph: { elements: [run] } }] } } }],
    comments: [], suggestions: [],
  };
}

function fixtureSuggestionDocument() {
  const elements = [
    { startIndex: 1, endIndex: 2, textRun: { content: 'A', textStyle: { bold: true } } },
    { startIndex: 2, endIndex: 4, textRun: { content: '😀', textStyle: { bold: true }, suggestedDeletionIds: ['suggest-new-1'] } },
    { startIndex: 4, endIndex: 7, textRun: {
      content: 'XYZ', textStyle: { bold: true }, suggestedInsertionIds: ['suggest-new-1'],
      suggestedTextStyleChanges: { 'suggest-new-1': { textStyle: { bold: true }, textStyleSuggestionState: { boldSuggested: true } } },
    } },
    { startIndex: 7, endIndex: 10, textRun: { content: 'BC\n', textStyle: { bold: true } } },
  ];
  return {
    documentId: 'doc-1', title: 'Fixture', revisionId: 'rev-2',
    tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Draft' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: 10, paragraph: { elements } }] } } }],
    comments: [], suggestions: [{ suggestionId: 'suggest-new-1' }],
  };
}

function fixtureStyledDocument() {
  const elements = [
    { startIndex: 1, endIndex: 2, textRun: { content: 'A', textStyle: { bold: true } } },
    { startIndex: 2, endIndex: 4, textRun: { content: '😀', textStyle: { italic: true } } },
    { startIndex: 4, endIndex: 7, textRun: { content: 'BC\n', textStyle: {} } },
  ];
  return {
    documentId: 'doc-1', title: 'Fixture', revisionId: 'rev-1',
    tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Draft' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: 7, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements } }] } } }],
    comments: [], suggestions: [],
  };
}

function fixtureStyledSuggestionDocument({ neighborStyle = { bold: true }, insertedStyle = { bold: false, italic: true }, insertedBaseStyle = { bold: true }, includeObject = false, includeStyle = true } = {}) {
  const elements = [
    { startIndex: 1, endIndex: 2, textRun: { content: 'A', textStyle: neighborStyle } },
    { startIndex: 2, endIndex: 4, textRun: { content: '😀', textStyle: { italic: true }, suggestedDeletionIds: ['suggest-new-1'] } },
    { startIndex: 4, endIndex: 7, textRun: {
      content: 'XYZ', textStyle: insertedBaseStyle, suggestedInsertionIds: ['suggest-new-1'],
      ...(includeStyle ? { suggestedTextStyleChanges: { 'suggest-new-1': { textStyle: insertedStyle, textStyleSuggestionState: { boldSuggested: true, italicSuggested: true } } } } : {}),
    } },
  ];
  let nextIndex = 7;
  if (includeObject) elements.push({ startIndex: nextIndex++, endIndex: nextIndex, inlineObjectElement: { inlineObjectId: 'unexpected-object' } });
  elements.push({ startIndex: nextIndex, endIndex: nextIndex + 3, textRun: { content: 'BC\n', textStyle: {} } });
  return {
    documentId: 'doc-1', title: 'Fixture', revisionId: 'rev-2',
    tabs: [{ tabProperties: { tabId: 'tab-1', title: 'Draft' }, documentTab: { body: { content: [{ startIndex: 1, endIndex: nextIndex + 3, paragraph: { paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, elements } }] } } }],
    comments: [], suggestions: [{ suggestionId: 'suggest-new-1' }],
  };
}

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'talewisp-google-'));
  const env = { GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI };
  process.env.GOOGLE_CLIENT_ID = clientId;
  process.env.GOOGLE_CLIENT_SECRET = clientSecret;
  process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8787/api/google/callback';
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dataDir, service: createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' }) };
}

async function authorize(service, audience = clientId) {
  const { authUrl } = await service.beginLogin();
  const auth = new URL(authUrl);
  const nonce = auth.searchParams.get('nonce');
  let tokenBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      tokenBody = new URLSearchParams(options.body);
      return new Response(JSON.stringify({ access_token: `access-${audience}`, refresh_token: `refresh-${audience}`, expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.readonly', id_token: makeIdToken(nonce, audience) }), { status: 200 });
    }
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`Unexpected fetch URL ${url}`);
  };
  const result = await service.callback(`${auth.searchParams.get('redirect_uri')}?code=temporary-code&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
  assert.deepEqual(result, { connected: true });
  return { nonce, tokenBody };
}

function docsFetch({ document = fixtureDocument(), onBatch, commentsPages } = {}) {
  const seen = { get: [], comments: [], batch: [] };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'refreshed-access-token', expires_in: 3600 }), { status: 200 });
    if (parsed.pathname.endsWith('/certs')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (parsed.pathname.startsWith('/v1/documents/') && !parsed.pathname.endsWith(':batchUpdate')) {
      seen.get.push(parsed);
      return new Response(JSON.stringify(document), { status: 200 });
    }
    if (parsed.pathname.endsWith('/comments')) {
      seen.comments.push(parsed);
      const page = parsed.searchParams.get('pageToken') ? 1 : 0;
      return new Response(JSON.stringify(commentsPages?.[page] ?? { comments: [] }), { status: 200 });
    }
    if (parsed.pathname.endsWith(':batchUpdate')) {
      seen.batch.push({ url: parsed, body: JSON.parse(options.body ?? '{}') });
      if (onBatch) return onBatch(parsed, options, seen);
      return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL ${url}`);
  };
  return seen;
}

test('rejects unknown or expired OAuth state before exchanging a code', async (t) => {
  const { service } = await setup(t);
  const { authUrl } = await service.beginLogin();
  const auth = new URL(authUrl);
  let tokenCalls = 0;
  globalThis.fetch = async () => { tokenCalls++; throw new Error('must not exchange'); };
  await assert.rejects(service.callback(`http://127.0.0.1:8787/api/google/callback?code=x&state=wrong`), { code: 'GOOGLE_OAUTH_STATE_INVALID' });
  assert.equal(tokenCalls, 0);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(auth.searchParams.get('code_challenge'));
  assert.ok(auth.searchParams.get('nonce'));
  const { authUrl: secondAuthUrl } = await service.beginLogin();
  const secondAuth = new URL(secondAuthUrl);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 11 * 60 * 1000;
  try {
    await assert.rejects(service.callback(`${secondAuth.searchParams.get('redirect_uri')}?code=x&state=${encodeURIComponent(secondAuth.searchParams.get('state'))}`), { code: 'GOOGLE_OAUTH_STATE_INVALID' });
  } finally { Date.now = originalNow; }
});

test('reports an unconfigured connection honestly and returns a safe disconnect result', async (t) => {
  const { dataDir } = await setup(t);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  assert.deepEqual(await service.status(), { configured: false, authenticated: false, reason: 'missing_google_oauth_configuration', redirectUri: 'http://127.0.0.1:8787/api/google/callback', requiresClientConfiguration: true });
  await assert.rejects(service.beginLogin(), { code: 'GOOGLE_NOT_CONFIGURED' });
  assert.deepEqual(await service.disconnect(), { disconnected: true });
  assert.deepEqual(await service.status(), { configured: false, authenticated: false, reason: 'missing_google_oauth_configuration', redirectUri: 'http://127.0.0.1:8787/api/google/callback', requiresClientConfiguration: true });
});

test('lists only native Google Docs with bounded title search and one opaque page token', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  let requested;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'refreshed-access-token', expires_in: 3600 }), { status: 200 });
    if (parsed.pathname.endsWith('/files')) {
      requested = parsed;
      return new Response(JSON.stringify({ nextPageToken: 'page-next', files: [
        { id: 'doc_1', name: 'Author draft', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-14T10:00:00Z' },
        { id: 'sheet_1', name: 'Not a Doc', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-14T10:00:00Z' },
        { id: 'bad/id', name: 'Bad ID', mimeType: 'application/vnd.google-apps.document' },
      ] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL ${url}`);
  };
  const page = await service.listDocuments({ query: "Kut's draft", pageToken: 'page-prev', pageSize: 12 });
  assert.deepEqual(page, { files: [{ id: 'doc_1', title: 'Author draft', modifiedTime: '2026-10-14T10:00:00Z' }], nextPageToken: 'page-next' });
  assert.equal(requested.searchParams.get('pageSize'), '12');
  assert.equal(requested.searchParams.get('pageToken'), 'page-prev');
  assert.match(requested.searchParams.get('q'), /mimeType = 'application\/vnd\.google-apps\.document'/);
  assert.match(requested.searchParams.get('q'), /name contains 'Kut\\'s draft'/);
  await assert.rejects(service.listDocuments({ pageSize: 31 }), { code: 'GOOGLE_PAGE_SIZE_INVALID' });
  await assert.rejects(service.listDocuments({ query: 'x'.repeat(101) }), { code: 'GOOGLE_QUERY_INVALID' });
});

test('OAuth setup persists encrypted client configuration and status never exposes secrets', async (t) => {
  const { dataDir } = await setup(t);
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const clientIdValue = '123456789012-example.apps.googleusercontent.com';
  const clientSecretValue = 'GOCSPX-private-setup-secret';
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  const missing = await service.status();
  assert.equal(missing.configured, false);
  assert.equal(missing.requiresClientConfiguration, true);
  assert.equal(missing.redirectUri, 'http://127.0.0.1:8787/api/google/callback');
  assert.equal(JSON.stringify(missing).includes(clientSecretValue), false);
  await assert.rejects(service.configure({ clientId: 'bad-client-id', clientSecret: clientSecretValue }), { code: 'GOOGLE_OAUTH_CONFIGURATION_INVALID' });
  await assert.rejects(service.configure({ clientId: clientIdValue, clientSecret: 'short' }), { code: 'GOOGLE_OAUTH_CONFIGURATION_INVALID' });
  const configured = await service.configure({ clientId: clientIdValue, clientSecret: clientSecretValue });
  assert.deepEqual(configured, { configured: true, requiresClientConfiguration: false, redirectUri: 'http://127.0.0.1:8787/api/google/callback' });
  const status = await service.status();
  assert.equal(status.configured, true);
  assert.equal(status.requiresClientConfiguration, false);
  assert.equal(JSON.stringify(status).includes(clientSecretValue), false);
  const stored = await readFile(path.join(dataDir, 'google', 'configuration.enc'), 'utf8');
  assert.equal(stored.includes(clientIdValue), false);
  assert.equal(stored.includes(clientSecretValue), false);
  const restarted = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  const afterRestart = await restarted.status();
  assert.equal(afterRestart.configured, true);
  assert.equal(afterRestart.requiresClientConfiguration, false);
  const { authUrl } = await restarted.beginLogin();
  assert.equal(new URL(authUrl).searchParams.get('client_id'), clientIdValue);
});

test('encrypts persisted credentials and reloads the connection without exposing tokens', async (t) => {
  const { dataDir, service } = await setup(t);
  const { tokenBody } = await authorize(service);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.ok(tokenBody.get('code_verifier'));
  assert.deepEqual(await service.status(), { configured: true, authenticated: true, reason: null, redirectUri: 'http://127.0.0.1:8787/api/google/callback', requiresClientConfiguration: false });
  const files = await readdir(path.join(dataDir, 'google'));
  assert.ok(files.includes('credentials.enc'));
  const ciphertext = await readFile(path.join(dataDir, 'google', 'credentials.enc'), 'utf8');
  assert.equal(ciphertext.includes('refresh-private-value'), false);
  assert.equal(ciphertext.includes('access-private-value'), false);
  const second = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  assert.deepEqual(await second.status(), { configured: true, authenticated: true, reason: null, redirectUri: 'http://127.0.0.1:8787/api/google/callback', requiresClientConfiguration: false });
});

test('agent OAuth uses separate configuration, token key, callback, and state from the human connection', async t => {
  const { dataDir, service: human } = await setup(t);
  const previous = Object.fromEntries(['GOOGLE_AGENT_CLIENT_ID','GOOGLE_AGENT_CLIENT_SECRET','GOOGLE_AGENT_REDIRECT_URI'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) delete process.env[key];
  t.after(() => { for (const [key,value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const agent = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', credentialNamespace: 'agent', callbackPath: '/api/google/agent/callback' });
  assert.equal((await agent.status()).authenticated, false);
  assert.equal((await agent.status()).redirectUri, 'http://127.0.0.1:8787/api/google/agent/callback');
  const humanLogin = new URL((await human.beginLogin()).authUrl);
  const agentId = '987654321098-agent.apps.googleusercontent.com';
  await agent.configure({ clientId: agentId, clientSecret: 'GOCSPX-agent-secret-value' });
  const agentLogin = new URL((await agent.beginLogin()).authUrl);
  assert.equal(agentLogin.searchParams.get('client_id'), agentId);
  assert.equal(agentLogin.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/api/google/agent/callback');
  await assert.rejects(agent.callback(`http://127.0.0.1:8787/api/google/agent/callback?code=x&state=${encodeURIComponent(humanLogin.searchParams.get('state'))}`), { code: 'GOOGLE_OAUTH_STATE_INVALID' });
  await authorize(human);
  assert.equal((await agent.status()).authenticated, false, 'human credentials must not authenticate the agent channel');
  await authorize(agent, agentId);
  assert.equal((await human.status()).authenticated, true);
  assert.equal((await agent.status()).authenticated, true);
  const humanCredential = await readFile(path.join(dataDir, 'google', 'credentials.enc'), 'utf8');
  const agentCredential = await readFile(path.join(dataDir, 'google', 'agent', 'credentials.enc'), 'utf8');
  const agentConfig = await readFile(path.join(dataDir, 'google', 'agent', 'configuration.enc'), 'utf8');
  assert.equal(agentCredential.includes(`refresh-${agentId}`), false);
  assert.equal(agentConfig.includes('GOCSPX-agent-secret-value'), false);
  assert.notDeepEqual(await readFile(path.join(dataDir, 'google', 'storage.key')), await readFile(path.join(dataDir, 'google', 'agent', 'storage.key')));
  assert.notEqual(humanCredential, agentCredential);
});

test('an unresolved human write blocks an agent write through the shared durable document journal', async t => {
  const { dataDir, service: human } = await setup(t);
  const previous = Object.fromEntries(['GOOGLE_AGENT_CLIENT_ID','GOOGLE_AGENT_CLIENT_SECRET','GOOGLE_AGENT_REDIRECT_URI'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) delete process.env[key];
  t.after(() => { for (const [key,value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const agent = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', credentialNamespace: 'agent' });
  const agentId = '987654321098-agent.apps.googleusercontent.com';
  await agent.configure({ clientId: agentId, clientSecret: 'GOCSPX-agent-secret-value' });
  await authorize(human);
  await authorize(agent, agentId);
  const seen = docsFetch({ onBatch: async () => { throw new Error('response lost'); } });
  const operation = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 1, endIndex: 2, quote: 'A', replacement: 'better words', operationId: 'human-unknown-0001' };
  await assert.rejects(human.suggest(operation), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  assert.equal(seen.batch.length, 1);
  await assert.rejects(agent.suggest({ ...operation, operationId: 'agent-new-write-0001', replacement: 'another replacement' }), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  assert.equal(seen.batch.length, 1, 'the agent channel must be stopped before any second document write');
});

test('reads all tabs with inline suggestions, exact UTF-16 segments, comments, and Drive comment pages', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  const seen = docsFetch({ commentsPages: [{ comments: [{ id: 'c1', replies: [{ id: 'r1' }] }], nextPageToken: 'p2' }, { comments: [{ id: 'c2', replies: [] }] }] });
  const result = await service.readDocument('doc-1');
  assert.equal(seen.get[0].searchParams.get('includeTabsContent'), 'true');
  assert.equal(seen.get[0].searchParams.get('suggestionsViewMode'), 'SUGGESTIONS_INLINE');
  assert.equal(seen.get[0].searchParams.get('commentsViewMode'), 'COMMENTS_VIEW_MODE_INCLUDED');
  assert.equal(result.tabs[0].tabId, 'tab-1');
  assert.equal(result.tabs[0].text, 'A😀BC\n');
  assert.equal(result.tabs[0].segments[0].startIndex, 1);
  assert.equal(result.tabs[0].segments[0].endIndex, 7);
  assert.equal(result.tabs[0].segments[0].text.length, 6);
  assert.deepEqual(result.comments.map((comment) => comment.id), ['c1', 'c2']);
  assert.equal(result.comments[0].replies[0].id, 'r1');
  assert.equal(seen.comments.length, 2);
  assert.equal(seen.comments[1].searchParams.get('pageToken'), 'p2');
  assert.equal(result.raw.commentPages.length, 2);
});

test('rejects a stale revision before issuing any mutation and journals the conflict', async (t) => {
  const { dataDir, service } = await setup(t);
  await authorize(service);
  const seen = docsFetch({ document: fixtureDocument({ revisionId: 'newer-revision' }) });
  const operation = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'older-revision', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'better words', operationId: 'stale-op-0001' };
  await assert.rejects(service.suggest(operation), { code: 'GOOGLE_REVISION_CONFLICT' });
  assert.equal(seen.batch.length, 0);
  const operationsDir = path.join(dataDir, 'google', 'operations');
  const files = await readdir(operationsDir);
  assert.equal(files.length, 1);
  assert.equal((await readFile(path.join(operationsDir, files[0]), 'utf8')).includes('older-revision'), false);
});

test('sends exact UTF-16 ranges in SUGGEST mode and verifies the returned suggestion ID', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  let calls = 0;
  const seen = docsFetch({ onBatch: async (_url, options) => {
    const request = JSON.parse(options.body);
    if (calls === 0) {
      assert.deepEqual(request.writeControl, { requiredRevisionId: 'rev-1', writeMode: 'SUGGEST' });
      assert.deepEqual(request.requests[0].deleteContentRange.range, { startIndex: 2, endIndex: 4, tabId: 'tab-1' });
      assert.deepEqual(request.requests[1].insertText.location, { index: 2, tabId: 'tab-1' });
      assert.equal(request.requests[1].insertText.text, 'XYZ');
    } else {
      assert.equal(request.requests.length, 1);
      assert.deepEqual(request.requests[0].updateTextStyle.textStyle, { bold: true });
      assert.equal(request.requests[0].updateTextStyle.fields, '*');
      assert.deepEqual(request.requests[0].updateTextStyle.range, { startIndex: 4, endIndex: 7, tabId: 'tab-1' });
      assert.deepEqual(request.writeControl, { requiredRevisionId: 'rev-2', writeMode: 'SUGGEST' });
    }
    calls++;
    return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
  } });
  // Before mutation the old document is returned. The next read is the persisted inline suggestion view.
  const rawFetch = globalThis.fetch;
  let documentCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) return rawFetch(url, options);
    if (String(url).includes('/documents/doc-1?')) {
      if (documentCalls++ === 0) return rawFetch(url, options);
      return new Response(JSON.stringify(fixtureSuggestionDocument()), { status: 200 });
    }
    const response = await rawFetch(url, options);
    return response;
  };
  const result = await service.suggest({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: 'suggest-op-0001' });
  assert.equal(calls, 2);
  assert.deepEqual(result.suggestionIds, ['suggest-new-1']);
  assert.equal(result.nativeVisualValidated, false);
});

test('preserves selected style when insertion inherits a differently styled predecessor', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  docsFetch({ document: fixtureStyledDocument() });
  const rawFetch = globalThis.fetch;
  let documentCalls = 0;
  let batchCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) {
      const request = JSON.parse(options.body);
      if (batchCalls++ === 1) {
        assert.deepEqual(request.requests[0].updateTextStyle.textStyle, { italic: true });
        assert.equal(request.requests[0].updateTextStyle.fields, '*');
        assert.deepEqual(request.requests[0].updateTextStyle.range, { startIndex: 4, endIndex: 7, tabId: 'tab-1' });
        assert.deepEqual(request.writeControl, { requiredRevisionId: 'rev-2', writeMode: 'SUGGEST' });
      }
      return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
    }
    if (String(url).includes('/documents/doc-1?') && documentCalls++ > 0) {
      return new Response(JSON.stringify(fixtureStyledSuggestionDocument({ includeStyle: documentCalls > 2 })), { status: 200 });
    }
    return rawFetch(url, options);
  };
  const result = await service.suggest({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: 'style-preserve-0001' });
  assert.deepEqual(result.suggestionIds, ['suggest-new-1']);
});

test('verifies style changes already attached to the insertion suggestion ID', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  docsFetch({ document: fixtureStyledDocument() });
  const rawFetch = globalThis.fetch;
  let documentCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
    if (String(url).includes('/documents/doc-1?') && documentCalls++ > 0) {
      // Google creates the style-change record with the insertion suggestion, then
      // returns that same record after the style request updates the suggestion.
      return new Response(JSON.stringify(fixtureStyledSuggestionDocument({ includeStyle: true })), { status: 200 });
    }
    return rawFetch(url, options);
  };
  const result = await service.suggest({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: 'style-reuses-insertion-id-0001' });
  assert.deepEqual(result.suggestionIds, ['suggest-new-1']);
});

test('does not verify a suggestion when surrounding text style, structure, or inserted style changed', async (t) => {
  for (const [name, after] of [
    ['neighbor style', fixtureStyledSuggestionDocument({ neighborStyle: { bold: false } })],
    ['inline object', fixtureStyledSuggestionDocument({ includeObject: true })],
    ['inserted style', fixtureStyledSuggestionDocument({ insertedStyle: { bold: false, italic: false } })],
    ['missing inserted style suggestion', fixtureStyledSuggestionDocument({ insertedBaseStyle: { italic: true }, includeStyle: false })],
  ]) {
    await t.test(name, async (st) => {
      const { service } = await setup(st);
      await authorize(service);
      docsFetch({ document: fixtureStyledDocument() });
      const rawFetch = globalThis.fetch;
      let documentCalls = 0;
      globalThis.fetch = async (url, options = {}) => {
        if (String(url).includes(':batchUpdate')) return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
        if (String(url).includes('/documents/doc-1?')) {
          const call = documentCalls++;
          if (call === 0) return rawFetch(url, options);
          return new Response(JSON.stringify(call === 1 ? fixtureStyledSuggestionDocument({ includeStyle: false }) : after), { status: 200 });
        }
        return rawFetch(url, options);
      };
      await assert.rejects(service.suggest({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: `style-reject-${name.replaceAll(' ', '-')}` }), { code: 'GOOGLE_SUGGESTION_NEEDS_REVIEW' });
    });
  }
});

test('journals an unknown style-phase result as review-required and refuses retry', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  docsFetch({ document: fixtureStyledDocument() });
  const rawFetch = globalThis.fetch;
  let batchCalls = 0;
  let documentCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) {
      if (batchCalls++ === 0) return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
      throw new Error('connection lost after style request');
    }
    if (String(url).includes('/documents/doc-1?')) {
      if (documentCalls++ === 0) return rawFetch(url, options);
      return new Response(JSON.stringify(fixtureStyledSuggestionDocument({ includeStyle: false })), { status: 200 });
    }
    return rawFetch(url, options);
  };
  const operation = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'XYZ', operationId: 'style-unknown-0001' };
  await assert.rejects(service.suggest(operation), { code: 'GOOGLE_SUGGESTION_NEEDS_REVIEW' });
  await assert.rejects(service.suggest(operation), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  assert.equal(batchCalls, 2);
});

test('verifies that a saved comment thread is anchored to the exact range and quote', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  const seen = docsFetch();
  const rawFetch = globalThis.fetch;
  let documentCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) {
      const request = JSON.parse(options.body);
      assert.deepEqual(request.requests[0].insertComment.range, { startIndex: 2, endIndex: 4, tabId: 'tab-1' });
      return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 });
    }
    if (String(url).includes('/documents/doc-1?') && documentCalls++ > 0) {
      const value = fixtureDocument({ revisionId: 'rev-2' });
      value.comments = [{ commentId: 'comment-1', anchorId: 'anchor-1', plainTextQuote: '😀', headPost: { content: 'Please check this wording.' } }];
      value.tabs[0].documentTab.commentAnchors = { 'anchor-1': { anchorId: 'anchor-1', ranges: [{ startIndex: 2, endIndex: 4 }] } };
      return new Response(JSON.stringify(value), { status: 200 });
    }
    return rawFetch(url, options);
  };
  const result = await service.comment({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Please check this wording.', operationId: 'comment-op-0001' });
  assert.equal(result.commentId, 'comment-1');
  assert.equal(result.anchorId, 'anchor-1');
  assert.equal(result.nativeVisualValidated, false);
  assert.equal(seen.batch.length, 0);
});

test('records unknown write outcomes and refuses a blind retry with the same operation ID', async (t) => {
  const { service } = await setup(t);
  await authorize(service);
  let batchCalls = 0;
  const seen = docsFetch();
  const rawFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes(':batchUpdate')) { batchCalls++; throw new Error('connection lost after send'); }
    return rawFetch(url, options);
  };
  const operation = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', replacement: 'replacement', operationId: 'unknown-op-0001' };
  await assert.rejects(service.suggest(operation), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  await assert.rejects(service.suggest(operation), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  assert.equal(batchCalls, 1);
  assert.equal(seen.batch.length, 0);
});

test('an unresolved document write blocks new IDs after service reload and reports pending state', async (t) => {
  const { dataDir, service } = await setup(t);
  await authorize(service);
  let batchCalls = 0;
  const rawFetch = globalThis.fetch;
  docsFetch({ onBatch: async () => { batchCalls++; throw new Error('connection lost after send'); } });
  const withAuth = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/token') || String(url).includes('/certs')) return rawFetch(url, options);
    return withAuth(url, options);
  };
  await assert.rejects(service.comment({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Review this.', operationId: 'unknown-doc-lock-1' }), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  const readback = await service.readDocument('doc-1');
  assert.deepEqual(readback.pendingOperations, [{ operationId: 'unknown-doc-lock-1', state: 'outcome_unknown', createdAt: readback.pendingOperations[0].createdAt, phase: 'write', active: false }]);
  const restarted = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  await assert.rejects(restarted.comment({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-2', startIndex: 2, endIndex: 4, quote: '😀', text: 'Another change.', operationId: 'unknown-doc-lock-2' }), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  assert.equal(batchCalls, 1);
});

test('serializes different operation IDs on one document while a write is active', async (t) => {
  const { dataDir, service } = await setup(t);
  await authorize(service);
  const ownerId = createHash('sha256').update(path.resolve(dataDir)).digest('hex');
  const second = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' });
  let batchStarted;
  let finishBatch;
  const started = new Promise((resolve) => { batchStarted = resolve; });
  const seen = docsFetch({ onBatch: async () => {
    batchStarted();
    return new Promise((resolve) => { finishBatch = resolve; });
  } });
  const active = service.comment({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Active write.', operationId: 'active-doc-lock-1' });
  await started;
  await assert.rejects(second.reconcileOperation({ documentId: 'doc-1', operationId: 'active-doc-lock-1', authorReviewed: true, ownerId }), { code: 'GOOGLE_OPERATION_ACTIVE' });
  const pending = await second.readDocument('doc-1');
  assert.equal(pending.pendingOperations.find((item) => item.operationId === 'active-doc-lock-1').active, true);
  await assert.rejects(second.comment({ documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Concurrent write.', operationId: 'active-doc-lock-2' }), { code: 'GOOGLE_OPERATION_ACTIVE' });
  assert.equal(seen.batch.length, 1);
  finishBatch(new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 }));
  await assert.rejects(active, { code: 'GOOGLE_OUTCOME_UNKNOWN' });
});

test('manual owner reconciliation releases only the matching unresolved lock and never marks it verified', async (t) => {
  const { dataDir } = await setup(t);
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', ownerId: 'owner-one' });
  await authorize(service);
  let batchCalls = 0;
  docsFetch({ onBatch: async () => { batchCalls++; if (batchCalls === 1) throw new Error('connection lost after send'); return new Response(JSON.stringify({ commentUpdateState: 'ALL_SAVED', replies: [] }), { status: 200 }); } });
  const first = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Review this.', operationId: 'manual-review-op-1' };
  await assert.rejects(service.comment(first), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  await assert.rejects(service.reconcileOperation({ documentId: 'other-doc', operationId: first.operationId, authorReviewed: true, ownerId: 'owner-one' }), { code: 'GOOGLE_RECONCILIATION_NOT_FOUND' });
  await assert.rejects(service.reconcileOperation({ documentId: 'doc-1', operationId: first.operationId, authorReviewed: true, ownerId: 'wrong-owner' }), { code: 'GOOGLE_RECONCILIATION_FORBIDDEN' });
  const acknowledged = await service.reconcileOperation({ documentId: 'doc-1', operationId: first.operationId, authorReviewed: true, ownerId: 'owner-one' });
  assert.equal(acknowledged.state, 'author_reviewed');
  assert.equal(acknowledged.machineVerified, false);
  assert.equal(acknowledged.nativeVisualValidated, false);
  await assert.rejects(service.comment(first), { code: 'GOOGLE_OPERATION_RECONCILED' });
  const fresh = { ...first, revisionId: 'rev-1', text: 'A fresh review.', operationId: 'manual-review-op-2' };
  await assert.rejects(service.comment(fresh), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  await assert.rejects(service.comment({ ...first, text: 'Different operation body.' }), { code: 'GOOGLE_OPERATION_RECONCILED' });
  assert.equal(batchCalls, 2);
});

test('owner can reconcile an orphan lock after restart and inactive started work is reviewable', async (t) => {
  const { dataDir } = await setup(t);
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', ownerId: 'owner-one' });
  await authorize(service);
  const googleDir = path.join(dataDir, 'google');
  const journalDir = path.join(googleDir, 'operations');
  await mkdir(journalDir, { recursive: true });
  const key = await readFile(path.join(googleDir, 'storage.key'));
  const now = new Date().toISOString();
  const orphan = { operationId: 'orphan-lock-operation', documentId: 'doc-1', kind: 'comment', signature: 'saved-signature', state: 'started', createdAt: now, phase: 'reserved' };
  await writeEncryptedFixture(path.join(journalDir, `${sha256('doc-1')}.lock`), orphan, key);
  const recovered = await service.reconcileOperation({ documentId: 'doc-1', operationId: orphan.operationId, authorReviewed: true, ownerId: 'owner-one' });
  assert.equal(recovered.state, 'author_reviewed');
  const recoveredJournal = JSON.parse(await readFile(path.join(journalDir, `${sha256(orphan.operationId)}.enc`), 'utf8'));
  assert.ok(recoveredJournal.data);

  const inactive = { ...orphan, operationId: 'started-after-restart', state: 'started' };
  await writeEncryptedFixture(path.join(journalDir, `${sha256(inactive.operationId)}.enc`), inactive, key);
  await writeEncryptedFixture(path.join(journalDir, `${sha256('doc-1')}.lock`), inactive, key);
  docsFetch();
  const restarted = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', ownerId: 'owner-one' });
  const readback = await restarted.readDocument('doc-1');
  assert.equal(readback.pendingOperations.find((item) => item.operationId === inactive.operationId).active, false);
  const reviewed = await restarted.reconcileOperation({ documentId: 'doc-1', operationId: inactive.operationId, authorReviewed: true, ownerId: 'owner-one' });
  assert.equal(reviewed.state, 'author_reviewed');
  assert.equal(reviewed.machineVerified, false);
  assert.equal(reviewed.nativeVisualValidated, false);
});

test('failed reservation never terminalizes an orphan lock across retries or service restart', async (t) => {
  const { dataDir } = await setup(t);
  const ownerId = 'owner-orphan-retry';
  const service = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', ownerId });
  await authorize(service);
  const googleDir = path.join(dataDir, 'google');
  const journalDir = path.join(googleDir, 'operations');
  const key = await readFile(path.join(googleDir, 'storage.key'));
  const orphan = { operationId: 'orphan-retry-operation', documentId: 'doc-1', kind: 'comment', signature: 'orphan-signature', state: 'started', createdAt: new Date().toISOString(), phase: 'reserved' };
  const lockPath = path.join(journalDir, `${sha256('doc-1')}.lock`);
  const orphanJournalPath = path.join(journalDir, `${sha256(orphan.operationId)}.enc`);
  await writeEncryptedFixture(lockPath, orphan, key);
  const originalLock = await readFile(lockPath, 'utf8');
  const operation = { documentId: 'doc-1', tabId: 'tab-1', revisionId: 'rev-1', startIndex: 2, endIndex: 4, quote: '😀', text: 'Review this.', operationId: orphan.operationId };

  await assert.rejects(service.comment(operation), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  await assert.rejects(readFile(orphanJournalPath), { code: 'ENOENT' });
  assert.equal(await readFile(lockPath, 'utf8'), originalLock);
  await assert.rejects(service.comment({ ...operation, operationId: 'orphan-retry-new-id' }), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  await assert.rejects(readFile(orphanJournalPath), { code: 'ENOENT' });

  const restarted = createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787', ownerId });
  await assert.rejects(restarted.comment(operation), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  await assert.rejects(restarted.comment({ ...operation, operationId: 'orphan-retry-after-restart' }), { code: 'GOOGLE_DOCUMENT_OPERATION_PENDING' });
  await assert.rejects(readFile(orphanJournalPath), { code: 'ENOENT' });
  assert.equal(await readFile(lockPath, 'utf8'), originalLock);

  const reviewed = await restarted.reconcileOperation({ documentId: 'doc-1', operationId: orphan.operationId, authorReviewed: true, ownerId });
  assert.equal(reviewed.state, 'author_reviewed');
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  const reviewedJournal = JSON.parse(await readFile(orphanJournalPath, 'utf8'));
  assert.ok(reviewedJournal.data);
});
