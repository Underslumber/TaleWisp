import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { realpath, readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CONTRACT_SCHEMA = 'talewisp-runtime-contract/v1';
const MAX_RESOURCE_BYTES = 128 * 1024;
const CAPABILITY_STATES = new Set(['available', 'unavailable', 'not_checked']);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIR, '..');
const DEFAULT_POLICY_ROOT = path.join(MODULE_DIR, 'runtime-policy');
const ROOT_SKILLS = [
  { logical: 'plugins/talewisp/skills/write-fiction', canonical: 'plugin/skills/write-fiction', alias: 'plugins/talewisp/skills/write-fiction' },
  { logical: 'plugins/talewisp/skills/build-series-base', canonical: 'plugin/skills/build-series-base', alias: 'plugins/talewisp/skills/build-series-base' },
  { logical: 'plugins/talewisp/skills/google-writing-workspace', canonical: 'plugin/skills/google-writing-workspace', alias: 'plugins/talewisp/skills/google-writing-workspace' },
  { logical: 'skills/coordinate-talewisp-storyart', canonical: 'plugin/skills/coordinate-talewisp-storyart', alias: 'skills/coordinate-talewisp-storyart' },
];
const EDITOR_PROTOCOL = 'vault/99_Служебное/Редакторский протокол.md';
const EDITOR_PROTOCOL_SNAPSHOT = 'editor-protocol.md';
const GLOBAL_OPERATIONAL_FILES = [
  ['host/policies/orchestration.md', path.join('policies', 'orchestration.md')],
  ['host/skills/gemini-review-handoff/SKILL.md', path.join('skills', 'gemini-review-handoff', 'SKILL.md')],
];
const WRITING = 'project/plugins/talewisp/skills/write-fiction';
const SERIES_BASE = 'project/plugins/talewisp/skills/build-series-base';
const GOOGLE_WRITING = 'project/plugins/talewisp/skills/google-writing-workspace';

export const ROOT_WORKFLOW_INSTRUCTIONS = `# TaleWisp web runtime root workflow

These instructions are normative for the runtime contract. Apply this priority: the current direct user request; project-specific constraints and dialogue; current global user instructions; bundled skill resources; defaults. Preserve source text in resources; when instructions differ, follow that priority and do not silently discard the lower-priority source.

## Load authoritative resources

Before acting, call \`talewisp_runtime_resource\` with the exact resource ID from this contract for every applicable skill and referenced resource. Do not reconstruct a skill from metadata, snippets, summaries, or memory. Load only the selected project scope at runtime. The bundle does not contain author manuscripts, canon, prose, character cards, style profiles, or lexical dictionaries; fetch those only from the selected authorized scope through the host's scoped TaleWisp tools.

## Delegate through the host

Use \`talewisp_delegate\` only when a scenario below calls for delegation and the host exposes it. Pass exactly \`{ role, task, input, maxOutputChars }\`. The host validates authorization, role, model, privacy, and scope; the runtime contract itself does not dispatch, choose a model, or grant tool access. Never pass the full conversation or unrelated vault material by default.

Current user/global instruction routing is authoritative: ordinary discovery, implementation, mechanics, debugging, and routine checks use \`default\`, \`worker\`, or \`explorer\` on \`gpt-6-luna\`, high effort, with no inherited full history. A standard fiction production dispatch uses exactly one \`style_editor\` on that same ordinary route. \`lore_researcher\`, \`vault_curator\`, and \`continuity_reviewer\` are available only for their bounded, applicable tasks and follow the same ordinary route. Do not select Sol based on complexity. \`sol_review\` is limited to substantial code changes, after machine checks, as independent read-only review; it is not a default fiction reviewer. \`sol_escalation\` requires a recorded confirmed substantive Luna failure or the user's direct Sol request and an explicit gate. Preserve any stronger current user instruction.

## Scenario gates

- Ordinary writing, continuation, or revision: load the writing skill, applicable production references, the selected series lexical dictionary and authorized scene/canon context at runtime. Delegate one finished-prose generation to one \`style_editor\`; do not make calibration or roleplay the default. A quick \`continuity_reviewer\` is conditional: the user requests review, there is a consequential canon/knowledge/physical risk, or the root has a specific evidence-based doubt. At most one reviewer; no hidden rewrite loop.
- Continuation and revision are explicit ordinary-writing task types: pass the current scene, source context, and exact user delta within the authorized scope. A revision first loads the editor protocol and keeps its minimal-change and knowledge/relationship preservation constraints.
- Canon research, timeline questions, and knowledge-at-time checks: remain in the root unless bounded evidence retrieval is needed; then use one read-only \`lore_researcher\` and load only linked source material. Do not have research silently change canon or prose.
- Onboarding: use the writing skill's onboarding route and ask only questions required for the requested next step. Do not block an immediate task with generic setup.
- Roleplay: only after explicit author opt-in and the source-backed readiness gate. Load both roleplay resources; preserve their separate host/agent responsibilities. It is not an automatic writing mode.
- Calibration/training: only by explicit author request. Load the calibration/evaluation resources, keep candidates blind to held-out author examples, and run the requested bounded comparison. Do not launch automatically.
- Series-base import: use the build-series-base route. Ask for the pseudonym first unless supplied in the request; do not read source books or create author placement before that answer. Completion requires the full source-grounded layers and the route's required checks/review.
- Existing manuscript Google Docs or linked Google workspace: use the Google workspace route and read its required context and acceptance resources. Native Google operations require the host's connected tools, current schema, user authorization, and requested scope. Merely loading a skill does not provide Docs/Sheets/Drive capability.
- StoryArt: TaleWisp remains canon owner. Use its coordinator and persistent-links resources; create/continue a dedicated partner task only through a host transport that supports it. This bundle does not provide StoryArt transport, generation, registry access, or approval. Do not claim handoff or acceptance without host evidence.
- Vault analysis or canon questions: load only selected-scope sources through authorized TaleWisp tools. A resource bundle never authorizes whole-vault reads, writes, deletions, or external transmission.
- Review: distinguish prose review from code review. Fiction review is conditional and bounded as above. Code \`sol_review\` requires a substantial code diff and completed machine checks. A review role cannot edit or trigger a repair loop unless separately authorized.

## Capability truth

Every scenario reports host capabilities as \`available\`, \`unavailable\`, or \`not_checked\` from live host evidence. Skill presence is not a capability signal. Native Google actions require the corresponding connector and scope; StoryArt requires its dedicated-task transport; Gemini requires the configured local handoff tool/adapter and applicable policy. If a dependency is missing, report that exact operation as unavailable and retain any prepared proposal; do not simulate success. The host remains responsible for authorization checks and actual operation receipts.`;

const ROLES = Object.freeze({
  default: { purpose: 'ordinary bounded work', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  worker: { purpose: 'bounded implementation or debugging', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  explorer: { purpose: 'bounded read-only discovery', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  style_editor: { purpose: 'one finished prose generation or revision', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  lore_researcher: { purpose: 'bounded canon or external evidence research', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  vault_curator: { purpose: 'bounded vault structure or explicitly scoped continuity extraction', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  continuity_reviewer: { purpose: 'conditional quick fiction blocker review', model: 'gpt-6-luna', reasoningEffort: 'high', fullHistory: false, writes: 'read-only' },
  sol_review: { purpose: 'independent review of substantial code changes after machine checks', model: 'gpt-6.1-sol', reasoningEffort: 'medium', fullHistory: false, writes: 'read-only', defaultDispatchable: false, requires: ['substantial_code_change', 'machine_checks_complete', 'explicit_sol_gate'] },
  sol_escalation: { purpose: 'bounded diagnosis after confirmed substantive Luna failure or direct user Sol request', model: 'gpt-6.1-sol', reasoningEffort: 'high', fullHistory: false, writes: 'read-only', defaultDispatchable: false, requires: ['confirmed_substantive_luna_failure_or_direct_user_request', 'explicit_sol_gate'] },
});

const SCENARIOS = Object.freeze({
  ordinary_writing: { title: 'New prose', default: true, roles: ['style_editor'], maxWriterCalls: 1, reviewer: 'conditional; at most one continuity_reviewer; blockers only; no automatic rewrite', resources: [`${WRITING}/SKILL.md`, `${WRITING}/references/production-input.md`, `${WRITING}/references/agent-routing.md`] },
  continuation: { title: 'Continue a scene', default: true, roles: ['style_editor'], maxWriterCalls: 1, reviewer: 'same conditional rule as ordinary_writing', resources: [`${WRITING}/SKILL.md`, `${WRITING}/references/production-input.md`, `${WRITING}/references/agent-routing.md`] },
  revision: { title: 'Revise existing prose', default: true, roles: ['style_editor'], maxWriterCalls: 1, reviewer: 'same conditional rule as ordinary_writing', resources: [`${WRITING}/SKILL.md`, `${WRITING}/references/production-input.md`, `${WRITING}/references/agent-routing.md`, 'project/editor-protocol-public'] },
  canon_research: { title: 'Research canon or external evidence', default: false, roles: ['lore_researcher'], maxCalls: 1, writes: 'read-only', resources: [`${WRITING}/SKILL.md`, `${WRITING}/references/agent-routing.md`] },
  knowledge_audit: { title: 'Check chronology or character knowledge', default: false, roles: ['lore_researcher', 'continuity_reviewer'], requires: ['source_bound_records_when_using_deterministic_audit'], writes: 'read-only', resources: [`${WRITING}/references/continuity-contract.md`, `${WRITING}/references/agent-routing.md`] },
  onboarding: { title: 'Author or project onboarding', default: false, roles: [], requires: ['only_necessary_questions', 'do_not_block_immediate_request'], resources: [`${WRITING}/references/onboarding.md`] },
  roleplay: { title: 'Roleplay mode', default: false, requires: ['explicit_author_opt_in', 'source_backed_readiness'], resources: [`${WRITING}/references/roleplay-mode.md`, `${WRITING}/references/roleplay-dramaturgy.md`] },
  calibration: { title: 'Style calibration or training', default: false, requires: ['explicit_author_request'], resources: [`${WRITING}/references/style-calibration.md`, `${WRITING}/references/style-evaluation.md`] },
  series_base: { title: 'Build a series base', default: false, requires: ['applicable_import_request', 'pseudonym_before_source_reading_unless_supplied', 'host_import_capability'], resources: [`${SERIES_BASE}/SKILL.md`, `${SERIES_BASE}/references/source-inputs.md`, `${SERIES_BASE}/references/process.md`, `${SERIES_BASE}/references/analysis-schema.md`] },
  google_workspace: { title: 'Google author workspace', default: false, requires: ['connected_native_tool', 'live_schema', 'user_authorization', 'requested_scope'], resources: [`${GOOGLE_WRITING}/SKILL.md`, `${GOOGLE_WRITING}/references/context.md`, `${GOOGLE_WRITING}/references/capabilities.md`, `${GOOGLE_WRITING}/references/acceptance.md`], neverInferCapabilityFromSkill: true },
  storyart: { title: 'StoryArt partner task', default: false, requires: ['host_partner_task_transport', 'story_grounded_brief', 'approval_receipt_for_publishing'], resources: ['project/skills/coordinate-talewisp-storyart/SKILL.md', 'project/skills/coordinate-talewisp-storyart/references/persistent-links.md'], neverInferCapabilityFromSkill: true },
  code_review: { title: 'Independent code review', default: false, requires: ['substantial_code_change', 'machine_checks_complete', 'explicit_sol_gate', 'host_subagent_capability'], role: 'sol_review' },
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const slash = (value) => value.split(path.sep).join('/');
const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function redactPrivateAbsolutePaths(text) {
  return text
    .replace(/C:\\Users\\[^\\\s`"'<>]+/gi, '{USER_HOME}')
    .replace(/D:\\Projects\\TaleWisp/gi, '{PROJECT_ROOT}')
    .replace(/D:\\Projects\\StoryArt/gi, '{STORYART_ROOT}');
}

function extractMarkdownTargets(text) {
  const targets = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, '').split(/[ \t]+(?:"|')/)[0];
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(raw)) continue;
    const withoutAnchor = raw.split('#', 1)[0];
    if (withoutAnchor.toLowerCase().endsWith('.md')) targets.push(withoutAnchor);
  }
  return targets;
}

function parseSkillMetadata(text, id) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Skill entry has no frontmatter metadata: ${id}`);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) throw new Error(`Skill entry is missing name/description metadata: ${id}`);
  return Object.freeze({ id, name, description });
}

async function safeRead(rootReal, absolutePath, sourceId) {
  let resolved;
  try {
    resolved = await realpath(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing runtime resource ${sourceId}: ${slash(path.relative(rootReal, absolutePath))}`);
    throw error;
  }
  const relative = path.relative(rootReal, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime resource path escapes its configured allowlist: ${sourceId}`);
  }
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) throw new Error(`Runtime resource symlink is not allowed: ${sourceId}`);
  const buffer = await readFile(resolved);
  if (buffer.byteLength > MAX_RESOURCE_BYTES) {
    throw new Error(`Runtime resource ${sourceId} exceeds ${MAX_RESOURCE_BYTES} bytes; refusing truncation`);
  }
  return { text: buffer.toString('utf8'), sourcePath: resolved };
}

function redactResourceText(text) {
  return redactPrivateAbsolutePaths(text);
}

/**
 * Builds an allowlisted, source-hashed instruction contract for a TaleWisp host.
 * Global rules come from the configured user .codex tree when present, otherwise
 * from the exact portable policy snapshots shipped beside this module.
 */
export async function createRuntimeContract({ projectRoot = DEFAULT_PROJECT_ROOT, globalInstructionsPath, hostCapabilities = {}, userHomeDirectory = homedir() } = {}) {
  for (const [name, state] of Object.entries(hostCapabilities)) {
    if (!CAPABILITY_STATES.has(state)) throw new Error(`Invalid host capability state for ${name}: ${String(state)}`);
  }
  const rootReal = await realpath(projectRoot);
  const projectAgentPath = path.join(rootReal, 'AGENTS.md');
  const projectAgent = await safeRead(rootReal, projectAgentPath, 'project/AGENTS.md');
  const sourceFiles = new Map();
  const contentById = new Map();
  const sourceHashes = new Map();
  const projectAgentHash = sha256(projectAgent.text);
  sourceFiles.set('project/AGENTS.md', { kind: 'project', sourcePath: projectAgent.sourcePath, relative: 'AGENTS.md', sourceHash: projectAgentHash, provenance: 'project' });
  sourceHashes.set('project/AGENTS.md', projectAgentHash);
  contentById.set('project/AGENTS.md', redactResourceText(projectAgent.text));

  const selectedSkillRoots = [];
  for (const skill of ROOT_SKILLS) {
    const canonical = path.resolve(rootReal, skill.canonical);
    const alias = path.resolve(rootReal, skill.alias);
    let selected;
    try {
      await realpath(canonical);
      selected = canonical;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      selected = alias;
    }
    selectedSkillRoots.push({ sourceRoot: selected, logicalRoot: skill.logical });
  }

  function mapProjectSource(relative) {
    const absolute = path.resolve(rootReal, relative);
    const mapping = selectedSkillRoots
      .filter(({ sourceRoot }) => isWithin(sourceRoot, absolute))
      .sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0];
    if (mapping) {
      const remainder = path.relative(mapping.sourceRoot, absolute);
      return { id: `project/${slash(path.join(mapping.logicalRoot, remainder))}`, isAllowed: true };
    }
    const isEditorProtocol = slash(relative) === EDITOR_PROTOCOL;
    return { id: isEditorProtocol ? 'project/editor-protocol-public' : `project/${slash(relative)}`, isAllowed: isEditorProtocol };
  }

  async function addProjectResource(relativePath, idOverride) {
    const normalized = path.normalize(relativePath);
    const absolute = path.resolve(rootReal, normalized);
    const relative = path.relative(rootReal, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Project resource is outside the TaleWisp root: ${relativePath}`);
    }
    const mapped = mapProjectSource(relative);
    if (!mapped.isAllowed) throw new Error(`Project resource is outside configured operational roots: ${slash(relative)}`);
    const id = idOverride ?? mapped.id;
    if (contentById.has(id)) return id;
    const { text, sourcePath } = await safeRead(rootReal, absolute, id);
    const sourceHash = sha256(text);
    sourceFiles.set(id, { kind: 'project', sourcePath, relative: slash(relative), sourceHash, provenance: 'project' });
    sourceHashes.set(id, sourceHash);
    contentById.set(id, redactResourceText(text));
    for (const target of extractMarkdownTargets(text)) {
      const nextPath = path.resolve(path.dirname(absolute), decodeURIComponent(target));
      const resolvedRelative = path.relative(rootReal, nextPath);
      if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) {
        throw new Error(`Markdown reference escapes project allowlist in ${id}: ${target}`);
      }
      await addProjectResource(path.relative(rootReal, nextPath));
    }
    return id;
  }

  async function addDeclaredScenarioResource(id) {
    if (contentById.has(id) || id === 'project/editor-protocol-public') return;
    if (typeof id !== 'string' || !id.startsWith('project/')) throw new Error(`Scenario resource is outside configured project roots: ${String(id)}`);
    const logical = id.slice('project/'.length);
    const mapping = selectedSkillRoots
      .filter(({ logicalRoot }) => logical === logicalRoot || logical.startsWith(`${logicalRoot}/`))
      .sort((a, b) => b.logicalRoot.length - a.logicalRoot.length)[0];
    if (!mapping) throw new Error(`Scenario resource is outside configured operational roots: ${id}`);
    const remainder = logical === mapping.logicalRoot ? '' : logical.slice(mapping.logicalRoot.length + 1);
    if (!remainder || remainder.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Invalid declared scenario resource ID: ${id}`);
    await addProjectResource(path.relative(rootReal, path.join(mapping.sourceRoot, ...remainder.split('/'))), id);
  }

  for (const skill of selectedSkillRoots) {
    await addProjectResource(path.relative(rootReal, path.join(skill.sourceRoot, 'SKILL.md')), `project/${skill.logicalRoot}/SKILL.md`);
  }
  for (const id of new Set(Object.values(SCENARIOS).flatMap((scenario) => scenario.resources ?? []))) {
    await addDeclaredScenarioResource(id);
  }
  const editorProtocolId = 'project/editor-protocol-public';
  let editorProtocol;
  let editorProtocolProvenance = 'project';
  let editorProtocolOrigin = EDITOR_PROTOCOL;
  try {
    editorProtocol = await safeRead(rootReal, path.join(rootReal, EDITOR_PROTOCOL), editorProtocolId);
  } catch (error) {
    if (!String(error?.message).startsWith(`Missing runtime resource ${editorProtocolId}:`)) throw error;
    const snapshotRoot = await realpath(DEFAULT_POLICY_ROOT);
    editorProtocol = await safeRead(snapshotRoot, path.join(snapshotRoot, EDITOR_PROTOCOL_SNAPSHOT), editorProtocolId);
    editorProtocolProvenance = 'portable_snapshot';
    editorProtocolOrigin = `runtime-policy/${EDITOR_PROTOCOL_SNAPSHOT}`;
  }
  const editorProtocolHash = sha256(editorProtocol.text);
  sourceFiles.set(editorProtocolId, { kind: editorProtocolProvenance === 'project' ? 'project' : 'host', sourcePath: editorProtocol.sourcePath, relative: editorProtocolOrigin, sourceHash: editorProtocolHash, provenance: editorProtocolProvenance });
  sourceHashes.set(editorProtocolId, editorProtocolHash);
  contentById.set(editorProtocolId, redactResourceText(editorProtocol.text));

  let globalPath;
  let policyProvenance;
  if (globalInstructionsPath !== undefined && globalInstructionsPath !== null) {
    globalPath = path.resolve(globalInstructionsPath);
    policyProvenance = 'local_host';
  } else {
    const hostPath = path.resolve(userHomeDirectory, '.codex', 'AGENTS.md');
    try {
      await realpath(hostPath);
      globalPath = hostPath;
      policyProvenance = 'local_host';
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      globalPath = path.join(DEFAULT_POLICY_ROOT, 'AGENTS.md');
      policyProvenance = 'portable_snapshot';
    }
  }
  const codexRoot = path.dirname(globalPath);
  const codexRootReal = await realpath(codexRoot);
  async function addHostResource(id, absolute) {
    const { text, sourcePath } = await safeRead(codexRootReal, absolute, id);
    const sourceHash = sha256(text);
    sourceFiles.set(id, { kind: 'host', sourcePath, relative: slash(path.relative(codexRootReal, sourcePath)), sourceHash, provenance: policyProvenance });
    sourceHashes.set(id, sourceHash);
    contentById.set(id, redactResourceText(text));
    return text;
  }

  const globalRules = await addHostResource('host/global/AGENTS.md', globalPath);
  for (const [id, suffix] of GLOBAL_OPERATIONAL_FILES) {
    await addHostResource(id, path.join(codexRoot, suffix));
  }

  // Google author-workspace skills are a declared operational dependency.
  // Resolve only the named installed plugin path; never scan the user's home.
  const googleCodexRoot = policyProvenance === 'portable_snapshot' ? path.join(userHomeDirectory, '.codex') : codexRoot;
  const googlePluginRoot = path.join(googleCodexRoot, 'plugins', 'cache', 'openai-curated-remote', 'google-drive');
  const googleSkillNames = ['google-drive', 'google-docs', 'google-sheets', 'google-drive-comments'];
  let googleSkillsAvailable = true;
  let googleSkillsReason = null;
  let googlePluginReal;
  try {
    googlePluginReal = await realpath(googlePluginRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    googleSkillsAvailable = false;
    googleSkillsReason = `Installed Google connector skill root is missing: ${slash(path.relative(googleCodexRoot, googlePluginRoot))}`;
  }
  if (googleSkillsAvailable) {
    const googleCodexRootReal = await realpath(googleCodexRoot);
    if (!isWithin(googleCodexRootReal, googlePluginReal)) throw new Error('Installed Google connector skill root resolves outside the configured Codex operational root');
    const { readdir } = await import('node:fs/promises');
    const versions = (await readdir(googlePluginReal, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!versions.length) {
      googleSkillsAvailable = false;
      googleSkillsReason = `No installed Google connector version exists under ${slash(path.relative(googleCodexRoot, googlePluginRoot))}`;
    }
    if (googleSkillsAvailable) {
    const selectedVersion = versions[0];
    const skillsRoot = path.join(googlePluginReal, selectedVersion, 'skills');
    const sourceRootReal = await realpath(skillsRoot);
    if (!isWithin(googlePluginReal, sourceRootReal)) throw new Error('Installed Google skill directory resolves outside its plugin root');
    for (const name of googleSkillNames) {
      const startPath = path.join(skillsRoot, name, 'SKILL.md');
      const id = `host/plugins/google-drive/${selectedVersion}/skills/${name}/SKILL.md`;
      const { text, sourcePath } = await safeRead(sourceRootReal, startPath, id);
      const sourceHash = sha256(text);
      sourceFiles.set(id, { kind: 'host', sourcePath, relative: slash(path.relative(googleCodexRootReal, sourcePath)), sourceHash, provenance: 'installed_plugin' });
      sourceHashes.set(id, sourceHash);
      contentById.set(id, redactResourceText(text));
      const allowedRoot = skillsRoot;
      async function addGoogleReference(targetPath, fromId) {
        const absolute = path.resolve(path.dirname(fromId === id ? startPath : sourceFiles.get(fromId).sourcePath), targetPath);
        const allowed = path.relative(allowedRoot, absolute);
        if (allowed === '..' || allowed.startsWith(`..${path.sep}`) || path.isAbsolute(allowed)) throw new Error(`Google skill reference escapes its skill root in ${fromId}: ${targetPath}`);
        const resourceId = `host/plugins/google-drive/${selectedVersion}/skills/${slash(allowed)}`;
        if (contentById.has(resourceId)) return;
        const { text: referenceText, sourcePath: referencePath } = await safeRead(sourceRootReal, absolute, resourceId);
        const referenceHash = sha256(referenceText);
        sourceFiles.set(resourceId, { kind: 'host', sourcePath: referencePath, relative: slash(path.relative(googleCodexRootReal, referencePath)), sourceHash: referenceHash, provenance: 'installed_plugin' });
        sourceHashes.set(resourceId, referenceHash);
        contentById.set(resourceId, redactResourceText(referenceText));
        for (const child of extractMarkdownTargets(referenceText)) await addGoogleReference(path.resolve(path.dirname(referencePath), decodeURIComponent(child)), resourceId);
      }
      for (const target of extractMarkdownTargets(text)) await addGoogleReference(path.resolve(path.dirname(startPath), decodeURIComponent(target)), id);
    }
    }
  }

  // Exact global rules are exposed as a resource and included in root instructions.
  // Resource IDs, rather than absolute paths, are the only origins returned to callers.
  const skillEntries = ROOT_SKILLS.map(({ logical }) => {
    const id = `project/${logical}/SKILL.md`;
    return parseSkillMetadata(sourceFiles.has(id) ? contentById.get(id) : '', id);
  });
  const skillCatalog = `## Bundled skill entry metadata\n\n${skillEntries.map(({ id, name, description }) => `- \`${name}\` — ${description} Resource: \`${id}\`.`).join('\n')}`;
  const instructionText = `${redactResourceText(globalRules)}\n\n---\n\n${redactResourceText(projectAgent.text)}\n\n---\n\n${skillCatalog}\n\n---\n\n${ROOT_WORKFLOW_INSTRUCTIONS}`;
  if (Buffer.byteLength(instructionText, 'utf8') > MAX_RESOURCE_BYTES) {
    throw new Error(`Combined runtime instructions exceed ${MAX_RESOURCE_BYTES} bytes; refusing truncation`);
  }

  const resources = [...contentById.entries()].map(([id, text]) => {
    const source = sourceFiles.get(id);
    const derived = false;
    const title = id.split('/').at(-1).replace(/\.md$/i, '').replace(/-/g, ' ');
    return Object.freeze({ id, title, hash: sha256(text), sourceHash: source.sourceHash, origin: source.relative, provenance: source.provenance, derived });
  }).sort((a, b) => a.id.localeCompare(b.id));
  const sourceManifest = [...sourceHashes.entries()].sort(([a], [b]) => a.localeCompare(b));
  const version = sha256(JSON.stringify({ schema: CONTRACT_SCHEMA, instructions: instructionText, resources: resources.map(({ id, hash, sourceHash }) => [id, hash, sourceHash]), roles: ROLES, scenarios: SCENARIOS }));
  const resourceMap = new Map(contentById);

  return Object.freeze({
    version,
    schema: CONTRACT_SCHEMA,
    instructions: instructionText,
    ROOT_WORKFLOW_INSTRUCTIONS,
    skills: Object.freeze(skillEntries),
    resources: Object.freeze(resources),
    sourceManifest: Object.freeze(sourceManifest.map(([id, hash]) => Object.freeze({ id, hash, origin: sourceFiles.get(id).relative, provenance: sourceFiles.get(id).provenance }))),
    roles: ROLES,
    scenarios: SCENARIOS,
    dependencies: Object.freeze({
      googleOperationalSkills: { capability: googleSkillsAvailable ? 'available' : 'unavailable', reason: googleSkillsReason, requires: ['installed Google connector skill package'], availabilityMeaning: 'instruction resources only; no connected tool capability implied' },
      googleNativeTools: { capability: hostCapabilities.googleNativeTools ?? 'not_checked', requires: ['connected Drive/Docs/Sheets tools', 'live tool schema', 'explicit user authorization', 'requested scope'] },
      storyArtTransport: { capability: hostCapabilities.storyArtTransport ?? 'not_checked', requires: ['host transport to the dedicated StoryArt task'] },
      geminiHandoff: { capability: hostCapabilities.geminiHandoff ?? 'not_checked', requires: ['configured local gemini_agy tool or approved adapter path', 'applicable policy'] },
      taleWispTools: { capability: hostCapabilities.taleWispTools ?? 'not_checked', requires: ['host-scoped TaleWisp MCP tools and current user authorization'] },
      subagentDispatch: { capability: hostCapabilities.subagentDispatch ?? 'not_checked', requires: ['host exposes talewisp_delegate', 'host validates role/model/scope'] },
    }),
    readResource(id) {
      if (typeof id !== 'string' || !resourceMap.has(id)) throw new Error(`Unknown or disallowed TaleWisp runtime resource: ${String(id)}`);
      const text = resourceMap.get(id);
      if (Buffer.byteLength(text, 'utf8') > MAX_RESOURCE_BYTES) throw new Error(`Runtime resource ${id} exceeds ${MAX_RESOURCE_BYTES} bytes; refusing truncation`);
      return text;
    },
  });
}

export const RUNTIME_CONTRACT_LIMITS = Object.freeze({ maxResourceBytes: MAX_RESOURCE_BYTES, projectResourceRoots: ['AGENTS.md', 'plugin/skills/{write-fiction,build-series-base,google-writing-workspace,coordinate-talewisp-storyart}/**', 'plugins/talewisp/skills/{write-fiction,build-series-base,google-writing-workspace}/** (legacy alias)', 'skills/coordinate-talewisp-storyart/** (legacy alias)', EDITOR_PROTOCOL], hostResourceRoots: ['<selected-policy-root>/AGENTS.md', '<selected-policy-root>/policies/orchestration.md', '<selected-policy-root>/skills/gemini-review-handoff/**', '<user-home>/.codex/plugins/cache/openai-curated-remote/google-drive/** (optional)', 'web-client/runtime-policy/editor-protocol.md (editor-protocol fallback)'] });
