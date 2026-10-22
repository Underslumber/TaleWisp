import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../server.mjs';

test('studio HTTP requires authentication/origin, binds server scope, limits upload, and serves only typed binary endpoints', async t => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'storyart-http-'));
  const calls = [];
  class Agent extends EventEmitter { status() { return { available: false, models: [], messages: [] }; } async shutdown() {} }
  const project = {
    catalog: async context => { calls.push(['catalog', context]); return { styles: [], workspaceRevision: context.workspaceRevision }; },
    style: async id => ({ style: { id } }),
    character: async (styleId, characterId) => { calls.push(['character', styleId, characterId]); return { styleId, character: { id: characterId }, categories: [] }; },
    characterImage: async (styleId, characterId, assetId) => { calls.push(['character-image', styleId, characterId, assetId]); return { bytes: Buffer.from([3, 4]), mimeType: 'image/png' }; },
    libraryImage: async (id, ref, hash) => { calls.push(['image', id, ref, hash]); return { bytes: Buffer.from([1, 2]), mimeType: 'image/png' }; },
    upload: async (body, context) => { calls.push(['upload', body, context]); return { upload: { id: 'fixture' } }; },
    jobs: context => { calls.push(['jobs', context]); return { requests: [] }; },
    createJob: async (body, context) => { calls.push(['create', body, context]); return { ok: true }; },
    job: async (id, context) => { calls.push(['job', id, context]); return { request: { id } }; },
    action: async (id, body, context) => { calls.push(['action', id, body, context]); return { ok: true }; }
  };
  const app = await createApplication({ dataDir: path.join(base, 'data'), vaultPath: base, catalogVaultPath: base, agent: new Agent(), googleService: { status: async () => ({}) }, googleAgentService: { status: async () => ({}) }, storyArtProject: project, host: '127.0.0.1', port: 8787 });
  t.after(async () => { await app.close(); await fs.rm(base, { recursive: true, force: true }); });
  let cookie = '';
  async function request(url, method = 'GET', body, origin = 'http://127.0.0.1:8787', additional = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.url = url; req.method = method; req.headers = { host: '127.0.0.1:8787', origin, cookie, 'content-type': 'application/json', 'x-storyart-scope': '', ...additional }; req.socket = { remoteAddress: '127.0.0.1' };
    const result = await new Promise(resolve => {
      const response = { status: 200, headers: {}, chunks: [], writeHead(status, headers) { this.status = status; this.headers = headers; }, write(value) { this.chunks.push(Buffer.from(value)); }, end(value) { if (value) this.chunks.push(Buffer.from(value)); resolve(this); } };
      app.server.emit('request', req, response);
    });
    if (result.headers['set-cookie']) cookie = result.headers['set-cookie'].split(';')[0];
    return { ...result, bytes: Buffer.concat(result.chunks) };
  }
  assert.equal((await request('/api/storyart/project')).status, 401);
  assert.equal((await request('/api/storyart/character-image?styleId=TEST&characterId=CHAR_001&assetId=asset')).status,401);
  assert.equal((await request('/api/session', 'POST', { local: true })).status, 200);
  const catalogue = await request('/api/storyart/project'); assert.equal(catalogue.status, 200);
  assert.equal(JSON.parse(catalogue.bytes).clientScope, '');
  for (const route of ['/api/storyart/project', '/api/storyart/jobs', '/api/storyart/styles/TEST', '/api/storyart/styles/TEST/characters/CHAR_001']) {
    const wrongScope = await request(route, 'GET', undefined, 'http://127.0.0.1:8787', { 'x-storyart-scope': 'stale/book' });
    assert.equal(wrongScope.status, 409); assert.equal(JSON.parse(wrongScope.bytes).code, 'scope_changed');
  }
  assert.equal((await request('/api/storyart/uploads', 'POST', {name:'x'}, 'http://127.0.0.1:8787', {'x-storyart-scope':'wrong'})).status,409);
  const bad = await request('/api/storyart/jobs', 'POST', { scope: 'forged' }, 'https://other.invalid'); assert.equal(bad.status, 403);
  assert.equal((await request('/api/storyart/jobs', 'POST', { scope: 'forged' })).status, 202);
  const creation = calls.find(row => row[0] === 'create'); assert.notEqual(creation[2].scope, 'forged'); assert.equal(typeof creation[2].workspaceRevision, 'string');
  assert.equal((await request('/api/storyart/uploads', 'POST', { name: 'x', base64: 'A'.repeat(28_000_000) })).status, 413);
  const picture = await request('/api/storyart/library-image?styleId=TEST&referenceId=REF_1&sha256=hash');
  assert.equal(picture.status, 200); assert.equal(picture.headers['x-content-type-options'], 'nosniff'); assert.match(picture.headers['content-security-policy'], /sandbox/); assert.deepEqual([...picture.bytes], [1, 2]);
  assert.deepEqual(calls.find(row => row[0] === 'image'), ['image', 'TEST', 'REF_1', 'hash']);
  const character=await request('/api/storyart/styles/TEST/characters/CHAR_001');
  assert.equal(character.status,200);assert.equal(JSON.parse(character.bytes).clientScope,'');
  assert.deepEqual(calls.find(row=>row[0]==='character'),['character','TEST','CHAR_001']);
  const characterImage=await request('/api/storyart/character-image?styleId=TEST&characterId=CHAR_001&assetId=asset');
  assert.equal(characterImage.status,200);assert.equal(characterImage.headers['x-content-type-options'],'nosniff');assert.deepEqual([...characterImage.bytes],[3,4]);
  assert.deepEqual(calls.find(row=>row[0]==='character-image'),['character-image','TEST','CHAR_001','asset']);
});
