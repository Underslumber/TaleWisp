import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execute = promisify(execFile);
export async function resolveRuntimeModel({ projectRoot, pythonExecutable = 'python', executeImpl = execute, route = 'ordinary' }) {
  // The author's current global routing explicitly authorizes Luna/high once for
  // ordinary delegates. The authoritative resolver must still run before launch.
  if (!['ordinary','sol_review'].includes(route)) throw new Error('Unsupported host model route.');
  const model = route === 'sol_review' ? 'gpt-6.1-sol' : 'gpt-6-luna';
  const effort = route === 'sol_review' ? 'medium' : 'high';
  const { stdout } = await executeImpl(pythonExecutable, [
    join(projectRoot, 'plugin', 'scripts', 'model_selection.py'),
    '--project-root', projectRoot, '--model', model, '--effort', effort, '--choice', 'once'
  ], { cwd: projectRoot, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 128_000 });
  let result; try { result = JSON.parse(stdout); } catch { throw new Error('TaleWisp model resolver returned invalid JSON.'); }
  if (result.ready !== true || result.scope !== 'once' || result.selection?.model !== model || result.selection?.effort !== effort) {
    throw new Error('TaleWisp model selection is unresolved or differs from the authorized host role route.');
  }
  return { model: result.selection.model, effort: result.selection.effort, scope: result.scope, source: result.source };
}
