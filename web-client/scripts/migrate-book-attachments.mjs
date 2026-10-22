#!/usr/bin/env node
// Explicit, author-confirmed migration: legacy vault "books" of one series become companion files of one book.
// Dry-run by default. Never writes vault files; changes only the app-owned SQLite in the data directory.
//
//   node scripts/migrate-book-attachments.mjs --data <.data dir> --vault <catalog vault> --map migration-map.json            (dry-run)
//   node scripts/migrate-book-attachments.mjs --data <.data dir> --vault <catalog vault> --map migration-map.json --apply    (apply)
//   node scripts/migrate-book-attachments.mjs --data <.data dir> --rollback <migrationId>
//
// Stop the TaleWisp Web server and back up the data directory before --apply or --rollback.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from '../store.mjs';
import { applyBookMigration, planBookMigration, rollbackBookMigration } from '../workspace.mjs';

// The allocation the author confirmed on 2026-10-21: one book, all eight files attached to it.
export const CONFIRMED_BOOK_NAME = 'Мир под гнетом магии';
export const CONFIRMED_SOURCE_COUNT = 8;

export function parseArgs(argv) {
  const args = { apply: false, data: null, vault: null, map: null, rollback: null, expectBookName: CONFIRMED_BOOK_NAME, expectCount: CONFIRMED_SOURCE_COUNT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value.`); return next; };
    if (flag === '--apply') args.apply = true;
    else if (flag === '--data') args.data = value();
    else if (flag === '--vault') args.vault = value();
    else if (flag === '--map') args.map = value();
    else if (flag === '--rollback') args.rollback = value();
    else if (flag === '--expect-book-name') args.expectBookName = value();
    else if (flag === '--expect-count') args.expectCount = Number(value());
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.data) throw new Error('--data <data directory> is required.');
  if (args.rollback && (args.apply || args.map)) throw new Error('--rollback cannot be combined with --apply or --map.');
  if (!args.rollback && (!args.map || !args.vault)) throw new Error('--map and --vault are required.');
  if (!Number.isSafeInteger(args.expectCount) || args.expectCount < 1) throw new Error('--expect-count must be a positive integer.');
  return args;
}

// Holds the same lock file as the server so neither can write the database concurrently.
export function holdDataLock(dataDir) {
  const lockFile = join(dataDir, 'server.lock'), token = randomBytes(16).toString('hex');
  if (existsSync(lockFile)) {
    let pid; try { pid = JSON.parse(readFileSync(lockFile, 'utf8')).pid; } catch {}
    if (Number.isInteger(pid)) { let alive = false; try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; } if (alive) throw new Error('TaleWisp Web is running on this data directory; stop it first.'); }
    unlinkSync(lockFile);
  }
  const fd = openSync(lockFile, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString(), tool: 'migrate-book-attachments' })); closeSync(fd);
  return () => { try { if (JSON.parse(readFileSync(lockFile, 'utf8')).token === token) unlinkSync(lockFile); } catch {} };
}

export function checkConfirmedAllocation(map, { expectBookName, expectCount }) {
  const errors = [];
  if (map?.bookName !== expectBookName) errors.push(`bookName «${map?.bookName}» не совпадает с подтверждённым автором «${expectBookName}».`);
  if (!Array.isArray(map?.sourceBooks) || map.sourceBooks.length !== expectCount) errors.push(`В карте должно быть ровно ${expectCount} исходных файлов, найдено ${Array.isArray(map?.sourceBooks) ? map.sourceBooks.length : 0}.`);
  return errors;
}

export function runMigration(args, log = console.log) {
  const dataDir = resolve(args.data);
  if (!existsSync(join(dataDir, 'talewisp-web.sqlite'))) throw new Error('The data directory has no talewisp-web.sqlite.');
  const writes = args.apply || !!args.rollback;
  const release = writes ? holdDataLock(dataDir) : () => {};
  const store = openStore(dataDir);
  try {
    if (args.rollback) { const result = rollbackBookMigration({ store, migrationId: args.rollback }); log(JSON.stringify(result, null, 2)); return result; }
    const map = JSON.parse(readFileSync(resolve(args.map), 'utf8'));
    const allocation = checkConfirmedAllocation(map, args), catalogRoot = resolve(args.vault);
    const plan = planBookMigration({ map, store, catalogRoot });
    if (allocation.length) { const result = { ...plan, status: 'invalid', errors: [...allocation, ...(plan.errors ?? [])] }; log(JSON.stringify(result, null, 2)); return result; }
    if (!args.apply || plan.status !== 'ready') { log(JSON.stringify({ ...plan, dryRun: true }, null, 2)); return { ...plan, dryRun: true }; }
    const result = applyBookMigration({ map, store, catalogRoot });
    log(JSON.stringify(result, null, 2)); return result;
  } finally { store.close(); release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runMigration(parseArgs(process.argv.slice(2)));
    process.exitCode = ['ready', 'applied', 'already-applied', 'rolled-back', 'already-rolled-back'].includes(result.status) ? 0 : 2;
  } catch (error) { console.error(error?.message || error); process.exitCode = 1; }
}
