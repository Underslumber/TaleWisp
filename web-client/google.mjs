import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, createPublicKey, verify as verifySignature } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, open, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { googleNoteBody } from './public/google-note.js';
import { GOOGLE_SHEETS_API, GOOGLE_SPREADSHEET_MIME, parseBoundedA1Range, sheetValuesUrl, normalizeGrid, padGrid, containsFormula, stableGridHash, validateWriteGrid } from './google-sheets.mjs';
import { createChapterOperations } from './google-chapters.mjs';

const execFileAsync = promisify(execFile);
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const TEXT_STYLE_FIELDS = [
  'backgroundColor', 'baselineOffset', 'bold', 'fontSize', 'foregroundColor',
  'italic', 'link', 'smallCaps', 'strikethrough', 'underline', 'weightedFontFamily',
];
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.readonly',
];
const OAUTH_TTL_MS = 10 * 60 * 1000;
const TOKEN_SKEW_MS = 60_000;
const UNRESOLVED_OPERATION_STATES = new Set(['started', 'outcome_unknown', 'needs_review']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'conflict', 'rejected', 'author_reviewed']);
const activeDocumentRuns = new Map();
const activeSpreadsheetRuns = new Map();

function safeError(message, code = 'GOOGLE_ERROR', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function docUrl(id, query = {}) {
  const url = new URL(`${DOCS}/${encodeURIComponent(id)}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  return url;
}

function getTabEntries(document) {
  const entries = [];
  function add(tab, parentTitle = '') {
    const tabId = tab.tabProperties?.tabId ?? '';
    const title = tab.tabProperties?.title ?? parentTitle ?? '';
    entries.push({ tabId, title, tab, documentTab: tab.documentTab ?? {} });
    for (const child of tab.childTabs ?? []) add(child, title);
  }
  for (const tab of document.tabs ?? []) add(tab);
  if (!entries.length) entries.push({ tabId: '', title: '', tab: null, documentTab: document });
  return entries;
}

function flattenTab(documentTab) {
  const segments = [];
  const chunks = [];
  let textOffset = 0;
  function addRun(run, ancestry, kind) {
    const text = run.content ?? '';
    if (!text) return;
    const startIndex = Number.isInteger(run.startIndex) ? run.startIndex : null;
    const endIndex = Number.isInteger(run.endIndex) ? run.endIndex : (startIndex == null ? null : startIndex + text.length);
    const segment = {
      startIndex,
      endIndex,
      text,
      textOffset,
      textEndOffset: textOffset + text.length,
      structure: ancestry.join('/'),
      segmentId: ancestry[0] === 'body' ? '' : ancestry[1] ?? '',
      kind,
      style: run.textStyle ?? {},
      suggestedInsertionIds: run.suggestedInsertionIds ?? [],
      suggestedDeletionIds: run.suggestedDeletionIds ?? [],
      suggestedTextStyleChanges: run.suggestedTextStyleChanges ?? {},
    };
    segments.push(segment);
    chunks.push(text);
    textOffset += text.length; // JavaScript string offsets are UTF-16 code units, matching Docs indexes.
  }
  function walkContent(content, ancestry) {
    for (let i = 0; i < (content ?? []).length; i++) {
      const item = content[i];
      const itemPath = [...ancestry, `content:${i}`];
      if (item.paragraph) {
        for (let j = 0; j < (item.paragraph.elements ?? []).length; j++) {
          const element = item.paragraph.elements[j];
          if (element.textRun) addRun({ ...element.textRun, startIndex: element.startIndex, endIndex: element.endIndex }, [...itemPath, `paragraph:${item.startIndex ?? ''}`], 'textRun');
          else if (element.autoText) addRun({ ...element.autoText, startIndex: element.startIndex, endIndex: element.endIndex, content: element.autoText.content ?? '' }, [...itemPath, `paragraph:${item.startIndex ?? ''}`], 'autoText');
        }
      } else if (item.table) {
        for (let row = 0; row < (item.table.tableRows ?? []).length; row++) {
          const cells = item.table.tableRows[row].tableCells ?? [];
          for (let col = 0; col < cells.length; col++) {
            walkContent(cells[col].content, [...itemPath, `table:${row}:${col}`]);
          }
        }
      } else if (item.tableOfContents) {
        walkContent(item.tableOfContents.content, [...itemPath, 'toc']);
      }
    }
  }
  walkContent(documentTab.body?.content, ['body']);
  for (const [sectionName, sections] of [['headers', documentTab.headers], ['footers', documentTab.footers], ['footnotes', documentTab.footnotes]]) {
    for (const [id, section] of Object.entries(sections ?? {})) walkContent(section.content, [sectionName, id]);
  }
  return { text: chunks.join(''), segments };
}

function findProtectedOverlap(raw, tabId, startIndex, endIndex) {
  let found = false;
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value) || found) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    const protectedRange = value.protectedRange ?? (value.range && value.protectedRangeId ? value : null);
    if (protectedRange) {
      const range = protectedRange.range ?? protectedRange;
      const rangeTab = range.tabId ?? '';
      if ((rangeTab === tabId || !rangeTab) && !(range.segmentId ?? '') && Number.isInteger(range.startIndex) && Number.isInteger(range.endIndex) && startIndex < range.endIndex && endIndex > range.startIndex) found = true;
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(raw);
  return found;
}

function validateRange(tab, tabId, startIndex, endIndex, quote, raw) {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex <= startIndex) {
    throw safeError('Google Docs range is invalid.', 'GOOGLE_RANGE_INVALID', 400);
  }
  if (typeof quote !== 'string' || quote.length !== endIndex - startIndex) {
    throw safeError('The quoted text length does not match the UTF-16 range.', 'GOOGLE_RANGE_INVALID', 400);
  }
  if (findProtectedOverlap(raw, tabId, startIndex, endIndex)) {
    throw safeError('The selected range overlaps protected content.', 'GOOGLE_PROTECTED_RANGE', 409);
  }
  const picked = (tab.segments ?? []).filter((part) => part.segmentId === '' && part.startIndex != null && part.endIndex != null && part.startIndex < endIndex && part.endIndex > startIndex);
  if (!picked.length) throw safeError('The selected range does not map to document text.', 'GOOGLE_RANGE_INVALID', 409);
  let cursor = startIndex;
  let actual = '';
  const structures = new Set();
  const styleKeys = new Set();
  for (const segment of picked) {
    const from = Math.max(cursor, segment.startIndex);
    if (from !== cursor) throw safeError('The selected range crosses non-text document structure.', 'GOOGLE_MIXED_STRUCTURE', 409);
    const to = Math.min(endIndex, segment.endIndex);
    const localStart = from - segment.startIndex;
    const localEnd = to - segment.startIndex;
    actual += segment.text.slice(localStart, localEnd);
    cursor = to;
    structures.add(segment.structure);
    styleKeys.add(JSON.stringify(segment.style));
    if (segment.suggestedInsertionIds.length || segment.suggestedDeletionIds.length || Object.keys(segment.suggestedTextStyleChanges).length) {
      throw safeError('The selected range already contains a pending suggestion.', 'GOOGLE_PENDING_SUGGESTION', 409);
    }
    if (cursor === endIndex) break;
  }
  if (cursor !== endIndex) throw safeError('The selected range crosses non-text document structure.', 'GOOGLE_MIXED_STRUCTURE', 409);
  if (actual !== quote) throw safeError('The selected text no longer matches the supplied quote.', 'GOOGLE_QUOTE_MISMATCH', 409);
  if (structures.size !== 1) throw safeError('The selected range crosses a paragraph or structural boundary.', 'GOOGLE_MIXED_STRUCTURE', 409);
  if (styleKeys.size !== 1) throw safeError('The selected range crosses differently styled text.', 'GOOGLE_MIXED_STYLE', 409);
  const style = picked[0].style ?? {};
  if (Object.keys(style).some((key) => !TEXT_STYLE_FIELDS.includes(key))) {
    throw safeError('The selected text uses an unsupported style that cannot be preserved safely.', 'GOOGLE_STYLE_UNSUPPORTED', 409);
  }
  return JSON.parse(JSON.stringify(style));
}

function cleanIndices(value) {
  if (Array.isArray(value)) return value.map(cleanIndices);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'startIndex' && key !== 'endIndex')
    .map(([key, child]) => [key, cleanIndices(child)]));
}

function bodyTokens(content, out = []) {
  for (const item of content ?? []) {
    if (item.paragraph) {
      const { elements = [], ...paragraph } = item.paragraph;
      out.push({ kind: 'paragraph', paragraph: cleanIndices(paragraph) });
      for (const element of elements) {
        const run = element.textRun ?? element.autoText;
        if (run) {
          const text = run.content ?? '';
          for (let i = 0; i < text.length; i++) {
            out.push({
              kind: 'text', char: text[i], index: Number.isInteger(element.startIndex) ? element.startIndex + i : null,
              style: cleanIndices(run.textStyle ?? {}),
              styleChanges: cleanIndices(run.suggestedTextStyleChanges ?? {}),
              insertionIds: run.suggestedInsertionIds ?? [], deletionIds: run.suggestedDeletionIds ?? [],
            });
          }
        } else {
          out.push({ kind: 'element', element: cleanIndices(element) });
        }
      }
    } else if (item.table) {
      const { tableRows = [], ...table } = item.table;
      out.push({ kind: 'table', table: cleanIndices(table) });
      for (const row of tableRows) {
        out.push({ kind: 'tableRow', row: cleanIndices({ ...row, tableCells: undefined }) });
        for (const cell of row.tableCells ?? []) {
          const { content: cellContent = [], ...cellMeta } = cell;
          out.push({ kind: 'tableCell', cell: cleanIndices(cellMeta) });
          bodyTokens(cellContent, out);
        }
      }
    } else if (item.tableOfContents) {
      const { content: tocContent = [], ...toc } = item.tableOfContents;
      out.push({ kind: 'tableOfContents', toc: cleanIndices(toc) });
      bodyTokens(tocContent, out);
    } else {
      out.push({ kind: 'bodyElement', element: cleanIndices(item) });
    }
  }
  return out;
}

function expectedStyleAfterSuggestion(segment, suggestionIds) {
  const expected = { ...(segment.style ?? {}) };
  let found = false;
  for (const id of suggestionIds) {
    const proposal = segment.suggestedTextStyleChanges?.[id];
    if (!proposal) continue;
    found = true;
    const state = proposal.textStyleSuggestionState ?? {};
    const style = proposal.textStyle ?? {};
    for (const field of TEXT_STYLE_FIELDS) {
      if (!state[`${field}Suggested`]) continue;
      if (Object.hasOwn(style, field)) expected[field] = style[field];
      else delete expected[field];
    }
  }
  return found ? expected : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function styleMatchesSource(source, proposed, base) {
  const actual = proposed ?? base ?? {};
  for (const [field, value] of Object.entries(source)) {
    if (!Object.hasOwn(actual, field) || !sameValue(actual[field], value)) return false;
  }
  for (const field of TEXT_STYLE_FIELDS) {
    if (Object.hasOwn(source, field) || !Object.hasOwn(base ?? {}, field)) continue;
    if (Object.hasOwn(actual, field)) {
      // Google may serialize a cleared inherited boolean as its visual default.
      if (!(typeof (base ?? {})[field] === 'boolean' && actual[field] === false)) return false;
    }
  }
  return true;
}

export function createGoogleService({ dataDir, origin, ownerId, credentialNamespace = 'human', callbackPath } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  if (!['human', 'agent'].includes(credentialNamespace)) throw new TypeError('credentialNamespace must be human or agent');
  const expectedCallbackPath = credentialNamespace === 'agent' ? '/api/google/agent/callback' : '/api/google/callback';
  const oauthCallbackPath = callbackPath ?? expectedCallbackPath;
  if (oauthCallbackPath !== expectedCallbackPath) throw new TypeError('callbackPath does not match the Google credential namespace');
  const googleDir = path.join(dataDir, 'google');
  const credentialDir = credentialNamespace === 'agent' ? path.join(googleDir, 'agent') : googleDir;
  const credentialPath = path.join(credentialDir, 'credentials.enc');
  const configurationPath = path.join(credentialDir, 'configuration.enc');
  const credentialKeyPath = path.join(credentialDir, 'storage.key');
  const keyPath = path.join(googleDir, 'storage.key');
  const journalDir = path.join(googleDir, 'operations');
  const serviceOwnerId = typeof ownerId === 'string' && ownerId ? ownerId : sha256(path.resolve(dataDir));
  const environmentClientId = process.env[credentialNamespace === 'agent' ? 'GOOGLE_AGENT_CLIENT_ID' : 'GOOGLE_CLIENT_ID'] ?? '';
  const environmentClientSecret = process.env[credentialNamespace === 'agent' ? 'GOOGLE_AGENT_CLIENT_SECRET' : 'GOOGLE_CLIENT_SECRET'] ?? '';
  const environmentConfigured = Boolean(environmentClientId && environmentClientSecret);
  let clientId = environmentClientId;
  let clientSecret = environmentClientSecret;
  let configurationLoaded = false;
  let configurationLoad;
  const redirectOverride = process.env[credentialNamespace === 'agent' ? 'GOOGLE_AGENT_REDIRECT_URI' : 'GOOGLE_REDIRECT_URI'] || '';
  const configuredOrigin = typeof origin === 'function' ? origin : () => origin || 'http://127.0.0.1:8787';
  const currentRedirectUri = () => redirectOverride || `${String(configuredOrigin()).replace(/\/$/, '')}${oauthCallbackPath}`;
  const oauthStates = new Map();
  const pendingOps = new Map();
  const keyCache = new Map();
  let credentialsCache;
  let dirReady;
  let lastServiceApiError = null;

  async function ensurePrivateDir() {
    if (!dirReady) dirReady = (async () => {
      await mkdir(googleDir, { recursive: true, mode: 0o700 });
      await mkdir(credentialDir, { recursive: true, mode: 0o700 });
      await mkdir(journalDir, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') {
        const user = process.env.USERDOMAIN && process.env.USERNAME
          ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
          : process.env.USERNAME;
        if (!user) throw safeError('Cannot establish a private Google credential directory.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
        try {
          async function restrictAcl(directory) {
            // Keep the current AppContainer SID when running under a Windows sandbox; it is the
            // same constrained process identity that created this directory, not a broad user group.
            const inherited = await execFileAsync('icacls.exe', [directory], { windowsHide: true, timeout: 10_000 });
            const sandboxSids = [...new Set(inherited.stdout.match(/S-1-15-2-[\d-]+/g) ?? [])];
            const grants = [`${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F', ...sandboxSids.map((sid) => `*${sid}:(OI)(CI)F`)];
            await execFileAsync('icacls.exe', [directory, '/inheritance:r', '/grant:r', ...grants], { windowsHide: true, timeout: 10_000 });
          }
          await restrictAcl(googleDir);
          if (credentialDir !== googleDir) await restrictAcl(credentialDir);
          await restrictAcl(journalDir);
        } catch {
          throw safeError('Cannot restrict access to Google credentials and operation records.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
        }
      } else {
        await chmod(googleDir, 0o700);
        if (credentialDir !== googleDir) await chmod(credentialDir, 0o700);
        await chmod(journalDir, 0o700);
      }
    })().catch((error) => { dirReady = null; throw error; });
    return dirReady;
  }

  async function ensureOAuthConfiguration() {
    if (environmentConfigured) {
      clientId = environmentClientId;
      clientSecret = environmentClientSecret;
      configurationLoaded = true;
      return;
    }
    if (configurationLoaded) return;
    if (!configurationLoad) configurationLoad = (async () => {
      const saved = await readEncryptedFile(configurationPath, credentialKeyPath);
      if (saved && validateOAuthConfiguration(saved.clientId, saved.clientSecret)) {
        clientId = saved.clientId;
        clientSecret = saved.clientSecret;
      }
      configurationLoaded = true;
    })().catch((error) => { configurationLoad = null; throw error; });
    await configurationLoad;
  }

  function validateOAuthConfiguration(candidateId, candidateSecret) {
    return typeof candidateId === 'string' && candidateId.length <= 256
      && /^\d+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(candidateId)
      && typeof candidateSecret === 'string' && /^[A-Za-z0-9._-]{8,512}$/.test(candidateSecret);
  }

  async function configure({ clientId: candidateId, clientSecret: candidateSecret } = {}) {
    if (environmentClientId || environmentClientSecret) throw safeError('Google OAuth is controlled by environment configuration.', 'GOOGLE_OAUTH_ENV_CONFIGURED', 409);
    await ensureOAuthConfiguration();
    if (clientId && clientSecret) throw safeError('Google OAuth is already configured.', 'GOOGLE_OAUTH_ALREADY_CONFIGURED', 409);
    if (!validateOAuthConfiguration(candidateId, candidateSecret)) throw safeError('Enter a valid Google OAuth client ID and client secret.', 'GOOGLE_OAUTH_CONFIGURATION_INVALID', 400);
    await saveEncrypted(configurationPath, { clientId: candidateId, clientSecret: candidateSecret }, credentialKeyPath);
    clientId = candidateId;
    clientSecret = candidateSecret;
    configurationLoaded = true;
    configurationLoad = null;
    return { configured: true, requiresClientConfiguration: false, redirectUri: currentRedirectUri() };
  }

  async function storageKey(file = keyPath) {
    if (keyCache.has(file)) return keyCache.get(file);
    await ensurePrivateDir();
    try {
      const key = await readFile(file);
      if (key.length !== 32) throw safeError('Google credential storage key is invalid.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
      keyCache.set(file, key);
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32);
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
      if (process.platform !== 'win32') await chmod(file, 0o600);
      keyCache.set(file, key);
      return key;
    } catch (error) {
      if (error.code === 'EEXIST') return storageKey(file);
      throw safeError('Cannot create Google credential storage key.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
    }
  }

  async function encryptValue(value, keyFile = keyPath) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await storageKey(keyFile), iv);
    const ciphertext = Buffer.concat([cipher.update(jsonBytes(value)), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
  }

  async function decryptValue(envelope, keyFile = keyPath) {
    if (envelope?.v !== 1) throw safeError('Encrypted Google data has an unsupported version.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
    try {
      const decipher = createDecipheriv('aes-256-gcm', await storageKey(keyFile), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch {
      throw safeError('Encrypted Google data could not be verified.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
    }
  }

  async function saveEncrypted(file, value, keyFile = keyPath) {
    await ensurePrivateDir();
    const envelope = await encryptValue(value, keyFile);
    const serialized = JSON.stringify(envelope);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const tempHandle = await open(temp, 'wx', 0o600);
      try { await tempHandle.writeFile(serialized); await tempHandle.sync(); } finally { await tempHandle.close(); }
      if (process.platform !== 'win32') await chmod(temp, 0o600);
      try {
        await rename(temp, file);
      } catch (renameError) {
        // Some Windows sandboxed filesystems deny rename even within one private directory.
        // The fallback still writes only authenticated ciphertext under the restricted ACL.
        const directHandle = await open(file, 'w', 0o600);
        try { await directHandle.writeFile(serialized); await directHandle.sync(); } finally { await directHandle.close(); }
        try { const { unlink } = await import('node:fs/promises'); await unlink(temp); } catch { /* orphaned ciphertext is harmless */ }
      }
    } catch (error) {
      const storageError = safeError('Cannot save private Google connection data.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
      storageError.cause = error;
      throw storageError;
    }
  }

  async function loadCredentials() {
    if (credentialsCache) return credentialsCache;
    try {
      const envelope = parseJson(await readFile(credentialPath, 'utf8'), null);
      if (!envelope) throw safeError('Google credential file is invalid.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
      credentialsCache = await decryptValue(envelope, credentialKeyPath);
      return credentialsCache;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function persistCredentials(credentials) {
    await saveEncrypted(credentialPath, credentials, credentialKeyPath);
    credentialsCache = credentials;
  }

  async function readJournal(operationId) {
    const file = path.join(journalDir, `${sha256(operationId)}.enc`);
    try { return await decryptValue(parseJson(await readFile(file, 'utf8'), null)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function writeJournal(operationId, entry) {
    const file = path.join(journalDir, `${sha256(operationId)}.enc`);
    await saveEncrypted(file, entry);
    const lockFile = documentLockPath(entry.documentId);
    const lock = await readEncryptedFile(lockFile);
    if (lock?.operationId === operationId && lock.documentId === entry.documentId) {
      if (TERMINAL_OPERATION_STATES.has(entry.state)) {
        try { const { unlink } = await import('node:fs/promises'); await unlink(lockFile); }
        catch (error) { if (error.code !== 'ENOENT') throw safeError('Cannot release the Google document operation lock.', 'GOOGLE_STORAGE_UNAVAILABLE', 500); }
      } else {
        await saveEncrypted(lockFile, lockProjection(entry));
      }
    } else if (UNRESOLVED_OPERATION_STATES.has(entry.state)) {
      throw safeError('The durable Google document operation lock is missing.', 'GOOGLE_STORAGE_UNAVAILABLE', 500);
    }
  }

  function documentLockPath(documentId) {
    return path.join(journalDir, `${sha256(documentId)}.lock`);
  }

  function spreadsheetLockPath(spreadsheetId) {
    return path.join(journalDir, `${sha256(`sheets:${spreadsheetId}`)}.sheetlock`);
  }

  async function writeSpreadsheetJournal(operationId, entry) {
    await saveEncrypted(path.join(journalDir, `${sha256(operationId)}.enc`), entry);
  }

  async function releaseSpreadsheetLock(spreadsheetId, operationId) {
    const file = spreadsheetLockPath(spreadsheetId);
    const lock = await readEncryptedFile(file);
    if (lock?.operationId === operationId && lock.spreadsheetId === spreadsheetId) {
      try { const { unlink } = await import('node:fs/promises'); await unlink(file); }
      catch (error) { if (error.code !== 'ENOENT') throw safeError('Cannot release the Google Sheets operation lock.', 'GOOGLE_STORAGE_UNAVAILABLE', 500); }
    }
  }

  function lockProjection(entry) {
    return { operationId: entry.operationId, documentId: entry.documentId, state: entry.state, createdAt: entry.createdAt, phase: entry.phase ?? 'reserved', ...(entry.signature ? { signature: entry.signature } : {}), ...(entry.kind ? { kind: entry.kind } : {}) };
  }

  function getDocumentRunKey(documentId) { return `${path.resolve(dataDir)}:${sha256(documentId)}`; }

  async function readEncryptedFile(file, keyFile = keyPath) {
    try { return await decryptValue(parseJson(await readFile(file, 'utf8'), null), keyFile); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function listPendingOperations(documentId) {
    await ensurePrivateDir();
    const operations = new Map();
    for (const name of await readdir(journalDir)) {
      if (!name.endsWith('.enc')) continue;
      const entry = await readEncryptedFile(path.join(journalDir, name));
      if (entry?.documentId === documentId && UNRESOLVED_OPERATION_STATES.has(entry.state)) operations.set(entry.operationId, entry);
    }
    for (const name of await readdir(journalDir)) {
      if (!name.endsWith('.lock')) continue;
      const lock = await readEncryptedFile(path.join(journalDir, name));
      if (lock?.documentId !== documentId) continue;
      const journal = lock.operationId ? await readJournal(lock.operationId) : null;
      const current = journal?.documentId === documentId ? journal : lock;
      if (UNRESOLVED_OPERATION_STATES.has(current.state) && !operations.has(current.operationId)) operations.set(current.operationId, current);
    }
    return [...operations.values()].map((entry) => ({ operationId: entry.operationId, state: entry.state, createdAt: entry.createdAt, phase: entry.phase ?? 'reserved', active: activeDocumentRuns.get(getDocumentRunKey(documentId)) === entry.operationId }));
  }

  async function reserveDocument(entry) {
    await ensurePrivateDir();
    const file = documentLockPath(entry.documentId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const unresolved = await listPendingOperations(entry.documentId);
      const other = unresolved.find((operation) => operation.operationId !== entry.operationId);
      if (other) throw safeError('Another Google document operation needs review before any new write.', 'GOOGLE_DOCUMENT_OPERATION_PENDING', 409);
      try {
        const handle = await open(file, 'wx', 0o600);
        let writeError;
        try {
          const envelope = await encryptValue(lockProjection(entry));
          await handle.writeFile(JSON.stringify(envelope));
          await handle.sync();
        } catch (error) {
          writeError = error;
        } finally { await handle.close(); }
        if (writeError) {
          try { const { unlink } = await import('node:fs/promises'); await unlink(file); } catch { /* keep the original storage error */ }
          throw writeError;
        }
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lock = await readEncryptedFile(file);
        const prior = lock?.operationId ? await readJournal(lock.operationId) : null;
        if (lock?.documentId === entry.documentId && prior && TERMINAL_OPERATION_STATES.has(prior.state)) {
          try { const { unlink } = await import('node:fs/promises'); await unlink(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
          continue;
        }
        throw safeError('Another Google document operation needs review before any new write.', 'GOOGLE_DOCUMENT_OPERATION_PENDING', 409);
      }
    }
    throw safeError('The Google document operation lock could not be reserved.', 'GOOGLE_DOCUMENT_OPERATION_PENDING', 409);
  }

  function safeOrigin(redirectUri = currentRedirectUri()) {
    try {
      const parsed = new URL(redirectUri);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) return false;
      return parsed.pathname === oauthCallbackPath;
    } catch { return false; }
  }

  async function tokenFetch(body) {
    let response;
    try {
      response = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw safeError('Google OAuth could not be reached.', 'GOOGLE_OAUTH_UNAVAILABLE', 502);
    }
    const payload = parseJson(await response.text(), null);
    if (!response.ok || !payload?.access_token) throw safeError('Google OAuth did not complete. Check the Google app configuration and consent.', 'GOOGLE_OAUTH_FAILED', 502);
    return payload;
  }

  async function verifyIdToken(idToken, nonce) {
    await ensureOAuthConfiguration();
    if (typeof idToken !== 'string') throw safeError('Google did not return an OpenID nonce proof.', 'GOOGLE_OAUTH_FAILED', 502);
    const parts = idToken.split('.');
    if (parts.length !== 3) throw safeError('Google returned an invalid identity token.', 'GOOGLE_OAUTH_FAILED', 502);
    const header = parseJson(Buffer.from(parts[0], 'base64url').toString('utf8'), null);
    const claims = parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'), null);
    if (!header?.kid || header.alg !== 'RS256' || !claims) throw safeError('Google returned an unsupported identity token.', 'GOOGLE_OAUTH_FAILED', 502);
    let keys;
    try {
      const response = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(10_000) });
      keys = parseJson(await response.text(), null);
      if (!response.ok) keys = null;
    } catch { keys = null; }
    const jwk = keys?.keys?.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
    if (!jwk) throw safeError('Google identity could not be verified.', 'GOOGLE_OAUTH_FAILED', 502);
    let valid = false;
    try {
      valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    } catch { valid = false; }
    const now = Math.floor(Date.now() / 1000);
    const issuerValid = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    const audienceValid = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
    const authorizedPartyValid = !Array.isArray(claims.aud) || claims.aud.length < 2 || claims.azp === clientId;
    if (!valid || !issuerValid || !audienceValid || !authorizedPartyValid || claims.nonce !== nonce || !Number.isFinite(claims.exp) || claims.exp <= now || (claims.iat && claims.iat > now + 60)) {
      throw safeError('Google identity verification failed.', 'GOOGLE_OAUTH_FAILED', 502);
    }
  }

  async function accessToken() {
    await ensureOAuthConfiguration();
    if (!(clientId && clientSecret)) throw safeError('Google OAuth is not configured.', 'GOOGLE_NOT_CONFIGURED', 503);
    const credentials = await loadCredentials();
    if (!credentials?.refresh_token) throw safeError('Google is not connected.', 'GOOGLE_NOT_CONNECTED', 401);
    if (credentials.access_token && Date.now() + TOKEN_SKEW_MS < credentials.expires_at) return credentials.access_token;
    const refreshed = await tokenFetch({ client_id: clientId, client_secret: clientSecret, refresh_token: credentials.refresh_token, grant_type: 'refresh_token' });
    const updated = { ...credentials, access_token: refreshed.access_token, expires_at: Date.now() + Number(refreshed.expires_in ?? 3600) * 1000 };
    await persistCredentials(updated);
    return updated.access_token;
  }

  async function apiRequest(url, options = {}) {
    const token = await accessToken();
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
        signal: options.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw safeError('Google API request did not return a response.', 'GOOGLE_NETWORK_UNKNOWN', 502);
    }
    const rawText = await response.text();
    const payload = parseJson(rawText, {});
    if (!response.ok) {
      const stale = response.status === 409 || (response.status === 400 && /required revision|revision.*match|revision.*not/i.test(JSON.stringify(payload)));
      lastServiceApiError = { status: response.status, code: stale ? 'GOOGLE_REVISION_CONFLICT' : 'GOOGLE_API_ERROR', observedAt: new Date().toISOString() };
      throw safeError(stale ? 'The Google document changed. Reload it before preparing this operation.' : `Google API returned HTTP ${response.status}.`, stale ? 'GOOGLE_REVISION_CONFLICT' : 'GOOGLE_API_ERROR', stale ? 409 : response.status >= 500 ? 502 : 400);
    }
    lastServiceApiError = null;
    return payload;
  }

  async function getRawDocument(documentId) {
    if (typeof documentId !== 'string' || !documentId.trim() || documentId.length > 512) throw safeError('A valid Google document ID is required.', 'GOOGLE_DOCUMENT_ID_INVALID');
    const query = {
      includeTabsContent: true,
      suggestionsViewMode: 'SUGGESTIONS_INLINE',
      commentsViewMode: 'COMMENTS_VIEW_MODE_INCLUDED',
    };
    return apiRequest(docUrl(documentId, query));
  }

  async function listAllComments(documentId) {
    const comments = [];
    const pages = [];
    let pageToken;
    do {
      const url = new URL(`${DRIVE}/${encodeURIComponent(documentId)}/comments`);
      url.searchParams.set('includeDeleted', 'false');
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('fields', 'nextPageToken,comments(id,content,anchor,quotedFileContent,author,createdTime,modifiedTime,resolved,replies(id,content,author,createdTime,modifiedTime,action))');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await apiRequest(url);
      pages.push(page);
      comments.push(...(page.comments ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { comments, pages };
  }

  async function listDocuments({ query = '', pageToken = '', pageSize = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 100) throw safeError('Google Docs search text is invalid.', 'GOOGLE_QUERY_INVALID');
    if (typeof pageToken !== 'string' || pageToken.length > 4096 || /[\u0000-\u001f]/.test(pageToken)) throw safeError('Google Docs page token is invalid.', 'GOOGLE_PAGE_TOKEN_INVALID');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 30) throw safeError('Google Docs page size is invalid.', 'GOOGLE_PAGE_SIZE_INVALID');
    const filters = ["mimeType = 'application/vnd.google-apps.document'", 'trashed = false'];
    const needle = query.trim();
    if (needle) filters.push(`name contains '${needle.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const url = new URL(DRIVE);
    url.searchParams.set('q', filters.join(' and '));
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await apiRequest(url);
    const files = (Array.isArray(page.files) ? page.files : []).flatMap(file => {
      if (file?.mimeType !== 'application/vnd.google-apps.document' || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)) return [];
      return [{ id: file.id, title: typeof file.name === 'string' ? file.name.slice(0, 1024) : '', modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : '' }];
    });
    return { files, nextPageToken: typeof page.nextPageToken === 'string' && page.nextPageToken.length <= 4096 ? page.nextPageToken : '' };
  }

  async function readDocument(documentId) {
    const raw = await getRawDocument(documentId);
    const entries = getTabEntries(raw);
    const tabs = entries.map(({ tabId, title, documentTab }) => ({ tabId, title, ...flattenTab(documentTab) }));
    const { comments, pages } = await listAllComments(documentId);
    return {
      documentId,
      title: raw.title ?? '',
      revisionId: raw.revisionId ?? '',
      text: tabs.map((tab) => tab.text).join('\n'),
      tabs,
      comments: comments.map((comment) => ({ ...comment, commentHash: hashCommentThread(comment) })),
      pendingOperations: await listPendingOperations(documentId),
      raw: { document: raw, commentPages: pages },
    };
  }

  async function beginLogin({ includeSheets = false, includeDriveFile = false } = {}) {
    if (typeof includeSheets !== 'boolean' || typeof includeDriveFile !== 'boolean') throw safeError('Google OAuth scope options must be true or false.', 'GOOGLE_OAUTH_OPTION_INVALID');
    await ensureOAuthConfiguration();
    const redirectUri = currentRedirectUri();
    if (!(clientId && clientSecret)) throw safeError('Set up Google OAuth to connect Google.', 'GOOGLE_NOT_CONFIGURED', 503);
    if (!safeOrigin(redirectUri)) throw safeError('Set GOOGLE_REDIRECT_URI to an HTTPS URL or the local callback URL.', 'GOOGLE_REDIRECT_URI_INVALID', 503);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const requestedScopes = [...SCOPES, ...(includeSheets ? ['https://www.googleapis.com/auth/spreadsheets'] : []), ...(includeDriveFile ? ['https://www.googleapis.com/auth/drive.file'] : [])];
    oauthStates.set(sha256(state), { state, verifier, nonce, requestedScopes, expiresAt: Date.now() + OAUTH_TTL_MS });
    for (const [hash, entry] of oauthStates) if (entry.expiresAt <= Date.now()) oauthStates.delete(hash);
    while (oauthStates.size > 32) oauthStates.delete(oauthStates.keys().next().value);
    const url = new URL(GOOGLE_AUTH);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: requestedScopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) url.searchParams.set(key, value);
    return { authUrl: url.toString() };
  }

  async function callback(callbackUrl) {
    await ensureOAuthConfiguration();
    const redirectUri = currentRedirectUri();
    let url;
    try { url = new URL(callbackUrl); } catch { throw safeError('Google OAuth callback URL is invalid.', 'GOOGLE_OAUTH_STATE_INVALID', 400); }
    if (url.origin + url.pathname !== new URL(redirectUri).origin + new URL(redirectUri).pathname) throw safeError('Google OAuth callback does not match the configured redirect URL.', 'GOOGLE_OAUTH_STATE_INVALID', 400);
    const state = url.searchParams.get('state') ?? '';
    const key = sha256(state);
    const record = oauthStates.get(key);
    if (!record || record.state !== state || record.expiresAt <= Date.now()) {
      oauthStates.delete(key);
      throw safeError('Google OAuth state is invalid or expired.', 'GOOGLE_OAUTH_STATE_INVALID', 400);
    }
    oauthStates.delete(key); // one-time callback, including provider errors
    if (url.searchParams.has('error')) throw safeError('Google sign-in was not completed.', 'GOOGLE_OAUTH_CANCELLED', 400);
    const code = url.searchParams.get('code');
    if (!code) throw safeError('Google OAuth callback is missing its authorization code.', 'GOOGLE_OAUTH_FAILED', 400);
    const token = await tokenFetch({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: record.verifier,
    });
    await verifyIdToken(token.id_token, record.nonce);
    if (!token.refresh_token) throw safeError('Google did not return offline access. Reconnect and approve the requested access.', 'GOOGLE_OAUTH_FAILED', 502);
    const credentials = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + Number(token.expires_in ?? 3600) * 1000,
      scope: token.scope ?? record.requestedScopes.join(' '),
      token_type: token.token_type ?? 'Bearer',
    };
    await persistCredentials(credentials);
    return { connected: true };
  }

  async function status() {
    const redirectUri = currentRedirectUri();
    try { await ensureOAuthConfiguration(); }
    catch { return { configured: false, authenticated: false, reason: 'configuration_store_unavailable', redirectUri, requiresClientConfiguration: false }; }
    if (!(clientId && clientSecret)) return { configured: false, authenticated: false, reason: 'missing_google_oauth_configuration', redirectUri, requiresClientConfiguration: true };
    try {
      const credentials = await loadCredentials();
      const authenticated = Boolean(credentials?.refresh_token);
      return { configured: true, authenticated, reason: authenticated ? null : 'not_connected', redirectUri, requiresClientConfiguration: false };
    } catch {
      return { configured: true, authenticated: false, reason: 'credential_store_unavailable', redirectUri, requiresClientConfiguration: false };
    }
  }

  async function capabilities() {
    const connection = await status();
    let scopes = new Set();
    if (connection.authenticated) {
      try { scopes = new Set(String((await loadCredentials())?.scope ?? SCOPES.join(' ')).split(/\s+/).filter(Boolean)); }
      catch { /* status already reports credential storage errors */ }
    }
    const authenticated = connection.authenticated === true;
    return {
      ...connection,
      scopes: [...scopes],
      canReadDocs: authenticated && scopes.has('https://www.googleapis.com/auth/documents'),
      canSuggestDocs: authenticated && scopes.has('https://www.googleapis.com/auth/documents'),
      canDirectEditDocs: authenticated && scopes.has('https://www.googleapis.com/auth/documents'),
      canInsertDocs: authenticated && scopes.has('https://www.googleapis.com/auth/documents'),
      canCreateNoteDocs: authenticated && scopes.has('https://www.googleapis.com/auth/documents'),
      canCommentDocs: authenticated && (scopes.has('https://www.googleapis.com/auth/drive.file') || scopes.has('https://www.googleapis.com/auth/drive')),
      canReply: authenticated && (scopes.has('https://www.googleapis.com/auth/drive.file') || scopes.has('https://www.googleapis.com/auth/drive')),
      canReadSheets: authenticated && (scopes.has('https://www.googleapis.com/auth/drive.readonly') || scopes.has('https://www.googleapis.com/auth/spreadsheets.readonly') || scopes.has('https://www.googleapis.com/auth/spreadsheets') || scopes.has('https://www.googleapis.com/auth/drive')),
      canWriteSheets: authenticated && (scopes.has('https://www.googleapis.com/auth/spreadsheets') || scopes.has('https://www.googleapis.com/auth/drive.file') || scopes.has('https://www.googleapis.com/auth/drive')),
      ...(lastServiceApiError ? { serviceApiError: lastServiceApiError } : {}),
    };
  }

  async function requireSheetCapability(write = false) {
    const state = await capabilities();
    if (!state.configured || !state.authenticated) throw safeError('Google is not connected.', 'GOOGLE_NOT_CONNECTED', 401);
    if (!(write ? state.canWriteSheets : state.canReadSheets)) throw safeError(write
      ? 'Google Sheets write access is not authorized. Start an explicit Sheets-enabled Google connection first.'
      : 'Google Sheets read access is not authorized for this connection.', 'GOOGLE_SHEETS_SCOPE_REQUIRED', 403);
  }

  async function listSpreadsheets({ query = '', pageToken = '', pageSize = 20 } = {}) {
    await requireSheetCapability(false);
    if (typeof query !== 'string' || query.length > 100) throw safeError('Google Sheets search text is invalid.', 'GOOGLE_QUERY_INVALID');
    if (typeof pageToken !== 'string' || pageToken.length > 4096 || /[\u0000-\u001f]/.test(pageToken)) throw safeError('Google Sheets page token is invalid.', 'GOOGLE_PAGE_TOKEN_INVALID');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 30) throw safeError('Google Sheets page size is invalid.', 'GOOGLE_PAGE_SIZE_INVALID');
    const filters = [`mimeType = '${GOOGLE_SPREADSHEET_MIME}'`, 'trashed = false'];
    const needle = query.trim();
    if (needle) filters.push(`name contains '${needle.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const url = new URL(DRIVE);
    url.searchParams.set('q', filters.join(' and '));
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await apiRequest(url);
    const files = (Array.isArray(page.files) ? page.files : []).flatMap(file => file?.mimeType === GOOGLE_SPREADSHEET_MIME && typeof file.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(file.id)
      ? [{ id: file.id, title: typeof file.name === 'string' ? file.name.slice(0, 1024) : '', modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : '' }]
      : []);
    return { files, nextPageToken: typeof page.nextPageToken === 'string' && page.nextPageToken.length <= 4096 ? page.nextPageToken : '' };
  }

  async function getSpreadsheetMetadata(spreadsheetId) {
    if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(spreadsheetId)) throw safeError('A valid Google spreadsheet ID is required.', 'GOOGLE_SPREADSHEET_ID_INVALID');
    const url = new URL(`${GOOGLE_SHEETS_API}/${encodeURIComponent(spreadsheetId)}`);
    url.searchParams.set('fields', 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))');
    const metadata = await apiRequest(url);
    if (metadata.spreadsheetId !== spreadsheetId) throw safeError('Google returned metadata for a different spreadsheet.', 'GOOGLE_SPREADSHEET_MISMATCH', 409);
    return { spreadsheetId, title: metadata.properties?.title ?? '', sheets: (metadata.sheets ?? []).map(sheet => ({ sheetId: sheet.properties?.sheetId, title: sheet.properties?.title ?? '', index: sheet.properties?.index, gridProperties: sheet.properties?.gridProperties ?? {} })) };
  }

  async function readSpreadsheet({ spreadsheetId, range } = {}) {
    await requireSheetCapability(false);
    const bounds = parseBoundedA1Range(range);
    const metadata = await getSpreadsheetMetadata(spreadsheetId);
    const response = await apiRequest(sheetValuesUrl(spreadsheetId, range, { valueRenderOption: 'FORMULA', dateTimeRenderOption: 'SERIAL_NUMBER' }));
    const values = padGrid(response.values, bounds);
    return { ...metadata, range, valueRenderOption: 'FORMULA', values, valueHash: stableGridHash(values), cellCount: bounds.cells };
  }

  async function updateSpreadsheet({ spreadsheetId, range, beforeValues, beforeHash, values, operationId } = {}) {
    await requireSheetCapability(true);
    const afterValues = validateWriteGrid(range, values);
    const originalValues = normalizeGrid(beforeValues);
    if (stableGridHash(originalValues) !== beforeHash) throw safeError('The queued before-values do not match their hash. Reload the spreadsheet before applying.', 'GOOGLE_SHEET_PROPOSAL_INVALID', 409);
    if (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 200) throw safeError('A unique operationId is required.', 'GOOGLE_OPERATION_ID_INVALID');
    const signature = sha256(JSON.stringify({ spreadsheetId, range, beforeHash, afterValues }));
    const prior = await readJournal(operationId);
    if (prior) {
      if (prior.signature !== signature || prior.spreadsheetId !== spreadsheetId || prior.range !== range) throw safeError('This operationId was already used for different Google Sheets values.', 'GOOGLE_OPERATION_ID_REUSED', 409);
      if (prior.state === 'succeeded') return prior.result;
      if (prior.state === 'outcome_unknown' || prior.state === 'started' || prior.state === 'needs_review') {
        const current = await readSpreadsheet({ spreadsheetId, range });
        if (stableGridHash(current.values) === prior.afterHash) {
          prior.state = 'succeeded';
          prior.result = { operationId, spreadsheetId, range, valueHash: prior.afterHash, verified: true, atomicRevisionGuard: false, warning: 'Google Sheets values.update has no atomic revision guard; readback confirms current values only.' };
          prior.completedAt = new Date().toISOString();
          await writeSpreadsheetJournal(operationId, prior);
          await releaseSpreadsheetLock(spreadsheetId, operationId);
          return prior.result;
        }
        throw safeError('The previous Sheets write outcome cannot be proven from readback. No retry was sent; inspect the range and operation record.', 'GOOGLE_SHEET_OUTCOME_UNKNOWN', 409);
      }
      if (prior.state === 'conflict') throw safeError('The spreadsheet values changed after this proposal was prepared.', 'GOOGLE_SHEET_CONFLICT', 409);
      if (prior.state === 'rejected') throw safeError('This Sheets operation was rejected and was not retried.', 'GOOGLE_OPERATION_REJECTED', 400);
    }
    const activeKey = `${path.resolve(dataDir)}:${sha256(`sheets:${spreadsheetId}`)}`;
    if (activeSpreadsheetRuns.has(activeKey)) throw safeError('A Google Sheets write is already active for this spreadsheet.', 'GOOGLE_SHEET_OPERATION_ACTIVE', 409);
    activeSpreadsheetRuns.set(activeKey, operationId);
    const lockPath = spreadsheetLockPath(spreadsheetId);
    let lockAcquired = false;
    let writeAttempted = false;
    const entry = { operationId, signature, kind: 'sheets_update', spreadsheetId, range, beforeHash, afterHash: stableGridHash(afterValues), state: 'started', createdAt: new Date().toISOString() };
    try {
      await ensurePrivateDir();
      let handle;
      try { handle = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw safeError('A previous Google Sheets operation still holds the spreadsheet lock. Reconcile its operation record before continuing.', 'GOOGLE_SHEET_OPERATION_PENDING', 409);
        throw error;
      }
      try { await handle.writeFile(JSON.stringify(await encryptValue({ operationId, spreadsheetId, state: 'started' }))); await handle.sync(); }
      catch (error) { await handle.close(); throw error; }
      await handle.close();
      lockAcquired = true;
      const before = await readSpreadsheet({ spreadsheetId, range });
      if (stableGridHash(before.values) !== beforeHash) {
        entry.state = 'conflict';
        await writeSpreadsheetJournal(operationId, entry);
        await releaseSpreadsheetLock(spreadsheetId, operationId);
        throw safeError('The spreadsheet values changed after this proposal was prepared.', 'GOOGLE_SHEET_CONFLICT', 409);
      }
      if (containsFormula(before.values)) throw safeError('This bounded range contains formula cells. Narrow the update to text-only cells so RAW values do not replace formulas.', 'GOOGLE_SHEET_FORMULA_UNSUPPORTED', 409);
      await writeSpreadsheetJournal(operationId, entry);
      entry.state = 'outcome_unknown';
      entry.requestStartedAt = new Date().toISOString();
      await writeSpreadsheetJournal(operationId, entry);
      let response;
      try {
        writeAttempted = true;
        response = await apiRequest(sheetValuesUrl(spreadsheetId, range, { valueInputOption: 'RAW' }), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values: afterValues }) });
      } catch (error) {
        if (error.code !== 'GOOGLE_NETWORK_UNKNOWN') {
          entry.state = error.status === 409 ? 'conflict' : 'rejected';
          await writeSpreadsheetJournal(operationId, entry);
          if (lockAcquired && entry.state !== 'outcome_unknown') await releaseSpreadsheetLock(spreadsheetId, operationId);
        }
        throw error;
      }
      entry.updatedCells = response.updatedCells ?? null;
      const after = await readSpreadsheet({ spreadsheetId, range });
      if (stableGridHash(after.values) !== entry.afterHash) {
        entry.state = 'needs_review';
        await writeSpreadsheetJournal(operationId, entry);
        throw safeError('Google acknowledged the Sheets write, but readback did not match the proposed values. Inspect the range before continuing.', 'GOOGLE_SHEET_VERIFICATION_FAILED', 409);
      }
      entry.state = 'succeeded';
      entry.result = { operationId, spreadsheetId, range, valueHash: entry.afterHash, updatedCells: entry.updatedCells, verified: true, atomicRevisionGuard: false, warning: 'Google Sheets values.update has no atomic revision guard; the pre-write hash check can race with another editor. Readback verifies the saved values, not who wrote them.' };
      entry.completedAt = new Date().toISOString();
      await writeSpreadsheetJournal(operationId, entry);
      await releaseSpreadsheetLock(spreadsheetId, operationId);
      return entry.result;
    } catch (error) {
      if (lockAcquired && !writeAttempted) await releaseSpreadsheetLock(spreadsheetId, operationId);
      throw error;
    } finally {
      activeSpreadsheetRuns.delete(activeKey);
    }
  }

  async function disconnect() {
    credentialsCache = null;
    await ensurePrivateDir();
    const file = credentialPath;
    try {
      const bytes = await readFile(file);
      await writeFile(file, randomBytes(bytes.length), { mode: 0o600 });
      const { unlink } = await import('node:fs/promises');
      await unlink(file);
    } catch (error) { if (error.code !== 'ENOENT') throw safeError('Cannot remove Google credentials.', 'GOOGLE_STORAGE_UNAVAILABLE', 500); }
    return { disconnected: true };
  }

  async function performWrite(kind, payload) {
    if (!payload || typeof payload.operationId !== 'string' || payload.operationId.length < 8 || payload.operationId.length > 200) throw safeError('A unique operationId is required.', 'GOOGLE_OPERATION_ID_INVALID');
    if (typeof payload.documentId !== 'string' || !payload.documentId.trim() || payload.documentId.length > 512) throw safeError('A valid Google document ID is required.', 'GOOGLE_DOCUMENT_ID_INVALID');
    const operationId = payload.operationId;
    const signature = sha256(JSON.stringify({ kind, payload }));
    const prior = await readJournal(operationId);
    if (prior) {
      if (prior.state === 'author_reviewed') throw safeError('This operation was manually reviewed and cannot be retried. Use a new operationId and the current document revision.', 'GOOGLE_OPERATION_RECONCILED', 409);
      if (prior.signature !== signature) throw safeError('This operationId is already bound to different content.', 'GOOGLE_OPERATION_ID_REUSED', 409);
      if (prior.state === 'succeeded') return prior.result;
      if (prior.state === 'outcome_unknown' || prior.state === 'started') throw safeError('The previous operation outcome is unknown. Inspect the Google document before any new operation.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
      if (prior.state === 'needs_review') throw safeError('A native suggestion may be only partially complete. Inspect it in Google Docs before starting another operation.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
      if (prior.state === 'conflict') throw safeError('This operation conflicted with the Google document revision. Reload before preparing a new operation.', 'GOOGLE_REVISION_CONFLICT', 409);
      if (prior.state === 'rejected') throw safeError('This operation was rejected by Google and was not retried.', 'GOOGLE_OPERATION_REJECTED', 400);
    }
    if (pendingOps.has(operationId)) return pendingOps.get(operationId);
    const run = (async () => {
      const entry = { operationId, signature, kind, documentId: payload.documentId, state: 'started', createdAt: new Date().toISOString() };
      const runKey = getDocumentRunKey(entry.documentId);
      if (activeDocumentRuns.has(runKey)) throw safeError('The Google document operation is still active.', 'GOOGLE_OPERATION_ACTIVE', 409);
      activeDocumentRuns.set(runKey, operationId);
      let reservationAcquired = false;
      try {
        await reserveDocument(entry);
        reservationAcquired = true;
        await writeJournal(operationId, entry);
        const before = await readDocument(payload.documentId);
        if (before.revisionId !== payload.revisionId) {
          entry.state = 'conflict';
          await writeJournal(operationId, entry);
          throw safeError('The Google document changed. Reload it before preparing this operation.', 'GOOGLE_REVISION_CONFLICT', 409);
        }
        const tab = before.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
        if (!tab) throw safeError('The requested Google Docs tab was not found.', 'GOOGLE_TAB_NOT_FOUND', 409);
        const originalStyle = validateRange(tab, payload.tabId ?? '', payload.startIndex, payload.endIndex, payload.quote, before.raw.document);
        const requests = kind === 'suggest'
          ? [
              { deleteContentRange: { range: { startIndex: payload.startIndex, endIndex: payload.endIndex, ...(payload.tabId ? { tabId: payload.tabId } : {}) } } },
              { insertText: { location: { index: payload.startIndex, ...(payload.tabId ? { tabId: payload.tabId } : {}) }, text: payload.replacement } },
            ]
          : [{ insertComment: { content: payload.text, range: { startIndex: payload.startIndex, endIndex: payload.endIndex, ...(payload.tabId ? { tabId: payload.tabId } : {}) } } }];
        // The write journal is durable before the API call. Any lost response is unknown and never retried.
        entry.state = 'outcome_unknown';
        entry.phase = kind === 'suggest' ? 'insert' : 'write';
        entry.requestStartedAt = new Date().toISOString();
        await writeJournal(operationId, entry);
        let response;
        try {
          response = await apiRequest(`${DOCS}/${encodeURIComponent(payload.documentId)}:batchUpdate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requests, writeControl: { requiredRevisionId: payload.revisionId, ...(kind === 'suggest' ? { writeMode: 'SUGGEST' } : {}) } }),
          });
        } catch (error) {
          if (error.code === 'GOOGLE_REVISION_CONFLICT') {
            entry.state = 'conflict';
            await writeJournal(operationId, entry);
          } else if (kind === 'suggest') {
            entry.state = 'outcome_unknown';
            entry.requiresReview = true;
            entry.phase = 'insert_outcome_unknown';
            await writeJournal(operationId, entry);
          }
          throw error;
        }
        let after;
        let result;
        if (kind === 'suggest') {
          if (response.commentUpdateState && response.commentUpdateState !== 'ALL_SAVED') {
            entry.state = 'needs_review';
            entry.phase = 'insert_save_unconfirmed';
            await writeJournal(operationId, entry);
            throw safeError('The native suggestion may be partially saved. Inspect it in Google Docs before continuing.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
          }
          const afterInsert = await readDocument(payload.documentId);
          const insertion = verifyInsertion(before, afterInsert, payload, response);
          if (!insertion || !afterInsert.revisionId) {
            entry.state = 'needs_review';
            entry.phase = 'insert_verification_failed';
            await writeJournal(operationId, entry);
            throw safeError('A native suggestion may be present, but its text, range, or surrounding structure could not be verified. Inspect it in Google Docs.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
          }
          entry.insertionSuggestionIds = insertion.suggestionIds;
          entry.insertionRange = insertion.range;
          entry.phase = 'style';
          entry.state = 'outcome_unknown';
          entry.styleRequestStartedAt = new Date().toISOString();
          await writeJournal(operationId, entry);
          let styleResponse;
          try {
            styleResponse = await apiRequest(`${DOCS}/${encodeURIComponent(payload.documentId)}:batchUpdate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                requests: [{ updateTextStyle: {
                  range: { ...insertion.range, ...(payload.tabId ? { tabId: payload.tabId } : {}) },
                  textStyle: originalStyle,
                  fields: '*',
                } }],
                writeControl: { requiredRevisionId: afterInsert.revisionId, writeMode: 'SUGGEST' },
              }),
            });
          } catch (error) {
            entry.state = 'outcome_unknown';
            entry.requiresReview = true;
            entry.phase = 'style_outcome_unknown';
            await writeJournal(operationId, entry);
            throw safeError('The text suggestion exists, but its style suggestion outcome is unknown. Inspect the proposal in Google Docs before continuing.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
          }
          if (styleResponse.commentUpdateState && styleResponse.commentUpdateState !== 'ALL_SAVED') {
            entry.state = 'needs_review';
            entry.phase = 'style_save_unconfirmed';
            await writeJournal(operationId, entry);
            throw safeError('The text suggestion exists, but Google did not confirm its style suggestion. Inspect it in Google Docs.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
          }
          after = await readDocument(payload.documentId);
          result = verifyStyledSuggestion(afterInsert, after, payload, originalStyle, insertion);
          if (!result) {
            entry.state = 'needs_review';
            entry.phase = 'style_verification_failed';
            await writeJournal(operationId, entry);
            throw safeError('The text suggestion exists, but its style or surrounding structure could not be verified. Inspect it in Google Docs.', 'GOOGLE_SUGGESTION_NEEDS_REVIEW', 409);
          }
        } else {
          if (response.commentUpdateState === 'ALL_FAILED_UNKNOWN_REASON' || (response.commentUpdateState && response.commentUpdateState !== 'ALL_SAVED')) {
            await writeJournal(operationId, entry);
            throw safeError('Google did not confirm that the comment was saved.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          }
          after = await readDocument(payload.documentId);
          result = verifyComment(after, payload, response);
        }
        if (!result) {
          await writeJournal(operationId, entry);
          throw safeError('Google returned success, but the saved operation could not be verified.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
        }
        entry.state = 'succeeded';
        entry.result = { ...result, revisionId: after.revisionId, nativeVisualValidated: false };
        entry.completedAt = new Date().toISOString();
        await writeJournal(operationId, entry);
        return entry.result;
      } catch (error) {
        if (reservationAcquired && entry.state === 'started') {
          entry.state = 'rejected';
          await writeJournal(operationId, entry);
        }
        throw error;
      } finally {
        if (activeDocumentRuns.get(runKey) === operationId) activeDocumentRuns.delete(runKey);
      }
    })();
    pendingOps.set(operationId, run);
    try { return await run; }
    finally { pendingOps.delete(operationId); }
  }

  function reviewValue(kind, before, after, extras = {}) {
    return { kind, before, after, ...extras };
  }

  function hashCommentThread(thread) {
    return sha256(JSON.stringify(stableValue({
      id: thread.id ?? thread.commentId ?? '',
      content: thread.content ?? '',
      resolved: thread.resolved === true,
      anchor: thread.anchor ?? null,
      quotedFileContent: thread.quotedFileContent ?? null,
      replies: (thread.replies ?? []).map(reply => ({ id: reply.id ?? '', content: reply.content ?? '', action: reply.action ?? '', createdTime: reply.createdTime ?? '', modifiedTime: reply.modifiedTime ?? '' })).sort((a, b) => a.id.localeCompare(b.id)),
    })));
  }

  function sameReview(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function bodyText(document, tabId) {
    const entry = getTabEntries(document.raw.document).find((item) => item.tabId === (tabId ?? ''));
    return entry ? flattenTab(entry.documentTab).text : null;
  }

  function checkInsertion(document, tabId, index) {
    if (!Number.isInteger(index) || index < 0) throw safeError('Google Docs insertion index is invalid.', 'GOOGLE_RANGE_INVALID');
    const tab = document.tabs.find((candidate) => candidate.tabId === (tabId ?? ''));
    if (!tab) throw safeError('The requested Google Docs tab was not found.', 'GOOGLE_TAB_NOT_FOUND', 409);
    const segments = tab.segments.filter((part) => part.segmentId === '' && part.startIndex != null && part.endIndex != null);
    const segment = segments.find((part) => index >= part.startIndex && index <= part.endIndex);
    if (!segment || !['textRun'].includes(segment.kind)) throw safeError('The insertion point is not plain document text.', 'GOOGLE_MIXED_STRUCTURE', 409);
    if (segment.suggestedInsertionIds.length || segment.suggestedDeletionIds.length || Object.keys(segment.suggestedTextStyleChanges).length) throw safeError('The insertion point overlaps a pending suggestion.', 'GOOGLE_PENDING_SUGGESTION', 409);
    const local = index - segment.startIndex;
    const left = segment.text.charCodeAt(local - 1), right = segment.text.charCodeAt(local);
    if (left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF) throw safeError('The insertion point splits a UTF-16 surrogate pair.', 'GOOGLE_RANGE_INVALID', 409);
    if (findProtectedOverlap(document.raw.document, tabId ?? '', index, index + 1)) throw safeError('The insertion point touches protected content.', 'GOOGLE_PROTECTED_RANGE', 409);
    const style = segment.style ?? {};
    if (Object.keys(style).some((key) => !TEXT_STYLE_FIELDS.includes(key))) throw safeError('The insertion point uses a style that cannot be preserved safely.', 'GOOGLE_STYLE_UNSUPPORTED', 409);
    const offset = segment.textOffset + local;
    return { style: JSON.parse(JSON.stringify(style)), text: tab.text, offset };
  }

  async function stageProduct(kind, payload) {
    const currentCapabilities = await capabilities();
    if (kind === 'reply') {
      if (!currentCapabilities.canReply) throw safeError('Google reply requires an explicitly granted Drive file or Drive scope. Reconnect with the optional reply permission.', 'GOOGLE_REPLY_SCOPE_REQUIRED', 403);
      const read = await readDocument(payload.documentId);
      const thread = read.comments.find((comment) => (comment.id ?? comment.commentId) === payload.commentId);
      if (!thread || thread.deleted) throw safeError('The requested Google comment thread was not found.', 'GOOGLE_COMMENT_NOT_FOUND', 409);
      const commentText = typeof thread.content === 'string' ? thread.content : '';
      const commentHash = hashCommentThread(thread);
      if (commentHash !== payload.commentHash) throw safeError('The Google comment changed since it was read. Reload the full thread before staging a reply.', 'GOOGLE_COMMENT_CONFLICT', 409);
      return { review: reviewValue(kind, commentText, payload.text, { documentTitle: read.title, commentText, commentHash }), summary: `Google Docs reply: ${read.title}` };
    }
    if (kind === 'create_note') {
      if (!currentCapabilities.canCreateNoteDocs) throw safeError('Google Docs note creation requires the Docs scope.', 'GOOGLE_SCOPE_REQUIRED', 403);
      return { review: reviewValue(kind, null, googleNoteBody(payload)), summary: `Google Docs source note: ${payload.title}` };
    }
    if (!currentCapabilities.canReadDocs) throw safeError('Google Docs access requires the Docs scope.', 'GOOGLE_SCOPE_REQUIRED', 403);
    const read = await readDocument(payload.documentId);
    if (read.revisionId !== payload.revisionId) throw safeError('The Google document changed. Reload it before staging this operation.', 'GOOGLE_REVISION_CONFLICT', 409);
    const tab = read.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
    if (!tab) throw safeError('The requested Google Docs tab was not found.', 'GOOGLE_TAB_NOT_FOUND', 409);
    if (kind === 'direct_edit') {
      if (!payload.replacement || /[\r\n]/.test(payload.replacement)) throw safeError('A non-empty single-paragraph direct replacement is required.', 'GOOGLE_REPLACEMENT_INVALID');
      validateRange(tab, payload.tabId ?? '', payload.startIndex, payload.endIndex, payload.quote, read.raw.document);
      return { review: reviewValue(kind, payload.quote, payload.replacement, { documentTitle: read.title }), summary: `Google Docs direct edit: ${read.title}` };
    }
    const anchor = checkInsertion(read, payload.tabId ?? '', payload.index);
    return { review: reviewValue(kind, '', payload.text, { documentTitle: read.title, anchor: { index: payload.index, tabId: payload.tabId, before: anchor.text.slice(Math.max(0, anchor.offset - 40), anchor.offset), after: anchor.text.slice(anchor.offset, anchor.offset + 40) } }), summary: `Google Docs text insertion: ${read.title}` };
  }

  async function acquireProductLock(operationId) {
    await ensurePrivateDir();
    const file = path.join(journalDir, `${sha256(`product:${operationId}`)}.oplock`);
    let handle;
    try { handle = await open(file, 'wx', 0o600); await handle.writeFile(operationId); await handle.sync(); }
    catch (error) {
      if (error.code === 'EEXIST') throw safeError('This Google operation is already active or unresolved; inspect Google before retrying.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
      throw error;
    } finally { await handle?.close(); }
    return file;
  }

  async function applyProduct(kind, queued) {
    const { _review: suppliedReview, ...payload } = queued ?? {};
    if (!suppliedReview || typeof payload.operationId !== 'string' || payload.operationId.length < 1 || payload.operationId.length > 512) throw safeError('The queued Google product review or operationId is invalid.', 'GOOGLE_PRODUCT_INVALID');
    const prepared = await stageProduct(kind, payload);
    if (!sameReview(prepared.review, suppliedReview)) throw safeError('The Google document or comment changed after staging. Reopen and review the current product.', 'GOOGLE_REVIEW_CHANGED', 409);
    const operationId = payload.operationId;
    const signature = sha256(JSON.stringify({ kind, payload, review: suppliedReview }));
    const prior = await readJournal(operationId);
    if (prior) {
      if (prior.signature !== signature) throw safeError('This operationId is already bound to different content.', 'GOOGLE_OPERATION_ID_REUSED', 409);
      if (prior.state === 'succeeded') return prior.result;
      throw safeError('The previous Google operation is unresolved or terminal. Inspect its journal and Google state; it will not be retried.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
    }
    const opLock = await acquireProductLock(operationId);
    const entry = { operationId, kind, signature, documentId: payload.documentId ?? '', state: 'started', createdAt: new Date().toISOString(), ...(kind === 'create_note' ? { canonStatus: 'draft', noteTitle: payload.title, sourceUrl: payload.sourceUrl ?? null, sourceTabOrRange: payload.sourceTabOrRange ?? null, sourceRevision: payload.sourceRevision ?? null } : {}) };
    const journalPath = path.join(journalDir, `${sha256(operationId)}.enc`);
    let documentLocked = false;
    try {
      await saveEncrypted(journalPath, entry);
      if (kind !== 'create_note') {
        await reserveDocument(entry);
        documentLocked = true;
      }
      let result;
      if (kind === 'create_note') {
        entry.state = 'outcome_unknown'; entry.phase = 'create_document'; entry.requestStartedAt = new Date().toISOString(); await saveEncrypted(journalPath, entry);
        const created = await apiRequest(`${DOCS}?fields=documentId,title`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: payload.title }) });
        if (typeof created.documentId !== 'string' || !created.documentId) throw safeError('Google created a note but returned no document ID; inspect Drive before any retry.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
        entry.documentId = created.documentId; entry.phase = 'blank_document_created'; await saveEncrypted(journalPath, entry);
        const content = googleNoteBody(payload);
        entry.phase = 'populate_document'; entry.state = 'outcome_unknown'; entry.requestStartedAt = new Date().toISOString(); await saveEncrypted(journalPath, entry);
        try {
          await apiRequest(`${DOCS}/${encodeURIComponent(created.documentId)}:batchUpdate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }) });
        } catch {
          throw safeError(`A blank draft note was created, but its content could not be confirmed. Inspect Google Doc ${created.documentId} before any retry.`, 'GOOGLE_NOTE_PARTIAL', 409);
        }
        const after = await readDocument(created.documentId);
        if (!after.text.includes(content) || !after.revisionId) throw safeError('The draft note document exists, but its content could not be verified; inspect it before any retry.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
        result = { documentId: created.documentId, title: after.title, revisionId: after.revisionId, body: content, state: 'draft', verified: true };
      } else if (kind === 'reply') {
        const before = await readDocument(payload.documentId);
        const thread = before.comments.find((comment) => (comment.id ?? comment.commentId) === payload.commentId);
        if (!thread || hashCommentThread(thread) !== payload.commentHash) throw safeError('The Google comment thread changed after staging; no reply was written.', 'GOOGLE_COMMENT_CONFLICT', 409);
        const url = `${DRIVE}/${encodeURIComponent(payload.documentId)}/comments/${encodeURIComponent(payload.commentId)}/replies?fields=id,content,createdTime`;
        entry.state = 'outcome_unknown'; entry.phase = 'reply'; entry.requestStartedAt = new Date().toISOString(); await writeJournal(operationId, entry);
        const reply = await apiRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: payload.text }) });
        const after = await readDocument(payload.documentId);
        const savedThread = after.comments.find((comment) => (comment.id ?? comment.commentId) === payload.commentId);
        const saved = (savedThread?.replies ?? []).find((item) => item.id === reply.id && item.content === payload.text);
        if (!saved) throw safeError('Google returned a reply response, but the exact saved thread reply could not be verified.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
        result = { documentId: payload.documentId, commentId: payload.commentId, replyId: saved.id, text: saved.content, revisionId: after.revisionId, verified: true };
      } else {
        const before = await readDocument(payload.documentId);
        if (before.revisionId !== payload.revisionId) throw safeError('The Google document changed after staging; no write was made.', 'GOOGLE_REVISION_CONFLICT', 409);
        const tab = before.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
        if (!tab) throw safeError('The requested Google Docs tab was not found.', 'GOOGLE_TAB_NOT_FOUND', 409);
        let request, expectedText, expectedStyle = null;
        if (kind === 'direct_edit') {
          const style = validateRange(tab, payload.tabId ?? '', payload.startIndex, payload.endIndex, payload.quote, before.raw.document);
          expectedStyle = style;
          if (!payload.replacement || /[\r\n]/.test(payload.replacement)) throw safeError('A non-empty single-paragraph direct replacement is required.', 'GOOGLE_REPLACEMENT_INVALID');
          const requests = [
            { deleteContentRange: { range: { startIndex: payload.startIndex, endIndex: payload.endIndex, ...(payload.tabId ? { tabId: payload.tabId } : {}) } } },
            { insertText: { location: { index: payload.startIndex, ...(payload.tabId ? { tabId: payload.tabId } : {}) }, text: payload.replacement } },
          ];
          if (Object.keys(style).length) requests.push({ updateTextStyle: { range: { startIndex: payload.startIndex, endIndex: payload.startIndex + payload.replacement.length, ...(payload.tabId ? { tabId: payload.tabId } : {}) }, textStyle: style, fields: '*' } });
          request = requests;
          expectedText = null;
        } else {
          checkInsertion(before, payload.tabId ?? '', payload.index);
          request = [{ insertText: { location: { index: payload.index, ...(payload.tabId ? { tabId: payload.tabId } : {}) }, text: payload.text } }];
        }
        entry.state = 'outcome_unknown'; entry.phase = kind; entry.requestStartedAt = new Date().toISOString(); await writeJournal(operationId, entry);
        await apiRequest(`${DOCS}/${encodeURIComponent(payload.documentId)}:batchUpdate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests: request, writeControl: { requiredRevisionId: payload.revisionId } }) });
        const after = await readDocument(payload.documentId);
        const afterTab = after.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
        if (!afterTab || after.tabs.length !== before.tabs.length) throw safeError('The Google document structure changed unexpectedly and could not be verified.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
        const oldRawTab = getTabEntries(before.raw.document).find((candidate) => candidate.tabId === (payload.tabId ?? ''));
        const newRawTab = getTabEntries(after.raw.document).find((candidate) => candidate.tabId === (payload.tabId ?? ''));
        if (kind === 'insert') {
          const offsetSegment = tab.segments.find((part) => part.startIndex <= payload.index && part.endIndex >= payload.index);
          const offset = offsetSegment.textOffset + payload.index - offsetSegment.startIndex;
          if (afterTab.text !== tab.text.slice(0, offset) + payload.text + tab.text.slice(offset)) throw safeError('The inserted text or unaffected document content failed readback verification.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          const project = (tokens, start, end) => tokens.filter((token) => !(token.kind === 'text' && token.index >= start && token.index < end)).map(({ index, ...token }) => token);
          if (!oldRawTab || !newRawTab || !sameValue(bodyTokens(oldRawTab.documentTab.body?.content).map(({ index, ...token }) => token), project(bodyTokens(newRawTab.documentTab.body?.content), payload.index, payload.index + payload.text.length))) throw safeError('The inserted text changed surrounding document structure.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          result = { documentId: payload.documentId, tabId: payload.tabId, index: payload.index, text: payload.text, revisionId: after.revisionId, verified: true };
        } else {
          const startSegment = tab.segments.find((part) => part.startIndex <= payload.startIndex && part.endIndex >= payload.startIndex);
          const endSegment = tab.segments.find((part) => part.startIndex <= payload.endIndex && part.endIndex >= payload.endIndex);
          const from = startSegment.textOffset + payload.startIndex - startSegment.startIndex;
          const to = endSegment.textOffset + payload.endIndex - endSegment.startIndex;
          expectedText = tab.text.slice(0, from) + payload.replacement + tab.text.slice(to);
          if (afterTab.text !== expectedText) throw safeError('The direct edit or unaffected document content failed readback verification.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          const project = (tokens, start, end) => tokens.filter((token) => !(token.kind === 'text' && token.index >= start && token.index < end)).map(({ index, ...token }) => token);
          if (!oldRawTab || !newRawTab || !sameValue(project(bodyTokens(oldRawTab.documentTab.body?.content), payload.startIndex, payload.endIndex), project(bodyTokens(newRawTab.documentTab.body?.content), payload.startIndex, payload.startIndex + payload.replacement.length))) throw safeError('The direct edit changed document structure or content outside the selected range.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          const newRange = afterTab.segments.filter((part) => part.segmentId === '' && part.startIndex != null && part.endIndex != null && part.startIndex < payload.startIndex + payload.replacement.length && part.endIndex > payload.startIndex);
          const writtenText = newRange.map((part) => part.text.slice(Math.max(payload.startIndex, part.startIndex) - part.startIndex, Math.min(payload.startIndex + payload.replacement.length, part.endIndex) - part.startIndex)).join('');
          if (!newRange.length || writtenText !== payload.replacement || newRange.some((part) => !styleMatchesSource(expectedStyle, null, part.style))) throw safeError('The direct edit text style could not be verified.', 'GOOGLE_OUTCOME_UNKNOWN', 409);
          result = { documentId: payload.documentId, tabId: payload.tabId, quote: payload.quote, replacement: payload.replacement, revisionId: after.revisionId, verified: true, nativeVisualValidated: false };
        }
      }
      entry.state = 'succeeded'; entry.result = result; entry.completedAt = new Date().toISOString();
      if (documentLocked) await writeJournal(operationId, entry); else await saveEncrypted(journalPath, entry);
      return result;
    } catch (error) {
      if (entry.state === 'started') { entry.state = 'rejected'; if (documentLocked) await writeJournal(operationId, entry); else await saveEncrypted(journalPath, entry); }
      throw error;
    } finally {
      if (documentLocked) {
        const file = documentLockPath(payload.documentId);
        const lock = await readEncryptedFile(file);
        if (lock?.operationId === operationId && entry.state === 'succeeded') { const { unlink } = await import('node:fs/promises'); await unlink(file).catch(() => {}); }
      }
      if (entry.state === 'succeeded' || entry.state === 'rejected' || entry.state === 'conflict') { const { unlink } = await import('node:fs/promises'); await unlink(opLock).catch(() => {}); }
    }
  }


  function verifyInsertion(before, after, payload, response) {
    const oldTab = before.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
    const newTab = after.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
    if (!oldTab || !newTab) return null;
    const previousIds = new Set((before.raw.document.suggestions ?? []).map((item) => item.suggestionId).filter(Boolean));
    const apiCreatedIds = new Set((response.suggestionResponses ?? []).flatMap((item) => item.createdSuggestionIds ?? []));
    const newSuggestionIds = new Set(apiCreatedIds.size ? apiCreatedIds : (after.raw.document.suggestions ?? []).map((item) => item.suggestionId).filter((id) => id && !previousIds.has(id)));
    for (const segment of newTab.segments) {
      for (const id of [...segment.suggestedInsertionIds, ...segment.suggestedDeletionIds]) {
        if (!(oldTab.segments ?? []).some((old) => old.suggestedInsertionIds.includes(id) || old.suggestedDeletionIds.includes(id))) newSuggestionIds.add(id);
      }
    }
    if (!newSuggestionIds.size) return null;
    const insertedSegments = newTab.segments.filter((segment) => segment.segmentId === '' && segment.suggestedInsertionIds.some((id) => newSuggestionIds.has(id)));
    const deletedSegments = newTab.segments.filter((segment) => segment.segmentId === '' && segment.suggestedDeletionIds.some((id) => newSuggestionIds.has(id)));
    if (insertedSegments.map((segment) => segment.text).join('') !== payload.replacement || deletedSegments.map((segment) => segment.text).join('') !== payload.quote) return null;
    const ordered = [...insertedSegments].sort((a, b) => a.startIndex - b.startIndex);
    if (!ordered.length || ordered.some((segment) => segment.startIndex == null || segment.endIndex == null || segment.endIndex - segment.startIndex !== segment.text.length || segment.structure !== ordered[0].structure)) return null;
    for (let i = 1; i < ordered.length; i++) if (ordered[i - 1].endIndex !== ordered[i].startIndex) return null;
    const range = { startIndex: ordered[0].startIndex, endIndex: ordered.at(-1).endIndex };
    if (range.endIndex - range.startIndex !== payload.replacement.length) return null;

    const oldBodySegments = oldTab.segments.filter((segment) => segment.segmentId === '');
    const newBodySegments = newTab.segments.filter((segment) => segment.segmentId === '');
    const startSegment = oldBodySegments.find((segment) => segment.startIndex <= payload.startIndex && segment.endIndex >= payload.startIndex);
    const endSegment = oldBodySegments.find((segment) => segment.startIndex <= payload.endIndex && segment.endIndex >= payload.endIndex);
    if (!startSegment || !endSegment) return null;
    const startOffset = startSegment.textOffset + payload.startIndex - startSegment.startIndex;
    const endOffset = endSegment.textOffset + payload.endIndex - endSegment.startIndex;
    const oldBodyText = oldBodySegments.map((segment) => segment.text).join('');
    const expectedRemainder = oldBodyText.slice(0, startOffset) + oldBodyText.slice(endOffset);
    const remainder = newBodySegments.filter((segment) => !segment.suggestedInsertionIds.some((id) => newSuggestionIds.has(id)) && !segment.suggestedDeletionIds.some((id) => newSuggestionIds.has(id))).map((segment) => segment.text).join('');
    if (remainder !== expectedRemainder) return null;

    const oldRawTab = getTabEntries(before.raw.document).find((entry) => entry.tabId === (payload.tabId ?? ''));
    const newRawTab = getTabEntries(after.raw.document).find((entry) => entry.tabId === (payload.tabId ?? ''));
    if (!oldRawTab || !newRawTab) return null;
    const sourceTokens = bodyTokens(oldRawTab.documentTab.body?.content).filter((token) => !(token.kind === 'text' && token.index >= payload.startIndex && token.index < payload.endIndex)).map(({ index, ...token }) => token);
    const savedTokens = bodyTokens(newRawTab.documentTab.body?.content).filter((token) => !(token.kind === 'text' && [...token.insertionIds, ...token.deletionIds].some((id) => newSuggestionIds.has(id)))).map(({ index, ...token }) => token);
    if (!sameValue(sourceTokens, savedTokens)) return null;
    return { suggestionIds: [...newSuggestionIds], range, quote: payload.quote, replacement: payload.replacement };
  }

  function verifyStyledSuggestion(before, after, payload, originalStyle, insertion) {
    const oldTab = before.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
    const newTab = after.tabs.find((candidate) => candidate.tabId === (payload.tabId ?? ''));
    const oldRawTab = getTabEntries(before.raw.document).find((entry) => entry.tabId === (payload.tabId ?? ''));
    const newRawTab = getTabEntries(after.raw.document).find((entry) => entry.tabId === (payload.tabId ?? ''));
    if (!oldTab || !newTab || !oldRawTab || !newRawTab || !after.revisionId) return null;
    const inserted = newTab.segments.filter((segment) => segment.segmentId === '' && segment.suggestedInsertionIds.some((id) => insertion.suggestionIds.includes(id)));
    if (inserted.map((segment) => segment.text).join('') !== payload.replacement) return null;
    const newStyleIds = new Set((after.raw.document.suggestions ?? []).map((item) => item.suggestionId).filter((id) => id && !(before.raw.document.suggestions ?? []).some((old) => old.suggestionId === id)));
    for (const id of insertion.suggestionIds) newStyleIds.add(id);
    for (const segment of inserted) {
      const oldSegment = oldTab.segments.find((old) => old.suggestedInsertionIds.some((id) => insertion.suggestionIds.includes(id)) && old.text === segment.text);
      for (const id of Object.keys(segment.suggestedTextStyleChanges ?? {})) if (!Object.hasOwn(oldSegment?.suggestedTextStyleChanges ?? {}, id)) newStyleIds.add(id);
      const expectedStyle = expectedStyleAfterSuggestion(segment, newStyleIds);
      if (expectedStyle === null || !styleMatchesSource(originalStyle, expectedStyle, segment.style)) return null;
    }
    const oldTokens = bodyTokens(oldRawTab.documentTab.body?.content);
    const newTokens = bodyTokens(newRawTab.documentTab.body?.content);
    const insertionIds = new Set(insertion.suggestionIds);
    const project = (tokens) => tokens.map((token) => {
      const { index, ...rest } = token;
      if (token.kind === 'text' && token.insertionIds.some((id) => insertionIds.has(id))) {
        rest.styleChanges = Object.fromEntries(Object.entries(token.styleChanges ?? {}).filter(([id]) => !insertionIds.has(id)));
      }
      return rest;
    });
    if (!sameValue(project(oldTokens), project(newTokens))) return null;
    return { suggestionIds: insertion.suggestionIds, quote: payload.quote, replacement: payload.replacement, revisionId: after.revisionId };
  }

  function verifyComment(document, payload, response) {
    const thread = (document.raw.document.comments ?? []).find((item) => item.headPost?.content === payload.text && item.plainTextQuote === payload.quote && item.commentId && item.anchorId);
    if (!thread) return null;
    const matchingAnchor = getTabEntries(document.raw.document).some(({ tabId, documentTab }) => {
      const anchors = Object.values(documentTab.commentAnchors ?? {});
      return anchors.some((anchor) => anchor.anchorId === thread.anchorId && (anchor.ranges ?? []).some((range) =>
        range.startIndex === payload.startIndex && range.endIndex === payload.endIndex && (range.tabId ?? tabId ?? '') === (payload.tabId ?? tabId ?? '') && (range.segmentId ?? '') === ''));
    });
    if (!matchingAnchor) return null;
    return { commentId: thread.commentId, anchorId: thread.anchorId, quote: payload.quote, commentUpdateState: response.commentUpdateState ?? null, revisionId: document.revisionId };
  }

  async function suggest(payload) {
    if (typeof payload?.replacement !== 'string' || !payload.replacement || /[\r\n]/.test(payload.replacement)) throw safeError('A single-paragraph replacement is required.', 'GOOGLE_REPLACEMENT_INVALID');
    return performWrite('suggest', payload);
  }

  async function comment(payload) {
    if (typeof payload?.text !== 'string' || !payload.text.trim()) throw safeError('Comment text is required.', 'GOOGLE_COMMENT_INVALID');
    return performWrite('comment', payload);
  }

  async function reconcileOperation({ documentId, operationId, authorReviewed, ownerId: reviewerOwnerId } = {}) {
    if (typeof documentId !== 'string' || !documentId.trim() || typeof operationId !== 'string' || !operationId.trim()) throw safeError('A document ID and operation ID are required for reconciliation.', 'GOOGLE_RECONCILIATION_INVALID');
    if (authorReviewed !== true || typeof reviewerOwnerId !== 'string' || reviewerOwnerId !== serviceOwnerId) throw safeError('Only the authenticated document owner can acknowledge a manual review.', 'GOOGLE_RECONCILIATION_FORBIDDEN', 403);
    const runKey = getDocumentRunKey(documentId);
    if (activeDocumentRuns.has(runKey) || pendingOps.has(operationId)) throw safeError('The Google document operation is still active.', 'GOOGLE_OPERATION_ACTIVE', 409);
    const lock = await readEncryptedFile(documentLockPath(documentId));
    if (!lock || lock.documentId !== documentId || lock.operationId !== operationId) throw safeError('The durable Google document lock does not match the unresolved operation.', 'GOOGLE_RECONCILIATION_NOT_FOUND', 404);
    if (!UNRESOLVED_OPERATION_STATES.has(lock.state)) throw safeError('The durable Google document lock is invalid or no longer unresolved.', 'GOOGLE_RECONCILIATION_NOT_FOUND', 404);
    let entry = await readJournal(operationId);
    if (entry) {
      if (entry.documentId !== documentId || entry.operationId !== operationId || !UNRESOLVED_OPERATION_STATES.has(entry.state) || (lock.signature !== undefined && lock.signature !== entry.signature) || (lock.kind !== undefined && lock.kind !== entry.kind)) throw safeError('The unresolved Google operation does not match this document and operation ID.', 'GOOGLE_RECONCILIATION_NOT_FOUND', 404);
    } else {
      entry = { operationId, documentId, state: lock.state, createdAt: lock.createdAt, phase: lock.phase ?? 'reserved', ...(lock.signature ? { signature: lock.signature } : {}), ...(lock.kind ? { kind: lock.kind } : {}), ...(!lock.signature ? { recoveryNote: 'Recovered from a legacy lock without an operation signature; retries remain prohibited.' } : {}) };
      await saveEncrypted(path.join(journalDir, `${sha256(operationId)}.enc`), entry);
    }
    entry.state = 'author_reviewed';
    entry.authorReviewedAt = new Date().toISOString();
    entry.reviewedByOwnerId = serviceOwnerId;
    entry.machineVerified = false;
    entry.nativeVisualValidated = false;
    await writeJournal(operationId, entry);
    return { operationId, state: entry.state, authorReviewedAt: entry.authorReviewedAt, machineVerified: false, nativeVisualValidated: false };
  }

  // Main-manuscript chapters reuse the same OAuth, journal, durable lock and active-run guard.
  const chapters = createChapterOperations({
    apiRequest, getRawDocument, readJournal, writeJournal, reserveDocument, listPendingOperations, capabilities,
    activeRuns: activeDocumentRuns, runKey: getDocumentRunKey,
  });

  return { status, capabilities, configure, beginLogin, callback, disconnect, listDocuments, readDocument, listSpreadsheets, readSpreadsheet, updateSpreadsheet, suggest, comment, stageProduct, applyProduct, reconcileOperation, ...chapters };
}
