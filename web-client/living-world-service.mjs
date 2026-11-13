import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, lstatSync, cpSync, renameSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importLivingWorld, validateStaging, worldError, hash } from './living-world-import.mjs';
import { projectWorld } from './living-world-projection.mjs';
import { createWorldApiSettings } from './living-world-api.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROJECT = resolve(HERE, '..'), VENDOR = join(PROJECT, 'vendor', 'worldx');
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, data) { const tmp = path + '.' + randomUUID() + '.tmp'; writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', flush: true }); renameSync(tmp, path); }
const scopeOf = s => JSON.stringify([s?.authorId ?? null, s?.seriesId ?? null, s?.bookId ?? null]);

export function createLivingWorldService({ dataDir, workspace, pythonExecutable = 'python', modelRunner = null }) {
  if (process.platform !== 'win32') return {
    async handle(method, path) { if (path.startsWith('/api/living-world')) throw worldError('Модуль «Живой мир» сейчас поддерживает Windows: остановка дерева модельных процессов проверена для этой среды.', 503); return null; },
    async close() {}, root: null,
  };
  const root = resolve(dataDir, 'living-world'), branches = join(root, 'branches'), imports = join(root, 'imports');
  mkdirSync(branches, { recursive: true }); mkdirSync(imports, { recursive: true });
  const apiSettings = createWorldApiSettings(root);
  if (lstatSync(root).isSymbolicLink() || lstatSync(branches).isSymbolicLink() || lstatSync(imports).isSymbolicLink()) throw worldError('Каталоги симуляции не могут быть ссылками.');
  const workers = new Map(), terminations = new Set(); let closed = false;
  function activeScope() {
    const selection = workspace.selection(); if (!selection?.seriesId) throw worldError('Выберите серию в основном пространстве.', 409);
    const canon = workspace.root(); if (canon && (root === realpathSync(canon) || root.startsWith(realpathSync(canon) + sep))) throw worldError('Данные симуляции нельзя хранить внутри канона.', 409);
    return scopeOf(selection);
  }
  function scoped(id) {
    if (!uuid(id)) throw worldError('Неизвестная ветка.', 404);
    const dir = join(branches, id), manifestFile = join(dir, 'manifest.json');
    if (!existsSync(manifestFile) || lstatSync(dir).isSymbolicLink()) throw worldError('Ветка не найдена.', 404);
    const manifest = read(manifestFile); if (manifest.scope !== activeScope()) throw worldError('Ветка относится к другому пространству.', 404);
    return { dir, manifest };
  }
  function current(dir, checkpoint) {
    const pointer = read(join(dir, 'current.json')), selected = checkpoint || pointer.checkpoint;
    if (!/^cp-\d{8}$/.test(selected) || !existsSync(join(dir, selected, 'state.json'))) throw worldError('Снимок не найден.', 404);
    return { pointer, checkpoint: selected, state: read(join(dir, selected, 'state.json')) };
  }
  function quota(dir) { return existsSync(join(dir, 'quota.json')) ? read(join(dir, 'quota.json')) : { limit: 0, used: 0 }; }
  function snapshot(id, options = {}) {
    const { dir, manifest } = scoped(id), { pointer, checkpoint, state } = current(dir, options.checkpoint), worker = workers.get(id);
    return { ...projectWorld(state, options.view || 'author', options.actorId || state.definition.heroId), checkpoint,
      currentCheckpoint: pointer.checkpoint, replay: checkpoint !== pointer.checkpoint, stateHash: hash(state),
      runtime: { running: !!worker?.running, busy: !!worker?.pending.size, error: worker?.error || null },
      quota: options.view === 'role' ? undefined : quota(dir),
      origin: manifest.parent || null, checkpoints: readdirSync(dir).filter(n => /^cp-\d{8}$/.test(n)).sort() };
  }
  function stopProcess(child) {
    if (!child || child.exitCode !== null) return Promise.resolve();
    const termination = new Promise(resolveExit => {
      const timer = setTimeout(resolveExit, 5000); timer.unref();
      child.once('close', () => { clearTimeout(timer); resolveExit(); });
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill());
    });
    terminations.add(termination); void termination.finally(() => terminations.delete(termination)); return termination;
  }
  function cancelModels(w) {
    w.cancelVersion++;
    return Promise.all([...w.modelProcesses].map(stopProcess));
  }
  async function runModel(w, message) {
    if (closed || w.dead || w.child.exitCode !== null) throw new Error('Процесс ветки уже остановлен.');
    const q = quota(w.dir);
    if (q.used >= q.limit) throw new Error('Лимит модельных вызовов исчерпан.');
    const provider = current(w.dir).state.provider || 'codex';
    if (provider === 'openai') {
      if (!apiSettings.status().configured) throw worldError('API-ключ не настроен.', 409);
      const reservation = apiSettings.reservation(message.packet);
      if ((q.apiReservedUsd || 0) + reservation > (q.apiLimitUsd || 0)) throw worldError('Локальный API-бюджет исчерпан.', 409);
      q.apiReservedUsd = (q.apiReservedUsd || 0) + reservation;
    }
    q.used++; save(join(w.dir, 'quota.json'), q);
    if (modelRunner) return modelRunner(message.packet);
    const inputs = join(w.dir, 'inputs'); mkdirSync(inputs, { recursive: true });
    const filename = message.id + '.json'; save(join(inputs, filename), message.packet);
    return new Promise((resolveModel, reject) => {
      const credential = provider === 'openai' ? apiSettings.credentials() : null;
      const modelEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', TALEWISP_WORLD_PROVIDER: provider };
      if (credential) { modelEnv.OPENAI_API_KEY = credential.apiKey; modelEnv.OPENAI_PROJECT_ID = credential.projectId; modelEnv.TALEWISP_API_MAX_OUTPUT = String(credential.maxOutputTokens); }
      const child = spawn(pythonExecutable, [join(HERE, 'living-world-model.py'), w.dir, filename], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: modelEnv });
      w.modelProcesses.add(child); let out = '', error = ''; const timer = setTimeout(() => { stopProcess(child); reject(new Error('Модель не ответила за отведённое время.')); }, 260000);
      child.stdout.on('data', b => { out += b; if (out.length > 2_000_000) stopProcess(child); }); child.stderr.on('data', b => { error = (error + b).slice(-2000); });
      child.on('error', reject); child.on('close', code => { clearTimeout(timer); w.modelProcesses.delete(child); try { const data = JSON.parse(out); if (code || data.error) throw new Error(data.error || error || 'Вызов модели не завершён.');
        if (provider === 'openai' && data.metadata?.usage) { const meter = quota(w.dir), usage = data.metadata.usage; meter.inputTokens = (meter.inputTokens || 0) + (usage.input_tokens || 0); meter.outputTokens = (meter.outputTokens || 0) + (usage.output_tokens || 0); meter.apiMeasuredUsd = meter.inputTokens * 2 / 1e6 + meter.outputTokens * 10 / 1e6; save(join(w.dir, 'quota.json'), meter); }
        resolveModel(data.result); } catch (e) { reject(e); } });
    });
  }
  async function workerFor(id) {
    if (closed) throw worldError('Модуль завершает работу.', 503);
    const { dir } = scoped(id); if (workers.has(id)) return workers.get(id).ready;
    const entry = join(HERE, 'living-world-worker.mjs');
    if (!existsSync(join(VENDOR, 'server', 'dist', 'simulation', 'simulation-engine.js'))) throw worldError('WorldX не собран. Выполните настройку модуля из этого checkout.', 503);
    const argv = ['--permission', '--allow-fs-read=' + VENDOR, '--allow-fs-read=' + entry, '--allow-fs-read=' + join(HERE, 'living-world-projection.mjs'), '--allow-fs-read=' + dir, '--allow-fs-write=' + dir, entry, dir];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA'].includes(key))); env.NODE_NO_WARNINGS = '1';
    const child = spawn(process.execPath, argv, { cwd: join(VENDOR, 'server'), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const w = { child, dir, pending: new Map(), modelProcesses: new Set(), running: false, dead: false, error: null, modelQueue: Promise.resolve(), cancelVersion: 0 };
    child.stdin.on('error', () => {});
    workers.set(id, w);
    w.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => { stopProcess(child); rejectReady(new Error('WorldX не подтвердил запуск.')); }, 15000);
      const lines = createInterface({ input: child.stdout }); let diagnostic = '';
      child.stderr.on('data', b => { diagnostic = (diagnostic + b).slice(-5000); });
      lines.on('line', line => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'ready') { clearTimeout(timer); resolveReady(w); }
        else if (m.type === 'cancelModels') { void cancelModels(w); }
        else if (m.type === 'model') {
          const epoch = w.cancelVersion;
          w.modelQueue = w.modelQueue.then(async () => { try { if (closed || w.dead || epoch !== w.cancelVersion) throw new Error('Вызов отменён.'); const result = await runModel(w, m); if (!w.dead && child.exitCode === null && child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'modelResult', id: m.id, result }) + '\n'); } catch (e) { if (!w.dead && child.exitCode === null && child.stdin.writable) child.stdin.write(JSON.stringify({ type: 'modelResult', id: m.id, error: e.message }) + '\n'); } });
        } else {
          const p = w.pending.get(m.id); if (p) { w.pending.delete(m.id); m.error ? p.reject(worldError(m.error, m.status || 409)) : p.resolve(m.result); }
        }
      });
      child.on('error', e => { clearTimeout(timer); rejectReady(e); });
      child.on('exit', () => { clearTimeout(timer); w.running = false; w.dead = true; void cancelModels(w); w.error = diagnostic || 'Процесс WorldX завершён. Последний checkpoint сохранён.'; for (const p of w.pending.values()) p.reject(new Error(w.error)); w.pending.clear(); if (workers.get(id) === w) workers.delete(id); rejectReady(new Error(w.error)); });
    });
    return w.ready;
  }
  async function command(id, body) {
    const w = await workerFor(id);
    if (!body || !uuid(body.requestId) || !Number.isInteger(body.expectedRevision) || !['initialize', 'step', 'queueIntent', 'configure', 'intervene', 'scheduleEvent', 'checkpoint'].includes(body.operation)) throw worldError('Недопустимая команда ветки.');
    if (body.operation === 'configure') {
      const requested = body.args?.modelLimit;
      if (!Number.isInteger(requested) || requested < 0 || requested > 40) throw worldError('Лимит должен быть от 0 до 40 вызовов.');
      const provider = body.args.provider || 'codex', apiBudget = body.args.apiBudgetUsd ?? 0;
      if (!['codex', 'openai'].includes(provider) || !Number.isFinite(apiBudget) || apiBudget < 0 || apiBudget > 1000) throw worldError('Неверный вариант модели или API-бюджет.');
      if (provider === 'openai' && !apiSettings.status().configured) throw worldError('Сначала подключите API-ключ в настройках «Живого мира».', 409);
      // Quota is granted explicitly by this author command; failed attempts still consume it.
      const response = await sendCommand(w, id, body); if (!response.duplicate) { const q = quota(w.dir); save(join(w.dir, 'quota.json'), { ...q, limit: q.used + requested, apiLimitUsd: (q.apiReservedUsd || 0) + apiBudget }); } return response;
    }
    return sendCommand(w, id, body);
  }
  function sendCommand(w, id, body) { return new Promise((resolveCommand, reject) => { if (w.child.exitCode !== null || !w.child.stdin.writable) return reject(new Error('Процесс ветки недоступен.')); const rid = randomUUID(); w.pending.set(rid, { resolve: resolveCommand, reject }); w.child.stdin.write(JSON.stringify({ ...body, branchId: id, id: rid }) + '\n'); }); }
  function list() {
    const scope = activeScope();
    return readdirSync(branches).filter(uuid).flatMap(id => { const dir = join(branches, id); if (!existsSync(join(dir, 'manifest.json')) || lstatSync(dir).isSymbolicLink()) return []; const m = read(join(dir, 'manifest.json')); if (m.scope !== scope) return []; const p = existsSync(join(dir, 'current.json')) ? read(join(dir, 'current.json')) : null; return [{ id, name: m.name, revision: p?.revision ?? null, createdAt: m.createdAt, parent: m.parent || null }]; });
  }
  async function createBranch(importId, setup, approved) {
    if (!uuid(importId) || !existsSync(join(imports, importId + '.json'))) throw worldError('Снимок импорта не найден.', 404);
    const imported = read(join(imports, importId + '.json')); if (imported.scope !== activeScope()) throw worldError('Снимок относится к другой серии.', 404);
    if (approved !== true) throw worldError('Постановка должна быть подтверждена автором.', 409);
    const definition = validateStaging(setup), id = randomUUID(), dir = join(branches, id); mkdirSync(dir);
    save(join(dir, 'manifest.json'), { id, scope: imported.scope, importId, name: definition.name, createdAt: new Date().toISOString(), engine: 'WorldX', engineCommit: 'edb4976de5963457dfbf5d2171355270a4ca1e79' });
    await command(id, { expectedRevision: 0, requestId: randomUUID(), operation: 'initialize', args: { definition, importHash: imported.fingerprint } });
    return snapshot(id);
  }
  async function fork(id, checkpoint, name) {
    const { dir, manifest } = scoped(id), selected = current(dir, checkpoint), nextId = randomUUID(), target = join(branches, nextId); mkdirSync(target);
    const cp = 'cp-00000000'; cpSync(join(dir, selected.checkpoint), join(target, cp), { recursive: true });
    const state = read(join(target, cp, 'state.json')); state.branchId = nextId; state.revision = 0; state.requests = {}; state.definition.name = name || state.definition.name + ' · ветка';
    save(join(target, cp, 'state.json'), state); save(join(target, 'current.json'), { checkpoint: cp, revision: 0, hash: hash(state), nativeHash: state.nativeHash });
    save(join(target, 'manifest.json'), { ...manifest, id: nextId, name: state.definition.name, createdAt: new Date().toISOString(), parent: { branchId: id, checkpoint: selected.checkpoint } });
    return snapshot(nextId);
  }
  async function pause(id) { scoped(id); const w = workers.get(id); if (!w) return { paused: true }; w.running = false; if (w.child.stdin.writable) w.child.stdin.write(JSON.stringify({ operation: 'pause', id: randomUUID() }) + '\n'); await cancelModels(w); return { paused: true }; }
  async function runUntil(id, ticks) {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 24) throw worldError('Горизонт должен быть от 1 до 24 тактов.');
    const w = await workerFor(id); if (w.running || w.pending.size) throw worldError('Ветка уже выполняет команду.', 409); w.running = true; w.error = null;
    void (async () => { try { for (let i = 0; i < ticks && w.running; i++) { const c = current(w.dir); await command(id, { expectedRevision: c.pointer.revision, requestId: randomUUID(), operation: 'step', args: {} }); await new Promise(r => setTimeout(r, 150)); } } catch (e) { w.error = e.message; } finally { w.running = false; } })();
    return { running: true, ticks };
  }
  async function handle(method, path, url, body) {
    if (!path.startsWith('/api/living-world')) return null;
    activeScope();
    const suffix = path.slice('/api/living-world'.length);
    if (method === 'GET' && suffix === '/status') return { status: 200, data: { engine: 'WorldX', ready: existsSync(join(VENDOR, 'server', 'dist', 'simulation', 'simulation-engine.js')), branches: list(), api: apiSettings.status() } };
    if (method === 'POST' && suffix === '/api-settings') return { status: 200, data: apiSettings.save(body) };
    if (method === 'POST' && suffix === '/api-check') return { status: 200, data: await apiSettings.check() };
    if (method === 'POST' && suffix === '/import') {
      const imported = importLivingWorld(workspace.root(), { sourcePaths: body.sourcePaths || [] }), id = randomUUID(); save(join(imports, id + '.json'), { ...imported, id, scope: activeScope() });
      return { status: 201, data: { id, name: imported.name, fingerprint: imported.fingerprint, sourceCount: imported.sources.length, entities: imported.entities, gaps: imported.gaps, sources: imported.sources.map(({ text, links, ...s }) => s), staging: null } };
    }
    const sourceMatch = suffix.match(/^\/imports\/([a-f0-9-]+)\/source$/);
    if (method === 'GET' && sourceMatch) { const data = read(join(imports, sourceMatch[1] + '.json')); if (data.scope !== activeScope()) throw worldError('Источник недоступен.', 404); const source = data.sources.find(s => s.path === url.searchParams.get('path')); if (!source) throw worldError('Источник не найден.', 404); return { status: 200, data: source }; }
    if (method === 'POST' && suffix === '/branches') return { status: 201, data: await createBranch(body.importId, body.setup, body.approved) };
    const match = suffix.match(/^\/branches\/([a-f0-9-]+)(?:\/(command|pause|run|fork))?$/);
    if (!match) throw worldError('Маршрут модуля не найден.', 404);
    const [, id, operation] = match; scoped(id);
    if (method === 'GET' && !operation) return { status: 200, data: snapshot(id, { view: url.searchParams.get('view') || 'author', actorId: url.searchParams.get('actorId') || undefined, checkpoint: url.searchParams.get('checkpoint') || undefined }) };
    if (method === 'POST' && operation === 'command') { await command(id, body); return { status: 200, data: snapshot(id) }; }
    if (method === 'POST' && operation === 'pause') return { status: 200, data: await pause(id) };
    if (method === 'POST' && operation === 'run') return { status: 202, data: await runUntil(id, body.ticks) };
    if (method === 'POST' && operation === 'fork') return { status: 201, data: await fork(id, body.checkpoint, body.name) };
    throw worldError('Метод не поддерживается.', 405);
  }
  async function close() {
    closed = true;
    await Promise.all([...workers.entries()].map(async ([id, w]) => { w.running = false; w.dead = true; await cancelModels(w); if (w.child.exitCode === null && w.child.stdin.writable) w.child.stdin.write(JSON.stringify({ operation: 'shutdown' }) + '\n'); await Promise.race([new Promise(r => w.child.once('exit', r)), new Promise(r => setTimeout(r, 1500))]); await stopProcess(w.child); }));
    await Promise.all([...terminations]);
    workers.clear();
  }
  return { handle, snapshot, createBranch, command, fork, pause, runUntil, list, close, root };
}
