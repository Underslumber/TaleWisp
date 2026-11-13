// Run once from any directory with Node 24+ and npm on PATH.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let cwd = fileURLToPath(new URL('../vendor/worldx/server/', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Living world requires Node 24 or newer.');
function run(program, args) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' && program === 'npm' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json']);
cwd = fileURLToPath(new URL('../vendor/worldx/client/', import.meta.url));
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
run(process.execPath, [fileURLToPath(new URL('./build-living-world-stage.mjs', import.meta.url))]);
console.log('WorldX is ready for the Living world tab in TaleWisp.');
