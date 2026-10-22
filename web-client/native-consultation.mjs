import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const MODEL = 'gemini-3.8-flash-high';
const MAX_TASK = 64 * 1024;
const MAX_REQUIREMENTS = 64 * 1024;
const MAX_INPUT = 256 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const ADAPTER_TIMEOUT_SECONDS = 180;
// The adapter itself allows timeout + 15s for its native-process cleanup.
const STUCK_AFTER_MS = (ADAPTER_TIMEOUT_SECONDS + 20) * 1000;
const CHILD_ENV_ALLOWLIST = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA',
  'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'PYTHONUTF8', 'PYTHONIOENCODING'
]);

const HOST_OAUTH_CONFIG_KEYS = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_AGENT_CLIENT_ID', 'GOOGLE_AGENT_CLIENT_SECRET', 'GOOGLE_AGENT_REDIRECT_URI']);

function checkHostEnvironment() {
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    // Exact application OAuth configuration is never forwarded by childEnvironment.
    // It is not a model credential; all other provider/API variables still fail closed.
    if (HOST_OAUTH_CONFIG_KEYS.has(upper)) continue;
    const unsafe = ['API_KEY', 'APIKEY', 'ACCESS_TOKEN', 'AUTH_TOKEN', 'BASE_URL', 'BASEURL', 'PROXY', 'VERTEX'].some(part => upper.includes(part)) ||
      ['GEMINI_', 'GOOGLE_', 'ANTHROPIC_', 'OPENAI_', 'AGY_'].some(prefix => upper.startsWith(prefix));
    if (value && unsafe) throw new Error('Native consultation refused because API, provider, credential, or proxy environment is present.');
  }
}

function childEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (CHILD_ENV_ALLOWLIST.has(name.toUpperCase()) && value !== undefined) env[name] = value;
  }
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

function utf8Size(value, name, limit, { required = false } = {}) {
  if (typeof value !== 'string' || (required && !value.trim())) throw new TypeError(`${name} must be ${required ? 'nonempty ' : ''}text.`);
  const size = Buffer.byteLength(value, 'utf8');
  if (size > limit) throw new RangeError(`${name} exceeds ${limit} UTF-8 bytes.`);
  return size;
}

function safeReceipt(result, packetSha256) {
  return {
    status: 'SUCCESS',
    observed_model: result.observed_model,
    observed_agent: result.observed_agent,
    observed_permission_mode: result.observed_permission_mode,
    requested_mode: result.requested_mode,
    local_useG1Credits: false,
    packet_sha256: packetSha256
  };
}

function parseAdapterResult(raw) {
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new Error('Native consultation returned invalid adapter JSON.'); }
  const result = envelope?.structuredContent;
  if (envelope?.isError !== false || !result || typeof result !== 'object') {
    throw new Error(typeof result?.error === 'string' ? result.error : 'Native consultation failed; no retry or fallback was attempted.');
  }
  if (result.observed_model !== MODEL || result.observed_agent !== 'codex-gemini-review' ||
      result.requested_mode !== 'plan' || result.observed_permission_mode !== 'request-review') {
    throw new Error('Native consultation metadata did not verify the required model, agent, plan mode, and request-review permission.');
  }
  if (typeof result.response !== 'string' || !result.response.trim()) throw new Error('Native consultation has no verified response.');
  return result;
}

export function createNativeConsultationService({
  dataDir,
  pythonExecutable,
  adapterPath = join(homedir(), '.codex', 'tools', 'gemini-agy', 'adapter.py'),
  spawnImpl = nodeSpawn,
  execFileImpl
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required.');
  if (typeof pythonExecutable !== 'string' || !pythonExecutable) throw new TypeError('pythonExecutable is required.');
  if (execFileImpl) throw new TypeError('execFileImpl is not supported: inject spawnImpl so cancellation cannot kill the adapter before native cleanup.');
  const baseDir = resolve(dataDir, 'consultations');
  let active = null;

  async function status() {
    let adapterInstalled = false;
    try { adapterInstalled = (await stat(adapterPath)).isFile(); } catch { /* Presence only; auth and model readiness are not checked here. */ }
    const job = active;
    return {
      adapterInstalled,
      busy: Boolean(job),
      running: Boolean(job?.child && !job.exited),
      cancelRequested: Boolean(job?.cancelRequested),
      cleanupPending: Boolean(job?.child && !job.exited),
      stuck: Boolean(job?.stuck)
    };
  }

  function executeAdapter(args, options, job) {
    return new Promise((resolveRun, rejectRun) => {
      let child;
      let outputBytes = 0;
      let spawnError = null;
      try {
        child = spawnImpl(pythonExecutable, [adapterPath, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        job.child = child;
      } catch {
        job.exited = true;
        rejectRun(new Error('Could not start native consultation adapter.'));
        return;
      }
      const countOutput = chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT) job.outputExceeded = true;
        // Keep draining both pipes after the bound; stopping Python here could release its
        // Windows settings guard while the native descendant is still running.
      };
      child.stdout?.on('data', countOutput);
      child.stderr?.on('data', countOutput);
      child.once('error', () => { spawnError = new Error('Could not start native consultation adapter.'); });
      child.once('close', (code, signal) => {
        job.exited = true;
        clearTimeout(job.stuckTimer);
        if (spawnError) return rejectRun(spawnError);
        resolveRun({ code, signal, outputExceeded: job.outputExceeded });
      });
      job.stuckTimer = setTimeout(() => {
        if (!job.exited) job.stuck = true;
      }, STUCK_AFTER_MS);
      job.stuckTimer.unref?.();
    });
  }

  async function analyze({ task, requirements = '', input = '', mode = 'analyze' } = {}) {
    if (active) throw new Error('A native consultation is already running; concurrent consultations are not allowed.');
    if (!['requirements', 'analyze', 'review'].includes(mode)) throw new TypeError('mode must be requirements, analyze, or review.');
    utf8Size(task, 'task', MAX_TASK, { required: true });
    utf8Size(requirements, 'requirements', MAX_REQUIREMENTS);
    utf8Size(input, 'input', MAX_INPUT);
    if (mode !== 'requirements' && !input.trim()) throw new TypeError('Evidence modes require nonempty input.');
    if (mode === 'requirements' && input.trim()) throw new TypeError('Requirements mode does not accept evidence input; use analyze or review.');
    checkHostEnvironment();

    let resolveIdle;
    const idlePromise = new Promise(resolveIdlePromise => { resolveIdle = resolveIdlePromise; });
    const job = { child: null, exited: false, cancelRequested: false, outputExceeded: false, stuck: false, idlePromise, resolveIdle };
    active = job;
    const jobDir = join(baseDir, randomUUID());
    const packetBytes = Buffer.from(input, 'utf8');
    const packetSha256 = createHash('sha256').update(packetBytes).digest('hex');
    const packetPath = join(jobDir, 'packet.md');
    const resultPath = join(jobDir, 'result.json');
    const requestPath = join(jobDir, 'request.json');
    const request = { mode, task, requirements, workspace: jobDir, timeout: ADAPTER_TIMEOUT_SECONDS };
    if (mode !== 'requirements') request.files = ['packet.md'];
    let jobReal;
    try {
      await mkdir(baseDir, { recursive: true });
      await mkdir(jobDir, { recursive: false });
      await writeFile(packetPath, packetBytes, { flag: 'wx' });
      await writeFile(requestPath, JSON.stringify(request), { flag: 'wx' });
      jobReal = await realpath(jobDir);
      if (jobReal !== resolve(jobDir) || !jobReal.startsWith(baseDir + sep)) throw new Error('Consultation job directory escaped its configured data directory.');
      if (job.cancelRequested) throw new Error('Native consultation was cancelled before the adapter started.');
      const processResult = await executeAdapter(['--request', requestPath, '--output', resultPath], {
        shell: false, windowsHide: true, cwd: jobReal, env: childEnvironment()
      }, job);
      if (job.cancelRequested) throw new Error('Native consultation was cancelled; late adapter result discarded.');
      if (processResult.outputExceeded) throw new Error('Native consultation adapter output exceeded the bound; result discarded after adapter exit.');
      if (processResult.code !== 0 && processResult.code !== 1) throw new Error(`Native consultation adapter exited with code ${processResult.code ?? 'unknown'}${processResult.signal ? ` (${processResult.signal})` : ''}.`);
      const resultStat = await stat(resultPath);
      if (!resultStat.isFile() || resultStat.size > MAX_OUTPUT) throw new Error('Native consultation result exceeded the output bound.');
      const result = parseAdapterResult(await readFile(resultPath, 'utf8'));
      const afterHash = createHash('sha256').update(await readFile(packetPath)).digest('hex');
      if (afterHash !== packetSha256) throw new Error('Consultation packet changed during analysis; result is stale.');
      const receipt = safeReceipt(result, packetSha256);
      await writeFile(join(jobReal, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
      return { response: result.response, receipt };
    } catch (error) {
      if (jobReal) {
        const message = job.cancelRequested ? 'Native consultation cancelled; response discarded after adapter exit.' : String(error?.message || 'Native consultation failed.').slice(0, 500);
        try { await writeFile(join(jobReal, 'receipt.json'), JSON.stringify({ status: 'ERROR', error: message }, null, 2), { flag: 'wx' }); } catch { /* Existing success receipt or an unwritable job directory. */ }
      }
      throw error;
    } finally {
      clearTimeout(job.stuckTimer);
      if (active === job) active = null;
      job.resolveIdle();
    }
  }

  async function stop() {
    const job = active;
    if (!job) return { cancelRequested: false, stopped: false, cleanupPending: false, reason: 'No consultation is running.' };
    job.cancelRequested = true;
    return {
      cancelRequested: true,
      stopped: false,
      cleanupPending: Boolean(job.child && !job.exited),
      reason: job.child && !job.exited
        ? 'The adapter is left running to finish its native-process and settings-guard cleanup; its eventual result will be discarded.'
        : 'Cancellation is recorded; the adapter has not started and will not be launched.'
    };
  }

  async function waitForIdle() {
    const job = active;
    if (job) await job.idlePromise;
  }

  return { status, analyze, stop, waitForIdle };
}
