import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bytesToBase64, buildJobRequest, createStoryArtWorkspace, filterStyles, jobStatusLabel, normalizeStoryArtRoute, qaLabel,
  referenceBuckets, safeStoryArtUrl, stageLabel, stageStatusLabel, STORYART_MAX_UPLOAD_BYTES, validateImageFile,
  SCENE_CHOICES, OUTPUT_CHOICES, FIDELITY_CHOICES, normalizeStyle, normalizeReference, readinessLabel, approvalLabel,
  referenceStatusLabel, eligibilityLabel, isTrialReference, referenceDisplayName
} from '../public/storyart-workspace.js';

test('reference cards show a readable title instead of the raw library filename', () => {
  assert.equal(referenceDisplayName('BODY_CORE_cara_165fe9da-f6eb-4a94-92a5-ae70972897d9_1_katefox-XNhs-spB1xHshRDZDUJZa-Traveler.jpg', 'BODY_CORE'), 'Traveler');
  assert.equal(referenceDisplayName("ANCHOR_STYLE_cara_dd52aada-845c-44c4-a318-b33404ac5700_1_katefox-SqYDiESysirIiD8E9fSHd-It's-all-simple-here-look.jpg", 'ANCHOR_STYLE'), "It's all simple here look");
  assert.equal(referenceDisplayName('MASTER_STYLE_MASTER_STYLE_A_1nbkaG.jpg', 'MASTER_STYLE'), 'A 1nbkaG');
  assert.equal(referenceDisplayName('alex_flores_project_jhin.jpg', ''), 'alex flores project jhin');
  assert.equal(referenceDisplayName('ANCHOR_STYLE.png', 'ANCHOR_STYLE'), 'ANCHOR STYLE');
});
import { normalizeNavigation, readNavigation, writeNavigation } from '../public/navigation-state.js';
import { PRIMARY_VIEWS } from '../public/workspace-adapters.js';
import { renderStoryArtRequests } from '../public/host-workspace.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ORIGIN = 'https://tale.example';

// Minimal DOM: enough for the workspace's rendering, events and focus handling.
class FakeElement {
  constructor(doc, tag) {
    Object.assign(this, { ownerDocument: doc, tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, dataset: {}, style: {}, hidden: false, listeners: {}, className: '', ownText: '', value: '', checked: false, disabled: false });
    this.classList = {
      contains: c => this.className.split(/\s+/).includes(c),
      add: (...cs) => cs.forEach(c => { if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim(); }),
      remove: (...cs) => { this.className = this.className.split(/\s+/).filter(x => x && !cs.includes(x)).join(' '); },
      toggle: (c, force = !this.classList.contains(c)) => { force ? this.classList.add(c) : this.classList.remove(c); return force; }
    };
  }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.ownerDocument.body || n === this.ownerDocument.mount; }
  setAttribute(name, value) { if (name === 'class') this.className = String(value); else this.attrs[name] = String(value); }
  getAttribute(name) { return name === 'class' ? this.className : this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...nodes) { nodes.forEach(n => { if (n.parent) n.remove(); n.parent = this; this.children.push(n); }); }
  replaceChildren(...nodes) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  get textContent() { return [this.ownText, ...this.children.map(c => c.textContent)].filter(Boolean).join(' '); }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    (this.listeners[type] || []).forEach(fn => fn(event));
    return event;
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
}

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const httpError = (message, status, code = '') => Object.assign(Error(message), { status, code });

const STYLES = [
  { id: 'KATE_FOX', name: 'KATE_FOX', description: 'Тёплая акварельная линия', coverUrl: '/api/storyart/library-image?styleId=KATE_FOX&referenceId=REF_1', readiness: 'READY', referenceCount: 2, characterCount: 1 },
  { id: 'AROMA', name: 'AROMA', description: 'Плотная гуашь', coverUrl: 'https://evil.example/cover.png', readiness: 'READY', referenceCount: 0, characterCount: 0 }
];
const STYLE_DETAIL = {
  style: STYLES[0], profile: '# Профиль\nМягкий свет.', negative: 'Не переносить лица.',
  references: [
    { id: 'REF_1', name: 'Лес', role: 'ANCHOR_STYLE', status: 'APPROVED', url: '/api/storyart/library-image?styleId=KATE_FOX&referenceId=REF_1', useFor: 'linework', doNotUseFor: 'identity' },
    { id: 'REF_2', name: '<img src=x onerror=alert(1)>', role: 'PALETTE', url: '/api/storyart/library-image?styleId=KATE_FOX&referenceId=REF_2' }
  ],
  characters: [{ id: 'CHAR_002', name: 'Beal' }]
};
const JOB = { id: 'job-1', title: 'Сцена у реки', kind: 'generation', styleId: 'KATE_FOX', status: 'completed', artifacts: [{ index: 0, label: 'Кандидат 1', url: '/api/storyart/artifact?requestId=job-1&index=0', sha256: 'abc' }, { index: 1, label: 'Кандидат 2', url: '/api/storyart/artifact?requestId=job-1&index=1', sha256: 'def' }], visualQa: 'PASS', canonQa: null, authorApproval: null };
const PROCESS = {
  available: true, phase: 'qa', status: 'waiting', nextAction: 'Выберите вариант для согласования.',
  stages: [{ id: 'plan', status: 'done' }, { id: 'generate', status: 'done' }, { id: 'visual_qa', status: 'running' }],
  events: [{ at: '2026-10-22T10:00:00Z', event: 'plan', summary: 'План составлен' }],
  selectedReferences: [{ id: 'REF_1', name: 'Лес', role: 'ANCHOR_STYLE' }],
  preparedReferences: [{ id: 'REF_1', name: 'Лес', role: 'ANCHOR_STYLE', url: '/api/storyart/library-image?styleId=KATE_FOX&referenceId=REF_1' }],
  executedReferences: []
};

function setup({ routes = {}, scope = () => 'author/series/book', ask = null } = {}) {
  const doc = { activeElement: null, listeners: {}, visibilityState: 'visible' };
  doc.createElement = tag => new FakeElement(doc, tag);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.body = new FakeElement(doc, 'body');
  doc.mount = new FakeElement(doc, 'main');
  const root = doc.createElement('div');
  doc.mount.append(root);
  const timers = [], calls = [], notes = [], routesSeen = [];
  let uuid = 0;
  const window = {
    location: { origin: ORIGIN }, navigator: { onLine: true }, crypto: { randomUUID: () => 'uuid-' + (++uuid) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    URL: { createObjectURL: () => 'blob:local', revokeObjectURL: () => {} }, btoa: s => Buffer.from(s, 'binary').toString('base64')
  };
  const defaults = {
    'GET /api/storyart/project': () => ({ styles: STYLES, capabilities: { available: true, reason: '', uploads: true }, workspaceRevision: 'rev-1' }),
    'GET /api/storyart/jobs': () => ({ requests: [JOB], workspaceRevision: 'rev-1' }),
    'GET /api/storyart/styles/KATE_FOX': () => STYLE_DETAIL,
    'GET /api/storyart/jobs/job-1': () => ({ request: JOB, process: PROCESS, workspaceRevision: 'rev-1' })
  };
  // Mirrors the server contract: the scope header is required and echoed back as clientScope.
  const api = async (path, options = {}) => {
    const method = options.method || 'GET';
    const clientScope = options.headers?.['x-storyart-scope'];
    calls.push({ method, path, body: options.body, scope: clientScope });
    if (typeof clientScope !== 'string') throw Object.assign(httpError('scope header missing', 409, 'scope_changed'), { clientScope: '' });
    const handler = routes[method + ' ' + path] ?? defaults[method + ' ' + path];
    if (!handler) throw httpError('not routed: ' + method + ' ' + path, 404);
    const result = await handler(options.body);
    return result && typeof result === 'object' && !('clientScope' in result) ? { ...result, clientScope } : result;
  };
  const ws = createStoryArtWorkspace({ document: doc, window, root, api, notify: (m, e) => notes.push([m, !!e]), getScope: scope, ask, onRouteChange: r => routesSeen.push(r) });
  const nodes = () => [...doc.mount.walk(), ...doc.body.walk()];
  const find = (tag, text) => nodes().find(n => n.tagName === tag && n.textContent.includes(text));
  const field = label => nodes().find(n => n.tagName === 'LABEL' && n.children[0]?.textContent === label)?.children[1];
  return { ws, root, doc, window, timers, calls, notes, routesSeen, nodes, find, field };
}

test('manual reference UI requires confirmation and passes the exact plan to generation',async()=>{
  const ref={pool:'POSE_ATLAS',id:'pose-ui',title:'Спокойная стойка',sha256:'a'.repeat(64),role:'STAGING_ONLY',previewUrl:'/api/storyart/reference-image?id=pose-ui'};
  const routes={};let planId;
  routes['GET /api/storyart/references?offset=0&limit=24&grouped=1']=()=>({revision:'library-1',total:1,categories:[],pools:[{id:'POSE_ATLAS',roles:['STAGING_ONLY']}],records:[ref]});
  routes['POST /api/storyart/references/plans']=body=>{planId=body.requestId;routes['POST /api/storyart/references/plans/'+planId]=choice=>({plan:{id:planId,status:choice.confirm?'ready':'awaiting_confirmation',revision:'library-1',selections:choice.items,alternatives:[]}});return {plan:{id:planId,status:'draft',revision:'library-1',selections:[],alternatives:[]}};};
  routes['POST /api/storyart/jobs']=()=>({ok:true,request:JOB});
  const t=setup({routes});const d=t.ws._state().generation;d.styleId='KATE_FOX';d.title='Сцена';d.prompt='Герой стоит у двери';
  t.ws.restore({scope:'author/series/book',screen:'generate',styleId:'KATE_FOX'});t.ws.show();await flush();
  const toggle=t.nodes().find(n=>n.tagName==='LABEL'&&n.textContent==='Использовать референсы').children[0];toggle.checked=true;toggle.dispatch('change');
  t.find('BUTTON','Вручную').click();await flush();t.find('BUTTON','Добавить в набор').click();
  t.nodes().find(n=>n.tagName==='FORM').dispatch('submit');await flush();assert.equal(t.calls.some(c=>c.path==='/api/storyart/jobs'&&c.method==='POST'),false);assert.equal(d.unknown,false);
  t.find('BUTTON','Подтвердить набор').click();await flush();assert.equal(d.referencePicker.plan.status,'ready');
  const styleReference=t.nodes().find(n=>n.tagName==='BUTTON'&&n.attrs['aria-label']?.startsWith('ANCHOR_STYLE_')) || t.nodes().find(n=>n.tagName==='BUTTON'&&n.classList.contains('sa-pick'));
  styleReference.click();assert.ok(t.root.textContent.includes('Задание изменилось. Этот набор нужно обновить.'));
  styleReference.click();await flush();
  t.nodes().find(n=>n.tagName==='FORM').dispatch('submit');await flush();
  const sent=t.calls.find(c=>c.path==='/api/storyart/jobs'&&c.method==='POST');assert.equal(sent.body.referencePlanId,planId);assert.equal(sent.body.options.bodyLibrary,'on');
});

// Pure helpers

test('upload validation accepts only PNG/JPEG/WebP up to 20 MiB and explains rejections', () => {
  assert.equal(validateImageFile({ name: 'a.png', type: 'image/png', size: 10 }), '');
  assert.equal(validateImageFile({ name: 'a.webp', type: '', size: 10 }), '');
  assert.match(validateImageFile({ name: 'a.gif', type: 'image/gif', size: 10 }), /PNG, JPEG или WebP/);
  assert.match(validateImageFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 }), /только/);
  assert.match(validateImageFile({ name: 'big.jpg', type: 'image/jpeg', size: STORYART_MAX_UPLOAD_BYTES + 1 }), /20 МБ/);
  assert.equal(validateImageFile({ name: 'edge.jpg', type: 'image/jpeg', size: STORYART_MAX_UPLOAD_BYTES }), '');
  assert.match(validateImageFile({ name: 'empty.png', type: 'image/png', size: 0 }), /пустой/);
  assert.equal(bytesToBase64(new Uint8Array([1, 2, 3, 4]), s => Buffer.from(s, 'binary').toString('base64')), 'AQIDBA==');
});

test('image URLs are limited to same-origin StoryArt routes', () => {
  assert.equal(safeStoryArtUrl('/api/storyart/library-image?styleId=A&referenceId=R', ORIGIN), '/api/storyart/library-image?styleId=A&referenceId=R');
  assert.equal(safeStoryArtUrl('https://evil.example/api/storyart/x', ORIGIN), '');
  assert.equal(safeStoryArtUrl('//evil.example/api/storyart/x', ORIGIN), '');
  assert.equal(safeStoryArtUrl('/api/storyart/../documents', ORIGIN), '');
  assert.equal(safeStoryArtUrl('/api/documents', ORIGIN), '');
  assert.equal(safeStoryArtUrl('javascript:alert(1)', ORIGIN), '');
  assert.equal(safeStoryArtUrl(null, ORIGIN), '');
});

test('routes keep only known screens and slug IDs', () => {
  assert.deepEqual(normalizeStoryArtRoute({ scope: 'a/b/c', screen: 'job', jobId: 'job-1' }), { scope: 'a/b/c', screen: 'job', styleId: null, jobId: 'job-1' });
  assert.equal(normalizeStoryArtRoute({ screen: 'job', jobId: '../x' }).screen, 'jobs');
  assert.equal(normalizeStoryArtRoute({ screen: 'style' }).screen, 'styles');
  assert.equal(normalizeStoryArtRoute({ screen: 'admin' }), null);
  assert.equal(filterStyles(STYLES, 'акварел').length, 1);
  assert.equal(filterStyles(STYLES, '').length, 2);
});

test('job request is built literally with explicit choices and no inherited body library', () => {
  const detail = { style: { id: 'KATE_FOX' }, references: STYLE_DETAIL.references, characters: STYLE_DETAIL.characters };
  const base = { kind: 'generation', requestId: 'uuid-1', styleId: 'KATE_FOX', title: ' Река ', prompt: '  Сцена у реки, без людей  ', referenceIds: ['REF_1'], characterId: 'CHAR_002', uploads: [{ status: 'ready', upload: { id: 'UP_1' } }, { status: 'error' }], options: { fidelity: '', bodyLibrary: 'off' } };
  const { body } = buildJobRequest(base, { revision: 'rev-1', styles: STYLES, detail });
  assert.deepEqual(body, { requestId: 'uuid-1', workspaceRevision: 'rev-1', kind: 'generation', title: 'Река', styleId: 'KATE_FOX', prompt: 'Сцена у реки, без людей', referenceIds: ['REF_1'], uploadIds: ['UP_1'], options: { bodyLibrary: 'off' }, characterId: 'CHAR_002' });
  assert.equal('fidelity' in body.options, false, 'empty fidelity means StoryArt must ask');
  assert.equal(buildJobRequest({ ...base, options: { fidelity: 'custom', fidelityCustom: '' } }, { revision: 'rev-1', styles: STYLES, detail }).error.includes('степень'), true);
  assert.equal(buildJobRequest({ ...base, options: { fidelity: 'custom', fidelityCustom: 'как на обложке' } }, { revision: 'rev-1', styles: STYLES, detail }).body.options.fidelity, 'как на обложке');
  assert.equal(buildJobRequest({ ...base, kind: 'character_create' }, { revision: 'rev-1', styles: STYLES, detail }).body.characterId, undefined);
  assert.match(buildJobRequest({ ...base, referenceIds: ['REF_OTHER'] }, { revision: 'rev-1', styles: STYLES, detail }).error, /не относится/);
  assert.match(buildJobRequest({ ...base, characterId: 'CHAR_X' }, { revision: 'rev-1', styles: STYLES, detail }).error, /персонаж/);
  assert.match(buildJobRequest(base, { revision: '', styles: STYLES, detail }).error, /Каталог/);
  assert.match(buildJobRequest({ ...base, uploads: [{ status: 'uploading' }] }, { revision: 'rev-1', styles: STYLES, detail }).error, /загрузки/);
  const style = { kind: 'style_create', requestId: 'uuid-2', styleName: 'Ночь', prompt: 'Синие тени', uploads: [] };
  assert.match(buildJobRequest(style, { revision: 'rev-1' }).error, /исходное изображение/);
  assert.deepEqual(buildJobRequest({ ...style, uploads: [{ status: 'ready', upload: { id: 'UP_9' } }] }, { revision: 'rev-1' }).body, { requestId: 'uuid-2', workspaceRevision: 'rev-1', kind: 'style_create', title: 'Новый стиль: Ночь', styleName: 'Ночь', prompt: 'Синие тени', uploadIds: ['UP_9'] });
});

test('option choices use only real StoryArt enums and fidelity presets', () => {
  const values = list => list.map(([value]) => value);
  assert.deepEqual(values(SCENE_CHOICES), ['', 'LOCATION', 'PHENOMENON', 'ARTIFACT', 'MIXED']);
  assert.deepEqual(values(OUTPUT_CHOICES), ['', 'GENERAL_ART', 'WALLPAPER', 'PROMO_POSTER']);
  assert.deepEqual(values(FIDELITY_CHOICES), ['', '30', '50', '70', '90', '100', 'custom']);
  const detail = { style: { id: 'KATE_FOX' }, references: STYLE_DETAIL.references, characters: STYLE_DETAIL.characters };
  const draft = options => ({ kind: 'generation', requestId: 'uuid-3', styleId: 'KATE_FOX', title: 'T', prompt: 'P', options });
  const built = options => buildJobRequest(draft(options), { revision: 'rev-1', styles: STYLES, detail }).body.options;
  for (const fidelity of ['30', '50', '100']) assert.equal(built({ fidelity }).fidelity, fidelity);
  assert.equal('fidelity' in built({ fidelity: '45' }), false, 'an unknown preset is never sent');
  assert.deepEqual(built({ sceneKind: 'PHENOMENON', outputUse: 'PROMO_POSTER' }), { bodyLibrary: 'off', sceneKind: 'PHENOMENON', outputUse: 'PROMO_POSTER' });
  assert.deepEqual(built({ sceneKind: 'CHARACTER', outputUse: 'COVER' }), { bodyLibrary: 'off' });
});

test('style approval, reference status and eligibility survive normalization and are labelled honestly', () => {
  const style = normalizeStyle({ id: 'KATE_FOX', readiness: 'READY', approvalStatus: 'NO_APPROVED_ANCHOR' });
  assert.equal(style.readiness, 'READY');
  assert.equal(style.approvalStatus, 'NO_APPROVED_ANCHOR');
  assert.notEqual(readinessLabel('READY'), approvalLabel('ANCHOR_APPROVED'));
  assert.match(approvalLabel('NO_APPROVED_ANCHOR'), /Нет утверждённого якоря/);
  const trial = normalizeReference({ id: 'REF_T', status: 'TEST', eligibility: 'REVIEW_REQUIRED_NOT_APPROVED', previewReason: '' });
  assert.equal(trial.status, 'TEST');
  assert.equal(trial.eligibility, 'REVIEW_REQUIRED_NOT_APPROVED');
  assert.equal(isTrialReference(trial), true);
  assert.match(referenceStatusLabel('TEST'), /не утверждён/);
  assert.match(eligibilityLabel('REVIEW_REQUIRED_NOT_APPROVED'), /не якорь/);
  const legacy = normalizeReference({ id: 'REF_L', status: 'PUBLISHED_LEGACY', eligibility: 'REVALIDATE_FOR_REQUEST' });
  assert.equal(isTrialReference(legacy), false);
  assert.match(referenceStatusLabel('PUBLISHED_LEGACY'), /старой опубликованной/);
  assert.doesNotMatch(referenceStatusLabel('PUBLISHED_LEGACY'), /Одобрен|якорь/);
  assert.equal(normalizeReference({ id: 'REF_P', previewReason: 'нужна проверка' }).previewReason, 'нужна проверка');
});

test('character stage IDs from StoryArt have Russian names', () => {
  assert.equal(stageLabel('01_FACE_IDENTITY'), 'Лицо и узнаваемость');
  assert.equal(stageLabel('02_PHYSIQUE_FRONT'), 'Телосложение: спереди');
  assert.equal(stageLabel('03_PHYSIQUE_SIDE'), 'Телосложение: сбоку');
  assert.equal(stageLabel('04_PHYSIQUE_BACK'), 'Телосложение: со спины');
  assert.equal(stageLabel('05_CHARACTER_ASSEMBLY'), 'Сборка персонажа');
});

test('reference states stay distinct and missing plan data is not invented', () => {
  const buckets = referenceBuckets({ available: false, reason: 'нет плана', selectedReferences: [{ id: 'REF_1' }] });
  assert.equal(buckets.selected.length, 1);
  assert.equal(buckets.prepared, null);
  assert.equal(buckets.executed, null);
  assert.equal(jobStatusLabel('completed'), 'Ответ получен');
  assert.equal(stageLabel('face'), 'Лицо');
  assert.equal(stageLabel('CUSTOM_STAGE'), 'CUSTOM_STAGE');
  assert.equal(stageStatusLabel('mystery'), 'Неизвестно');
  assert.equal(qaLabel(null), 'нет данных');
  assert.equal(qaLabel({ status: 'PASS' }), 'пройдена');
});

// Workspace behaviour

test('opening the section reads the catalog only and renders image cards safely', async () => {
  const t = setup();
  t.ws.show();
  await flush();
  assert.ok(t.calls.length >= 1);
  assert.ok(t.calls.every(call => call.method === 'GET'), 'opening must not dispatch anything');
  const imgs = t.nodes().filter(n => n.tagName === 'IMG');
  assert.ok(imgs.some(img => img.src === '/api/storyart/library-image?styleId=KATE_FOX&referenceId=REF_1'));
  assert.ok(!imgs.some(img => String(img.src).includes('evil.example')));
  assert.match(t.root.textContent, /Тёплая акварельная линия/);
  assert.match(t.root.textContent, /Образца нет/);
});

test('style page shows saved profile, negative, references with roles and characters as text', async () => {
  const t = setup();
  t.ws.show(); await flush();
  t.find('BUTTON', 'KATE_FOX').click(); await flush();
  assert.match(t.root.textContent, /Мягкий свет/);
  assert.match(t.root.textContent, /Не переносить лица/);
  t.find('BUTTON', 'Референсы (2)').click();
  assert.match(t.root.textContent, /ANCHOR_STYLE/);
  assert.match(t.root.textContent, /<img src=x onerror=alert\(1\)>/, 'names stay text');
  assert.equal(t.nodes().filter(n => n.tagName === 'SCRIPT').length, 0);
  t.find('BUTTON', 'Персонажи (1)').click();
  assert.match(t.root.textContent, /Beal/);
  assert.deepEqual(t.routesSeen.at(-1), { scope: 'author/series/book', screen: 'style', styleId: 'KATE_FOX', jobId: null });
});

test('generation keeps the draft and the same requestId after an unknown outcome, and blocks double submit', async () => {
  const pending = deferred();
  let attempt = 0;
  const t = setup({ routes: { 'POST /api/storyart/jobs': () => { attempt++; if (attempt === 1) throw httpError('Шлюз не ответил', 504); return pending.promise; } } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  const style = t.nodes().find(n => n.tagName === 'SELECT');
  style.value = 'KATE_FOX'; style.dispatch('change'); await flush();
  t.field('Название работы').value = 'Река'; t.field('Название работы').dispatch('input');
  t.field('Задание').value = 'Сцена у реки'; t.field('Задание').dispatch('input');
  t.nodes().find(n => n.tagName === 'BUTTON' && n.attrs['aria-label']?.startsWith('Лес')).click();
  const form = () => t.nodes().find(n => n.tagName === 'FORM');
  form().dispatch('submit'); await flush();
  const first = t.calls.filter(c => c.method === 'POST');
  assert.equal(first.length, 1);
  assert.equal(first[0].body.requestId, 'uuid-1');
  assert.deepEqual(first[0].body.referenceIds, ['REF_1']);
  assert.equal(first[0].body.options.bodyLibrary, 'off');
  assert.equal(t.ws._state().generation.unknown, true);
  assert.equal(t.field('Задание').value, 'Сцена у реки', 'draft survives the error');
  assert.match(t.root.textContent, /Неизвестно, принял ли StoryArt запрос/);
  assert.ok(t.find('BUTTON', 'Отправить тот же запрос ещё раз'));
  form().dispatch('submit'); form().dispatch('submit'); await flush();
  const posts = t.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2, 'in-flight submission ignores the second click');
  assert.equal(posts[1].body.requestId, 'uuid-1', 'retry is manual and reuses the requestId');
  pending.resolve({ ok: true, request: { id: 'job-1', requestId: 'uuid-1', status: 'dispatching', kind: 'generation' }, workspaceRevision: 'rev-2' });
  await flush();
  assert.equal(t.ws.route().screen, 'job');
  assert.equal(t.ws.route().jobId, 'job-1');
  assert.match(t.notes.at(-1)[0], /передан StoryArt/);
  assert.doesNotMatch(t.notes.at(-1)[0], /готов/i);
  assert.notEqual(t.ws._state().generation.requestId, 'uuid-1', 'a new request gets a new id');
});

test('style creation uploads real files, rejects bad ones locally and dispatches once', async () => {
  const t = setup({ routes: {
    'POST /api/storyart/uploads': body => ({ upload: { id: 'UP_1', name: body.name, url: '/api/storyart/uploads/UP_1', mimeType: 'image/png', size: 4 }, workspaceRevision: 'rev-1' }),
    'POST /api/storyart/jobs': () => ({ ok: true, request: { id: 'job-9', kind: 'style_create', status: 'dispatching' }, workspaceRevision: 'rev-2' })
  } });
  t.ws.show(); await flush();
  t.find('BUTTON', 'Создать стиль').click(); await flush();
  t.find('BUTTON', 'Дальше: исходные изображения').click();
  assert.match(t.root.textContent, /Назовите стиль/);
  t.field('Название стиля').value = 'Ночь'; t.field('Название стиля').dispatch('input');
  t.field('Замысел').value = 'Синие тени'; t.field('Замысел').dispatch('input');
  t.find('BUTTON', 'Дальше: исходные изображения').click(); await flush();
  t.find('BUTTON', 'Дальше: проверка').click();
  assert.match(t.root.textContent, /хотя бы одно/);
  const input = t.nodes().find(n => n.tagName === 'INPUT' && n.attrs.type === 'file');
  assert.equal(input.attrs.accept, 'image/png,image/jpeg,image/webp');
  input.files = [
    { name: 'bad.gif', type: 'image/gif', size: 10 },
    { name: 'huge.png', type: 'image/png', size: STORYART_MAX_UPLOAD_BYTES + 1 },
    { name: 'ok.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
  ];
  input.dispatch('change'); await flush();
  const uploads = t.calls.filter(c => c.path === '/api/storyart/uploads');
  assert.equal(uploads.length, 1, 'rejected files never reach the server');
  assert.deepEqual(uploads[0].body, { name: 'ok.png', base64: 'AQIDBA==', workspaceRevision: 'rev-1' });
  assert.match(t.root.textContent, /bad\.gif/);
  assert.match(t.root.textContent, /Файлов с ошибкой: 2/);
  t.find('BUTTON', 'Дальше: проверка').click(); await flush();
  assert.match(t.root.textContent, /1 файл/);
  t.nodes().find(n => n.tagName === 'FORM').dispatch('submit'); await flush();
  const jobs = t.calls.filter(c => c.method === 'POST' && c.path === '/api/storyart/jobs');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].body.uploadIds, ['UP_1']);
  assert.equal(jobs[0].body.kind, 'style_create');
  assert.equal(jobs[0].body.styleName, 'Ночь');
  assert.equal(t.ws.route().jobId, 'job-9');
});

test('removing an attachment drops it from the request', async () => {
  const t = setup({ routes: { 'POST /api/storyart/uploads': () => ({ upload: { id: 'UP_1', url: '/api/storyart/uploads/UP_1' } }) } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  const input = t.nodes().find(n => n.tagName === 'INPUT' && n.attrs.type === 'file');
  input.files = [{ name: 'a.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1]).buffer }];
  input.dispatch('change'); await flush();
  assert.equal(t.ws._state().generation.uploads[0].status, 'ready');
  t.nodes().find(n => n.attrs['aria-label'] === 'Убрать файл a.png').click();
  assert.equal(t.ws._state().generation.uploads.length, 0);
  assert.match(t.root.textContent, /Файлы не добавлены/);
});

test('job studio separates selected, prepared and executed references and shows real stages without percentages', async () => {
  const t = setup();
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  const group = cls => t.nodes().find(n => n.className.includes('sa-ref-group-' + cls));
  assert.match(group('selected').textContent, /Выбрано вами/);
  assert.match(group('selected').textContent, /Лес/);
  assert.match(group('prepared').textContent, /Лес/);
  assert.match(group('executed').textContent, /Исполненный вызов пока не зафиксирован/);
  assert.match(t.root.textContent, /Визуальная проверка/);
  assert.match(t.root.textContent, /Идёт/);
  assert.match(t.root.textContent, /Выберите вариант для согласования/);
  assert.doesNotMatch(t.root.textContent, /\d+\s*%/);
  assert.doesNotMatch(t.root.textContent, /Утверждено|APPROVED/);
});

test('unavailable process data is reported as unavailable', async () => {
  const t = setup({ routes: { 'GET /api/storyart/jobs/job-1': () => ({ request: { ...JOB, artifacts: [] }, process: { available: false, reason: 'Чат StoryArt недоступен.' } }) } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  assert.match(t.root.textContent, /Чат StoryArt недоступен/);
  assert.match(t.root.textContent, /Изображений пока нет/);
  assert.match(t.root.textContent, /План StoryArt недоступен/);
});

test('approval targets one artifact and reads as sent, not saved', async () => {
  const t = setup({ routes: { 'POST /api/storyart/jobs/job-1/action': () => ({ ok: true, accepted: true, requestId: 'job-1', workspaceRevision: 'rev-1' }) } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  t.nodes().find(n => n.attrs['aria-label'] === 'Кандидат 2').click();
  t.find('BUTTON', 'Согласовать этот вариант').click(); await flush();
  const action = t.calls.find(c => c.method === 'POST');
  assert.deepEqual(action.body, { workspaceRevision: 'rev-1', action: 'approve', artifactIndex: 1, expectedSha256: 'def' });
  assert.ok(t.calls.every(c => c.scope === 'author/series/book'), 'every call names its scope');
  assert.match(t.root.textContent, /Согласие отправлено/);
  assert.match(t.root.textContent, /подтвердит сохранение|подтверждения сохранения/);
});

test('correction text survives a failed send and is cleared only after delivery', async () => {
  let fail = true;
  const t = setup({ routes: { 'POST /api/storyart/jobs/job-1/action': () => { if (fail) throw httpError('StoryArt недоступен', 503); return { ok: true, accepted: true }; } } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  const box = t.field('Поправка для StoryArt');
  box.value = 'Сделай небо светлее'; box.dispatch('input');
  const form = t.nodes().find(n => n.tagName === 'FORM' && n.className.includes('sa-correction'));
  form.dispatch('submit'); await flush();
  assert.equal(box.value, 'Сделай небо светлее');
  assert.match(t.root.textContent, /Неизвестно, дошло ли действие/);
  assert.deepEqual(t.calls.filter(c => c.method === 'POST')[0].body, { workspaceRevision: 'rev-1', action: 'correction', message: 'Сделай небо светлее' });
  fail = false;
  form.dispatch('submit'); await flush();
  assert.equal(box.value, '');
});

test('polling only re-reads job detail while the job is visible', async () => {
  const t = setup();
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  const timer = t.timers.at(-1);
  assert.ok(timer.ms >= 10000);
  const before = t.calls.length;
  timer.fn(); await flush();
  assert.deepEqual(t.calls.slice(before).map(c => c.method + ' ' + c.path), ['GET /api/storyart/jobs/job-1']);
  t.doc.visibilityState = 'hidden';
  const count = t.calls.length;
  t.timers.at(-1).fn(); await flush();
  assert.equal(t.calls.length, count, 'hidden tab does not poll');
});

test('lightbox closes on Escape and returns focus to the opener', async () => {
  const t = setup();
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  const opener = t.nodes().find(n => n.attrs['aria-label'] === 'Открыть Кандидат 1 крупно');
  opener.focus(); opener.click();
  const overlay = t.doc.body.children.find(n => n.className.includes('sa-lightbox'));
  assert.ok(overlay);
  assert.equal(overlay.attrs.role, 'dialog');
  assert.match(overlay.textContent, /1 из 2/);
  overlay.dispatch('keydown', { key: 'ArrowRight' });
  assert.match(overlay.textContent, /2 из 2/);
  const control = label => [...overlay.walk()].find(n => n.attrs['aria-label'] === label);
  assert.ok(control('Уменьшить') && control('Увеличить') && control('Вписать в экран') && control('Исходный размер'));
  assert.ok(control('Предыдущее изображение') && control('Следующее изображение') && control('Закрыть просмотр'));
  assert.equal(overlay.classList.contains('is-zoomed'), false, 'opens fitted to the screen');
  control('Исходный размер').click();
  assert.equal(overlay.classList.contains('is-zoomed'), true);
  overlay.dispatch('keydown', { key: '0' });
  assert.equal(overlay.classList.contains('is-zoomed'), false);
  const img = [...overlay.walk()].find(n => n.tagName === 'IMG');
  overlay.dispatch('pointerdown', { target: img }); overlay.dispatch('click', { target: img });
  assert.equal(t.doc.body.children.length, 1, 'a click on the picture keeps the viewer open');
  overlay.dispatch('pointerdown', { target: control('Масштаб') }); overlay.dispatch('click', { target: control('Масштаб') });
  assert.equal(t.doc.body.children.length, 1, 'a click on the controls keeps the viewer open');
  overlay.dispatch('pointerdown', { target: img }); overlay.dispatch('click', { target: overlay });
  assert.equal(t.doc.body.children.length, 1, 'a drag that started on the picture does not close');
  overlay.dispatch('pointerdown'); overlay.dispatch('click');
  assert.equal(t.doc.body.children.length, 0, 'a full click beside the picture closes');
  assert.equal(t.doc.activeElement, opener);
  opener.click();
  const reopened = t.doc.body.children.find(n => n.className.includes('sa-lightbox'));
  reopened.dispatch('keydown', { key: 'Escape' });
  assert.equal(t.doc.body.children.length, 0);
  assert.equal(t.doc.activeElement, opener);
});

test('late responses from a previous scope never render into the new scope', async () => {
  let scope = 'A';
  const projectA = deferred();
  const t = setup({ scope: () => scope, routes: {
    'GET /api/storyart/project': () => scope === 'A' ? projectA.promise : { styles: [{ id: 'B_STYLE', name: 'Стиль книги Б' }], workspaceRevision: 'rev-b' },
    'GET /api/storyart/jobs': () => ({ requests: [], workspaceRevision: scope === 'A' ? 'rev-a' : 'rev-b' })
  } });
  t.ws.show(); await flush(2);
  scope = 'B';
  t.ws.scopeChanged(); await flush();
  projectA.resolve({ styles: [{ id: 'A_STYLE', name: 'Стиль книги А' }], workspaceRevision: 'rev-a' });
  await flush();
  assert.match(t.root.textContent, /Стиль книги Б/);
  assert.doesNotMatch(t.root.textContent, /Стиль книги А/);
  assert.equal(t.ws._state().revision, 'rev-b');
  assert.equal(t.ws.restore({ scope: 'A', screen: 'job', jobId: 'job-1' }), false, 'a route from another scope is not restored');
  assert.equal(t.ws.restore({ scope: 'B', screen: 'style', styleId: 'B_STYLE' }), true);
});

test('character gallery keeps categories, exact character images, route state and returns to the character tab without POSTs', async () => {
  const asset = (id, category, url, status = 'APPROVED') => ({ id, category, name: id, url, status });
  const categories = [
    { id: 'identity', assets: [asset('ID_1', 'identity', '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=ID_1'), asset('OTHER', 'identity', '/api/storyart/character-image?styleId=OTHER&characterId=CHAR_X&assetId=OTHER')] },
    { id: 'projections', assets: [asset('PROJ_1', 'projections', '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=PROJ_1')] },
    { id: 'wardrobe', assets: [asset('WARD_1', 'wardrobe', '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=WARD_1', 'SAVED_UNVERIFIED')] },
    { id: 'accessories', assets: [asset('ACC_1', 'accessories', '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=ACC_1')] },
    { id: 'scenes', assets: [asset('SCENE_1', 'scenes', '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=SCENE_1')] }
  ];
  const t = setup({ routes: {
    'GET /api/storyart/styles/KATE_FOX/characters/CHAR_002': () => ({ styleId: 'KATE_FOX', character: { id: 'CHAR_002', name: 'Beal' }, categories, workspaceRevision: 'rev-char' })
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'style', styleId: 'KATE_FOX' }); await flush();
  t.find('BUTTON', 'Персонажи (1)').click();
  t.find('BUTTON', 'Галерея персонажа').click(); await flush();
  assert.equal(t.ws.route().screen, 'character');
  assert.equal(t.ws.route().category, 'identity');
  assert.deepEqual(t.routesSeen.at(-1), { scope: 'author/series/book', screen: 'character', styleId: 'KATE_FOX', jobId: null, characterId: 'CHAR_002', category: 'identity' });
  assert.match(t.root.textContent, /Одобрено/);
  assert.equal(t.nodes().filter(node => node.tagName === 'IMG' && String(node.src).includes('assetId=OTHER')).length, 0);
  t.find('BUTTON', 'Одежда (1)').click(); await flush();
  assert.match(t.root.textContent, /Сохранено, статус не подтверждён/);
  const postsBefore = t.calls.filter(call => call.method === 'POST').length;
  t.find('BUTTON', 'Проекции (1)').click(); await flush();
  assert.equal(t.ws.route().category, 'projections');
  assert.deepEqual(t.routesSeen.at(-1), { scope: 'author/series/book', screen: 'character', styleId: 'KATE_FOX', jobId: null, characterId: 'CHAR_002', category: 'projections' });
  assert.ok(t.nodes().some(node => node.tagName === 'IMG' && String(node.src).includes('assetId=PROJ_1')));
  assert.ok(!t.nodes().some(node => node.tagName === 'IMG' && String(node.src).includes('assetId=ID_1')));
  assert.equal(t.calls.filter(call => call.method === 'POST').length, postsBefore, 'browsing a gallery never generates or uploads');
  t.find('BUTTON', 'К стилю').click(); await flush();
  assert.ok(t.nodes().some(node => node.attrs.role === 'tab' && node.textContent.includes('Персонажи') && node.attrs['aria-selected'] === 'true'));
});

test('character gallery distinguishes loading, empty categories and errors', async () => {
  const pending = deferred();
  const t = setup({ routes: {
    'GET /api/storyart/styles/KATE_FOX/characters/CHAR_002': () => pending.promise
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'character', styleId: 'KATE_FOX', characterId: 'CHAR_002', category: 'scenes' });
  assert.match(t.root.textContent, /Загружаем галерею персонажа/);
  assert.doesNotMatch(t.root.textContent, /пока нет изображений/);
  pending.reject(httpError('персонаж недоступен', 503)); await flush();
  assert.match(t.root.textContent, /Галерея персонажа не загрузилась/);
  assert.doesNotMatch(t.root.textContent, /пока нет изображений/);
  assert.equal(t.ws._state().characters.get(JSON.stringify(['KATE_FOX', 'CHAR_002'])).error.includes('персонаж недоступен'), true);
});

test('a catalogue refresh invalidates an older character reply and reloads the active gallery', async () => {
  const oldReply = deferred();
  let characterReads = 0;
  const gallery = { styleId: 'KATE_FOX', character: { id: 'CHAR_002', name: 'Beal' }, categories: [{ id: 'identity', assets: [{ id: 'NEW', category: 'identity', name: 'Новый', url: '/api/storyart/character-image?styleId=KATE_FOX&characterId=CHAR_002&assetId=NEW', status: 'APPROVED' }] }] };
  const t = setup({ routes: {
    'GET /api/storyart/styles/KATE_FOX/characters/CHAR_002': () => ++characterReads === 1 ? oldReply.promise : { ...gallery, workspaceRevision: 'rev-new' }
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'character', styleId: 'KATE_FOX', characterId: 'CHAR_002' }); await flush(2);
  assert.equal(characterReads, 1);
  t.find('BUTTON', 'Обновить каталог').click(); await flush();
  assert.equal(characterReads, 2, 'refresh immediately reloads the active character');
  oldReply.resolve({ ...gallery, categories: [{ id: 'identity', assets: [] }], workspaceRevision: 'rev-old' });
  await flush();
  assert.equal(t.ws._state().revision, 'rev-new', 'the stale reply cannot replace the current revision');
  assert.ok(t.nodes().some(node => node.tagName === 'IMG' && String(node.src).includes('assetId=NEW')));
});

test('refresh in another book releases a pending character cache before returning', async () => {
  let scope = 'A', reads = 0;
  const oldReply = deferred();
  const gallery = { styleId: 'KATE_FOX', character: { id: 'CHAR_002', name: 'Beal' }, categories: [] };
  const t = setup({ scope: () => scope, routes: {
    'GET /api/storyart/styles/KATE_FOX/characters/CHAR_002': () => ++reads === 1 ? oldReply.promise : { ...gallery, workspaceRevision: 'rev-new' }
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'character', styleId: 'KATE_FOX', characterId: 'CHAR_002' }); await flush(2);
  assert.equal(reads, 1);
  scope = 'B'; t.ws.scopeChanged(); await flush();
  t.find('BUTTON', 'Обновить каталог').click(); await flush();
  oldReply.resolve({ ...gallery, workspaceRevision: 'rev-old' }); await flush();
  scope = 'A'; t.ws.scopeChanged(); await flush();
  assert.equal(reads, 2, 'returning to A sends a new gallery request');
  assert.equal(t.ws._state().revision, 'rev-new');
  assert.doesNotMatch(t.root.textContent, /Загружаем галерею персонажа/);
  assert.notEqual(t.ws._state().characters.get(JSON.stringify(['KATE_FOX', 'CHAR_002'])).loading, true);
});

test('drafts are kept per scope', async () => {
  let scope = 'A';
  const t = setup({ scope: () => scope });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  t.field('Задание').value = 'Черновик книги А'; t.field('Задание').dispatch('input');
  scope = 'B'; t.ws.scopeChanged(); await flush();
  assert.equal(t.ws._state().generation.prompt, '');
  scope = 'A'; t.ws.scopeChanged(); await flush();
  assert.equal(t.ws._state().generation.prompt, 'Черновик книги А');
});

test('launch unavailability is explicit while the catalog stays readable', async () => {
  const t = setup({ routes: { 'GET /api/storyart/project': () => ({ styles: STYLES, capabilities: { available: false, reason: 'Desktop transport не запущен.', uploads: true }, workspaceRevision: 'rev-1' }) } });
  t.ws.show(); await flush();
  assert.match(t.root.textContent, /Desktop transport не запущен/);
  assert.match(t.root.textContent, /KATE_FOX/);
  t.ws.navigate({ screen: 'generate' }); await flush();
  assert.equal(t.nodes().find(n => n.tagName === 'BUTTON' && n.type === 'submit').disabled, true);
});

test('consent carries the hash of the candidate the author saw, even if polling swaps it during confirmation', async () => {
  const confirm = deferred();
  const routes = { 'POST /api/storyart/jobs/job-1/action': () => { throw httpError('Вариант изменился', 409, 'artifact_changed'); } };
  const t = setup({ routes, ask: () => confirm.promise });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'job', jobId: 'job-1' }); await flush();
  t.find('BUTTON', 'Согласовать этот вариант').click(); await flush();
  routes['GET /api/storyart/jobs/job-1'] = () => ({ request: { ...JOB, artifacts: [{ ...JOB.artifacts[0], sha256: 'zzz' }, JOB.artifacts[1]] }, process: PROCESS, workspaceRevision: 'rev-1' });
  t.timers.at(-1).fn(); await flush();
  assert.equal(t.ws._state().details.get('job-1').request.artifacts[0].sha256, 'zzz', 'the poll really replaced the candidate');
  confirm.resolve('confirm'); await flush();
  const posts = () => t.calls.filter(c => c.method === 'POST');
  assert.equal(posts().length, 1);
  assert.deepEqual(posts()[0].body, { workspaceRevision: 'rev-1', action: 'approve', artifactIndex: 0, expectedSha256: 'abc' });
  assert.match(t.root.textContent, /изменился после того, как вы его открыли/);
  assert.doesNotMatch(t.root.textContent, /Согласие отправлено/);
  assert.doesNotMatch(t.root.textContent, /Рабочая область изменилась/, 'artifact_changed is not a revision conflict');
  await flush();
  assert.equal(posts().length, 1, 'consent is never resent automatically');
});

test('every call names its scope and an answer for another scope is not absorbed', async () => {
  const t = setup({ routes: {
    'GET /api/storyart/project': () => ({ styles: [{ id: 'FOREIGN', name: 'Чужой стиль' }], capabilities: { available: true, uploads: true }, workspaceRevision: 'rev-x', clientScope: 'other/series/book' }),
    'GET /api/storyart/jobs': () => ({ requests: [{ ...JOB, title: 'Чужая работа' }], workspaceRevision: 'rev-x', clientScope: 'other/series/book' })
  } });
  t.ws.show(); await flush();
  assert.ok(t.calls.length >= 2);
  assert.ok(t.calls.every(c => c.scope === 'author/series/book'));
  assert.equal(t.ws._state().revision, '', 'a foreign revision is not taken');
  assert.equal(t.ws._state().project, null);
  assert.equal(t.ws._state().jobs, null);
  assert.doesNotMatch(t.root.textContent, /Чужой стиль|Чужая работа/);
  assert.match(t.root.textContent, /другой книге/);
});

test('uploads wait for the workspace revision and send it with the file', async () => {
  let ready = false;
  const t = setup({ routes: {
    'GET /api/storyart/jobs': () => { if (!ready) throw httpError('Сервер недоступен', 503); return { requests: [], workspaceRevision: 'rev-7' }; },
    'GET /api/storyart/project': () => { if (!ready) throw httpError('Сервер недоступен', 503); return { styles: STYLES, capabilities: { available: true, uploads: true }, workspaceRevision: 'rev-7' }; },
    'POST /api/storyart/uploads': () => ({ upload: { id: 'UP_1', url: '/api/storyart/uploads/UP_1' }, workspaceRevision: 'rev-7' })
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  const file = { name: 'a.png', type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([1]).buffer };
  const attach = () => { const input = t.nodes().find(n => n.tagName === 'INPUT' && n.attrs.type === 'file'); input.files = [file]; input.dispatch('change'); };
  const uploads = () => t.calls.filter(c => c.method === 'POST' && c.path === '/api/storyart/uploads');
  attach(); await flush();
  assert.equal(uploads().length, 0, 'no upload before the revision is known');
  assert.match(t.ws._state().generation.uploads[0].error, /Каталог/);
  ready = true;
  t.find('BUTTON', 'Обновить каталог').click(); await flush();
  assert.equal(t.ws._state().revision, 'rev-7');
  attach(); await flush();
  assert.equal(uploads().length, 1);
  assert.deepEqual(uploads()[0].body, { name: 'a.png', base64: 'AQ==', workspaceRevision: 'rev-7' });
  assert.equal(uploads()[0].scope, 'author/series/book');
});

test('same-book revision conflict refreshes the revision and retains the draft without automatic resend', async () => {
  let revision = 'rev-1';
  const t = setup({ routes: {
    'GET /api/storyart/project': () => ({ styles: STYLES, capabilities: { available: true, uploads: true }, workspaceRevision: revision }),
    'POST /api/storyart/uploads': () => { revision = 'rev-2'; throw Object.assign(httpError('Старая ревизия', 409), {code:'workspace_revision_changed'}); }
  } });
  t.ws.show(); await flush(); t.ws.navigate({screen:'generate'}); await flush();
  t.ws._state().generation.prompt = 'Сохранить авторский текст';
  const input = t.nodes().find(n => n.tagName === 'INPUT' && n.attrs.type === 'file');
  input.files = [{name:'a.png',type:'image/png',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer}]; input.dispatch('change'); await flush();
  assert.equal(t.ws._state().revision, 'rev-2');
  assert.equal(t.ws._state().generation.prompt, 'Сохранить авторский текст');
  assert.equal(t.calls.filter(c=>c.method==='POST'&&c.path==='/api/storyart/uploads').length,1);
  assert.match(t.ws._state().generation.uploads[0].error,/Каталог обновлён/);
});

test('an unknown dispatch freezes the exact body: edits never change the retry, and a scope rejection is not an unknown outcome', async () => {
  let attempt = 0;
  const t = setup({ routes: { 'POST /api/storyart/jobs': () => {
    attempt++;
    if (attempt === 1) throw httpError('scope', 409, 'scope_changed');
    if (attempt === 2) throw httpError('Шлюз не ответил', 504);
    return { ok: true, request: { id: 'job-1', kind: 'generation', status: 'dispatching' }, workspaceRevision: 'rev-2' };
  } } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  const style = t.nodes().find(n => n.tagName === 'SELECT');
  style.value = 'KATE_FOX'; style.dispatch('change'); await flush();
  t.field('Название работы').value = 'Река'; t.field('Название работы').dispatch('input');
  t.field('Задание').value = 'Сцена у реки'; t.field('Задание').dispatch('input');
  const form = () => t.nodes().find(n => n.tagName === 'FORM');
  const projectReads = () => t.calls.filter(c => c.path === '/api/storyart/project').length;
  const readsBefore = projectReads();
  form().dispatch('submit'); await flush();
  assert.equal(t.ws._state().generation.unknown, false, 'scope_changed is a definite rejection');
  assert.match(t.root.textContent, /другой книгой/);
  assert.doesNotMatch(t.root.textContent, /Рабочая область изменилась/);
  assert.equal(projectReads(), readsBefore, 'scope_changed does not trigger a revision reload');
  assert.equal(t.field('Задание').disabled, false);
  form().dispatch('submit'); await flush();
  assert.equal(t.ws._state().generation.unknown, true);
  assert.equal(t.field('Задание').disabled, true, 'controls are locked while the outcome is unknown');
  assert.equal(t.field('Задание').value, 'Сцена у реки', 'user text survives');
  assert.ok(t.find('BUTTON', 'Начать новый запрос'));
  t.field('Задание').value = 'Совсем другая сцена'; t.field('Задание').dispatch('input');
  t.field('Название работы').value = 'Другое'; t.field('Название работы').dispatch('input');
  form().dispatch('submit'); await flush();
  const posts = t.calls.filter(c => c.method === 'POST' && c.path === '/api/storyart/jobs');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2].body, posts[1].body, 'the retry is the original body');
  assert.equal(posts[2].body.prompt, 'Сцена у реки');
  assert.equal(posts[2].body.requestId, 'uuid-1');
  assert.equal(t.ws.route().jobId, 'job-1');
});

test('catalogue refresh shows new styles, re-reads style details and keeps the draft', async () => {
  let version = 1;
  const t = setup({ routes: {
    'GET /api/storyart/project': () => ({ styles: version === 1 ? STYLES : [...STYLES, { id: 'NEW_STYLE', name: 'Новый стиль владельца' }], capabilities: { available: true, uploads: true }, workspaceRevision: 'rev-' + version })
  } });
  t.ws.show(); await flush();
  t.ws.navigate({ screen: 'generate' }); await flush();
  const style = t.nodes().find(n => n.tagName === 'SELECT');
  style.value = 'KATE_FOX'; style.dispatch('change'); await flush();
  const prompt = t.field('Задание');
  prompt.value = 'Черновик сцены'; prompt.dispatch('input');
  const detailReads = () => t.calls.filter(c => c.path === '/api/storyart/styles/KATE_FOX').length;
  assert.equal(detailReads(), 1);
  assert.ok(!t.nodes().some(n => n.tagName === 'OPTION' && n.textContent === 'Новый стиль владельца'));
  version = 2;
  t.find('BUTTON', 'Обновить каталог').click(); await flush();
  assert.equal(detailReads(), 2, 'cached style details are invalidated');
  assert.ok(t.nodes().some(n => n.tagName === 'OPTION' && n.textContent === 'Новый стиль владельца'), 'an owner-created style appears without reload');
  assert.equal(t.ws._state().revision, 'rev-2');
  assert.equal(t.field('Задание'), prompt, 'the form was not rebuilt');
  assert.equal(prompt.value, 'Черновик сцены');
  assert.equal(t.ws._state().generation.prompt, 'Черновик сцены');
  assert.equal(t.ws._state().generation.styleId, 'KATE_FOX');
  assert.ok(t.nodes().some(n => n.tagName === 'BUTTON' && n.attrs['aria-label']?.startsWith('Лес')), 'style references are shown again');
});

// Integration with the shell

test('navigation remembers the StoryArt view and route without prose', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  writeNavigation(storage, { view: 'storyart', storyArt: { scope: 'a/b/c', screen: 'job', jobId: 'job-1', prompt: 'private prompt' } });
  const restored = readNavigation(storage);
  assert.equal(restored.view, 'storyart');
  assert.deepEqual(restored.storyArt, { scope: 'a/b/c', screen: 'job', styleId: null, jobId: 'job-1' });
  assert.equal([...values.values()].join('').includes('private'), false);
  assert.equal(normalizeNavigation({ view: 'storyart', storyArt: { scope: 'x', screen: 'nope' } }).storyArt, null);
  assert.equal(PRIMARY_VIEWS.has('storyart'), true);
});

test('the drawer links to the full workspace only when asked, keeping its own buttons in order', () => {
  const doc = { createElement: tag => new FakeElement(doc, tag) };
  const opened = [];
  const withLink = renderStoryArtRequests(doc, [], { origin: ORIGIN, onOpenWorkspace: () => opened.push(1) });
  const buttons = [...withLink.walk()].filter(n => n.tagName === 'BUTTON');
  assert.equal(buttons[0].textContent, 'Обновить список');
  buttons.find(b => b.textContent === 'Открыть мастерскую StoryArt').click();
  assert.deepEqual(opened, [1]);
  const plain = renderStoryArtRequests(doc, [], { origin: ORIGIN });
  assert.equal([...plain.walk()].some(n => n.textContent === 'Открыть мастерскую StoryArt'), false);
});

test('app shell wires the main StoryArt view without touching other routes', () => {
  const app = read('../public/app.js'), html = read('../public/index.html'), css = read('../public/storyart-workspace.css');
  assert.match(html, /data-view="storyart"/);
  assert.match(html, /href="\/storyart-workspace\.css/);
  assert.match(app, /import \{ createStoryArtWorkspace \} from '\.\/storyart-workspace\.js';/);
  assert.match(app, /if \(view === 'storyart'\) \{ special\.append\(storyArt\.root\); storyArt\.show\(\); \}/);
  assert.match(app, /storyArt\.scopeChanged\(\);/);
  assert.match(app, /storyArt\.restore\(savedNavigation\.storyArt\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /https?:\/\/|@import|@font-face/);
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@(?:media|container)[^{]+\{/g, '').replace(/@keyframes[^{]+\{[^}]*\{[^}]*\}[^}]*\{[^}]*\}\s*\}/g, '').match(/[^{}]+(?=\{)/g).map(s => s.trim()).filter(Boolean);
  const splitTop = value => { const out = []; let depth = 0, current = ''; for (const ch of value) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(current); current = ''; } else current += ch; } out.push(current); return out; };
  for (const selector of selectors) for (const part of splitTop(selector)) assert.match(part.trim(), /^(\.storyart-workspace|\.app-shell\.primary-workspace-view #special-view\.storyart-view)/, 'unscoped selector: ' + part);
});


test('generation keeps style thumbnails collapsed and updates selected count without hiding the current choice',async()=>{
  const t=setup();t.ws._state().generation.styleId='KATE_FOX';t.ws.restore({scope:'author/series/book',screen:'generate',styleId:'KATE_FOX'});t.ws.show();await flush();
  const refs=t.nodes().find(n=>n.tagName==='DETAILS'&&n.classList.contains('sa-style-refs'));
  assert.ok(refs);assert.ok(!refs.open);assert.equal(refs.children[0].tagName,'SUMMARY');
  assert.ok([...refs.walk()].some(n=>n.tagName==='IMG'),'visual thumbnails remain available in the expandable selector');
  const choice=[...refs.walk()].find(n=>n.tagName==='BUTTON'&&n.classList.contains('sa-pick'));
  choice.click();assert.match(refs.children[0].textContent,/выбрано 1/);assert.equal(choice.attrs['aria-pressed'],'true');
});


test('returning to a visible generation form resumes reference polling after switching to the agent chat',async()=>{
  const t=setup();t.ws.restore({scope:'author/series/book',screen:'generate'});t.ws.show();await flush();
  const c=t.ws._state().generation.referenceController;let stops=0,resumes=0;
  const oldStop=c.stop,oldResume=c.resume;c.stop=()=>{stops++;oldStop();};c.resume=()=>{resumes++;oldResume();};
  t.doc.visibilityState='hidden';for(const fn of t.doc.listeners.visibilitychange)fn();assert.equal(stops,1);
  t.doc.visibilityState='visible';for(const fn of t.doc.listeners.visibilitychange)fn();assert.equal(resumes,1);
});

test('visual angle buttons switch real previews by click and keyboard without posting or losing focus',async()=>{
  const views=['front','side','high','low','oblique'].map((angle,i)=>({pool:'POSE_ATLAS',id:'p-'+angle,group_id:'p',angle,title:'Наклон',sha256:String(i).repeat(64),role:'STAGING_ONLY',previewUrl:'/api/storyart/reference-image?id=p-'+angle}));
  const t=setup({routes:{'GET /api/storyart/references?offset=0&limit=24&grouped=1':()=>({revision:'r1',total:1,categories:[],pools:[{id:'POSE_ATLAS',roles:['STAGING_ONLY']}],records:[{...views[0],views}]})}});
  t.ws._state().generation.styleId='KATE_FOX';t.ws.restore({scope:'author/series/book',screen:'generate',styleId:'KATE_FOX'});t.ws.show();await flush();
  const toggle=t.nodes().find(n=>n.tagName==='LABEL'&&n.textContent==='Использовать референсы').children[0];toggle.checked=true;toggle.dispatch('change');
  t.find('BUTTON','Вручную').click();await flush();
  const chips=()=>t.nodes().filter(n=>n.classList.contains('sa-angle'));
  assert.equal(chips().length,5);assert.equal(chips().filter(n=>n.attrs['aria-pressed']==='true').length,1);
  chips()[1].click();await flush();assert.equal(chips()[1].attrs['aria-pressed'],'true');
  assert.ok(t.nodes().some(n=>n.tagName==='IMG'&&n.src===views[1].previewUrl));
  chips()[1].dispatch('keydown',{key:'ArrowRight'});await flush();assert.equal(chips()[2].attrs['aria-pressed'],'true');assert.equal(t.doc.activeElement,chips()[2]);
  chips()[2].dispatch('keydown',{key:'End'});await flush();assert.equal(chips()[4].attrs['aria-pressed'],'true');
  assert.equal(t.calls.filter(c=>c.method==='POST').length,0);
});
