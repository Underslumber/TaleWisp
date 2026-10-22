import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeConsultationService } from '../native-consultation.mjs';

const nativeSuccess = response => ({
  isError: false,
  structuredContent: {
    response,
    observed_model: 'gemini-3.8-flash-high',
    observed_agent: 'codex-gemini-review',
    observed_permission_mode: 'request-review',
    requested_mode: 'plan'
  }
});

async function fixture(t, spawnImpl) {
  const root = await mkdtemp(join(tmpdir(), 'talewisp-native-consult-'));
  const dataDir = join(root, 'data');
  const adapterPath = join(root, 'adapter.py');
  await mkdir(dataDir);
  await writeFileSync(adapterPath, '# fixture only');
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, dataDir, adapterPath,
    service: createNativeConsultationService({ dataDir, pythonExecutable: 'fixture-python', adapterPath, spawnImpl })
  };
}

function fakeSpawn(log, { mutatePacket = false, result = nativeSuccess('Independent finding.'), exitCode = 0, hold = false } = {}) {
  return (executable, args, options) => {
    const requestIndex = args.indexOf('--request');
    const outputIndex = args.indexOf('--output');
    assert.deepEqual(args.slice(requestIndex, requestIndex + 1), ['--request']);
    assert.deepEqual(args.slice(outputIndex, outputIndex + 1), ['--output']);
    assert.equal(args.length, 5);
    const request = JSON.parse(readFileSync(args[requestIndex + 1], 'utf8'));
    log.push({ executable, args, options, request });
    assert.equal(request.timeout, 180);
    assert.ok(request.workspace.includes('consultations'));
    if (request.files) assert.deepEqual(request.files, ['packet.md']);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { throw new Error('adapter child must never be killed'); };
    log.at(-1).child = child;
    const complete = ({ lateResult = result, code = exitCode } = {}) => {
      const packetPath = join(request.workspace, 'packet.md');
      if (mutatePacket) writeFileSync(packetPath, 'tampered');
      writeFileSync(args[outputIndex + 1], JSON.stringify(lateResult));
      child.stdout.end(); child.stderr.end();
      child.emit('close', code, null);
    };
    log.at(-1).complete = complete;
    if (!hold) setImmediate(() => complete());
    return child;
  };
}

test('status reports adapter presence and live cleanup state without probing auth or starting a child', async t => {
  const calls = [];
  const { service, adapterPath } = await fixture(t, (...args) => { calls.push(args); return fakeSpawn(calls)(...args); });
  assert.deepEqual(await service.status(), { adapterInstalled: true, busy: false, running: false, cancelRequested: false, cleanupPending: false, stuck: false });
  assert.equal(calls.length, 0);
  const missing = createNativeConsultationService({ dataDir: join(tmpdir(), 'missing-consult'), pythonExecutable: 'unused', adapterPath: join(adapterPath, 'absent.py') });
  assert.equal((await missing.status()).adapterInstalled, false);
});

test('evidence consultation passes only its packet and returns a verified response with a small receipt', async t => {
  const calls = [];
  const { service, dataDir } = await fixture(t, fakeSpawn(calls));
  const input = 'Only this explicitly supplied evidence.';
  const result = await service.analyze({ task: 'Assess this evidence.', requirements: 'Report uncertainty.', input, mode: 'review', ignoredPath: 'C:\\private\\vault.md' });
  assert.equal(result.response, 'Independent finding.');
  assert.equal(result.receipt.observed_model, 'gemini-3.8-flash-high');
  assert.equal(result.receipt.local_useG1Credits, false);
  assert.equal(result.receipt.packet_sha256, createHash('sha256').update(input).digest('hex'));
  assert.equal('receiptPath' in result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, 'fixture-python');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.cwd.startsWith(join(dataDir, 'consultations')));
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  const jobDir = calls[0].options.cwd;
  assert.equal(await readFile(join(jobDir, 'packet.md'), 'utf8'), input);
  assert.deepEqual(JSON.parse(await readFile(join(jobDir, 'receipt.json'), 'utf8')), result.receipt);
  assert.equal((await stat(join(jobDir, 'request.json'))).isFile(), true);
});

test('requirements mode omits evidence paths; task and UTF-8 byte limits reject before invocation', async t => {
  const calls = [];
  const { service } = await fixture(t, fakeSpawn(calls));
  await service.analyze({ task: 'Review this requirement.', requirements: 'Keep all constraints.', mode: 'requirements' });
  assert.equal(calls[0].request.mode, 'requirements');
  assert.equal('files' in calls[0].request, false);
  await assert.rejects(service.analyze({ task: 'x'.repeat(64 * 1024 + 1), mode: 'requirements' }), /task exceeds/);
  await assert.rejects(service.analyze({ task: 'ok', mode: 'analyze' }), /nonempty/);
  await assert.rejects(service.analyze({ task: 'ok', input: 'ignored evidence', mode: 'requirements' }), /does not accept evidence/);
  assert.equal(calls.length, 1);
});

test('changed source and mismatched model metadata fail closed without a second invocation', async t => {
  const calls = [];
  const changed = await fixture(t, fakeSpawn(calls, { mutatePacket: true }));
  await assert.rejects(changed.service.analyze({ task: 'Review.', input: 'source', mode: 'analyze' }), /packet changed/);
  assert.equal(calls.length, 1);

  const badCalls = [];
  const badResult = nativeSuccess('Not accepted.');
  badResult.structuredContent.observed_model = 'other-model';
  const bad = await fixture(t, fakeSpawn(badCalls, { result: badResult }));
  await assert.rejects(bad.service.analyze({ task: 'Review.', input: 'source', mode: 'analyze' }), /metadata did not verify/);
  assert.equal(badCalls.length, 1);
});

test('adapter quota error is read from its single nonzero-exit envelope and receipt is retained', async t => {
  const calls = [];
  const { service } = await fixture(t, fakeSpawn(calls, { result: { isError: true, structuredContent: { error: 'quota gate failed' } }, exitCode: 1 }));
  await assert.rejects(service.analyze({ task: 'Review.', input: 'source', mode: 'analyze' }), /quota gate failed/);
  assert.equal(calls.length, 1);
  const receipt = JSON.parse(await readFile(join(calls[0].options.cwd, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'ERROR');
  assert.equal(receipt.error, 'quota gate failed');
});

test('stop marks cancellation, discards late results, and keeps the guard-owning adapter busy until close', async t => {
  const calls = [];
  const { service } = await fixture(t, fakeSpawn(calls, { hold: true }));
  const pending = service.analyze({ task: 'Review.', input: 'source', mode: 'analyze' });
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  const stopped = await service.stop();
  assert.deepEqual(stopped, {
    cancelRequested: true, stopped: false, cleanupPending: true,
    reason: 'The adapter is left running to finish its native-process and settings-guard cleanup; its eventual result will be discarded.'
  });
  assert.deepEqual(await service.status(), { adapterInstalled: true, busy: true, running: true, cancelRequested: true, cleanupPending: true, stuck: false });
  await assert.rejects(service.analyze({ task: 'Second.', input: 'source', mode: 'analyze' }), /already running/);
  let idleResolved = false;
  const idle = service.waitForIdle().then(() => { idleResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idleResolved, false);

  calls[0].complete({ lateResult: nativeSuccess('Late answer.') });
  await assert.rejects(pending, /cancelled; late adapter result discarded/);
  await idle;
  assert.equal(idleResolved, true);
  assert.equal((await service.status()).busy, false);
  const receipt = JSON.parse(await readFile(join(calls[0].options.cwd, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'ERROR');
  assert.match(receipt.error, /cancelled/);
});

test('output overflow is drained while adapter remains alive, then rejected only after exit', async t => {
  const calls = [];
  const { service } = await fixture(t, fakeSpawn(calls, { hold: true }));
  const pending = service.analyze({ task: 'Review.', input: 'source', mode: 'analyze' });
  while (calls.length === 0) await new Promise(resolve => setImmediate(resolve));
  const noisyChild = calls[0].options;
  // The fake child is reachable via its streams through the injected spawn result holder.
  // Emit an oversized chunk and prove the service does not terminate it before adapter close.
  const child = calls[0].child;
  child?.stdout.write(Buffer.alloc(1024 * 1024 + 1));
  assert.equal((await service.status()).cleanupPending, true);
  calls[0].complete();
  await assert.rejects(pending, /output exceeded the bound/);
  assert.ok(noisyChild.cwd);
});

test('full application OAuth configuration is withheld while model API variables fail before launch', async t => {
  const calls = [];
  const { service } = await fixture(t, fakeSpawn(calls));
  const oauthKeys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_AGENT_CLIENT_ID', 'GOOGLE_AGENT_CLIENT_SECRET', 'GOOGLE_AGENT_REDIRECT_URI'];
  const guardedKeys = ['OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  const before = Object.fromEntries([...oauthKeys, ...guardedKeys].map(key => [key, process.env[key]]));
  try {
    for (const key of oauthKeys) process.env[key] = 'synthetic-oauth-config';
    for (const key of guardedKeys) delete process.env[key];
    await service.analyze({ task: 'Review.', input: 'evidence', mode: 'analyze' });
    for (const key of oauthKeys) assert.equal(calls[0].options.env[key], undefined);
    assert.equal(calls[0].options.env.PYTHONUTF8, '1');
    for (const key of guardedKeys) {
      process.env[key] = 'must-not-pass';
      await assert.rejects(service.analyze({ task: 'Review.', input: 'evidence', mode: 'analyze' }), /environment is present/);
      delete process.env[key];
    }
    assert.equal(calls.length, 1);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('real Python subprocess receives adapterPath before CLI flags, including paths with spaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'talewisp native adapter smoke '));
  const dataDir = join(root, 'private data');
  const scriptDir = join(root, 'adapter path with spaces');
  await mkdir(dataDir);
  await mkdir(scriptDir);
  const adapterPath = join(scriptDir, 'fake adapter.py');
  const markerPath = join(root, 'invocation marker.json');
  const markerLiteral = JSON.stringify(markerPath);
  const script = `import json, pathlib, sys\nargs = sys.argv[1:]\nrequest_path = pathlib.Path(args[args.index('--request') + 1])\noutput_path = pathlib.Path(args[args.index('--output') + 1])\nrequest = json.loads(request_path.read_text(encoding='utf-8'))\nworkspace = pathlib.Path(request['workspace'])\npacket = (workspace / 'packet.md').read_text(encoding='utf-8')\nif packet != 'real python smoke packet': raise SystemExit(21)\nresult = {'isError': False, 'structuredContent': {'response': 'Synthetic Python adapter response.', 'observed_model': 'gemini-3.8-flash-high', 'observed_agent': 'codex-gemini-review', 'observed_permission_mode': 'request-review', 'requested_mode': 'plan'}}\noutput_path.write_text(json.dumps(result), encoding='utf-8')\npathlib.Path(${markerLiteral}).write_text(json.dumps({'file': str(pathlib.Path(__file__).resolve()), 'argv': sys.argv, 'request': request}), encoding='utf-8')\n`;
  await writeFile(adapterPath, script, 'utf8');
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createNativeConsultationService({ dataDir, pythonExecutable: 'python', adapterPath });
  const result = await service.analyze({ task: 'Exercise the Python boundary.', input: 'real python smoke packet', mode: 'analyze' });
  await service.waitForIdle();
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(result.response, 'Synthetic Python adapter response.');
  assert.equal(marker.file, adapterPath);
  assert.equal(marker.argv[0], adapterPath);
  assert.deepEqual(marker.argv.slice(1), ['--request', join(marker.request.workspace, 'request.json'), '--output', join(marker.request.workspace, 'result.json')]);
  assert.deepEqual(marker.request.files, ['packet.md']);
  assert.equal((await service.status()).busy, false);
});
