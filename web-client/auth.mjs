import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCRYPT_BYTES = 64;
const DAY = 86_400_000;
const REMEMBER_MS = 90 * DAY;
const SESSION_MS = 12 * 60 * 60 * 1000;
const GENERIC_FAILURE = 'Invalid username or password.';
const digest = value => createHash('sha256').update(value).digest('hex');

export function createPasswordRecord(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9._@+-]{1,128}$/.test(username)) throw new Error('Username must be 1-128 safe characters.');
  if (typeof password !== 'string' || password.length < 1 || Buffer.byteLength(password, 'utf8') > 1024) throw new Error('Password must contain 1-1024 bytes.');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_BYTES).toString('hex');
  return { username, salt, hash };
}

export function createPasswordAuth({ authFile, dataDir, now = Date.now, maxAttempts = 10, windowMs = 15 * 60_000 } = {}) {
  let credential;
  try { credential = JSON.parse(readFileSync(authFile, 'utf8')); } catch { throw new Error('TALEWISP_AUTH_FILE must point to a valid password credential JSON file.'); }
  if (!credential || typeof credential.username !== 'string' || !/^[A-Za-z0-9._@+-]{1,128}$/.test(credential.username) || typeof credential.salt !== 'string' || !/^[a-f0-9]{32}$/.test(credential.salt) || typeof credential.hash !== 'string' || !/^[a-f0-9]{128}$/.test(credential.hash)) throw new Error('TALEWISP_AUTH_FILE must contain username, salt, and a 64-byte scrypt hash.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(`${dataDir}/auth-sessions.sqlite`);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, remembered INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
  const attempts = new Map();
  const pruneAttempts = at => { for (const [key, item] of attempts) if (item.until <= at) attempts.delete(key); while (attempts.size > 4096) attempts.delete(attempts.keys().next().value); };
  const authenticate = (username, password, address) => {
    const at = now(); pruneAttempts(at);
    const userValid = typeof username === 'string' && /^[A-Za-z0-9._@+-]{1,128}$/.test(username);
    const safeUser = userValid ? username : '';
    const key = String(address ?? 'unknown').slice(0, 100);
    const current = attempts.get(key);
    if (current && current.count >= maxAttempts && current.until > at) throw Object.assign(new Error(GENERIC_FAILURE), { status: 429 });
    const passwordValid = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 1024;
    const candidate = passwordValid ? scryptSync(password, credential.salt, SCRYPT_BYTES) : scryptSync('invalid-password', credential.salt, SCRYPT_BYTES);
    const expected = Buffer.from(credential.hash, 'hex');
    const valid = userValid && passwordValid && safeUser === credential.username && candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!valid) { attempts.set(key, { count: (current?.until > at ? current.count : 0) + 1, until: at + windowMs }); throw Object.assign(new Error(GENERIC_FAILURE), { status: 401 }); }
    attempts.delete(key); return true;
  };
  const issue = remembered => {
    const token = randomBytes(32).toString('base64url'), expiresAt = now() + (remembered ? REMEMBER_MS : SESSION_MS);
    db.prepare('INSERT INTO sessions(token_hash, expires_at, remembered) VALUES(?, ?, ?)').run(digest(token), expiresAt, remembered ? 1 : 0);
    return { token, expiresAt, remembered: !!remembered };
  };
  const valid = token => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false;
    const at = now(); db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at);
    const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(digest(token));
    return !!row && row.expires_at > at;
  };
  const revoke = token => { if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token)); };
  return { username: credential.username, authenticate, issue, valid, revoke, close: () => db.close(), rememberMs: REMEMBER_MS };
}

export const AUTH_SESSION_MS = SESSION_MS;
