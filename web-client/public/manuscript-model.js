// Pure state helpers for the chapter workspace: no DOM, no network.

// Every request captures a token; a newer begin() or bump() makes older tokens stale, so a response
// that returns after leaving and re-entering the same book/document (A → B → A) is still discarded.
export function createScopeGuard() {
  let generation = 0, scope = '';
  return {
    enter(nextScope) { if (nextScope !== scope) { scope = nextScope; generation++; } return generation; },
    bump() { generation++; return generation; },
    begin() { return { generation, scope }; },
    isCurrent(token) { return !!token && token.generation === generation && token.scope === scope; },
    scope: () => scope,
  };
}

export const scopeKeyOf = (bookId, documentId) => `${bookId ?? ''}|${documentId ?? ''}`;
export const storageKeyOf = (bookId, documentId) => `talewisp.chapters.v1.${bookId}.${documentId}`;

export function isDirty(item) {
  if (!item) return false;
  if (item.kind === 'new') return true;
  return item.title !== item.baseTitle || item.body !== item.baseBody;
}

export function detectionLabel(section) {
  if (section.detection === 'heading') return `Заголовок ${section.level}`;
  if (section.detection === 'plain') return 'Распознано по строке «Глава/Пролог/Эпилог»';
  if (section.detection === 'preamble') return 'Текст до первого заголовка';
  if (section.detection === 'whole') return 'Во вкладке нет заголовков';
  if (section.detection === 'written') return 'Новая глава уже записана в Google';
  return '';
}

export function sectionTitle(section) {
  return section.hasHeading ? (section.title || '').trim() || 'Без названия' : section.label;
}

export function wordsLabel(count) {
  const n = Number(count) || 0, a = n % 10, b = n % 100;
  return n + ' ' + (a === 1 && b !== 11 ? 'слово' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'слова' : 'слов');
}

// Loaded chapter from a /sections response. `revisionId` is the Google revision it was read at.
export function loadedFromSection(section, revisionId) {
  return {
    key: section.sectionId, kind: 'section', sectionId: section.sectionId, label: section.label, tabId: section.tabId, tabTitle: section.tabTitle,
    level: section.level, detection: section.detection, hasHeading: section.hasHeading, headingId: section.headingId,
    baseTitle: section.title, baseBody: section.body, baseHash: section.hash, baseRevision: revisionId,
    title: section.title, body: section.body, locked: section.locked ?? [], titleLocked: section.titleLocked ?? '', conflict: false,
  };
}

// A fresh server copy never overwrites the author's unsaved text. If Google changed the chapter under a
// dirty draft, the draft keeps its text and is flagged; the author decides after seeing the review.
export function mergeLoaded(existing, fresh) {
  if (!existing) return fresh;
  if (!isDirty(existing)) return { ...fresh };
  if (existing.baseHash === fresh.baseHash) return { ...existing, baseRevision: fresh.baseRevision, sectionId: fresh.sectionId, key: fresh.key, locked: fresh.locked, conflict: false };
  return { ...existing, conflict: true, remote: { title: fresh.baseTitle, body: fresh.baseBody, hash: fresh.baseHash, revision: fresh.baseRevision, sectionId: fresh.sectionId } };
}

// A persisted working chapter has already been merged with Google by the server.
// Keep that base/conflict metadata; only overlay typing made after the request snapshot.
export function mergeWorkingChapter(local, persisted, sent) {
  if (!local) return { ...persisted };
  return { ...persisted,
    title: !sent || local.title !== sent.title ? local.title : persisted.title,
    body: !sent || local.body !== sent.body ? local.body : persisted.body,
  };
}

// Explicit author choice after a conflict: compare against the current Google text from now on.
export function rebaseOnRemote(item) {
  if (!item?.remote) return item;
  const { remote, ...rest } = item;
  return { ...rest, baseTitle: remote.title, baseBody: remote.body, baseHash: remote.hash, baseRevision: remote.revision, sectionId: remote.sectionId, key: remote.sectionId, conflict: false };
}

export function newChapterItem({ key, title, anchorSectionId, where, anchorLabel, tabTitle, tabId }) {
  return { key: 'new:' + key, kind: 'new', newKey: key, sectionId: '', label: title, tabId: tabId ?? '', tabTitle: tabTitle ?? '', level: 0, detection: 'new', hasHeading: true, baseTitle: '', baseBody: '', baseHash: '', baseRevision: '', title, body: '', locked: [], conflict: false, anchorSectionId, where, anchorLabel };
}

// A new chapter that was handed to an Apply whose outcome is not known yet (`inflight`) or never became known
// (`unknown`). `write` holds { state, operationId, scope, sent } and is saved before the Apply request.
export const isQuarantined = item => item?.kind === 'new' && !!item.write;

// Marks the new chapters about to be sent (by key) with the attempt; the author's text is not touched.
// `missing` lists keys that are no longer loaded: such a write must not be sent.
export function quarantineNew(items, chapters, { operationId, scope }) {
  const byKey = new Map(chapters.map(chapter => [chapter.key, chapter])), found = new Set();
  const out = items.map(item => {
    if (item.kind !== 'new' || item.write || !byKey.has(item.newKey)) return item;
    const { key, title, body, anchorSectionId, where } = byKey.get(item.newKey);
    found.add(key);
    return { ...item, write: { state: 'inflight', operationId, scope: { ...scope }, sent: { title, body, anchorSectionId, where } } };
  });
  return { items: out, missing: [...byKey.keys()].filter(key => !found.has(key)) };
}

// Result of one attempt for its own quarantined chapters only: 'unknown' keeps them blocked, 'release'
// (a definitive refusal before any write) makes them sendable again.
export function markAttempt(items, operationId, outcome) {
  return items.map(item => {
    if (!isQuarantined(item) || item.write.operationId !== operationId) return item;
    if (outcome === 'release') { const { write, ...rest } = item; return rest; }
    return { ...item, write: { ...item.write, state: 'unknown' } };
  });
}

// Only loaded Google chapters and not-yet-written new chapters are sent. A `written` item (a new chapter
// already in Google whose later edits could not be tied to it yet) and a quarantined new chapter are never sent again.
export function buildWritePayload(items) {
  const edits = [], newChapters = [];
  for (const item of items) {
    if (item.kind === 'new') { if (!item.write && item.title.trim()) newChapters.push({ key: item.newKey, title: item.title, body: item.body, anchorSectionId: item.anchorSectionId, where: item.where }); }
    else if (item.kind === 'section' && isDirty(item)) edits.push({ sectionId: item.sectionId, baseHash: item.baseHash, title: item.hasHeading ? item.title : undefined, body: item.body });
  }
  return { edits, newChapters };
}

// The exact text sent with a write, per loaded item; settlement compares against it, not against the
// editor, because the author may keep typing while the review and the write are pending.
export function writeSnapshot(items) {
  const payload = buildWritePayload(items), sent = new Set([...payload.edits.map(edit => edit.sectionId), ...payload.newChapters.map(chapter => 'new:' + chapter.key)]);
  return new Map(items.filter(item => sent.has(item.kind === 'new' ? item.key : item.sectionId)).map(item => [item.key, { title: item.title, body: item.body }]));
}

// A Google chapter whose base is the server copy, carrying the author's current (possibly newer) text.
export function adoptCreated(fresh, item) {
  return { ...fresh, title: fresh.hasHeading ? item.title : fresh.baseTitle, body: item.body, conflict: false };
}

// After a verified write. `snapshot` holds the text that was sent (see writeSnapshot); without it every
// item is treated as sent unchanged. `created` maps a written new chapter key to its fresh Google copy.
// - Text equal to the server copy becomes clean.
// - If the server copy is exactly what was sent, later typing stays as a dirty edit on top of it.
// - A written new chapter becomes the created Google chapter; if that chapter could not be identified,
//   later typing is kept as a `written` item that is never inserted again; unchanged ones are dropped.
// - A sent chapter that could not be re-read is marked stale: its old base no longer matches Google.
export function settleAfterWrite(items, freshById, result, snapshot = null, created = new Map()) {
  const written = new Set(result?.newChapters ?? []), out = [];
  const sentOf = item => (snapshot ? snapshot.get(item.key) : { title: item.title, body: item.body });
  for (const item of items) {
    const sent = sentOf(item), unchanged = !!sent && sent.title === item.title && sent.body === item.body;
    if (item.kind === 'new') {
      // Quarantined by another attempt: this result says nothing about it.
      if (item.write && result?.operationId && item.write.operationId !== result.operationId) { out.push(item); continue; }
      if (!written.has(item.newKey) || !sent) { out.push(item.write ? { ...item, write: { ...item.write, state: 'unknown' } } : item); continue; }
      const fresh = created.get(item.newKey), { write, ...rest } = item;
      if (fresh) out.push(unchanged ? { ...fresh } : adoptCreated(fresh, rest));
      else if (!unchanged) out.push({ ...rest, kind: 'written', detection: 'written', baseTitle: sent.title, baseBody: sent.body });
      continue;
    }
    if (item.kind !== 'section') { out.push(item); continue; }
    const fresh = freshById.get(item.sectionId);
    if (!fresh) { out.push(sent && snapshot ? { ...item, stale: true } : item); continue; }
    if (fresh.baseTitle === item.title && fresh.baseBody === item.body) out.push({ ...fresh });
    else if (sent && fresh.baseTitle === sent.title && fresh.baseBody === sent.body) out.push(adoptCreated(fresh, item));
    else out.push(mergeLoaded(item, fresh));
  }
  return out;
}

export function serializeState(state) {
  return JSON.stringify({ v: 1, loaded: state.loaded.map(({ remote, ...item }) => ({ ...item, ...(remote ? { remote } : {}) })), activeKey: state.activeKey ?? null, checked: [...(state.checked ?? [])], agentKeys: [...(state.agentKeys ?? [])] });
}

export function parseState(text) {
  try {
    const value = JSON.parse(text || 'null');
    if (!value || value.v !== 1 || !Array.isArray(value.loaded)) return null;
    // A restored in-flight attempt can no longer complete here: its outcome is unknown, so it stays blocked.
    const loaded = value.loaded.filter(item => item && typeof item.key === 'string' && typeof item.title === 'string' && typeof item.body === 'string' && typeof item.baseBody === 'string')
      .map(item => (item.kind === 'new' && item.write ? { ...item, write: { ...(typeof item.write === 'object' ? item.write : {}), state: 'unknown' } } : item));
    return { loaded, activeKey: typeof value.activeKey === 'string' ? value.activeKey : null, checked: Array.isArray(value.checked) ? value.checked.filter(x => typeof x === 'string') : [], agentKeys: Array.isArray(value.agentKeys) ? value.agentKeys.filter(x => typeof x === 'string') : [] };
  } catch { return null; }
}

export function googleDocUrl(documentId, { tabId = '', headingId = '' } = {}) {
  const url = new URL(`https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`);
  if (tabId) url.searchParams.set('tab', tabId);
  if (headingId) url.hash = 'heading=' + headingId;
  return url.toString();
}
