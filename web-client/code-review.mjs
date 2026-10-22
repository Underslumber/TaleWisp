import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const CODE_REVIEW_MODEL = 'gpt-6.1-sol';
export const CODE_REVIEW_EFFORT = 'medium';

const MAX_TASK_CHARS = 8_000;
const MAX_FILES = 8;
const MAX_SOURCE_CHARS = 100_000;
const MAX_REVIEW_CHARS = 40_000;
const MAX_CHILD_MS = 4 * 60_000;
const CANCEL_GRACE_MS = 5_000;
const MAX_RECENT = 20;
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.json']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete']);

export const CODE_REVIEW_TOOL = Object.freeze({
  name: 'talewisp_code_review',
  description: 'Request a host-authorized independent read-only code review of complete literal before/after source files. The host computes a hash-bound unified diff, runs syntax checks on the supplied after snapshots, and starts a fresh Sol reviewer through app-server review/start. This does not run project tests or inspect arbitrary files.',
  type: 'function',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARS },
      files: {
        type: 'array', minItems: 1, maxItems: MAX_FILES,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            before: { type: 'string', maxLength: MAX_SOURCE_CHARS },
            after: { type: 'string', maxLength: MAX_SOURCE_CHARS }
          }, required: ['path', 'before', 'after']
        }
      }
    }, required: ['task', 'files'], additionalProperties: false
  }
});

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const cleanText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} is invalid or exceeds its permitted size.`);
  return value;
};
const asLines = text => {
  if (text === '') return { lines: [], finalNewline: false };
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const finalNewline = normalized.endsWith('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
};
const sourceIsSummary = source => /(?:\.\.\.\s*(?:unchanged|omitted|rest of (?:the )?file)|\[(?:omitted|unchanged|rest of (?:the )?file)\])/i.test(source);

// Produce a real unified diff. Small inputs use LCS for readable minimal hunks;
// adversarially large line products use a valid all-lines hunk within a hard bound.
function unifiedDiff(path, before, after, context = 3) {
  const beforeLines = asLines(before); const afterLines = asLines(after);
  const a = beforeLines.lines; const b = afterLines.lines;
  const makeEdit = (type, line, side, index) => ({ type, line, noFinalNewline: index === side.lines.length - 1 && !side.finalNewline });
  let edits;
  if (a.length * b.length <= 1_000_000) {
    const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      rows[i][j] = a[i] === b[j] && !(i === a.length - 1 && j === b.length - 1 && beforeLines.finalNewline !== afterLines.finalNewline) ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
    edits = [];
    let i = 0; let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j] && !(i === a.length - 1 && j === b.length - 1 && beforeLines.finalNewline !== afterLines.finalNewline)) { edits.push(makeEdit(' ', a[i], beforeLines, i)); i++; j++; }
      else if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) { edits.push(makeEdit('+', b[j], afterLines, j)); j++; }
      else { edits.push(makeEdit('-', a[i], beforeLines, i)); i++; }
    }
  } else {
    edits = [...a.map((line, index) => makeEdit('-', line, beforeLines, index)), ...b.map((line, index) => makeEdit('+', line, afterLines, index))];
  }
  const changed = edits.flatMap((edit, index) => edit.type === ' ' ? [] : [index]);
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - context); const end = Math.min(edits.length, index + context + 1);
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  const oldAt = new Uint32Array(edits.length + 1); const newAt = new Uint32Array(edits.length + 1);
  for (let i = 0; i < edits.length; i++) {
    oldAt[i + 1] = oldAt[i] + (edits[i].type === '+' ? 0 : 1);
    newAt[i + 1] = newAt[i] + (edits[i].type === '-' ? 0 : 1);
  }
  const headers = [`--- a/${path}`, `+++ b/${path}`];
  for (const range of ranges) {
    const oldCount = oldAt[range.end] - oldAt[range.start]; const newCount = newAt[range.end] - newAt[range.start];
    const oldStart = oldAt[range.start] + (oldCount === 0 ? 0 : 1); const newStart = newAt[range.start] + (newCount === 0 ? 0 : 1);
    headers.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = range.start; i < range.end; i++) {
      headers.push(`${edits[i].type}${edits[i].line}`);
      if (edits[i].noFinalNewline) headers.push('\\ No newline at end of file');
    }
  }
  return headers.join('\n');
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw new TypeError(`Supply between 1 and ${MAX_FILES} complete source files.`);
  const seen = new Set(); let total = 0;
  const snapshot = files.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join(',') !== 'after,before,path') throw new TypeError(`File ${index + 1} must contain only path, before, and after.`);
    const { path, before, after } = file;
    if (typeof path !== 'string' || !path.trim() || path.length > 500 || path.startsWith('/') || path.startsWith('\\') || /^[a-z]:/i.test(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/.test(path)) throw new TypeError(`File ${index + 1} has an unsafe or invalid relative path.`);
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new TypeError(`Unsupported source type for ${path}; only .js, .mjs, and .json are accepted.`);
    if (seen.has(path.toLowerCase())) throw new TypeError(`Duplicate source path: ${path}.`);
    seen.add(path.toLowerCase());
    if (typeof before !== 'string' || typeof after !== 'string' || before.length > MAX_SOURCE_CHARS || after.length > MAX_SOURCE_CHARS || (!before && !after)) throw new TypeError(`File ${path} must include complete literal source text.`);
    if (before === after) throw new TypeError(`File ${path} is unchanged.`);
    if (sourceIsSummary(before) || sourceIsSummary(after)) throw new TypeError(`File ${path} contains an omission marker; complete source is required.`);
    total += before.length + after.length;
    if (total > MAX_SOURCE_CHARS) throw new TypeError(`Combined before/after source exceeds ${MAX_SOURCE_CHARS} characters.`);
    return Object.freeze({ path, before, after, beforeSha256: sha256(before), afterSha256: sha256(after), diff: unifiedDiff(path, before, after) });
  });
  return Object.freeze(snapshot);
}

function checkSyntax(file, { timeoutMs = 10_000, spawnImpl = spawn } = {}) {
  if (file.path.toLowerCase().endsWith('.json')) {
    try { JSON.parse(file.after); return Promise.resolve({ path: file.path, kind: 'json-parse', passed: true }); }
    catch (error) { return Promise.resolve({ path: file.path, kind: 'json-parse', passed: false, error: error.message }); }
  }
  return new Promise(resolve => {
    let settled = false; let output = '';
    const child = spawnImpl(process.execPath, ['--check', '--input-type=module'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve({ path: file.path, kind: 'node-check-module-syntax', ...result }); };
    const timer = setTimeout(() => { child.kill(); finish({ passed: false, error: 'Syntax check timed out.' }); }, timeoutMs);
    child.stdout?.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.stderr?.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.once('error', error => finish({ passed: false, error: `Node syntax checker failed: ${error.message}` }));
    child.once('close', code => finish({ passed: code === 0, ...(code === 0 ? {} : { error: output || `Node syntax checker exited with code ${code}.` }) }));
    child.stdin.end(file.after);
  });
}

const supportsEffort = (model, effort) => Array.isArray(model?.supportedReasoningEfforts) && model.supportedReasoningEfforts.some(item => item === effort || item?.reasoningEffort === effort);

export function createCodeReviewService({ runner, getModelCatalog = () => [], resolveModel, emit = () => {}, store = null, cwd = null, getActiveContext = () => null, spawnImpl = spawn, childDeadlineMs = MAX_CHILD_MS, cancelGraceMs = CANCEL_GRACE_MS }) {
  if (!runner || typeof runner.request !== 'function') throw new TypeError('An initialized app-server runner is required.');
  if (typeof resolveModel !== 'function') throw new TypeError('The authoritative Sol review model resolver is required.');
  const active = new Map(); const activeByCall = new Map(); const recent = [];
  const usedCalls = new Set(); const callsByTurn = new Map(); const childThreads = new Set();
  let closed = false;

  function available() {
    const entry = (getModelCatalog() ?? []).find(model => model?.id === CODE_REVIEW_MODEL);
    if (!entry || !supportsEffort(entry, CODE_REVIEW_EFFORT)) return { available: false, model: CODE_REVIEW_MODEL, effort: CODE_REVIEW_EFFORT, reason: 'The Sol 6.1 medium model route is unavailable in the active app-server catalog.' };
    return { available: true, model: CODE_REVIEW_MODEL, effort: CODE_REVIEW_EFFORT };
  }

  const emitEvent = (job, phase, extra = {}) => {
    const now = new Date().toISOString();
    if (phase === 'started') job.startedAt = now;
    if (TERMINAL.has(phase)) job.completedAt = now;
    emit({ type: 'delegation', phase, id: job.id, role: 'sol_review', model: job.actualModel ?? CODE_REVIEW_MODEL, effort: job.actualEffort ?? CODE_REVIEW_EFFORT, threadId: job.threadId ?? null, turnId: job.turnId ?? null, parentTurnId: job.parentTurnId, parentCallId: job.parentCallId, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null, manifest: job.manifest, machineChecks: job.machineChecks ?? [], gate: job.gate, ...extra });
  };

  function finish(job, status, result = '', error = null) {
    if (job.done) return;
    job.done = true;
    if (job.cancelRequested) { status = 'cancelled'; error = job.cancelReason ?? error; result = ''; }
    job.status = status; job.result = status === 'completed' ? result.slice(0, MAX_REVIEW_CHARS) : ''; job.error = error;
    active.delete(job.threadId); activeByCall.delete(job.parentCallId); clearTimeout(job.deadlineTimer); clearTimeout(job.cancelTimer);
    const receipt = { id: job.id, role: 'sol_review', model: job.actualModel ?? CODE_REVIEW_MODEL, effort: job.actualEffort ?? CODE_REVIEW_EFFORT, threadId: job.threadId ?? null, turnId: job.turnId ?? null, parentThreadId: job.parentThreadId, parentTurnId: job.parentTurnId, parentCallId: job.parentCallId, workspaceRevision: job.workspaceRevision, status, complete: status === 'completed', result: job.result, error, manifest: job.manifest, machineChecks: job.machineChecks, gate: job.gate, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? new Date().toISOString() };
    recent.push(receipt); if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
    if (store?.setSetting) {
      try { store.setSetting('agent.codeReviewHistory', JSON.stringify(recent)); } catch {}
    }
    emitEvent(job, status, { result: receipt.result, complete: receipt.complete, error });
    job.resolve({ receipt });
  }

  async function assertMcpDisabled(threadId) {
    let cursor = null; const cursors = new Set();
    for (let page = 0; page < 32; page++) {
      const response = await runner.request('mcpServerStatus/list', { threadId, serverName: null, detail: 'full', cursor, limit: 100 }, 20_000);
      if (!Array.isArray(response?.data)) throw new Error('App-server did not return the reviewer thread MCP inventory.');
      for (const server of response.data) {
        if (!server || typeof server.name !== 'string' || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools)) throw new Error('Reviewer MCP inventory is incomplete.');
        if (Object.keys(server.tools).length) throw new Error(`Reviewer thread exposes MCP tools through ${server.name}.`);
      }
      if (!response.nextCursor) return;
      if (cursors.has(response.nextCursor)) throw new Error('Reviewer MCP inventory pagination repeated a cursor.');
      cursors.add(response.nextCursor); cursor = response.nextCursor;
    }
    throw new Error('Reviewer MCP inventory exceeded the pagination safety limit.');
  }

  function contextMatches(job, context) {
    const current = getActiveContext();
    return current?.mode === 'code_review' && context?.mode === 'code_review'
      && current.parentThreadId === job.parentThreadId && context.parentThreadId === job.parentThreadId
      && current.parentTurnId === job.parentTurnId && context.parentTurnId === job.parentTurnId
      && current.workspaceRevision === job.workspaceRevision && context.workspaceRevision === job.workspaceRevision;
  }

  async function requestCancel(job, reason) {
    if (!job || job.done) return;
    if (!job.cancelRequested) { job.cancelRequested = true; job.cancelReason = reason; job.status = 'cancel_requested'; emitEvent(job, 'cancel_requested', { cancelRequested: true, reason }); }
    clearTimeout(job.deadlineTimer);
    if (job.threadId && job.turnId && !job.interruptPromise) job.interruptPromise = runner.request('turn/interrupt', { threadId: job.threadId, turnId: job.turnId }, 5_000).catch(error => { job.interruptError = error?.message ?? 'Reviewer interrupt failed.'; return null; });
    if (!job.cancelTimer) job.cancelTimer = setTimeout(() => {
      if (job.done || !job.cancelRequested) return;
      if (typeof runner.stop === 'function') Promise.resolve(runner.stop(`Code review ${job.id} did not confirm cancellation.`)).then(confirmed => {
        if (confirmed === true) runnerExited(new Error('Runner stopped after reviewer cancellation timeout.'));
        else { job.stopError = 'App-server did not confirm shutdown.'; emitEvent(job, 'cancel_requested', { cancelRequested: true, error: job.stopError }); }
      }).catch(error => { job.stopError = error?.message ?? 'App-server stop failed.'; });
    }, cancelGraceMs);
    job.cancelTimer.unref?.();
    return job.interruptPromise;
  }

  async function execute(args, context) {
    if (closed) throw new Error('Code review service is stopped.');
    const capability = available();
    if (!capability.available) throw new Error(capability.reason);
    cleanText(args?.task, 'Review task', MAX_TASK_CHARS);
    if (!context || typeof context !== 'object') throw new Error('The active code-review context is required.');
    const { parentThreadId, parentTurnId, parentCallId, workspaceRevision, mode } = context;
    if ([parentThreadId, parentTurnId, parentCallId, workspaceRevision].some(value => typeof value !== 'string' || !value) || mode !== 'code_review') throw new Error('Code review is only available inside the active code_review parent turn.');
    if (usedCalls.has(parentCallId)) throw new Error('This code-review tool call has already been used.');
    if (activeByCall.size) throw new Error('Only one independent code review may run at a time.');
    if ((callsByTurn.get(parentTurnId) ?? 0) >= 1) throw new Error('Only one independent code review is allowed per parent turn.');
    let gate = `SOL_GATE: role sol_review; основание: author-requested independent code review; scope: ${args.task}; пределы: supplied source text only, read-only, no project test claims, no source edits, no arbitrary path reads, no tools or delegation.`;
    const files = validateFiles(args.files);
    if (!contextMatches({ parentThreadId, parentTurnId, workspaceRevision }, context)) throw new Error('The active parent code-review context changed before dispatch.');
    const manifest = files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 }));
    const job = {
      id: randomUUID(), role: 'sol_review', mode: 'code_review', task: args.task, parentThreadId, parentTurnId, parentCallId, workspaceRevision,
      manifest, machineChecks: [], gate, status: 'checking', text: '', reviewText: '',
      resolve: null, done: false, cancelRequested: false, turnStartAttempted: false,
      actualModel: null, actualEffort: null, threadId: null, turnId: null
    };
    const completion = new Promise(resolve => { job.resolve = resolve; });
    activeByCall.set(parentCallId, job); usedCalls.add(parentCallId); callsByTurn.set(parentTurnId, (callsByTurn.get(parentTurnId) ?? 0) + 1);
    job.deadlineTimer = setTimeout(() => requestCancel(job, 'Independent code review exceeded the four-minute deadline.'), childDeadlineMs);
    job.deadlineTimer.unref?.();
    emitEvent(job, 'queued', { complete: false });
    try {
      job.machineChecks = await Promise.all(files.map(file => checkSyntax(file, { spawnImpl })));
      const badCheck = job.machineChecks.find(check => !check.passed);
      if (badCheck) { finish(job, 'failed', '', `Host syntax check failed for ${badCheck.path}: ${badCheck.error ?? 'syntax rejected'}`); return await completion; }
      if (job.cancelRequested) { finish(job, 'cancelled', '', job.cancelReason); return await completion; }
      if (!contextMatches(job, context)) { finish(job, 'failed', '', 'The active parent code-review context changed before dispatch.'); return await completion; }
      gate = `SOL_GATE: role sol_review; основание: author-requested independent code review; доказательство: host-computed diff with SHA-256 bindings and completed syntax checks on supplied after snapshots; scope: ${args.task}; пределы: supplied source text only, read-only, no project test claims, no source edits, no arbitrary path reads, no tools or delegation.`;
      job.gate = gate;
      emitEvent(job, 'checked', { complete: false });
      const resolved = await resolveModel();
      if (job.cancelRequested) { finish(job, 'cancelled', '', job.cancelReason); return await completion; }
      const selectedModel = resolved?.model ?? resolved?.id;
      const selectedEffort = resolved?.effort ?? resolved?.reasoningEffort;
      if (selectedModel !== CODE_REVIEW_MODEL || selectedEffort !== CODE_REVIEW_EFFORT) throw new Error('Authoritative model resolver did not select Sol 6.1 medium for role sol_review.');
      const latestCapability = available();
      if (!latestCapability.available) throw new Error(latestCapability.reason);
      const packet = [
        `TASK: ${args.task}`,
        `SOL_GATE: ${gate}`,
        'PROVENANCE: Every before/after body below is literal source text explicitly supplied to this tool call. The host did not read these files from disk. Review only this packet.',
        `PARENT BINDING: parent thread ${parentThreadId}; parent turn ${parentTurnId}; workspace revision ${workspaceRevision}.`,
        `HOST CHECKS: ${JSON.stringify(job.machineChecks)}. These are syntax/JSON-parse checks only; no project tests or broader validation ran.`,
        ...files.map(file => `\n===== SUPPLIED FILE: ${file.path} =====\nBEFORE SHA-256: ${file.beforeSha256}\nAFTER SHA-256: ${file.afterSha256}\n--- COMPLETE BEFORE SOURCE ---\n${file.before}\n--- COMPLETE AFTER SOURCE ---\n${file.after}\n--- HOST-COMPUTED UNIFIED DIFF ---\n${file.diff}\n===== END SUPPLIED FILE =====`),
        'REVIEW INSTRUCTIONS: Report only actionable defects introduced by the after source, with severity and exact file/line evidence. Check whether each finding is truly supported by the supplied diff. Do not infer unsupplied repository context, tests, runtime behavior, or files. If no actionable defect is proven, say so. Do not edit, execute, delegate, browse, access arbitrary files, or request tools. Do not generate a patch.'
      ].join('\n\n');
      if (packet.length > 300_000) throw new Error('Review packet exceeded the hard transport bound.');
      if (!contextMatches(job, context)) throw new Error('The active parent code-review context changed before reviewer thread creation.');
      if (job.cancelRequested) { finish(job, 'cancelled', '', job.cancelReason); return await completion; }
      const started = await runner.request('thread/start', {
        cwd,
        model: CODE_REVIEW_MODEL,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: {
          sandbox_mode: 'read-only', approval_policy: 'never', model_reasoning_effort: CODE_REVIEW_EFFORT,
          review_model: CODE_REVIEW_MODEL,
          'features.shell_tool': false, 'features.apps': false, 'features.multi_agent': false,
          'agents.enabled': false, 'mcp_servers.talewisp.enabled': false
        },
        developerInstructions: 'You are an independent read-only code reviewer. Follow the one bounded review packet supplied through the app-server native review/start custom target. Use no tools and inspect no files outside the packet. Return findings only; do not make edits, run commands, delegate, browse, or request approval.',
        dynamicTools: []
      }, 30_000);
      job.threadId = started?.thread?.id;
      if (typeof job.threadId !== 'string' || !job.threadId || job.threadId === parentThreadId || childThreads.has(job.threadId)) throw new Error('App-server did not return a fresh, non-conflicting reviewer thread id.');
      childThreads.add(job.threadId);
      job.actualModel = started.model; job.actualEffort = started.reasoningEffort;
      if (job.actualModel !== CODE_REVIEW_MODEL || job.actualEffort !== CODE_REVIEW_EFFORT || started.approvalPolicy !== 'never' || started.sandbox?.type !== 'readOnly') throw new Error('App-server reviewer thread did not confirm Sol 6.1 medium, approval never, and read-only sandbox.');
      if (job.cancelRequested) { finish(job, 'cancelled', '', job.cancelReason); return await completion; }
      active.set(job.threadId, job); emitEvent(job, 'started');
      await assertMcpDisabled(job.threadId);
      if (job.cancelRequested) { finish(job, 'cancelled', '', job.cancelReason); return await completion; }
      if (job.cancelRequested || !contextMatches(job, context)) throw new Error('Parent review context changed before native review dispatch.');
      job.status = 'review_starting'; job.turnStartAttempted = true;
      const review = await runner.request('review/start', {
        threadId: job.threadId,
        delivery: 'inline',
        target: { type: 'custom', instructions: packet }
      }, 30_000);
      const turnId = review?.turn?.id;
      if (typeof turnId === 'string' && turnId) {
        if (job.turnId && job.turnId !== turnId) throw new Error('Native review response returned a turn id that conflicts with the observed turn.');
        job.turnId = turnId;
      }
      if (review?.reviewThreadId && review.reviewThreadId !== job.threadId) throw new Error('Native reviewer started on an unexpected thread.');
      if (job.done) return await completion;
      if (job.cancelRequested) { await requestCancel(job, job.cancelReason); return await completion; }
      job.status = 'running'; emitEvent(job, 'running');
      return await completion;
    } catch (error) {
      if (job.turnStartAttempted) {
        await requestCancel(job, error?.message ?? 'Native code review dispatch failed.');
        return await completion;
      }
      finish(job, 'failed', '', error?.message ?? 'Native code review failed.');
      return await completion;
    }
  }

  function routeNotification(message) {
    const params = message?.params ?? {};
    const threadId = params.threadId ?? params.turn?.threadId ?? params.item?.threadId;
    const job = active.get(threadId);
    if (!job) return childThreads.has(threadId);
    if (message.method === 'turn/started') {
      const turnId = params.turn?.id;
      if (typeof turnId !== 'string' || !turnId || job.turnId && job.turnId !== turnId) return true;
      job.turnId = turnId; return true;
    }
    const item = params.item ?? {};
    if (item.type === 'exitedReviewMode' && typeof item.review === 'string') {
      if (!contextMatches(job, job)) { requestCancel(job, 'The active parent code-review context changed during native review.'); return true; }
      job.reviewText = item.review.slice(0, MAX_REVIEW_CHARS + 1);
      if (job.reviewText.length > MAX_REVIEW_CHARS) job.outputExceeded = true;
      return true;
    }
    const prohibitedType = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall', 'appToolCall', 'computerUse', 'toolCall', 'shellCommand', 'skillCall'].includes(item.type);
    if (message.method?.includes('requestApproval') || ['item/toolCall', 'item/mcpToolCall', 'item/dynamicToolCall'].includes(message.method) || prohibitedType) {
      requestCancel(job, 'Native reviewer attempted a prohibited tool, command, or approval request.'); return true;
    }
    if (message.method === 'turn/completed') {
      if (!job.turnId || params.turn?.id !== job.turnId) return true;
      if (job.cancelRequested) finish(job, 'cancelled', '', job.cancelReason);
      else if (!contextMatches(job, job)) finish(job, 'cancelled', '', 'The active parent code-review context changed before review completion.');
      else if (params.turn?.status !== 'completed') finish(job, 'failed', '', params.turn?.error?.message ?? 'Native review turn did not complete.');
      else if (job.outputExceeded) finish(job, 'incomplete', '', `Reviewer output exceeded ${MAX_REVIEW_CHARS} characters.`);
      else if (!job.reviewText) finish(job, 'incomplete', '', 'Native review completed without an exitedReviewMode result.');
      else finish(job, 'completed', job.reviewText, null);
      return true;
    }
    return true;
  }

  function runnerExited(error = null) {
    const jobs = [...new Set([...active.values(), ...activeByCall.values()])];
    for (const job of jobs) finish(job, job.cancelRequested ? 'cancelled' : 'failed', '', job.cancelRequested ? job.cancelReason : (error?.message ?? 'App-server exited before native review completion.'));
    return jobs.length;
  }

  async function cancelAll(reason = 'Parent code-review turn stopped.') {
    const jobs = [...new Set([...active.values(), ...activeByCall.values()])];
    await Promise.all(jobs.map(job => requestCancel(job, reason)));
    return jobs.length;
  }

  async function shutdown(reason = 'Code-review service shut down.') { closed = true; return cancelAll(reason); }

  function status() {
    return { available: available(), active: [...new Set([...active.values(), ...activeByCall.values()])].map(job => ({ id: job.id, role: 'sol_review', model: job.actualModel ?? CODE_REVIEW_MODEL, effort: job.actualEffort ?? CODE_REVIEW_EFFORT, threadId: job.threadId, turnId: job.turnId, parentTurnId: job.parentTurnId, parentCallId: job.parentCallId, status: job.status, cancelRequested: job.cancelRequested })), recent: recent.map(item => ({ ...item })) };
  }

  return { available, execute, routeNotification, cancelAll, shutdown, runnerExited, status, toolDefinition: CODE_REVIEW_TOOL, toolDefinitions: [CODE_REVIEW_TOOL] };
}

