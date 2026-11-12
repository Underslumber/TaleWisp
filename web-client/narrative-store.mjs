// App-owned narrative framework storage. Lives in the application SQLite database next to drafts and project
// metadata (never in the vault, never in .book.json): a book plan must survive a change of main manuscript.
// Every mutation runs inside one IMMEDIATE transaction together with its idempotency receipt and event rows.
import { createHash, randomUUID } from 'node:crypto';
import { scopeKey } from './workspace-scope.mjs';
import { canonicalJson, NarrativeError } from './public/narrative-model.js';

export const NARRATIVE_SCHEMA_VERSION = 1;
const now = () => new Date().toISOString();
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const parse = (value, fallback = null) => { if (value === null || value === undefined) return fallback; try { return JSON.parse(value); } catch { return fallback; } };
export const OPERATION_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS narrative_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS narrative_plans (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, author_id TEXT, series_id TEXT, book_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('book','chapter')), chapter_id TEXT,
    draft TEXT NOT NULL, draft_version INTEGER NOT NULL, draft_hash TEXT NOT NULL, draft_status TEXT NOT NULL DEFAULT 'draft',
    revision_index TEXT NOT NULL DEFAULT '{}', active_snapshot_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS narrative_plans_book ON narrative_plans(scope_key) WHERE kind='book';
  CREATE UNIQUE INDEX IF NOT EXISTS narrative_plans_chapter ON narrative_plans(scope_key, chapter_id) WHERE kind='chapter';
  CREATE TABLE IF NOT EXISTS narrative_snapshots (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
    book_snapshot_id TEXT, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, UNIQUE(plan_id, version)
  );
  CREATE TABLE IF NOT EXISTS narrative_chapters (
    chapter_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, author_id TEXT, series_id TEXT, book_id TEXT NOT NULL,
    title TEXT NOT NULL, sort_order INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    text_binding TEXT, source_identity TEXT, binding_version INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS narrative_chapters_source ON narrative_chapters(scope_key, source_identity) WHERE source_identity IS NOT NULL;
  CREATE TABLE IF NOT EXISTS narrative_progress (
    plan_id TEXT NOT NULL, stage_id TEXT NOT NULL, content_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('not_started','in_progress','closed')),
    decided_in_snapshot_id TEXT, actor TEXT NOT NULL, decision_reason TEXT, evidence_ids TEXT NOT NULL DEFAULT '[]', basis TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(plan_id, stage_id, content_revision)
  );
  CREATE TABLE IF NOT EXISTS narrative_evidence (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, plan_id TEXT NOT NULL, stage_id TEXT NOT NULL, content_revision INTEGER NOT NULL,
    chapter_id TEXT NOT NULL, source_identity TEXT NOT NULL, working_version INTEGER, text_hash TEXT NOT NULL,
    quote TEXT NOT NULL, prefix TEXT NOT NULL, suffix TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    origin TEXT NOT NULL, proposal_id TEXT, retired_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS narrative_evidence_stage ON narrative_evidence(plan_id, stage_id, content_revision);
  CREATE TABLE IF NOT EXISTS narrative_proposals (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, request_id TEXT NOT NULL, plan_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
    stage_id TEXT NOT NULL, content_revision INTEGER NOT NULL, chapter_id TEXT NOT NULL, source_identity TEXT NOT NULL, text_hash TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('close')), anchors TEXT NOT NULL, rationale TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','stale')), reason TEXT, call_ref TEXT, created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS narrative_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT, scope_key TEXT NOT NULL, action TEXT NOT NULL,
    before TEXT, after TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS narrative_events_scope ON narrative_events(scope_key, seq);
  CREATE TABLE IF NOT EXISTS narrative_operations (
    operation_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, action TEXT NOT NULL, body_hash TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS narrative_requests (
    request_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, mode TEXT NOT NULL, manifest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('staged','running','completed','failed','stopped')), status_reason TEXT,
    user_message_id TEXT, assistant_message_ids TEXT NOT NULL DEFAULT '[]', accounting TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS narrative_requests_scope ON narrative_requests(scope_key, created_at);
  CREATE TABLE IF NOT EXISTS narrative_receipts (
    operation_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, book_id TEXT NOT NULL, document_id TEXT NOT NULL,
    new_keys TEXT NOT NULL, sent_titles TEXT NOT NULL, prior_keys TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS narrative_prefs (scope_key TEXT PRIMARY KEY, strict INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`;

const NARRATIVE_TABLES = ['narrative_plans', 'narrative_chapters', 'narrative_evidence', 'narrative_requests', 'narrative_proposals'];
// Count of narrative rows in one exact scope. Used to refuse a project relink that would orphan them.
export function narrativeScopeCount(db, tuple) {
  const key = scopeKey({ authorId: tuple[0] ?? null, seriesId: tuple[1] ?? null, bookId: tuple[2] ?? null });
  let total = 0;
  for (const table of NARRATIVE_TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    total += db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope_key=?`).get(key).n;
  }
  return total;
}

export function createNarrativeStore({ db, tx }) {
  db.exec(SCHEMA);
  const stored = Number(db.prepare("SELECT value FROM narrative_meta WHERE key='schema'").get()?.value ?? 0);
  if (stored > NARRATIVE_SCHEMA_VERSION) throw new Error('Данные каркаса созданы более новой версией TaleWisp; запуск остановлен, чтобы их не повредить.');
  if (stored < NARRATIVE_SCHEMA_VERSION) db.prepare("INSERT INTO narrative_meta(key,value) VALUES('schema',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(NARRATIVE_SCHEMA_VERSION));

  const planView = row => row && ({ id: row.id, scopeKey: row.scope_key, kind: row.kind, chapterId: row.chapter_id ?? null, draft: parse(row.draft), draftVersion: row.draft_version, draftHash: row.draft_hash, draftStatus: row.draft_status, revisionIndex: parse(row.revision_index, {}), activeSnapshotId: row.active_snapshot_id ?? null, createdAt: row.created_at, updatedAt: row.updated_at });
  const snapshotView = row => row && ({ id: row.id, planId: row.plan_id, version: row.version, hash: row.hash, payload: parse(row.payload), bookSnapshotId: row.book_snapshot_id ?? null, approvedBy: row.approved_by, approvedAt: row.approved_at });
  const chapterView = row => row && ({ chapterId: row.chapter_id, scopeKey: row.scope_key, title: row.title, order: row.sort_order, archived: !!row.archived, binding: parse(row.text_binding), sourceIdentity: row.source_identity ?? null, bindingVersion: row.binding_version, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
  const progressView = row => row && ({ planId: row.plan_id, stageId: row.stage_id, contentRevision: row.content_revision, state: row.state, decidedInSnapshotId: row.decided_in_snapshot_id ?? null, actor: row.actor, decisionReason: row.decision_reason ?? '', evidenceIds: parse(row.evidence_ids, []), basis: parse(row.basis, []), version: row.version, updatedAt: row.updated_at });
  const evidenceView = row => row && ({ id: row.id, planId: row.plan_id, stageId: row.stage_id, contentRevision: row.content_revision, chapterId: row.chapter_id, sourceIdentity: row.source_identity, workingVersion: row.working_version ?? null, textHash: row.text_hash, quote: row.quote, prefix: row.prefix, suffix: row.suffix, start: row.start_offset, end: row.end_offset, origin: row.origin, proposalId: row.proposal_id ?? null, retiredAt: row.retired_at ?? null, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
  const proposalView = row => row && ({ id: row.id, requestId: row.request_id, planId: row.plan_id, snapshotId: row.snapshot_id, stageId: row.stage_id, contentRevision: row.content_revision, chapterId: row.chapter_id, sourceIdentity: row.source_identity, textHash: row.text_hash, action: row.action, anchors: parse(row.anchors, []), rationale: row.rationale, state: row.state, reason: row.reason ?? null, createdAt: row.created_at, decidedAt: row.decided_at ?? null });
  const requestView = row => row && ({ requestId: row.request_id, mode: row.mode, manifest: parse(row.manifest), status: row.status, statusReason: row.status_reason ?? null, userMessageId: row.user_message_id ?? null, assistantMessageIds: parse(row.assistant_message_ids, []), accounting: parse(row.accounting), createdAt: row.created_at, updatedAt: row.updated_at });
  const receiptView = row => row && ({ operationId: row.operation_id, bookId: row.book_id, documentId: row.document_id, newKeys: parse(row.new_keys, []), sentTitles: parse(row.sent_titles, {}), priorKeys: parse(row.prior_keys, []), createdAt: row.created_at });

  // One idempotent author/agent operation. Repeating the identical body returns the stored receipt; the same
  // id with another body or scope is refused. `fn` runs synchronously inside the transaction.
  function mutate({ scope, operationId, action, body, actor = 'author' }, fn) {
    if (typeof operationId !== 'string' || !OPERATION_PATTERN.test(operationId)) throw new NarrativeError('Нужен идентификатор операции.', 'operation_required', 400);
    const bodyHash = sha(canonicalJson({ action, body: body ?? null }));
    return tx(() => {
      const existing = db.prepare('SELECT * FROM narrative_operations WHERE operation_id=?').get(operationId);
      if (existing) {
        if (existing.scope_key !== scope.key || existing.action !== action || existing.body_hash !== bodyHash) throw new NarrativeError('Этот идентификатор операции уже использован для другого действия. Обновите каркас и повторите действие.', 'operation_conflict', 409);
        return { ...parse(existing.receipt, {}), replayed: true };
      }
      const events = [];
      const result = fn({ event: (eventAction, before, after) => events.push({ eventAction, before, after }) });
      const receipt = { operationId, action, ...result, completedAt: now() };
      db.prepare('INSERT INTO narrative_operations(operation_id,scope_key,action,body_hash,receipt,created_at) VALUES(?,?,?,?,?,?)').run(operationId, scope.key, action, bodyHash, JSON.stringify(receipt), now());
      const insert = db.prepare('INSERT INTO narrative_events(operation_id,scope_key,action,before,after,actor,created_at) VALUES(?,?,?,?,?,?,?)');
      for (const item of events.length ? events : [{ eventAction: action, before: null, after: result }]) insert.run(operationId, scope.key, item.eventAction, item.before === undefined ? null : JSON.stringify(item.before), item.after === undefined ? null : JSON.stringify(item.after), actor, now());
      return receipt;
    });
  }

  return {
    tx, mutate,
    operation: (scope, operationId) => { const row = db.prepare('SELECT * FROM narrative_operations WHERE operation_id=? AND scope_key=?').get(String(operationId), scope.key); return row ? { ...parse(row.receipt, {}), action: row.action, recordedAt: row.created_at } : null; },
    // Plans
    bookPlan: scope => planView(db.prepare("SELECT * FROM narrative_plans WHERE scope_key=? AND kind='book'").get(scope.key)),
    chapterPlan: (scope, chapterId) => planView(db.prepare("SELECT * FROM narrative_plans WHERE scope_key=? AND kind='chapter' AND chapter_id=?").get(scope.key, chapterId)),
    plan: (scope, id) => planView(db.prepare('SELECT * FROM narrative_plans WHERE scope_key=? AND id=?').get(scope.key, id)),
    planById: id => planView(db.prepare('SELECT * FROM narrative_plans WHERE id=?').get(id)),
    plans: scope => db.prepare('SELECT * FROM narrative_plans WHERE scope_key=? ORDER BY created_at, id').all(scope.key).map(planView),
    insertPlan(scope, { id, kind, chapterId = null, draft, draftHash, draftStatus, revisionIndex }) {
      const t = now();
      db.prepare('INSERT INTO narrative_plans(id,scope_key,author_id,series_id,book_id,kind,chapter_id,draft,draft_version,draft_hash,draft_status,revision_index,active_snapshot_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,NULL,?,?)')
        .run(id, scope.key, scope.authorId, scope.seriesId, scope.bookId, kind, chapterId, JSON.stringify(draft), draftHash, draftStatus, JSON.stringify(revisionIndex), t, t);
    },
    updateDraft(id, expectedVersion, { draft, draftHash, draftStatus, revisionIndex }) {
      const result = db.prepare('UPDATE narrative_plans SET draft=?,draft_hash=?,draft_status=?,revision_index=?,draft_version=draft_version+1,updated_at=? WHERE id=? AND draft_version=?')
        .run(JSON.stringify(draft), draftHash, draftStatus, JSON.stringify(revisionIndex), now(), id, expectedVersion);
      if (result.changes !== 1) throw new NarrativeError('Черновик плана изменился в другой вкладке. Ваш ввод сохранён в браузере; сравните его с серверной версией.', 'draft_conflict', 409);
    },
    setActiveSnapshot(id, snapshotId, expectedActive) {
      const result = db.prepare('UPDATE narrative_plans SET active_snapshot_id=?,draft_status=?,updated_at=? WHERE id=? AND active_snapshot_id IS ?').run(snapshotId, 'draft', now(), id, expectedActive);
      if (result.changes !== 1) throw new NarrativeError('Согласованная версия изменилась в другой вкладке.', 'approval_conflict', 409);
    },
    // Snapshots are immutable: no UPDATE statement exists for them.
    insertSnapshot({ planId, payload, bookSnapshotId = null }) {
      const version = (db.prepare('SELECT MAX(version) AS v FROM narrative_snapshots WHERE plan_id=?').get(planId).v ?? 0) + 1;
      const id = randomUUID(), hash = sha(canonicalJson(payload)), approvedAt = now();
      db.prepare('INSERT INTO narrative_snapshots(id,plan_id,version,hash,payload,book_snapshot_id,approved_by,approved_at) VALUES(?,?,?,?,?,?,?,?)').run(id, planId, version, hash, JSON.stringify(payload), bookSnapshotId, 'author', approvedAt);
      return { id, planId, version, hash, payload, bookSnapshotId, approvedBy: 'author', approvedAt };
    },
    snapshot: id => snapshotView(db.prepare('SELECT * FROM narrative_snapshots WHERE id=?').get(id)),
    snapshots: planId => db.prepare('SELECT id,plan_id,version,hash,book_snapshot_id,approved_by,approved_at,payload FROM narrative_snapshots WHERE plan_id=? ORDER BY version DESC').all(planId).map(snapshotView),
    // Chapters
    chapters: scope => db.prepare('SELECT * FROM narrative_chapters WHERE scope_key=? ORDER BY sort_order, created_at').all(scope.key).map(chapterView),
    chapter: (scope, chapterId) => chapterView(db.prepare('SELECT * FROM narrative_chapters WHERE scope_key=? AND chapter_id=?').get(scope.key, chapterId)),
    chapterBySource: (scope, identity) => chapterView(db.prepare('SELECT * FROM narrative_chapters WHERE scope_key=? AND source_identity=?').get(scope.key, identity)),
    chapterCount: scope => db.prepare('SELECT COUNT(*) AS n FROM narrative_chapters WHERE scope_key=?').get(scope.key).n,
    insertChapter(scope, { chapterId, title, order }) {
      const t = now();
      db.prepare('INSERT INTO narrative_chapters(chapter_id,scope_key,author_id,series_id,book_id,title,sort_order,archived,text_binding,source_identity,binding_version,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,NULL,NULL,0,1,?,?)')
        .run(chapterId, scope.key, scope.authorId, scope.seriesId, scope.bookId, title, order, t, t);
    },
    updateChapter(scope, chapterId, expectedVersion, { title, order, archived }) {
      const result = db.prepare('UPDATE narrative_chapters SET title=?,sort_order=?,archived=?,version=version+1,updated_at=? WHERE scope_key=? AND chapter_id=? AND version=?').run(title, order, archived ? 1 : 0, now(), scope.key, chapterId, expectedVersion);
      if (result.changes !== 1) throw new NarrativeError('Глава каркаса изменилась в другой вкладке.', 'chapter_conflict', 409);
    },
    bindChapter(scope, chapterId, expectedBindingVersion, binding, identity) {
      const result = db.prepare('UPDATE narrative_chapters SET text_binding=?,source_identity=?,binding_version=binding_version+1,updated_at=? WHERE scope_key=? AND chapter_id=? AND binding_version=?')
        .run(binding ? JSON.stringify(binding) : null, identity, now(), scope.key, chapterId, expectedBindingVersion);
      if (result.changes !== 1) throw new NarrativeError('Привязка главы изменилась в другой вкладке. Обновите каркас.', 'binding_conflict', 409);
    },
    // Progress: absence of a row means "not started".
    progress: (planId, stageId, revision) => progressView(db.prepare('SELECT * FROM narrative_progress WHERE plan_id=? AND stage_id=? AND content_revision=?').get(planId, stageId, revision)),
    progressForPlans: planIds => planIds.length ? db.prepare(`SELECT * FROM narrative_progress WHERE plan_id IN (${planIds.map(() => '?').join(',')})`).all(...planIds).map(progressView) : [],
    putProgress({ planId, stageId, contentRevision, state, decidedInSnapshotId, actor, decisionReason, evidenceIds, basis }, expectedVersion) {
      const current = db.prepare('SELECT version FROM narrative_progress WHERE plan_id=? AND stage_id=? AND content_revision=?').get(planId, stageId, contentRevision);
      if ((current?.version ?? 0) !== expectedVersion) throw new NarrativeError('Состояние этапа изменилось в другой вкладке. Обновите каркас и проверьте решение.', 'progress_conflict', 409);
      const values = [state, decidedInSnapshotId, actor, decisionReason ?? '', JSON.stringify(evidenceIds ?? []), JSON.stringify(basis ?? []), now()];
      if (current) db.prepare('UPDATE narrative_progress SET state=?,decided_in_snapshot_id=?,actor=?,decision_reason=?,evidence_ids=?,basis=?,version=version+1,updated_at=? WHERE plan_id=? AND stage_id=? AND content_revision=?').run(...values, planId, stageId, contentRevision);
      else db.prepare('INSERT INTO narrative_progress(state,decided_in_snapshot_id,actor,decision_reason,evidence_ids,basis,version,updated_at,plan_id,stage_id,content_revision) VALUES(?,?,?,?,?,?,1,?,?,?,?)').run(...values, planId, stageId, contentRevision);
      return progressView(db.prepare('SELECT * FROM narrative_progress WHERE plan_id=? AND stage_id=? AND content_revision=?').get(planId, stageId, contentRevision));
    },
    // Evidence
    insertEvidence(scope, row) {
      const id = randomUUID(), t = now();
      db.prepare('INSERT INTO narrative_evidence(id,scope_key,plan_id,stage_id,content_revision,chapter_id,source_identity,working_version,text_hash,quote,prefix,suffix,start_offset,end_offset,origin,proposal_id,retired_at,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)')
        .run(id, scope.key, row.planId, row.stageId, row.contentRevision, row.chapterId, row.sourceIdentity, row.workingVersion ?? null, row.textHash, row.quote, row.prefix, row.suffix, row.start, row.end, row.origin, row.proposalId ?? null, t, t);
      return evidenceView(db.prepare('SELECT * FROM narrative_evidence WHERE id=?').get(id));
    },
    evidence: (scope, id) => evidenceView(db.prepare('SELECT * FROM narrative_evidence WHERE scope_key=? AND id=?').get(scope.key, id)),
    evidenceList: scope => db.prepare('SELECT * FROM narrative_evidence WHERE scope_key=? ORDER BY created_at').all(scope.key).map(evidenceView),
    evidenceForStage: (planId, stageId, revision) => db.prepare('SELECT * FROM narrative_evidence WHERE plan_id=? AND stage_id=? AND content_revision=? AND retired_at IS NULL').all(planId, stageId, revision).map(evidenceView),
    reanchorEvidence(scope, id, expectedVersion, { workingVersion, textHash, prefix, suffix, start, end }) {
      const result = db.prepare('UPDATE narrative_evidence SET working_version=?,text_hash=?,prefix=?,suffix=?,start_offset=?,end_offset=?,version=version+1,updated_at=? WHERE scope_key=? AND id=? AND version=?').run(workingVersion ?? null, textHash, prefix, suffix, start, end, now(), scope.key, id, expectedVersion);
      if (result.changes !== 1) throw new NarrativeError('Фрагмент изменился в другой вкладке.', 'evidence_conflict', 409);
    },
    retireEvidence(scope, id) { db.prepare('UPDATE narrative_evidence SET retired_at=?,version=version+1,updated_at=? WHERE scope_key=? AND id=? AND retired_at IS NULL').run(now(), now(), scope.key, id); },
    // Proposals (agent channel; never closes anything on its own)
    insertProposal(scope, row) {
      const id = randomUUID();
      db.prepare('INSERT INTO narrative_proposals(id,scope_key,request_id,plan_id,snapshot_id,stage_id,content_revision,chapter_id,source_identity,text_hash,action,anchors,rationale,state,reason,call_ref,created_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
        .run(id, scope.key, row.requestId, row.planId, row.snapshotId, row.stageId, row.contentRevision, row.chapterId, row.sourceIdentity, row.textHash, 'close', JSON.stringify(row.anchors), row.rationale, row.state, row.reason ?? null, row.callRef ?? null, now());
      return proposalView(db.prepare('SELECT * FROM narrative_proposals WHERE id=?').get(id));
    },
    proposal: (scope, id) => proposalView(db.prepare('SELECT * FROM narrative_proposals WHERE scope_key=? AND id=?').get(scope.key, id)),
    proposals: scope => db.prepare('SELECT * FROM narrative_proposals WHERE scope_key=? ORDER BY created_at DESC LIMIT 200').all(scope.key).map(proposalView),
    setProposalState(scope, id, from, to, reason = null) {
      const result = db.prepare('UPDATE narrative_proposals SET state=?,reason=COALESCE(?,reason),decided_at=? WHERE scope_key=? AND id=? AND state=?').run(to, reason, now(), scope.key, id, from);
      if (result.changes !== 1) throw new NarrativeError('Предложение уже обработано или устарело.', 'proposal_conflict', 409);
    },
    // Agent requests: immutable manifest plus lifecycle; never reconstructed from chat text.
    insertRequest(scope, { requestId, mode, manifest }) {
      const t = now();
      db.prepare('INSERT INTO narrative_requests(request_id,scope_key,mode,manifest,status,status_reason,user_message_id,assistant_message_ids,accounting,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,?,NULL,?,?)').run(requestId, scope.key, mode, JSON.stringify(manifest), 'staged', '[]', t, t);
    },
    request: id => requestView(db.prepare('SELECT * FROM narrative_requests WHERE request_id=?').get(String(id))),
    requests: (scope, limit = 20) => db.prepare('SELECT * FROM narrative_requests WHERE scope_key=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(scope.key, limit).map(requestView),
    updateRequest(id, { status, statusReason, userMessageId, assistantMessageId, accounting } = {}) {
      const row = db.prepare('SELECT * FROM narrative_requests WHERE request_id=?').get(id); if (!row) return null;
      const ids = parse(row.assistant_message_ids, []); if (assistantMessageId && !ids.includes(assistantMessageId)) ids.push(assistantMessageId);
      db.prepare('UPDATE narrative_requests SET status=?,status_reason=?,user_message_id=?,assistant_message_ids=?,accounting=?,updated_at=? WHERE request_id=?')
        .run(status ?? row.status, statusReason === undefined ? row.status_reason : statusReason, userMessageId ?? row.user_message_id, JSON.stringify(ids), accounting === undefined ? row.accounting : JSON.stringify(accounting), now(), id);
      return requestView(db.prepare('SELECT * FROM narrative_requests WHERE request_id=?').get(id));
    },
    // Google creation receipts for new chapters; used to move a chapter binding from "new:<key>" to the created chapter.
    insertReceipt(scope, { operationId, bookId, documentId, newKeys, sentTitles, priorKeys }) {
      db.prepare('INSERT INTO narrative_receipts(operation_id,scope_key,book_id,document_id,new_keys,sent_titles,prior_keys,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING')
        .run(operationId, scope.key, bookId, documentId, JSON.stringify(newKeys), JSON.stringify(sentTitles), JSON.stringify(priorKeys), now());
    },
    receipt: (scope, operationId) => receiptView(db.prepare('SELECT * FROM narrative_receipts WHERE scope_key=? AND operation_id=?').get(scope.key, String(operationId))),
    receipts: scope => db.prepare('SELECT * FROM narrative_receipts WHERE scope_key=? ORDER BY created_at DESC LIMIT 200').all(scope.key).map(receiptView),
    prefs: scope => { const row = db.prepare('SELECT * FROM narrative_prefs WHERE scope_key=?').get(scope.key); return { strict: !!row?.strict, version: row?.version ?? 0 }; },
    setPrefs(scope, expectedVersion, { strict }) {
      const current = db.prepare('SELECT version FROM narrative_prefs WHERE scope_key=?').get(scope.key);
      if ((current?.version ?? 0) !== expectedVersion) throw new NarrativeError('Настройки каркаса изменились в другой вкладке.', 'prefs_conflict', 409);
      db.prepare('INSERT INTO narrative_prefs(scope_key,strict,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(scope_key) DO UPDATE SET strict=excluded.strict,version=narrative_prefs.version+1,updated_at=excluded.updated_at').run(scope.key, strict ? 1 : 0, now());
    },
    events: (scope, limit = 50) => db.prepare('SELECT * FROM narrative_events WHERE scope_key=? ORDER BY seq DESC LIMIT ?').all(scope.key, limit).map(row => ({ seq: row.seq, operationId: row.operation_id, action: row.action, before: parse(row.before), after: parse(row.after), actor: row.actor, createdAt: row.created_at })),
    exportData: () => ({
      schema: NARRATIVE_SCHEMA_VERSION,
      plans: db.prepare('SELECT * FROM narrative_plans ORDER BY created_at').all().map(planView),
      snapshots: db.prepare('SELECT * FROM narrative_snapshots ORDER BY plan_id, version').all().map(snapshotView),
      chapters: db.prepare('SELECT * FROM narrative_chapters ORDER BY scope_key, sort_order').all().map(chapterView),
      progress: db.prepare('SELECT * FROM narrative_progress').all().map(progressView),
      evidence: db.prepare('SELECT * FROM narrative_evidence ORDER BY created_at').all().map(evidenceView),
      proposals: db.prepare('SELECT * FROM narrative_proposals ORDER BY created_at').all().map(proposalView),
      events: db.prepare('SELECT * FROM narrative_events ORDER BY seq').all().map(row => ({ seq: row.seq, scopeKey: row.scope_key, operationId: row.operation_id, action: row.action, before: parse(row.before), after: parse(row.after), actor: row.actor, createdAt: row.created_at })),
      requests: db.prepare('SELECT * FROM narrative_requests ORDER BY created_at').all().map(row => ({ ...requestView(row), scopeKey: row.scope_key })),
      receipts: db.prepare('SELECT * FROM narrative_receipts ORDER BY created_at').all().map(receiptView),
    }),
  };
}
