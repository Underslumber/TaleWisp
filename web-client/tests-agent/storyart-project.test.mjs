import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStoryArtProject, parseStoryArtCsv, storyArtSafeFile } from '../storyart-project.mjs';
import { createStoryArtService } from '../storyart-service.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ0kAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
const ctx = { scope: 'author/series/book', workspaceRevision: 'rev-1' };
const other = { scope: 'author/other/book', workspaceRevision: 'rev-1' };
const id = '00000000-0000-4000-8000-000000000001';
async function fixture(t, overrides = {}) {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'storyart-project-')), root = path.join(base, 'StoryArt');
  await fs.mkdir(root); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const put = async (relative, value) => { const dest = path.join(root, relative); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value); return dest; };
  await put('TEST_PROJECT_PACK/.style-pack.json', { style_name: 'Тестовый стиль' });
  await put('TEST_PROJECT_PACK/03_UPLOAD_TO_WEB/00_STYLE_PROFILE.md', '# Стиль\nСохранённый профиль.');
  await put('TEST_PROJECT_PACK/03_UPLOAD_TO_WEB/00_STYLE_NEGATIVE.md', 'Не переносить чужую личность.');
  await put('TEST_PROJECT_PACK/03_UPLOAD_TO_WEB/image.png', png);
  await put('TEST_PROJECT_PACK/03_UPLOAD_TO_WEB/00_PROJECT_MANIFEST.csv', 'reference_id,filename,stored_relative_path,primary_role,status,user_approved,generator_safe,use_for,do_not_use_for\nREF_1,image.png,03_UPLOAD_TO_WEB/image.png,ANCHOR_STYLE,ANCHOR,YES,YES,Линия,Личность\nREF_BAD,secret.png,../../secret.png,MASTER_STYLE,APPROVED,YES,YES,,,\nREF_REJECTED,reject.png,01_WORK/reject.png,MASTER_STYLE,REJECTED,YES,YES,,,\nREF_TEST,pending.png,01_WORK/UPLOAD_CANDIDATES_DRAFT/pending.png,MASTER_STYLE,TEST,NO,YES,,,');
  await put('TEST_GENERATIONS/CHARACTER_REGISTRY.csv', 'character_id,name,status\nCHAR_001,Герой,APPROVED\nCHAR_002,Черновик,TEST');
  const settings = new Map(), store = { getSetting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value) }, calls = [];
  const host = {
    threadId: 'root-ui-thread',
    listTools: async () => ['list_projects', 'create_thread', 'send_message_to_thread', 'read_thread'],
    listProjects: async () => ({ projects: [{ projectId: 'storyart-project', projectKind: 'local', path: root, label: 'StoryArt' }] }),
    createThread: async input => { calls.push(['create', input]); return { threadId: 'owned-storyart-thread' }; },
    sendMessage: async input => { calls.push(['send', input]); return {}; },
    readThread: async input => { calls.push(['read', input]); return { text: `ARTIFACT_PATH: ${path.join(root, 'TEST_GENERATIONS', 'request', 'candidate.png')}\nVISUAL_QA: PASS\nCANON_QA: PENDING\nAUTHOR_APPROVAL: PENDING` }; },
    ...overrides.host
  };
  const partner = createStoryArtService({ store, hostClient: host, projectPath: root });
  let revision = 'rev-1';
  const service = createStoryArtProject({ projectPath: root, dataDir: path.join(base, 'data'), store, partner, currentRevision: () => revision });
  return { base, root, put, store, calls, partner, service, setRevision: next => { revision = next; } };
}
const input = extra => ({ requestId: id, workspaceRevision: 'rev-1', kind: 'generation', title: 'Иллюстрация', styleId: 'TEST', prompt: 'Герой у окна.', referenceIds: ['REF_1'], options: { bodyLibrary: 'off' }, ...extra });

test('CSV supports quoted commas/newlines and refuses incomplete quotes', () => {
  assert.deepEqual(parseStoryArtCsv('\uFEFFid,text\r\n1,"a,b\nline"\r\n'), [{ id: '1', text: 'a,b\nline' }]);
  assert.throws(() => parseStoryArtCsv('id,text\n1,"bad'), /реестр/);
});
test('catalog reads real profiles and only bounded registry images, no rejected/pending or arbitrary paths', async t => {
  const f = await fixture(t), result = await f.service.catalog(ctx), detail = await f.service.style('TEST');
  assert.equal(result.styles.length, 1); assert.equal(result.styles[0].name, 'Тестовый стиль');
  assert.match(detail.profile, /Сохранённый/); assert.deepEqual(detail.characters, [{ id: 'CHAR_001', name: 'Герой' }]);
  assert.deepEqual(detail.references.map(row => row.id), ['REF_1']);
  assert.equal('_relative' in detail.references[0], false);
  assert.equal((await f.service.libraryImage('TEST', 'REF_1')).sha256, hash(png));
  await assert.rejects(f.service.libraryImage('TEST', 'REF_REJECTED'));
  await assert.rejects(f.service.style('../outside'));
  await assert.rejects(storyArtSafeFile(f.root, 'TEST_PROJECT_PACK/../secret.png'));
  assert.equal(f.calls.length, 0);
});
test('read-only catalogue works without desktop and no task is started', async t => {
  const f = await fixture(t, { host: { listProjects: async () => { throw Error('offline'); } } });
  const result = await f.service.catalog(ctx);
  assert.equal(result.capabilities.available, false); assert.equal(result.styles.length, 1);
  await assert.rejects(f.service.createJob(input(), ctx), /offline/); assert.equal(f.calls.length, 0);
});
test('uploads preserve bytes, enforce content/size/name, dedupe within scope and deny cross-scope preview', async t => {
  const f = await fixture(t), payload = { workspaceRevision: 'rev-1', name: 'источник.png', base64: png.toString('base64') };
  const first = await f.service.upload(payload, ctx), again = await f.service.upload(payload, ctx);
  assert.equal(first.upload.id, again.upload.id);
  assert.deepEqual((await f.service.uploadImage(first.upload.id, ctx)).bytes, png);
  await assert.rejects(f.service.uploadImage(first.upload.id, other), /рабочей области/);
  await assert.rejects(f.service.upload({ ...payload, name: '../outside.png' }, ctx), /путь/);
  await assert.rejects(f.service.upload({ workspaceRevision: 'rev-1', name: 'fake.png', base64: Buffer.from('<svg/>').toString('base64') }, ctx), /PNG/);
  await assert.rejects(f.service.upload({ workspaceRevision: 'rev-1', name: 'bad.png', base64: 'bad' }, ctx));
  f.setRevision('rev-2');
  await assert.rejects(f.service.upload(payload, ctx), e => e.code === 'workspace_revision_changed');
});
test('creation binds real style/ref/source and scope, idempotent same request, no duplicate on concurrent clicks', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.service.createJob(input({ characterId: 'CHAR_001' }), ctx), f.service.createJob(input({ characterId: 'CHAR_001' }), ctx)]);
  assert(results.every(result => result.ok)); assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  const brief = f.calls[0][1].prompt;
  assert.match(brief, /RETURN_THREAD_ID: root-ui-thread/); assert.match(brief, /"bodyLibrary": "off"/); assert.match(brief, /REF_1/); assert.match(brief, new RegExp(hash(png)));
  assert.equal(f.service.jobs(other).requests.length, 0);
  await assert.rejects(f.service.job(id, other));
  await assert.rejects(f.service.createJob(input({ title: 'Другой запрос' }), ctx), /другим заданием/);
  await assert.rejects(f.service.createJob(input(), other), /другим заданием/);
});
test('invalid choices and stale scope fail before dispatch, style creation requires uploaded images', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.createJob(input({ referenceIds: ['REF_REJECTED'] }), ctx));
  await assert.rejects(f.service.createJob(input({ characterId: 'CHAR_002' }), ctx));
  await assert.rejects(f.service.createJob(input({ kind: 'style_create', styleName: 'New', referenceIds: [] }), ctx));
  f.setRevision('rev-2'); await assert.rejects(f.service.createJob(input(), ctx), /область изменилась/);
  assert.equal(f.calls.length, 0);
});
test('style creation dispatches actual uploaded unchanged sources without writing a style pack locally', async t => {
  const f = await fixture(t), { upload } = await f.service.upload({ workspaceRevision: 'rev-1', name: 'input.png', base64: png.toString('base64') }, ctx);
  await f.service.createJob(input({ kind: 'style_create', styleName: 'Новый стиль', styleId: undefined, referenceIds: [], uploadIds: [upload.id] }), ctx);
  assert.equal(f.calls[0][0], 'create'); assert.match(f.calls[0][1].prompt, /init|инвентаризация/); assert.match(f.calls[0][1].prompt, /storyart-uploads/);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['TEST_GENERATIONS', 'TEST_PROJECT_PACK']);
});
test('unknown create outcome cannot be replayed, even after reload', async t => {
  const f = await fixture(t, { host: { createThread: async () => { f.calls.push(['create']); throw Error('unknown network outcome'); } } });
  await assert.rejects(f.service.createJob(input(), ctx), /not confirmed|unknown|подтвержд|did not confirm/);
  await assert.rejects(f.service.createJob(input(), ctx), /Повторный запуск/);
  assert.equal(f.calls.length, 1);
});
test('jobs keep QA independent of completed and approval sends only exact artifact hash with idempotency', async t => {
  const f = await fixture(t); await f.service.createJob(input(), ctx);
  await f.put('TEST_GENERATIONS/request/candidate.png', png);
  await f.service.action(id, { action: 'read', workspaceRevision: 'rev-1' }, ctx);
  const job = await f.service.job(id, ctx);
  const displayedHash = job.request.artifacts[0].sha256;
  assert.equal(displayedHash, hash(png));
  assert.match(job.request.artifacts[0].url, new RegExp('sha256='+displayedHash));
  assert.equal(job.request.visualQa, 'PASS'); assert.equal(job.request.canonQa, 'PENDING'); assert.equal(job.request.authorApproval, 'PENDING');
  await assert.rejects(f.service.action(id, { action: 'approve', artifactIndex: 0, expectedSha256: 'a'.repeat(64), workspaceRevision: 'rev-1' }, ctx), e => e.code === 'artifact_changed');
  assert.equal(f.calls.filter(call=>call[0]==='send').length,0);
  await f.service.action(id, { action: 'approve', artifactIndex: 0, expectedSha256: displayedHash, workspaceRevision: 'rev-1' }, ctx);
  await f.service.action(id, { action: 'approve', artifactIndex: 0, expectedSha256: displayedHash, workspaceRevision: 'rev-1' }, ctx);
  const sends = f.calls.filter(call => call[0] === 'send'); assert.equal(sends.length, 1); assert.match(sends[0][1].prompt, new RegExp(hash(png)));
  assert.equal((await f.service.job(id, ctx)).request.lastAction.result, 'sent_not_saved');
  await f.put('TEST_GENERATIONS/request/candidate.png', Buffer.concat([png,Buffer.from('changed')]));
  await assert.rejects(f.service.action(id, { action: 'approve', artifactIndex: 0, expectedSha256: displayedHash, workspaceRevision:'rev-1' }, ctx), e=>e.code==='artifact_changed');
  assert.equal(f.calls.filter(call=>call[0]==='send').length,1);
  await assert.rejects(f.service.action(id, { action: 'approve', workspaceRevision: 'rev-1' }, ctx));
  await assert.rejects(f.service.action(id, { action: 'correction', message: 'x', workspaceRevision: 'rev-1' }, other));
});
test('process reads only the explicitly bound request; prepared and executed refs are separate real records', async t => {
  const f = await fixture(t); await f.service.createJob(input(), ctx);
  const folder = path.join(f.root, 'requests', id), thread = 'owned-storyart-thread';
  await f.put(`.agent/chat_requests/chats/${hash(thread)}.json`, { thread_id: thread, active_folder: folder });
  await f.put(`.agent/chat_requests/folders/${hash(path.resolve(folder))}.json`, { thread_id: thread, active_folder: folder });
  const call = { slots: [{ path: '/image/executed.png', role: 'FACE', sha256: 'b'.repeat(64) }] };
  const guard = { schema_version: 1, owner_chat_id: thread, request_id: id, phase: 'EXECUTION', status: 'ACTIVE', next_required_action: 'WAIT', required_stages: [{ id: '01_FACE_IDENTITY', status: 'PENDING' }], events: [{ at: 'now', event: 'EXECUTION_STARTED', summary: 'Запуск' }], attempts: [{ attempt_id: 'attempt', status: 'ACTIVE', provider_operation_receipt: 'fixture-receipt', execution_snapshot: { request_id: id, attempt_id: 'attempt', execution_call_sha256: hash(JSON.stringify(call)), execution_call: call } }] };
  await f.put(`requests/${id}/EXECUTION_GUARD.json`, guard);
  await f.put(`requests/${id}/REFERENCE_PLAN.json`, { request_id: id, execution_call: { slots: [{ path: '/image/planned.png', role: 'STYLE', sha256: 'a'.repeat(64) }] } });
  const result = await f.service.job(id, ctx);
  assert.equal(result.process.available, true); assert.equal(result.process.phase, 'EXECUTION');
  assert.equal(result.process.selectedReferences[0].id, 'REF_1');
  assert.equal(result.process.preparedReferences[0].name, 'planned.png'); assert.equal(result.process.executedReferences[0].name, 'executed.png');
  delete guard.attempts[0].provider_operation_receipt;
  await f.put(`requests/${id}/EXECUTION_GUARD.json`, guard);
  assert.equal((await f.service.job(id, ctx)).process.executedReferences.length, 0, 'EXECUTION_STARTED alone is not proof that attachments were delivered');
  await f.put(`.agent/chat_requests/folders/${hash(path.resolve(folder))}.json`, { thread_id: 'foreign', active_folder: folder });
  assert.equal((await f.service.job(id, ctx)).process.available, false);
});
test('symlink library resources are rejected rather than following an external file', async t => {
  const f = await fixture(t), file = path.join(f.root, 'TEST_PROJECT_PACK/03_UPLOAD_TO_WEB/image.png');
  await fs.unlink(file); await fs.writeFile(path.join(f.base, 'outside.png'), png);
  try { await fs.symlink(path.join(f.base, 'outside.png'), file); } catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('Host does not allow creating test symlinks'); throw e; }
  await assert.rejects(f.service.libraryImage('TEST', 'REF_1'), /Ссылки/);
});
