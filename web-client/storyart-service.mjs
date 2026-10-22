import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDesktopHostClient } from './desktop-host.mjs';

const SETTING_KEY = 'storyart.partnerJournal.v1';
const REQUIRED_TOOLS = ['list_projects', 'create_thread', 'send_message_to_thread', 'read_thread'];
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_BRIEF_CHARS = 60000;
const MAX_MESSAGE_CHARS = 12000;
const MAX_RECEIPT_CHARS = 20000;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const ARTIFACT_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);

function safeText(value, max = MAX_RECEIPT_CHARS) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function normalizedPath(value) {
  return path.win32.normalize(String(value ?? '').trim()).replace(/[\\/]+$/, '').toLowerCase();
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function extractThreadReceipt(payload) {
  const threadId = typeof payload?.threadId === 'string' ? payload.threadId : null;
  const clientThreadId = typeof payload?.clientThreadId === 'string' ? payload.clientThreadId : null;
  const status = payload?.status ?? (threadId ? 'created' : clientThreadId ? 'setup_pending' : 'unknown');
  return { threadId, clientThreadId, status: safeText(status, 80), receipt: safeText(payload?.text ?? JSON.stringify(payload)) };
}

function normalizePartnerStatus(value, fallback = null) {
  const toText = item => typeof item === 'object' && item !== null ? item.type ?? item.status ?? '' : item;
  const normalize = item => String(toText(item) ?? '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/-/g, '_');
  const map = status => {
    if (['running', 'in_progress', 'active'].includes(status)) return 'running';
    if (['completed', 'complete', 'done'].includes(status)) return 'completed';
    if (['error', 'failed', 'errored'].includes(status)) return 'error';
    if (status === 'idle') return 'idle';
    return null;
  };
  return map(normalize(value)) ?? map(normalize(fallback));
}

function extractThreadText(payload) {
  if (typeof payload === 'string') return { text: safeText(payload), status: null };
  if (!payload || typeof payload !== 'object') return { text: '', status: null };

  if (payload.thread && Array.isArray(payload.turns)) {
    const turns = payload.turns.slice(0, 10);
    const newestFirst = payload.page?.order !== 'oldest_first';
    const latestTurn = newestFirst ? turns[0] : turns.at(-1);
    const messages = Array.isArray(latestTurn?.items)
      ? latestTurn.items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string').map(item => ({
        text: item.text,
        phase: String(item.phase ?? '').toLowerCase(),
      }))
      : [];
    const finals = messages.filter(message => ['final', 'final_answer'].includes(message.phase));
    const chosen = finals.at(-1) ?? messages.at(-1);
    const fullText = chosen ? String(chosen.text).slice(-MAX_RECEIPT_CHARS).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : '';
    return { text: fullText, status: normalizePartnerStatus(latestTurn?.status, payload.thread.status) };
  }

  // Test adapters and generic host results may expose one explicit result text field.
  return { text: typeof payload.text === 'string' ? safeText(payload.text) : '', status: null };
}

function receiptStatuses(text) {
  const pick = (name, allowed) => {
    const m = text.match(new RegExp(`^\\s*${name}\\s*:\\s*(${allowed.join('|')})\\s*$`, 'im'));
    return m ? m[1].toUpperCase() : null;
  };
  return {
    visualQa: pick('VISUAL_QA', ['PASS', 'FAIL', 'PENDING']),
    canonQa: pick('CANON_QA', ['PASS', 'FAIL', 'PENDING']),
    authorApproval: pick('AUTHOR_APPROVAL', ['APPROVED', 'PENDING', 'REJECTED']),
  };
}

function errorResult(error, status = 'error') {
  return { ok: false, status, error: safeText(error?.message ?? error, 500) };
}

/**
 * TaleWisp-side narrow coordinator for one dedicated StoryArt task per request.
 * `context.scope` is supplied by the caller's selected workspace binding.
 */
export function createStoryArtService({ store, hostClient = null, projectPath = 'D:\\Projects\\StoryArt', fsImpl = fs, clockImpl = () => performance.now(), sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!store?.getSetting || !store?.setSetting) throw new TypeError('StoryArt service requires the persistent workspace store.');
  const host = hostClient ?? (() => {
    try { return createDesktopHostClient(); } catch { return null; }
  })();
  const projectRoot = path.win32.resolve(projectPath);
  const generationRoot = path.win32.join(projectRoot, 'GENERATIONS');
  let probePromise = null;
  let operationQueue = Promise.resolve();
  let selected = null;

  function scopeFrom(context) {
    const scope = typeof context?.scope === 'string' ? context.scope.trim() : '';
    if (!scope || scope.length > 300) throw new Error('A selected workspace scope is required for StoryArt pairing.');
    return scope;
  }

  function readJournal() {
    const raw = store.getSetting(SETTING_KEY);
    const text = typeof raw === 'string' ? raw : '';
    if (Buffer.byteLength(text, 'utf8') > MAX_JOURNAL_BYTES) throw new Error('StoryArt request journal exceeds its safe size limit.');
    const parsed = parseMaybeJson(text);
    if (text.trim() && (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.requests || typeof parsed.requests !== 'object')) {
      throw new Error('StoryArt request journal is unreadable; refusing to create or select a possibly duplicate task.');
    }
    return parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.requests && typeof parsed.requests === 'object'
      ? parsed : { version: 1, requests: {} };
  }

  function writeJournal(journal) {
    store.setSetting(SETTING_KEY, JSON.stringify(journal));
  }

  function findRequest(journal, requestId, scope) {
    const request = journal.requests[requestId];
    if (!request || request.scope !== scope) throw new Error('No StoryArt pairing owned by this workspace matches that request ID.');
    return request;
  }

  async function probe() {
    if (probePromise) return probePromise;
    probePromise = (async () => {
      if (!host) {
        selected = { available: false, requiresDesktop: true, project: null, capabilities: [], reason: 'The inherited Codex desktop bridge is unavailable.' };
        return selected;
      }
      try {
        const [tools, projectsPayload] = await Promise.all([host.listTools(), host.listProjects()]);
        const projects = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects : [];
        const project = projects.find(item => normalizedPath(item.path) === normalizedPath(projectRoot) && item.projectKind === 'local');
        const capabilities = REQUIRED_TOOLS.filter(name => tools.includes(name));
        selected = {
          available: Boolean(project && REQUIRED_TOOLS.every(name => capabilities.includes(name))),
          requiresDesktop: true,
          waitTransport: 'bounded_read_thread',
          project: project ? { projectId: project.projectId, label: safeText(project.label, 120), path: projectPath } : null,
          capabilities,
          ...(project ? {} : { reason: 'The selected StoryArt project is not registered on this desktop host.' }),
        };
      } catch (error) {
        selected = { available: false, requiresDesktop: true, project: null, capabilities: [], reason: safeText(error?.message ?? error, 500) };
      }
      return selected;
    })();
    return probePromise;
  }

  function status(context) {
    const scope = scopeFrom(context);
    const journal = readJournal();
    const requests = Object.entries(journal.requests)
      .filter(([, request]) => request.scope === scope)
      .map(([requestId, request]) => ({
        requestId,
        pairId: request.pairId,
        threadId: request.threadId ?? null,
        status: request.partnerStatus ?? request.status,
        lifecycleStatus: request.status,
        partnerStatus: request.partnerStatus ?? null,
        title: `StoryArt ${request.pairId}`,
        result: request.lastReceipt ?? null,
        visualQa: request.lastStatuses?.visualQa ?? null,
        canonQa: request.lastStatuses?.canonQa ?? null,
        authorApproval: request.lastStatuses?.authorApproval ?? null,
        error: ['unknown', 'failed'].includes(request.status) ? safeText(request.receipt, 500) : null,
        artifacts: (request.artifactPaths ?? []).map((reportedPath, index) => ({
          index,
          label: path.win32.basename(reportedPath),
        })),
        updatedAt: request.updatedAt,
      }))
      .slice(-50);
    return { ...(selected ?? { available: false, requiresDesktop: true, project: null, capabilities: [], reason: 'StoryArt host capability probe has not run.' }), requests };
  }

  async function executeOnce(input, context) {
    let scope;
    try { scope = scopeFrom(context); } catch (error) { return errorResult(error); }
    if (!input || !['create', 'send', 'read', 'wait'].includes(input.operation)) return errorResult('Unsupported StoryArt operation.');
    const capability = selected ?? await probe();
    if (!capability.available) return { ...errorResult(capability.reason || 'StoryArt desktop host is unavailable.', 'unavailable'), requiresDesktop: true };
    const journal = readJournal();
    const now = () => new Date().toISOString();

    if (input.operation === 'create') {
      const requestId = typeof input.requestId === 'string' && /^[\w.-]{8,100}$/.test(input.requestId) ? input.requestId : randomUUID();
      const existing = journal.requests[requestId];
      if (existing) {
        if (existing.scope !== scope) return errorResult('That request ID belongs to another workspace scope.');
        if (existing.status === 'dispatching' || existing.status === 'unknown') return { ...errorResult('Creation outcome is unresolved; retry is disabled to prevent a duplicate StoryArt task.', 'unknown_outcome'), requestId, pairId: existing.pairId };
        return { ok: existing.status === 'created' || existing.status === 'setup_pending', requestId, pairId: existing.pairId, threadId: existing.threadId ?? null, status: existing.status, hostReceipt: existing.receipt ?? '' };
      }
      const brief = safeText(input.brief, MAX_BRIEF_CHARS).trim();
      if (!brief) return errorResult('The complete author-approved illustration brief is required.');
      if (/^\s*(?:PAIR_ID|RETURN_THREAD_ID)\s*:/im.test(brief)) {
        return errorResult('The brief cannot override the trusted PAIR_ID or inherited RETURN_THREAD_ID headers.');
      }
      const returnThreadId = typeof host?.threadId === 'string' && host.threadId ? host.threadId : null;
      if (!returnThreadId) return errorResult('The actual inherited TaleWisp desktop thread ID is unavailable.');
      const pairId = requestId;
      const prompt = [
        'PAIR_BRIEF', `PAIR_ID: ${pairId}`, `RETURN_THREAD_ID: ${returnThreadId}`, brief,
        '', 'On completion, report the real absolute generated candidate file path as ARTIFACT_PATH: <path>. Report VISUAL_QA, CANON_QA, and AUTHOR_APPROVAL separately using PASS/FAIL/PENDING, PASS/FAIL/PENDING, and APPROVED/REJECTED/PENDING. Report only states and paths actually present in StoryArt; do not infer or manufacture a pass or approval.',
      ].join('\n');
      journal.requests[requestId] = { pairId, scope, projectPath, status: 'dispatching', threadId: null, receipt: null, artifactPaths: [], createdAt: now(), updatedAt: now() };
      writeJournal(journal);
      try {
        const payload = await host.createThread({
          prompt,
          title: `StoryArt ${pairId}`,
          target: { type: 'project', projectId: capability.project.projectId, environment: { type: 'local' } },
        });
        const receipt = extractThreadReceipt(payload);
        const item = journal.requests[requestId];
        item.status = receipt.threadId ? 'created' : receipt.clientThreadId ? 'setup_pending' : 'unknown';
        item.threadId = receipt.threadId;
        item.receipt = receipt.receipt;
        item.clientThreadId = receipt.clientThreadId;
        item.updatedAt = now();
        writeJournal(journal);
        return { ok: item.status !== 'unknown', requestId, pairId, threadId: item.threadId, status: item.status, hostReceipt: item.receipt };
      } catch (error) {
        journal.requests[requestId].status = 'unknown';
        journal.requests[requestId].receipt = safeText(error?.message ?? error, MAX_RECEIPT_CHARS);
        journal.requests[requestId].updatedAt = now();
        writeJournal(journal);
        return { ...errorResult('The host did not confirm whether the StoryArt task was created; this request will not be retried automatically.', 'unknown_outcome'), requestId, pairId };
      }
    }

    let request;
    try { request = findRequest(journal, input.requestId, scope); } catch (error) { return errorResult(error); }
    if (request.status !== 'created' || !request.threadId) return errorResult('The dedicated StoryArt task does not have a confirmed usable thread ID.', request.status);
    try {
      let payload;
      let receipt;
      if (input.operation === 'send') {
        const message = safeText(input.message, MAX_MESSAGE_CHARS).trim();
        if (!message) return errorResult('A transition message is required.');
        payload = await host.sendMessage({ threadId: request.threadId, prompt: message });
        const sentText = extractThreadText(payload).text;
        receipt = sentText || JSON.stringify({ transportAccepted: true, operation: 'send_message_to_thread', threadId: request.threadId, partnerResponse: null });
      } else if (input.operation === 'read') {
        payload = await host.readThread({ threadId: request.threadId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 4000 });
        const partner = extractThreadText(payload);
        receipt = partner.text;
        request.partnerStatus = partner.status;
        captureArtifactPaths(request, partner.text);
      } else {
        const timeoutMs = input.timeoutMs ?? 0;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) return errorResult('StoryArt wait timeout must be an integer from 0 to 60000 milliseconds.');
        const startedAt = clockImpl();
        const pollIntervalMs = timeoutMs > 0 ? Math.max(250, Math.ceil(timeoutMs / 5)) : 0;
        let polls = 0;
        let terminal = false;
        do {
          if (polls > 0) {
            const elapsedBeforeSleep = Math.max(0, clockImpl() - startedAt);
            if (elapsedBeforeSleep >= timeoutMs || polls >= 6) break;
            await sleepImpl(Math.min(pollIntervalMs, timeoutMs - elapsedBeforeSleep));
          }
          payload = await host.readThread({ threadId: request.threadId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 4000 });
          const partner = extractThreadText(payload);
          receipt = partner.text;
          request.partnerStatus = partner.status;
          captureArtifactPaths(request, partner.text);
          request.lastReceipt = receipt;
          request.lastStatuses = receiptStatuses(receipt);
          request.updatedAt = now();
          writeJournal(journal);
          polls++;
          terminal = ['completed', 'error'].includes(request.partnerStatus);
        } while (polls < 6 && !terminal && timeoutMs > 0);
        const elapsedMs = Math.max(0, Math.round(clockImpl() - startedAt));
        const timedOut = timeoutMs > 0 && !terminal && (elapsedMs >= timeoutMs || polls >= 6);
        request.lastWaitReceipt = { transport: 'bounded_read_thread', polls, elapsedMs, timedOut };
      }
      receipt = safeText(receipt);
      request.lastReceipt = receipt;
      request.lastStatuses = receiptStatuses(receipt);
      request.updatedAt = now();
      writeJournal(journal);
      return { ok: true, requestId: input.requestId, pairId: request.pairId, threadId: request.threadId, status: request.partnerStatus ?? request.status, lifecycleStatus: request.status, partnerStatus: request.partnerStatus ?? null, hostReceipt: receipt, ...(input.operation === 'wait' ? { waitReceipt: request.lastWaitReceipt } : {}), ...request.lastStatuses };
    } catch (error) { return errorResult(error); }
  }

  function execute(input, context) {
    const next = operationQueue.then(() => executeOnce(input, context));
    operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  function captureArtifactPaths(request, text) {
    const entries = [...text.matchAll(/^\s*ARTIFACT_PATH\s*:\s*(.+?)\s*$/gim)].map(match => match[1].trim());
    if (!entries.length) return;
    request.artifactPaths = [...new Set([...(request.artifactPaths ?? []), ...entries])].slice(0, 10);
  }

  async function artifact(input, context) {
    let scope;
    try { scope = scopeFrom(context); } catch (error) { return errorResult(error); }
    let request;
    try { request = findRequest(readJournal(), input?.requestId, scope); } catch (error) { return errorResult(error); }
    if (!request.threadId || !['created', 'setup_pending'].includes(request.status)) return errorResult('No confirmed StoryArt thread owns an artifact receipt.');
    const receipt = safeText(request.lastReceipt ?? '');
    const candidatePaths = new Set([...(request.artifactPaths ?? []), ...[...receipt.matchAll(/^\s*ARTIFACT_PATH\s*:\s*(.+?)\s*$/gim)].map(match => match[1].trim())]);
    const artifactIndex = Number.isInteger(input?.index) && input.index >= 0 ? input.index : 0;
    const candidate = [...candidatePaths][artifactIndex];
    if (!candidate) return errorResult('StoryArt has not reported an artifact path in an owned host receipt.', 'not_found');
    const ext = path.win32.extname(candidate).toLowerCase();
    if (!ARTIFACT_TYPES.has(ext)) return errorResult('The reported StoryArt artifact type is not supported.', 'rejected');
    const normalized = path.win32.resolve(candidate);
    const relative = path.win32.relative(projectRoot, normalized);
    const parts = relative.split(path.win32.sep).filter(Boolean);
    const firstPart = parts[0]?.toUpperCase() ?? '';
    const generationStyleRoot = firstPart.endsWith('_GENERATIONS');
    const ownedResultRoot = firstPart === 'GENERATION_RESULTS' && parts[1] === input.requestId && /^[\w.-]{8,100}$/.test(input.requestId ?? '');
    const rootPrefix = projectRoot.toLowerCase() + path.win32.sep;
    if (!normalized.toLowerCase().startsWith(rootPrefix) || !(generationStyleRoot && parts.length >= 2 || ownedResultRoot && parts.length >= 3)) {
      return errorResult('The reported artifact is outside StoryArt generation output folders.', 'rejected');
    }
    try {
      const generationFolder = path.win32.join(projectRoot, ...(ownedResultRoot ? parts.slice(0, 2) : parts.slice(0, 1)));
      const realRoot = await fsImpl.realpath(projectRoot);
      const realGenerationRoot = await fsImpl.realpath(generationFolder);
      const realPath = await fsImpl.realpath(normalized);
      const realProjectPrefix = realRoot.toLowerCase() + path.win32.sep;
      const realGenerationPrefix = realGenerationRoot.toLowerCase() + path.win32.sep;
      const realRootIsAllowed = ownedResultRoot
        ? path.win32.basename(realGenerationRoot).toLowerCase() === input.requestId.toLowerCase()
          && path.win32.basename(path.win32.dirname(realGenerationRoot)).toUpperCase() === 'GENERATION_RESULTS'
        : realGenerationRoot.toUpperCase().endsWith('_GENERATIONS');
      if (!realRootIsAllowed || !realGenerationRoot.toLowerCase().startsWith(realProjectPrefix)
        || !realPath.toLowerCase().startsWith(realGenerationPrefix)) {
        return errorResult('The reported artifact resolves outside an approved StoryArt generation folder.', 'rejected');
      }
      let component = projectRoot;
      for (let index = 0; index < parts.length; index++) {
        component = path.win32.join(component, parts[index]);
        const componentInfo = await fsImpl.lstat(component);
        if (componentInfo.isSymbolicLink()) return errorResult('The reported artifact path contains a symbolic link or junction.', 'rejected');
        if (index < parts.length - 1 && !componentInfo.isDirectory()) return errorResult('The reported artifact path has a non-directory parent.', 'rejected');
      }
      const info = await fsImpl.lstat(normalized);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARTIFACT_BYTES) return errorResult('The reported artifact is not a safe regular file within the size limit.', 'rejected');
      const bytes = await fsImpl.readFile(normalized);
      if (bytes.length > MAX_ARTIFACT_BYTES) return errorResult('The reported artifact exceeds the size limit.', 'rejected');
      return { ok: true, requestId: input.requestId, pairId: request.pairId, mimeType: ARTIFACT_TYPES.get(ext), bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), statuses: request.lastStatuses ?? receiptStatuses(receipt), sourcePath: normalized };
    } catch (error) {
      return errorResult(`The reported StoryArt artifact could not be read: ${safeText(error?.message ?? error, 300)}`, 'not_found');
    }
  }

  return { probe, status, list: status, execute, artifact, projectPath, close: () => host?.close?.(), stop: () => host?.close?.() };
}

export const STORYART_TOOL = {
  type: 'function',
  name: 'talewisp_storyart_partner',
  description: 'Create a dedicated StoryArt task for an approved illustration brief, then send transition messages or read/wait on that owned task.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['create', 'send', 'read', 'wait'] },
      requestId: { type: 'string', maxLength: 100 },
      brief: { type: 'string', maxLength: MAX_BRIEF_CHARS },
      message: { type: 'string', maxLength: MAX_MESSAGE_CHARS },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 60000 },
    },
    required: ['operation'],
  },
};

