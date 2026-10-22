const MAX_INPUT_CHARS = 24_000;
const MAX_OUTPUT_CHARS = 24_000;
const ROLES = Object.freeze(['leader', 'hero', 'formatter']);

export const ROLEPLAY_DELEGATE_TOOL = Object.freeze({
  name: 'talewisp_roleplay_delegate',
  description: 'Request one fresh read-only roleplay child using the native branch packet for the selected role. The host verifies author opt-in, the applied start action, current workspace, branch status and phase. Supply no task or packet text.',
  type: 'function',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 64 },
      role: { type: 'string', enum: [...ROLES] },
      maxOutputChars: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS },
      voiceInput: { type: 'object' }
    },
    required: ['sessionId', 'role', 'maxOutputChars'],
    additionalProperties: false
  }
});

const CHILD_ROLE = Object.freeze({
  leader: 'roleplay_leader',
  hero: 'roleplay_hero',
  formatter: 'roleplay_formatter'
});

const TASK = Object.freeze({
  leader: 'Perform exactly the roleplay leader step indicated by the current native phase. Return only the next situation or consequence text and any separately justified memory updates. Do not control the hero, expose scene_design, or claim a hero attempt succeeded.',
  hero: 'Choose and describe only the hero’s attempted action for the current situation, using only the hero packet. Preserve the character’s established motives and knowledge boundaries. Do not determine the outcome.',
  formatter: 'Turn the complete, currently accepted native skeleton into finished prose in the selected author voice. Preserve every played action, motive, knowledge boundary, perception, personal meaning, emotion or restraint, bodily response, manner, and consequence. Do not add, remove, or reorder events.'
});

const fail = message => { throw new Error(`Roleplay dispatch denied: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);

function nativeContent(result, tool) {
  if (result?.isError) fail(`${tool} failed: ${result.structuredContent?.error ?? result.content?.map?.(item => item.text).filter(Boolean).join('\n') ?? 'native call failed'}`);
  const value = result?.structuredContent;
  if (!object(value)) fail(`${tool} returned no structured native result`);
  return value;
}

function clampPacket(value, label) {
  const encoded = json(value);
  if (typeof encoded !== 'string' || encoded.length > MAX_INPUT_CHARS) fail(`${label} exceeds the bounded child input size`);
  return encoded;
}

function withoutSceneContextProvenance(value) {
  if (Array.isArray(value)) return value.map(withoutSceneContextProvenance);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['source_refs', 'author_instruction', 'branch_assumption'].includes(key))
    .map(([key, nested]) => [key, withoutSceneContextProvenance(nested)]));
}

function currentStartReceipt(workspaceService, sessionId, revision) {
  if (typeof workspaceService?.listProposals !== 'function' || typeof workspaceService?.proposal !== 'function') {
    fail('the workspace cannot verify an applied roleplay start receipt');
  }
  const summaries = workspaceService.listProposals();
  if (!Array.isArray(summaries)) fail('the workspace action inventory is unavailable');
  const starts = summaries.filter(row => row?.tool === 'talewisp_roleplay_start' && typeof row.id === 'string');
  const receipts = starts.map(row => workspaceService.proposal(row.id)).filter(row =>
    row?.tool === 'talewisp_roleplay_start' && row.state === 'applied' && row.workspaceRevision === revision &&
    row.arguments?.session_id === sessionId && row.appliedAt && object(row.result?.structuredContent));
  const receipt = receipts.find(row => row.result.structuredContent.session_id === sessionId &&
    typeof row.result.structuredContent.branch_id === 'string' && row.result.structuredContent.run_state === 'active');
  if (!receipt) fail('no author-applied roleplay_start receipt matches this session and active workspace');
  return receipt;
}

function projectedPacket(role, packet, status, voiceInput) {
  if (packet.revision !== undefined && packet.revision !== status.revision) fail('native packet and status describe different branch revisions or states');
  if (packet.run_state !== undefined && packet.run_state !== status.run_state) fail('native packet and status describe different branch revisions or states');
  if (status.run_state !== 'active') fail(`the native branch is ${status.run_state}, not active`);

  if (role === 'leader') {
    if (!['situation', 'consequence'].includes(status.phase)) fail(`leader cannot run during phase ${status.phase}`);
    const keys = ['branch_id', 'story_time', 'world', 'scene_contract', 'hero_declarations', 'scene_design', 'scene_context', 'source_excerpts', 'craft_input', 'craft_input_label', 'current_hero_state', 'current_hero_state_scope', 'hero_state_history', 'contract', 'leader_memory', 'past_hero_experience', 'turns', 'phase', 'revision', 'run_state'];
    return Object.fromEntries(keys.filter(key => Object.hasOwn(packet, key)).map(key => [key, packet[key]]));
  }

  if (role === 'hero') {
    if (status.phase !== 'hero_action' || packet.action_expected !== true) fail(`hero cannot run during phase ${status.phase}`);
    const keys = ['hero_id', 'scene_time', 'starting_context', 'starting_context_rule', 'current_hero_state', 'current_hero_state_scope', 'hero_state_history', 'character', 'personal_memory', 'revealed_observations', 'situation_history', 'past_hero_experience', 'contract', 'craft_input', 'craft_input_label', 'current_situation', 'perception_rule', 'past_experience_rule', 'action_expected'];
    // Allowlist only the native hero projection. In particular, never attach status,
    // branch identifiers, leader state, source metadata, or caller-provided fields.
    return Object.fromEntries(keys.filter(key => Object.hasOwn(packet, key)).map(key => [key, packet[key]]));
  }

  if (role === 'formatter') {
    if (status.formatting_ready !== true || status.skeleton_accepted_content_revision == null ||
        packet.accepted_skeleton?.accepted_content_revision !== status.skeleton_accepted_content_revision ||
        !Array.isArray(packet.accepted_skeleton?.turns) || !packet.accepted_skeleton.turns.length) {
      fail('formatter requires the complete currently accepted native skeleton revision');
    }
    if (!object(voiceInput) || !Object.keys(voiceInput).length) fail('formatter requires selected author voice input from the trusted host');
    const acceptedSkeleton = { ...packet.accepted_skeleton };
    if (Object.hasOwn(acceptedSkeleton, 'scene_context')) {
      acceptedSkeleton.scene_context = withoutSceneContextProvenance(acceptedSkeleton.scene_context);
    }
    return {
      accepted_skeleton: acceptedSkeleton,
      voice_input: voiceInput,
      craft_input: packet.craft_input,
      craft_input_label: packet.craft_input_label,
      contract: packet.contract
    };
  }
  fail('unknown role');
}

/**
 * Creates the trusted dispatch gate for roleplay children. This provides packet
 * separation and read-only child routing; it does not claim OS-level isolation.
 */
export function createRoleplayDispatcher({
  pluginService,
  workspaceService,
  getActiveRequest,
  delegate,
  getParentBinding,
  getContractVersion,
  getVoiceInput = () => null
}) {
  if (typeof pluginService?.call !== 'function' || typeof delegate !== 'function' ||
      typeof getActiveRequest !== 'function' || typeof getParentBinding !== 'function' ||
      typeof getContractVersion !== 'function') {
    throw new TypeError('Roleplay dispatcher requires plugin, delegate, active-request, parent-binding, and contract providers.');
  }

  return async function dispatchRoleplay(args, callContext = {}) {
    if (!object(args) || Object.keys(args).some(key => !['sessionId', 'role', 'maxOutputChars', 'voiceInput'].includes(key))) {
      fail('tool arguments do not match the roleplay delegate schema');
    }
    const { sessionId, role, maxOutputChars } = args;
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sessionId)) fail('sessionId is invalid');
    if (!ROLES.includes(role)) fail('role is invalid');
    if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > MAX_OUTPUT_CHARS) fail('maxOutputChars is invalid');

    const request = getActiveRequest();
    if (!object(request) || request.mode !== 'roleplay' || typeof request.text !== 'string' || !request.text.trim()) {
      fail('the active parent request is not an explicit author roleplay request');
    }
    const binding = getParentBinding();
    if (!object(binding) || typeof binding.threadId !== 'string' || !binding.threadId ||
        typeof binding.turnId !== 'string' || !binding.turnId ||
        typeof callContext.parentCallId !== 'string' || !callContext.parentCallId) {
      fail('the request is outside a bound parent thread, turn, and tool call');
    }
    if (typeof workspaceService?.revision !== 'function' || typeof workspaceService?.root !== 'function' || !await workspaceService.root()) {
      fail('there is no active TaleWisp workspace');
    }
    const workspaceRevision = await workspaceService.revision();
    if (typeof workspaceRevision !== 'string' || !workspaceRevision) fail('the active workspace revision is unavailable');
    const startReceipt = currentStartReceipt(workspaceService, sessionId, workspaceRevision);

    const status = nativeContent(await pluginService.call('talewisp_roleplay_status', { session_id: sessionId }, workspaceRevision), 'talewisp_roleplay_status');
    if (status.session_id !== sessionId || status.branch_id !== startReceipt.result.structuredContent.branch_id ||
        status.hero_id !== startReceipt.result.structuredContent.hero_id || status.run_state !== 'active') {
      fail('the fresh native branch status does not match the applied start receipt');
    }

    let trustedVoice = null;
    if (role === 'formatter') {
      trustedVoice = await getVoiceInput({ request, sessionId, workspaceRevision });
    }
    const packet = nativeContent(await pluginService.call('talewisp_roleplay_packet', {
      session_id: sessionId,
      role,
      ...(role === 'formatter' ? { voice_input: trustedVoice } : {})
    }, workspaceRevision), 'talewisp_roleplay_packet');
    if (packet.role !== role || packet.branch_id && packet.branch_id !== status.branch_id ||
        packet.hero_id && packet.hero_id !== status.hero_id) fail('native role packet binding does not match branch status');
    // Hero and formatter projections intentionally omit branch-control metadata.
    // A second fresh status brackets packet construction and detects intervening
    // branch changes without adding status fields to those role packets.
    const confirmedStatus = nativeContent(await pluginService.call('talewisp_roleplay_status', { session_id: sessionId }, workspaceRevision), 'talewisp_roleplay_status');
    if (confirmedStatus.session_id !== status.session_id || confirmedStatus.branch_id !== status.branch_id ||
        confirmedStatus.hero_id !== status.hero_id || confirmedStatus.revision !== status.revision ||
        confirmedStatus.phase !== status.phase || confirmedStatus.run_state !== status.run_state ||
        confirmedStatus.skeleton_accepted_content_revision !== status.skeleton_accepted_content_revision ||
        confirmedStatus.formatting_ready !== status.formatting_ready) fail('native branch changed while the role packet was being prepared');
    const childPacket = projectedPacket(role, packet, status, trustedVoice);
    const input = clampPacket(childPacket, 'Native role packet');
    if (await workspaceService.revision() !== workspaceRevision) fail('workspace changed while the role packet was being prepared');

    const receipt = await delegate({
      role: CHILD_ROLE[role],
      task: TASK[role],
      input,
      maxOutputChars,
      parentThreadId: binding.threadId,
      parentTurnId: binding.turnId,
      parentCallId: callContext.parentCallId,
      contractVersion: getContractVersion(),
      workspaceRevision
    });
    if (!object(receipt?.receipt) || receipt.receipt.complete !== true || receipt.receipt.status !== 'completed' ||
        typeof receipt.receipt.result !== 'string' || receipt.receipt.role !== CHILD_ROLE[role]) {
      fail('the child did not return a completed delegation receipt');
    }
    return receipt;
  };
}
