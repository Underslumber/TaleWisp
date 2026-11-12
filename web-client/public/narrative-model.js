// Narrative framework domain shared by the server and the browser: no DOM, no network, no storage.
// A plan is author data. Approval creates an immutable snapshot; execution progress is keyed by
// (planId, stageId, contentRevision) and never by snapshot, so reorder and re-approval keep closures.
import { splitsSurrogate } from './text-review-model.js';

export const NARRATIVE_LIMITS = Object.freeze({ bookStages: 1000, chapterStages: 200, chapters: 2000, anchorsPerDecision: 20, lines: 50, evidencePerStage: 200, basisChapters: 20, proposalQuotes: 20 });
export const FIELD_LIMITS = Object.freeze({ title: 300, text: 4000, note: 2000, participants: 30, participant: 120, quote: 4000 });
export const CONTEXT_CHARS = 40;
export const ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/;
// The deterministic set of fields that defines the meaning of a stage. Changing any of them creates a new
// contentRevision; order, line, participants, causality notes and archiving do not.
export const STAGE_CONTENT_FIELDS = Object.freeze(['title', 'expectedChange', 'closureCriterion', 'prerequisites', 'disclosureConstraints', 'parentStageIds']);

export class NarrativeError extends Error {
  constructor(message, code = 'narrative_invalid', status = 400, details = undefined) { super(message); this.code = code; this.status = status; this.expose = true; if (details !== undefined) this.details = details; }
}
const invalid = (message, details) => new NarrativeError(message, 'narrative_invalid', 400, details);

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

const text = (value, name, max, { required = false } = {}) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw invalid(`Поле «${name}» должно быть текстом.`);
  if (value.length > max) throw invalid(`Поле «${name}» длиннее ${max} знаков.`);
  if (required && !value.trim()) throw invalid(`Заполните поле «${name}».`);
  return value;
};
const idList = (value, name, max) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))) throw invalid(`Список «${name}» содержит неверные ссылки.`);
  if (new Set(value).size !== value.length) throw invalid(`Список «${name}» содержит повторы.`);
  return [...value];
};
export const validId = value => typeof value === 'string' && ID_PATTERN.test(value);

function normalizeStage(input, kind, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`Этап ${index + 1} передан в неверном формате.`);
  if (!validId(input.id)) throw invalid(`У этапа ${index + 1} неверный идентификатор.`);
  const participants = input.participants ?? [];
  if (!Array.isArray(participants) || participants.length > FIELD_LIMITS.participants || participants.some(p => typeof p !== 'string' || !p.trim() || p.length > FIELD_LIMITS.participant)) throw invalid(`Участники этапа «${input.title ?? index + 1}» указаны неверно.`);
  const stage = {
    id: input.id,
    lineId: kind === 'book' ? (input.lineId ?? null) : null,
    title: text(input.title, 'Название этапа', FIELD_LIMITS.title, { required: true }),
    expectedChange: text(input.expectedChange, 'Ожидаемое изменение', FIELD_LIMITS.text, { required: true }),
    closureCriterion: text(input.closureCriterion, 'Критерий закрытия', FIELD_LIMITS.text),
    participants: participants.map(p => p.trim()),
    prerequisites: idList(input.prerequisites, 'Предпосылки', 200),
    disclosureConstraints: text(input.disclosureConstraints, 'Запреты раннего раскрытия', FIELD_LIMITS.text),
    causality: text(input.causality, 'Причина и последствие', FIELD_LIMITS.note),
    parentStageIds: kind === 'chapter' ? idList(input.parentStageIds, 'Родительские этапы', 50) : [],
    archived: input.archived === true,
  };
  if (Number.isSafeInteger(input.contentRevision) && input.contentRevision > 0) stage.contentRevision = input.contentRevision;
  if (input.preserveRevision === true) stage.preserveRevision = true;
  if (stage.prerequisites.includes(stage.id)) throw invalid(`Этап «${stage.title}» не может быть предпосылкой самого себя.`);
  return stage;
}

// Validates a complete author draft. Throws NarrativeError with a Russian message; never truncates.
export function normalizeDraft(kind, input) {
  if (kind !== 'book' && kind !== 'chapter') throw invalid('Неизвестный вид плана.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Черновик плана передан в неверном формате.');
  const stagesInput = input.stages ?? [];
  if (!Array.isArray(stagesInput)) throw invalid('Этапы плана переданы в неверном формате.');
  const limit = kind === 'book' ? NARRATIVE_LIMITS.bookStages : NARRATIVE_LIMITS.chapterStages;
  if (stagesInput.length > limit) throw new NarrativeError(`В плане ${kind === 'book' ? 'книги' : 'главы'} не больше ${limit} этапов.`, 'narrative_limit', 413);
  const draft = kind === 'book'
    ? { kind, title: text(input.title, 'Название линии книги', FIELD_LIMITS.title), intent: text(input.intent, 'Замысел', FIELD_LIMITS.text), outcome: text(input.outcome, 'Желаемый исход', FIELD_LIMITS.text), constraints: text(input.constraints, 'Ограничения', FIELD_LIMITS.text), lines: [], stages: [] }
    : { kind, chapterId: input.chapterId, title: text(input.title, 'Название сюжетки', FIELD_LIMITS.title), goal: text(input.goal, 'Цель главы', FIELD_LIMITS.text), outcome: text(input.outcome, 'Исход главы', FIELD_LIMITS.text), knowledgeBounds: text(input.knowledgeBounds, 'Границы знания и раскрытия', FIELD_LIMITS.text), stages: [] };
  if (kind === 'chapter' && !validId(input.chapterId)) throw invalid('Сюжетка должна относиться к главе каркаса.');
  if (kind === 'book') {
    const lines = input.lines ?? [];
    if (!Array.isArray(lines) || lines.length > NARRATIVE_LIMITS.lines) throw invalid(`Линий не больше ${NARRATIVE_LIMITS.lines}.`);
    const seen = new Set();
    for (const [i, line] of lines.entries()) {
      if (!line || !validId(line.id) || seen.has(line.id)) throw invalid(`Линия ${i + 1} имеет неверный или повторный идентификатор.`);
      seen.add(line.id);
      draft.lines.push({ id: line.id, title: text(line.title, 'Название линии', FIELD_LIMITS.title, { required: true }), primary: line.primary === true });
    }
    if (draft.lines.filter(line => line.primary).length > 1) throw invalid('Основной может быть только одна линия.');
  }
  const ids = new Set();
  draft.stages = stagesInput.map((stage, i) => {
    const value = normalizeStage(stage, kind, i);
    if (ids.has(value.id)) throw invalid(`Этап «${value.title}» повторяется.`);
    ids.add(value.id); return value;
  });
  const byId = new Map(draft.stages.map(stage => [stage.id, stage]));
  for (const stage of draft.stages) {
    if (kind === 'book' && (!stage.lineId || !draft.lines.some(line => line.id === stage.lineId))) throw invalid(`Этап «${stage.title}» не относится ни к одной линии.`);
    for (const id of stage.prerequisites) {
      const target = byId.get(id);
      if (!target) throw invalid(`Предпосылка этапа «${stage.title}» ссылается на неизвестный этап.`);
      if (!stage.archived && target.archived) throw invalid(`Предпосылка этапа «${stage.title}» находится в архиве.`);
    }
  }
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 2) return; if (state.get(id) === 1) throw invalid('Предпосылки этапов образуют цикл.');
    state.set(id, 1); for (const next of byId.get(id).prerequisites) visit(next); state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id);
  return draft;
}

export const stageFingerprint = stage => canonicalJson({ title: stage.title, expectedChange: stage.expectedChange, closureCriterion: stage.closureCriterion, prerequisites: [...(stage.prerequisites ?? [])].sort(), disclosureConstraints: stage.disclosureConstraints, parentStageIds: [...(stage.parentStageIds ?? [])].sort() });
const fingerprintWithoutTitle = stage => stageFingerprint({ ...stage, title: '' });

// Assigns contentRevision deterministically. `index` maps stageId -> { revision, fingerprint, titleless } of
// the newest known revision (drafts and snapshots). Returns the stages and the next index; never mutates input.
export function assignRevisions(stages, index = {}) {
  const next = { ...index }, out = [];
  for (const stage of stages) {
    const { preserveRevision, contentRevision: _client, ...clean } = stage;
    const fingerprint = stageFingerprint(clean), titleless = fingerprintWithoutTitle(clean), known = index[stage.id];
    let revision;
    if (!known) revision = 1;
    else if (known.fingerprint === fingerprint) revision = known.revision;
    else if (preserveRevision === true && known.titleless === titleless) revision = known.revision; // explicit author choice: rename keeps closure
    else revision = known.revision + 1;
    next[stage.id] = { revision, fingerprint, titleless };
    out.push({ ...clean, contentRevision: revision });
  }
  return { stages: out, index: next };
}

export const activeStages = payload => (payload?.stages ?? []).filter(stage => !stage.archived);
export const findStage = (payload, stageId) => (payload?.stages ?? []).find(stage => stage.id === stageId) ?? null;

// Pins parent pairs from the active book snapshot. Throws when a parent is unknown or archived.
export function pinParents(chapterDraft, bookPayload) {
  const pins = [];
  for (const stage of chapterDraft.stages) {
    if (stage.archived) continue;
    for (const parentId of stage.parentStageIds) {
      const parent = findStage(bookPayload, parentId);
      if (!parent) throw new NarrativeError(`Родительский этап этапа «${stage.title}» отсутствует в согласованной версии каркаса книги.`, 'parent_missing', 409);
      if (parent.archived) throw new NarrativeError(`Родительский этап этапа «${stage.title}» находится в архиве каркаса книги.`, 'parent_archived', 409);
      if (!pins.some(pin => pin.stageId === parent.id)) pins.push({ stageId: parent.id, contentRevision: parent.contentRevision });
    }
  }
  return pins;
}

// A chapter snapshot is compatible with the active book snapshot only if every pinned parent pair still exists
// and is not archived. Reordering book stages never changes pairs, so it never breaks compatibility.
export function chapterCompatibility(chapterSnapshot, bookSnapshot) {
  if (!chapterSnapshot) return { compatible: false, reason: 'not_approved', problems: [] };
  if (!bookSnapshot) return { compatible: false, reason: 'book_not_approved', problems: [] };
  const problems = [];
  for (const pin of chapterSnapshot.payload?.parentPins ?? []) {
    const stage = findStage(bookSnapshot.payload, pin.stageId);
    if (!stage) problems.push({ ...pin, reason: 'missing' });
    else if (stage.archived) problems.push({ ...pin, reason: 'archived' });
    else if (stage.contentRevision !== pin.contentRevision) problems.push({ ...pin, reason: 'revision_changed', currentRevision: stage.contentRevision });
  }
  return { compatible: !problems.length, reason: problems.length ? 'link_outdated' : 'ok', problems };
}

const HEADER_FIELDS = { book: ['title', 'intent', 'outcome', 'constraints'], chapter: ['title', 'goal', 'outcome', 'knowledgeBounds'] };
export const FIELD_LABELS = { title: 'Название', intent: 'Замысел', outcome: 'Исход', constraints: 'Ограничения', goal: 'Цель главы', knowledgeBounds: 'Границы знания', expectedChange: 'Ожидаемое изменение', closureCriterion: 'Критерий закрытия', prerequisites: 'Предпосылки', disclosureConstraints: 'Запреты раскрытия', parentStageIds: 'Родительские этапы', participants: 'Участники', causality: 'Причина и последствие', lineId: 'Линия', archived: 'Архив' };

// Field-level comparison of two plan payloads (snapshot or draft) for "Сравнить версии".
export function diffPlans(before, after) {
  const kind = after?.kind ?? before?.kind ?? 'book';
  const header = HEADER_FIELDS[kind].filter(field => (before?.[field] ?? '') !== (after?.[field] ?? '')).map(field => ({ field, before: before?.[field] ?? '', after: after?.[field] ?? '' }));
  const oldStages = new Map((before?.stages ?? []).map((stage, i) => [stage.id, { stage, i }]));
  const newStages = new Map((after?.stages ?? []).map((stage, i) => [stage.id, { stage, i }]));
  const stages = [];
  const oldOrder = (before?.stages ?? []).map(stage => stage.id).filter(id => newStages.has(id));
  const newOrder = (after?.stages ?? []).map(stage => stage.id).filter(id => oldStages.has(id));
  for (const [id, { stage }] of newStages) {
    const old = oldStages.get(id)?.stage;
    if (!old) { stages.push({ id, title: stage.title, change: 'added', fields: [] }); continue; }
    const fields = [...STAGE_CONTENT_FIELDS, 'participants', 'causality', 'lineId'].filter(field => canonicalJson(old[field] ?? null) !== canonicalJson(stage[field] ?? null));
    const contentChanged = stageFingerprint(old) !== stageFingerprint(stage);
    const moved = oldOrder.indexOf(id) !== newOrder.indexOf(id);
    const archive = old.archived !== stage.archived ? (stage.archived ? 'archived' : 'restored') : null;
    if (fields.length || moved || archive) stages.push({ id, title: stage.title, change: archive ?? (fields.length ? 'changed' : 'moved'), fields, moved, contentChanged, beforeRevision: old.contentRevision ?? null, afterRevision: stage.contentRevision ?? null });
  }
  for (const [id, { stage }] of oldStages) if (!newStages.has(id)) stages.push({ id, title: stage.title, change: 'removed', fields: [] });
  const lines = kind === 'book' ? canonicalJson(before?.lines ?? []) !== canonicalJson(after?.lines ?? []) : false;
  return { header, stages, lines, empty: !header.length && !stages.length && !lines };
}

// ---------- Anchors ----------
export function anchorContext(source, start, end, size = CONTEXT_CHARS) {
  let a = Math.max(0, start - size), b = Math.min(source.length, end + size);
  if (splitsSurrogate(source, a)) a += 1;
  if (splitsSurrogate(source, b)) b -= 1;
  return { prefix: source.slice(a, start), suffix: source.slice(end, b) };
}
export function occurrences(source, needle, limit = 50) {
  const found = []; if (!needle) return found;
  for (let at = source.indexOf(needle); at >= 0 && found.length < limit; at = source.indexOf(needle, at + 1)) found.push(at);
  return found;
}
export function validRange(source, start, end) {
  return typeof source === 'string' && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= source.length && !splitsSurrogate(source, start) && !splitsSurrogate(source, end);
}
// Locates a saved anchor in the current saved text. Locations:
//   exact          — chapter hash unchanged (the very text the decision was made on)
//   intact         — chapter edited elsewhere; quote and its context still at the same offsets, uniquely
//   shifted        — quote with its context found exactly once at another offset (deterministic move)
//   ambiguous      — quote with context repeats: automatic choice is forbidden
//   window_changed — quote exists, but its context window changed: needs the author's check
//   lost           — quote not found
export function locateAnchor(source, sourceHash, anchor) {
  if (typeof source !== 'string') return { location: 'lost' };
  if (sourceHash && sourceHash === anchor.textHash && source.slice(anchor.start, anchor.end) === anchor.quote) return { location: 'exact', start: anchor.start, end: anchor.end };
  const window = (anchor.prefix ?? '') + anchor.quote + (anchor.suffix ?? '');
  const matches = occurrences(source, window, 3).map(at => at + (anchor.prefix ?? '').length);
  if (matches.length > 1) return { location: 'ambiguous', candidates: matches.length };
  if (matches.length === 1) return { location: matches[0] === anchor.start ? 'intact' : 'shifted', start: matches[0], end: matches[0] + anchor.quote.length };
  const quotes = occurrences(source, anchor.quote, 3);
  if (quotes.length) return { location: 'window_changed', candidates: quotes.length };
  return { location: 'lost' };
}

// How a located anchor is shown. Strict mode is an author preference for the book: it changes presentation
// only (historic author decisions are never rewritten).
export function evidenceTone(location, { strict = false, bindingOk = true } = {}) {
  if (!bindingOk || location === 'lost') return 'lost';
  if (location === 'exact') return 'current';
  if (location === 'intact' || location === 'shifted') return strict ? 'review' : 'historic';
  return 'review';
}
const TONE_RANK = { current: 0, historic: 1, review: 2, lost: 3 };
export const worstTone = tones => tones.reduce((worst, tone) => (TONE_RANK[tone] ?? 0) > (TONE_RANK[worst] ?? 0) ? tone : worst, 'current');

export const STATE_LABELS = { not_started: 'Не начат', in_progress: 'В работе', proposed: 'Проверить', closed: 'Закрыт' };
// Display status of one stage revision. `progress` is the stored row (or null = not started); evidence carries
// computed tones; a pending, receipt-bound proposal overlays "proposed" without becoming stored state.
export function stageStatus({ progress = null, evidence = [], pendingProposals = 0, basisChanged = false, strict = false } = {}) {
  const stored = progress?.state ?? 'not_started';
  if (stored !== 'closed') {
    if (pendingProposals > 0) return { state: 'proposed', stored, tone: 'proposed', label: 'Предложен к закрытию · проверить', icon: '◌' };
    return stored === 'in_progress' ? { state: 'in_progress', stored, tone: 'progress', label: 'В работе', icon: '◐' } : { state: 'not_started', stored, tone: 'none', label: 'Не начат', icon: '○' };
  }
  const linked = evidence.filter(item => (progress.evidenceIds ?? []).includes(item.id));
  if (!linked.length) {
    if (basisChanged) return { state: 'closed', stored, tone: strict ? 'review' : 'historic', closure: 'no_fragment_changed', label: 'Подтверждено автором без фрагмента · связанная глава изменена', icon: '✓' };
    return { state: 'closed', stored, tone: 'no_fragment', closure: 'no_fragment', label: 'Подтверждено автором без фрагмента', icon: '✓' };
  }
  const tone = worstTone(linked.map(item => item.tone));
  const label = { current: 'Закрыт · фрагмент актуален', historic: 'Закрыт автором · глава изменена', review: 'Закрыт ранее · проверить фрагмент', lost: 'Закрыт ранее · фрагмент не найден' }[tone];
  return { state: 'closed', stored, tone, closure: tone, label, icon: tone === 'current' ? '✓' : tone === 'historic' ? '✓' : '!' };
}

// Table-of-contents counter of the active approved chapter plan: navigation, not a quality score.
export function chapterCounter(stageStatuses, approved) {
  if (!approved) return { label: 'План не согласован', closed: 0, total: 0, stale: false, approved: false };
  const total = stageStatuses.length, closed = stageStatuses.filter(item => item.state === 'closed').length;
  const stale = stageStatuses.some(item => item.state === 'closed' && item.tone !== 'current' && item.tone !== 'no_fragment');
  return { label: `${closed} из ${total} закрыто`, closed, total, stale, approved: true };
}

// Source identities are app-owned and independent of titles and positions.
export const googleIdentity = (documentId, key) => JSON.stringify(['google', documentId, key]);
export const documentIdentity = id => JSON.stringify(['document', id]);
// Rich editor identities: local drafts use "document:<id>", Google chapters use [bookId, documentId, key].
export function sourceFromEditorIdentity(identity) {
  if (typeof identity !== 'string' || !identity) return null;
  if (identity.startsWith('document:')) { const id = identity.slice(9); return id && !id.startsWith('local-') ? { kind: 'document', id } : null; }
  try { const value = JSON.parse(identity); if (Array.isArray(value) && value.length === 3 && value.every(x => typeof x === 'string' && x)) return { kind: 'google', bookId: value[0], documentId: value[1], key: value[2] }; } catch { /* not a chapter identity */ }
  return null;
}
