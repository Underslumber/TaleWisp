// Creates neutral stand-ins for files the test suite expects but that are private to the
// author's machine and therefore not in git. Existing files are never overwritten.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webClient = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(webClient, '..');
const files = new Map([
  [join(project, 'AGENTS.md'), '# Project rules (test fixture)\n\nWork only inside this repository. Keep author data private.\n'],
  [join(webClient, 'runtime-policy', 'AGENTS.md'), '# Global rules (test fixture)\n\nFollow the current direct user request first. Default model for delegated work: gpt-6-luna.\n'],
  [join(webClient, 'runtime-policy', 'editor-protocol.md'), '# Editor protocol (test fixture)\n\n' + ['Универсальная граница', 'Контекстный снимок перед правкой', 'Проверка смыслонесущих переходов', 'Запреты при редактировании', 'Работа с авторским комментарием'].map(title => `## ${title}\n\nTest fixture section.\n`).join('\n')],
  [join(webClient, 'runtime-policy', 'policies', 'orchestration.md'), '# Orchestration (test fixture)\n\nDelegate only through the host.\n'],
  [join(webClient, 'runtime-policy', 'skills', 'gemini-review-handoff', 'SKILL.md'), '---\nname: gemini-review-handoff\ndescription: Test fixture for the review handoff skill.\n---\n\n# Review handoff (test fixture)\n'],
]);
// Scratch directory the agent-import tests create their temporary folders in; it is git-ignored.
mkdirSync(join(project, '.agent'), { recursive: true });
// The living world tests resolve the same folder from the web-client working directory.
mkdirSync(join(project, 'web-client', '.agent'), { recursive: true });
let created = 0;
for (const [file, text] of files) {
  if (existsSync(file)) continue;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
  created += 1;
  console.log(`created ${file}`);
}
console.log(created ? `Prepared ${created} test fixture file(s).` : 'All fixture files already exist; nothing changed.');
