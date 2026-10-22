// App-owned working manuscript. Never writes into the author's vault or to Google.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadedFromSection, mergeLoaded } from './public/manuscript-model.js';

const error = (message, status = 409, code = 'working_copy_conflict') => Object.assign(new Error(message), { status, code, expose: true });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export function createManuscriptFiles(dataDir) {
  const directory = join(dataDir, 'manuscripts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw error('Каталог рабочих рукописей не может быть ссылкой.', 400);
  const fileOf = (bookId, documentId) => {
    if (!validId(bookId) || !validId(documentId)) throw error('Неверная привязка рабочего файла.', 400, 'working_copy_invalid');
    return join(directory, createHash('sha256').update(JSON.stringify([bookId, documentId])).digest('hex') + '.book.json');
  };
  function read(bookId, documentId) {
    const path = fileOf(bookId, documentId);
    if (!existsSync(path)) return null;
    if (lstatSync(path).isSymbolicLink()) throw error('Рабочий файл не может быть ссылкой.', 400);
    const copy = JSON.parse(readFileSync(path, 'utf8'));
    if (copy.schema !== 1 || copy.bookId !== bookId || copy.documentId !== documentId || !Number.isSafeInteger(copy.version) || !Array.isArray(copy.chapters)) throw error('Рабочий файл повреждён. Исходный файл сохранён.', 409, 'working_copy_invalid');
    return copy;
  }
  function commit(bookId, documentId, expectedVersion, update) {
    // Synchronous CAS + rename under the application's single-data-directory server lock.
    // No await occurs between reading the version and installing the new file.
    const previous = read(bookId, documentId), version = previous?.version ?? 0;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== version) throw error('Рабочий файл изменён в другой вкладке. Ваш текст остаётся в браузере; загрузите рабочий файл для сравнения.');
    const copy = { ...update(previous), schema: 1, bookId, documentId, version: version + 1, updatedAt: new Date().toISOString() };
    const text = JSON.stringify(copy, null, 2);
    if (Buffer.byteLength(text) > 40_000_000) throw error('Рабочая рукопись превышает 40 МБ.', 413, 'working_copy_too_large');
    const path = fileOf(bookId, documentId), temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      if (previous) {
        const backup = path + '.previous';
        if (existsSync(backup) && lstatSync(backup).isSymbolicLink()) throw error('Резервный файл не может быть ссылкой.', 400);
        writeFileSync(backup, JSON.stringify(previous, null, 2), { mode: 0o600 });
      }
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return copy;
  }
  function importDocument(bookId, documentId, expectedVersion, { manuscript, source }) {
    if (manuscript?.documentId !== documentId || !Array.isArray(manuscript.sections) || manuscript.sections.some(x => typeof x.body !== 'string')) throw error('Google не вернул полный текст глав.', 502, 'working_copy_incomplete');
    return commit(bookId, documentId, expectedVersion, previous => {
      const old = new Map((previous?.chapters ?? []).map(x => [x.key, x]));
      const chapters = manuscript.sections.map(section => {
        const fresh = loadedFromSection(section, manuscript.revisionId);
        const existing = old.get(fresh.key); old.delete(fresh.key);
        return mergeLoaded(existing, fresh);
      });
      // A deleted/renumbered Google chapter may still contain author edits. Preserve it explicitly.
      for (const item of old.values()) chapters.push({ ...item, missing: item.kind === 'section' });
      return { manuscript, source, chapters, archive: previous?.archive ?? [], importedAt: new Date().toISOString() };
    });
  }
  function save(bookId, documentId, expectedVersion, chapters, retired = []) {
    if (!Array.isArray(chapters) || chapters.length > 2000) throw error('Неверный список глав.', 400, 'working_copy_invalid');
    const keys = new Set();
    if (!Array.isArray(retired) || retired.length > 2000 || retired.some(x => !x || typeof x.key !== 'string' || typeof x.operationId !== 'string')) throw error('Неверный список записанных глав.', 400, 'working_copy_invalid');
    for (const item of chapters) {
      if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 450 || keys.has(item.key) || !['section','new','written'].includes(item.kind)
        || typeof item.title !== 'string' || item.title.length > 400 || typeof item.body !== 'string' || item.body.length > 2_000_000
        || typeof item.baseBody !== 'string' || typeof item.baseTitle !== 'string') throw error('Глава передана в неверном формате.', 400, 'working_copy_invalid');
      keys.add(item.key);
    }
    return commit(bookId, documentId, expectedVersion, previous => {
      if (!previous) throw error('Сначала импортируйте рукопись из Google.', 409, 'working_copy_missing');
      // Saving an editor subset cannot delete chapters outside that subset.
      const incoming = new Map(chapters.map(x => [x.key, structuredClone(x)]));
      const archive = [...(previous.archive ?? [])], retirement = new Map(retired.map(x => [x.key, x.operationId]));
      const merged = [];
      for (const item of previous.chapters) {
        const next = incoming.get(item.key); incoming.delete(item.key);
        if (retirement.has(item.key) && item.kind === 'new' && item.write?.operationId === retirement.get(item.key) && !next) {
          archive.push({ ...item, retiredAt: new Date().toISOString() });
        } else merged.push(next ?? item);
      }
      return { ...previous, chapters: [...merged, ...incoming.values()], archive };
    });
  }
  const view = copy => copy && { ...copy, source: undefined, archive: undefined, fileName: fileOf(copy.bookId, copy.documentId).split(/[\\/]/).at(-1) };
  return { read, save, importDocument, view };
}
