// One permission-restricted process per branch. No canon path or network/model client is supplied.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, cpSync, renameSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { projectWorld, characterPacket } from './living-world-projection.mjs';

console.log = console.info = (...args) => console.error(...args);
const ROOT = resolve(process.argv[2]), VENDOR = fileURLToPath(new URL('../vendor/worldx/server/', import.meta.url));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, value) => writeFileSync(file, JSON.stringify(value), { encoding: 'utf8', flush: true });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safePath = path => { const p = resolve(path); if (!p.startsWith(ROOT + sep)) throw new Error('Запись за пределами ветки запрещена.'); return p; };
const currentFile = join(ROOT, 'current.json');
const { WorldManager } = await import(new URL('../vendor/worldx/server/dist/core/world-manager.js', import.meta.url));
const { CharacterManager } = await import(new URL('../vendor/worldx/server/dist/core/character-manager.js', import.meta.url));
const { SimulationEngine } = await import(new URL('../vendor/worldx/server/dist/simulation/simulation-engine.js', import.meta.url));
const { PromptBuilder } = await import(new URL('../vendor/worldx/server/dist/llm/prompt-builder.js', import.meta.url));
const { initDatabase, closeDb, getDb } = await import(new URL('../vendor/worldx/server/dist/store/db.js', import.meta.url));
let cancelled = false, cancelVersion = 0, queue = Promise.resolve(); const models = new Map();
function model(packet) {
  const id = randomUUID(); send({ type: 'model', id, packet });
  return new Promise((resolveModel, reject) => models.set(id, { resolve: resolveModel, reject }));
}
function worldFiles(work, definition) {
  mkdirSync(join(work, 'config', 'characters'), { recursive: true });
  const scene = { sceneType: 'open', startTime: '00:00', tickDurationMinutes: definition.tickMinutes, maxTicks: null, displayFormat: 'modern', description: definition.startLabel, multiDay: { enabled: true, endOfDayText: '', newDayText: '', nextDayStartTime: '00:00' } };
  write(join(work, 'world.json'), { talewispImported: true, worldName: definition.name, worldDescription: 'Отдельная неканоническая ветка TaleWisp.', worldSocialContext: '', contentLanguage: 'en', scene,
    locations: definition.locations.map(l => ({ id: l.id, name: l.name, description: l.description || '', adjacentLocations: definition.edges.filter(e => e.from === l.id).map(e => e.to), objects: definition.objects.filter(o => o.locationId === l.id) })), mainAreaPoints: [] });
  for (const c of definition.characters) write(join(work, 'config', 'characters', c.id + '.json'), { id: c.id, name: c.name, role: c.role, startPosition: c.location, coreMotivation: c.goal, speakingStyle: c.speakingStyle || '', preferredLocations: [c.location], preferredActivities: [], writeDiary: false, initialMemories: [] });
}
function initial(definition, branchId, importHash) {
  const memories = Object.fromEntries(definition.characters.map(a => [a.id, a.knowledge.map((k, i) => ({ id: `entry:${a.id}:${i}`, ownerId: a.id, kind: k.kind || 'entry_memory', text: k.text, source: k.source, acquiredAt: 0, importance: 5, intensity: 0 }))]));
  return { version: 1, branchId, importHash, definition, revision: 0, elapsed: 0, events: [], memories,
    actors: definition.characters.map(c => ({ id: c.id, name: c.name, role: c.role, location: c.location, goal: c.goal, action: null })),
    travels: {}, queued: {}, edgeState: Object.fromEntries(definition.edges.map(e => [e.id, e.open !== false])),
    visited: Object.fromEntries(definition.characters.map(a => [a.id, [a.location]])), scheduled: definition.scheduled || [], flags: {},
    encounters: [], modelDecisions: [], requests: {}, mode: 'manual', autonomousHero: false, autonomyActors: [], rng: 123456789 };
}
function route(state, from, to) {
  const q = [{ at: from, edges: [], cost: 0 }], best = new Map();
  while (q.length) { q.sort((a, b) => a.cost - b.cost); const n = q.shift(); if (n.at === to) return n.edges;
    if ((best.get(n.at) ?? Infinity) <= n.cost) continue; best.set(n.at, n.cost);
    for (const e of state.definition.edges.filter(e => e.from === n.at && state.edgeState[e.id] !== false)) q.push({ at: e.to, edges: [...n.edges, e.id], cost: n.cost + e.ticks });
  }
  throw new Error('Нет доступного маршрута.');
}
async function execute(command) {
  const current = existsSync(currentFile) ? read(currentFile) : null;
  const old = current ? read(join(ROOT, current.checkpoint, 'state.json')) : null;
  const requestHash = digest({ operation: command.operation, args: command.args });
  if (old?.requests[command.requestId]) { if (old.requests[command.requestId].hash !== requestHash) throw new Error('Повторный requestId имеет другое содержание.'); return { revision: current.revision, checkpoint: current.checkpoint, duplicate: true }; }
  if (current && command.expectedRevision !== current.revision) throw Object.assign(new Error('Ветка изменилась. Обновите состояние.'), { status: 409 });
  if (!current && command.operation !== 'initialize') throw new Error('Ветка не инициализирована.');
  const work = safePath(join(ROOT, 'work-' + randomUUID())); mkdirSync(work);
  let state = old ? structuredClone(old) : initial(command.args.definition, command.branchId, command.args.importHash);
  const privateTickEvents = [];
  function liveState(cm) { state.actors = cm.getAllStates().map(s => { const p = state.definition.characters.find(c => c.id === s.characterId); return { id: p.id, name: p.name, role: p.role, goal: p.goal, location: s.location, action: s.currentAction }; }); return state; }
  function emit(type, text, location, audience, details = {}) {
    const event = { id: randomUUID(), tick: state.elapsed + (command.operation === 'step' ? 1 : 0), type, text, location, audience: [...new Set(audience)], ...details };
    state.events.push(event); privateTickEvents.push(event);
    for (const ownerId of event.audience) if (state.memories[ownerId]) state.memories[ownerId].push({ id: 'memory:' + event.id + ':' + ownerId, ownerId, eventId: event.id,
      kind: type === 'speech' ? 'hearsay' : 'observation', text: event.ownerText?.[ownerId] ?? text, acquiredAt: event.tick,
      importance: 5, intensity: 0, locationIds: location ? [location] : [] });
    return event;
  }
  try {
    if (old) cpSync(safePath(join(ROOT, current.checkpoint)), work, { recursive: true });
    worldFiles(work, state.definition); initDatabase(join(work, 'world.sqlite'));
    const wm = new WorldManager(); wm.initialize(work); const cm = new CharacterManager(wm); cm.initialize();
    const builder = new PromptBuilder(); builder.initialize(); liveState(cm);
    Math.random = () => { state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0; return state.rng / 4294967296; };
    const present = location => state.definition.locations.find(l => l.id === location)?.encounters ? cm.getAllStates().filter(a => a.location === location && !state.travels[a.characterId]).map(a => a.characterId) : [];
    function recordEncounters() {
      const pairs = [];
      for (const l of state.definition.locations.filter(l => l.encounters)) { const ids = present(l.id); for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const pair = [ids[i], ids[j]].sort().join(':'); pairs.push(pair);
        if (!state.encounters.includes(pair)) emit('encounter', `${cm.getProfile(ids[i]).name} встречает ${cm.getProfile(ids[j]).name}.`, l.id, [ids[i], ids[j]]);
      } }
      state.encounters = pairs;
    }
    function allowedActions(actorId) {
      const a = cm.getState(actorId);
      return [{ actionType: 'idle', targetId: '' }, ...wm.getAdjacentLocations(a.location).filter(to => state.definition.edges.some(e => e.from === a.location && e.to === to && state.edgeState[e.id] !== false)).map(to => ({ actionType: 'move_to', targetId: to })),
        ...present(a.location).filter(id => id !== actorId).map(id => ({ actionType: 'talk_to', targetId: id })),
        ...wm.getLocationObjects(a.location).flatMap(o => wm.getAvailableInteractions(o.id).filter(i => i.repeatable !== false || !state.completedInteractions?.includes(`${actorId}:${o.id}:${i.id}`)).map(i => ({ actionType: 'interact_object', targetId: o.id, interactionId: i.id, name: i.name, description: i.description || '', duration: i.duration })))];
    }
    async function ask(actorId, purpose, extra) {
      liveState(cm); const packet = characterPacket({ ...state, elapsed: state.elapsed + (command.operation === 'step' ? 1 : 0) }, actorId, purpose, extra), result = await model(packet);
      if (cancelled) throw new Error('Вычисление отменено; последний checkpoint сохранён.');
      state.modelDecisions.push({ id: randomUUID(), tick: state.elapsed + 1, actorId, purpose, packetHash: digest(packet), response: result });
      return result;
    }
    function depart(actorId, to, reason) {
      if (state.travels[actorId]) throw new Error('Персонаж уже в пути.');
      const a = cm.getState(actorId), edges = route(state, a.location, to); if (!edges.length) return;
      const edge = state.definition.edges.find(e => e.id === edges[0]);
      state.travels[actorId] = { actorId, from: a.location, to: edge.to, destination: to, edgeIds: edges, segment: 0, departedAt: state.elapsed, arrivesAt: state.elapsed + edge.ticks, status: 'traveling' };
      const witnesses = present(a.location); cm.updateState(actorId, { location: 'transit:' + actorId, currentAction: 'talewisp_travel', actionEndTick: Number.MAX_SAFE_INTEGER });
      emit('departure', `${cm.getProfile(actorId).name} отправляется в путь.`, a.location, [...witnesses, actorId], { actorId, ownerText: { [actorId]: `Я направляюсь к ${wm.getLocation(to)?.name}.` }, privateReason: reason });
    }
    let tickError;
    const adapters = { imported: true, decisionMaker: { async makeDecision(actorId) {
      try {
        const options = allowedActions(actorId), profile = state.definition.characters.find(c => c.id === actorId);
        let decision = state.queued[actorId]?.shift();
        if (!decision && state.mode === 'plans' && profile.plan?.length) { const index = state.planIndex?.[actorId] ?? 0; decision = profile.plan[index % profile.plan.length]; (state.planIndex ??= {})[actorId] = index + 1; }
        if (!decision && state.mode === 'llm' && state.autonomyActors.includes(actorId) && (actorId !== state.definition.heroId || state.autonomousHero)) {
          const proposed = await ask(actorId, 'decision', { allowedActions: options, responseSchema: { actionType: 'one allowed actionType', targetId: 'exact allowed targetId', interactionId: 'only if applicable', reason: 'own grounded reason in Russian' } });
          decision = { actionType: proposed.actionType, targetId: proposed.targetId, ...(proposed.interactionId ? { interactionId: proposed.interactionId } : {}), reason: proposed.reason };
        }
        decision ??= { actionType: 'idle', targetId: '', reason: 'Ожидает следующего самостоятельного решения.' };
        if (!options.some(o => o.actionType === decision.actionType && o.targetId === decision.targetId && (o.interactionId ?? null) === (decision.interactionId ?? null))) throw new Error('Намерение отсутствует в доступных возможностях персонажа.');
        return decision;
      } catch (error) { tickError = error; throw error; }
    } }, move: (actorId, decision) => depart(actorId, decision.destination || decision.targetId, decision.reason),
    completed: e => {
      if (e.type !== 'action_end' || !e.actorId || !e.data?.targetId) return;
      (state.completedInteractions ??= []).push(`${e.actorId}:${e.data.targetId}:${e.data.action}`);
      emit('action', `${cm.getProfile(e.actorId).name}: завершено «${e.data.actionName || e.data.action}».`, e.location, [...present(e.location), e.actorId], { actorId: e.actorId });
    }, dialogueGenerator: {
      async generateNextTurn({ session }) {
        const speaker = session.nextSpeaker;
        if (state.mode !== 'llm' || !state.autonomyActors.includes(speaker) || speaker === state.definition.heroId && !state.autonomousHero) return null;
        try {
          const r = await ask(speaker, 'dialogue', { interlocutors: session.participants.filter(id => id !== speaker).map(id => ({ id, name: cm.getProfile(id).name })),
            transcript: session.transcript.map(t => ({ speaker: t.speaker, content: t.content })),
            responseSchema: { content: 'own spoken words only in Russian', shouldContinue: 'boolean' } });
          if (typeof r.content !== 'string' || !r.content.trim() || r.content.length > 4000) throw new Error('Неверная реплика.');
          return { turn: { speaker, content: r.content }, shouldContinue: r.shouldContinue === true, suggestedNextSpeaker: session.participants.find(id => id !== speaker), tags: [] };
        } catch (error) { tickError = error; throw error; }
      },
      async finalizeDialogueSession({ session }) { return { participants: session.participants, location: session.location, turns: session.transcript.map(t => ({ speaker: t.speaker, content: t.content })), memoriesGenerated: {}, tags: [] }; },
    } };
    const blockedLLM = { call() { throw new Error('Прямой модельный вызов WorldX отключён.'); } };
    const engine = new SimulationEngine(wm, cm, blockedLLM, builder, adapters);
    const args = command.args || {};
    switch (command.operation) {
      case 'initialize': break;
      case 'queueIntent': {
        const actorId = args.actorId, a = cm.getState(actorId);
        if (args.actionType === 'route') { const path = route(state, a.location, args.targetId); if (!path.length) throw new Error('Персонаж уже находится здесь.'); const first = state.definition.edges.find(e => e.id === path[0]); (state.queued[actorId] ??= []).push({ actionType: 'move_to', targetId: first.to, destination: args.targetId, reason: args.reason || 'Маршрут выбран автором.' }); }
        else if (args.actionType === 'speech') {
          if (!present(a.location).includes(args.targetId) || state.travels[actorId] || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4000) throw new Error('Сообщение требует присутствующего собеседника и текста.');
          emit('speech', `${cm.getProfile(actorId).name}: ${args.text}`, a.location, [actorId, args.targetId], { actorId });
        } else if (args.actionType === 'resumeTravel') {
          const trip = state.travels[actorId]; if (!trip || trip.status !== 'blocked' || state.edgeState[trip.edgeIds[trip.segment]] === false) throw new Error('Переход пока закрыт.');
          trip.status = 'traveling'; trip.baseProgress = trip.progress; trip.departedAt = state.elapsed; trip.arrivesAt = state.elapsed + trip.remaining;
        } else throw new Error('Неизвестное намерение.');
        break;
      }
      case 'configure': {
        if (!['manual', 'plans', 'llm'].includes(args.mode) || !Array.isArray(args.autonomyActors) || args.autonomyActors.some(id => !state.memories[id])) throw new Error('Неверное управление автономией.');
        state.mode = args.mode; state.provider = args.provider || 'codex'; state.autonomyActors = [...new Set(args.autonomyActors)]; state.autonomousHero = args.autonomousHero === true;
        break;
      }
      case 'intervene': case 'scheduleEvent': {
        if (!state.definition.locations.some(l => l.id === args.location) || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4000 || args.edgeId && !state.definition.edges.some(e => e.id === args.edgeId)) throw new Error('Событию нужны известное место и текст.');
        const event = { id: randomUUID(), at: args.at ?? state.elapsed, location: args.location, text: args.text, edgeId: args.edgeId, open: args.open };
        if (command.operation === 'scheduleEvent') { if (!Number.isInteger(event.at) || event.at <= state.elapsed) throw new Error('Время события должно быть в будущем.'); state.scheduled.push(event); }
        else { if (event.edgeId) state.edgeState[event.edgeId] = event.open === true; emit('environment', event.text, event.location, present(event.location)); }
        break;
      }
      case 'step': {
        if (cancelled) throw new Error('Вычисление отменено.');
        const next = state.elapsed + 1;
        for (const event of state.scheduled.filter(e => e.at <= next && !e.applied)) { event.applied = true; if (event.edgeId) state.edgeState[event.edgeId] = event.open === true; emit('environment', event.text, event.location, present(event.location)); }
        for (const [actorId, trip] of Object.entries(state.travels)) {
          if (trip.status === 'blocked') continue;
          if (state.edgeState[trip.edgeIds[trip.segment]] === false) { trip.progress = (trip.baseProgress || 0) + (1 - (trip.baseProgress || 0)) * Math.max(0, Math.min(1, (state.elapsed - trip.departedAt) / Math.max(1, trip.arrivesAt - trip.departedAt))); trip.remaining = Math.max(1, trip.arrivesAt - state.elapsed); trip.status = 'blocked'; emit('travel_blocked', 'Продолжение перехода недоступно; требуется решение о пути.', null, [actorId], { actorId }); continue; }
          if (next < trip.arrivesAt) continue;
          const arrived = trip.to; (state.visited[actorId] ??= []).push(arrived);
          const segment = trip.segment + 1;
          if (segment < trip.edgeIds.length) { const edge = state.definition.edges.find(e => e.id === trip.edgeIds[segment]); trip.from = arrived; trip.to = edge.to; trip.segment = segment; trip.departedAt = next; trip.arrivesAt = next + edge.ticks; delete trip.baseProgress; delete trip.progress; delete trip.remaining; }
          else { delete state.travels[actorId]; cm.updateState(actorId, { location: arrived, currentAction: null, currentActionTarget: null }); emit('arrival', `${cm.getProfile(actorId).name} приходит в ${wm.getLocation(arrived).name}.`, arrived, [...present(arrived), actorId], { actorId }); }
        }
        // Register actual co-presence before decisions can send an arrival away again.
        recordEncounters();
        const raw = await engine.simulateTick(); if (tickError) throw tickError;
        if (cancelled) throw new Error('Вычисление отменено; неполный такт не опубликован.');
        for (const e of raw) {
          if (e.type === 'dialogue' && e.data?.phase === 'turn') {
            for (const t of e.data.turns) emit('speech', `${cm.getProfile(t.speaker).name}: ${t.content}`, e.location, e.data.participants, { actorId: t.speaker });
          } else if (e.type === 'action_complete' || e.type === 'object_state_change') emit('action', `${cm.getProfile(e.actorId)?.name || 'Мир'}: ${e.data?.interactionName || e.type}`, e.location, present(e.location), { actorId: e.actorId });
        }
        recordEncounters(); state.elapsed = next; break;
      }
      case 'checkpoint': break;
      default: throw new Error('Неизвестная операция.');
    }
    // Adapter knowledge is the authority; upstream generic memories are never exported as character knowledge.
    liveState(cm); state.time = wm.getCurrentTime();
    state.revision = (old?.revision ?? -1) + 1;
    state.requests[command.requestId] = { hash: requestHash, revision: state.revision };
    const native = { characters: getDb().prepare('SELECT * FROM character_states').all(), globals: getDb().prepare('SELECT * FROM world_global_state').all() };
    state.nativeHash = digest(native);
    closeDb(); write(join(work, 'state.json'), state);
    const checkpoint = 'cp-' + String(state.revision).padStart(8, '0');
    const destination = safePath(join(ROOT, checkpoint));
    // Only current.json publishes a checkpoint. Preserve an orphan from a crash
    // under a non-checkpoint name rather than overwriting or adopting its state.
    if (existsSync(destination)) renameSync(destination, safePath(join(ROOT, 'orphan-' + checkpoint + '-' + randomUUID())));
    renameSync(work, destination);
    const pointer = { revision: state.revision, checkpoint, hash: digest(state), nativeHash: state.nativeHash };
    write(join(ROOT, 'current.next'), pointer); renameSync(join(ROOT, 'current.next'), currentFile);
    return { ...pointer, eventsAdded: privateTickEvents.length };
  } finally {
    try { closeDb(); } catch {}
    if (existsSync(work)) rmSync(safePath(work), { recursive: true, force: true });
  }
}
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  let input; try { input = JSON.parse(line); } catch { return; }
  if (input.type === 'modelResult') { const task = models.get(input.id); if (task) { models.delete(input.id); input.error ? task.reject(new Error(input.error)) : task.resolve(input.result); } return; }
  if (input.operation === 'pause') { cancelled = true; cancelVersion++; for (const p of models.values()) p.reject(new Error('Вызов отменён.')); models.clear(); send({ type: 'cancelModels' }); send({ id: input.id, result: { paused: true } }); return; }
  if (input.operation === 'shutdown') { cancelled = true; cancelVersion++; for (const p of models.values()) p.reject(new Error('Вычисление отменено завершением процесса.')); models.clear(); send({ type: 'cancelModels' }); queue.finally(() => process.exit(0)); return; }
  const epoch = cancelVersion;
  queue = queue.then(async () => { cancelled = false; try { if (epoch !== cancelVersion) throw new Error('Команда отменена паузой.'); const result = await execute(input); send({ id: input.id, result }); } catch (e) { send({ id: input.id, error: e.message, status: e.status || 409 }); } });
});
rl.on('close', () => process.exit(0));
send({ type: 'ready', engine: 'WorldX' });
