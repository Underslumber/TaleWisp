import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scopeKey } from './workspace-scope.mjs';

const MAX_TEXT = 2_000_000;
const now = () => new Date().toISOString();
const cleanText = (value, name = 'text') => {
  if (typeof value !== 'string') throw new TypeError(`${name} must be text`);
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT) throw new RangeError(`${name} is too large`);
  return value;
};

// App-owned project overlay: names, hierarchy and companion files of books.
// It shares the database with drafts/notes/messages so a relink moves scoped rows in
// the same transaction. Vault files are never written from here.
const projectTuple = value => [value?.[0] ?? null, value?.[1] ?? null, value?.[2] ?? null];
const sameTuple = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const tupleKey = value => scopeKey({ authorId: value[0], seriesId: value[1], bookId: value[2] });
const projectConflict = message => Object.assign(new Error(message), { status: 409, code: 'project_conflict' });
const STORYART_JOURNAL = 'storyart.partnerJournal.v1';

function createProjectStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_entities (
      kind TEXT NOT NULL CHECK(kind IN ('author','series','book')), id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('vault','logical')), name TEXT, parent_id TEXT,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, migration_id TEXT,
      PRIMARY KEY(kind,id)
    );
    CREATE TABLE IF NOT EXISTS project_attachments (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('google-doc','vault-book','vault-file')),
      display_name TEXT, google_document_id TEXT, source_ref TEXT, legacy_book_id TEXT,
      origin TEXT NOT NULL CHECK(origin IN ('implicit','author','migration')),
      archived_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, migration_id TEXT
    );
    CREATE INDEX IF NOT EXISTS project_attachments_book ON project_attachments(book_id);
    CREATE TABLE IF NOT EXISTS project_aliases (
      legacy_book_id TEXT PRIMARY KEY, legacy_author_id TEXT NOT NULL, legacy_series_id TEXT NOT NULL,
      book_id TEXT NOT NULL, migration_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_migrations (
      id TEXT PRIMARY KEY, map_hash TEXT NOT NULL, applied_at TEXT NOT NULL, summary TEXT NOT NULL, rolled_back_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_moves (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, migration_id TEXT, change_id TEXT NOT NULL, table_name TEXT NOT NULL,
      row_ids TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_changes (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_delegation_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL, source_key TEXT NOT NULL, setting_value TEXT NOT NULL,
      change_id TEXT NOT NULL, migration_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_delegation_archive_target ON project_delegation_archive(target_key);`);

  const revision = () => Number(db.prepare("SELECT value FROM project_meta WHERE key='revision'").get()?.value ?? 0);
  const bump = () => { const next = revision() + 1; db.prepare("INSERT INTO project_meta(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next)); return next; };
  const entityView = row => ({ kind: row.kind, id: row.id, origin: row.origin, name: row.name ?? null, parentId: row.parent_id ?? null, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, migrationId: row.migration_id ?? null });
  const attachmentView = row => ({ id: row.id, bookId: row.book_id, kind: row.kind, displayName: row.display_name ?? null, googleDocumentId: row.google_document_id ?? null, sourceRef: row.source_ref ?? null, legacyBookId: row.legacy_book_id ?? null, origin: row.origin, archivedAt: row.archived_at ?? null, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, migrationId: row.migration_id ?? null });
  const aliasView = row => ({ legacyBookId: row.legacy_book_id, legacyAuthorId: row.legacy_author_id, legacySeriesId: row.legacy_series_id, bookId: row.book_id, migrationId: row.migration_id ?? null, createdAt: row.created_at });
  const archiveView = row => { let rows = null; try { rows = JSON.parse(row.setting_value); } catch {} return { id: row.id, targetScopeKey: row.target_key, sourceScopeKey: row.source_key, rows: Array.isArray(rows) ? rows : [], raw: Array.isArray(rows) ? null : row.setting_value, changeId: row.change_id, migrationId: row.migration_id ?? null, movedAt: row.created_at }; };
  const migrationView = row => ({ id: row.id, mapHash: row.map_hash, appliedAt: row.applied_at, summary: JSON.parse(row.summary), rolledBackAt: row.rolled_back_at ?? null });

  const snapshot = () => ({
    revision: revision(),
    entities: db.prepare('SELECT * FROM project_entities ORDER BY created_at, id').all().map(entityView),
    attachments: db.prepare('SELECT * FROM project_attachments ORDER BY created_at, id').all().map(attachmentView),
    aliases: db.prepare('SELECT * FROM project_aliases ORDER BY created_at, legacy_book_id').all().map(aliasView),
  });

  const putEntity = ({ kind, id, origin, name = null, parentId = null, migrationId = null }) => {
    const timestamp = now();
    db.prepare(`INSERT INTO project_entities(kind,id,origin,name,parent_id,version,created_at,updated_at,migration_id) VALUES(?,?,?,?,?,1,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET origin=excluded.origin,name=excluded.name,parent_id=excluded.parent_id,version=project_entities.version+1,updated_at=excluded.updated_at,migration_id=COALESCE(excluded.migration_id,project_entities.migration_id)`)
      .run(kind, id, origin, name, parentId, timestamp, timestamp, migrationId);
  };
  const putAttachment = row => {
    const timestamp = now();
    db.prepare(`INSERT INTO project_attachments(id,book_id,kind,display_name,google_document_id,source_ref,legacy_book_id,origin,archived_at,version,created_at,updated_at,migration_id) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET book_id=excluded.book_id,display_name=excluded.display_name,archived_at=excluded.archived_at,version=project_attachments.version+1,updated_at=excluded.updated_at`)
      .run(row.id, row.bookId, row.kind, row.displayName ?? null, row.googleDocumentId ?? null, row.sourceRef ?? null, row.legacyBookId ?? null, row.origin, row.archivedAt ?? null, timestamp, timestamp, row.migrationId ?? null);
  };
  const recordMove = (changeId, migrationId, table, ids, before, after) => {
    if (!ids.length) return;
    db.prepare('INSERT INTO project_moves(migration_id,change_id,table_name,row_ids,before,after,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(migrationId, changeId, table, JSON.stringify(ids), JSON.stringify(before), JSON.stringify(after), now());
  };

  // Moves every app row owned by one exact (author, series, book) scope to another scope.
  const moveScope = (fromValue, toValue, changeId, migrationId = null) => {
    const from = projectTuple(fromValue), to = projectTuple(toValue), counts = { documents: 0, notes: 0, messages: 0, proposals: 0, delegations: 0, storyart: 0 };
    if (sameTuple(from, to)) return counts;
    for (const table of ['documents', 'notes']) {
      const ids = db.prepare(`SELECT id FROM ${table} WHERE author_id IS ? AND series_id IS ? AND book_id IS ?`).all(...from).map(row => row.id);
      const update = db.prepare(`UPDATE ${table} SET author_id=?,series_id=?,book_id=? WHERE id=?`);
      for (const id of ids) update.run(...to, id);
      recordMove(changeId, migrationId, table, ids, from, to); counts[table] = ids.length;
    }
    const messageIds = db.prepare('SELECT id FROM messages WHERE scope_key=?').all(tupleKey(from)).map(row => row.id);
    const updateMessage = db.prepare('UPDATE messages SET scope_key=? WHERE id=?');
    for (const id of messageIds) updateMessage.run(tupleKey(to), id);
    recordMove(changeId, migrationId, 'messages', messageIds, from, to); counts.messages = messageIds.length;
    const proposalIds = [];
    for (const row of db.prepare('SELECT id,payload FROM workspace_proposals').all()) {
      let payload; try { payload = JSON.parse(row.payload); } catch { continue; }
      if (!sameTuple([payload.authorId ?? null, payload.seriesId ?? null, payload.bookId ?? null], from)) continue;
      payload.authorId = to[0]; payload.seriesId = to[1]; payload.bookId = to[2];
      db.prepare('UPDATE workspace_proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id); proposalIds.push(row.id);
    }
    recordMove(changeId, migrationId, 'workspace_proposals', proposalIds, from, to); counts.proposals = proposalIds.length;
    // Delegation logs are capped to 20 rows on every write, so merging two logs would silently drop rows.
    // An empty target takes the log over; otherwise the source log is kept verbatim in the archive of the target scope.
    const fromSetting = 'agent.delegations.' + tupleKey(from), toSetting = 'agent.delegations.' + tupleKey(to);
    const sourceLog = db.prepare('SELECT value FROM settings WHERE key=?').get(fromSetting)?.value;
    if (sourceLog !== undefined) {
      if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(toSetting)) {
        db.prepare('UPDATE settings SET key=? WHERE key=?').run(toSetting, fromSetting);
        recordMove(changeId, migrationId, 'settings', [fromSetting], from, to);
      } else {
        const archived = db.prepare('INSERT INTO project_delegation_archive(target_key,source_key,setting_value,change_id,migration_id,created_at) VALUES(?,?,?,?,?,?)').run(tupleKey(to), tupleKey(from), sourceLog, changeId, migrationId, now());
        db.prepare('DELETE FROM settings WHERE key=?').run(fromSetting);
        recordMove(changeId, migrationId, 'delegation-archive', [Number(archived.lastInsertRowid)], from, to);
      }
      counts.delegations = 1;
    }
    // Logs archived earlier under the moved scope follow it.
    const chained = db.prepare('SELECT id FROM project_delegation_archive WHERE target_key=?').all(tupleKey(from)).map(row => row.id);
    if (chained.length) { db.prepare('UPDATE project_delegation_archive SET target_key=? WHERE target_key=?').run(tupleKey(to), tupleKey(from)); recordMove(changeId, migrationId, 'delegation-archive-target', chained, from, to); }
    // StoryArt pairings are owned by the exact workspace scope key; they follow the moved scope.
    const journalRaw = db.prepare('SELECT value FROM settings WHERE key=?').get(STORYART_JOURNAL)?.value;
    if (journalRaw !== undefined && journalRaw.trim()) {
      let journal; try { journal = JSON.parse(journalRaw); } catch { journal = null; }
      if (!journal || journal.version !== 1 || !journal.requests || typeof journal.requests !== 'object') throw projectConflict('Журнал StoryArt не читается; связи не изменены, чтобы не потерять владельца заданий.');
      const requestIds = Object.entries(journal.requests).filter(([, request]) => request?.scope === tupleKey(from)).map(([id]) => id);
      if (requestIds.length) {
        for (const id of requestIds) journal.requests[id].scope = tupleKey(to);
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(journal), STORYART_JOURNAL);
        recordMove(changeId, migrationId, 'storyart', requestIds, from, to);
      }
      counts.storyart = requestIds.length;
    }
    let current = null; try { current = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='workspace.selection'").get()?.value || 'null'); } catch {}
    if (current && sameTuple([current.authorId ?? null, current.seriesId ?? null, current.bookId ?? null], from)) {
      db.prepare("UPDATE settings SET value=? WHERE key='workspace.selection'").run(JSON.stringify({ authorId: to[0], seriesId: to[1], bookId: to[2] }));
      recordMove(changeId, migrationId, 'selection', ['workspace.selection'], from, to);
    }
    return counts;
  };

  // Reverses the scope moves of one migration; rows edited elsewhere since then are left where they are.
  const undoMoves = migrationId => {
    for (const move of db.prepare('SELECT * FROM project_moves WHERE migration_id=? ORDER BY seq DESC').all(migrationId)) {
      const ids = JSON.parse(move.row_ids), before = JSON.parse(move.before), after = JSON.parse(move.after);
      if (move.table_name === 'documents' || move.table_name === 'notes') {
        const update = db.prepare(`UPDATE ${move.table_name} SET author_id=?,series_id=?,book_id=? WHERE id=? AND author_id IS ? AND series_id IS ? AND book_id IS ?`);
        for (const id of ids) update.run(...before, id, ...after);
      } else if (move.table_name === 'messages') {
        const update = db.prepare('UPDATE messages SET scope_key=? WHERE id=? AND scope_key=?');
        for (const id of ids) update.run(tupleKey(before), id, tupleKey(after));
      } else if (move.table_name === 'workspace_proposals') {
        for (const id of ids) {
          const row = db.prepare('SELECT payload FROM workspace_proposals WHERE id=?').get(id); if (!row) continue;
          const payload = JSON.parse(row.payload);
          if (!sameTuple([payload.authorId ?? null, payload.seriesId ?? null, payload.bookId ?? null], after)) continue;
          payload.authorId = before[0]; payload.seriesId = before[1]; payload.bookId = before[2];
          db.prepare('UPDATE workspace_proposals SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
        }
      } else if (move.table_name === 'settings') {
        const target = 'agent.delegations.' + tupleKey(after), original = 'agent.delegations.' + tupleKey(before);
        if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(original)) db.prepare('UPDATE settings SET key=? WHERE key=?').run(original, target);
      } else if (move.table_name === 'delegation-archive') {
        const original = 'agent.delegations.' + tupleKey(before);
        for (const id of ids) {
          const row = db.prepare('SELECT * FROM project_delegation_archive WHERE id=?').get(id); if (!row) continue;
          if (db.prepare('SELECT 1 FROM settings WHERE key=?').get(original)) continue; // a newer log took the key; keep the archived copy reachable
          db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(original, row.setting_value);
          db.prepare('DELETE FROM project_delegation_archive WHERE id=?').run(id);
        }
      } else if (move.table_name === 'delegation-archive-target') {
        const update = db.prepare('UPDATE project_delegation_archive SET target_key=? WHERE id=? AND target_key=?');
        for (const id of ids) update.run(tupleKey(before), id, tupleKey(after));
      } else if (move.table_name === 'storyart') {
        const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(STORYART_JOURNAL)?.value;
        let journal = null; try { journal = JSON.parse(raw || 'null'); } catch {}
        if (!journal?.requests) continue;
        for (const id of ids) if (journal.requests[id]?.scope === tupleKey(after)) journal.requests[id].scope = tupleKey(before);
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(journal), STORYART_JOURNAL);
      } else if (move.table_name === 'selection') {
        let current = null; try { current = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='workspace.selection'").get()?.value || 'null'); } catch {}
        if (current && sameTuple([current.authorId ?? null, current.seriesId ?? null, current.bookId ?? null], after)) db.prepare("UPDATE settings SET value=? WHERE key='workspace.selection'").run(JSON.stringify({ authorId: before[0], seriesId: before[1], bookId: before[2] }));
      }
    }
  };

  // Runs a validated write plan atomically. `expectedRevision` protects against concurrent edits.
  const commit = ({ expectedRevision, action, payload = {}, write }) => tx(() => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision()) throw projectConflict('Настройки проекта изменились в другом окне. Обновите экран и повторите.');
    const changeId = randomUUID();
    const result = write({ changeId, putEntity, putAttachment, moveScope, db });
    const next = bump();
    db.prepare('INSERT INTO project_changes(id,revision,action,payload,created_at) VALUES(?,?,?,?,?)').run(changeId, next, action, JSON.stringify(payload), now());
    return { revision: next, changeId, result };
  });

  return {
    revision, snapshot, commit, undoMoves, tx,
    countScope: value => {
      const scope = projectTuple(value);
      const proposals = db.prepare('SELECT payload FROM workspace_proposals').all().filter(row => { try { const p = JSON.parse(row.payload); return sameTuple([p.authorId ?? null, p.seriesId ?? null, p.bookId ?? null], scope); } catch { return false; } }).length;
      return {
        documents: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE author_id IS ? AND series_id IS ? AND book_id IS ?').get(...scope).n,
        notes: db.prepare('SELECT COUNT(*) AS n FROM notes WHERE author_id IS ? AND series_id IS ? AND book_id IS ?').get(...scope).n,
        messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE scope_key=?').get(tupleKey(scope)).n,
        proposals,
        delegationRows: (() => { try { const rows = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('agent.delegations.' + tupleKey(scope))?.value || '[]'); return Array.isArray(rows) ? rows.length : 0; } catch { return 0; } })(),
        storyart: (() => { try { const journal = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(STORYART_JOURNAL)?.value || 'null'); return Object.values(journal?.requests ?? {}).filter(request => request?.scope === tupleKey(scope)).length; } catch { return 0; } })(),
      };
    },
    // Full, uncapped delegation logs that were moved into this scope next to an existing log.
    movedDelegationHistory: key => db.prepare('SELECT * FROM project_delegation_archive WHERE target_key=? ORDER BY id').all(String(key)).map(archiveView),
    migrations: () => db.prepare('SELECT * FROM project_migrations ORDER BY applied_at').all().map(migrationView),
    activeMigration: mapHash => { const row = db.prepare('SELECT * FROM project_migrations WHERE map_hash=? AND rolled_back_at IS NULL').get(mapHash); return row ? migrationView(row) : null; },
    migrationById: id => { const row = db.prepare('SELECT * FROM project_migrations WHERE id=?').get(id); return row ? migrationView(row) : null; },
    exportData: () => ({
      ...snapshot(),
      migrations: db.prepare('SELECT * FROM project_migrations ORDER BY applied_at').all().map(migrationView),
      moves: db.prepare('SELECT * FROM project_moves ORDER BY seq').all().map(row => ({ migrationId: row.migration_id ?? null, changeId: row.change_id, table: row.table_name, rowIds: JSON.parse(row.row_ids), before: JSON.parse(row.before), after: JSON.parse(row.after), createdAt: row.created_at })),
      changes: db.prepare('SELECT * FROM project_changes ORDER BY revision').all().map(row => ({ id: row.id, revision: row.revision, action: row.action, payload: JSON.parse(row.payload), createdAt: row.created_at })),
      delegationArchive: db.prepare('SELECT * FROM project_delegation_archive ORDER BY id').all().map(archiveView),
    }),
  };
}

export function openStore(dataDir) {
  const filename = resolve(dataDir, 'talewisp-web.sqlite');
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_history (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      title TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_history_order ON document_history(document_id, version DESC);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, document_id TEXT,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  const addColumn = (table, name, definition) => {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn('documents', 'author_id', 'TEXT'); addColumn('documents', 'series_id', 'TEXT'); addColumn('documents', 'book_id', 'TEXT');
  addColumn('documents', 'status', "TEXT NOT NULL DEFAULT 'draft'"); addColumn('documents', 'target_words', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('notes', 'author_id', 'TEXT'); addColumn('notes', 'series_id', 'TEXT'); addColumn('notes', 'book_id', 'TEXT'); addColumn('notes', 'status', "TEXT NOT NULL DEFAULT 'draft'");
  addColumn('messages', 'scope_key', "TEXT NOT NULL DEFAULT 'unassigned'");
  db.exec('CREATE TABLE IF NOT EXISTS workspace_proposals (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');

  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const bindingFrom = value => Array.isArray(value) && value.length === 3
    ? value.map(item=>item??null)
    : value && typeof value==='object' && !Array.isArray(value)
      ? [value.authorId??null,value.seriesId??null,value.bookId??null]
      : null;
  const docView = row => row && ({ id: row.id, title: row.title, text: row.text, version: row.version, updatedAt: row.updated_at, authorId:row.author_id??null, seriesId:row.series_id??null, bookId:row.book_id??null, status:row.status??'draft', targetWords:row.target_words??0 });
  const noteView = row => row && ({ id: row.id, title: row.title, text: row.text, documentId: row.document_id, version: row.version, updatedAt: row.updated_at, authorId:row.author_id??null, seriesId:row.series_id??null, bookId:row.book_id??null, status:row.status??'draft' });
  const saveHistory = row => db.prepare('INSERT INTO document_history(id,document_id,title,text,version,created_at) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), row.id, row.title, row.text, row.version, now());
  const project = createProjectStore({ db, tx });

  return {
    filename,
    project,
    close() { db.close(); },
    listDocuments() { return db.prepare('SELECT * FROM documents ORDER BY updated_at DESC').all().map(docView); },
    getDocument(id) { return docView(db.prepare('SELECT * FROM documents WHERE id=?').get(id)); },
    bindDocument(id,{authorId,seriesId,bookId,version}) {
      if(typeof authorId!=='string'||typeof seriesId!=='string'||typeof bookId!=='string'||!Number.isSafeInteger(version)||version<1)throw new TypeError('A complete workspace binding and version are required');
      const row=db.prepare('SELECT * FROM documents WHERE id=?').get(id);if(!row)return null;if(row.version!==version)return {conflict:true,document:docView(row)};
      const updatedAt=now();db.prepare('UPDATE documents SET author_id=?,series_id=?,book_id=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(authorId,seriesId,bookId,updatedAt,id,version);return {document:this.getDocument(id)};
    },
    createDocument({ title, text, authorId=null, seriesId=null, bookId=null, status='draft', targetWords=0 }) {
      title = cleanText(title, 'title').trim() || 'Без названия'; text = cleanText(text);
      if(typeof status!=='string'||!status.trim())throw new TypeError('status must be text');
      if(!Number.isSafeInteger(targetWords)||targetWords<0)throw new TypeError('targetWords must be a non-negative integer');
      const id = randomUUID(), timestamp = now();
      db.prepare('INSERT INTO documents(id,title,text,version,updated_at,author_id,series_id,book_id,status,target_words) VALUES(?,?,?,1,?,?,?,?,?,?)').run(id,title,text,timestamp,authorId,seriesId,bookId,status,targetWords);
      const row = { id,title,text,version:1,updated_at:timestamp,author_id:authorId,series_id:seriesId,book_id:bookId,status,target_words:targetWords }; saveHistory(row); return docView(row);
    },
    updateDocument(id, { title, text, version, status, targetWords }) {
      title = cleanText(title, 'title').trim() || 'Без названия'; text = cleanText(text);
      if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('version is required');
      if(status!==undefined&&(typeof status!=='string'||!status.trim()))throw new TypeError('status must be text');
      if(targetWords!==undefined&&(!Number.isSafeInteger(targetWords)||targetWords<0))throw new TypeError('targetWords must be a non-negative integer');
      return tx(() => {
        const current = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
        if (!current) return null;
        if (current.version !== version) return { conflict: true, document: docView(current) };
        const updatedAt = now();
        db.prepare('UPDATE documents SET title=?,text=?,status=?,target_words=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(title,text,status??current.status,targetWords??current.target_words,updatedAt,id,version);
        const row = db.prepare('SELECT * FROM documents WHERE id=?').get(id); saveHistory(row); return { document: docView(row) };
      });
    },
    documentHistory(id) { return db.prepare('SELECT id,title,text,version,created_at FROM document_history WHERE document_id=? ORDER BY version DESC').all(id).map(r=>({id:r.id,title:r.title,text:r.text,version:r.version,createdAt:r.created_at})); },
    restoreDocument(id, historyId, version) {
      return tx(() => {
        const current = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
        if (!current) return null;
        if (current.version !== version) return { conflict:true,document:docView(current) };
        const old = db.prepare('SELECT * FROM document_history WHERE id=? AND document_id=?').get(historyId,id);
        if (!old) return { missing:true };
        const timestamp=now(); db.prepare('UPDATE documents SET title=?,text=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(old.title,old.text,timestamp,id,version);
        const row=db.prepare('SELECT * FROM documents WHERE id=?').get(id); saveHistory(row); return {document:docView(row)};
      });
    },
    listNotes() { return db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all().map(noteView); },
    getNote(id) { return noteView(db.prepare('SELECT * FROM notes WHERE id=?').get(id)); },
    createNote({title,text,documentId=null,authorId=null,seriesId=null,bookId=null,status='draft'}) {
      title=cleanText(title,'title').trim()||'Заметка'; text=cleanText(text); const id=randomUUID(),updatedAt=now();
      if(typeof status!=='string'||!status.trim())throw new TypeError('status must be text');
      db.prepare('INSERT INTO notes(id,title,text,document_id,version,updated_at,author_id,series_id,book_id,status) VALUES(?,?,?, ?,1,?,?,?,?,?)').run(id,title,text,documentId,updatedAt,authorId,seriesId,bookId,status);
      return noteView({id,title,text,document_id:documentId,version:1,updated_at:updatedAt,author_id:authorId,series_id:seriesId,book_id:bookId,status});
    },
    updateNote(id,{title,text,documentId=null,version,status}) {
      title=cleanText(title,'title').trim()||'Заметка'; text=cleanText(text); if(!Number.isSafeInteger(version)||version<1) throw new TypeError('version is required');
      if(status!==undefined&&(typeof status!=='string'||!status.trim()))throw new TypeError('status must be text');
      const current=db.prepare('SELECT * FROM notes WHERE id=?').get(id); if(!current)return null; if(current.version!==version)return {conflict:true,note:noteView(current)};
      const updatedAt=now(); const result=db.prepare('UPDATE notes SET title=?,text=?,document_id=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(title,text,documentId,status??current.status,updatedAt,id,version);
      if(result.changes!==1)return {conflict:true,note:this.getNote(id)}; return {note:this.getNote(id)};
    },
    setMessageScope(scopeKey) {
      if(typeof scopeKey!=='string'||!scopeKey)throw new TypeError('A message scope key is required');
      let desired=scopeKey, desiredBinding=null;
      try { const parsed=JSON.parse(scopeKey);desiredBinding=bindingFrom(parsed);if(desiredBinding)desired=JSON.stringify(desiredBinding); } catch {}
      if(desiredBinding){
        tx(()=>{
          const legacy=db.prepare('SELECT DISTINCT scope_key FROM messages WHERE scope_key<>?').all(desired);
          for(const {scope_key:oldKey} of legacy){
            let oldBinding=null;try{const parsed=JSON.parse(oldKey);if(!Array.isArray(parsed))oldBinding=bindingFrom(parsed);}catch{}
            if(oldBinding&&JSON.stringify(oldBinding)===desired)db.prepare('UPDATE messages SET scope_key=? WHERE scope_key=?').run(desired,oldKey);
          }
        });
      }
      this.messageScopeKey=desired;
    },
    addMessage(role,text,scopeKey=this.messageScopeKey??'unassigned') {
      if(!['user','assistant','system'].includes(role)) throw new TypeError('Invalid message role');
      text=cleanText(text); const row={id:randomUUID(),role,text,createdAt:now(),scopeKey}; db.prepare('INSERT INTO messages(id,role,text,created_at,scope_key) VALUES(?,?,?,?,?)').run(row.id,row.role,row.text,row.createdAt,scopeKey); return row;
    },
    moveMessageScope(fromScope,toScope) {
      if(typeof fromScope!=='string'||!fromScope||typeof toScope!=='string'||!toScope||fromScope===toScope)throw new TypeError('Distinct message scopes are required');
      return tx(()=>{
        const sourceKey='agent.delegations.'+fromScope, targetKey='agent.delegations.'+toScope;
        const source=db.prepare('SELECT value FROM settings WHERE key=?').get(sourceKey);
        if(source) {
          const target=db.prepare('SELECT value FROM settings WHERE key=?').get(targetKey);
          let value=source.value;
          if(target) {
            const parse=raw=>{const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.id!=='string'))throw new Error('Saved delegation history is invalid; migration was not applied.');return rows;};
            const merged=new Map();
            for(const row of [...parse(source.value),...parse(target.value)]){merged.delete(row.id);merged.set(row.id,row);}
            value=JSON.stringify([...merged.values()]);
          }
          db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(targetKey,value);
          db.prepare('DELETE FROM settings WHERE key=?').run(sourceKey);
        }
        return db.prepare('UPDATE messages SET scope_key=? WHERE scope_key=?').run(toScope,fromScope).changes;
      });
    },
    listMessages(limit=100,scopeKey=this.messageScopeKey??'unassigned') { return db.prepare('SELECT role,text,created_at FROM messages WHERE scope_key=? ORDER BY rowid DESC LIMIT ?').all(scopeKey,limit).reverse().map(r=>({role:r.role,text:r.text,createdAt:r.created_at})); },
    getSetting(key) { const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row?.value ?? null; },
    setSetting(key,value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); },
    saveWorkspaceProposal(proposal) { const payload=JSON.stringify(proposal); db.prepare('INSERT INTO workspace_proposals(id,state,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at').run(proposal.id,proposal.state,payload,now()); return proposal; },
    getWorkspaceProposal(id) { return db.prepare('SELECT id,state,payload,updated_at FROM workspace_proposals WHERE id=?').get(id)??null; },
    listWorkspaceProposals() { return db.prepare('SELECT id,state,payload,updated_at FROM workspace_proposals ORDER BY updated_at DESC').all(); },
    exportData() { return {version:1,exportedAt:now(),documents:db.prepare('SELECT * FROM documents ORDER BY updated_at').all().map(docView),notes:db.prepare('SELECT * FROM notes ORDER BY updated_at').all().map(noteView),history:db.prepare('SELECT document_id AS documentId,title,text,version,created_at AS createdAt FROM document_history ORDER BY created_at').all(),messages:db.prepare('SELECT role,text,created_at AS createdAt,scope_key AS scopeKey FROM messages ORDER BY rowid').all(),project:project.exportData()}; },
  };
}
