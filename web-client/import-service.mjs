import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 12;
const MAX_ANALYSIS_BYTES = 1024 * 1024;
const MAX_FULL_READ_BYTES = 1024 * 1024;
const MAX_READ_RANGE_CHARS = 64000;
const EXTENSIONS = new Set(['.fb2', '.txt', '.md', '.html', '.htm', '.docx', '.epub', '.json']);
const SOURCE_KINDS = new Set(['book', 'article', 'notes', 'document', 'web', 'audio', 'video', 'other']);
const ACTIONS = new Set(['prepare', 'status', 'finalize', 'check', 'accept']);
const INVALID_COMPONENT = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_COMPONENT = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export class ImportServiceError extends Error {
  constructor(message, code = 'IMPORT_ERROR') {
    super(message); this.name = 'ImportServiceError'; this.code = code;
    this.status = ({ INVALID_INPUT: 400, INVALID_BASE64: 400, INVALID_FILENAME: 400, INVALID_SOURCE_KIND: 400, INVALID_ACTION: 400, INVALID_ANALYSIS: 400, INVALID_REVIEW: 400, INVALID_PATH: 400, INVALID_RANGE: 400, PATH_ESCAPE: 400, INVALID_JOB: 400,
      FILE_TOO_LARGE: 413, TOTAL_SIZE_LIMIT: 413, FILE_COUNT_LIMIT: 413, ANALYSIS_TOO_LARGE: 413, READ_TOO_LARGE: 413, READ_RANGE_REQUIRED: 413,
      JOB_NOT_FOUND: 404, READ_NOT_ALLOWED: 403, UNSAFE_PATH: 403, UPLOADS_CLOSED: 409, DUPLICATE_FILENAME: 409, INVALID_STATE: 409, NO_SOURCES: 409, ANALYSIS_REQUIRED: 409, NATIVE_CHECK_REQUIRED: 409, REVIEW_REQUIRED: 409, REVIEW_RECEIPT_REQUIRED: 409, PUBLISH_CONFLICT: 409, PUBLISH_HASH_MISMATCH: 409, STALE_PROPOSAL: 409, CONFIRMATION_REQUIRED: 409,
      UNSUPPORTED_FORMAT: 415, NATIVE_IMPORT_FAILED: 422, CLI_TIMEOUT: 504, CLI_OUTPUT_TOO_LARGE: 502, CLI_START_FAILED: 503, PUBLISH_NOT_CONFIGURED: 503 })[code] || 500;
  }
}

const fail = (message, code) => { throw new ImportServiceError(message, code); };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const safeComponent = (value, label) => {
  if (typeof value !== 'string') fail(`Invalid ${label}`, 'INVALID_INPUT');
  const part = value.trim();
  if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || INVALID_COMPONENT.test(part) || RESERVED_COMPONENT.test(part)) {
    fail(`Invalid ${label}`, 'INVALID_INPUT');
  }
  return part;
};
const parseJson = (text, label) => {
  try { return JSON.parse(text); } catch { fail(`Invalid ${label} JSON`, 'INVALID_JSON'); }
};
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function exists(p) {
  try { await fs.lstat(p); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function ensureNoLinks(root, target, { allowMissing = true } = {}) {
  const rel = path.relative(root, target);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) fail('Path escapes its configured root', 'PATH_ESCAPE');
  let cursor = root;
  const parts = rel ? rel.split(path.sep) : [];
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = await fs.lstat(cursor); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) fail('Symbolic links and special files are not allowed in import paths', 'UNSAFE_PATH');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('A path component is not a directory', 'UNSAFE_PATH');
  }
}

async function writeAtomic(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.import-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    try { await fs.rename(temp, file); }
    catch (error) {
      // Some Windows sandboxes deny rename even within one directory. Copy is
      // still confined to the already checked private job directory.
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      await fs.copyFile(temp, file);
    }
  } finally { await fs.rm(temp, { force: true }); }
}

function strictBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) fail('contentBase64 must be bounded canonical padded base64', value?.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ? 'FILE_TOO_LARGE' : 'INVALID_BASE64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('contentBase64 is not canonical', 'INVALID_BASE64');
  if (bytes.length > MAX_FILE_BYTES) fail('Each uploaded source is limited to 5 MiB', 'FILE_TOO_LARGE');
  return bytes;
}

function relativePath(root, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) fail('Invalid vault-relative path', 'INVALID_PATH');
  const resolved = path.resolve(root, ...value.split('/'));
  const rel = path.relative(root, resolved);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) fail('Path escapes the job vault', 'PATH_ESCAPE');
  return resolved;
}

export function createImportService({ dataDir, pythonExecutable = 'python', projectRoot, catalogRoot, reviewReceiptVerifier = async () => false,
  spawnProcess = spawn, nativeTimeoutMs = 120_000, nativeKillGraceMs = 1_000, maxNativeStdoutBytes = 16 * 1024 * 1024 } = {}) {
  if (!dataDir || !projectRoot) fail('dataDir and projectRoot are required', 'INVALID_CONFIG');
  const dataRoot = path.resolve(dataDir);
  const importsRoot = path.join(dataRoot, 'imports');
  const project = path.resolve(projectRoot);
  const cli = path.join(project, 'plugin', 'scripts', 'series_base_cli.py');
  const catalog = catalogRoot ? path.resolve(catalogRoot) : null;
  const locks = new Map();

  async function withLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    locks.set(key, tail);
    await previous.catch(() => {});
    try { return await operation(); }
    finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  const withJobLock = (jobId, operation) => withLock(`job:${jobId}`, operation);

  async function loadJob(jobId) {
    if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(jobId)) fail('Invalid job id', 'INVALID_JOB');
    await ensureNoLinks(dataRoot, importsRoot);
    const dir = path.join(importsRoot, jobId);
    try { await ensureNoLinks(importsRoot, dir, { allowMissing: false }); }
    catch (error) { if (error.code === 'ENOENT') fail('Import job was not found', 'JOB_NOT_FOUND'); throw error; }
    const jobPath = path.join(dir, 'job.json');
    await ensureNoLinks(dir, jobPath, { allowMissing: false });
    const job = parseJson(await fs.readFile(jobPath, 'utf8'), 'job');
    if (job.jobId !== jobId || !job.vault || path.resolve(job.vault) !== path.join(dir, 'vault')) fail('Import job metadata is inconsistent', 'CORRUPT_JOB');
    return { dir, jobPath, job };
  }

  async function saveJob(jobPath, job) { await writeAtomic(jobPath, canonicalJson(job)); }

  async function invoke(vault, args) {
    await ensureNoLinks(dataRoot, path.resolve(vault), { allowMissing: false });
    const cmdArgs = [cli, '--vault', vault];
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(pythonExecutable, cmdArgs, { cwd: project, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      } catch (error) {
        reject(new ImportServiceError(`Could not start the native importer: ${error.message}`, 'CLI_START_FAILED'));
        return;
      }
      const stdout = []; let bytes = 0; let stderrBytes = 0; let failure = null; let closeSeen = false;
      let deadlineTimer; let hardKillTimer; let settled = false;
      const markFailureAndKill = (error) => {
        if (!failure) failure = error;
        if (hardKillTimer || closeSeen) return;
        try { child.kill(); } catch { /* wait for close/error from the child */ }
        hardKillTimer = setTimeout(() => {
          if (!closeSeen) { try { child.kill('SIGKILL'); } catch { /* close remains the settlement boundary */ } }
        }, nativeKillGraceMs);
        hardKillTimer.unref?.();
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(hardKillTimer);
        if (error) reject(error); else resolve(value);
      };
      child.stdout.on('data', (chunk) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > maxNativeStdoutBytes) {
          markFailureAndKill(new ImportServiceError('Native importer response exceeded its bounded output limit', 'CLI_OUTPUT_TOO_LARGE'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => { stderrBytes = Math.min(64 * 1024, stderrBytes + chunk.length); }); // Drain, count only; stderr can contain local paths or source excerpts.
      child.on('error', () => markFailureAndKill(new ImportServiceError('Could not start the native importer', 'CLI_START_FAILED')));
      child.stdin.on?.('error', () => markFailureAndKill(new ImportServiceError('Could not send the native importer request', 'CLI_START_FAILED')));
      child.on('close', (code) => {
        closeSeen = true;
        const output = Buffer.concat(stdout).toString('utf8');
        if (failure) { finish(failure); return; }
        if (code !== 0) {
          let detail = '';
          try { detail = JSON.parse(output).error || ''; } catch { /* suppress tracebacks and local paths */ }
          finish(new ImportServiceError(detail || 'The native importer failed unexpectedly; local diagnostics were withheld.', 'NATIVE_IMPORT_FAILED'));
          return;
        }
        try { finish(null, parseJson(output, 'native importer response')); }
        catch (error) { finish(error); }
      });
      deadlineTimer = setTimeout(() => markFailureAndKill(new ImportServiceError(`Native importer exceeded the ${nativeTimeoutMs} ms deadline`, 'CLI_TIMEOUT')), nativeTimeoutMs);
      deadlineTimer.unref?.();
      try { child.stdin.end(JSON.stringify(args)); }
      catch { markFailureAndKill(new ImportServiceError('Could not send the native importer request', 'CLI_START_FAILED')); }
    });
  }

  async function create({ authorPseudonym, seriesName }) {
    const pseudonym = safeComponent(authorPseudonym, 'author pseudonym');
    const series = safeComponent(seriesName, 'series name');
    await fs.mkdir(importsRoot, { recursive: true });
    await ensureNoLinks(dataRoot, importsRoot, { allowMissing: false });
    const jobId = crypto.randomUUID();
    const dir = path.join(importsRoot, jobId);
    await fs.mkdir(dir, { recursive: false });
    const vault = path.join(dir, 'vault');
    await fs.mkdir(vault, { recursive: false });
    const job = { jobId, authorPseudonym: pseudonym, seriesName: series, vault, createdAt: new Date().toISOString(), uploads: [], uploadedBytes: 0, native: null, proposal: null, published: null };
    try { await writeAtomic(path.join(dir, 'job.json'), canonicalJson(job)); }
    catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
    return { jobId, status: 'awaiting_sources', authorPseudonym: pseudonym, seriesName: series, maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, acceptedExtensions: [...EXTENSIONS].sort() };
  }

  async function uploadUnlocked({ jobId, name, contentBase64, sourceKind }) {
    const { dir, jobPath, job } = await loadJob(jobId);
    if (job.native) fail('Uploads are closed after native prepare begins', 'UPLOADS_CLOSED');
    if (!Array.isArray(job.uploads) || job.uploads.length >= MAX_FILES) fail('An import job accepts at most 12 source files', 'FILE_COUNT_LIMIT');
    const bytes = strictBase64(contentBase64);
    if (bytes.length === 0) fail('Uploaded source files cannot be empty', 'INVALID_INPUT');
    const filename = typeof name === 'string' ? name.trim() : '';
    if (!filename || path.basename(filename) !== filename || filename === '.' || filename === '..' || /[\\/\x00-\x1f]/.test(filename)) fail('Upload name must be a plain filename', 'INVALID_FILENAME');
    const ext = path.extname(filename).toLowerCase();
    if (!EXTENSIONS.has(ext)) fail(`Unsupported ${ext || 'extension'}; verified extraction is required before import`, 'UNSUPPORTED_FORMAT');
    if (!SOURCE_KINDS.has(sourceKind)) fail('Each upload requires explicit sourceKind metadata', 'INVALID_SOURCE_KIND');
    const nameKey = filename.toLocaleLowerCase('en-US');
    if (job.uploads.some((item) => item.name.toLocaleLowerCase('en-US') === nameKey)) fail('Upload filenames must be unique within a job', 'DUPLICATE_FILENAME');
    const total = job.uploadedBytes + bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('An import job accepts at most 20 MiB total', 'TOTAL_SIZE_LIMIT');
    const uploadPath = path.join(dir, 'uploads', crypto.randomUUID(), filename);
    await ensureNoLinks(dir, uploadPath);
    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
    await writeAtomic(uploadPath, bytes);
    job.uploads.push({ name: filename, path: uploadPath, sourceKind, bytes: bytes.length, sha256: sha(bytes) });
    job.uploadedBytes = total;
    await saveJob(jobPath, job);
    return { jobId, uploaded: { name: filename, sourceKind, bytes: bytes.length, sha256: sha(bytes) }, fileCount: job.uploads.length, totalBytes: total };
  }

  async function statusUnlocked(jobId) {
    const { job } = await loadJob(jobId);
    if (!job.native?.session_id) return { jobId, authorPseudonym: job.authorPseudonym, seriesName: job.seriesName, status: job.uploads.length ? 'awaiting_prepare' : 'awaiting_sources', fileCount: job.uploads.length, totalBytes: job.uploadedBytes };
    return { jobId, authorPseudonym: job.authorPseudonym, seriesName: job.seriesName, ...await currentNativeStatus(job), proposal: job.proposal, published: job.published };
  }

  async function list() {
    if (!(await exists(importsRoot))) return { jobs: [] };
    await ensureNoLinks(dataRoot, importsRoot, { allowMissing: false });
    const entries = await fs.readdir(importsRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const { job } = await loadJob(entry.name);
      jobs.push({ jobId: job.jobId, authorPseudonym: job.authorPseudonym, seriesName: job.seriesName,
        status: job.published?.status || job.proposal?.status || job.native?.status || (job.uploads.length ? 'awaiting_prepare' : 'awaiting_sources'),
        createdAt: job.createdAt, fileCount: job.uploads.length, totalBytes: job.uploadedBytes,
        candidateSha256: job.native?.candidate_sha256 || null, publishStatus: job.published?.status || null });
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs };
  }

  async function saveAnalysisUnlocked(jobId, analysis) {
    const { dir, jobPath, job } = await loadJob(jobId);
    if (!job.native?.session_id || !['prepared_for_analysis', 'candidate_ready_for_review'].includes(job.native.status)) fail('Native prepare or a repairable candidate must exist before saving source analysis', 'INVALID_STATE');
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) fail('Analysis must be a JSON object', 'INVALID_ANALYSIS');
    const bytes = Buffer.from(canonicalJson(analysis), 'utf8');
    if (bytes.length > MAX_ANALYSIS_BYTES) fail('Analysis is limited to 1 MiB', 'ANALYSIS_TOO_LARGE');
    const target = path.join(job.vault, '.talewisp', 'imports', job.native.session_id, 'analysis.json');
    await ensureNoLinks(job.vault, target);
    await writeAtomic(target, bytes);
    job.analysis = { path: '.talewisp/imports/' + job.native.session_id + '/analysis.json', bytes: bytes.length, sha256: sha(bytes) };
    job.check = null;
    job.review = null;
    job.proposal = null;
    await saveJob(jobPath, job);
    return { jobId, analysisPath: job.analysis.path, bytes: bytes.length, sha256: job.analysis.sha256 };
  }

  async function saveReviewUnlocked(jobId, review) {
    const { jobPath, job } = await loadJob(jobId);
    if (!job.native?.session_id || job.native.status !== 'candidate_ready_for_review' || !job.native.candidate_sha256) fail('A finalized candidate is required before review', 'INVALID_STATE');
    if (job.check?.status !== 'PASS' || job.check?.candidate_sha256 !== job.native.candidate_sha256) fail('The current candidate must pass the native machine check before review', 'NATIVE_CHECK_REQUIRED');
    if (!review || typeof review !== 'object' || Array.isArray(review) || review.status !== 'PASS' || review.review_type !== 'independent' || review.session_id !== job.native.session_id || review.candidate_sha256 !== job.native.candidate_sha256 || !Array.isArray(review.findings) || typeof review.coverage !== 'string' || !review.coverage.trim()) fail('Review must identify the current candidate and record inspected coverage and findings', 'INVALID_REVIEW');
    if (typeof review.receiptId !== 'string' || !review.receiptId.trim() || !await reviewReceiptVerifier({ jobId, sessionId: job.native.session_id, candidateSha256: job.native.candidate_sha256, review })) fail('An actual independent-review receipt is required; this service cannot self-issue PASS', 'REVIEW_RECEIPT_REQUIRED');
    const bytes = Buffer.from(canonicalJson(review), 'utf8');
    const target = path.join(job.vault, '.talewisp', 'imports', job.native.session_id, 'independent-review.json');
    await ensureNoLinks(job.vault, target);
    await writeAtomic(target, bytes);
    job.review = { path: '.talewisp/imports/' + job.native.session_id + '/independent-review.json', sha256: sha(bytes), candidateSha256: job.native.candidate_sha256 };
    await saveJob(jobPath, job);
    return { jobId, reviewPath: job.review.path, candidateSha256: job.native.candidate_sha256 };
  }

  function nativeArgs(job, action) {
    if (!ACTIONS.has(action)) fail('Unsupported native action', 'INVALID_ACTION');
    if (action === 'prepare') {
      if (job.native) fail('Native prepare has already started', 'INVALID_STATE');
      if (!job.uploads.length) fail('Upload at least one source before prepare', 'NO_SOURCES');
      const sourceKinds = Object.fromEntries(job.uploads.map((upload) => [upload.path, upload.sourceKind]));
      return { action, author_pseudonym: job.authorPseudonym, series_name: job.seriesName, files: job.uploads.map((upload) => upload.path), source_kinds: sourceKinds };
    }
    if (!job.native?.session_id) fail('Native prepare must complete before this action', 'INVALID_STATE');
    if (action === 'finalize') {
      if (!job.analysis) fail('Save full nine-layer analysis before finalize', 'ANALYSIS_REQUIRED');
      return { action, session_id: job.native.session_id, analysis_path: job.analysis.path };
    }
    if (action === 'accept') {
      if (!job.review?.candidateSha256 || job.review.candidateSha256 !== job.native.candidate_sha256) fail('A verified independent review of the current candidate is required', 'REVIEW_REQUIRED');
      return { action, session_id: job.native.session_id, review_path: job.review.path };
    }
    return { action, session_id: job.native.session_id };
  }

  async function buildPublishProposal(job) {
    const completed = await invoke(job.vault, { action: 'status', session_id: job.native.session_id });
    if (completed.status !== 'complete') fail('Only an accepted complete native base can be proposed for publishing', 'INVALID_STATE');
    const seriesPath = relativePath(job.vault, completed.series_path);
    const seriesDir = seriesPath;
    await ensureNoLinks(job.vault, seriesDir, { allowMissing: false });
    const files = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const item = path.join(dir, entry.name);
        await ensureNoLinks(job.vault, item, { allowMissing: false });
        if (entry.isDirectory()) await walk(item);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(item);
          files.push({ relativePath: path.relative(seriesDir, item).split(path.sep).join('/'), before: { exists: false }, after: { bytes: bytes.length, sha256: sha(bytes) }, bytes: bytes.length, sha256: sha(bytes) });
        } else fail('Unexpected special file in completed series', 'UNSAFE_PATH');
      }
    }
    await walk(seriesDir);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const proposal = { status: 'awaiting_publish_confirmation', jobId: job.jobId, authorPseudonym: job.authorPseudonym, seriesName: job.seriesName, catalogRelativePath: `00 Автор/${job.authorPseudonym}/${job.seriesName}`, candidateSha256: job.native.candidate_sha256, files, manifestSha256: sha(Buffer.from(canonicalJson(files))) };
    return proposal;
  }

  function enrichNativeReferences(result) {
    if (!Array.isArray(result.books) || !result.series_path) return result;
    result.books = result.books.map((book) => ({ ...book,
      corpus_path: `${result.series_path}/${book.corpus_file}`,
      chapter_paths: (book.chapter_files || []).map((file) => `${result.series_path}/${file}`) }));
    return result;
  }

  async function currentNativeStatus(job) {
    const sessionId = job.native?.session_id;
    if (!sessionId) return null;
    const current = enrichNativeReferences(await invoke(job.vault, { action: 'status', session_id: sessionId }));
    const expectedSeriesPath = `00 Автор/${job.authorPseudonym}/${job.seriesName}`;
    if (current.session_id !== sessionId || current.author_pseudonym !== job.authorPseudonym ||
        current.series_name !== job.seriesName || current.series_path !== expectedSeriesPath) {
      fail('Native session identity does not match this import job', 'NATIVE_SESSION_MISMATCH');
    }
    return current;
  }

  async function sourceReferences(job, native) {
    const paths = new Set();
    if (!native) return paths;
    const sourcePath = `${native.series_path}/00 Источники`;
    const indexPath = `${sourcePath}/corpus-index.json`;
    if (native.source_path !== sourcePath || native.corpus_index_path !== indexPath || !Array.isArray(native.books)) {
      fail('Native source index identity is incomplete', 'NATIVE_INDEX_MISMATCH');
    }
    const indexFile = relativePath(job.vault, indexPath);
    await ensureNoLinks(job.vault, indexFile, { allowMissing: false });
    const index = parseJson(await fs.readFile(indexFile, 'utf8'), 'corpus index');
    if (index.author_pseudonym !== job.authorPseudonym || index.series !== job.seriesName ||
        !Array.isArray(index.books) || index.books.length !== native.books.length) {
      fail('Corpus index identity does not match the native session', 'NATIVE_INDEX_MISMATCH');
    }
    paths.add(indexPath);
    const sessionBooks = new Map(native.books.map((book) => [book.book_id, book]));
    const seen = new Set();
    for (const book of index.books) {
      const sessionBook = sessionBooks.get(book.book_id);
      if (!sessionBook || seen.has(book.book_id) || sessionBook.title !== book.title ||
          sessionBook.corpus_file !== book.corpus_file || canonicalJson(sessionBook.chapter_files) !== canonicalJson(book.chapter_files)) {
        fail('Corpus index book entries do not match the native session', 'NATIVE_INDEX_MISMATCH');
      }
      seen.add(book.book_id);
      for (const relative of [book.source_file, book.corpus_file, ...(book.chapter_files || [])]) {
        if (typeof relative !== 'string' || !relative) fail('Corpus index contains an invalid source reference', 'NATIVE_INDEX_MISMATCH');
        const ref = `${native.series_path}/${relative}`;
        relativePath(job.vault, ref);
        paths.add(ref);
      }
      if (!Array.isArray(book.chapter_files)) fail('Corpus index chapter references are invalid', 'NATIVE_INDEX_MISMATCH');
      const corpusPath = `${native.series_path}/${book.corpus_file}`;
      const corpusFile = relativePath(job.vault, corpusPath);
      await ensureNoLinks(job.vault, corpusFile, { allowMissing: false });
      const corpus = parseJson(await fs.readFile(corpusFile, 'utf8'), 'source corpus');
      if (corpus.book_id !== book.book_id || !Array.isArray(corpus.images)) fail('Corpus entry does not match its indexed book', 'NATIVE_INDEX_MISMATCH');
      for (const image of corpus.images) if (typeof image.relative_path === 'string' && image.relative_path) {
        const ref = `${native.series_path}/${image.relative_path}`;
        relativePath(job.vault, ref);
        paths.add(ref);
      }
    }
    return paths;
  }

  async function runUnlocked({ jobId, action }) {
    const { jobPath, job } = await loadJob(jobId);
    const args = nativeArgs(job, action);
    const result = enrichNativeReferences(await invoke(job.vault, args));
    if (action === 'prepare' || action === 'finalize') {
      job.native = action === 'prepare' ? result : { ...job.native, ...result };
      if (action === 'finalize') { job.check = null; job.review = null; job.proposal = null; }
    }
    else if (action === 'accept' && result.status === 'complete') {
      job.native = { ...job.native, ...result };
      job.proposal = await buildPublishProposal(job);
    } else if (action === 'check') {
      job.check = result;
      job.native.candidate_sha256 = result.candidate_sha256 || job.native.candidate_sha256;
    } else if (action === 'status') job.native = { ...job.native, ...result };
    await saveJob(jobPath, job);
    return { jobId, ...result, proposal: job.proposal };
  }

  async function readUnlocked(jobId, vaultRelativePath, { startChar, maxChars } = {}) {
    const { job } = await loadJob(jobId);
    const native = await currentNativeStatus(job);
    const target = relativePath(job.vault, vaultRelativePath);
    const allowed = await sourceReferences(job, native);
    const candidateCurrent = native?.status === 'candidate_ready_for_review' && native.candidate_sha256 && native.candidate_sha256 === job.native?.candidate_sha256;
    if (candidateCurrent && job.native?.candidate_paths) for (const candidate of Object.values(job.native.candidate_paths)) allowed.add(candidate);
    if (candidateCurrent && job.native?.candidate_manifest_path) allowed.add(job.native.candidate_manifest_path);
    // The native check result is recorded separately from the finalized
    // candidate in job.check. Expose only the exact path returned by that
    // check; a subsequent finalize clears job.check before a new candidate.
    if (job.check?.session_id === native?.session_id && job.check?.candidate_sha256 === native?.candidate_sha256 && job.check?.machine_checks_path === native?.machine_checks_path) allowed.add(job.check.machine_checks_path);
    if (job.analysis?.path) allowed.add(job.analysis.path);
    if (job.review?.path && job.review?.candidateSha256 === native?.candidate_sha256) allowed.add(job.review.path);
    if (!allowed.has(vaultRelativePath)) fail('Path is outside this job’s readable source, analysis, or candidate allowlist', 'READ_NOT_ALLOWED');
    await ensureNoLinks(job.vault, target, { allowMissing: false });
    const bytes = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const binary = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
    const originalSha256 = sha(bytes);
    if (!binary) {
      const text = bytes.toString('utf8');
      const totalChars = [...text].length;
      if (startChar === undefined && maxChars === undefined) {
        if (bytes.length > MAX_FULL_READ_BYTES) fail('This file is too large for a full response; request a bounded character range', 'READ_RANGE_REQUIRED');
        return { jobId, path: vaultRelativePath, bytes: bytes.length, sha256: originalSha256, originalSha256, text, truncated: false, totalChars, range: { start: 0, end: totalChars }, eof: true, complete: true };
      }
      if (!Number.isSafeInteger(startChar) || startChar < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_RANGE_CHARS) fail('Range reads require startChar >= 0 and maxChars from 1 to 64000', 'INVALID_RANGE');
      const chars = [...text];
      if (startChar > chars.length) fail('startChar is beyond the end of this file', 'INVALID_RANGE');
      const chunk = chars.slice(startChar, startChar + maxChars).join('');
      const end = startChar + [...chunk].length;
      const eof = end >= totalChars;
      return { jobId, path: vaultRelativePath, bytes: bytes.length, sha256: originalSha256, originalSha256, chunkSha256: sha(Buffer.from(chunk, 'utf8')), text: chunk, truncated: false, totalChars, range: { start: startChar, end }, eof, complete: startChar === 0 && eof };
    }
    if (startChar !== undefined || maxChars !== undefined) fail('Character ranges apply to text files only', 'INVALID_RANGE');
    if (bytes.length > MAX_FULL_READ_BYTES) fail('This binary file is too large for a full response', 'READ_TOO_LARGE');
    const mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
    return { jobId, path: vaultRelativePath, bytes: bytes.length, sha256: originalSha256, originalSha256, mimeType, contentBase64: bytes.toString('base64'), truncated: false, complete: true };
  }

  async function inventoryUnlocked(jobId) {
    const { job } = await loadJob(jobId);
    const native = await currentNativeStatus(job);
    const paths = await sourceReferences(job, native);
    const candidateCurrent = native?.status === 'candidate_ready_for_review' && native.candidate_sha256 && native.candidate_sha256 === job.native?.candidate_sha256;
    if (candidateCurrent && job.native?.candidate_paths) for (const candidate of Object.values(job.native.candidate_paths)) paths.add(candidate);
    if (candidateCurrent && job.native?.candidate_manifest_path) paths.add(job.native.candidate_manifest_path);
    if (job.check?.session_id === native?.session_id && job.check?.candidate_sha256 === native?.candidate_sha256 && job.check?.machine_checks_path === native?.machine_checks_path) paths.add(job.check.machine_checks_path);
    for (const ref of [job.analysis?.path, job.review?.candidateSha256 === native?.candidate_sha256 ? job.review?.path : null]) if (ref) paths.add(ref);
    const files = [];
    for (const ref of [...paths].sort()) {
      const target = relativePath(job.vault, ref);
      if (!(await exists(target))) continue;
      await ensureNoLinks(job.vault, target, { allowMissing: false });
      const bytes = await fs.readFile(target);
      files.push({ path: ref, bytes: bytes.length, sha256: sha(bytes), complete: true });
    }
    return { jobId, files, count: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }

  async function publishUnlocked({ jobId, confirmed }) {
    if (confirmed !== true) fail('Publishing requires confirmed: true', 'CONFIRMATION_REQUIRED');
    if (!catalog) fail('catalogRoot is not configured', 'PUBLISH_NOT_CONFIGURED');
    const { dir, jobPath, job } = await loadJob(jobId);
    if (!job.proposal || job.proposal.status !== 'awaiting_publish_confirmation' || job.native?.status !== 'complete') fail('Only a fully accepted job with a publish proposal can be published', 'INVALID_STATE');
    const authorRoot = path.join(catalog, '00 Автор');
    await ensureNoLinks(catalog, authorRoot);
    let createdAuthorRoot = false;
    const author = safeComponent(job.authorPseudonym, 'author pseudonym');
    const series = safeComponent(job.seriesName, 'series name');
    const authorDir = path.join(catalog, '00 Автор', author);
    const destination = path.join(authorDir, series);
    await ensureNoLinks(catalog, authorDir);
    await ensureNoLinks(catalog, destination);
    if (await exists(destination)) fail('The destination series already exists; refusing to overwrite it', 'PUBLISH_CONFLICT');
    const sourceDir = relativePath(job.vault, job.native.series_path);
    const freshProposal = await buildPublishProposal(job);
    if (freshProposal.manifestSha256 !== job.proposal.manifestSha256 || canonicalJson(freshProposal.files) !== canonicalJson(job.proposal.files)) fail('Accepted series contents changed after proposal creation', 'STALE_PROPOSAL');
    const stage = path.join(authorDir, `.import-${jobId}.tmp`);
    if (await exists(stage)) fail('Publish staging directory already exists', 'PUBLISH_CONFLICT');
    let createdAuthor = false;
    let publishedByThisCall = false;
    try {
      if (!(await exists(authorRoot))) { await fs.mkdir(authorRoot, { recursive: false }); createdAuthorRoot = true; }
      await ensureNoLinks(catalog, authorRoot, { allowMissing: false });
      if (!(await exists(authorDir))) { await fs.mkdir(authorDir, { recursive: false }); createdAuthor = true; }
      await ensureNoLinks(catalog, authorDir, { allowMissing: false });
      await fs.cp(sourceDir, stage, { recursive: true, errorOnExist: true, force: false, dereference: false });
      await ensureNoLinks(authorDir, stage, { allowMissing: false });
      for (const file of job.proposal.files) {
        const stagedFile = path.join(stage, ...file.relativePath.split('/'));
        const bytes = await fs.readFile(stagedFile);
        if (bytes.length !== file.bytes || sha(bytes) !== file.sha256) fail(`Staged publish verification failed for ${file.relativePath}`, 'PUBLISH_HASH_MISMATCH');
      }
      if (await exists(destination)) fail('The destination series appeared during publish; refusing to overwrite it', 'PUBLISH_CONFLICT');
      await fs.rename(stage, destination);
      publishedByThisCall = true;
      const after = [];
      for (const file of job.proposal.files) {
        const bytes = await fs.readFile(path.join(destination, ...file.relativePath.split('/')));
        after.push({ relativePath: file.relativePath, before: { exists: false }, after: { bytes: bytes.length, sha256: sha(bytes) }, bytes: bytes.length, sha256: sha(bytes) });
      }
      if (canonicalJson(after) !== canonicalJson(job.proposal.files)) {
        await fs.rm(destination, { recursive: true, force: true });
        fail('Published files did not match the approved proposal; publish was rolled back', 'PUBLISH_HASH_MISMATCH');
      }
      job.published = { status: 'published', catalogRelativePath: job.proposal.catalogRelativePath, files: after.length, manifestSha256: job.proposal.manifestSha256 };
      await saveJob(jobPath, job);
      return { jobId, ...job.published };
    } catch (error) {
      await fs.rm(stage, { recursive: true, force: true });
      if (publishedByThisCall) await fs.rm(destination, { recursive: true, force: true });
      if (createdAuthor) { try { await fs.rmdir(authorDir); } catch { /* retain a non-empty pre-existing race result */ } }
      if (createdAuthorRoot) { try { await fs.rmdir(authorRoot); } catch { /* retain a non-empty pre-existing race result */ } }
      throw error;
    }
  }

  const objectJob = (operation) => (args) => withJobLock(args?.jobId, () => operation(args));
  const idJob = (operation) => (jobId, ...args) => withJobLock(jobId, () => operation(jobId, ...args));
  const twoArgJob = (operation) => (jobId, value) => withJobLock(jobId, () => operation(jobId, value));
  const publish = (args) => withJobLock(args?.jobId, () => withLock('catalog-publish', () => publishUnlocked(args)));
  return Object.freeze({ create, upload: objectJob(uploadUnlocked), list, status: idJob(statusUnlocked), run: objectJob(runUnlocked), read: idJob(readUnlocked), inventory: idJob(inventoryUnlocked), saveAnalysis: twoArgJob(saveAnalysisUnlocked), saveReview: twoArgJob(saveReviewUnlocked), publish });
}

export const importServiceLimits = Object.freeze({ maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxFiles: MAX_FILES, maxAnalysisBytes: MAX_ANALYSIS_BYTES, maxFullReadBytes: MAX_FULL_READ_BYTES, maxReadRangeChars: MAX_READ_RANGE_CHARS });
