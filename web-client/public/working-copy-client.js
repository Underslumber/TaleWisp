// Ordered file saves per exact manuscript. A conflict/unknown reply stops writes;
// a subsequent edit must not silently adopt a newer file version.
import { mergeWorkingChapter } from './manuscript-model.js';
export function createWorkingCopyClient({ api, onStatus }) {
  const records = new Map();
  const keyOf = scope => JSON.stringify([scope.bookId, scope.documentId]);
  function record(scope) {
    const key = keyOf(scope);
    if (!records.has(key)) records.set(key, { scope: { ...scope }, ready: false, version: 0, status: 'idle', pending: new Map(), latest: new Map(), retired: new Map(), running: null, error: '' });
    return records.get(key);
  }
  const emit = r => onStatus?.(r.scope, { ready: r.ready, version: r.version, status: r.status, error: r.error });
  async function read(scope) {
    const r = record(scope);
    if (r.importWait) await r.importWait;
    if (r.running) await r.running;
    const result = await api('/api/manuscript/working/read', { method: 'POST', body: scope });
    r.version = result.copy?.version ?? 0; r.ready = !!result.copy; r.status = r.ready ? 'saved' : 'missing'; r.error = ''; r.pending.clear(); r.retired.clear(); emit(r);
    r.latest = new Map((result.copy?.chapters ?? []).map(x => [x.key, structuredClone(x)]));
    return result.copy;
  }
  async function importDocument(scope) {
    const r = record(scope);
    if (r.importing) throw new Error('Импорт рабочего файла уже выполняется.');
    await flush(scope);
    if (r.status === 'error') throw new Error(r.error);
    const sent = new Map([...r.latest].map(([key, item]) => [key, structuredClone(item)]));
    r.importing = true;
    let imported;
    r.importWait = new Promise(resolve => { imported = resolve; });
    try {
      const result = await api('/api/manuscript/working/import', { method: 'POST', body: { ...scope, version: r.version } });
      for (const item of result.copy.chapters ?? []) {
        if (r.pending.has(item.key)) r.pending.set(item.key, mergeWorkingChapter(r.pending.get(item.key), item, sent.get(item.key)));
        r.latest.set(item.key, r.pending.get(item.key) ?? structuredClone(item));
      }
      r.version = result.copy.version; r.ready = true; r.status = 'saved'; r.error = ''; emit(r);
      return result.copy;
    } catch (e) { r.status = 'error'; r.error = e.message; emit(r); throw e; }
    finally { r.importing = false; imported(); r.importWait = null; start(r); }
  }
  function queue(scope, chapters) {
    const r = record(scope);
    if (!r.ready) return;
    for (const item of chapters) {
      if (JSON.stringify(r.latest.get(item.key)) === JSON.stringify(item)) continue;
      r.pending.set(item.key, structuredClone(item)); r.latest.set(item.key, structuredClone(item));
    }
    if (r.status !== 'error') start(r);
  }
  function start(r) {
    if (r.running || r.importing || (!r.pending.size && !r.retired.size) || r.status === 'error') return;
    r.running = (async () => {
      while ((r.pending.size || r.retired.size) && r.status !== 'error') {
        const chapters = [...r.pending.values()], retired = [...r.retired].map(([key, operationId]) => ({ key, operationId })); r.pending.clear(); r.retired.clear(); r.status = 'saving'; emit(r);
        try {
          const result = await api('/api/manuscript/working/save', { method: 'POST', body: { ...r.scope, version: r.version, chapters, retired } });
          r.version = result.copy.version; r.status = 'saved'; r.error = ''; emit(r);
        } catch (e) {
          for (const item of chapters) if (!r.pending.has(item.key)) r.pending.set(item.key, item);
          for (const item of retired) r.retired.set(item.key, item.operationId);
          r.status = 'error'; r.error = e.message; emit(r);
        }
      }
    })().finally(() => { r.running = null; });
  }
  async function flush(scope) {
    const r = record(scope);
    if (r.importWait) await r.importWait;
    start(r);
    while (r.running) await r.running;
    if (r.status === 'error') throw new Error(r.error);
  }
  const state = scope => { const r = record(scope); return { ready: r.ready, version: r.version, status: r.status, error: r.error }; };
  function conflict(scope, message) { const r = record(scope); r.status = 'error'; r.error = message; emit(r); }
  function retire(scope, items) { const r = record(scope); if (!r.ready) return; for (const item of items) { r.pending.delete(item.key); r.retired.set(item.key, item.operationId); } start(r); }
  // Explicit author recovery: re-read the current CAS version, show exact file/browser
  // differences, then write the approved snapshot. It never replaces the editor text.
  async function recover(scope, getChapters, confirm) {
    const r = record(scope);
    if (r.importWait) await r.importWait;
    if (r.running) await r.running;
    const remote = await api('/api/manuscript/working/read', { method: 'POST', body: scope });
    if (!remote.copy) throw new Error('Рабочий файл не найден. Импортируйте рукопись заново.');
    const local = new Map(r.pending);
    for (const item of getChapters()) local.set(item.key, item);
    const chapters = structuredClone([...local.values()]);
    if (!await confirm(remote.copy, chapters)) return false;
    try {
      const result = await api('/api/manuscript/working/save', { method: 'POST', body: { ...scope, version: remote.copy.version, chapters, retired: [] } });
      r.version = result.copy.version; r.ready = true; r.status = 'saved'; r.error = '';
      for (const item of chapters) {
        if (JSON.stringify(r.pending.get(item.key)) === JSON.stringify(item)) r.pending.delete(item.key);
        if (!r.pending.has(item.key)) r.latest.set(item.key, structuredClone(item));
      }
      emit(r); start(r);
      const approved = new Map(chapters.map(x => [x.key, x]));
      const combined = remote.copy.chapters.map(x => { const item = approved.get(x.key); approved.delete(x.key); return item ?? x; });
      return { version: r.version, chapters: [...combined, ...approved.values()] };
    } catch (e) { r.status = 'error'; r.error = e.message; emit(r); throw e; }
  }
  return { read, importDocument, queue, flush, state, conflict, retire, recover };
}
