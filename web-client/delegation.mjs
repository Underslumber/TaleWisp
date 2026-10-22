import { randomUUID } from 'node:crypto';

export const DELEGATE_MODEL = 'gpt-6-luna';
export const DELEGATE_EFFORT = 'high';
export function supportsEffort(model, effort) {
  return Array.isArray(model?.supportedReasoningEfforts) && model.supportedReasoningEfforts.some(item => item === effort || item?.reasoningEffort === effort);
}
export const DELEGATE_ROLES = Object.freeze([
  'style_editor',
  'lore_researcher',
  'vault_curator',
  'continuity_reviewer',
  'calibration_evaluator',
  'roleplay_leader',
  'roleplay_hero',
  'roleplay_formatter'
]);

const MAX_TASK_CHARS = 8_000;
const MAX_INPUT_CHARS = 24_000;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_ACTIVE_CHILDREN = 2;
const MAX_CHILDREN_PER_TURN = 4;
const MAX_CHILD_MS = 4 * 60_000;
const CANCEL_GRACE_MS = 5_000;
const CHILD_THREAD_CONFIG = { 'mcp_servers.talewisp.enabled': false, model_reasoning_effort: 'high', web_search: 'disabled' };

export const DELEGATION_TOOLS = Object.freeze([
  {
    name: 'talewisp_runtime_resource',
    description: 'Read one operational TaleWisp workflow resource by its allowlisted resource id.',
    type: 'function',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 160 } },
      required: ['id'], additionalProperties: false
    }
  },
  {
    name: 'talewisp_delegate',
    description: 'Delegate only after the active TaleWisp scenario authorizes it. Supply exactly role, task, input, and maxOutputChars; input is the bounded explicit source packet only, never parent history. The host creates a fresh same-account child thread, enforces the selected role/model/workspace gates, disables MCP/native tools, and returns a receipt with the actual child result and status. A failed or incomplete receipt is not a completed result.',
    type: 'function',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: [...DELEGATE_ROLES] },
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARS },
        input: { type: 'string', maxLength: MAX_INPUT_CHARS },
        maxOutputChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS }
      },
      required: ['role', 'task', 'input', 'maxOutputChars'], additionalProperties: false
    }
  }
]);

const RESOURCE_TOOL = DELEGATION_TOOLS[0];
export const IMPORT_REVIEW_READ_TOOL = Object.freeze({
  name: 'talewisp_import_review_read',
  description: 'Read one exact pinned import-review source by path and bounded character range. This tool is available only to the host-authorized independent import reviewer.',
  type: 'function',
  inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 1000 }, startChar: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 64000 } }, required: ['path', 'startChar', 'maxChars'], additionalProperties: false }
});
const MAX_IMPORT_REVIEW_READ_CALLS = 64;
const MAX_IMPORT_REVIEW_READ_CHARS = 2_000_000;
const cleanText = (value, label, max, required = true) => {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new TypeError(`${label} is invalid or exceeds its permitted size.`);
  return value;
};

function roleInstructions(contract, role) {
  const entry = contract?.roles?.[role];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') return JSON.stringify(entry);
  return '';
}

function resourceManifest(contract) {
  return (contract?.resources ?? []).map(resource => `${resource.id} | ${resource.title} | source sha256=${resource.sourceHash} | content sha256=${resource.hash}`).join('\n');
}

function roleBoundary(role, calibrationCandidate = false) {
  const rules = {
    style_editor: 'You are already the designated style_editor. Produce the requested finished prose or revision in this single generation. Silently perform any necessary causal/perceptual skeleton within this generation. Do not delegate, ask the author to re-confirm the supplied task, calibrate, create ledgers, return readiness-only output, or run a hidden rewrite loop.',
    lore_researcher: 'You are already the designated lore_researcher. Establish only bounded claims supported by the explicit packet or operational resources you read. Cite the supplied source identifiers and separate confirmed facts, conflicts, and missing evidence. Do not browse, inspect arbitrary paths, or ask the author; report unresolved source needs to the root.',
    vault_curator: 'You are already the designated vault_curator. Analyze only the bounded materials in the explicit packet and operational resources. Return the requested structural or continuity findings without reading arbitrary files, editing the vault, or promoting hypotheses into canon.',
    continuity_reviewer: 'You are already the designated continuity_reviewer. Return only material blockers supported by the packet and cited source identifiers. Do not polish, rewrite, or trigger another generation. Report missing source evidence to the root.',
    calibration_evaluator: 'You are already the designated calibration_evaluator for an explicitly authorized laboratory run. Evaluate only the supplied blind candidates, controlled task, and confirmed rules. Do not generate or revise candidate prose, inspect held-out author examples unless explicitly included as evaluator-only input, or start another round.',
    roleplay_leader: 'You are already the designated roleplay_leader. Follow the supplied readiness result and host/leader responsibilities; do not control the hero or narrate its private thoughts. Do not ask the author to repeat the supplied opt-in.',
    roleplay_hero: 'You are already the designated roleplay_hero. Follow the supplied native role packet and hero responsibilities; control only the hero and do not take over the host/leader. Do not ask the author to repeat the supplied opt-in.',
    roleplay_formatter: 'You are already the designated roleplay_formatter. Use only the supplied complete, author-accepted native skeleton and host-selected voice input. Preserve every played action, motive, knowledge boundary, perception, personal meaning, emotion or restraint, bodily response, manner, and consequence. Do not add, remove, or reorder events; do not edit branch data.'
  };
  if (role === 'style_editor' && calibrationCandidate) return 'You are a blind calibration candidate. Produce one finished passage for the supplied controlled scene and candidate prompt. Use no held-out examples unless the packet explicitly marks them as candidate-visible. Do not evaluate candidates, inspect author calibration samples, or revise after this generation.';
  return rules[role] ?? '';
}

function normalizeResource(resource) {
  if (typeof resource === 'string') return resource;
  if (resource && typeof resource === 'object') return JSON.stringify(resource);
  throw new Error('The requested operational resource is unavailable.');
}

export function createDelegationManager({ runner, runtimeProfile = 'normal', contractProvider, resolveModel, getModelCatalog = () => [], getNativeSkills = () => [], emit = () => {}, getWorkspaceRevision = () => null, getParentBinding = () => null, authorizeRole = () => true, stopRunner = reason => runner.stop?.(reason), childDeadlineMs = MAX_CHILD_MS, cancelGraceMs = CANCEL_GRACE_MS }) {
  if (!['normal', 'import-bootstrap'].includes(runtimeProfile)) throw new Error('Unsupported delegation runtime profile.');
  const childThreadConfig = runtimeProfile === 'import-bootstrap'
    ? { model_reasoning_effort: DELEGATE_EFFORT, web_search: 'disabled' }
    : CHILD_THREAD_CONFIG;
  if (!runner || typeof runner.request !== 'function') throw new TypeError('An initialized app-server runner is required.');
  if (typeof contractProvider !== 'function') throw new TypeError('A runtime contract provider is required.');
  if (typeof resolveModel !== 'function') throw new TypeError('The authoritative TaleWisp model resolver is required.');

  const active = new Map();
  const starting = new Map();
  const childThreadIds = new Set();
  const recent = [];
  const usedCallIds = new Set();
  const countsByTurn = new Map();
  const countsByTurnRole = new Map();
  let closed = false;
  let runnerStopPromise = null;

  const event = (child, phase, extra = {}) => {
    const stamp = new Date().toISOString();
    if (phase === 'started') child.startedAt = stamp;
    if (['completed', 'failed', 'cancelled', 'incomplete'].includes(phase)) child.completedAt = stamp;
    emit({ type: 'delegation', phase, id: child.id, role: child.role, model: child.actualModel ?? DELEGATE_MODEL, effort: child.actualEffort ?? DELEGATE_EFFORT, threadId: child.threadId ?? null, parentTurnId: child.parentTurnId, parentCallId: child.parentCallId, startedAt: child.startedAt ?? null, completedAt: child.completedAt ?? null, ...(child.importReviewBinding?{importReviewBinding:child.importReviewBinding}:{}), ...extra });
  };

  const finish = (child, status, result = '', error = null) => {
    if (child.done) return;
    child.done = true;
    if(child.cancelRequested) {
      status='cancelled';
      error=[child.cancelReason,child.interruptError?`Interrupt failed: ${child.interruptError}`:null,child.runnerStopError?`Runner stop unconfirmed: ${child.runnerStopError}`:null].filter(Boolean).join(' ');
    }
    child.status = status;
    child.result = status === 'cancelled' ? '' : result.slice(0, child.maxOutputChars);
    child.error = error;
    active.delete(child.threadId);
    starting.delete(child.id);
    clearTimeout(child.deadlineTimer);
    clearTimeout(child.cancelTimer);
    const importReviewReadAudit=child.importReviewReader?{calls:child.importReviewReceipts.length,attempts:child.importReviewReadAttempts,chars:child.importReviewReadChars,reads:child.importReviewReceipts.map(read=>({...read}))}:undefined;
    recent.push({ id: child.id, role: child.role, model: child.actualModel ?? DELEGATE_MODEL, effort: child.actualEffort ?? DELEGATE_EFFORT, threadId: child.threadId, parentTurnId: child.parentTurnId, parentCallId: child.parentCallId, status, startedAt: child.startedAt, completedAt: child.completedAt, result: child.result, error, ...(child.importReviewBinding?{importReviewBinding:child.importReviewBinding}:{}), ...(importReviewReadAudit?{importReviewReadAudit}:{}) });
    if (recent.length > 20) recent.splice(0, recent.length - 20);
    event(child, status === 'completed' ? 'completed' : status, { result: child.result, complete: status === 'completed', error, ...(importReviewReadAudit?{importReviewReadAudit}:{}) });
    child.resolve({ receipt: { id: child.id, role: child.role, model: child.actualModel ?? DELEGATE_MODEL, effort: child.actualEffort ?? DELEGATE_EFFORT, threadId: child.threadId, status, complete: status === 'completed', result: child.result, error, ...(child.importReviewBinding?{importReviewBinding:child.importReviewBinding}:{}), ...(importReviewReadAudit?{importReviewReadAudit}:{}) } });
  };

  function stopRunnerOnce(reason) {
    if (!runnerStopPromise) runnerStopPromise = Promise.resolve().then(() => stopRunner(reason)).catch(error => ({ error: error?.message ?? 'Runner stop failed.' }));
    return runnerStopPromise;
  }

  function requestCancel(child, reason, { stopAfterGrace = true } = {}) {
    if (!child || child.done) return Promise.resolve();
    const firstRequest = !child.cancelRequested;
    child.cancelRequested = true;
    child.cancelReason ??= reason;
    child.status = 'cancel_requested';
    if (firstRequest) event(child, 'cancel_requested', { cancelRequested: true, reason: child.cancelReason });
    clearTimeout(child.deadlineTimer);
    if (child.turnMayRun && child.threadId && typeof child.turnId === 'string' && child.turnId && !child.turnStartPending && !child.interruptPromise) {
      child.interruptPromise = Promise.resolve().then(() => runner.request('turn/interrupt', { threadId: child.threadId, turnId: child.turnId }, 5_000)).then(result => {
        child.interruptResult = result;
        return result;
      }).catch(error => {
        child.interruptError = error?.message ?? 'Child interrupt request failed.';
        event(child, 'cancel_requested', { cancelRequested: true, error: child.interruptError });
        return null;
      });
    }
    if (stopAfterGrace && !child.cancelTimer) {
      child.cancelTimer = setTimeout(async () => {
        if (child.done || !child.cancelRequested) return;
        await child.interruptPromise;
        if (!child.done) {
          const result=await stopRunnerOnce(`Child ${child.id} did not confirm cancellation.`);
          if(result!==true) { child.runnerStopError=result?.error??'The app-server did not confirm shutdown.';event(child,'cancel_requested',{cancelRequested:true,error:child.runnerStopError}); }
        }
      }, cancelGraceMs);
    }
    return child.interruptPromise ?? Promise.resolve();
  }

  function runnerExited(error = null) {
    const children = [...new Set([...active.values(), ...starting.values()])];
    for (const child of children) {
      finish(child, child.cancelRequested ? 'cancelled' : 'failed', '', child.cancelRequested ? child.cancelReason : (error?.message ?? 'App-server exited before child turn completion.'));
    }
    return children.length;
  }

  async function delegate({ role, task, input, maxOutputChars, parentThreadId, parentTurnId, parentCallId, contractVersion, workspaceRevision, roleplayDispatch = false, importReviewReader = null, importReviewManifest = null }) {
    if (closed) throw new Error('Delegation is stopped.');
    if (!DELEGATE_ROLES.includes(role)) throw new TypeError('Delegation role is not permitted.');
    if (importReviewReader !== null && (role !== 'continuity_reviewer' || runtimeProfile !== 'import-bootstrap' || typeof importReviewReader !== 'function' || !importReviewManifest || typeof importReviewManifest!=='object' || !Array.isArray(importReviewManifest.files) || !Array.isArray(importReviewManifest.requiredFiles) || !importReviewManifest.requiredFiles.length || !Array.isArray(importReviewManifest.excludedFiles) || !importReviewManifest.jobId || !importReviewManifest.sessionId || !importReviewManifest.candidateSha256)) throw new Error('The import review reader requires a host-authorized isolated reviewer.');
    task = cleanText(task, 'Task', MAX_TASK_CHARS);
    input = cleanText(input, 'Input packet', MAX_INPUT_CHARS, false);
    if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > MAX_OUTPUT_CHARS) throw new TypeError('Output limit is invalid.');
    if ([parentThreadId, parentTurnId, parentCallId].some(value => typeof value !== 'string' || !value)) throw new TypeError('Parent thread, turn, and call ids are required.');
    if (usedCallIds.has(parentCallId)) throw new Error('Delegation call id was already used.');
    if (active.size + starting.size >= MAX_ACTIVE_CHILDREN) throw new Error('The concurrent child-thread limit has been reached.');
    const count = countsByTurn.get(parentTurnId) ?? 0;
    if (count >= MAX_CHILDREN_PER_TURN) throw new Error('The per-turn child-thread limit has been reached.');
    if (getWorkspaceRevision() !== workspaceRevision) throw new Error('Workspace changed before the child thread could start.');
    const parent = getParentBinding();
    if (!parent || parent.threadId !== parentThreadId || parent.turnId !== parentTurnId) throw new Error('Delegation request is outside the active parent thread and turn.');
    const authorization = authorizeRole(role, { parentThreadId, parentTurnId, parentCallId, roleplayDispatch: roleplayDispatch === true, hasWriter: (countsByTurnRole.get(`${parentTurnId}:style_editor`) ?? 0) > 0, task, input });
    if (!authorization) throw new Error(`Delegation role ${role} is not authorized for the active request mode.`);
    const roleLimit = typeof authorization === 'object' && Number.isSafeInteger(authorization.maxCalls) ? authorization.maxCalls : MAX_CHILDREN_PER_TURN;
    const roleCountKey = `${parentTurnId}:${role}`;
    const roleCount = countsByTurnRole.get(roleCountKey) ?? 0;
    if (roleCount >= roleLimit) throw new Error(`The ${role} role call limit has been reached for this turn.`);
    const modelCatalog = getModelCatalog();
    const available = Array.isArray(modelCatalog) ? modelCatalog : [];
    if (!available.some(model => model?.id === DELEGATE_MODEL && supportsEffort(model, DELEGATE_EFFORT))) throw new Error(`Required subscription model ${DELEGATE_MODEL} with ${DELEGATE_EFFORT} reasoning is unavailable in the account catalog.`);
    const importReviewBinding=importReviewReader?{jobId:importReviewManifest.jobId,sessionId:importReviewManifest.sessionId,candidateSha256:importReviewManifest.candidateSha256,requiredManifest:importReviewManifest.requiredFiles.map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes})),excludedManifest:importReviewManifest.excludedFiles.map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes,reason:file.reason}))}:null;
    const child = { id: randomUUID(), role, task, input, maxOutputChars, parentThreadId, parentTurnId, parentCallId, workspaceRevision, contractVersion, text: '', seenToolCalls: new Set(), status: 'starting', done: false, cancelRequested: false, turnMayRun: false, turnStartPending: false, importReviewReader, importReviewManifest, importReviewBinding, importReviewReadAttempts: 0, importReviewReadChars: 0, importReviewReadReservedChars: 0, importReviewReceipts: [] };
    const completion = new Promise(resolve => { child.resolve = resolve; });
    starting.set(child.id, child);
    child.deadlineTimer = setTimeout(() => { void requestCancel(child, 'Child turn exceeded its execution deadline.'); }, childDeadlineMs);
    usedCallIds.add(parentCallId);
    if (usedCallIds.size > 4096) usedCallIds.delete(usedCallIds.values().next().value);
    countsByTurn.set(parentTurnId, count + 1);
    countsByTurnRole.set(roleCountKey, roleCount + 1);
    if (countsByTurnRole.size > 256) countsByTurnRole.delete(countsByTurnRole.keys().next().value);
    event(child, 'starting');
    try {
      const selection = await resolveModel();
      if (selection?.scope !== 'once' || selection.model !== DELEGATE_MODEL || selection.effort !== DELEGATE_EFFORT) throw new Error('The authoritative TaleWisp resolver did not confirm the one-time Luna high route.');
      if(child.done)return await completion;
      if(child.cancelRequested||closed){finish(child,'cancelled','',child.cancelReason??'Parent runtime stopped before the child thread started.');return await completion;}
      const contract = await contractProvider();
      if (!contract?.version || contract.version !== contractVersion) throw new Error('Runtime contract changed; start a new parent thread before delegating.');
      if (child.done) return await completion;
      if (closed || child.cancelRequested) { finish(child,'cancelled','',child.cancelReason??'Parent runtime stopped before the child thread started.'); return await completion; }
      if (getWorkspaceRevision() !== workspaceRevision || getParentBinding()?.threadId !== parentThreadId || getParentBinding()?.turnId !== parentTurnId) throw new Error('Parent thread or workspace changed before the child thread started.');
      const calibrationCandidate = role === 'style_editor' && authorization.scenario === 'calibration';
      const importReview = typeof importReviewReader === 'function';
      const reviewInstructions = importReview ? `TRUSTED IMPORT REVIEW MANIFEST (host-pinned required text files; images and prior-review artifacts are explicitly excluded):\n${importReviewManifest.requiredFiles.map(file => `${file.path} | sha256=${file.sha256} | bytes=${file.bytes}`).join('\n')}\nEXCLUDED FILES:\n${importReviewManifest.excludedFiles.map(file=>`${file.path} | sha256=${file.sha256} | excluded=${file.reason}`).join('\n') || '(none)'}\n\nRead every required file fully using talewisp_import_review_read. For each read, set maxChars to no more than min(file bytes, 64000); UTF-8 character count cannot exceed byte count. Start at 0, continue exactly at each prior end, and finish with eof=true. The host verifies job, candidate, pinned hash, workspace and source-specific range before and after every read. The limit is 64 reads and 2,000,000 requested characters; if the required manifest cannot fit, report the actual unread files and do not claim full coverage or PASS. Return exactly one JSON object with keys {"jobId":"${importReviewManifest.jobId}","status":"PASS or FAIL","review_type":"independent","session_id":"${importReviewManifest.sessionId}","candidate_sha256":"${importReviewManifest.candidateSha256}","findings":[],"coverage":"..."}; no Markdown fences or surrounding text. Set status FAIL if material issues prevent an independent PASS. Do not invent a receiptId; the host adds it after verification.` : '';
      const instructions = [contract.instructions, contract.ROOT_WORKFLOW_INSTRUCTIONS, `ALLOWLISTED OPERATIONAL RESOURCE MANIFEST:\n${resourceManifest(contract)}`, `SELECTED ROLE CONTRACT (${role}):\n${roleInstructions(contract, role)}`, roleBoundary(role, calibrationCandidate), reviewInstructions, `Host boundary: you receive only this task packet and allowlisted operational resources${importReview?' plus the explicitly authorized pinned import review reader':''}. Do not use or claim other tools, MCP, network, shell, apps, or file access. Do not save or modify project, vault, or author data. Do not invoke delegation or ask the author questions; report any required missing fact to the root.`].filter(value => typeof value === 'string' && value.trim()).join('\n\n');
      const started = await runner.request('thread/start', {
        cwd: parent?.cwd,
        model: DELEGATE_MODEL,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: childThreadConfig,
        developerInstructions: instructions,
        dynamicTools: [RESOURCE_TOOL, ...(importReview ? [IMPORT_REVIEW_READ_TOOL] : [])]
      }, 30_000);
      child.threadId = started?.thread?.id;
      if(child.done)return await completion;
      if (typeof child.threadId !== 'string' || !child.threadId) throw new Error('App-server did not return a child thread id.');
      if (child.threadId === parentThreadId || active.has(child.threadId)) throw new Error('App-server returned a conflicting child thread id.');
      childThreadIds.add(child.threadId);
      if (child.cancelRequested || closed) { finish(child,'cancelled','',child.cancelReason??'Parent runtime stopped before child inference began.'); return await completion; }
      child.actualModel = started.model;
      child.actualEffort = started.reasoningEffort;
      if (child.actualModel !== DELEGATE_MODEL || child.actualEffort !== DELEGATE_EFFORT || started.approvalPolicy !== 'never' || started.sandbox?.type !== 'readOnly') throw new Error('App-server child thread did not confirm the requested Luna high-effort read-only settings.');
      child.status = 'thread_ready';
      active.set(child.threadId, child);
      starting.delete(child.id);
      event(child, 'started');
      await assertChildMcpDisabled(child);
      if(child.done)return await completion;
      if (closed || child.cancelRequested) { finish(child,'cancelled','',child.cancelReason??'Parent runtime stopped before child inference began.'); return await completion; }
      if (getWorkspaceRevision() !== workspaceRevision || getParentBinding()?.threadId !== parentThreadId || getParentBinding()?.turnId !== parentTurnId) throw new Error('Parent thread or workspace changed before the child turn started.');
      const roleSkill = ['style_editor','calibration_evaluator','roleplay_leader','roleplay_hero','roleplay_formatter'].includes(role) ? getNativeSkills().find(skill => typeof skill?.path === 'string' && skill.path.replaceAll('\\','/').toLowerCase().includes('/write-fiction/')) : null;
      const packet = `ROLE: ${role}\nTASK: ${task}\n\n${importReview ? `EXPLICIT INPUT PACKET (review context only; source contents must be read through the bounded reader):\n${input}\n\nThe pinned source manifest and exact review receipt schema are in your developer instructions. Use talewisp_import_review_read for source content; for each file request no more than min(file bytes,64000), read contiguous ranges through eof=true, and report any budget limit without claiming complete coverage.` : `EXPLICIT INPUT PACKET (the only task-specific source material supplied):\n${input}`}\n\nReturn the requested result directly. Do not claim to have read any other source. Do not use tools except ${importReview ? 'talewisp_runtime_resource and talewisp_import_review_read' : 'talewisp_runtime_resource for the operational workflow instructions'}. Maximum response length: ${maxOutputChars} characters.`;
      child.status='turn_starting';child.turnMayRun=true;child.turnStartPending=true;child.turnStartAttempted=true;
      const turn = await runner.request('turn/start', {
        threadId: child.threadId,
        input: [...(roleSkill ? [{ type: 'skill', name: roleSkill.name, path: roleSkill.path }] : []), { type: 'text', text: packet }],
        cwd: parent?.cwd,
        model: DELEGATE_MODEL,
        effort: DELEGATE_EFFORT,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }, 30_000);
      child.turnStartPending=false;
      if(child.done)return await completion;
      if (typeof turn?.turn?.id !== 'string' || !turn.turn.id || (child.turnId && turn.turn.id !== child.turnId)) {
        requestCancel(child,'App-server did not confirm the child turn id.');
        return await completion;
      }
      child.turnId = turn.turn.id;
      if(child.cancelRequested||closed){requestCancel(child,child.cancelReason??'Parent runtime stopped during child turn startup.');return await completion;}
      if(child.status!=='running'){child.status='running';event(child,'running');}
      return await completion;
    } catch (error) {
      if(child.done)return await completion;
      if(child.turnStartAttempted||child.turnMayRun) {
        child.turnStartPending=false;
        requestCancel(child,error?.message??'Child turn startup failed after dispatch; waiting for confirmed termination.');
      } else if(child.cancelRequested||closed) finish(child,'cancelled','',child.cancelReason??'Parent runtime stopped before child inference began.');
      else finish(child, 'failed', '', error?.message ?? 'Child thread failed.');
      return await completion;
    }
  }

  async function assertChildMcpDisabled(child) {
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < 32; page++) {
      const response = await runner.request('mcpServerStatus/list', { threadId: child.threadId, serverName: null, detail: 'full', cursor, limit: 100 }, 20_000);
      if (!Array.isArray(response?.data)) throw new Error('App-server did not return the child thread MCP inventory.');
      for (const server of response.data) {
        if (!server || typeof server.name !== 'string' || !server.tools || typeof server.tools !== 'object' || Array.isArray(server.tools)) throw new Error('Child thread MCP inventory is incomplete; refusing to start it.');
        if (Object.keys(server.tools).length) throw new Error(`Child thread exposes MCP tools through ${server.name}; refusing to start it.`);
      }
      if (!response.nextCursor) return;
      if (seen.has(response.nextCursor)) throw new Error('Child thread MCP inventory pagination repeated a cursor.');
      seen.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new Error('Child thread MCP inventory exceeded the pagination safety limit.');
  }

  async function handleResourceTool(params) {
    const child = active.get(params?.threadId);
    if (!child || child.done || child.cancelRequested || params.turnId !== child.turnId || typeof params.callId !== 'string' || !params.callId || params.tool !== RESOURCE_TOOL.name || (Object.hasOwn(params, 'namespace') && params.namespace !== null)) throw new Error('Operational resource request is outside an active child thread.');
    if (child.seenToolCalls.has(params.callId)) throw new Error('Operational resource call id was already used.');
    const args = params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).join(',') !== 'id' || typeof args.id !== 'string' || !args.id.trim() || args.id.length > 160) throw new Error('Operational resource arguments are invalid.');
    child.seenToolCalls.add(params.callId);
    const contract = await contractProvider();
    if(child.done||child.cancelRequested)throw new Error('Operational resource request was cancelled with its child turn.');
    if (contract?.version !== child.contractVersion || getWorkspaceRevision() !== child.workspaceRevision) throw new Error('Runtime contract or workspace changed during delegation.');
    if (typeof contract.readResource !== 'function') throw new Error('Operational resource access is unavailable.');
    return { id: args.id, content: normalizeResource(await contract.readResource(args.id)) };
  }

  async function handleImportReviewRead(params) {
    const child = active.get(params?.threadId);
    if (!child || child.done || child.cancelRequested || child.role !== 'continuity_reviewer' || typeof child.importReviewReader !== 'function' || params.turnId !== child.turnId || typeof params.callId !== 'string' || !params.callId || params.tool !== IMPORT_REVIEW_READ_TOOL.name || (Object.hasOwn(params, 'namespace') && params.namespace !== null)) throw new Error('Import review read is outside an authorized active reviewer thread.');
    if (child.seenToolCalls.has(params.callId)) throw new Error('Import review read call id was already used.');
    const args = params.arguments;
    const pinnedFile=child.importReviewManifest.files.find(file=>file.path===args?.path);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).sort().join(',') !== 'maxChars,path,startChar' || typeof args.path !== 'string' || !args.path || args.path.length > 1000 || !pinnedFile || !Number.isSafeInteger(args.startChar) || args.startChar < 0 || !Number.isSafeInteger(args.maxChars) || args.maxChars < 1 || args.maxChars > Math.min(64000,Math.max(1,pinnedFile.bytes))) throw new Error('Import review read arguments are invalid or exceed the pinned per-file allowance.');
    if (child.importReviewReadAttempts >= MAX_IMPORT_REVIEW_READ_CALLS || child.importReviewReadReservedChars + args.maxChars > MAX_IMPORT_REVIEW_READ_CHARS) throw new Error('Import review read budget is exhausted; refusing to truncate or exceed the bounded source allowance.');
    child.seenToolCalls.add(params.callId);
    child.importReviewReadAttempts++;
    child.importReviewReadReservedChars += args.maxChars;
    const result = await child.importReviewReader({ path: args.path, startChar: args.startChar, maxChars: args.maxChars });
    if (child.done || child.cancelRequested) throw new Error('Import review read was cancelled with its child turn.');
    if (!result || result.path!==args.path || typeof result.text !== 'string' || result.sha256!==pinnedFile.sha256 || typeof result.sha256 !== 'string' || !result.range || result.range.start!==args.startChar || !Number.isSafeInteger(result.range.end) || result.range.end<result.range.start || result.range.end-result.range.start!==[...result.text].length || typeof result.complete !== 'boolean' || typeof result.eof!=='boolean' || !Number.isSafeInteger(result.totalChars) || result.totalChars<result.range.end) throw new Error('Import review reader returned an incomplete or unpinned bounded result.');
    child.importReviewReadChars += [...result.text].length;
    child.importReviewReceipts.push({ path: args.path, startChar: args.startChar, endChar: result.range.end, totalChars:result.totalChars, eof:result.eof, sha256: result.sha256, charCount: [...result.text].length, complete: result.complete });
    return result;
  }

  function routeNotification(message) {
    const params = message?.params ?? {};
    const threadId = params.threadId ?? params.turn?.threadId ?? params.item?.threadId;
    const child = active.get(threadId);
    if (!child) return childThreadIds.has(threadId);
    if (message.method === 'turn/started') {
      const id = params.turn?.id;
      if(!child.turnStartAttempted)return true;
      if (typeof id !== 'string' || !id) { requestCancel(child,'Child turn started without a verifiable id.'); return true; }
      if(child.turnId&&child.turnId!==id)return true;
      child.turnId = id;
      if(!child.cancelRequested&&child.status!=='running'){child.status='running';event(child,'running');}
      return true;
    }
    if (message.method === 'item/agentMessage/delta') {
      const delta = params.delta ?? '';
      if (child.text.length + delta.length > child.maxOutputChars) child.outputExceeded = true;
      else child.text += delta;
      return true;
    }
    if (message.method === 'item/completed') {
      const item = params.item ?? {};
      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : child.text;
        if (text.length > child.maxOutputChars) child.outputExceeded = true;
        else if (text) child.text = text;
      }
      return true;
    }
    if (message.method === 'turn/completed') {
      if (typeof child.turnId!=='string'||!child.turnId||typeof params.turn?.id!=='string'||params.turn.id!==child.turnId) return true;
      const result = child.outputExceeded || child.cancelRequested ? '' : child.text;
      const status = child.cancelRequested?'cancelled':params.turn?.status === 'completed' ? (child.outputExceeded ? 'incomplete' : 'completed') : 'failed';
      const error=status==='completed'?null:child.cancelRequested?(child.cancelReason??'Child turn was cancelled.'):child.outputExceeded?`Child output exceeded the ${child.maxOutputChars}-character limit; no partial result is presented as complete.`:(params.turn?.error?.message??'Child turn failed.');
      finish(child, status, result, error);
      return true;
    }
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      requestCancel(child,'Child runtime requested a prohibited approval.');
      return true;
    }
    return true;
  }

  async function cancelAll(reason = 'Parent turn stopped.') {
    const children = [...new Set([...active.values(), ...starting.values()])];
    await Promise.all(children.map(child=>requestCancel(child,reason)));
    return children.length;
  }

  async function shutdown(reason = 'Agent runtime shut down.') {
    closed = true;
    return cancelAll(reason);
  }

  function status() {
    return { active: [...active.values(), ...starting.values()].map(child => ({ id: child.id, role: child.role, model: child.actualModel ?? DELEGATE_MODEL, effort: child.actualEffort ?? DELEGATE_EFFORT, threadId: child.threadId ?? null, parentTurnId: child.parentTurnId, parentCallId: child.parentCallId, status: child.status, cancelRequested:child.cancelRequested,cancelReason:child.cancelReason??null,interruptError:child.interruptError??null,runnerStopError:child.runnerStopError??null,startedAt: child.startedAt ?? null })), recent: recent.slice(-20).map(item => ({ ...item })) };
  }

  return { delegate, handleResourceTool, handleImportReviewRead, routeNotification, cancelAll, shutdown, runnerExited, status, toolDefinitions: DELEGATION_TOOLS };
}
