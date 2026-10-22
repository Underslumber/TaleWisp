import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAgentMessagePayload, buildWorkflowViewModel, availabilityLabel, delegationStatusLabel, scenarioCanRun } from '../public/agent-workflows.js';

test('cancellation request is distinct from confirmed stop and incomplete output', () => {
  assert.equal(delegationStatusLabel('cancel_requested'), 'Остановка запрошена');
  assert.equal(delegationStatusLabel('cancelled'), 'Остановлено');
  assert.equal(delegationStatusLabel('incomplete'), 'Не завершено');
});

const runtimeStatusFixture = {
  contractVersion: '1',
  skills: [
    { id: 'project/plugins/talewisp/skills/write-fiction/SKILL.md', title: 'Writing', hash: 'skill-hash', sourceHash: 'source-hash' },
    { id: 'project/plugins/talewisp/skills/write-fiction/references/production-input.md', title: 'Production input', hash: 'ref-hash', sourceHash: 'ref-source-hash' },
    { id: 'project/plugins/talewisp/skills/google-writing-workspace/SKILL.md', title: 'Google Workspace', hash: 'skill-hash-2', sourceHash: 'source-hash-2' },
    { id: 'project/plugins/talewisp/skills/build-series-base/SKILL.md', title: 'Series base', hash: 'skill-hash-3', sourceHash: 'source-hash-3' },
    { id: 'project/plugins/talewisp/skills/coordinate-talewisp-storyart/SKILL.md', title: 'StoryArt', hash: 'skill-hash-4', sourceHash: 'source-hash-4' }
  ],
  scenarios: {
    ordinary_writing: { title: 'New prose', default: true, roles: ['style_editor'], maxWriterCalls: 1 },
    continuation: { title: 'Continue a scene', default: true, roles: ['style_editor'], maxWriterCalls: 1 },
    revision: { title: 'Revise existing prose', default: true, roles: ['style_editor'], maxWriterCalls: 1 },
    canon_research: { title: 'Research canon or external evidence', default: false, roles: ['lore_researcher'] },
    knowledge_audit: { title: 'Check chronology or character knowledge', default: false, roles: ['lore_researcher', 'continuity_reviewer'] },
    onboarding: { title: 'Author or project onboarding', default: false, roles: [] },
    roleplay: { title: 'Roleplay mode', default: false, requires: ['explicit_author_opt_in', 'source_backed_readiness'] },
    calibration: { title: 'Style calibration or training', default: false, requires: ['explicit_author_request'] },
    series_base: { title: 'Build a series base', default: false, requires: ['applicable_import_request', 'host_import_capability'] },
    google_workspace: { title: 'Google author workspace', default: false, neverInferCapabilityFromSkill: true },
    storyart: { title: 'StoryArt partner task', default: false, requires: ['host_partner_task_transport'], neverInferCapabilityFromSkill: true }
  },
  delegations: {
    active: [{ id: 'd-1', role: 'style_editor', model: 'gpt-6-luna', effort: 'high', threadId: 'thread-1', parentTurnId: 'turn-1', parentCallId: 'call-1', status: 'running', startedAt: '2026-10-15T10:00:00Z' }],
    recent: [
      { id: 'd-2', role: 'reviewer', model: 'gpt-6.1-sol', effort: 'medium', threadId: 'thread-2', parentTurnId: 'turn-2', parentCallId: 'call-2', status: 'failed', startedAt: '2026-10-15T10:01:00Z', completedAt: '2026-10-15T10:02:00Z', error: 'Review failed' },
      { id: 'd-3', role: 'worker', model: 'gpt-6-luna', effort: 'high', threadId: 'thread-3', parentTurnId: 'turn-3', parentCallId: 'call-3', status: 'completed', result: 'Done' }
    ]
  }
};

const normalizedStatusFixture = {
  ...runtimeStatusFixture,
  scenarios: [
    { id: 'ordinary_writing', title: 'New prose', available: true, gates: [] },
    { id: 'continuation', title: 'Continue a scene', available: true, gates: [] },
    { id: 'revision', title: 'Revise existing prose', available: true, gates: [] },
    { id: 'canon_research', title: 'Research canon', available: true, gates: [] },
    { id: 'knowledge_audit', title: 'Knowledge audit', available: true, gates: [] },
    { id: 'onboarding', title: 'Onboarding', available: true, gates: [] },
    { id: 'series_base', title: 'Import books', available: false, gates: ['host_import_capability'] },
    { id: 'calibration', title: 'Style calibration', available: true, gates: ['explicit_author_request'] },
    { id: 'roleplay', title: 'Roleplay', available: true, gates: ['explicit_author_opt_in', 'source_backed_readiness'] },
    { id: 'storyart', title: 'StoryArt partner task', available: true, gates: [] }
  ]
};

test('normalizes real runtime workflow fields and keeps explicit opt-in modes visible', () => {
  const view = buildWorkflowViewModel(normalizedStatusFixture);
  assert.equal(view.contractVersion, '1');
  assert.equal(view.skills.length, 4);
  assert.equal(view.skills.some(item => item.title === 'Production input'), false);
  assert.equal(view.skills.find(item => item.id.includes('google-writing-workspace')).availability, 'unknown');
  assert.equal(view.scenarios.length, 10);
  assert.equal(view.scenarios.find(item => item.id === 'storyart').availability, 'available');
  assert.equal(scenarioCanRun(view.scenarios.find(item => item.id === 'storyart')), true);
  assert.equal(view.scenarios.find(item => item.id === 'calibration').optIn, true);
  assert.equal(view.scenarios.find(item => item.id === 'roleplay').optIn, true);
  assert.equal(scenarioCanRun(view.scenarios.find(item => item.id === 'ordinary_writing')), true);
  assert.equal(scenarioCanRun(view.scenarios.find(item => item.id === 'series_base')), false);
});

test('keeps only six recent actual delegations and preserves terminal errors/results', () => {
  const view = buildWorkflowViewModel(runtimeStatusFixture);
  assert.equal(view.delegations.length, 3);
  assert.equal(view.delegations.find(item => item.id === 'd-2').error, 'Review failed');
  assert.equal(view.delegations.find(item => item.id === 'd-3').result, 'Done');
  assert.equal(delegationStatusLabel('cancelled'), 'Остановлено');
  assert.equal(delegationStatusLabel('new-runtime-state'), 'Состояние обновлено');
});

test('missing and unknown status fields stay safe and do not claim availability', () => {
  const view = buildWorkflowViewModel({ scenarios: [{ id: 'future-mode', title: 'Future', gates: ['setup'] }] });
  assert.equal(view.skills.length, 0);
  assert.equal(view.scenarios[0].availability, 'unknown');
  assert.equal(scenarioCanRun(view.scenarios[0]), false);
  assert.equal(availabilityLabel('unknown'), 'Статус уточняется');
  assert.deepEqual(buildWorkflowViewModel(null), { contractVersion: '', skills: [], scenarios: [], delegations: [] });
});

test('message mode is sent explicitly and optional review text appears only after opt-in', () => {
  assert.deepEqual(buildAgentMessagePayload('Продолжи сцену', 'continuation'), { text: 'Продолжи сцену', mode: 'continuation' });
  assert.deepEqual(buildAgentMessagePayload('Привет', ''), { text: 'Привет' });
  const withReview = buildAgentMessagePayload('Проверь текст', 'knowledge_audit', true);
  assert.equal(withReview.mode, 'knowledge_audit');
  assert.match(withReview.text, /Отдельная просьба: после ответа проведи одну независимую проверку/);
  assert.equal(buildAgentMessagePayload('Проверь текст', 'knowledge_audit').text, 'Проверь текст');
});

test('agent controls remain native keyboard-accessible controls with opt-in review text', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /<label class="scenario-label" for="agent-mode">/);
  assert.match(html, /<select id="agent-mode" aria-describedby="agent-mode-help"/);
  assert.match(html, /<input id="review-request" type="checkbox">/);
  assert.match(html, /Отправьте сообщение, чтобы начать/);
  assert.match(html, /aria-live="polite"/);
  assert.match(app, /canWriteSheets === true/);
  assert.match(app, /renderStoryArtRequests/);
  assert.doesNotMatch(app, /StoryArt и его файлы не подключены/);
});
