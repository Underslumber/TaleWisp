import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseBoundedA1Range, containsFormula, validateWriteGrid } from './google-sheets.mjs';

const MAX_LINE_BYTES = 4_000_000;
const READ_ONLY_EXCEPTIONS = new Set(['talewisp_select_vault']);
const ERROR = message => Object.assign(new Error(message), { status: 400 });
const MAX_NATIVE_PROPOSAL_BYTES = 4 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function assertRegularFile(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch { throw ERROR(`${label} is missing.`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw ERROR(`${label} must be a regular, non-symlink file.`);
  if (stat.size > MAX_NATIVE_PROPOSAL_BYTES) throw ERROR(`${label} exceeds the review size limit.`);
}

function assertDirectory(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch { throw ERROR(`${label} is missing.`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw ERROR(`${label} must be a regular directory.`);
}

function assertVaultRelativePath(root, value, label) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) throw ERROR(`${label} must be a vault-relative path.`);
  const target = resolve(root, value);
  if (!isInside(root, target)) throw ERROR(`${label} escapes the active series.`);
  const canonicalRoot = realpathSync(root);
  if (!isInside(canonicalRoot, target)) throw ERROR(`${label} escapes the active series.`);
  return target;
}

function nativePreview(proposal) {
  const metadata = proposal.continuity_extraction;
  const sourcePath = proposal.source_path ?? '';
  if (metadata) {
    const markerHash = sha256(stableJson(metadata));
    return `<!-- continuity-extraction-v1:${markerHash} -->\n---\ntype: talewisp-proposal\nstatus: pending\nproposal_type: ${proposal.proposal_type}\nsource_path: ${JSON.stringify(sourcePath)}\n---\n\n# ${proposal.title}\n\n${proposal.summary}\n\n## Proposed text\n\n${proposal.replacement_text}\n`;
  }
  return `---\ntype: talewisp-proposal\nstatus: pending\nproposal_type: ${proposal.proposal_type}\nsource_path: ${JSON.stringify(sourcePath)}\n---\n\n# ${proposal.title}\n\n${proposal.summary}\n\n## Proposed text\n\n${proposal.replacement_text}\n`;
}
const WEB_GOOGLE_TOOLS = [
  { name: 'talewisp_web_google_list', description: 'List and search native Google Docs available to the separately authorized agent account. Returns one bounded page and an optional next-page token; requires connected agent OAuth and performs no writes.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 }, pageToken: { type: 'string', maxLength: 4096 }, pageSize: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_read', description: 'Read the full Google Docs document, tabs, revision, comments and pending operations through the configured native Google service. Performs a live read and requires connected OAuth.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['documentId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_suggest', description: 'Queue a native Google Docs suggestion for author review. Requires the exact document revision, tab, UTF-16 range, quote, replacement and unique operationId; a UI approval is required before the guarded native write.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 512 }, tabId: { type: 'string' }, revisionId: { type: 'string', minLength: 1 }, startIndex: { type: 'integer', minimum: 0 }, endIndex: { type: 'integer', minimum: 0 }, quote: { type: 'string', minLength: 1 }, replacement: { type: 'string', minLength: 1 }, operationId: { type: 'string', minLength: 8, maxLength: 200 } }, required: ['documentId', 'tabId', 'revisionId', 'startIndex', 'endIndex', 'quote', 'replacement', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_comment', description: 'Queue a range-anchored Google Docs comment for author review. Requires exact document revision, tab, UTF-16 range, quote, comment text and unique operationId; a UI approval is required before the guarded native write.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 512 }, tabId: { type: 'string' }, revisionId: { type: 'string', minLength: 1 }, startIndex: { type: 'integer', minimum: 0 }, endIndex: { type: 'integer', minimum: 0 }, quote: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 }, operationId: { type: 'string', minLength: 8, maxLength: 200 } }, required: ['documentId', 'tabId', 'revisionId', 'startIndex', 'endIndex', 'quote', 'text', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_direct_edit', description: 'Stage an explicitly authorized direct Google Docs text edit for exact author review. This tool only reads and queues; UI approval applies the guarded direct edit.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 256 }, tabId: { type: 'string', maxLength: 256 }, revisionId: { type: 'string', minLength: 1, maxLength: 512 }, startIndex: { type: 'integer', minimum: 0 }, endIndex: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 60000 }, replacement: { type: 'string', minLength: 1, maxLength: 60000 }, operationId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['documentId', 'tabId', 'revisionId', 'startIndex', 'endIndex', 'quote', 'replacement', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_insert', description: 'Stage new text insertion into Google Docs for exact author review. This tool only reads and queues; UI approval applies the guarded insertion.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 256 }, tabId: { type: 'string', maxLength: 256 }, revisionId: { type: 'string', minLength: 1, maxLength: 512 }, index: { type: 'integer', minimum: 0 }, text: { type: 'string', minLength: 1, maxLength: 60000 }, operationId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['documentId', 'tabId', 'revisionId', 'index', 'text', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_create_note', description: 'Stage a readable draft Google Docs source note for author review. Optional source bindings identify the source and revision; no existing document is overwritten.', inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 512 }, text: { type: 'string', minLength: 1, maxLength: 60000 }, sourceUrl: { type: 'string', maxLength: 2048 }, sourceTabOrRange: { type: 'string', maxLength: 512 }, quote: { type: 'string', maxLength: 60000 }, sourceRevision: { type: 'string', maxLength: 512 }, operationId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['title', 'text', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_google_reply', description: 'Stage a reply to an exact existing Google Drive comment thread for author review. Requires the current thread content hash; UI approval writes only to that thread.', inputSchema: { type: 'object', properties: { documentId: { type: 'string', minLength: 1, maxLength: 256 }, commentId: { type: 'string', minLength: 1, maxLength: 256 }, commentHash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }, text: { type: 'string', minLength: 1, maxLength: 60000 }, operationId: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['documentId', 'commentId', 'commentHash', 'text', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_sheets_list', description: 'Search one bounded page of Google Sheets available to the authorized account. Uses Drive metadata search; requires Google Drive read scope and performs no writes.', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 }, pageToken: { type: 'string', maxLength: 4096 }, pageSize: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_sheets_read', description: 'Read spreadsheet metadata and one exact finite A1 range (at most 2,000 cells) with FORMULA rendering. Read the linked-index headers first, then request only its bounded source range; draft material stays draft and is never promoted to canon automatically. No writes occur.', inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string', minLength: 1, maxLength: 256 }, range: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['spreadsheetId', 'range'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  { name: 'talewisp_web_sheets_update', description: 'Prepare an exact bounded Google Sheets index update for the author review queue. Requires the range, values, and valueHash returned by a fresh read; it only stages a proposal. The workspace UI must explicitly approve it before values are written with RAW input and readback verification. Google Sheets has no atomic revision guard, so a hash check can race with another editor.', inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string', minLength: 1, maxLength: 256 }, range: { type: 'string', minLength: 1, maxLength: 512 }, beforeHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, values: { type: 'array', minItems: 1, maxItems: 2000, items: { type: 'array', minItems: 1, maxItems: 2000 } }, operationId: { type: 'string', minLength: 8, maxLength: 200 } }, required: ['spreadsheetId', 'range', 'beforeHash', 'values', 'operationId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } }
];

function schemaAccepts(schema, value, at = 'arguments') {
  const type = schema?.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type && type !== actual && !(type === 'integer' && Number.isInteger(value))) throw ERROR(`${at} must be ${type}.`);
  if (schema?.enum && !schema.enum.includes(value)) throw ERROR(`${at} has an unsupported value.`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) throw ERROR(`${at} is too short.`);
    if (schema.maxLength != null && value.length > schema.maxLength) throw ERROR(`${at} is too long.`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) throw ERROR(`${at} has an invalid format.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) throw ERROR(`${at} is below its minimum.`);
    if (schema.maximum != null && value > schema.maximum) throw ERROR(`${at} exceeds its maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) throw ERROR(`${at} has too few items.`);
    if (schema.maxItems != null && value.length > schema.maxItems) throw ERROR(`${at} has too many items.`);
    if (schema.items) value.forEach((item, index) => schemaAccepts(schema.items, item, `${at}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) throw ERROR(`${at}.${key} is required.`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) throw ERROR(`${at}.${key} is not allowed.`);
    for (const [key, item] of Object.entries(value)) if (properties[key]) schemaAccepts(properties[key], item, `${at}.${key}`);
  }
}

class NativeMcpClient {
  constructor({ pythonExecutable, talewispMcpPath, vaultPath, spawnImpl = spawn }) {
    this.proc = spawnImpl(pythonExecutable, ['-u', talewispMcpPath], {
      env: this.environment(vaultPath), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.pending = new Map(); this.seq = 0; this.closed = false; this.stderr = '';
    const lines = createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.onLine(line));
    this.proc.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000); });
    this.proc.on('error', error => this.failAll(new Error(`TaleWisp plugin failed to start: ${error.message}`)));
    this.proc.on('exit', code => { this.closed = true; this.failAll(new Error(`TaleWisp plugin exited (${code ?? 'unknown'}).`)); });
  }
  environment(vaultPath) {
    const env = {};
    for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL']) if (process.env[key] != null) env[key] = process.env[key];
    env.TALEWISP_VAULT = vaultPath;
    env.PYTHONDONTWRITEBYTECODE = '1';
    return env;
  }
  failAll(error) { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  onLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { this.close(); return; }
    let value; try { value = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id); clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error(value.error.message ?? 'TaleWisp MCP request failed.'));
    else pending.resolve(value.result ?? {});
  }
  request(method, params = {}, timeoutMs = 25_000) {
    if (this.closed) return Promise.reject(new Error('TaleWisp plugin is unavailable.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`TaleWisp ${method} timed out.`)); }, timeoutMs); timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'talewisp-local-workspace', version: '0.1.0' } });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return (await this.request('tools/list')).tools ?? [];
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.kill(); } catch {}
    this.failAll(new Error('TaleWisp plugin stopped.'));
  }
}

/** Executes the installed TaleWisp MCP against the currently selected series. */
export class PluginService {
  constructor({ workspaceService, dataDir, pythonExecutable = 'python', talewispMcpPath, spawnImpl = spawn, googleService = null }) {
    this.workspaceService = workspaceService; this.dataDir = dataDir; this.pythonExecutable = pythonExecutable;
    this.talewispMcpPath = talewispMcpPath; this.spawnImpl = spawnImpl; this.client = null; this.clientRoot = null; this.toolCache = null; this.googleService = googleService;
  }
  async _client() {
    const root = await this.workspaceService.root();
    if (!root) throw new Error('Select a TaleWisp series before using its tools.');
    if (this.client && (this.clientRoot !== root || this.client.closed)) { await this.client.close(); this.client = null; this.toolCache = null; }
    if (!this.client) {
      this.clientRoot = root;
      this.client = new NativeMcpClient({ pythonExecutable: this.pythonExecutable, talewispMcpPath: this.talewispMcpPath, vaultPath: root, spawnImpl: this.spawnImpl });
    }
    return this.client;
  }
  async tools() {
    const client = await this._client();
    if (!this.toolCache) this.toolCache = await client.initialize();
    return [...this.toolCache.map(tool => ({ ...tool, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } })), ...WEB_GOOGLE_TOOLS];
  }
  setGoogleService(service) { this.googleService = service; }
  async capabilities() {
    const status = await this.googleService?.capabilities?.() ?? { configured: false, authenticated: false, reason: 'service_unavailable', scopes: [] };
    const capabilities = {
      configured: status.configured === true,
      authenticated: status.authenticated === true,
      reason: status.reason ?? null,
      googleDocs: {
        authenticated: status.authenticated === true,
        canRead: status.canReadDocs === true,
        canSuggest: status.canSuggestDocs === true,
        canComment: status.canCommentDocs === true,
      },
      googleProducts: {
        canDirectEdit: status.canDirectEditDocs === true,
        canInsert: status.canInsertDocs === true,
        canCreateNote: status.canCreateNoteDocs === true,
        canReply: status.canReply === true,
      },
      googleSheets: {
        authenticated: status.authenticated === true,
        canRead: status.canReadSheets === true,
        canWrite: status.canWriteSheets === true,
      },
    };
    if (Array.isArray(status.scopes)) capabilities.grantedScopes = status.scopes;
    if (status.serviceApiError) capabilities.serviceApiError = status.serviceApiError;
    return capabilities;
  }
  async _requireGoogle() {
    const status = await this.googleService?.status?.();
    if (!status?.configured || !status?.authenticated) throw Object.assign(new Error('Google Workspace is not connected. Configure and connect Google in the workspace settings.'), { status: 503 });
    return this.googleService;
  }
  async _proposalAction(name, args, workspaceRevision) {
    if (name === 'talewisp_save_proposal') {
      const baseRevision = args.baseRevision ?? args.base_revision;
      const proposal = await this.workspaceService.prepareProposal({
        path: args.source_path ?? null,
        text: args.replacement_text,
        title: args.title,
        summary: args.summary ?? `${args.proposal_type} proposal`,
        ...(baseRevision !== undefined ? { baseRevision } : {})
      });
      return { proposal, status: 'pending_author_review', message: 'Proposal prepared for explicit review. The source has not been changed.' };
    }
    if (name === 'talewisp_apply_proposal') {
      const action = await this._prepareNativeApplyAction(args);
      const proposal = await this.workspaceService.queueAction({ tool: name, arguments: action.arguments, summary: action.summary });
      return { proposal, status: 'pending_author_review', message: 'The native pending proposal and exact before/after preview are queued. The model confirmation flag was ignored; review and approve this action in the workspace UI.' };
    }
    if (name === 'talewisp_select_vault') return { status: 'catalog_selection_required', message: 'Choose an author, series, and book in workspace settings. Arbitrary filesystem roots are not accepted.' };
    await this._validateQueuedMutation(name, args);
    const summary = typeof args.summary === 'string' ? args.summary : `Review ${name}`;
    const proposal = await this.workspaceService.queueAction({ tool: name, arguments: args, summary });
    return { proposal, status: 'pending_author_review', message: 'Action queued with its complete arguments. It will run only after explicit approval in the workspace UI.' };
  }
  async _validateQueuedMutation(name, args) {
    if (name === 'talewisp_model_selection' && args.project_root) {
      const projectRoot = realpathSync(process.cwd());
      const candidatePath = resolve(projectRoot, args.project_root);
      let candidate;
      try { candidate = realpathSync(candidatePath); } catch { throw ERROR('Model selection project_root must exist inside the current project.'); }
      if (candidate !== projectRoot && !isInside(projectRoot, candidate)) throw ERROR('Model selection project_root escapes the current project.');
      if (!lstatSync(candidate).isDirectory()) throw ERROR('Model selection project_root must be a project directory.');
    }
    if (name === 'talewisp_build_series_base' && Array.isArray(args.files) && args.files.length) {
      if (args.action !== 'prepare') throw ERROR('Series-base source files are accepted only during the explicit prepare step.');
      const activeRoot = realpathSync(await this.workspaceService.root());
      const dataRoot = realpathSync(this.dataDir);
      for (const file of args.files) {
        if (typeof file !== 'string' || !isAbsolute(file)) throw ERROR('Series-base source paths must be absolute paths from the active catalog or workspace data.');
        let actual;
        try { actual = realpathSync(file); } catch { throw ERROR('A series-base source file is missing.'); }
        if (!isInside(activeRoot, actual) && actual !== activeRoot && !isInside(dataRoot, actual)) throw ERROR('Series-base source paths must stay inside the active catalog or workspace data.');
        const stat = lstatSync(actual);
        if (stat.isSymbolicLink() || !stat.isFile()) throw ERROR('Series-base source inputs must be regular files, not symlinks.');
      }
    }
  }
  async _prepareNativeApplyAction(args) {
    const rootValue = await this.workspaceService.root();
    if (typeof rootValue !== 'string' || !rootValue) throw Object.assign(new Error('Select an active series before reviewing a native proposal.'), { status: 409 });
    const root = realpathSync(rootValue);
    assertDirectory(root, 'Active series root');
    for (const segment of ['.talewisp', 'proposals', 'pending']) assertDirectory(join(root, ...['.talewisp', 'proposals', 'pending'].slice(0, ['.talewisp', 'proposals', 'pending'].indexOf(segment) + 1)), 'Pending proposal directory');
    const pendingDir = join(root, '.talewisp', 'proposals', 'pending');
    const proposalPath = assertVaultRelativePath(root, args.proposal_path, 'Proposal path');
    if (dirname(proposalPath) !== pendingDir || !proposalPath.toLowerCase().endsWith('.json')) throw ERROR('Only a direct .json file in the active series pending-proposals folder can be reviewed.');
    assertRegularFile(proposalPath, 'Pending proposal JSON');
    const proposalBytes = readFileSync(proposalPath);
    if (proposalBytes.length > MAX_NATIVE_PROPOSAL_BYTES) throw ERROR('Pending proposal JSON exceeds the review size limit.');
    let proposal;
    try { proposal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(proposalBytes)); }
    catch { throw ERROR('Pending proposal is not valid UTF-8 JSON.'); }
    const expectedId = basename(proposalPath, '.json');
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || proposal.schema_version !== 1 || proposal.id !== expectedId || proposal.status !== 'pending' || !['revision', 'continuation', 'canon'].includes(proposal.proposal_type) || typeof proposal.title !== 'string' || typeof proposal.replacement_text !== 'string' || !proposal.replacement_text || typeof proposal.summary !== 'string' || !Array.isArray(proposal.evidence)) throw ERROR('Pending proposal structure is incomplete or unsupported.');
    const previewPath = proposalPath.slice(0, -5) + '.md';
    assertRegularFile(previewPath, 'Pending proposal preview');
    const previewBytes = readFileSync(previewPath);
    const previewText = new TextDecoder('utf-8', { fatal: true }).decode(previewBytes);
    if (previewText.replaceAll('\r\n', '\n') !== nativePreview(proposal)) throw ERROR('Pending proposal preview does not match its source JSON.');
    const nativeArguments = { proposal_path: args.proposal_path, confirmed: false };
    if (args.target_path !== undefined) nativeArguments.target_path = args.target_path;
    const sourcePath = proposal.source_path;
    let source;
    let targetPath = null;
    if (sourcePath) {
      const sourceFile = assertVaultRelativePath(root, sourcePath, 'Proposal source path');
      assertRegularFile(sourceFile, 'Proposal source');
      const sourceBytes = readFileSync(sourceFile);
      const before = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
      const nativeSource = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes).replace(/\r\n?/g, '\n');
      const beforeSha256 = sha256(sourceBytes);
      const nativeSourceSha256 = sha256(nativeSource);
      if (typeof proposal.source_sha256 !== 'string' || proposal.source_sha256 !== nativeSourceSha256) throw Object.assign(new Error('Proposal source changed after it was staged.'), { status: 409 });
      const actualSource = realpathSync(sourceFile);
      if (!isInside(root, actualSource)) throw ERROR('Proposal source resolves outside the active series.');
      source = { path: sourcePath, before, beforeSha256, nativeBeforeSha256: nativeSourceSha256, expectedSourceSha256: proposal.source_sha256 };
    } else {
      targetPath = proposal.continuity_extraction?.target_path ?? args.target_path;
      if (typeof targetPath !== 'string' || !targetPath) throw ERROR('A standalone native proposal requires its validated target path.');
      const target = assertVaultRelativePath(root, targetPath, 'Proposal target path');
      if (target.startsWith(join(root, '.talewisp') + sep)) throw ERROR('Native proposals cannot target internal .talewisp state.');
      if (existsSync(target)) throw Object.assign(new Error('Proposal target already exists; refresh the proposal before review.'), { status: 409 });
      source = { path: null, before: null, beforeSha256: null, expectedSourceSha256: null, targetPath };
      nativeArguments.target_path = targetPath;
    }
    const review = {
      proposal: JSON.parse(JSON.stringify(proposal)),
      proposalSha256: sha256(proposalBytes),
      previewText,
      previewSha256: sha256(previewBytes),
      source,
      after: proposal.replacement_text
    };
    const summary = `Apply pending ${proposal.proposal_type} proposal: ${proposal.title}`;
    return { arguments: { ...nativeArguments, _review: review }, summary };
  }
  async _validateNativeApplyAction(action) {
    const args = action.arguments ?? {};
    const review = args._review;
    if (!review || typeof review !== 'object' || Array.isArray(review)) throw ERROR('Native proposal review snapshot is missing. Prepare the proposal again.');
    const current = await this._prepareNativeApplyAction({ proposal_path: args.proposal_path, ...(args.target_path !== undefined ? { target_path: args.target_path } : {}) });
    const next = current.arguments._review;
    if (review.proposalSha256 !== next.proposalSha256 || review.previewSha256 !== next.previewSha256 || review.after !== next.after || stableJson(review.proposal) !== stableJson(next.proposal) || stableJson(review.source) !== stableJson(next.source)) throw Object.assign(new Error('Pending proposal or source changed after review. Reopen the current preview.'), { status: 409 });
    const nativeArguments = { proposal_path: args.proposal_path, confirmed: true };
    if (args.target_path !== undefined) nativeArguments.target_path = args.target_path;
    else if (next.source?.targetPath) nativeArguments.target_path = next.source.targetPath;
    return nativeArguments;
  }
  async call(name, args = {}, workspaceRevision) {
    const tools = await this.tools();
    const tool = tools.find(item => item.name === name);
    if (!tool) throw ERROR('Unknown TaleWisp tool.');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw ERROR('Tool arguments must be an object.');
    schemaAccepts(tool.inputSchema, args);
    const currentRevision = await this.workspaceService.revision();
    if (workspaceRevision != null && currentRevision !== workspaceRevision) throw Object.assign(new Error('The workspace changed during this turn. Restart the turn in the selected series.'), { status: 409 });
    if (name === 'talewisp_web_google_list') return (await this._requireGoogle()).listDocuments(args);
    if (name === 'talewisp_web_google_read') return (await this._requireGoogle()).readDocument(args.documentId);
    if (name === 'talewisp_web_sheets_list') return (await this._requireGoogle()).listSpreadsheets(args);
    if (name === 'talewisp_web_sheets_read') return (await this._requireGoogle()).readSpreadsheet(args);
    if (name === 'talewisp_web_sheets_update') {
      const google = await this._requireGoogle();
      const bounds = parseBoundedA1Range(args.range);
      const proposalValues = validateWriteGrid(args.range, args.values);
      const before = await google.readSpreadsheet({ spreadsheetId: args.spreadsheetId, range: args.range });
      if (before.valueHash !== args.beforeHash) throw Object.assign(new Error('The linked index changed since it was read. Reload its bounded range before staging an update.'), { status: 409 });
      if (containsFormula(before.values)) throw Object.assign(new Error('This bounded range contains formula cells. Narrow the update to text-only cells so RAW values do not replace formulas.'), { code: 'GOOGLE_SHEET_FORMULA_UNSUPPORTED', status: 409 });
      if (bounds.cells > 2000) throw ERROR('A Sheets update is limited to 2,000 cells.');
      const action = { spreadsheetId: args.spreadsheetId, range: args.range, beforeValues: before.values, beforeHash: before.valueHash, values: proposalValues, operationId: args.operationId };
      const proposal = await this.workspaceService.queueAction({ tool: name, arguments: action, summary: args.summary ?? `Google Sheets index update: ${before.title} ${args.range}` });
      return { proposal, status: 'pending_author_review', message: 'The exact before-values, before-hash, and proposed values are queued. No Google write has occurred; review and approve this action in the workspace UI.' };
    }
    if (name === 'talewisp_web_google_suggest' || name === 'talewisp_web_google_comment') {
      const proposal = await this.workspaceService.queueAction({ tool: name, arguments: args, summary: `${name.endsWith('suggest') ? 'Google Docs suggestion' : 'Google Docs comment'}: ${args.documentId}` });
      return { proposal, status: 'pending_author_review', message: 'The exact quoted range and operation details are queued. No Google write has occurred; review and approve it in the workspace UI.' };
    }
    if (name === 'talewisp_model_selection' && args.choice === 'once') {
      await this._validateQueuedMutation(name, args);
      const client = await this._client();
      const result = await client.request('tools/call', { name, arguments: args });
      if (result.isError) throw Object.assign(new Error(result.structuredContent?.error ?? 'TaleWisp model selection failed.'), { status: 400 });
      return result;
    }
    const productKinds = {
      talewisp_web_google_direct_edit: 'direct_edit',
      talewisp_web_google_insert: 'insert',
      talewisp_web_google_create_note: 'create_note',
      talewisp_web_google_reply: 'reply',
    };
    if (productKinds[name]) {
      const google = await this._requireGoogle();
      const prepared = await google.stageProduct(productKinds[name], args);
      const action = { ...args, _review: prepared.review };
      const proposal = await this.workspaceService.queueAction({ tool: name, arguments: action, summary: prepared.summary });
      return { proposal, status: 'pending_author_review', message: 'The native Google product and its exact before/after preview are queued. No Google write has occurred; author UI approval is required.' };
    }
    if (READ_ONLY_EXCEPTIONS.has(name)) return this._proposalAction(name, args, currentRevision);
    if (tool.annotations?.readOnlyHint !== true) return this._proposalAction(name, args, currentRevision);
    const client = await this._client();
    const result = await client.request('tools/call', { name, arguments: args });
    if (result.isError) throw Object.assign(new Error(result.structuredContent?.error ?? 'TaleWisp tool failed.'), { status: 400 });
    return result;
  }
  async applyAction(action) {
    if (!action || typeof action.tool !== 'string' || !action.arguments || typeof action.arguments !== 'object') throw ERROR('Invalid queued TaleWisp action.');
    const currentRevision = await this.workspaceService.revision();
    if (action.workspaceRevision != null && action.workspaceRevision !== currentRevision) throw Object.assign(new Error('The workspace changed after this action was queued.'), { status: 409 });
    if (action.tool === 'talewisp_apply_proposal') {
      const nativeArguments = await this._validateNativeApplyAction(action);
      const tool = (await this.tools()).find(item => item.name === action.tool);
      schemaAccepts(tool.inputSchema, nativeArguments);
      const client = await this._client();
      const result = await client.request('tools/call', { name: action.tool, arguments: nativeArguments });
      if (result.isError) throw Object.assign(new Error(result.structuredContent?.error ?? 'Native proposal apply failed.'), { status: 409 });
      return result;
    }
    if (action.tool === 'talewisp_web_google_suggest' || action.tool === 'talewisp_web_google_comment') {
      const google = await this._requireGoogle();
      return action.tool === 'talewisp_web_google_suggest' ? google.suggest(action.arguments) : google.comment(action.arguments);
    }
    const productKinds = {
      talewisp_web_google_direct_edit: 'direct_edit',
      talewisp_web_google_insert: 'insert',
      talewisp_web_google_create_note: 'create_note',
      talewisp_web_google_reply: 'reply',
    };
    if (productKinds[action.tool]) {
      const { _review, ...payload } = action.arguments;
      const tool = (await this.tools()).find(item => item.name === action.tool);
      if (!tool) throw ERROR('Queued Google product is no longer supported.');
      schemaAccepts(tool.inputSchema, payload);
      return (await this._requireGoogle()).applyProduct(productKinds[action.tool], action.arguments);
    }
    if (action.tool === 'talewisp_web_sheets_update') return (await this._requireGoogle()).updateSpreadsheet(action.arguments);
    const tool = (await this.tools()).find(item => item.name === action.tool);
    if (!tool || tool.annotations?.readOnlyHint === true || READ_ONLY_EXCEPTIONS.has(action.tool)) throw ERROR('This queued action is not an applicable TaleWisp mutation.');
    schemaAccepts(tool.inputSchema, action.arguments);
    await this._validateQueuedMutation(action.tool, action.arguments);
    const client = await this._client();
    const result = await client.request('tools/call', { name: action.tool, arguments: action.arguments });
    if (result.isError) throw Object.assign(new Error(result.structuredContent?.error ?? 'TaleWisp action failed.'), { status: 400 });
    return result;
  }
  async setWorkspace() { await this.client?.close(); this.client = null; this.clientRoot = null; this.toolCache = null; }
  async shutdown() { await this.client?.close(); this.client = null; this.clientRoot = null; this.toolCache = null; }
}

export const createPluginService = options => new PluginService(options);
