import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createGoogleService } from '../google.mjs';
import { createPluginService } from '../plugin-service.mjs';
import { parseBoundedA1Range } from '../google-sheets.mjs';

const originalFetch = globalThis.fetch;
const oldEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, redirect: process.env.GOOGLE_REDIRECT_URI };
const SPREADSHEET_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'talewisp-sheets-'));
  process.env.GOOGLE_CLIENT_ID = 'sheets-fixture.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://127.0.0.1:8787/api/google/callback';
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ GOOGLE_CLIENT_ID: oldEnv.id, GOOGLE_CLIENT_SECRET: oldEnv.secret, GOOGLE_REDIRECT_URI: oldEnv.redirect })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dataDir, google: createGoogleService({ dataDir, origin: 'http://127.0.0.1:8787' }) };
}

async function authorize(google, fixture, scopes) {
  const includeSheets = scopes.includes(SPREADSHEET_SCOPE);
  const { authUrl } = await google.beginLogin({ includeSheets });
  const auth = new URL(authUrl);
  const requested = auth.searchParams.get('scope').split(' ');
  assert.ok(scopes.every(scope => requested.includes(scope)));
  if (!includeSheets) assert.equal(requested.some(scope => scope.includes('/auth/spreadsheets')), false, 'Docs/default login must not request new Sheets consent');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'sheets-test-key'; jwk.alg = 'RS256';
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, nonce: auth.searchParams.get('nonce') });
  const signingInput = `${head}.${body}`;
  const signer = createSign('RSA-SHA256'); signer.update(signingInput); signer.end();
  const idToken = `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const request = new URLSearchParams(options.body);
      if (request.get('grant_type') === 'authorization_code') return new Response(JSON.stringify({ access_token: 'fixture', refresh_token: 'refresh', expires_in: 3600, scope: scopes.join(' '), id_token: idToken }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }), { status: 200 });
    }
    if (String(url) === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    return fixture.fetchHandler(url, options);
  };
  await google.callback(`${auth.searchParams.get('redirect_uri')}?code=fixture-code&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
  return { authUrl, requested };
}

function gridFetch({ values = [['Name', 'Source'], ['Hero', '=A1']] } = {}) {
  const seen = { metadata: [], values: [], writes: [] };
  let current = structuredClone(values);
  const fetchHandler = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }), { status: 200 });
    if (parsed.pathname.endsWith('/v3/certs')) return new Response(JSON.stringify({ keys: [] }), { status: 200 });
    if (parsed.pathname.endsWith('/drive/v3/files')) return new Response(JSON.stringify({ files: [{ id: 'sheet-1', name: 'Linked index', mimeType: 'application/vnd.google-apps.spreadsheet' }] }), { status: 200 });
    if (parsed.pathname === '/v4/spreadsheets/sheet-1') {
      seen.metadata.push(parsed);
      return new Response(JSON.stringify({ spreadsheetId: 'sheet-1', properties: { title: 'Linked index' }, sheets: [{ properties: { sheetId: 1, title: 'Index', index: 0, gridProperties: { rowCount: 200, columnCount: 8 } } }] }), { status: 200 });
    }
    if (parsed.pathname === '/v4/spreadsheets/sheet-1/values/Index!A1%3AB2') {
      seen.values.push({ url: parsed, method: options.method ?? 'GET' });
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        seen.writes.push({ url: parsed, body });
        current = body.values;
        return new Response(JSON.stringify({ updatedCells: 4 }), { status: 200 });
      }
      const apiValues = current.map(row => [...row]);
      for (const row of apiValues) while (row.length && row.at(-1) === '') row.pop();
      while (apiValues.length && apiValues.at(-1).length === 0) apiValues.pop();
      return new Response(JSON.stringify({ range: 'Index!A1:B2', majorDimension: 'ROWS', values: apiValues }), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL ${url}`);
  };
  return { seen, fetchHandler, get values() { return current; }, set values(next) { current = next; } };
}

test('A1 validation rejects unbounded grids and caps every exact range at 2,000 cells', () => {
  assert.deepEqual(parseBoundedA1Range("'Source Index'!A1:F20"), { range: "'Source Index'!A1:F20", cells: 120, rows: 20, columns: 6 });
  assert.throws(() => parseBoundedA1Range('Index!A:A'), /exact, finite A1 range/);
  assert.throws(() => parseBoundedA1Range('Index!A1:Z100'), /limited to 2000 cells/);
  assert.throws(() => parseBoundedA1Range('Index!A1:B9007199254740992'), /safe integers/);
});

test('linked index read searches spreadsheets and preserves formula values from the selected bounded range', async t => {
  const { dataDir, google } = await setup(t);
  // Existing Drive read authorization is sufficient for the read-only Sheets API methods.
  const fixture = gridFetch();
  await authorize(google, fixture, ['openid', 'https://www.googleapis.com/auth/documents', DRIVE_READ_SCOPE]);
  const listed = await google.listSpreadsheets({ query: 'Linked', pageSize: 10 });
  assert.equal(listed.files[0].id, 'sheet-1');
  const result = await google.readSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2' });
  assert.equal(result.title, 'Linked index');
  assert.deepEqual(result.values, [['Name', 'Source'], ['Hero', '=A1']]);
  assert.equal(result.valueRenderOption, 'FORMULA');
  assert.equal(fixture.seen.metadata.length, 1);
  assert.equal(fixture.seen.values.at(-1).url.searchParams.get('valueRenderOption'), 'FORMULA');
  assert.equal(fixture.seen.values.at(-1).url.pathname.includes('A1%3AB2'), true);
  const state = await google.capabilities();
  assert.equal(state.canReadSheets, true);
  assert.equal(state.canWriteSheets, false);
});

test('update proposal queues exact before-values and only writes after UI apply, then verifies RAW readback', async t => {
  const { dataDir, google } = await setup(t);
  const fixture = gridFetch({ values: [['Name', 'Source'], ['Hero', 'Source.md']] });
  await authorize(google, fixture, ['openid', 'https://www.googleapis.com/auth/documents', DRIVE_READ_SCOPE, SPREADSHEET_SCOPE]);
  const queued = [];
  const workspaceService = { revision: async () => 'rev-1', queueAction: async payload => { const action = { id: `action-${queued.length + 1}`, ...payload, workspaceRevision: 'rev-1' }; queued.push(action); return action; } };
  const plugin = createPluginService({ workspaceService, dataDir, pythonExecutable: 'python', talewispMcpPath: 'unused.py', googleService: google });
  plugin.tools = async () => [
    { name: 'talewisp_web_sheets_read', inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, required: ['spreadsheetId', 'range'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'talewisp_web_sheets_update', inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, beforeHash: { type: 'string' }, values: { type: 'array' }, operationId: { type: 'string' } }, required: ['spreadsheetId', 'range', 'beforeHash', 'values', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  ];
  const capabilityStatus = await plugin.capabilities();
  assert.deepEqual(capabilityStatus.googleDocs, { authenticated: true, canRead: true, canSuggest: true, canComment: false });
  assert.deepEqual(capabilityStatus.googleSheets, { authenticated: true, canRead: true, canWrite: true });
  const read = await plugin.call('talewisp_web_sheets_read', { spreadsheetId: 'sheet-1', range: 'Index!A1:B2' }, 'rev-1');
  const staged = await plugin.call('talewisp_web_sheets_update', { spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeHash: read.valueHash, values: [['Name', 'Source'], ['Heroine', 'Source.md']], operationId: 'index-update-0001' }, 'rev-1');
  assert.equal(staged.status, 'pending_author_review');
  assert.deepEqual(queued[0].arguments.beforeValues, [['Name', 'Source'], ['Hero', 'Source.md']]);
  assert.equal(fixture.seen.writes.length, 0, 'staging never sends a Google write');
  const applied = await plugin.applyAction(queued[0]);
  assert.equal(applied.verified, true);
  assert.equal(applied.atomicRevisionGuard, false);
  assert.equal(fixture.seen.writes[0].url.searchParams.get('valueInputOption'), 'RAW');
  assert.deepEqual(fixture.values, [['Name', 'Source'], ['Heroine', 'Source.md']]);
  assert.equal(fixture.seen.values.at(-1).method, 'GET');
  assert.match(applied.warning, /no atomic revision guard/);
  await plugin.shutdown();
});

test('stale exact-value precondition conflicts and timeout never blind-retries a Sheets write', async t => {
  const { google } = await setup(t);
  const fixture = gridFetch({ values: [['Name', 'Source'], ['Hero', 'Source.md']] });
  await authorize(google, fixture, ['openid', 'https://www.googleapis.com/auth/documents', DRIVE_READ_SCOPE, SPREADSHEET_SCOPE]);
  const base = await google.readSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2' });
  fixture.values = [['Changed', 'Source'], ['Hero', 'Source.md']];
  await assert.rejects(google.updateSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeValues: base.values, beforeHash: base.valueHash, values: [['Name', 'Source'], ['Heroine', 'Source.md']], operationId: 'index-conflict-0001' }), { code: 'GOOGLE_SHEET_CONFLICT' });

  fixture.values = base.values;
  const original = globalThis.fetch;
  let putCount = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.includes('/values/') && options.method === 'PUT') { putCount++; throw new Error('response lost'); }
    return original(url, options);
  };
  const operation = { spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeValues: base.values, beforeHash: base.valueHash, values: [['Name', 'Source'], ['Heroine', 'Source.md']], operationId: 'index-timeout-0001' };
  await assert.rejects(google.updateSpreadsheet(operation), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  await assert.rejects(google.updateSpreadsheet(operation), { code: 'GOOGLE_SHEET_OUTCOME_UNKNOWN' });
  assert.equal(putCount, 1);
  await assert.rejects(google.updateSpreadsheet({ ...operation, operationId: 'index-timeout-0002' }), { code: 'GOOGLE_SHEET_OPERATION_PENDING' });
});

test('RAW updates reject formula-bearing target ranges while bounded reads preserve formulas', async t => {
  const { dataDir, google } = await setup(t);
  const fixture = gridFetch();
  await authorize(google, fixture, ['openid', 'https://www.googleapis.com/auth/documents', DRIVE_READ_SCOPE, SPREADSHEET_SCOPE]);
  const before = await google.readSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2' });
  assert.deepEqual(before.values, [['Name', 'Source'], ['Hero', '=A1']]);
  const plugin = createPluginService({ workspaceService: { revision: async () => 'rev-1', queueAction: async () => assert.fail('formula-bearing index update must not be staged') }, dataDir, pythonExecutable: 'python', talewispMcpPath: 'unused.py', googleService: google });
  plugin.tools = async () => [{ name: 'talewisp_web_sheets_update', inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, beforeHash: { type: 'string' }, values: { type: 'array' }, operationId: { type: 'string' } }, required: ['spreadsheetId', 'range', 'beforeHash', 'values', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true } }];
  await assert.rejects(plugin.call('talewisp_web_sheets_update', { spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeHash: before.valueHash, values: [['Name', 'Source'], ['Heroine', 'Person.md']], operationId: 'index-fact-formula-0001' }, 'rev-1'), { code: 'GOOGLE_SHEET_FORMULA_UNSUPPORTED' });
  await assert.rejects(google.updateSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeValues: before.values, beforeHash: before.valueHash, values: [['Name', 'Source'], ['Heroine', '=A1']], operationId: 'index-formula-0001' }), { code: 'GOOGLE_SHEET_FORMULA_UNSUPPORTED' });
  assert.equal(fixture.seen.writes.length, 0);
  await plugin.shutdown();
});

test('readback restores a cleared trailing cell and a proven preflight read failure releases its lock', async t => {
  const { google } = await setup(t);
  const fixture = gridFetch({ values: [['Name', 'Source'], ['Hero', 'Source.md']] });
  await authorize(google, fixture, ['openid', 'https://www.googleapis.com/auth/documents', DRIVE_READ_SCOPE, SPREADSHEET_SCOPE]);
  const before = await google.readSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2' });
  const clearing = { spreadsheetId: 'sheet-1', range: 'Index!A1:B2', beforeValues: before.values, beforeHash: before.valueHash, values: [['Name', 'Source'], ['Hero', '']], operationId: 'index-clear-tail-0001' };
  const applied = await google.updateSpreadsheet(clearing);
  assert.equal(applied.verified, true);
  assert.deepEqual(fixture.values, [['Name', 'Source'], ['Hero', '']]);

  const after = await google.readSpreadsheet({ spreadsheetId: 'sheet-1', range: 'Index!A1:B2' });
  fixture.values = before.values;
  const original = globalThis.fetch;
  let failOnce = true;
  globalThis.fetch = async (url, options = {}) => {
    if (failOnce && String(url).includes('/values/') && (!options.method || options.method === 'GET')) {
      failOnce = false;
      throw new Error('preflight read unavailable');
    }
    return original(url, options);
  };
  const retry = { ...clearing, beforeValues: before.values, beforeHash: before.valueHash, values: [['Name', 'Source'], ['Heroine', 'Source.md']], operationId: 'index-preflight-0001' };
  await assert.rejects(google.updateSpreadsheet(retry), { code: 'GOOGLE_NETWORK_UNKNOWN' });
  const next = await google.updateSpreadsheet({ ...retry, operationId: 'index-preflight-0002' });
  assert.equal(next.verified, true);
  assert.equal(after.valueHash, applied.valueHash);
});

