import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createApplication } from '../server.mjs';
import { acceptsGzip, createStaticAssets, etagMatches } from '../static-assets.mjs';

class Agent extends EventEmitter { status() { return { available: true, authenticated: true, running: false, models: [], messages: [] }; } shutdown() {} }
const google = { status: async () => ({ configured: false, authenticated: false }), disconnect: async () => ({ disconnected: true }) };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tw-static-')), dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const app = await createApplication({ dataDir, host: '127.0.0.1', port: 0, lock: false, agent: new Agent(), googleService: google, googleAgentService: google });
  if (!app.server.listening) await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { get };
}

test('gzip negotiation and validator matching follow the request headers', () => {
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
  assert.equal(acceptsGzip('br;q=1.0, gzip;q=0'), false);
  assert.equal(acceptsGzip('*'), true);
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(etagMatches('"a", W/"b"', '"b"'), true);
  assert.equal(etagMatches('"a"', '"b"'), false);
});

test('a compressed body is rebuilt when the file changes and small or binary files stay as they are', async () => {
  let reads = 0;
  const assets = createStaticAssets({ readFileImpl: async () => { reads++; return Buffer.from('x'.repeat(5000)); } });
  const stat = { size: 5000, mtimeMs: 1000 };
  const first = await assets.describe({ file: 'a.js', extension: '.js', stat, acceptEncoding: 'gzip' });
  const again = await assets.describe({ file: 'a.js', extension: '.js', stat, acceptEncoding: 'gzip' });
  assert.equal(reads, 1); assert.equal(first.etag, again.etag); assert.equal(gunzipSync(first.body).length, 5000);
  const changed = await assets.describe({ file: 'a.js', extension: '.js', stat: { size: 5000, mtimeMs: 2000 }, acceptEncoding: 'gzip' });
  assert.equal(reads, 2); assert.notEqual(changed.etag, first.etag);
  assert.equal((await assets.describe({ file: 'a.js', extension: '.js', stat, acceptEncoding: '' })).body, null);
  assert.equal((await assets.describe({ file: 'a.png', extension: '.png', stat, acceptEncoding: 'gzip' })).body, null);
  assert.equal((await assets.describe({ file: 'tiny.css', extension: '.css', stat: { size: 10, mtimeMs: 1 }, acceptEncoding: 'gzip' })).body, null);
});

test('static assets answer 304 to a matching validator and travel gzipped; index.html is never cached', async t => {
  const f = await fixture(t);
  const source = readFileSync(new URL('../public/app.js', import.meta.url));
  const plain = await f.get('/app.js');
  assert.equal(plain.status, 200); assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers['cache-control'], 'no-cache'); assert.ok(plain.headers.etag); assert.deepEqual(plain.body, source);
  const zipped = await f.get('/app.js?v=1', { 'accept-encoding': 'gzip' });
  assert.equal(zipped.status, 200); assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.equal(zipped.headers.vary, 'accept-encoding');
  assert.ok(zipped.body.length < source.length / 2); assert.deepEqual(gunzipSync(zipped.body), source);
  assert.notEqual(zipped.headers.etag, plain.headers.etag);
  const unchanged = await f.get('/app.js', { 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0); assert.equal(unchanged.headers['content-encoding'], undefined);
  const stale = await f.get('/app.js', { 'accept-encoding': 'gzip', 'if-none-match': '"old"' });
  assert.equal(stale.status, 200);
  const image = await f.get('/favicon.png', { 'accept-encoding': 'gzip' });
  assert.equal(image.status, 200); assert.equal(image.headers['content-encoding'], undefined); assert.ok(image.headers.etag);
  const index = await f.get('/', { 'accept-encoding': 'gzip', 'if-none-match': '*' });
  assert.equal(index.status, 200); assert.equal(index.headers['cache-control'], 'no-store'); assert.equal(index.headers.etag, undefined);
  assert.match(index.body.toString('utf8'), /tw-style-nonce/);
});
