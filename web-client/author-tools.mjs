// Author tools: chapter version history, writing statistics, book export, timeline, entity lookup,
// continuity findings for the open chapter and project-wide search. Everything here is read-only for
// the author's vault and for Google; the only state it owns is its own SQLite file in the data directory.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildBookFile, EXPORT_FORMATS } from './book-export.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });
const sha = value => createHash('sha256').update(value).digest('hex');
export const countWords = text => (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
export const chapterTitle = item => String((item.kind === 'new' || item.kind === 'written' || item.hasHeading ? item.title : item.label) || item.title || 'Без названия').trim() || 'Без названия';
const dayOf = date => { const d = new Date(date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const OPEN_WINDOW_MS = 10 * 60_000;
const MAX_VERSIONS_PER_CHAPTER = 120;
const ASSERTION_LABELS = { death: 'Смерть', revival: 'Возвращение', appearance: 'Появление', mention: 'Упоминание', promise_setup: 'Обещание читателю', promise_payoff: 'Обещание выполнено', learn: 'Персонаж узнаёт', reveal: 'Читатель узнаёт', knowledge_use: 'Персонаж использует знание', reader_use: 'Опора на знание читателя' };

export function createAuthorTools({ dataDir, manuscriptFiles, store, workspaceService, bookContext, pluginCall = null, now = () => Date.now() }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'author-tools.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS chapter_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, document_id TEXT NOT NULL, chapter_key TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, words INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS chapter_versions_chapter ON chapter_versions(book_id, document_id, chapter_key, id);
    CREATE TABLE IF NOT EXISTS writing_days (book_id TEXT NOT NULL, day TEXT NOT NULL, start_words INTEGER NOT NULL, words INTEGER NOT NULL, PRIMARY KEY(book_id, day));`);

  // ---- Chapter history --------------------------------------------------------------------------
  const latest = db.prepare('SELECT id, hash, created_at, pinned FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=? ORDER BY id DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO chapter_versions(book_id, document_id, chapter_key, title, body, hash, words, created_at, updated_at, label) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const refresh = db.prepare('UPDATE chapter_versions SET title=?, body=?, hash=?, words=?, updated_at=? WHERE id=?');
  const prune = db.prepare(`DELETE FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=? AND pinned=0 AND id NOT IN
    (SELECT id FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=? AND pinned=0 ORDER BY id DESC LIMIT ${MAX_VERSIONS_PER_CHAPTER})`);
  const liveChapters = copy => (copy?.chapters ?? []).filter(item => item && !item.missing && typeof item.body === 'string');

  /** Records what changed in a committed working copy. Saves within ten minutes refine one open version. */
  function recordCopy(copy) {
    if (!copy?.bookId || !copy.documentId) return 0;
    const at = now(); let written = 0;
    db.exec('BEGIN');
    try {
      for (const item of liveChapters(copy)) {
        const title = chapterTitle(item), hash = sha(`${title}\0${item.body}`), keys = [copy.bookId, copy.documentId, item.key];
        const last = latest.get(...keys);
        if (last?.hash === hash) continue;
        if (!last && typeof item.baseBody === 'string' && item.kind === 'section' && item.baseBody !== item.body) {
          const baseTitle = String(item.hasHeading ? item.baseTitle : item.label) || title;
          insert.run(...keys, baseTitle, item.baseBody, sha(`${baseTitle}\0${item.baseBody}`), countWords(item.baseBody), at, at, 'Из Google');
        }
        // Text that returns to an earlier version is a restore: keep the outgoing text as its own version.
        const restored = last && db.prepare('SELECT 1 AS hit FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=? AND hash=? AND id<>? LIMIT 1').get(...keys, hash, last.id);
        if (last && !restored && !last.pinned && at - last.created_at < OPEN_WINDOW_MS && db.prepare('SELECT COUNT(*) AS n FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=?').get(...keys).n > 1) {
          refresh.run(title, item.body, hash, countWords(item.body), at, last.id);
        } else insert.run(...keys, title, item.body, hash, countWords(item.body), at, at, '');
        prune.run(...keys, ...keys);
        written += 1;
      }
      recordDay(copy.bookId, liveChapters(copy).reduce((sum, item) => sum + countWords(item.body), 0), at);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return written;
  }

  function recordDay(bookId, words, at = now()) {
    const day = dayOf(at), row = db.prepare('SELECT start_words FROM writing_days WHERE book_id=? AND day=?').get(bookId, day);
    if (row) { db.prepare('UPDATE writing_days SET words=? WHERE book_id=? AND day=?').run(words, bookId, day); return; }
    const previous = db.prepare('SELECT words FROM writing_days WHERE book_id=? AND day<? ORDER BY day DESC LIMIT 1').get(bookId, day);
    db.prepare('INSERT INTO writing_days(book_id, day, start_words, words) VALUES(?,?,?,?)').run(bookId, day, previous ? previous.words : words, words);
  }

  /** The same working-copy API as manuscriptFiles; committed saves and imports also feed the history. */
  const recordingFiles = {
    ...manuscriptFiles,
    save(...args) { const copy = manuscriptFiles.save(...args); try { recordCopy(copy); } catch (error) { console.error('TaleWisp Web could not record chapter history:', error.message); } return copy; },
    importDocument(...args) { const copy = manuscriptFiles.importDocument(...args); try { recordCopy(copy); } catch (error) { console.error('TaleWisp Web could not record chapter history:', error.message); } return copy; },
  };

  const versionView = row => ({ id: row.id, chapterKey: row.chapter_key, title: row.title, words: row.words, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), pinned: !!row.pinned, label: row.label });
  function history(context, chapterKey) {
    if (typeof chapterKey !== 'string' || !chapterKey || chapterKey.length > 450) throw fail(400, 'Нужен ключ главы.');
    const rows = db.prepare('SELECT id, chapter_key, title, words, created_at, updated_at, pinned, label FROM chapter_versions WHERE book_id=? AND document_id=? AND chapter_key=? ORDER BY id DESC').all(context.bookId, context.documentId, chapterKey);
    return { chapterKey, versions: rows.map(versionView) };
  }
  function versionRow(context, id) {
    const row = Number.isSafeInteger(id) ? db.prepare('SELECT * FROM chapter_versions WHERE id=? AND book_id=? AND document_id=?').get(id, context.bookId, context.documentId) : null;
    if (!row) throw fail(404, 'Версия не найдена в этой книге.');
    return row;
  }
  const version = (context, id) => { const row = versionRow(context, id); return { ...versionView(row), body: row.body }; };
  function pin(context, { id, pinned = true, label = '' }) {
    const row = versionRow(context, id);
    if (typeof label !== 'string' || label.length > 120) throw fail(400, 'Подпись версии не длиннее 120 знаков.');
    db.prepare('UPDATE chapter_versions SET pinned=?, label=? WHERE id=?').run(pinned ? 1 : 0, label.trim(), row.id);
    return versionView({ ...row, pinned: pinned ? 1 : 0, label: label.trim() });
  }

  // ---- Statistics -------------------------------------------------------------------------------
  const goalKey = (bookId, name) => `author-tools:${name}:${bookId}`;
  const readGoal = (bookId, name) => { const value = Number.parseInt(store.getSetting(goalKey(bookId, name)) ?? '', 10); return Number.isSafeInteger(value) && value > 0 ? value : 0; };
  function readCopy(context) { try { return context.documentId ? manuscriptFiles.read(context.bookId, context.documentId) : null; } catch { return null; } }
  function bookChapters(context) {
    const copy = readCopy(context);
    if (copy) return { source: 'manuscript', chapters: liveChapters(copy).map(item => ({ key: item.key, title: chapterTitle(item), body: item.body, rich: item.rich ?? null, heading: item.kind !== 'section' || !!item.hasHeading })) };
    const documents = store.listDocuments().filter(row => row.bookId === context.bookId).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    return { source: 'documents', chapters: documents.map(row => ({ key: `document:${row.id}`, title: row.title || 'Без названия', body: row.text ?? '', rich: row.rich ?? null, heading: true })) };
  }
  function stats(context) {
    const { source, chapters } = bookChapters(context), rows = chapters.map(item => ({ key: item.key, title: item.title, words: countWords(item.body), characters: item.body.length }));
    const totalWords = rows.reduce((sum, row) => sum + row.words, 0);
    if (source === 'manuscript') recordDay(context.bookId, totalWords);
    const days = db.prepare('SELECT day, start_words, words FROM writing_days WHERE book_id=? ORDER BY day DESC LIMIT 60').all(context.bookId).reverse().map(row => ({ day: row.day, written: row.words - row.start_words, total: row.words }));
    const today = dayOf(now()), byDay = new Map(days.map(row => [row.day, row]));
    let streak = 0; const cursor = new Date(now());
    if (!(byDay.get(today)?.written > 0)) cursor.setDate(cursor.getDate() - 1);
    while (streak < 400 && byDay.get(dayOf(cursor))?.written > 0) { streak += 1; cursor.setDate(cursor.getDate() - 1); }
    return { bookId: context.bookId, bookName: context.bookName ?? '', source, totalWords, totalCharacters: rows.reduce((sum, row) => sum + row.characters, 0), chapters: rows, days, today: byDay.get(today)?.written ?? 0, streak, targetWords: readGoal(context.bookId, 'target'), dailyGoal: readGoal(context.bookId, 'daily') };
  }
  function setGoals(context, body) {
    for (const [field, name] of [['targetWords', 'target'], ['dailyGoal', 'daily']]) {
      if (body[field] === undefined) continue;
      if (!Number.isSafeInteger(body[field]) || body[field] < 0 || body[field] > 50_000_000) throw fail(400, 'Цель задаётся целым неотрицательным числом слов.');
      store.setSetting(goalKey(context.bookId, name), String(body[field]));
    }
    return stats(context);
  }

  // ---- Export -----------------------------------------------------------------------------------
  function exportBook(context, format) {
    if (!EXPORT_FORMATS.includes(format)) throw fail(400, 'Поддерживаются форматы EPUB, DOCX и FB2.');
    const { chapters } = bookChapters(context), filled = chapters.filter(item => item.body.trim());
    if (!filled.length) throw fail(409, 'В книге пока нет текста для сборки. Импортируйте рукопись или создайте главы.', 'book_empty');
    return buildBookFile({ format, title: context.bookName || 'Книга', author: context.authorName || '', series: context.seriesName || '', language: 'ru', chapters: filled, identifier: sha(`${context.bookId}|${context.documentId ?? ''}`).slice(0, 32), modifiedAt: new Date(now()) });
  }

  // ---- Continuity contracts: timeline, entities, findings ------------------------------------------
  const contractCache = new Map();
  function contracts() {
    const root = workspaceService.root();
    if (!root || !existsSync(root)) return [];
    const found = [], queue = [[root, 0]]; let examined = 0;
    while (queue.length && examined < 600) {
      const [directory, depth] = queue.shift();
      let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) { if (depth < 6) queue.push([full, depth + 1]); continue; }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json') || examined >= 600) continue;
        examined += 1;
        let info; try { info = statSync(full); } catch { continue; }
        if (info.size > 2 * 1024 * 1024) continue;
        const stamp = `${info.size}:${info.mtimeMs}`, cached = contractCache.get(full);
        if (cached?.stamp === stamp) { if (cached.contract) found.push(cached.contract); continue; }
        let contract = null;
        try {
          const data = JSON.parse(readFileSync(full, 'utf8').replace(/^﻿/, ''));
          if (data && data.version === 1 && ['scenes', 'entities', 'facts', 'assertions'].every(name => Array.isArray(data[name]))) contract = { path: relative(root, full).replaceAll('\\', '/'), data };
        } catch { contract = null; }
        contractCache.set(full, { stamp, contract });
        if (contract) found.push(contract);
      }
    }
    return found.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  }
  const text = (value, limit = 600) => typeof value === 'string' ? value.slice(0, limit) : '';
  const evidenceView = row => row?.evidence && typeof row.evidence === 'object' ? { path: text(row.evidence.path, 400), quote: text(row.evidence.quote, 1200) } : null;
  const entityName = row => text(row.name, 200) || text(row.title, 200) || text(row.label, 200) || text(row.id, 200);
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function timeline({ axis = 'story', entity = '' } = {}) {
    const field = axis === 'narrative' ? 'narrative_order' : 'story_order', list = contracts(), events = [], entities = new Map();
    for (const contract of list) {
      const { data } = contract, byId = name => new Map(data[name].filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
      const scenes = byId('scenes'), entityRows = byId('entities'), facts = byId('facts');
      for (const row of entityRows.values()) entities.set(row.id, entityName(row));
      const grouped = new Map();
      for (const assertion of data.assertions) {
        if (!assertion || typeof assertion.scene_id !== 'string') continue;
        if (entity && assertion.entity_id !== entity) continue;
        if (!grouped.has(assertion.scene_id)) grouped.set(assertion.scene_id, []);
        grouped.get(assertion.scene_id).push({ id: text(assertion.id, 200), kind: text(assertion.kind, 40), label: ASSERTION_LABELS[assertion.kind] ?? text(assertion.kind, 40), status: text(assertion.status, 20), entityId: text(assertion.entity_id, 200), entityName: assertion.entity_id ? entityName(entityRows.get(assertion.entity_id) ?? { id: assertion.entity_id }) : '', fact: text(facts.get(assertion.fact_id)?.text, 600), promiseId: text(assertion.promise_id, 200), evidence: evidenceView(assertion) });
      }
      for (const scene of scenes.values()) {
        const items = grouped.get(scene.id) ?? [];
        if (entity && !items.length) continue;
        events.push({ contract: contract.path, sceneId: scene.id, title: text(scene.title, 300) || text(scene.name, 300) || scene.id, status: text(scene.status, 20), storyOrder: finite(scene.story_order) ? scene.story_order : null, narrativeOrder: finite(scene.narrative_order) ? scene.narrative_order : null, order: finite(scene[field]) ? scene[field] : null, evidence: evidenceView(scene), items });
      }
    }
    events.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.sceneId.localeCompare(b.sceneId, 'ru'));
    return { axis: axis === 'narrative' ? 'narrative' : 'story', contracts: list.map(item => item.path), entities: [...entities].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')), events };
  }

  /** Names the editor can recognise in chapter text: knowledge cards plus named continuity entities. */
  function entities() {
    const result = [], seen = new Set();
    const add = (name, row) => { const key = name.toLocaleLowerCase('ru'); if (name.length < 3 || name.length > 80 || seen.has(key)) return; seen.add(key); result.push({ name, ...row }); };
    let cards = []; try { cards = workspaceService.cards({}).cards ?? []; } catch { cards = []; }
    for (const card of cards) {
      if (!card.title || card.type === 'note' && /исходный текст/i.test(card.title)) continue;
      add(String(card.title).trim(), { path: card.path, type: card.type, excerpt: text(card.excerpt, 360), status: card.status });
    }
    for (const contract of contracts()) {
      const facts = new Map(contract.data.facts.filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
      const scenes = new Map(contract.data.scenes.filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
      for (const row of contract.data.entities) {
        if (!row || typeof row.id !== 'string' || !(text(row.name) || text(row.title))) continue;
        const knows = contract.data.assertions.filter(item => item?.kind === 'learn' && item.entity_id === row.id && item.status === 'confirmed' && facts.has(item.fact_id))
          .map(item => ({ fact: text(facts.get(item.fact_id).text, 300), order: finite(scenes.get(item.scene_id)?.story_order) ? scenes.get(item.scene_id).story_order : null, sceneId: text(item.scene_id, 200) }))
          .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity)).slice(0, 12);
        const existing = result.find(item => item.name.toLocaleLowerCase('ru') === entityName(row).toLocaleLowerCase('ru'));
        if (existing) { existing.entityId = row.id; existing.knows = knows; }
        else add(entityName(row), { path: '', type: 'entity', excerpt: text(row.evidence?.quote, 360), status: text(row.status, 20), entityId: row.id, knows });
        for (const alias of Array.isArray(row.aliases) ? row.aliases.slice(0, 8) : []) if (typeof alias === 'string') add(alias.trim(), { path: existing?.path ?? '', type: existing?.type ?? 'entity', excerpt: existing?.excerpt ?? text(row.evidence?.quote, 360), status: text(row.status, 20), entityId: row.id, knows, aliasOf: entityName(row) });
      }
    }
    return { entities: result.slice(0, 2000), truncated: result.length > 2000 };
  }

  const locate = (body, quote) => { if (!quote || quote.length < 6) return null; const start = body.indexOf(quote); return start < 0 ? null : { start, end: start + quote.length }; };
  /** Deterministic findings for the open chapter: plugin audits of every contract, plus hints tied to this text. */
  async function continuity(context, { text: body = '' } = {}) {
    if (typeof body !== 'string' || body.length > 2_000_000) throw fail(400, 'Текст главы передан в неверном формате.');
    const list = contracts(), reports = [], findings = [];
    for (const contract of list.slice(0, 16)) {
      let report = null, error = '';
      if (pluginCall) {
        try {
          const result = await pluginCall('talewisp_continuity_check', { contract_path: contract.path });
          const payload = result?.structuredContent ?? JSON.parse(result?.content?.find?.(item => typeof item.text === 'string')?.text ?? 'null');
          if (payload && typeof payload === 'object') report = payload;
        } catch (failure) { error = text(failure?.message, 300) || 'Плагин не ответил.'; }
      } else error = 'Проверка плагином недоступна на этом сервере.';
      const rows = Array.isArray(report?.findings) ? report.findings : [];
      reports.push({ path: contract.path, status: text(report?.status, 40) || (error ? 'UNAVAILABLE' : 'UNKNOWN'), error, findings: rows.length, failures: rows.filter(row => row?.severity === 'FAIL').length });
      for (const row of rows.slice(0, 400)) {
        const evidence = evidenceView(row), range = locate(body, evidence?.quote);
        if (row?.severity !== 'FAIL' && !range) continue;
        findings.push({ severity: row.severity === 'FAIL' ? 'fail' : 'incomplete', code: text(row.code, 80), record: text(row.record, 200), message: text(row.message, 600), contract: contract.path, evidence, range });
      }
      // Hint: a named entity with a recorded death is mentioned in this text. The author decides whether it is a flashback.
      const scenes = new Map(contract.data.scenes.filter(row => row && typeof row.id === 'string').map(row => [row.id, row]));
      for (const death of contract.data.assertions.filter(row => row?.kind === 'death' && row.status === 'confirmed')) {
        const row = contract.data.entities.find(item => item?.id === death.entity_id), name = row ? text(row.name) || text(row.title) : '';
        if (name.length < 3) continue;
        const start = body.toLocaleLowerCase('ru').indexOf(name.toLocaleLowerCase('ru'));
        if (start < 0) continue;
        findings.push({ severity: 'hint', code: 'mention_after_recorded_death', record: `assertions:${text(death.id, 200)}`, message: `В тексте есть «${name}», а в каноне записана смерть (сцена ${text(scenes.get(death.scene_id)?.title, 200) || text(death.scene_id, 200)}). Проверьте, что это воспоминание или упоминание, а не живое появление.`, contract: contract.path, evidence: evidenceView(death), range: { start, end: start + name.length } });
      }
    }
    const rank = { fail: 0, hint: 1, incomplete: 2 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity));
    return { checkedAt: new Date(now()).toISOString(), contracts: reports, findings: findings.slice(0, 200), truncated: findings.length > 200, scope: 'listed_records_only' };
  }

  // ---- Project-wide search --------------------------------------------------------------------------
  const snippet = (source, index, length) => { const from = Math.max(0, index - 60), to = Math.min(source.length, index + length + 100); return (from ? '…' : '') + source.slice(from, to).replace(/\s+/g, ' ').trim() + (to < source.length ? '…' : ''); };
  function search(context, query) {
    const q = String(query ?? '').trim();
    if (q.length < 2) return { query: q, results: [] };
    if (q.length > 200) throw fail(400, 'Запрос длиннее 200 знаков.');
    const needle = q.toLocaleLowerCase('ru'), results = [];
    const scan = (kind, id, title, body, extra = {}) => {
      const inTitle = String(title).toLocaleLowerCase('ru').includes(needle), index = String(body).toLocaleLowerCase('ru').indexOf(needle);
      if (!inTitle && index < 0) return;
      results.push({ kind, id, title: String(title).slice(0, 300), snippet: index >= 0 ? snippet(String(body), index, q.length) : String(body).slice(0, 160).replace(/\s+/g, ' '), offset: index >= 0 ? index : null, rank: inTitle ? 0 : 1, ...extra });
    };
    if (context) for (const item of bookChapters(context).chapters) if (!item.key.startsWith('document:')) scan('chapter', item.key, item.title, item.body);
    for (const row of store.listDocuments()) if (!context || !row.bookId || row.bookId === context.bookId) scan('document', row.id, row.title || 'Без названия', row.text ?? '');
    for (const row of store.listNotes()) scan('note', row.id, row.title || 'Заметка', row.text ?? '');
    try { for (const card of workspaceService.cards({ q }).cards ?? []) results.push({ kind: 'card', id: card.path, title: card.title, snippet: card.excerpt, offset: null, rank: String(card.title).toLocaleLowerCase('ru').includes(needle) ? 0 : 1, type: card.type }); } catch { /* no series selected */ }
    results.sort((a, b) => a.rank - b.rank);
    return { query: q, results: results.slice(0, 60).map(({ rank, ...row }) => row), truncated: results.length > 60 };
  }

  // ---- Routing --------------------------------------------------------------------------------------
  /** Returns { status, data } or { status, file }, or null when the path is not ours. */
  // Roleplay branches are driven by the agent; the client only shows the author where a scene stands.
  const pluginPayload = result => { if (result?.isError) throw new Error(result.content?.find?.(item => typeof item.text === 'string')?.text ?? 'Плагин отклонил запрос.'); return result?.structuredContent ?? JSON.parse(result?.content?.find?.(item => typeof item.text === 'string')?.text ?? 'null'); };
  function roleplayStarts() {
    const rows = typeof workspaceService.listProposals === 'function' ? workspaceService.listProposals() : [], starts = [];
    for (const row of rows) {
      if (row?.tool !== 'talewisp_roleplay_start' || row.state !== 'applied') continue;
      let full = null; try { full = workspaceService.proposal(row.id); } catch { full = null; }
      const sessionId = full?.arguments?.session_id;
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(sessionId) || starts.some(item => item.sessionId === sessionId)) continue;
      starts.push({ sessionId, title: text(row.title, 200) || sessionId, startedAt: full.appliedAt ?? row.createdAt ?? null });
    }
    return starts.slice(0, 40);
  }
  async function roleplay() {
    const sessions = [];
    for (const start of roleplayStarts()) {
      let status = null, error = '';
      if (pluginCall) {
        try {
          const value = pluginPayload(await pluginCall('talewisp_roleplay_status', { session_id: start.sessionId }));
          if (value && typeof value === 'object') status = { runState: text(value.run_state, 40), phase: text(value.phase, 40), turn: Number.isSafeInteger(value.turn_number) ? value.turn_number : 0, revision: Number.isSafeInteger(value.revision) ? value.revision : null, heroId: text(value.hero_id, 200), formattingReady: value.formatting_ready === true };
        } catch (failure) { error = text(failure?.message, 300) || 'Плагин не ответил.'; }
      } else error = 'Плагин недоступен на этом сервере.';
      sessions.push({ ...start, status, error });
    }
    return { available: Boolean(pluginCall), sessions };
  }
  async function roleplayScene(sessionId) {
    if (!roleplayStarts().some(item => item.sessionId === sessionId)) throw Object.assign(new Error('Такой ролевой сцены в этой серии нет.'), { status: 404 });
    if (!pluginCall) throw Object.assign(new Error('Плагин недоступен на этом сервере.'), { status: 503 });
    const packet = pluginPayload(await pluginCall('talewisp_roleplay_packet', { session_id: sessionId, role: 'leader' })) ?? {};
    const line = value => text(typeof value === 'string' ? value : value?.text, 24_000);
    const turns = (Array.isArray(packet.turns) ? packet.turns : []).slice(-200).map((turn, index) => ({ turn: Number.isSafeInteger(turn?.turn) ? turn.turn : index + 1, situation: line(turn?.situation), heroAction: line(turn?.hero_action), consequence: line(turn?.consequence) }));
    return { sessionId, phase: text(packet.phase, 40), runState: text(packet.run_state, 40), turns };
  }

  async function handle(method, pathname, body, searchParams) {
    if (!pathname.startsWith('/api/tools/')) return null;
    const route = pathname.slice('/api/tools/'.length), get = method === 'GET', post = method === 'POST', param = name => searchParams.get(name) ?? '';
    const ok = data => ({ status: 200, data });
    if (get && route === 'search') return ok(search(bookContext({ optional: true }), param('q')));
    if (get && route === 'journal') return ok({ entries: workspaceService.journal() });
    if (post && route === 'journal/undo') return ok({ entry: workspaceService.undoProposal(body.id) });
    if (get && route === 'timeline') return ok(timeline({ axis: param('axis'), entity: param('entity') }));
    if (get && route === 'entities') return ok(entities());
    if (get && route === 'roleplay') return ok(await roleplay());
    if (get && route === 'roleplay/scene') return ok(await roleplayScene(param('session')));
    const context = bookContext();
    if (get && route === 'history') return ok(history(context, param('chapter')));
    if (get && route === 'history/version') return ok(version(context, Number(param('id'))));
    if (post && route === 'history/pin') return ok({ version: pin(context, body) });
    if (get && route === 'stats') return ok(stats(context));
    if (post && route === 'stats/goals') return ok(setGoals(context, body));
    if (get && route === 'export') return { status: 200, file: exportBook(context, param('format')) };
    if (post && route === 'continuity') return ok(await continuity(context, body));
    throw fail(404, 'Route not found.');
  }

  return { handle, manuscriptFiles: recordingFiles, recordCopy, history, version, pin, stats, setGoals, exportBook, timeline, entities, continuity, search, contracts, roleplay, roleplayScene, close: () => db.close() };
}
