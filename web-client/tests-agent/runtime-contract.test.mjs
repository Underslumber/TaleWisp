import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntimeContract } from '../runtime-contract.mjs';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function write(root, relative, text) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  return target;
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'talewisp-runtime-contract-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const projectRoot = path.join(temp, 'project');
  const codexRoot = path.join(temp, '.codex');
  await mkdir(projectRoot, { recursive: true });
  const linkToRef = [
    '[Operational reference](references/route.md)',
    ...['production-input.md', 'agent-routing.md', 'continuity-contract.md', 'onboarding.md', 'roleplay-mode.md', 'roleplay-dramaturgy.md', 'style-calibration.md', 'style-evaluation.md'].map((name) => `[${name}](references/${name})`),
  ].join('\n');
  await write(projectRoot, 'AGENTS.md', '# Project AGENTS\nOnly this project rule.\n');
  await write(projectRoot, 'plugin/skills/write-fiction/SKILL.md', `---\nname: write-fiction\ndescription: Writing skill fixture.\n---\n# Writing skill\n${linkToRef}\n`);
  await write(projectRoot, 'plugin/skills/write-fiction/references/route.md', '# Route\nExact route text.\n');
  const writingRefs = ['production-input.md', 'agent-routing.md', 'continuity-contract.md', 'onboarding.md', 'roleplay-mode.md', 'roleplay-dramaturgy.md', 'style-calibration.md', 'style-evaluation.md'];
  for (const reference of writingRefs) await write(projectRoot, `plugin/skills/write-fiction/references/${reference}`, `# ${reference}\n`);
  await write(projectRoot, 'plugin/skills/build-series-base/SKILL.md', `---\nname: build-series-base\ndescription: Base skill fixture.\n---\n# Base skill\n${['source-inputs.md', 'process.md', 'analysis-schema.md'].map((name) => `[${name}](references/${name})`).join('\n')}\n`);
  for (const reference of ['source-inputs.md', 'process.md', 'analysis-schema.md']) await write(projectRoot, `plugin/skills/build-series-base/references/${reference}`, `# ${reference}\n`);
  await write(projectRoot, 'plugin/skills/google-writing-workspace/SKILL.md', `---\nname: google-writing-workspace\ndescription: Google skill fixture.\n---\n# Google skill\n${['context.md', 'capabilities.md', 'acceptance.md'].map((name) => `[${name}](references/${name})`).join('\n')}\n`);
  for (const reference of ['context.md', 'capabilities.md', 'acceptance.md']) await write(projectRoot, `plugin/skills/google-writing-workspace/references/${reference}`, `# ${reference}\n`);
  await write(projectRoot, 'plugin/skills/coordinate-talewisp-storyart/SKILL.md', '---\nname: coordinate-talewisp-storyart\ndescription: StoryArt skill fixture.\n---\n# StoryArt skill\n[Persistent links](references/persistent-links.md)\n');
  await write(projectRoot, 'plugin/skills/coordinate-talewisp-storyart/references/persistent-links.md', '# Persistent links\n');
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const editorProtocol = await readFile(path.join(moduleRoot, 'runtime-policy', 'editor-protocol.md'), 'utf8');
  await write(projectRoot, 'vault/99_Служебное/Редакторский протокол.md', editorProtocol);
  const globalInstructionsPath = await write(codexRoot, 'AGENTS.md', '# Global rules\nC:\\Users\\private-user\\.codex\\settings.md\n');
  await write(codexRoot, 'policies/orchestration.md', '# Orchestration\n');
  await write(codexRoot, 'skills/gemini-review-handoff/SKILL.md', '# Gemini handoff\n');
  return { temp, projectRoot, codexRoot, globalInstructionsPath };
}

test('builds a source-hashed contract with full linked resource text and exact allowlist reads', async (t) => {
  const f = await fixture(t);
  const contract = await createRuntimeContract(f);
  assert.ok(contract.resources.some((item) => item.id === 'project/AGENTS.md'));
  assert.deepEqual(contract.skills.map((skill) => skill.name), ['write-fiction', 'build-series-base', 'google-writing-workspace', 'coordinate-talewisp-storyart']);
  assert.ok(contract.instructions.includes('## Bundled skill entry metadata'));
  const routeId = 'project/plugins/talewisp/skills/write-fiction/references/route.md';
  const routeSource = await readFile(path.join(f.projectRoot, 'plugin/skills/write-fiction/references/route.md'), 'utf8');
  assert.equal(contract.readResource(routeId), routeSource);
  const entry = contract.resources.find((item) => item.id === 'project/plugins/talewisp/skills/write-fiction/SKILL.md');
  assert.equal(entry.sourceHash, sha256(await readFile(path.join(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md'))));
  for (const resource of contract.resources.filter((item) => item.id.startsWith('project/') && item.id !== 'project/editor-protocol-public')) {
    const source = await readFile(path.join(f.projectRoot, resource.origin), 'utf8');
    assert.equal(contract.readResource(resource.id), source, `source text mismatch for ${resource.id}`);
  }
  assert.ok(contract.resources.some((item) => item.id === routeId));
  const editorProtocolSource = await readFile(path.join(f.projectRoot, 'vault/99_Служебное/Редакторский протокол.md'));
  const editorProtocolResource = contract.resources.find((item) => item.id === 'project/editor-protocol-public');
  const editorProtocolText = contract.readResource('project/editor-protocol-public');
  assert.equal(editorProtocolResource.sourceHash, sha256(editorProtocolSource));
  assert.equal(editorProtocolResource.hash, sha256(Buffer.from(editorProtocolText)));
  assert.equal(editorProtocolResource.derived, false);
  assert.equal(editorProtocolText, editorProtocolSource.toString('utf8'));
  for (const heading of ['## Универсальная граница', '## Контекстный снимок перед правкой', '## Проверка смыслонесущих переходов', '## Запреты при редактировании', '## Работа с авторским комментарием']) {
    assert.ok(editorProtocolText.includes(heading), `full editor protocol is missing ${heading}`);
  }
  assert.ok(!contract.instructions.includes('C:\\Users\\private-user'));
  assert.ok(contract.instructions.includes('{USER_HOME}'));
  assert.throws(() => contract.readResource('vault/00 Автор/Writer/series.md'), /Unknown or disallowed/);
  assert.throws(() => contract.readResource('../AGENTS.md'), /Unknown or disallowed/);
});

test('includes the required TaleWisp skill closure and exact scenario resource IDs', async (t) => {
  const f = await fixture(t);
  const contract = await createRuntimeContract(f);
  const ids = new Set(contract.resources.map((resource) => resource.id));
  for (const id of [
    'project/plugins/talewisp/skills/write-fiction/SKILL.md',
    'project/plugins/talewisp/skills/build-series-base/SKILL.md',
    'project/plugins/talewisp/skills/google-writing-workspace/SKILL.md',
    'project/skills/coordinate-talewisp-storyart/SKILL.md',
    'project/editor-protocol-public',
  ]) assert.ok(ids.has(id), `missing required resource ${id}`);
  for (const scenario of Object.values(contract.scenarios)) {
    for (const id of scenario.resources ?? []) assert.ok(ids.has(id), `scenario references a non-allowlisted ID: ${id}`);
  }
  assert.equal(contract.scenarios.ordinary_writing.maxWriterCalls, 1);
  assert.match(contract.scenarios.ordinary_writing.reviewer, /conditional/);
  assert.equal(contract.scenarios.roleplay.default, false);
  assert.equal(contract.scenarios.calibration.default, false);
  assert.equal(contract.roles.style_editor.writes, 'read-only');
  assert.equal(contract.roles.continuity_reviewer.writes, 'read-only');
  assert.equal(contract.roles.sol_review.defaultDispatchable, false);
  assert.deepEqual(contract.dependencies.googleNativeTools.capability, 'not_checked');
});

test('loads a declared onboarding resource even when the skill entry does not link it', async (t) => {
  const f = await fixture(t);
  const skillPath = path.join(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md');
  const skillText = await readFile(skillPath, 'utf8');
  await write(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md', skillText.replace('[onboarding.md](references/onboarding.md)\n', ''));
  const onboardingPath = path.join(f.projectRoot, 'plugin/skills/write-fiction/references/onboarding.md');
  const onboardingText = await readFile(onboardingPath, 'utf8');
  const contract = await createRuntimeContract(f);
  const onboardingId = 'project/plugins/talewisp/skills/write-fiction/references/onboarding.md';
  const resource = contract.resources.find((item) => item.id === onboardingId);
  assert.ok(resource, 'the scenario-declared onboarding resource is present in the contract');
  assert.equal(resource.sourceHash, sha256(onboardingText));
  assert.equal(contract.readResource(onboardingId), onboardingText);

  await rm(onboardingPath);
  await assert.rejects(createRuntimeContract(f), /Missing runtime resource.*onboarding\.md/);
});

test('contract version changes when a linked source changes and accepts live host capability evidence', async (t) => {
  const f = await fixture(t);
  const first = await createRuntimeContract({ ...f, hostCapabilities: { googleNativeTools: 'available', subagentDispatch: 'available' } });
  await write(f.projectRoot, 'plugin/skills/write-fiction/references/route.md', '# Route\nChanged operational text.\n');
  const second = await createRuntimeContract({ ...f, hostCapabilities: { googleNativeTools: 'available', subagentDispatch: 'available' } });
  assert.notEqual(first.version, second.version);
  assert.equal(second.dependencies.googleNativeTools.capability, 'available');
  assert.equal(second.dependencies.subagentDispatch.capability, 'available');
});

test('uses exact bundled policy snapshots when the server user has no .codex AGENTS.md', async (t) => {
  const f = await fixture(t);
  const { globalInstructionsPath: _explicitOverride, ...projectOptions } = f;
  const contract = await createRuntimeContract({ ...projectOptions, userHomeDirectory: path.join(f.temp, 'server-user') });
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = [
    ['host/global/AGENTS.md', path.join(moduleRoot, 'runtime-policy', 'AGENTS.md')],
    ['host/policies/orchestration.md', path.join(moduleRoot, 'runtime-policy', 'policies', 'orchestration.md')],
    ['host/skills/gemini-review-handoff/SKILL.md', path.join(moduleRoot, 'runtime-policy', 'skills', 'gemini-review-handoff', 'SKILL.md')],
  ];
  for (const [id, sourcePath] of bundled) {
    const raw = await readFile(sourcePath);
    const resource = contract.resources.find((item) => item.id === id);
    assert.equal(resource.provenance, 'portable_snapshot');
    assert.equal(resource.sourceHash, sha256(raw));
    assert.equal(contract.readResource(id), raw.toString('utf8').replace(/C:\\Users\\[^\\\s`"'<>]+/gi, '{USER_HOME}'));
  }
  assert.match(contract.readResource('host/global/AGENTS.md'), /gpt-6-luna/);
  assert.match(contract.readResource('host/policies/orchestration.md'), /orchestration/i);
  assert.match(contract.readResource('host/skills/gemini-review-handoff/SKILL.md'), /gemini/i);
  assert.equal(contract.dependencies.googleOperationalSkills.capability, 'unavailable');
  assert.match(contract.dependencies.googleOperationalSkills.reason, /missing/);
});

test('uses the exact bundled editor protocol when the project vault is absent', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.projectRoot, 'vault', '99_Служебное', 'Редакторский протокол.md'));
  const contract = await createRuntimeContract(f);
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = await readFile(path.join(moduleRoot, 'runtime-policy', 'editor-protocol.md'));
  const resource = contract.resources.find((item) => item.id === 'project/editor-protocol-public');
  assert.equal(resource.provenance, 'portable_snapshot');
  assert.equal(resource.origin, 'runtime-policy/editor-protocol.md');
  assert.equal(resource.sourceHash, sha256(bundled));
  assert.equal(resource.derived, false);
  assert.equal(contract.readResource(resource.id), bundled.toString('utf8'));
});

test('fails on missing linked resources and references outside operational roots', async (t) => {
  const f = await fixture(t);
  await write(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md', '# Writing\n[Missing](references/not-installed.md)\n');
  await assert.rejects(createRuntimeContract(f), /Missing runtime resource.*not-installed\.md/);

  await write(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md', '# Writing\n[Outside](../../../../private.md)\n');
  await write(f.projectRoot, 'private.md', 'private data');
  await assert.rejects(createRuntimeContract(f), /outside configured operational roots|escapes project allowlist/);
});

test('refuses oversized linked resources without truncating them', async (t) => {
  const f = await fixture(t);
  await write(f.projectRoot, 'plugin/skills/write-fiction/SKILL.md', '# Writing\n[Large](references/large.md)\n');
  await write(f.projectRoot, 'plugin/skills/write-fiction/references/large.md', 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(createRuntimeContract(f), /exceeds 131072 bytes; refusing truncation/);
});

test('runtime instructions prescribe the host loader and delegation schema without claiming integrations', async (t) => {
  const f = await fixture(t);
  const contract = await createRuntimeContract(f);
  assert.match(contract.ROOT_WORKFLOW_INSTRUCTIONS, /talewisp_runtime_resource/);
  assert.match(contract.ROOT_WORKFLOW_INSTRUCTIONS, /\{ role, task, input, maxOutputChars \}/);
  assert.match(contract.ROOT_WORKFLOW_INSTRUCTIONS, /Google actions require the corresponding connector and scope/);
  assert.match(contract.ROOT_WORKFLOW_INSTRUCTIONS, /StoryArt requires its dedicated-task transport/);
  assert.match(contract.ROOT_WORKFLOW_INSTRUCTIONS, /Skill presence is not a capability signal/i);
});
