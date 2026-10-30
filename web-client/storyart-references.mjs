import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const KEY = 'storyart.reference-plans.v1';
const MAX = 12_000_000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const modes = new Set(['auto', 'confirm', 'manual']);
const targetOf = input => ({ kind: input.kind || 'generation', styleId: input.styleId || '', characterId: input.characterId || '', prompt: input.prompt || '', referenceIds: [...(input.referenceIds || [])].sort(), uploadIds: [...(input.uploadIds || [])].sort(), options: Object.fromEntries(Object.entries(input.options || {}).filter(([k]) => k !== 'bodyLibrary').sort(([a], [b]) => a.localeCompare(b))) });

export function runReferenceBridge(projectPath, request, { python = process.env.TALEWISP_PYTHON || 'python', spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(python, ['-B', '-X', 'utf8', fileURLToPath(new URL('./storyart-reference-bridge.py', import.meta.url)), projectPath], { windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', bytes = 0, exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', b => { bytes += Buffer.byteLength(b); if (bytes > MAX) { exceeded = true; child.kill(); } else out += b; });
    child.stderr.on('data', b => { err = (err + b).slice(-2000); });
    child.on('error', e => { clearTimeout(timer); reject(fail(503, `Менеджер референсов недоступен: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) return reject(fail(409, exceeded ? 'Менеджер референсов превысил время или размер ответа.' : `StoryArt не подтвердил каталог/выбор: ${err.slice(-700)}`));
      try { resolve(JSON.parse(out)); } catch { reject(fail(503, 'Некорректный ответ менеджера StoryArt.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export function createStoryArtReferences({ projectPath, store, partner, currentRevision, safeFile, imageType, bridge = request => runReferenceBridge(projectPath, request) }) {
  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const state = () => { const raw = store.getSetting(KEY); if (!raw) return {}; try { const s = JSON.parse(raw); if (!s || Array.isArray(s) || typeof s !== 'object') throw 0; return s; } catch { throw fail(409, 'Журнал выбора референсов повреждён.'); } };
  const save = plans => { const raw = JSON.stringify(plans); if (Buffer.byteLength(raw) > 3_000_000) throw fail(413, 'Журнал подбора заполнен.'); store.setSetting(KEY, raw); };
  const check = (input, context) => { if (!context?.scope || input.workspaceRevision !== context.workspaceRevision || input.workspaceRevision !== currentRevision()) throw fail(409, 'Рабочая область изменилась.'); };
  const owned = (id, context) => { const p = state()[id]; if (!p || p.scope !== context.scope) throw fail(404, 'Подбор не найден.'); return p; };
  const publicRecord = (r, revision) => {
    const { relative_path, ...record } = r;
    return { ...record, generationEligible: false, previewUrl: relative_path ? `/api/storyart/reference-image?pool=${encodeURIComponent(r.pool)}&id=${encodeURIComponent(r.id)}&revision=${revision}&sha256=${r.sha256}` : '', previewReason: relative_path ? '' : 'Источник требует проверки классификации в StoryArt.' };
  };
  const publicPlan = p => { const { scope, target, ...plan } = p; return plan; };
  async function catalog(query = {}) {
    const data = await bridge({ operation: 'catalog' });
    for (const key of ['pool', 'category', 'subject', 'q', 'tag']) if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > 300)) throw fail(400, 'Некорректный фильтр.');
    if (query.pool && !data.pools[query.pool] || query.category && !data.categories[query.category] || query.subject && !['MALE', 'FEMALE', 'NO_SUBJECT', 'UNKNOWN'].includes(query.subject)) throw fail(400, 'Неизвестный фильтр каталога.');
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 36);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail(400, 'Некорректная страница.');
    const q = (query.q || '').toLocaleLowerCase(), tag = (query.tag || '').toLocaleLowerCase();
    if (query.grouped !== undefined && !['0', '1'].includes(query.grouped)) throw fail(400, 'Некорректный режим группировки.');
    const eligible = data.records.filter(r => (!query.pool || r.pool === query.pool) && (!query.category || r.categories.includes(query.category)) && (!query.subject || r.subject_label === query.subject) && (!tag || JSON.stringify([r.tags, r.groups]).toLocaleLowerCase().includes(tag)));
    const rows = eligible.filter(r => !q || JSON.stringify([r.id, r.title, r.tags, r.groups, r.group_id, r.group_display, r.provenance]).toLocaleLowerCase().includes(q));
    const poseKey = r => r.pool === 'POSE_ATLAS' && r.group_id ? `${r.pool}:${r.group_id}` : `${r.pool}:${r.id}`;
    const siblings = new Map();
    if (query.grouped === '1') for (const r of eligible) { const k = poseKey(r); if (!siblings.has(k)) siblings.set(k, []); siblings.get(k).push(r); }
    const seen = new Set();
    const displayed = query.grouped === '1' ? rows.filter(r => { const k = poseKey(r); if (seen.has(k)) return false; seen.add(k); return true; }) : rows;
    const displayRecord = r => ({ ...publicRecord(r, data.revision), ...(query.grouped === '1' && r.pool === 'POSE_ATLAS' && r.group_id ? { views: siblings.get(poseKey(r)).map(view => publicRecord(view, data.revision)) } : {}) });
    return { revision: data.revision, total: displayed.length, imageCount: rows.length, grouped: query.grouped === '1', offset, limit, categories: Object.entries(data.categories).map(([id, c]) => ({ id, label: c.label_ru, count: data.records.filter(r => r.categories.includes(id)).length })), pools: Object.entries(data.pools).map(([id, p]) => ({ id, roles: p.roles, count: data.records.filter(r => r.pool === id).length })), records: displayed.slice(offset, offset + limit).map(displayRecord) };
  }
  async function image(query) {
    const data = await bridge({ operation: 'catalog' });
    if (data.revision !== query.revision) throw fail(409, 'Каталог изменился. Обновите подбор.');
    const r = data.records.find(r => r.pool === query.pool && r.id === query.id);
    if (!r?.relative_path) throw fail(403, 'Просмотр требует проверки классификации StoryArt.');
    if (r.sha256 !== query.sha256) throw fail(409, 'Референс изменился.');
    const file = await safeFile(projectPath, `${data.pools[r.pool].root}/${r.relative_path}`);
    if (file.sha256 !== r.sha256) throw fail(409, 'Файл изменился после классификации.');
    return { ...file, ...imageType(file.bytes) };
  }
  async function validate(items, revision, subject) {
    if (!Array.isArray(items) || !items.length || items.length > 12 || items.some(i => !i || typeof i.pool !== 'string' || typeof i.id !== 'string' || typeof i.role !== 'string' || !/^[a-f0-9]{64}$/.test(i.sha256)) || new Set(items.map(i => `${i.pool}:${i.id}`)).size !== items.length) throw fail(400, 'Выберите от 1 до 12 разных референсов с назначением.');
    const result = await bridge({ operation: 'select', items, revision, subject });
    return result.selected.map(({ record, candidate }) => ({ pool: record.pool, id: record.id, role: items.find(i => i.pool === record.pool && i.id === record.id).role, sha256: record.sha256, title: record.title, previewUrl: publicRecord(record, revision).previewUrl, previewReason: publicRecord(record, revision).previewReason, groupId: record.group_id || '', parentId: record.parent_id || '', angle: record.angle || '', provenance: record.provenance, candidateStatus: candidate.classification_status || candidate.approval_status || 'NOT_APPROVED', generationEligible: false }));
  }
  const persist = (p, context) => { check(p, context); const plans = state(); plans[p.id] = p; save(plans); return publicPlan(p); };
  async function create(input, context) { return serial(async () => {
    check(input, context);
    if (typeof input.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)) throw fail(400, 'Нужен постоянный ID попытки подбора.');
    if (!modes.has(input.mode) || typeof input.target?.prompt !== 'string' || !input.target.prompt.trim() || input.target.prompt.length > 16000 || !['', 'MALE', 'FEMALE'].includes(input.subject || '')) throw fail(400, 'Некорректное задание подбора.');
    const inputHash = hash({ target: targetOf(input.target), mode: input.mode, subject: input.subject || '' });
    const existing = state()[input.requestId];
    if (existing) {
      if (existing.scope !== context.scope || existing.inputHash !== inputHash) throw fail(409, 'ID уже связан с другим подбором.');
      return publicPlan(existing);
    }
    if (Object.values(state()).filter(p => p.scope === context.scope).length >= 100) throw fail(413, 'Лимит подборов рабочей области достигнут.');
    const data = await bridge({ operation: 'catalog' });
    const p = { id: input.requestId, inputHash, scope: context.scope, workspaceRevision: context.workspaceRevision, target: targetOf(input.target), targetHash: hash(targetOf(input.target)), mode: input.mode, subject: input.subject || '', revision: data.revision, status: input.mode === 'manual' ? 'draft' : 'dispatching', selections: [], alternatives: [], round: 0 };
    if (input.mode === 'manual') return persist(p, context);
    if (!partner) throw fail(503, 'Агент StoryArt недоступен.');
    persist(p, context);
    try {
      const result = await partner.execute({ operation: 'create', requestId: `refs-${p.id}`, brief: ['STORYART_REFERENCE_SELECTION_ONLY', 'Автор поручил подобрать референсы. Только подбор; не генерировать изображения, не менять канон, классификацию или утверждённую личность. Пользуйся актуальным reference_pool_manager и правилами StoryArt. Выбор типа библиотеки разрешён в рамках этого подбора.', JSON.stringify({ target: p.target, subject: p.subject, catalogRevision: p.revision, round: 0 }), 'Верни финальный результат строго в блоке REFERENCE_SELECTION_BEGIN / REFERENCE_SELECTION_END с JSON внутри: {"round":0,"selections":[{"pool":"...","id":"...","role":"...","sha256":"..."}],"alternatives":[...],"reason":"почему выбран набор"}. Не более 6 выбранных и 6 альтернатив. Для задачи о позе сначала проверь все подходящие группы каталога и предложи 3–6 РАЗНЫХ поз, если столько действительно подходит: одна рекомендованная поза в selections, другие подходящие позы в alternatives. Если вариантов меньше, объясни почему остальные не подходят. Для каждой позы верни один лучший ракурс-представитель; остальные ракурсы UI получит из каталога. Не заполняй alternatives ракурсами одной и той же позы. Не ограничивайся первой найденной группой. Только текущие исходные ID и SHA256, допустимые роли. UNKNOWN не превращать в PASS. Если подбор невозможен, верни пустые массивы и причину.'].join('\n') }, { ...context, mode: 'storyart' });
      p.status = result.ok ? 'selecting' : 'unknown'; p.error = result.ok ? '' : result.error;
    } catch (e) { p.status = 'unknown'; p.error = e.message; }
    return persist(p, context);
  }); }
  async function get(id, context) { return serial(async () => {
    const p = owned(id, context); check(p, context);
    if (p.status !== 'selecting') return publicPlan(p);
    const result = await partner.execute({ operation: 'read', requestId: `refs-${id}` }, { ...context, mode: 'storyart' });
    if (!result.ok) throw fail(409, result.error || 'Не удалось прочитать подбор.');
    const match = [...String(result.hostReceipt || '').matchAll(/REFERENCE_SELECTION_BEGIN\s*([\s\S]*?)\s*REFERENCE_SELECTION_END/g)].at(-1);
    if (!match) {
      if (['completed', 'idle', 'error', 'failed'].includes(result.status)) { p.status = 'review_required'; p.error = 'Агент завершил ход без структурированного выбора. Откройте ручной подбор или уточните задание.'; return persist(p, context); }
      return publicPlan(p);
    }
    try {
      const choice = JSON.parse(match[1]);
      if (choice.round !== p.round) return publicPlan(p);
      if (!Array.isArray(choice.alternatives) || !Array.isArray(choice.selections) || choice.alternatives.length > 6 || choice.selections.length > 6) throw fail(400, 'Некорректный ответ агента.');
      p.reason = String(choice.reason || '').slice(0, 2000);
      if ((p.pinned || []).some(pin => !choice.selections.some(i => i.pool === pin.pool && i.id === pin.id && i.role === pin.role && i.sha256 === pin.sha256))) throw fail(409, 'Агент изменил закреплённый референс.');
      if (!choice.selections.length) { p.selections = []; p.alternatives = []; p.status = 'review_required'; p.error = ''; return persist(p, context); }
      const all = [...choice.selections, ...choice.alternatives];
      const verified = await validate(all, p.revision, p.subject);
      p.selections = verified.slice(0, choice.selections.length); p.alternatives = verified.slice(choice.selections.length); p.reason = String(choice.reason || '').slice(0, 2000);
      if (!p.selections.length) throw fail(409, p.reason || 'Агент не нашёл подходящий набор.');
      p.status = p.mode === 'auto' ? 'ready' : 'awaiting_confirmation';
    } catch (e) { p.status = 'review_required'; p.error = e.message; }
    return persist(p, context);
  }); }
  async function update(id, input, context) { return serial(async () => {
    check(input, context); const p = owned(id, context); check(p, context);
    if (['dispatching', 'selecting', 'unknown', 'in_use'].includes(p.status)) throw fail(409, 'Подбор ещё выполняется или уже передан в работу.');
    p.selections = await validate(input.items, p.revision, p.subject);
    p.status = input.confirm === true ? 'ready' : 'awaiting_confirmation';
    return persist(p, context);
  }); }
  async function regenerate(id, input, context) { return serial(async () => {
    check(input, context); const p = owned(id, context); check(p, context);
    if (p.mode === 'manual' || !['ready', 'awaiting_confirmation', 'review_required'].includes(p.status) || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 1500) throw fail(400, 'Укажите, что изменить в подборе.');
    const pinned = input.pinned || [];
    if (!Array.isArray(pinned) || pinned.some(key => !p.selections.some(i => `${i.pool}:${i.id}` === key))) throw fail(400, 'Неизвестный закреплённый референс.');
    p.status = 'unknown'; p.round++; persist(p, context);
    const result = await partner.execute({ operation: 'send', requestId: `refs-${id}`, message: `Переподбери референсы. Генерация запрещена. ${input.message}\nСохрани закреплённые: ${JSON.stringify(p.selections.filter(i => pinned.includes(`${i.pool}:${i.id}`)))}\nОтклонённые варианты текущего набора: ${JSON.stringify(p.selections.filter(i => !pinned.includes(`${i.pool}:${i.id}`)).map(i => ({pool:i.pool,id:i.id})))}\nВерни новый полный набор и альтернативы в прежнем REFERENCE_SELECTION_BEGIN/END JSON. Для задачи о позе проверь все подходящие группы и покажи 3–6 разных поз, если они подходят. Один лучший ракурс на позу; другие ракурсы покажет UI. Не заменяй разнообразие поз ракурсами одной группы. Обязательное поле round: ${p.round}.` }, { ...context, mode: 'storyart' });
    p.status = result.ok ? 'selecting' : 'unknown'; p.error = result.ok ? '' : result.error; p.pinned = p.selections.filter(i => pinned.includes(`${i.pool}:${i.id}`));
    return persist(p, context);
  }); }
  async function forGeneration(id, input, context) { return serial(async () => {
    const p = owned(id, context); check(p, context);
    if ((p.status !== 'ready' && !(p.status === 'in_use' && p.generationRequestId === input.requestId)) || hash(targetOf(input)) !== p.targetHash || typeof input.requestId !== 'string' || !input.requestId) throw fail(409, 'Подтвердите подбор для актуального задания.');
    const selections = await validate(p.selections, p.revision, p.subject);
    p.status = 'in_use'; p.generationRequestId = input.requestId; persist(p, context);
    return { planId: id, mode: p.mode, revision: p.revision, selections, authorConfirmed: p.mode !== 'auto', attachmentApproval: false };
  }); }
  async function release(id, requestId, context) { return serial(async () => {
    const p = owned(id, context);
    if (p.status === 'in_use' && p.generationRequestId === requestId) { p.status = 'ready'; delete p.generationRequestId; const plans = state(); plans[id] = p; save(plans); }
  }); }
  return { catalog, image, create, get, update, regenerate, forGeneration, release };
}
