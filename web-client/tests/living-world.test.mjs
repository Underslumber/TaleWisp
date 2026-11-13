import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLivingWorldService } from '../living-world-service.mjs';
import { importLivingWorld, hash } from '../living-world-import.mjs';

function setup() {
  return { name: 'Независимая проба', heroId: 'hero', tickMinutes: 10, startLabel: 'Условное начало', stagingNotes: ['Не канон'], locations: [
    { id: 'road', name: 'Дорога', x: 80, y: 180, encounters: true }, { id: 'edge', name: 'Опушка', x: 400, y: 120, encounters: true }, { id: 'camp', name: 'Лагерь', x: 750, y: 250, encounters: true }],
    edges: [{ id: 'road_edge', from: 'road', to: 'edge', ticks: 2, open: true, provenance: 'test staging' }, { id: 'edge_camp', from: 'edge', to: 'camp', ticks: 2, open: true, provenance: 'test staging' }],
    characters: [
      { id: 'hero', name: 'Герой', role: 'hero', location: 'road', goal: 'Добраться к лагерю.', knowledge: [{ kind: 'approved_staging', text: 'HERO_PRIVATE_CANARY' }], plan: [] },
      { id: 'near', name: 'Путник', role: 'npc', location: 'edge', goal: 'Продолжить путь.', knowledge: [{ kind: 'approved_staging', text: 'NPC_PRIVATE_CANARY' }], plan: [] },
      { id: 'far', name: 'Дальний NPC', role: 'npc', location: 'camp', goal: 'Работать.', knowledge: [], plan: [] }], objects: [], rules: [], scheduled: [] };
}
async function fixture(t, modelRunner, definition = setup()) {
  const root = mkdtempSync(resolve('.agent/living-world-test-')), canon = join(root, 'canon'); mkdirSync(canon); mkdirSync(join(canon, '04 Анализ')); writeFileSync(join(canon, '04 Анализ', 'world.md'), '---\nstatus: author-grounded\n---\n# Мир\nИсходный мир.\n');
  let selected = { authorId: 'a', seriesId: 's', bookId: 'b' };
  const service = createLivingWorldService({ dataDir: join(root, 'data'), workspace: { selection: () => selected, root: () => canon }, modelRunner });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const imported = (await service.handle('POST', '/api/living-world/import', new URL('http://localhost'), {})).data;
  const state = await service.createBranch(imported.id, definition, true), id = state.branchId;
  const cmd = async (operation, args = {}, overrides = {}) => { const s = service.snapshot(id); return service.command(id, { operation, args, expectedRevision: s.revision, requestId: randomUUID(), ...overrides }); };
  return { service, id, cmd, canon, root, setScope: value => { selected = value; } };
}

test('source import is read-only, source hashes are raw bytes, unknown timing stays unknown', () => {
  const root = mkdtempSync(resolve('.agent/living-import-test-')); mkdirSync(join(root, '03 Сущности')); const file = join(root, '03 Сущности', 'entity.md'); const text = '---\nid: E1\nrecord_kind: entity\nstatus: supported\nvalid_from: unknown\n---\n# Сущность\nНе обязательно знание героя.\n'; writeFileSync(file, text);
  try { const snapshot = importLivingWorld(root); assert.equal(snapshot.sources[0].sha256, hash(readFileSync(file))); assert.equal(snapshot.entities[0].validFrom, 'unknown'); assert.equal(snapshot.sources[0].status, 'supported'); assert.equal(readFileSync(file, 'utf8'), text); } finally { rmSync(root, { recursive: true, force: true }); }
});
test('real WorldX movement stays in transit until duration, arrives and records a witnessed encounter', async t => {
  const f = await fixture(t); const before = readFileSync(join(f.canon, '04 Анализ/world.md'));
  await f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'edge' }); await f.cmd('step'); let s = f.service.snapshot(f.id); assert.equal(s.actors.find(a => a.id === 'hero').location, 'transit:hero'); assert.equal(s.travels.hero.arrivesAt, 2);
  const mid = s.checkpoint; await f.cmd('step'); s = f.service.snapshot(f.id); assert.equal(s.actors.find(a => a.id === 'hero').location, 'edge'); assert.ok(s.events.some(e => e.type === 'encounter' && e.text.includes('Герой')));
  const role = f.service.snapshot(f.id, { view: 'role', actorId: 'hero' }); assert.ok(!JSON.stringify(role).includes('NPC_PRIVATE_CANARY')); assert.ok(!role.actors.some(a => a.id === 'far'));
  const replay = f.service.snapshot(f.id, { checkpoint: mid }); assert.equal(replay.actors.find(a => a.id === 'hero').location, 'transit:hero'); assert.equal(replay.elapsed, 1);
  assert.deepEqual(readFileSync(join(f.canon, '04 Анализ/world.md')), before);
});
test('private knowledge, offscreen event and delivered speech keep separate audiences in live and replay', async t => {
  const f = await fixture(t);
  await f.cmd('intervene', { location: 'camp', text: 'OFFSCREEN_CANARY' }); const cp = f.service.snapshot(f.id).checkpoint;
  assert.ok(JSON.stringify(f.service.snapshot(f.id, { view: 'role', actorId: 'far' })).includes('OFFSCREEN_CANARY'));
  assert.ok(!JSON.stringify(f.service.snapshot(f.id, { view: 'role', actorId: 'hero', checkpoint: cp })).includes('OFFSCREEN_CANARY'));
  await assert.rejects(f.cmd('queueIntent', { actorId: 'near', actionType: 'speech', targetId: 'hero', text: 'SECRET_MESSAGE' }), /присутствующего/);
  await f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'edge' }); await f.cmd('step'); await f.cmd('step');
  await f.cmd('queueIntent', { actorId: 'near', actionType: 'speech', targetId: 'hero', text: 'SECRET_MESSAGE' });
  assert.ok(f.service.snapshot(f.id, { view: 'role', actorId: 'hero' }).memories.hero.some(m => m.kind === 'hearsay' && m.text.includes('SECRET_MESSAGE')));
  assert.ok(!JSON.stringify(f.service.snapshot(f.id, { view: 'role', actorId: 'far' })).includes('SECRET_MESSAGE'));
});
test('checkpoint fork preserves travel and native state, diverges without touching parent; replay calls no models', async t => {
  let models = 0; const f = await fixture(t, async () => { models++; throw Error('Must not run'); });
  await f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'camp' }); await f.cmd('step'); const parent = f.service.snapshot(f.id), child = await f.service.fork(f.id, parent.checkpoint);
  assert.deepEqual(child.travels, parent.travels); assert.equal(child.elapsed, parent.elapsed);
  await f.service.command(child.branchId, { expectedRevision: child.revision, requestId: randomUUID(), operation: 'step', args: {} });
  assert.equal(f.service.snapshot(f.id).stateHash, parent.stateHash); assert.notEqual(f.service.snapshot(child.branchId).elapsed, parent.elapsed);
  assert.equal(f.service.snapshot(f.id, { checkpoint: parent.checkpoint }).stateHash, parent.stateHash); assert.equal(models, 0);
});
test('stale and concurrent commands cannot double-apply; exact request retry is idempotent', async t => {
  const f = await fixture(t); const current = f.service.snapshot(f.id), requestId = randomUUID();
  const body = { expectedRevision: current.revision, requestId, operation: 'step', args: {} }; await f.service.command(f.id, body);
  const done = f.service.snapshot(f.id); assert.equal((await f.service.command(f.id, body)).duplicate, true); assert.equal(f.service.snapshot(f.id).stateHash, done.stateHash);
  await assert.rejects(f.service.command(f.id, { ...body, requestId: randomUUID() }), /изменилась/);
});
test('road closure blocks transit and cannot teleport; committed journey recovers on a new worker', async t => {
  const f = await fixture(t); await f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'camp' }); await f.cmd('step');
  await f.cmd('intervene', { location: 'edge', text: 'Путь закрыт.', edgeId: 'road_edge', open: false }); await f.cmd('step');
  let s = f.service.snapshot(f.id); assert.equal(s.travels.hero.status, 'blocked'); assert.equal(s.actors.find(a => a.id === 'hero').location, 'transit:hero');
  const saved = s.stateHash; await f.service.close();
  const restored = createLivingWorldService({ dataDir: join(f.root, 'data'), workspace: { selection: () => ({ authorId: 'a', seriesId: 's', bookId: 'b' }), root: () => f.canon } });
  t.after(() => restored.close()); assert.equal(restored.snapshot(f.id).stateHash, saved);
  const cmd = (operation, args = {}) => restored.command(f.id, { operation, args, expectedRevision: restored.snapshot(f.id).revision, requestId: randomUUID() });
  await cmd('intervene', { location: 'edge', text: 'Путь открыт.', edgeId: 'road_edge', open: true }); await cmd('queueIntent', { actorId: 'hero', actionType: 'resumeTravel' });
  for (let i = 0; i < 3; i++) await cmd('step');
  s = restored.snapshot(f.id); assert.equal(s.actors.find(a => a.id === 'hero').location, 'camp'); assert.equal(s.travels.hero, undefined);
});
test('workspace scope isolates branches and invalid intents leave committed checkpoint unchanged', async t => {
  const f = await fixture(t), before = f.service.snapshot(f.id);
  await assert.rejects(f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'nonexistent' }), /маршрута/);
  assert.equal(f.service.snapshot(f.id).stateHash, before.stateHash);
  f.setScope({ authorId: 'other', seriesId: 's', bookId: 'b' }); assert.throws(() => f.service.snapshot(f.id), /другому/); assert.deepEqual(f.service.list(), []);
});
test('autonomous actor receives only its own packet, failure rolls back state, pause cancels in-flight model', async t => {
  let release, packet; const f = await fixture(t, async p => { packet = p; return new Promise(resolve => { release = resolve; }); });
  await f.cmd('configure', { mode: 'llm', autonomyActors: ['near'], autonomousHero: false, modelLimit: 1 }); const before = f.service.snapshot(f.id);
  const pending = f.cmd('step');
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(packet.actor_id, 'near'); assert.ok(JSON.stringify(packet).includes('NPC_PRIVATE_CANARY')); assert.ok(!JSON.stringify(packet).includes('HERO_PRIVATE_CANARY'));
  await f.service.pause(f.id); release({ actionType: 'idle', targetId: '', reason: 'Продолжает собственную работу.' }); await assert.rejects(pending, /отмен/);
  assert.equal(f.service.snapshot(f.id).stateHash, before.stateHash); assert.equal(f.service.snapshot(f.id).quota.used, 1);
});

test('configuration queued behind a model step preserves every spent call', async t => {
  let release, calls = 0;
  const f = await fixture(t, async () => { calls++; if (calls === 1) await new Promise(r => { release = r; }); return { actionType: 'idle', targetId: '', reason: 'Ждёт.' }; });
  await f.service.handle('POST', '/api/living-world/api-settings', new URL('http://localhost'), { apiKey: 'sk-local_test_canary_1234567890' });
  await f.cmd('configure', { mode: 'llm', provider: 'openai', apiBudgetUsd: 1, autonomyActors: ['near', 'far'], autonomousHero: false, modelLimit: 2 });
  const before = f.service.snapshot(f.id), step = f.cmd('step');
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(release);
  const configure = f.service.command(f.id, { operation: 'configure', args: { mode: 'manual', autonomyActors: [], autonomousHero: false, modelLimit: 0 }, expectedRevision: before.revision + 1, requestId: randomUUID() });
  release(); await step; await configure;
  assert.equal(calls, 2); const q = f.service.snapshot(f.id).quota; assert.equal(q.used, 2); assert.equal(q.limit, 2); assert.ok(q.apiReservedUsd > .08); assert.equal(q.apiLimitUsd, q.apiReservedUsd);
});

test('an unpublished checkpoint from interrupted publication cannot block the next commit', async t => {
  const f = await fixture(t), dir = join(f.root, 'data/living-world/branches', f.id), next = 'cp-00000001';
  mkdirSync(join(dir, next)); writeFileSync(join(dir, next, 'unpublished.txt'), 'Preserve for recovery');
  await f.cmd('step'); assert.equal(f.service.snapshot(f.id).elapsed, 1);
  const orphan = readdirSync(dir).find(n => n.startsWith('orphan-' + next)); assert.ok(orphan);
  assert.equal(readFileSync(join(dir, orphan, 'unpublished.txt'), 'utf8'), 'Preserve for recovery');
});

test('same-tick conversation can reserve a departing actor before movement is applied', async t => {
  const packets = [];
  const f = await fixture(t, async p => {
    packets.push(p);
    if (p.purpose === 'dialogue') return { content: p.actor_id === 'near' ? 'Ты идёшь к лагерю?' : 'Да, ищу ночлег.', shouldContinue: false };
    return p.actor_id === 'hero' ? { actionType: 'move_to', targetId: 'camp', reason: 'Найти ночлег.' } : { actionType: 'talk_to', targetId: 'hero', reason: 'Спросить о пути.' };
  });
  await f.cmd('queueIntent', { actorId: 'hero', actionType: 'route', targetId: 'edge' }); await f.cmd('step'); await f.cmd('step');
  await f.cmd('configure', { mode: 'llm', autonomyActors: ['hero', 'near'], autonomousHero: true, modelLimit: 8 });
  await f.cmd('step'); const s = f.service.snapshot(f.id);
  assert.equal(s.actors.find(a => a.id === 'hero').location, 'edge');
  assert.ok(!s.travels.hero, 'dialogue reserves hero before departure');
  assert.ok(packets.find(p => p.actor_id === 'near' && p.purpose === 'decision').perception.people.some(a => a.id === 'hero'));
  assert.ok(s.events.some(e => e.type === 'speech' && e.text.includes('Ты идёшь к лагерю?')));
});

test('completed interaction reaches own memory before next choice and one-shot action disappears', async t => {
  const definition = setup(); definition.objects = [{ id: 'wood', name: 'Хворост', locationId: 'edge', defaultState: 'ready', capacity: 1, interactions: [{ id: 'gather', name: 'Собрать охапку', availableWhenState: ['ready'], duration: 1, effects: [], repeatable: false }] }];
  const packets = [];
  const f = await fixture(t, async p => { packets.push(p); return p.allowedActions.some(a => a.interactionId === 'gather') ? { actionType: 'interact_object', targetId: 'wood', interactionId: 'gather', reason: 'Собрать одну охапку.' } : { actionType: 'idle', targetId: '', reason: 'Сбор завершён.' }; }, definition);
  await f.cmd('configure', { mode: 'llm', autonomyActors: ['near'], autonomousHero: false, modelLimit: 4 });
  for (let i = 0; i < 4 && packets.length < 2; i++) await f.cmd('step');
  assert.ok(packets.length >= 2);
  assert.ok(!packets[1].allowedActions.some(a => a.interactionId === 'gather'));
  assert.ok(packets[1].accessibleHistory.some(e => e.type === 'action' && e.text.includes('Собрать охапку')));
  assert.ok(packets[1].memory.some(m => m.text.includes('Собрать охапку')));
  assert.ok(!JSON.stringify(f.service.snapshot(f.id, { view: 'role', actorId: 'far' })).includes('Собрать охапку'));
});
