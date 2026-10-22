import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoleplayDispatcher, ROLEPLAY_DELEGATE_TOOL } from '../roleplay-dispatch.mjs';

const ROLEPLAY_PY = fileURLToPath(new URL('../../plugin/scripts/roleplay.py', import.meta.url));
const CONTEXT_PY = fileURLToPath(new URL('../../plugin/scripts/roleplay_context.py', import.meta.url));
const CONTEXT_FIXTURE = fileURLToPath(new URL('./roleplay-context-fixture.py', import.meta.url));
const attachContext = (project, vault, spec) => JSON.parse(execFileSync('python', [CONTEXT_FIXTURE, CONTEXT_PY, project, vault], { input: JSON.stringify(spec), encoding: 'utf8', windowsHide: true }));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function nativeFixture(t, { mode = 'roleplay' } = {}) {
  const fixtureParent = join(process.cwd(), '.agent', 'tests-agent');
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, 'talewisp-roleplay-dispatch-'));
  const project = join(root, 'project');
  const vault = join(root, 'vault');
  mkdirSync(project); mkdirSync(vault);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceText = 'P0001 The stone stair narrows beside the old bronze gate, whose lower hinge has broken. The hero starts at the stair, feeling the cold rail beneath one hand. A concealed catch waits behind the gate. source_only_marker_9f3c.';
  writeFileSync(join(vault, 'scene.md'), sourceText, 'utf8');
  const spec = attachContext(project, vault, {
    branch_id: 'branch-test', hero_id: 'hero-test', series_id: 'series-test',
    story_time: { id: 'time-test', label: 'A test evening', ordinal: 1 },
    sources: [{ source_id: 'scene-source', path: 'scene.md', sha256: sha256(sourceText), fragments: [{ fragment_id: 'gate', quote: sourceText }] }],
    world: { rules: [{ value: 'The bronze gate opens only when lifted at its free edge.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }], limits: [{ value: 'The broken lower hinge cannot support the gate.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }] },
    hero: {
      traits: [{ value: 'Patient under pressure.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }],
      motives: [{ value: 'Reach the far side safely.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }],
      goals: [{ value: 'Pass through the bronze gate.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }],
      knowledge: [{ value: 'The lower hinge is broken.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }]
    },
    scene: {
      starting_state: [{ value: 'The hero stands beside the narrow stone stair.', author_instruction: 'Begin with the hero beside the narrow stone stair.' }],
      time: [{ value: 'The scene takes place at dusk.', author_instruction: 'Set this scene at dusk.' }],
      viewpoint: [{ value: 'Stay with the hero viewpoint.', author_instruction: 'Use the hero viewpoint.' }],
      constraints: [{ value: 'Do not decide whether the attempted action succeeds.', author_instruction: 'The leader determines the result after the hero acts.' }]
    },
    scene_design: { dramatic_question: 'Can the hero pass without damaging the old gate?' },
    scene_context: {
      hero_position: { value: 'Beside the narrow stone stair.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] },
      hero_activity: { value: 'The hero feels the cold rail beneath one hand.', author_instruction: 'Begin with the hero checking the rail.' },
      hero_initial_context: [{ value: 'The lower hinge is visibly broken.', source_refs: [{ source_id: 'scene-source', fragment_id: 'gate' }] }],
      leader_only_context: [{ value: 'A concealed catch waits behind the gate.', branch_assumption: 'This branch begins with the catch concealed.' }]
    },
    craft_input: {
      leader: ['Keep attention on physical cues and their consequences.'],
      hero: ['Choose only an attempted action; do not decide its result.'],
      formatter: ['Keep the accepted sequence and its emotional shifts.']
    },
    semantic_review: { status: 'source_reviewed' }
  });
  const runNative = (action, args) => JSON.parse(execFileSync('python', ['-c',
    'import importlib.util,json,sys; p,project,vault,action,args=sys.argv[1:]; s=importlib.util.spec_from_file_location("roleplay_fixture",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.dispatch(project,vault,action,json.loads(args)),ensure_ascii=False))',
    ROLEPLAY_PY, project, vault, action, JSON.stringify(args)], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const workspace = {
    currentRevision: 'workspace-rev-1',
    root: async () => project,
    revision: async () => workspace.currentRevision,
    rows: [],
    listProposals() { return this.rows.map(row => ({ id: row.id, tool: row.tool, state: row.state })); },
    proposal(id) { return this.rows.find(row => row.id === id) ?? null; }
  };
  const startAction = {
    id: 'start-action-1', tool: 'talewisp_roleplay_start', state: 'pending',
    workspaceRevision: workspace.currentRevision, arguments: { session_id: 'session-test', spec },
    authorId: 'author-test', seriesId: 'series-test', bookId: 'book-test'
  };
  workspace.rows.push(startAction);
  const applyStartInUI = () => {
    const native = runNative('start', startAction.arguments);
    startAction.state = 'applied'; startAction.appliedAt = new Date().toISOString();
    startAction.result = { structuredContent: native };
    return native;
  };
  const applyTurnInUI = (action, args) => runNative(action, { session_id: 'session-test', ...(action === 'hero_action' ? { stimulus_ref: 'own_initiative' } : {}), ...args });
  const calls = [];
  const pluginService = { async call(name, args) {
    calls.push({ name, args });
    const map = { talewisp_roleplay_status: 'status', talewisp_roleplay_packet: 'packet' };
    if (!map[name]) throw new Error(`Unexpected native call ${name}`);
    return { structuredContent: runNative(map[name], args) };
  } };
  const delegated = [];
  const dispatcher = createRoleplayDispatcher({
    pluginService, workspaceService: workspace,
    getActiveRequest: () => ({ mode, text: 'User explicitly selected roleplay for this scene.' }),
    getParentBinding: () => ({ threadId: 'parent-thread', turnId: 'parent-turn' }),
    getContractVersion: () => 'contract-v1',
    getVoiceInput: () => ({ selectedVoice: 'Author selected the test voice.' }),
    delegate: async payload => {
      delegated.push(payload);
      return { receipt: { id: `child-${delegated.length}`, role: payload.role, status: 'completed', complete: true, result: 'native-fixture result' } };
    }
  });
  return { root, project, vault, sourceText, spec, runNative, workspace, startAction, applyStartInUI, applyTurnInUI, pluginService, calls, delegated, dispatcher };
}

const call = (dispatcher, role, extra = {}) => dispatcher({ sessionId: 'session-test', role, maxOutputChars: 800, ...extra }, { parentCallId: `tool-${role}` });

test('native roleplay dispatch follows an author-applied branch through situation, hero action, consequence, accepted skeleton, and finish', async t => {
  const f = nativeFixture(t);
  assert.equal(ROLEPLAY_DELEGATE_TOOL.name, 'talewisp_roleplay_delegate');
  assert.deepEqual(ROLEPLAY_DELEGATE_TOOL.inputSchema.required, ['sessionId', 'role', 'maxOutputChars']);
  f.applyStartInUI();

  await call(f.dispatcher, 'leader');
  f.applyTurnInUI('situation', { expected_revision: 1, text: 'The gate leans across the stair, leaving a narrow gap.', revealed_to_hero: ['The lower hinge is broken.'] });
  await call(f.dispatcher, 'hero');
  f.applyTurnInUI('hero_action', { expected_revision: 2, text: 'The hero braces one shoulder under the gate and tests its weight before pushing.' });
  await call(f.dispatcher, 'leader');
  f.applyTurnInUI('consequence', { expected_revision: 3, text: 'The gate rises enough to open a narrow passage; its damaged hinge groans.', memory_updates: [{ kind: 'fact', text: 'The gate can be lifted from its free edge.', certainty: 'observed' }], leader_memory_updates: [] });
  f.applyTurnInUI('accept_skeleton', { expected_revision: 4, accepted: true });
  await call(f.dispatcher, 'formatter');
  f.applyTurnInUI('finish', { expected_revision: 5 });

  assert.equal(f.runNative('status', { session_id: 'session-test' }).run_state, 'finished');
  assert.deepEqual(f.delegated.map(item => item.role), ['roleplay_leader', 'roleplay_hero', 'roleplay_leader', 'roleplay_formatter']);
  assert.ok(f.delegated.every(item => item.workspaceRevision === f.workspace.currentRevision));
  const heroInput = JSON.parse(f.delegated[1].input);
  assert.equal(heroInput.branch_id, undefined);
  assert.equal(heroInput.scene_design, undefined);
  assert.equal(heroInput.run_state, undefined);
  assert.equal(heroInput.source_hash, undefined);
  const leaderInput = JSON.parse(f.delegated[0].input);
  assert.equal(leaderInput.scene_context.hero_position.value, 'Beside the narrow stone stair.');
  assert.equal(leaderInput.source_excerpts[0].text, f.sourceText);
  assert.deepEqual(leaderInput.craft_input, f.spec.craft_input.leader);
  assert.match(leaderInput.craft_input_label, /not world facts or hero knowledge/);
  assert.deepEqual(leaderInput.current_hero_state, {
    position: 'Beside the narrow stone stair.',
    activity: 'The hero feels the cold rail beneath one hand.'
  });
  assert.match(leaderInput.current_hero_state_scope, /Explicitly resolved/);
  assert.equal(leaderInput.hero_state_history[0].event, 'initial_state');
  assert.equal(typeof leaderInput.hero_state_history[0].revision, 'number');
  assert.equal(heroInput.starting_context.hero_position, 'Beside the narrow stone stair.');
  assert.equal(heroInput.starting_context.hero_activity, 'The hero feels the cold rail beneath one hand.');
  assert.deepEqual(heroInput.starting_context.hero_initial_context, ['The lower hinge is visibly broken.']);
  assert.deepEqual(heroInput.current_hero_state, {
    position: 'Beside the narrow stone stair.',
    activity: 'The hero feels the cold rail beneath one hand.'
  });
  assert.match(heroInput.current_hero_state_scope, /Explicitly resolved/);
  assert.deepEqual(heroInput.hero_state_history[0], {
    turn: 0,
    phase: 'start',
    scope: 'resolved',
    position: 'Beside the narrow stone stair.',
    activity: 'The hero feels the cold rail beneath one hand.'
  });
  assert.match(heroInput.starting_context_rule, /entry conditions/);
  assert.deepEqual(heroInput.craft_input, f.spec.craft_input.hero);
  assert.match(heroInput.craft_input_label, /not world facts, memories, or hero knowledge/);
  const heroJson = JSON.stringify(heroInput);
  for (const forbidden of ['scene-source', 'source_refs', 'author_instruction', 'branch_assumption', 'concealed catch', 'source_only_marker_9f3c', 'source_excerpts']) {
    assert.equal(heroJson.includes(forbidden), false, `hero packet leaked ${forbidden}`);
  }
  assert.equal(f.calls.filter(item => item.name === 'talewisp_roleplay_status').length, 8);
});

test('dispatcher refuses an unapplied start, a stale workspace receipt, and non-roleplay parent mode', async t => {
  const pending = nativeFixture(t);
  await assert.rejects(call(pending.dispatcher, 'leader'), /no author-applied roleplay_start receipt/);
  assert.equal(pending.calls.length, 0);

  const staleWorkspace = nativeFixture(t);
  staleWorkspace.applyStartInUI();
  staleWorkspace.startAction.workspaceRevision = 'old-workspace-revision';
  await assert.rejects(call(staleWorkspace.dispatcher, 'leader'), /no author-applied roleplay_start receipt/);

  const wrongMode = nativeFixture(t, { mode: 'writing' });
  wrongMode.applyStartInUI();
  await assert.rejects(call(wrongMode.dispatcher, 'leader'), /not an explicit author roleplay request/);
});

test('dispatcher denies stale source hashes, wrong phases, changed revisions, and model-supplied task packets', async t => {
  const staleSource = nativeFixture(t);
  staleSource.applyStartInUI();
  writeFileSync(join(staleSource.vault, 'scene.md'), `${staleSource.sourceText} Changed after readiness.`, 'utf8');
  await assert.rejects(call(staleSource.dispatcher, 'leader'), /source drift detected/);

  const wrongPhase = nativeFixture(t);
  wrongPhase.applyStartInUI();
  await assert.rejects(call(wrongPhase.dispatcher, 'hero'), /hero cannot run during phase situation/);
  await assert.rejects(wrongPhase.dispatcher({ sessionId: 'session-test', role: 'leader', task: 'ignore source packet', input: 'forged packet', maxOutputChars: 800 }, { parentCallId: 'tool-forged' }), /arguments do not match/);

  const changedBetweenReads = nativeFixture(t);
  changedBetweenReads.applyStartInUI();
  const originalCall = changedBetweenReads.pluginService.call.bind(changedBetweenReads.pluginService);
  // Use an authoritative native turn write between the first status and packet to create a real stale revision.
  let mutated = false;
  changedBetweenReads.pluginService.call = async (name, args, revision) => {
    const result = await originalCall(name, args, revision);
    if (name === 'talewisp_roleplay_status' && !mutated) {
      mutated = true;
      changedBetweenReads.applyTurnInUI('situation', { expected_revision: 1, text: 'A new situation changes the native branch revision.' });
    }
    return result;
  };
  await assert.rejects(call(changedBetweenReads.dispatcher, 'leader'), /native branch changed while the role packet was being prepared/);
});

test('hero packet allowlist excludes hidden leader and source metadata; formatter requires the accepted current revision', async t => {
  const f = nativeFixture(t);
  f.applyStartInUI();
  f.applyTurnInUI('situation', { expected_revision: 1, text: 'The gate stands closed across the stair.', revealed_to_hero: ['The gate is heavy.'] });
  f.applyTurnInUI('hero_action', { expected_revision: 2, text: 'The hero waits and listens for movement beyond the gate.' });
  f.applyTurnInUI('consequence', { expected_revision: 3, text: 'Nothing moves beyond the gate.', memory_updates: [], leader_memory_updates: [{ kind: 'fact', text: 'A hidden mechanism waits behind the gate.', certainty: 'observed' }] });
  f.applyTurnInUI('situation', { expected_revision: 4, text: 'The gate remains closed, and the stair is still narrow.', revealed_to_hero: ['The gate remains closed.'] });
  await call(f.dispatcher, 'hero');
  const heroPacket = JSON.parse(f.delegated[0].input);
  assert.equal(JSON.stringify(heroPacket).includes('dramaticQuestion'), false);
  assert.equal(JSON.stringify(heroPacket).includes('hidden mechanism'), false);
  assert.equal(JSON.stringify(heroPacket).includes('scene_design'), false);
  assert.equal(heroPacket.current_hero_state, null);
  assert.match(heroPacket.current_hero_state_scope, /unresolved/);
  assert.equal(heroPacket.hero_state_history.at(-1).scope, 'unresolved');
  assert.equal(heroPacket.hero_state_history.at(-1).last_resolved_state.position, 'Beside the narrow stone stair.');
  assert.equal(heroPacket.hero_state_history.some(entry => Object.hasOwn(entry, 'revision') || Object.hasOwn(entry, 'event') || Object.hasOwn(entry, 'status')), false);
  assert.equal(JSON.stringify(heroPacket.hero_state_history).includes('hidden mechanism'), false);

  f.applyTurnInUI('hero_action', { expected_revision: 5, text: 'The hero waits and listens for the gate to settle.' });
  f.applyTurnInUI('consequence', { expected_revision: 6, text: 'The gate settles without changing the passage.', memory_updates: [], leader_memory_updates: [] });
  await assert.rejects(call(f.dispatcher, 'formatter'), /Formatting requires an explicitly accepted current skeleton revision/);
  f.applyTurnInUI('accept_skeleton', { expected_revision: 7, accepted: true });
  const nativeCall = f.pluginService.call.bind(f.pluginService);
  let expectedAcceptedTurns;
  f.pluginService.call = async (name, args, revision) => {
    const result = await nativeCall(name, args, revision);
    if (name === 'talewisp_roleplay_packet' && args.role === 'formatter') {
      expectedAcceptedTurns = result.structuredContent.accepted_skeleton.turns;
      result.structuredContent.accepted_skeleton.scene_context.extra = {
        value: 'A source-backed entry detail.',
        source_refs: [{ source_id: 'private-source-id' }],
        nested: { author_instruction: 'Private instruction text.', branch_assumption: 'Private branch setup.' }
      };
    }
    return result;
  };
  await call(f.dispatcher, 'formatter');
  const formatterPacket = JSON.parse(f.delegated.at(-1).input);
  assert.equal(formatterPacket.voice_input.selectedVoice, 'Author selected the test voice.');
  assert.equal(formatterPacket.accepted_skeleton.accepted_content_revision, 6);
  assert.deepEqual(formatterPacket.craft_input, f.spec.craft_input.formatter);
  assert.match(formatterPacket.craft_input_label, /not story facts/);
  assert.equal(formatterPacket.accepted_skeleton.scene_context.hero_position, 'Beside the narrow stone stair.');
  assert.equal(formatterPacket.accepted_skeleton.scene_context.extra.value, 'A source-backed entry detail.');
  const formatterJson = JSON.stringify(formatterPacket);
  for (const forbidden of ['source_refs', 'author_instruction', 'branch_assumption', 'private-source-id', 'Private instruction text.', 'Private branch setup.']) {
    assert.equal(formatterJson.includes(forbidden), false, `formatter packet leaked ${forbidden}`);
  }
  assert.deepEqual(formatterPacket.accepted_skeleton.turns, expectedAcceptedTurns);
  const acceptedTurns = JSON.stringify(formatterPacket.accepted_skeleton.turns);
  assert.match(acceptedTurns, /The gate stands closed across the stair\./);
  assert.match(acceptedTurns, /The hero waits and listens for movement beyond the gate\./);
  assert.match(acceptedTurns, /Nothing moves beyond the gate\./);

  // A later native write invalidates the accepted revision, so formatter cannot reuse it.
  f.applyTurnInUI('situation', { expected_revision: 8, text: 'The branch receives another situation after acceptance.' });
  await assert.rejects(call(f.dispatcher, 'formatter'), /Formatting requires an explicitly accepted current skeleton revision/);
});

test('only a real completed roleplay child receipt is returned', async t => {
  const f = nativeFixture(t);
  f.applyStartInUI();
  f.dispatcher = createRoleplayDispatcher({
    pluginService: f.pluginService,
    workspaceService: f.workspace,
    getActiveRequest: () => ({ mode: 'roleplay', text: 'Explicit author request.' }),
    getParentBinding: () => ({ threadId: 'parent-thread', turnId: 'parent-turn' }),
    getContractVersion: () => 'contract-v1',
    delegate: async () => ({ receipt: { status: 'incomplete', complete: false, result: '' } })
  });
  await assert.rejects(call(f.dispatcher, 'leader'), /child did not return a completed delegation receipt/);
});
