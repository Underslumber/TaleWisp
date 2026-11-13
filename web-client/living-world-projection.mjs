// Server-side role projection. Filtering precedes recall and is reused by live state and replay.
export function recallOwned(memories, ownerId, elapsed, context = '', count = 5) {
  const terms = new Set(context.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return memories.filter(m => m.ownerId === ownerId && m.acquiredAt <= elapsed).map(m => {
    const words = new Set(m.text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    const relevant = [...terms].filter(t => words.has(t)).length / Math.max(1, terms.size);
    return { ...m, score: 3 * relevant + 2 / (1 + .05 * Math.max(0, elapsed - m.acquiredAt)) + (m.importance ?? 5) / 5 + (m.intensity ?? 0) / 10 };
  }).sort((a, b) => b.score - a.score || b.acquiredAt - a.acquiredAt).slice(0, count);
}
export function projectWorld(state, view = 'author', actorId = state.definition.heroId) {
  if (!['author', 'role'].includes(view)) throw Object.assign(new Error('Неизвестный режим обзора.'), { status: 400 });
  const author = view === 'author', actor = state.actors.find(a => a.id === actorId);
  if (!actor) throw Object.assign(new Error('Персонаж не найден.'), { status: 404 });
  const own = (state.memories[actorId] ?? []).filter(m => m.ownerId === actorId && m.acquiredAt <= state.elapsed);
  const knownPlaces = new Set([state.definition.characters.find(a => a.id === actorId)?.location, actor.location,
    ...(state.visited[actorId] ?? []), ...own.flatMap(m => m.locationIds ?? [])]);
  const travel = state.travels[actorId]; if (travel) { knownPlaces.add(travel.from); knownPlaces.add(travel.to); }
  // A visible junction reveals the outgoing paths, not hidden actors or distant events.
  for (const edge of state.definition.edges) if (edge.from === actor.location) knownPlaces.add(edge.to);
  const here = state.definition.locations.find(l => l.id === actor.location);
  const visible = a => author || a.id === actorId || here?.encounters === true && a.location === actor.location && !state.travels[a.id] && !travel;
  const events = state.events.filter(e => author || e.audience.includes(actorId)).map(e => author ? e : ({
    id: e.id, tick: e.tick, type: e.type, location: e.location,
    text: e.ownerText?.[actorId] ?? e.text,
    ...(e.actorId ? { actorId: e.actorId } : {}),
  }));
  return { branchId: state.branchId, revision: state.revision, name: state.definition.name, engine: 'WorldX',
    elapsed: state.elapsed, tickMinutes: state.definition.tickMinutes, startLabel: state.definition.startLabel,
    view, actorId, heroId: state.definition.heroId, mode: state.mode, provider: state.provider || 'codex', autonomousHero: state.autonomousHero,
    locations: state.definition.locations.filter(l => author || knownPlaces.has(l.id)).map(l => ({ id: l.id, name: l.name, description: l.description, x: l.x, y: l.y, encounters: l.encounters, source: author ? l.source : undefined })),
    edges: state.definition.edges.filter(e => author || knownPlaces.has(e.from) && knownPlaces.has(e.to)).map(e => ({ id: e.id, from: e.from, to: e.to, ticks: e.ticks, open: state.edgeState[e.id] !== false })),
    actors: state.actors.filter(visible).map(a => ({ id: a.id, name: a.name, role: a.role, location: a.location, action: a.action, ...(author || a.id === actorId ? { goal: a.goal } : {}) })),
    travels: Object.fromEntries(Object.entries(state.travels).filter(([id]) => author || id === actorId)),
    events, memories: author ? structuredClone(state.memories) : { [actorId]: structuredClone(own) },
    recalled: recallOwned(own, actorId, state.elapsed, actor.goal),
    ...(author ? { autonomyActors: [...state.autonomyActors], scheduled: structuredClone(state.scheduled), modelDecisions: structuredClone(state.modelDecisions), stagingNotes: state.definition.stagingNotes, sources: state.definition.sources, flags: state.flags } : {}),
    rules: author ? state.definition.rules : [],
  };
}
export function characterPacket(state, actorId, purpose, extra = {}) {
  const actor = state.actors.find(a => a.id === actorId), profile = state.definition.characters.find(a => a.id === actorId);
  if (!actor || !profile) throw new Error('Неизвестный участник.');
  const view = projectWorld(state, 'role', actorId);
  return { session_id: state.branchId, source_fingerprint: state.importHash, based_on_revision: state.revision,
    actor_id: actorId, role: profile.role, packet_binding: { session_id: state.branchId, actor_id: actorId, source_fingerprint: state.importHash, based_on_revision: state.revision },
    purpose, character: { name: actor.name, goal: actor.goal, speakingStyle: profile.speakingStyle },
    perception: { location: actor.location, places: view.locations, paths: view.edges.filter(e => e.from === actor.location), people: view.actors.filter(a => a.id !== actorId) },
    memory: view.recalled, accessibleHistory: view.events.slice(-30), ...extra,
    instruction: 'Используй только собственные доступные знания. Сообщение доказывает, что это сказали, а не его истинность. Не придумывай биографию, прошлое, навыки, предметы и правила. Сохраняй собственную цель. Действие выбирай только из allowedActions; реплика не выполняет перемещение. Выводы и внутренние мысли не становятся известны собеседнику. Верни только запрошенный JSON. Не используй инструменты.' };
}
