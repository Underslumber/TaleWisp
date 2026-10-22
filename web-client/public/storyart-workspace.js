import { storyArtStatusLabel } from './host-workspace.js';

// StoryArt project workspace: style deck, style page, style creation, generation form, jobs and job studio.
// The catalog is shared; jobs, uploads, drafts and selections belong to the TaleWisp scope from getScope().
export const STORYART_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const STORYART_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const STORYART_POLL_MS = 15000;
const SCREENS = new Set(['styles', 'style', 'character', 'create-style', 'generate', 'jobs', 'job']);
export const CHARACTER_CATEGORIES = Object.freeze([
  { id: 'identity', label: 'Персонаж' },
  { id: 'projections', label: 'Проекции' },
  { id: 'wardrobe', label: 'Одежда' },
  { id: 'accessories', label: 'Аксессуары' },
  { id: 'scenes', label: 'Готовые арты с ним (сцены)' }
]);
const characterCategoryIds = new Set(CHARACTER_CATEGORIES.map(item => item.id));
export function characterAssetStatusLabel(status) {
  const value = text(status);
  if (value === 'SAVED_UNVERIFIED') return 'Сохранено, статус не подтверждён';
  if (value === 'APPROVED' || value.startsWith('APPROVED_')) return 'Одобрено';
  if (value === 'TEST') return 'Пробный образец';
  return value;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const text = value => typeof value === 'string' ? value : '';
export const safeId = value => typeof value === 'string' && ID.test(value) ? value : null;
const plural = (n, [one, few, many]) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

export const ASPECT_CHOICES = Object.freeze([['', 'Не выбрано'], ['1:1', '1:1, квадрат'], ['2:3', '2:3, портрет'], ['3:2', '3:2, альбом'], ['16:9', '16:9, широкий кадр'], ['9:16', '9:16, вертикальный кадр']]);
// Only the enum values StoryArt actually accepts.
export const SCENE_CHOICES = Object.freeze([['', 'Не выбрано'], ['LOCATION', 'Локация'], ['PHENOMENON', 'Явление'], ['ARTIFACT', 'Артефакт'], ['MIXED', 'Смешанная сцена']]);
export const OUTPUT_CHOICES = Object.freeze([['', 'Не выбрано'], ['GENERAL_ART', 'Иллюстрация'], ['WALLPAPER', 'Обои'], ['PROMO_POSTER', 'Промо-постер']]);
export const FIDELITY_PRESETS = Object.freeze(['30', '50', '70', '90', '100']);
export const FIDELITY_CHOICES = Object.freeze([['', 'Не выбрано, StoryArt спросит'], ['30', '30: вольная трактовка'], ['50', '50: умеренно'], ['70', '70: свободнее'], ['90', '90: близко к стилю'], ['100', '100: максимально точно'], ['custom', 'Свой вариант']]);
const choiceValues = list => new Set(list.map(([value]) => value).filter(Boolean));

// Readiness says the pack has usable references; approval says whether an anchor was approved. Two separate facts.
const READINESS = { READY: 'Есть референсы', REVIEW_REQUIRED: 'Нужна проверка' };
export const readinessLabel = value => READINESS[text(value)] || text(value);
const APPROVAL = { ANCHOR_APPROVED: 'Есть утверждённый якорь', NO_APPROVED_ANCHOR: 'Нет утверждённого якоря' };
export const approvalLabel = value => APPROVAL[text(value)] || text(value);
const REF_STATUS = { APPROVED: 'Одобрен', ANCHOR: 'Утверждённый якорь', TEST: 'Пробный образец, не утверждён', PUBLISHED_LEGACY: 'Из старой опубликованной библиотеки' };
export const referenceStatusLabel = value => REF_STATUS[text(value)] || text(value);
const ELIGIBILITY = { REVIEW_REQUIRED_NOT_APPROVED: 'Пробный образец: не якорь, требует проверки владельцем', REVALIDATE_FOR_REQUEST: 'StoryArt перепроверит для конкретной работы' };
export const eligibilityLabel = value => ELIGIBILITY[text(value)] || text(value);
export const isTrialReference = ref => ref?.status === 'TEST' || ref?.eligibility === 'REVIEW_REQUIRED_NOT_APPROVED';
// Library filenames carry the role prefix, source UUIDs and upload ids; the card shows only the readable title.
export function referenceDisplayName(name, role = '') {
  const raw = text(name);
  let s = raw.replace(/\.(png|jpe?g|webp)$/i, '');
  const prefix = text(role).toUpperCase() + '_';
  while (role && s.toUpperCase().startsWith(prefix)) s = s.slice(prefix.length);
  s = s.replace(/^cara_[0-9a-f-]{36}_\d+_/i, '').replace(/^[a-z0-9]+-[A-Za-z0-9_-]{21}-/, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || raw;
}

export function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return size + ' Б';
  if (size < 1024 * 1024) return Math.round(size / 1024) + ' КБ';
  return (size / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
}

// Local pre-check only; the server validates the bytes again.
export function validateImageFile(file) {
  if (!file || typeof file !== 'object') return 'Файл не выбран.';
  const name = text(file.name) || 'Файл';
  const type = text(file.type).toLowerCase();
  if (type ? !STORYART_IMAGE_TYPES.includes(type) : !/\.(png|jpe?g|webp)$/i.test(name)) return `«${name}»: подходят только PNG, JPEG или WebP.`;
  if (!Number.isFinite(file.size) || file.size <= 0) return `«${name}»: файл пустой.`;
  if (file.size > STORYART_MAX_UPLOAD_BYTES) return `«${name}»: ${formatBytes(file.size)}, а допустимо не больше 20 МБ.`;
  return '';
}

export function bytesToBase64(bytes, encode = globalThis.btoa) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return encode(binary);
}

// Images come only from same-origin StoryArt routes registered by the server.
export function safeStoryArtUrl(raw, origin = 'http://localhost') {
  if (typeof raw !== 'string' || !raw.startsWith('/api/storyart/')) return '';
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/storyart/')) return '';
    return url.pathname + url.search;
  } catch { return ''; }
}

export function normalizeStoryArtRoute(value) {
  if (!value || typeof value !== 'object' || !SCREENS.has(value.screen)) return null;
  const scope = typeof value.scope === 'string' && value.scope.length <= 1024 ? value.scope : '';
  const styleId = safeId(value.styleId), jobId = safeId(value.jobId);
  const characterId = safeId(value.characterId);
  const category = characterCategoryIds.has(value.category) ? value.category : 'identity';
  let screen = value.screen;
  if (screen === 'style' && !styleId) screen = 'styles';
  if (screen === 'character' && (!styleId || !characterId)) screen = styleId ? 'style' : 'styles';
  if (screen === 'job' && !jobId) screen = 'jobs';
  const route = { scope, screen, styleId, jobId };
  if (screen === 'character') Object.assign(route, { characterId, category });
  return route;
}

export function normalizeStyle(raw) {
  const id = safeId(raw?.id);
  if (!id) return null;
  return {
    id, name: text(raw.name) || id, description: text(raw.description), coverUrl: text(raw.coverUrl), readiness: text(raw.readiness), approvalStatus: text(raw.approvalStatus),
    referenceCount: Number.isInteger(raw.referenceCount) ? raw.referenceCount : null,
    characterCount: Number.isInteger(raw.characterCount) ? raw.characterCount : null
  };
}

export function normalizeReference(raw) {
  const id = safeId(raw?.id);
  if (!id) return null;
  return { id, name: text(raw.name) || id, role: text(raw.role), status: text(raw.status), url: text(raw.url), useFor: text(raw.useFor), doNotUseFor: text(raw.doNotUseFor), sha256: text(raw.sha256), eligibility: text(raw.eligibility), previewReason: text(raw.previewReason) };
}

export function filterStyles(styles, query) {
  const list = Array.isArray(styles) ? styles : [];
  const q = text(query).trim().toLocaleLowerCase('ru');
  if (!q) return list;
  return list.filter(style => [style.name, style.id, style.description].some(value => text(value).toLocaleLowerCase('ru').includes(q)));
}

export const kindLabel = kind => ({ generation: 'Иллюстрация', character_create: 'Новый персонаж', style_create: 'Новый стиль' })[kind] || 'Работа StoryArt';
const JOB_STATUS = { accepted: 'Передано StoryArt', dispatched: 'Передано StoryArt', queued: 'В очереди StoryArt', waiting: 'Ждёт решения', waiting_author: 'Ждёт вашего решения', blocked: 'Нужен ответ' };
export const jobStatusLabel = status => JOB_STATUS[status] || storyArtStatusLabel(status);
export function statusTone(status) {
  if (['error', 'failed'].includes(status)) return 'error';
  if (['unknown', 'unknown_outcome'].includes(status) || !status) return 'unknown';
  if (status === 'completed') return 'done';
  if (['waiting', 'waiting_author', 'blocked'].includes(status)) return 'wait';
  if (['cancelled', 'interrupted'].includes(status)) return 'idle';
  return 'live';
}
const STAGES = { '01_face_identity': 'Лицо и узнаваемость', '02_physique_front': 'Телосложение: спереди', '03_physique_side': 'Телосложение: сбоку', '04_physique_back': 'Телосложение: со спины', '05_character_assembly': 'Сборка персонажа', face: 'Лицо', front: 'Вид спереди', side: 'Вид сбоку', back: 'Вид со спины', assembly: 'Сборка листа', intake: 'Приём запроса', plan: 'План', prepare: 'Подготовка', references: 'Подбор референсов', generate: 'Генерация', generation: 'Генерация', visual_qa: 'Визуальная проверка', canon_qa: 'Проверка канона', approval: 'Согласие автора', author_approval: 'Согласие автора', ingest: 'Приём исходников', classify: 'Разбор исходников', profile: 'Профиль стиля', finalize: 'Завершение', save: 'Сохранение' };
export const stageLabel = id => STAGES[text(id).toLowerCase()] || text(id) || 'Этап без названия';
const STAGE_STATUS = { pending: 'Впереди', todo: 'Впереди', running: 'Идёт', active: 'Идёт', in_progress: 'Идёт', inprogress: 'Идёт', done: 'Готово', completed: 'Готово', passed: 'Пройдено', failed: 'Ошибка', error: 'Ошибка', blocked: 'Ждёт решения', waiting: 'Ждёт решения', skipped: 'Пропущено' };
export const stageStatusLabel = status => STAGE_STATUS[text(status).toLowerCase()] || 'Неизвестно';
const QA = { pass: 'пройдена', passed: 'пройдена', ok: 'пройдена', fail: 'не пройдена', failed: 'не пройдена', pending: 'ожидает', running: 'идёт', approved: 'есть', rejected: 'отказ', not_required: 'не требуется' };
export function qaLabel(value) {
  const raw = value && typeof value === 'object' ? text(value.status) : text(value);
  if (!raw) return 'нет данных';
  return QA[raw.toLowerCase()] || raw;
}

export function normalizeArtifacts(job, origin) {
  return (Array.isArray(job?.artifacts) ? job.artifacts : []).map((artifact, i) => ({
    index: Number.isInteger(artifact?.index) && artifact.index >= 0 ? artifact.index : i,
    label: text(artifact?.label) || `Вариант ${i + 1}`,
    url: safeStoryArtUrl(artifact?.url, origin),
    sha256: text(artifact?.sha256)
  }));
}

// Three separate facts: what the author chose, what StoryArt planned, what the executed call recorded.
export function referenceBuckets(process) {
  const list = value => Array.isArray(value) ? value.map(normalizeReference).filter(Boolean) : null;
  return {
    available: process?.available === true,
    reason: text(process?.reason),
    selected: list(process?.selectedReferences) || [],
    prepared: list(process?.preparedReferences),
    executed: list(process?.executedReferences)
  };
}

export function buildJobRequest(draft, { revision, styles = [], detail = null } = {}) {
  if (!draft || typeof draft !== 'object') return { error: 'Форма не заполнена.' };
  if (!text(revision)) return { error: NO_REVISION };
  const requestId = safeId(draft.requestId);
  if (!requestId) return { error: 'Номер запроса повреждён. Очистите форму и заполните её заново.' };
  const prompt = text(draft.prompt).trim();
  const uploads = Array.isArray(draft.uploads) ? draft.uploads : [];
  if (uploads.some(item => item.status === 'reading' || item.status === 'uploading')) return { error: 'Дождитесь окончания загрузки файлов.' };
  const uploadIds = uploads.filter(item => item.status === 'ready' && safeId(item.upload?.id)).map(item => item.upload.id);
  if (draft.kind === 'style_create') {
    const styleName = text(draft.styleName).trim();
    if (!styleName) return { error: 'Назовите стиль.' };
    if (styleName.length > 80) return { error: 'Название стиля длиннее 80 знаков.' };
    if (!prompt) return { error: 'Опишите замысел стиля.' };
    if (!uploadIds.length) return { error: 'Добавьте хотя бы одно исходное изображение.' };
    return { body: { requestId, workspaceRevision: revision, kind: 'style_create', title: 'Новый стиль: ' + styleName, styleName, prompt, uploadIds } };
  }
  if (!['generation', 'character_create'].includes(draft.kind)) return { error: 'Выберите, что создаём.' };
  const styleId = safeId(draft.styleId);
  if (!styleId || !styles.some(style => style.id === styleId)) return { error: 'Выберите стиль из каталога.' };
  const title = text(draft.title).trim();
  if (!title) return { error: 'Назовите работу, чтобы найти её в списке.' };
  if (!prompt) return { error: 'Опишите задание для StoryArt.' };
  const own = detail && detail.style?.id === styleId ? detail : null;
  const referenceIds = [...new Set((Array.isArray(draft.referenceIds) ? draft.referenceIds : []).filter(safeId))];
  if (referenceIds.length && !own) return { error: 'Описание стиля ещё загружается. Повторите через мгновение.' };
  if (referenceIds.some(id => !own.references.some(ref => ref.id === id))) return { error: 'Часть выбранных референсов не относится к этому стилю. Проверьте выбор.' };
  const body = { requestId, workspaceRevision: revision, kind: draft.kind, title, styleId, prompt, referenceIds, uploadIds, options: {} };
  if (draft.kind === 'generation' && draft.characterId) {
    if (!own || !own.characters.some(item => item.id === draft.characterId)) return { error: 'Выбранный персонаж не найден в этом стиле.' };
    body.characterId = draft.characterId;
  }
  const o = draft.options || {};
  body.options.bodyLibrary = o.bodyLibrary === 'on' ? 'on' : 'off';
  if (choiceValues(ASPECT_CHOICES).has(o.aspectRatio)) body.options.aspectRatio = o.aspectRatio;
  if (FIDELITY_PRESETS.includes(o.fidelity)) body.options.fidelity = o.fidelity;
  else if (o.fidelity === 'custom') {
    const custom = text(o.fidelityCustom).trim();
    if (!custom) return { error: 'Опишите свою степень переноса стиля или выберите готовый вариант.' };
    if (custom.length > 200) return { error: 'Описание степени переноса длиннее 200 знаков.' };
    body.options.fidelity = custom;
  }
  if (choiceValues(SCENE_CHOICES).has(o.sceneKind)) body.options.sceneKind = o.sceneKind;
  if (choiceValues(OUTPUT_CHOICES).has(o.outputUse)) body.options.outputUse = o.outputUse;
  return { body };
}

export const STORYART_SCOPE_HEADER = 'x-storyart-scope';
// Server answers are told apart by code: a 409 is not automatically a workspace revision conflict.
export function storyArtErrorKind(error) {
  const code = text(error?.code);
  if (code === 'scope_changed') return 'scope';
  if (code === 'request_payload_conflict') return 'payload';
  if (code === 'artifact_changed') return 'artifact';
  if (code === 'unknown_outcome' || error?.unknownOutcome === true) return 'unknown';
  if (error?.status === 409) return 'revision';
  if (!error?.status || error.status >= 500) return 'unknown';
  return '';
}
const NO_REVISION = 'Каталог StoryArt ещё не загружен. Обновите раздел и повторите.';
const SCOPE_CHANGED = 'Сервер сейчас работает с другой книгой: её могли выбрать в другой вкладке. Запрос не выполнен. Выберите книгу заново или обновите страницу.';

export function createStoryArtWorkspace({ document, window, root, api, notify = () => {}, getScope = () => '', ask = null, renderMarkdown = null, isActive = () => true, onRouteChange = () => {} }) {
  const origin = window?.location?.origin || 'http://localhost';
  const scopes = new Map(), styleCache = new Map();
  let shown = false, pollTimer = null, regions = {}, lightbox = null, catalogEpoch = 0;
  root.classList.add('storyart-workspace');

  const uuid = () => window?.crypto?.randomUUID?.() || 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  // pendingBody is the exact body of a dispatch with an unknown outcome; a retry resends it unchanged.
  const newGenerationDraft = (styleId = '', kind = 'generation') => ({ kind, requestId: uuid(), title: '', styleId, characterId: '', referenceIds: [], prompt: '', options: { aspectRatio: '', fidelity: '', fidelityCustom: '', bodyLibrary: 'off', sceneKind: '', outputUse: '' }, optionsOpen: false, uploads: [], submitting: false, error: '', errorKind: '', unknown: false, pendingBody: null });
  const newStyleDraft = () => ({ kind: 'style_create', requestId: uuid(), step: 1, styleName: '', prompt: '', uploads: [], submitting: false, error: '', errorKind: '', unknown: false, pendingBody: null });
  function scopeState(key = getScope()) {
    if (!scopes.has(key)) scopes.set(key, {
      key, project: null, projectError: '', projectLoading: false, revision: '',
      jobs: null, jobsError: '', jobsLoading: false, details: new Map(), detailErrors: new Map(), detailLoading: new Set(),
      characters: new Map(),
      generation: newGenerationDraft(), styleCreate: newStyleDraft(), corrections: new Map(), consent: new Map(),
      jobBusy: new Map(), actionErrors: new Map(), actionNotes: new Map(), selectedArtifact: new Map(),
      route: { screen: 'styles', styleId: null, jobId: null, characterId: null, category: 'identity' }, stylesQuery: '', jobsFilter: 'all', styleTab: 'profile', jobPane: 'result'
    });
    return scopes.get(key);
  }
  const live = s => shown && s.key === getScope();
  const takeRevision = (s, result) => { if (typeof result?.workspaceRevision === 'string' && result.workspaceRevision) s.revision = result.workspaceRevision; };
  const styles = s => s.project?.styles || [];
  const capabilities = s => s.project?.capabilities || null;
  const launchBlocked = s => capabilities(s)?.available === false ? (capabilities(s).reason || 'StoryArt сейчас не принимает запросы.') : '';
  const uploadsBlocked = s => capabilities(s)?.uploads === false ? 'Загрузка файлов сейчас недоступна на сервере.' : '';
  const errorText = error => error?.code === 'scope_changed' ? SCOPE_CHANGED : text(error?.message) || 'Неизвестная ошибка.';

  // Every JSON call names the scope it belongs to; an answer for another scope is never absorbed.
  async function call(s, path, options = {}) {
    const r = await api(path, { ...options, headers: { ...(options.headers || {}), [STORYART_SCOPE_HEADER]: s.key } });
    if (r && typeof r === 'object' && typeof r.clientScope === 'string' && r.clientScope !== s.key) {
      throw Object.assign(Error('Ответ сервера относится к другой книге и не принят.'), { code: 'foreign_scope' });
    }
    return r;
  }
  // While a dispatch outcome is unknown the form is frozen: a retry must send exactly what may already exist.
  function lockControls(node) {
    if (!node) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) || (node.tagName === 'BUTTON' && (node.classList?.contains('sa-pick') || node.classList?.contains('sa-upload-remove')))) node.disabled = true;
    [...(node.children || [])].forEach(lockControls);
  }
  const lockIf = (draft, nodes) => { if (draft.unknown) [nodes].flat().forEach(lockControls); return nodes; };

  // DOM helpers. All server strings go through textContent.
  function el(tag, cls, value, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (value !== undefined && value !== null && value !== '') n.textContent = String(value);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v)); });
    return n;
  }
  function button(label, cls, onClick, attrs) { const b = el('button', cls || 'sa-button', label, attrs); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; }
  function picture(url, alt, fallback, cls = 'sa-picture') {
    const frame = el('div', cls);
    const safe = safeStoryArtUrl(url, origin);
    const missing = () => { frame.classList.add('is-missing'); frame.replaceChildren(el('span', 'sa-missing', fallback)); };
    if (!safe) { missing(); return frame; }
    const img = el('img'); img.src = safe; img.alt = alt; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', missing);
    frame.append(img);
    return frame;
  }
  function notice(kind, title, copy, ...actions) {
    const box = el('div', 'sa-notice sa-notice-' + kind, '', { role: kind === 'error' ? 'alert' : 'status' });
    box.append(el('strong', '', title));
    if (copy) box.append(el('p', '', copy));
    if (actions.length) { const row = el('div', 'sa-row'); row.append(...actions); box.append(row); }
    return box;
  }
  function chip(label, tone) { return el('span', 'sa-chip' + (tone ? ' sa-tone-' + tone : ''), label); }
  function markdown(container, value) { if (renderMarkdown) renderMarkdown(container, value); else container.textContent = value; return container; }
  const date = value => { const d = new Date(value); return value && !isNaN(d) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d) : ''; };
  function region(name, cls, build) { const box = el('div', cls); regions[name] = { box, build }; fill(name); return box; }
  function fill(name) { const r = regions[name]; if (!r) return; r.box.replaceChildren(...[r.build()].flat().filter(Boolean)); }
  function refresh(s, ...names) { if (live(s)) names.forEach(fill); }

  // Routing and persistence.
  function routeSnapshot(s = scopeState()) {
    const route = { scope: s.key, screen: s.route.screen, styleId: s.route.styleId, jobId: s.route.jobId };
    if (s.route.screen === 'character') Object.assign(route, { characterId: s.route.characterId, category: s.route.category });
    return route;
  }
  function navigate(s, route, { persist = true } = {}) {
    const next = normalizeStoryArtRoute({ scope: s.key, ...route });
    if (!next) return;
    s.route = { screen: next.screen, styleId: next.styleId, jobId: next.jobId, characterId: next.characterId, category: next.category };
    if (persist) onRouteChange(routeSnapshot(s));
    if (live(s)) { render(); load(s); root.scrollTop = 0; }
  }
  function load(s) {
    if (!s.project && !s.projectLoading) loadProject(s);
    const { screen, styleId, jobId } = s.route;
    if (screen === 'style' && styleId) loadStyle(s, styleId);
    if (screen === 'character' && styleId && s.route.characterId) loadCharacter(s, styleId, s.route.characterId);
    if (screen === 'generate' && s.generation.styleId) loadStyle(s, s.generation.styleId);
    if (['styles', 'jobs', 'style'].includes(screen) && !s.jobs && !s.jobsLoading) loadJobs(s);
    if (screen === 'job' && jobId) loadDetail(s, jobId);
  }

  // Data loading. Results always land in the scope that asked; only the live scope re-renders.
  async function loadProject(s, force = false) {
    if (s.projectLoading || (s.project && !force)) return;
    const hadProject = !!s.project;
    s.projectLoading = true; s.projectError = ''; refresh(s, 'banner');
    if (live(s) && s.route.screen === 'styles') fill('grid');
    try {
      const r = await call(s, '/api/storyart/project');
      s.project = { styles: (Array.isArray(r?.styles) ? r.styles : []).map(normalizeStyle).filter(Boolean), capabilities: r?.capabilities && typeof r.capabilities === 'object' ? { available: r.capabilities.available === true, reason: text(r.capabilities.reason), uploads: r.capabilities.uploads !== false } : null };
      takeRevision(s, r);
    } catch (e) { s.projectError = errorText(e); }
    finally {
      s.projectLoading = false;
      // A refresh must not rebuild a form or job page the author is typing in.
      if (live(s)) { if (hadProject && ['generate', 'create-style', 'job'].includes(s.route.screen)) ['banner', 'formStatus', 'submit', 'styleSelect'].forEach(fill); else render(); }
    }
  }
  async function loadJobs(s) {
    if (s.jobsLoading) return;
    s.jobsLoading = true; s.jobsError = ''; refresh(s, 'jobs');
    try {
      const r = await call(s, '/api/storyart/jobs');
      s.jobs = (Array.isArray(r?.requests) ? r.requests : []).filter(job => safeId(job?.id));
      takeRevision(s, r);
    } catch (e) { s.jobsError = errorText(e); }
    finally { s.jobsLoading = false; refresh(s, 'jobs'); if (live(s) && s.route.screen === 'style') fill('style'); }
  }
  async function loadStyle(s, styleId) {
    const cached = styleCache.get(styleId);
    if (cached?.loading || cached?.data) return;
    const epoch = catalogEpoch;
    styleCache.set(styleId, { loading: true });
    let entry;
    try {
      const r = await call(s, '/api/storyart/styles/' + encodeURIComponent(styleId));
      const style = normalizeStyle(r?.style);
      if (!style || style.id !== styleId) throw Error('StoryArt вернул описание другого стиля.');
      entry = { data: { style, profile: text(r.profile), negative: text(r.negative), references: (Array.isArray(r.references) ? r.references : []).map(normalizeReference).filter(Boolean), characters: (Array.isArray(r.characters) ? r.characters : []).filter(c => safeId(c?.id)).map(c => ({ id: c.id, name: text(c.name) || c.id, coverUrl: safeStoryArtUrl(c.coverUrl, origin) })) } };
    } catch (e) { entry = { error: errorText(e) }; }
    // A catalogue refresh started meanwhile: this answer may predate it.
    if (epoch !== catalogEpoch) return;
    styleCache.set(styleId, entry);
    const current = scopeState();
    if (live(current) && (current.route.styleId === styleId || current.generation.styleId === styleId)) {
      if (current.route.screen === 'style') fill('style');
      if (current.route.screen === 'generate') fill('styleBound');
    }
  }
  async function loadDetail(s, jobId, { quiet = false } = {}) {
    if (s.detailLoading.has(jobId)) return;
    s.detailLoading.add(jobId);
    if (!quiet) refresh(s, 'jobHead');
    try {
      const r = await call(s, '/api/storyart/jobs/' + encodeURIComponent(jobId));
      if (!r?.request || safeId(r.request.id) !== jobId) throw Error('StoryArt вернул другую работу.');
      s.details.set(jobId, { request: r.request, process: r.process && typeof r.process === 'object' ? r.process : null, loadedAt: Date.now() });
      s.detailErrors.delete(jobId);
      takeRevision(s, r);
      if (Array.isArray(s.jobs)) { const i = s.jobs.findIndex(job => job.id === jobId); if (i >= 0) s.jobs[i] = r.request; }
    } catch (e) { s.detailErrors.set(jobId, errorText(e)); }
    finally {
      s.detailLoading.delete(jobId);
      if (live(s) && s.route.screen === 'job' && s.route.jobId === jobId) { ['jobHead', 'stage', 'gallery', 'process', 'refs', 'jobActions'].forEach(fill); schedulePoll(s, jobId); }
    }
  }

  async function loadCharacter(s, styleId, characterId, force = false) {
    const key = JSON.stringify([styleId, characterId]);
    const current = s.characters.get(key);
    if (current?.loading || (current?.data && !force)) return;
    const epoch = catalogEpoch;
    const entry = { loading: true };
    s.characters.set(key, entry);
    refresh(s, 'character');
    try {
      const r = await call(s, '/api/storyart/styles/' + encodeURIComponent(styleId) + '/characters/' + encodeURIComponent(characterId));
      if (epoch !== catalogEpoch || s.characters.get(key) !== entry) return;
      if (r?.styleId !== styleId || safeId(r?.character?.id) !== characterId) throw Error('StoryArt вернул галерею другого персонажа или стиля.');
      takeRevision(s, r);
      const categories = new Map((Array.isArray(r.categories) ? r.categories : []).map(item => [item?.id, item]));
      const ownedAssetUrl = asset => {
        const safe = safeStoryArtUrl(asset?.url, origin);
        if (!safe) return '';
        const url = new URL(safe, origin);
        return url.pathname === '/api/storyart/character-image' && url.searchParams.get('styleId') === styleId &&
          url.searchParams.get('characterId') === characterId && url.searchParams.get('assetId') === asset.id ? safe : '';
      };
      const data = {
        styleId,
        character: { id: characterId, name: text(r.character.name) || characterId, coverUrl: safeStoryArtUrl(r.character.coverUrl, origin) },
        categories: CHARACTER_CATEGORIES.map(def => {
          const raw = categories.get(def.id);
          const assets = Array.isArray(raw?.assets) ? raw.assets.filter(asset =>
            safeId(asset?.id) && (!asset.category || asset.category === def.id) && ownedAssetUrl(asset)
          ).map(asset => ({
            id: asset.id, category: characterCategoryIds.has(asset.category) ? asset.category : def.id,
            name: text(asset.name) || asset.id, status: text(asset.status), description: text(asset.description),
            source: text(asset.source), url: ownedAssetUrl(asset), previewReason: text(asset.previewReason)
          })) : [];
          return { ...def, assets };
        })
      };
      if (epoch !== catalogEpoch || s.characters.get(key) !== entry) return;
      s.characters.set(key, { data });
    } catch (error) {
      if (epoch !== catalogEpoch || s.characters.get(key) !== entry) return;
      s.characters.set(key, { error: errorText(error) });
    }
    if (live(s) && s.route.screen === 'character' && s.route.styleId === styleId && s.route.characterId === characterId) fill('character');
  }

  // Manual catalogue refresh: new styles appear without a reload, style pages are re-read, drafts stay as typed.
  function refreshCatalog(s) {
    catalogEpoch++;
    for (const scope of scopes.values()) scope.characters.clear();
    styleCache.clear();
    loadProject(s, true);
    if (!live(s)) return;
    if (s.route.screen === 'style' && s.route.styleId) { loadStyle(s, s.route.styleId); fill('style'); }
    if (s.route.screen === 'character' && s.route.styleId && s.route.characterId) loadCharacter(s, s.route.styleId, s.route.characterId);
    if (s.route.screen === 'generate') fill('styleBound');
  }

  // Detail polling: GET only, visible tab, online, open job. Never creates StoryArt turns.
  function stopPoll() { if (pollTimer !== null) window.clearTimeout(pollTimer); pollTimer = null; }
  function canPoll(s, jobId) {
    const status = s.details.get(jobId)?.request?.status;
    return live(s) && isActive() && document.visibilityState !== 'hidden' && window.navigator?.onLine !== false &&
      s.route.screen === 'job' && s.route.jobId === jobId && !['error', 'failed', 'cancelled', 'interrupted'].includes(status);
  }
  function schedulePoll(s, jobId) {
    stopPoll();
    if (!canPoll(s, jobId)) return;
    pollTimer = window.setTimeout(() => { pollTimer = null; if (canPoll(s, jobId)) loadDetail(s, jobId, { quiet: true }); }, STORYART_POLL_MS);
  }
  document.addEventListener?.('visibilitychange', () => {
    const s = scopeState();
    if (document.visibilityState === 'hidden') stopPoll();
    else if (s.route.screen === 'job' && s.route.jobId) schedulePoll(s, s.route.jobId);
  });

  // Full render of the current scope's screen.
  function render() {
    const s = scopeState();
    closeLightbox(false);
    stopPoll();
    regions = {};
    root.replaceChildren(header(s), region('banner', 'sa-banner', () => banner(s)), screen(s));
    if (s.route.screen === 'job' && s.details.has(s.route.jobId)) schedulePoll(s, s.route.jobId);
  }
  function header(s) {
    const head = el('header', 'sa-head');
    const brand = el('div', 'sa-brand');
    brand.append(el('h1', 'sa-title', 'StoryArt'), el('p', 'sa-sub', 'Стили и иллюстрации книги'));
    const tabs = el('nav', 'sa-tabs', '', { 'aria-label': 'Разделы StoryArt' });
    const section = ['styles', 'style', 'character', 'create-style'].includes(s.route.screen) ? 'styles' : 'jobs';
    [['styles', 'Стили'], ['jobs', 'Работы']].forEach(([screen, label]) => {
      tabs.append(button(label, 'sa-tab', () => navigate(s, { screen }), { 'aria-current': section === screen ? 'page' : null }));
    });
    const actions = el('div', 'sa-head-actions');
    actions.append(
      button('Обновить каталог', 'sa-button sa-button-quiet', () => refreshCatalog(s)),
      button('Создать стиль', 'sa-button sa-button-quiet', () => navigate(s, { screen: 'create-style' })),
      button('Новая генерация', 'sa-button sa-button-gold', () => navigate(s, { screen: 'generate' }))
    );
    head.append(brand, tabs, actions);
    return head;
  }
  function banner(s) {
    const out = [];
    if (window.navigator?.onLine === false) out.push(notice('wait', 'Нет сети', 'Показаны последние загруженные данные. Действия отправятся, когда связь вернётся и вы повторите их.'));
    const blocked = launchBlocked(s);
    if (blocked) out.push(notice('wait', 'Запуск в StoryArt сейчас недоступен', blocked + ' Каталог и прежние работы можно смотреть.'));
    if (s.projectError && s.project) out.push(notice('error', 'Каталог не обновился', s.projectError, button('Повторить', 'sa-button sa-button-quiet', () => loadProject(s, true))));
    return out;
  }
  function screen(s) {
    const { screen } = s.route;
    const box = el('div', 'sa-screen sa-screen-' + screen);
    if (screen === 'styles') box.append(...stylesScreen(s));
    else if (screen === 'style') box.append(...styleScreen(s));
    else if (screen === 'character') box.append(region('character', 'sa-character-region', () => characterScreen(s)));
    else if (screen === 'create-style') box.append(...createStyleScreen(s));
    else if (screen === 'generate') box.append(...generateScreen(s));
    else if (screen === 'jobs') box.append(...jobsScreen(s));
    else if (screen === 'job') box.append(...jobScreen(s));
    return box;
  }
  const back = (label, onClick) => button(label, 'sa-back', onClick);

  // Styles: the deck.
  function stylesScreen(s) {
    const intro = el('div', 'sa-intro');
    intro.append(el('h2', 'sa-h2', 'Стили'), el('p', 'sa-lead', 'Откройте стиль, чтобы прочитать описание, посмотреть референсы и персонажей.'));
    const search = el('label', 'sa-search');
    const input = el('input', '', '', { type: 'search', placeholder: 'Найти стиль по названию или описанию', 'aria-label': 'Найти стиль' });
    input.value = s.stylesQuery;
    input.addEventListener('input', () => { s.stylesQuery = input.value; fill('grid'); });
    search.append(input);
    intro.append(search);
    const recent = el('section', 'sa-recent', '', { 'aria-label': 'Последние работы' });
    recent.append(region('jobs', 'sa-recent-body', () => recentJobs(s)));
    return [intro, region('grid', 'sa-deck', () => styleGrid(s)), recent];
  }
  function styleGrid(s) {
    if (!s.project) {
      if (s.projectError) return notice('error', 'Каталог стилей не загрузился', s.projectError, button('Повторить', 'sa-button sa-button-quiet', () => loadProject(s, true)));
      return el('p', 'sa-loading', 'Загружаем каталог стилей…', { role: 'status' });
    }
    if (!styles(s).length) return notice('info', 'В StoryArt пока нет готовых стилей', 'Создайте стиль из своих исходных изображений.', button('Создать стиль', 'sa-button sa-button-gold', () => navigate(s, { screen: 'create-style' })));
    const found = filterStyles(styles(s), s.stylesQuery);
    if (!found.length) return notice('info', `Ничего не найдено по запросу «${s.stylesQuery.trim()}»`, 'Проверьте написание или очистите поиск.');
    const list = el('ul', 'sa-deck-grid');
    found.forEach(style => { const li = el('li'); li.append(styleCard(s, style)); list.append(li); });
    return list;
  }
  function styleCard(s, style) {
    const card = button('', 'sa-card', () => navigate(s, { screen: 'style', styleId: style.id }), { 'aria-label': `Открыть стиль ${style.name}` });
    card.append(picture(style.coverUrl, '', 'Образца нет', 'sa-card-art'));
    const plaque = el('span', 'sa-card-plaque');
    plaque.append(el('span', 'sa-card-name', style.name));
    if (style.description) plaque.append(el('span', 'sa-card-desc', style.description));
    const meta = el('span', 'sa-card-meta');
    if (style.readiness) meta.append(chip(readinessLabel(style.readiness), style.readiness === 'READY' ? 'done' : 'wait'));
    if (style.approvalStatus) meta.append(chip(approvalLabel(style.approvalStatus), style.approvalStatus === 'ANCHOR_APPROVED' ? 'done' : 'wait'));
    if (style.referenceCount !== null) meta.append(el('span', '', `${style.referenceCount} ${plural(style.referenceCount, ['референс', 'референса', 'референсов'])}`));
    if (style.characterCount) meta.append(el('span', '', `${style.characterCount} ${plural(style.characterCount, ['персонаж', 'персонажа', 'персонажей'])}`));
    plaque.append(meta);
    card.append(plaque);
    return card;
  }
  function recentJobs(s) {
    const head = el('div', 'sa-section-head');
    head.append(el('h2', 'sa-h3', 'Последние работы'), button('Все работы', 'sa-button sa-button-quiet', () => navigate(s, { screen: 'jobs' })));
    if (s.jobsError) return [head, notice('error', 'Список работ не загрузился', s.jobsError, button('Повторить', 'sa-button sa-button-quiet', () => loadJobs(s)))];
    if (!s.jobs) return [head, el('p', 'sa-loading', 'Загружаем работы…', { role: 'status' })];
    if (!s.jobs.length) return [head, el('p', 'sa-quiet', 'В этой книге работ StoryArt пока нет.')];
    const list = el('ul', 'sa-job-grid sa-job-grid-compact');
    s.jobs.slice(0, 4).forEach(job => { const li = el('li'); li.append(jobCard(s, job)); list.append(li); });
    return [head, list];
  }

  // Style page.
  function styleScreen(s) {
    const styleId = s.route.styleId;
    return [back('Все стили', () => navigate(s, { screen: 'styles' })), region('style', 'sa-style', () => styleBody(s, styleId))];
  }
  function styleBody(s, styleId) {
    const summary = styles(s).find(style => style.id === styleId);
    const cached = styleCache.get(styleId);
    if (cached?.error) return notice('error', 'Описание стиля не загрузилось', cached.error, button('Повторить', 'sa-button sa-button-quiet', () => { styleCache.delete(styleId); loadStyle(s, styleId); fill('style'); }));
    if (!cached?.data) {
      if (s.project && !summary) return notice('error', 'Стиль не найден в каталоге', 'Он мог быть переименован в StoryArt. Вернитесь к списку стилей.');
      return el('p', 'sa-loading', 'Загружаем стиль…', { role: 'status' });
    }
    const { style, references, characters } = cached.data;
    const cover = el('figure', 'sa-style-cover');
    const coverArt = picture(style.coverUrl || summary?.coverUrl, `Образец стиля ${style.name}`, 'Образец не выбран в реестре стиля', 'sa-style-art');
    const coverUrl = safeStoryArtUrl(style.coverUrl || summary?.coverUrl, origin);
    if (coverUrl) { const open = button('', 'sa-art-button', e => openLightbox([{ url: coverUrl, label: `Образец стиля ${style.name}` }], 0, e?.currentTarget || open), { 'aria-label': 'Открыть образец крупно' }); open.append(coverArt); cover.append(open); }
    else cover.append(coverArt);
    const body = el('div', 'sa-style-body');
    const titleRow = el('div', 'sa-style-title');
    titleRow.append(el('h2', 'sa-h2', style.name));
    if (style.readiness) titleRow.append(chip(readinessLabel(style.readiness), style.readiness === 'READY' ? 'done' : 'wait'));
    const approval = style.approvalStatus || summary?.approvalStatus;
    if (approval) titleRow.append(chip(approvalLabel(approval), approval === 'ANCHOR_APPROVED' ? 'done' : 'wait'));
    body.append(titleRow);
    if (style.description || summary?.description) body.append(el('p', 'sa-lead', style.description || summary.description));
    const actions = el('div', 'sa-row');
    actions.append(
      button('Новая генерация в этом стиле', 'sa-button sa-button-gold', () => startGeneration(s, styleId, 'generation')),
      button('Создать персонажа', 'sa-button sa-button-quiet', () => startGeneration(s, styleId, 'character_create'))
    );
    body.append(actions);
    const tabs = el('div', 'sa-segment', '', { role: 'tablist', 'aria-label': 'Сведения о стиле' });
    const panel = el('div', 'sa-tabpanel', '', { role: 'tabpanel' });
    const styleJobs = (s.jobs || []).filter(job => job.styleId === styleId);
    const defs = [['profile', 'Описание'], ['references', `Референсы (${references.length})`], ['characters', `Персонажи (${characters.length})`], ['jobs', `Работы (${styleJobs.length})`]];
    const show = tab => {
      s.styleTab = tab;
      tabButtons.forEach(([id, b]) => { b.setAttribute('aria-selected', String(id === tab)); b.tabIndex = id === tab ? 0 : -1; });
      panel.replaceChildren(...stylePanel(s, tab, cached.data, styleJobs));
    };
    const tabButtons = defs.map(([id, label]) => { const b = button(label, 'sa-segment-item', () => show(id), { role: 'tab' }); tabs.append(b); return [id, b]; });
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const i = defs.findIndex(([id]) => id === s.styleTab), next = defs[(i + (event.key === 'ArrowRight' ? 1 : defs.length - 1)) % defs.length][0];
      event.preventDefault(); show(next); tabButtons.find(([id]) => id === next)[1].focus();
    });
    show(defs.some(([id]) => id === s.styleTab) ? s.styleTab : 'profile');
    body.append(tabs, panel);
    return [cover, body];
  }
  function stylePanel(s, tab, data, styleJobs) {
    if (tab === 'profile') {
      const out = [];
      out.push(el('h3', 'sa-h3', 'Описание стиля'));
      out.push(data.profile ? markdown(el('div', 'sa-prose'), data.profile) : el('p', 'sa-quiet', 'Профиль стиля не сохранён в StoryArt.'));
      out.push(el('h3', 'sa-h3', 'Ограничения переноса'));
      out.push(data.negative ? markdown(el('div', 'sa-prose sa-prose-negative'), data.negative) : el('p', 'sa-quiet', 'Отдельные ограничения для стиля не сохранены.'));
      return out;
    }
    if (tab === 'references') {
      if (!data.references.length) return [el('p', 'sa-quiet', 'В реестре стиля нет референсов, доступных для показа.')];
      const note = el('p', 'sa-note', 'Референсы библиотеки стиля с их настоящим статусом. Пробные образцы не являются утверждёнными якорями; StoryArt заново проверяет каждый референс, когда готовит конкретную работу.');
      const list = el('ul', 'sa-ref-grid');
      const viewable = data.references.map(ref => ({ id: ref.id, url: safeStoryArtUrl(ref.url, origin), label: referenceDisplayName(ref.name, ref.role) })).filter(item => item.url);
      data.references.forEach(ref => { const li = el('li'); li.append(referenceCard(ref, { onOpen: trigger => openLightbox(viewable, Math.max(0, viewable.findIndex(item => item.id === ref.id)), trigger) })); list.append(li); });
      return [note, list];
    }
    if (tab === 'characters') {
      if (!data.characters.length) return [el('p', 'sa-quiet', 'В этом стиле пока нет одобренных персонажей.'), button('Создать персонажа', 'sa-button sa-button-quiet', () => startGeneration(s, data.style.id, 'character_create'))];
      const list = el('ul', 'sa-char-grid');
      data.characters.forEach(character => {
        const li = el('li');
        const card = el('article', 'sa-char-card');
        card.append(picture(character.coverUrl, character.name, 'Образца нет', 'sa-char-art'));
        const info = el('div', 'sa-char-info');
        info.append(el('strong', 'sa-char-name', character.name));
        const actions = el('div', 'sa-row sa-char-actions');
        actions.append(button('Галерея персонажа', 'sa-button sa-button-quiet', () => navigate(s, { screen: 'character', styleId: data.style.id, characterId: character.id, category: 'identity' }), { 'aria-label': `Открыть галерею ${character.name}` }));
        actions.append(button('Иллюстрация с персонажем', 'sa-button sa-button-quiet', () => startGeneration(s, data.style.id, 'generation', character.id)));
        card.append(info, actions);
        li.append(card); list.append(li);
      });
      return [list];
    }
    if (s.jobsError) return [notice('error', 'Список работ не загрузился', s.jobsError)];
    if (!s.jobs) return [el('p', 'sa-loading', 'Загружаем работы…')];
    if (!styleJobs.length) return [el('p', 'sa-quiet', 'В этой книге ещё нет работ в этом стиле.')];
    const list = el('ul', 'sa-job-grid');
    styleJobs.forEach(job => { const li = el('li'); li.append(jobCard(s, job)); list.append(li); });
    return [list];
  }
  function characterScreen(s) {
    const { styleId, characterId, category } = s.route;
    const cached = s.characters.get(JSON.stringify([styleId, characterId]));
    const out = [back('К стилю', () => { s.styleTab = 'characters'; navigate(s, { screen: 'style', styleId }); })];
    if (cached?.error) {
      out.push(notice('error', 'Галерея персонажа не загрузилась', cached.error, button('Повторить', 'sa-button sa-button-quiet', () => loadCharacter(s, styleId, characterId, true))));
      return out;
    }
    if (!cached?.data) {
      out.push(el('p', 'sa-loading', 'Загружаем галерею персонажа…', { role: 'status' }));
      return out;
    }
    const { character, categories } = cached.data;
    const head = el('div', 'sa-character-head');
    head.append(picture(character.coverUrl, character.name, 'Образца нет', 'sa-character-cover'), el('div', 'sa-character-title', '', { role: 'heading', 'aria-level': '2' }));
    head.children[1].append(el('h2', 'sa-h2', character.name), el('p', 'sa-lead', 'Личная библиотека сохранённых изображений этого персонажа. Просмотр не запускает генерацию и не добавляет изображения в исходники.'));
    out.push(head);
    const tabs = el('div', 'sa-segment sa-character-tabs', '', { role: 'tablist', 'aria-label': 'Категории генераций персонажа' });
    CHARACTER_CATEGORIES.forEach(def => {
      const item = categories.find(value => value.id === def.id);
      const b = button(`${def.label} (${item.assets.length})`, 'sa-segment-item', () => navigate(s, { screen: 'character', styleId, characterId, category: def.id }), { role: 'tab', 'aria-selected': String(category === def.id), 'aria-current': category === def.id ? 'page' : null });
      tabs.append(b);
    });
    out.push(tabs);
    const selected = categories.find(item => item.id === category) || categories[0];
    if (!selected.assets.length) {
      out.push(notice('info', `В категории «${selected.label}» пока нет изображений`, 'Показаны только сохранённые изображения, относящиеся к выбранному персонажу и категории.'));
      return out;
    }
    const grid = el('ul', 'sa-character-gallery');
    selected.assets.forEach(asset => {
      const imageUrl = asset.url;
      const viewable = selected.assets.filter(item => item.url).map(item => ({ url: item.url, label: item.name }));
      const li = el('li');
      const card = el('article', 'sa-character-asset');
      const open = button('', 'sa-art-button', event => {
        const index = viewable.findIndex(item => item.url === imageUrl && item.label === asset.name);
        openLightbox(viewable, Math.max(0, index), event?.currentTarget || open);
      }, { 'aria-label': `Открыть ${asset.name} крупно` });
      open.disabled = !imageUrl;
      open.append(picture(imageUrl, asset.name, asset.previewReason || 'Изображение недоступно', 'sa-character-asset-art'));
      const details = el('div', 'sa-character-asset-info');
      details.append(el('strong', '', asset.name));
      details.append(chip(characterAssetStatusLabel(asset.status), asset.status === 'SAVED_UNVERIFIED' ? 'wait' : asset.status.startsWith('APPROVED_') ? 'done' : ''));
      if (asset.description) details.append(el('p', 'sa-quiet', asset.description));
      card.append(open, details); li.append(card); grid.append(li);
    });
    out.push(grid);
    return out;
  }

  function referenceCard(ref, { onOpen = null, state = '' } = {}) {
    const card = el('article', 'sa-ref' + (state ? ' sa-ref-' + state : ''));
    const url = safeStoryArtUrl(ref.url, origin);
    const art = picture(ref.url, ref.name, ref.previewReason || 'Изображение недоступно', 'sa-ref-art');
    if (url && onOpen) { const open = button('', 'sa-art-button', e => onOpen(e?.currentTarget || open), { 'aria-label': `Открыть референс ${ref.name} крупно` }); open.append(art); card.append(open); }
    else card.append(art);
    const info = el('div', 'sa-ref-info');
    info.append(el('strong', 'sa-ref-name', referenceDisplayName(ref.name, ref.role), { title: ref.name }));
    const chips = el('div', 'sa-ref-chips');
    if (ref.role) chips.append(chip(ref.role));
    if (ref.status) chips.append(chip(referenceStatusLabel(ref.status), isTrialReference(ref) ? 'wait' : ref.status === 'PUBLISHED_LEGACY' ? 'idle' : 'done'));
    if (ref.role || ref.status) info.append(chips);
    // The routine "revalidated per request" note is stated once above the grid; only a trial warning is per card.
    if (ref.eligibility && isTrialReference(ref)) info.append(el('span', 'sa-ref-line sa-ref-avoid', eligibilityLabel(ref.eligibility)));
    if (ref.useFor) info.append(el('span', 'sa-ref-line sa-ref-clamp', 'Для: ' + ref.useFor, { title: ref.useFor }));
    if (ref.doNotUseFor) info.append(el('span', 'sa-ref-line sa-ref-avoid sa-ref-clamp', 'Не для: ' + ref.doNotUseFor, { title: ref.doNotUseFor }));
    card.append(info);
    return card;
  }

  // Explicit "use this style" from the style page. Choices tied to another style are cleared, never carried over.
  function startGeneration(s, styleId, kind, characterId = '') {
    const d = s.generation;
    // A frozen draft with an unknown outcome is shown as is; it must not be silently rewritten.
    if (d.unknown) { navigate(s, { screen: 'generate' }); return; }
    if (d.styleId !== styleId) { d.styleId = styleId; d.referenceIds = []; d.characterId = ''; }
    d.kind = kind;
    if (kind === 'generation' && characterId) d.characterId = characterId;
    if (kind !== 'generation') d.characterId = '';
    navigate(s, { screen: 'generate' });
  }

  // File attachments shared by the style wizard and the generation form.
  function uploader(s, draft, regionName, label) {
    const wrap = el('div', 'sa-uploader');
    const blocked = uploadsBlocked(s);
    const drop = el('label', 'sa-drop' + (blocked ? ' is-disabled' : ''));
    const input = el('input', 'sa-file', '', { type: 'file', accept: STORYART_IMAGE_TYPES.join(','), multiple: true });
    input.disabled = !!blocked || draft.unknown;
    input.addEventListener('change', () => { addFiles(s, draft, [...(input.files || [])], regionName); input.value = ''; });
    drop.append(input, el('strong', '', label), el('span', '', blocked || 'PNG, JPEG или WebP, до 20 МБ каждый. Исходные файлы не изменяются.'));
    wrap.append(drop, region(regionName, 'sa-upload-region', () => uploadList(s, draft, regionName)));
    return wrap;
  }
  function uploadList(s, draft, regionName) {
    if (!draft.uploads.length) return el('p', 'sa-quiet', 'Файлы не добавлены.');
    const list = el('ul', 'sa-upload-list');
    draft.uploads.forEach(item => {
      const li = el('li', 'sa-upload sa-upload-' + item.status);
      const preview = item.upload?.url ? picture(item.upload.url, item.name, 'Предпросмотр недоступен', 'sa-upload-art') : el('div', 'sa-upload-art');
      if (!item.upload?.url && item.localUrl) { const img = el('img'); img.src = item.localUrl; img.alt = item.name; preview.append(img); }
      const info = el('div', 'sa-upload-info');
      info.append(el('strong', '', item.name));
      const status = { reading: 'Читаем файл…', uploading: 'Загружаем…', ready: 'Загружено' + (item.size ? ', ' + formatBytes(item.size) : ''), error: item.error || 'Не загружено' }[item.status];
      info.append(el('span', item.status === 'error' ? 'sa-upload-error' : 'sa-upload-status', status, item.status === 'error' ? { role: 'alert' } : null));
      li.append(preview, info, button('Убрать', 'sa-button sa-button-quiet sa-upload-remove', () => removeUpload(s, draft, item, regionName), { 'aria-label': `Убрать файл ${item.name}` }));
      list.append(li);
    });
    return lockIf(draft, list);
  }
  function removeUpload(s, draft, item, regionName) {
    draft.uploads = draft.uploads.filter(x => x !== item);
    if (item.localUrl) window.URL?.revokeObjectURL?.(item.localUrl);
    refresh(s, regionName, 'formStatus', 'review');
  }
  function addFiles(s, draft, files, regionName) {
    if (draft.unknown) return;
    // The server checks uploads against the workspace revision, so nothing is sent before it is known.
    if (!s.revision && !s.projectLoading) loadProject(s, true);
    files.forEach(file => {
      const problem = validateImageFile(file) || (s.revision ? '' : `«${text(file?.name) || 'Файл'}»: ${NO_REVISION}`);
      const item = { name: text(file?.name) || 'Файл', size: file?.size, status: problem ? 'error' : 'reading', error: problem, upload: null, localUrl: '' };
      if (!problem) { try { item.localUrl = window.URL?.createObjectURL?.(file) || ''; } catch { item.localUrl = ''; } }
      draft.uploads.push(item);
      if (!problem) uploadFile(s, draft, item, file, regionName);
    });
    refresh(s, regionName, 'formStatus', 'review');
  }
  async function uploadFile(s, draft, item, file, regionName) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const base64 = bytesToBase64(bytes, value => window.btoa ? window.btoa(value) : globalThis.btoa(value));
      if (!s.revision) throw Error(NO_REVISION);
      item.status = 'uploading'; refresh(s, regionName);
      const r = await call(s, '/api/storyart/uploads', { method: 'POST', body: { name: item.name, base64, workspaceRevision: s.revision } });
      if (!safeId(r?.upload?.id)) throw Error('Сервер не подтвердил сохранение файла.');
      item.upload = { id: r.upload.id, url: text(r.upload.url), size: r.upload.size };
      item.status = 'ready';
      takeRevision(s, r);
    } catch (e) {
      item.status = 'error';
      const kind = storyArtErrorKind(e);
      item.error = `«${item.name}»: ` + (kind === 'revision' ? 'рабочая область изменилась во время загрузки. Каталог обновлён, добавьте файл ещё раз.' : errorText(e));
      if (kind === 'revision') loadProject(s, true);
    }
    if (draft.uploads.includes(item)) refresh(s, regionName, 'formStatus', 'review');
  }
  function formStatus(s, draft) {
    const out = [];
    const blocked = launchBlocked(s);
    if (blocked) out.push(notice('wait', 'Отправка недоступна', blocked));
    if (draft.submitting) out.push(notice('info', 'Отправляем запрос в StoryArt…', 'Не закрывайте вкладку, пока сервер не ответит.'));
    else if (draft.unknown) out.push(notice('error', draft.errorKind === 'payload' ? 'Запрос с этим номером уже есть в StoryArt' : 'Неизвестно, принял ли StoryArt запрос', draft.error + ' Откройте «Работы» и проверьте список. Поля заблокированы: повторная отправка передаёт ровно тот же запрос с тем же номером, поэтому дубликат не создастся. Чтобы что-то изменить, начните новый запрос, но прежний мог уже дойти до StoryArt.', button('Открыть работы', 'sa-button sa-button-quiet', () => { loadJobs(s); navigate(s, { screen: 'jobs' }); })));
    else if (draft.error) out.push(notice('error', 'Запрос не отправлен', draft.error));
    const failed = draft.uploads.filter(item => item.status === 'error').length;
    if (failed) out.push(el('p', 'sa-note', `Файлов с ошибкой: ${failed}. Они не будут приложены.`));
    return out;
  }
  async function submitJob(s, draft) {
    if (draft.submitting) return;
    const blocked = launchBlocked(s);
    if (blocked) { draft.error = blocked; refresh(s, 'formStatus'); return; }
    // After an unknown outcome the frozen original body is resent unchanged, whatever the fields show now.
    const built = draft.pendingBody ? { body: draft.pendingBody } : buildJobRequest(draft, { revision: s.revision, styles: styles(s), detail: draft.styleId ? styleCache.get(draft.styleId)?.data : null });
    if (built.error) { draft.error = built.error; draft.errorKind = ''; refresh(s, 'formStatus'); return; }
    draft.submitting = true; draft.error = '';
    refresh(s, 'formStatus', 'submit');
    try {
      const r = await call(s, '/api/storyart/jobs', { method: 'POST', body: built.body });
      takeRevision(s, r);
      const request = r?.request && typeof r.request === 'object' ? r.request : null;
      if (r?.ok !== true || !request) throw Object.assign(Error('Сервер не подтвердил передачу запроса.'), { unknownOutcome: true });
      const jobId = safeId(request.id) || safeId(request.requestId) || built.body.requestId;
      draft.uploads.forEach(item => { if (item.localUrl) window.URL?.revokeObjectURL?.(item.localUrl); });
      if (draft.kind === 'style_create') s.styleCreate = newStyleDraft();
      else s.generation = newGenerationDraft();
      const job = { ...request, id: jobId };
      if (Array.isArray(s.jobs)) s.jobs = [job, ...s.jobs.filter(item => item.id !== jobId)];
      if (live(s)) {
        notify('Запрос передан StoryArt. Изображение появится, когда StoryArt его создаст.');
        navigate(s, { screen: 'job', jobId });
      }
    } catch (e) {
      draft.submitting = false;
      const kind = storyArtErrorKind(e), wasUnknown = draft.unknown;
      draft.errorKind = kind;
      if (kind === 'revision') { draft.error = 'Рабочая область изменилась после загрузки каталога. Каталог обновлён.' + (wasUnknown ? '' : ' Проверьте форму и отправьте снова.'); loadProject(s, true); }
      else if (kind === 'payload') draft.error = 'StoryArt уже получил запрос с этим номером, но с другим содержимым. Повторно ничего не отправлено.';
      else draft.error = errorText(e);
      // Once the outcome is unknown it stays unknown until an acknowledgement: a later rejection proves nothing about the first attempt.
      if (kind === 'unknown' || kind === 'payload') { draft.unknown = true; draft.pendingBody ||= built.body; }
      if (live(s) && draft.unknown && !wasUnknown) render();
      else refresh(s, 'formStatus', 'submit');
    }
  }
  function submitButton(s, draft, label) {
    const b = button(draft.submitting ? 'Отправляем…' : draft.unknown ? 'Отправить тот же запрос ещё раз' : label, 'sa-button sa-button-gold sa-submit');
    b.type = 'submit';
    b.disabled = draft.submitting || !!launchBlocked(s);
    return b;
  }
  const clearLabel = draft => draft.unknown ? 'Начать новый запрос' : 'Очистить форму';
  async function clearDraft(s, which) {
    const draft = which === 'style' ? s.styleCreate : s.generation;
    if (draft.submitting) return;
    if (draft.unknown && ask && await ask('Начать новый запрос?', 'Прежний запрос мог уже дойти до StoryArt и выполняться. Проверьте «Работы». Новая форма получит новый номер, и при отправке это будет отдельная работа.', 'Начать новый запрос') !== 'confirm') return;
    draft.uploads.forEach(item => { if (item.localUrl) window.URL?.revokeObjectURL?.(item.localUrl); });
    if (which === 'style') s.styleCreate = newStyleDraft(); else s.generation = newGenerationDraft();
    if (live(s)) render();
  }

  // Style creation wizard: a real three-step sequence.
  function createStyleScreen(s) {
    const d = s.styleCreate;
    const intro = el('div', 'sa-intro');
    intro.append(back('Все стили', () => navigate(s, { screen: 'styles' })), el('h2', 'sa-h2', 'Новый стиль'), el('p', 'sa-lead', 'StoryArt разберёт исходные изображения, составит профиль стиля и попросит вас проверить результат.'));
    const steps = el('ol', 'sa-steps');
    [['Название и замысел', 1], ['Исходные изображения', 2], ['Проверка и запуск', 3]].forEach(([label, n]) => steps.append(el('li', 'sa-step' + (n === d.step ? ' is-current' : n < d.step ? ' is-done' : ''), label, n === d.step ? { 'aria-current': 'step' } : null)));
    const form = el('form', 'sa-form sa-wizard');
    form.noValidate = true;
    const go = step => { d.step = step; render(); };
    const status = region('formStatus', 'sa-form-status', () => formStatus(s, d));
    if (d.step === 1) {
      const name = field('Название стиля', 'input', d.styleName, value => { d.styleName = value; }, { maxlength: 80, required: true, autocomplete: 'off' });
      const intent = field('Замысел', 'textarea', d.prompt, value => { d.prompt = value; }, { rows: 5, maxlength: 4000, required: true }, 'Что должно отличать стиль: линия, свет, палитра, фактура. Текст передаётся StoryArt без изменений.');
      const row = el('div', 'sa-row sa-form-actions');
      row.append(button('Дальше: исходные изображения', 'sa-button sa-button-gold', () => {
        if (!d.styleName.trim()) { d.error = 'Назовите стиль.'; fill('formStatus'); return; }
        if (!d.prompt.trim()) { d.error = 'Опишите замысел стиля.'; fill('formStatus'); return; }
        d.error = ''; go(2);
      }));
      form.append(...lockIf(d, [name, intent]), status, row);
    } else if (d.step === 2) {
      const row = el('div', 'sa-row sa-form-actions');
      row.append(button('Назад', 'sa-button sa-button-quiet', () => go(1)), button('Дальше: проверка', 'sa-button sa-button-gold', () => {
        if (d.uploads.some(item => item.status === 'reading' || item.status === 'uploading')) { d.error = 'Дождитесь окончания загрузки файлов.'; fill('formStatus'); return; }
        if (!d.uploads.some(item => item.status === 'ready')) { d.error = 'Добавьте хотя бы одно исходное изображение.'; fill('formStatus'); return; }
        d.error = ''; go(3);
      }));
      form.append(uploader(s, d, 'styleUploads', 'Добавить исходные изображения'), status, row);
    } else {
      form.append(region('review', 'sa-review', () => {
        const ready = d.uploads.filter(item => item.status === 'ready');
        const summary = el('dl', 'sa-review-list');
        summary.append(el('dt', '', 'Название'), el('dd', '', d.styleName.trim() || 'Не указано'), el('dt', '', 'Замысел'), el('dd', 'sa-pre', d.prompt.trim() || 'Не указан'), el('dt', '', 'Исходники'), el('dd', '', ready.length ? `${ready.length} ${plural(ready.length, ['файл', 'файла', 'файлов'])}` : 'Нет загруженных файлов'));
        const thumbs = el('ul', 'sa-review-thumbs');
        ready.forEach(item => { const li = el('li'); li.append(picture(item.upload?.url, item.name, item.name, 'sa-upload-art')); thumbs.append(li); });
        return [summary, thumbs, el('p', 'sa-note', 'Запуск отправит один запрос в StoryArt. Стиль появится в каталоге только после того, как StoryArt сохранит его и вы утвердите результат.')];
      }));
      const row = el('div', 'sa-row sa-form-actions');
      const submit = region('submit', 'sa-submit-slot', () => submitButton(s, d, 'Начать обработку стиля'));
      row.append(button('Назад', 'sa-button sa-button-quiet', () => go(2)), button(clearLabel(d), 'sa-button sa-button-quiet', () => clearDraft(s, 'style')), submit);
      form.append(status, row);
    }
    form.addEventListener('submit', event => { event.preventDefault(); if (d.step === 3) submitJob(s, d); });
    return [intro, steps, form];
  }
  function field(label, tag, value, onInput, attrs = {}, hint = '') {
    const wrap = el('label', 'sa-field');
    wrap.append(el('span', 'sa-label', label));
    const input = el(tag, 'sa-input', '', attrs);
    input.value = value;
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(input);
    if (hint) wrap.append(el('span', 'sa-hint', hint));
    return wrap;
  }
  function select(label, choices, value, onChange, hint = '') {
    const wrap = el('label', 'sa-field');
    wrap.append(el('span', 'sa-label', label));
    const input = el('select', 'sa-input');
    choices.forEach(([v, l]) => { const option = el('option', '', l); option.value = v; input.append(option); });
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    wrap.append(input);
    if (hint) wrap.append(el('span', 'sa-hint', hint));
    return wrap;
  }

  // Generation form.
  function generateScreen(s) {
    const d = s.generation;
    const intro = el('div', 'sa-intro');
    intro.append(back('Назад', () => navigate(s, d.styleId ? { screen: 'style', styleId: d.styleId } : { screen: 'styles' })), el('h2', 'sa-h2', 'Новая генерация'), el('p', 'sa-lead', 'Запрос уйдёт в StoryArt только по кнопке отправки. Ход работы и подключённые референсы будут видны на странице работы.'));
    const form = el('form', 'sa-form sa-generate');
    form.noValidate = true;
    const kind = el('fieldset', 'sa-kind');
    kind.append(el('legend', 'sa-label', 'Что создаём'));
    [['generation', 'Иллюстрация', 'Сцена или кадр в выбранном стиле.'], ['character_create', 'Новый персонаж', 'Новая внешность: лицо, ракурсы и лист персонажа.']].forEach(([value, label, copy]) => {
      const option = el('label', 'sa-kind-option');
      const radio = el('input', '', '', { type: 'radio', name: 'sa-kind' });
      radio.value = value; radio.checked = d.kind === value;
      radio.addEventListener('change', () => { if (!radio.checked) return; d.kind = value; if (value !== 'generation') d.characterId = ''; fill('styleBound'); });
      const copyBox = el('span', 'sa-kind-copy');
      copyBox.append(el('strong', '', label), el('span', '', copy));
      option.append(radio, copyBox);
      kind.append(option);
    });
    // A region, so a catalogue refresh can add new styles without touching the rest of the form.
    const style = region('styleSelect', 'sa-style-select', () => {
      const styleChoices = [['', s.project ? 'Выберите стиль' : 'Каталог загружается…'], ...styles(s).map(item => [item.id, item.name])];
      if (d.styleId && !styles(s).some(item => item.id === d.styleId)) styleChoices.push([d.styleId, d.styleId + ' (нет в каталоге)']);
      return lockIf(d, select('Стиль', styleChoices, d.styleId, value => {
        d.styleId = value; d.referenceIds = []; d.characterId = '';
        if (value) loadStyle(s, value);
        fill('styleBound');
      }));
    });
    const title = field('Название работы', 'input', d.title, value => { d.title = value; }, { maxlength: 160, required: true, autocomplete: 'off' }, 'Так работа будет подписана в списке.');
    const prompt = field('Задание', 'textarea', d.prompt, value => { d.prompt = value; }, { rows: 7, maxlength: 8000, required: true }, 'Сцена, детали и что исключить. Текст передаётся StoryArt без изменений.');
    const options = el('details', 'sa-options');
    options.open = d.optionsOpen;
    options.addEventListener('toggle', () => { d.optionsOpen = options.open; });
    options.append(el('summary', '', 'Параметры изображения'));
    const o = d.options;
    const fidelity = el('fieldset', 'sa-fidelity');
    fidelity.append(el('legend', 'sa-label', 'Степень переноса стиля'));
    const custom = el('input', 'sa-input', '', { type: 'text', maxlength: 200, 'aria-label': 'Своя степень переноса' });
    custom.value = o.fidelityCustom; custom.disabled = o.fidelity !== 'custom';
    custom.addEventListener('input', () => { o.fidelityCustom = custom.value; });
    FIDELITY_CHOICES.forEach(([value, label]) => {
      const opt = el('label', 'sa-radio');
      const radio = el('input', '', '', { type: 'radio', name: 'sa-fidelity' });
      radio.value = value; radio.checked = o.fidelity === value;
      radio.addEventListener('change', () => { if (radio.checked) { o.fidelity = value; custom.disabled = value !== 'custom'; } });
      opt.append(radio, el('span', '', label));
      fidelity.append(opt);
    });
    fidelity.append(custom);
    const body = el('label', 'sa-check');
    const bodyInput = el('input', '', '', { type: 'checkbox' });
    bodyInput.checked = o.bodyLibrary === 'on';
    bodyInput.addEventListener('change', () => { o.bodyLibrary = bodyInput.checked ? 'on' : 'off'; });
    body.append(bodyInput, el('span', '', 'Подключить библиотеку тел (по умолчанию выключено)'));
    options.append(
      select('Формат кадра', ASPECT_CHOICES, o.aspectRatio, value => { o.aspectRatio = value; }),
      fidelity,
      select('Тип сцены', SCENE_CHOICES, o.sceneKind, value => { o.sceneKind = value; }),
      select('Назначение', OUTPUT_CHOICES, o.outputUse, value => { o.outputUse = value; }),
      body
    );
    const attachments = el('div', 'sa-field');
    attachments.append(el('span', 'sa-label', 'Свои файлы для этой работы'), uploader(s, d, 'genUploads', 'Приложить изображения'));
    const actions = el('div', 'sa-row sa-form-actions');
    actions.append(button(clearLabel(d), 'sa-button sa-button-quiet', () => clearDraft(s, 'generation')), region('submit', 'sa-submit-slot', () => submitButton(s, d, 'Отправить в StoryArt')));
    lockIf(d, [kind, title, prompt, options, attachments]);
    form.append(kind, style, title, region('styleBound', 'sa-style-bound', () => styleBound(s, d)), prompt, options, attachments, region('formStatus', 'sa-form-status', () => formStatus(s, d)), actions);
    form.addEventListener('submit', event => { event.preventDefault(); submitJob(s, d); });
    return [intro, form];
  }
  function styleBound(s, d) {
    if (!d.styleId) return el('p', 'sa-quiet', 'Выберите стиль, чтобы увидеть его персонажей и референсы.');
    const cached = styleCache.get(d.styleId);
    if (cached?.error) return notice('error', 'Описание стиля не загрузилось', cached.error + ' Отправить запрос можно без выбора референсов и персонажа.', button('Повторить', 'sa-button sa-button-quiet', () => { styleCache.delete(d.styleId); loadStyle(s, d.styleId); fill('styleBound'); }));
    if (!cached?.data) { if (!cached) loadStyle(s, d.styleId); return el('p', 'sa-loading', 'Загружаем персонажей и референсы стиля…', { role: 'status' }); }
    const { characters, references } = cached.data;
    const out = [];
    if (d.kind === 'generation') {
      const choices = [['', 'Без персонажа'], ...characters.map(c => [c.id, c.name])];
      if (d.characterId && !characters.some(c => c.id === d.characterId)) d.characterId = '';
      out.push(select('Персонаж', choices, d.characterId, value => { d.characterId = value; }, characters.length ? 'Для главного героя StoryArt сначала опирается на утверждённую внешность, затем строит сцену.' : 'В этом стиле пока нет одобренных персонажей.'));
    } else out.push(el('p', 'sa-note', 'Новый персонаж создаётся с нуля: StoryArt проведёт его через лицо, ракурсы и сборку листа.'));
    const refs = el('fieldset', 'sa-ref-pick');
    refs.append(el('legend', 'sa-label', 'Референсы стиля, которые вы хотите видеть в работе'));
    refs.append(el('p', 'sa-hint', 'Отмеченное здесь — ваше пожелание. Пробные образцы можно выбрать, но StoryArt и владелец проверят их отдельно. Что действительно подготовлено и подключено, будет показано на странице работы.'));
    if (!references.length) refs.append(el('p', 'sa-quiet', 'В реестре стиля нет референсов, доступных для выбора.'));
    const list = el('ul', 'sa-pick-grid');
    d.referenceIds = d.referenceIds.filter(id => references.some(ref => ref.id === id));
    references.forEach(ref => {
      const li = el('li');
      const pressed = d.referenceIds.includes(ref.id);
      const status = ref.status ? referenceStatusLabel(ref.status) : '';
      const b = button('', 'sa-pick', null, { 'aria-pressed': String(pressed), 'aria-label': [ref.name, ref.role, status].filter(Boolean).join(', ') });
      b.append(picture(ref.url, '', ref.previewReason || ref.name, 'sa-pick-art'), el('span', 'sa-pick-name', ref.name));
      if (ref.role) b.append(el('span', 'sa-pick-role', ref.role));
      if (status) b.append(el('span', 'sa-pick-role' + (isTrialReference(ref) ? ' sa-pick-trial' : ''), status));
      b.addEventListener('click', () => {
        const on = !d.referenceIds.includes(ref.id);
        d.referenceIds = on ? [...d.referenceIds, ref.id] : d.referenceIds.filter(id => id !== ref.id);
        b.setAttribute('aria-pressed', String(on));
      });
      li.append(b); list.append(li);
    });
    refs.append(list);
    out.push(refs);
    return lockIf(d, out);
  }

  // Jobs list.
  function jobsScreen(s) {
    const intro = el('div', 'sa-intro');
    const head = el('div', 'sa-section-head');
    head.append(el('h2', 'sa-h2', 'Работы'), button('Обновить список', 'sa-button sa-button-quiet', () => loadJobs(s)));
    intro.append(head, el('p', 'sa-lead', 'Запросы этой книги к StoryArt. Статус обновляется по кнопке.'));
    const filter = el('div', 'sa-segment', '', { role: 'group', 'aria-label': 'Показать работы' });
    [['all', 'Все'], ['generation', 'Иллюстрации'], ['character_create', 'Персонажи'], ['style_create', 'Стили']].forEach(([value, label]) => {
      const b = button(label, 'sa-segment-item', () => { s.jobsFilter = value; [...filter.children].forEach(child => child.setAttribute('aria-pressed', String(child === b))); fill('jobs'); }, { 'aria-pressed': String(s.jobsFilter === value) });
      filter.append(b);
    });
    intro.append(filter);
    return [intro, region('jobs', 'sa-jobs', () => jobList(s))];
  }
  function jobList(s) {
    if (s.jobsError) return notice('error', 'Список работ не загрузился', s.jobsError, button('Повторить', 'sa-button sa-button-quiet', () => loadJobs(s)));
    if (!s.jobs) return el('p', 'sa-loading', 'Загружаем работы…', { role: 'status' });
    const jobs = s.jobsFilter === 'all' ? s.jobs : s.jobs.filter(job => job.kind === s.jobsFilter);
    if (!jobs.length) return notice('info', s.jobs.length ? 'В этом разделе работ нет' : 'Работ в этой книге пока нет', 'Начните с новой генерации или создайте стиль.', button('Новая генерация', 'sa-button sa-button-gold', () => navigate(s, { screen: 'generate' })));
    const list = el('ul', 'sa-job-grid');
    jobs.forEach(job => { const li = el('li'); li.append(jobCard(s, job)); list.append(li); });
    const out = [list];
    if (s.jobsLoading) out.unshift(el('p', 'sa-loading', 'Обновляем…', { role: 'status' }));
    return out;
  }
  function jobCard(s, job) {
    const title = text(job.title) || kindLabel(job.kind);
    const card = button('', 'sa-job-card', () => navigate(s, { screen: 'job', jobId: job.id }), { 'aria-label': `Открыть работу ${title}` });
    const first = normalizeArtifacts(job, origin).find(item => item.url);
    card.append(picture(first?.url, '', 'Изображений пока нет', 'sa-job-thumb'));
    const info = el('span', 'sa-job-info');
    info.append(el('span', 'sa-job-title', title));
    const meta = el('span', 'sa-job-meta');
    meta.append(chip(jobStatusLabel(job.status), statusTone(job.status)), el('span', '', kindLabel(job.kind)));
    const when = date(job.updatedAt);
    if (when) meta.append(el('span', 'sa-job-when', when));
    info.append(meta);
    if (text(job.error)) info.append(el('span', 'sa-job-error', text(job.error)));
    card.append(info);
    return card;
  }

  // Job studio.
  function jobScreen(s) {
    const jobId = s.route.jobId;
    const top = el('div', 'sa-job-top');
    top.append(back('Все работы', () => navigate(s, { screen: 'jobs' })), region('jobHead', 'sa-job-head', () => jobHead(s, jobId)));
    const panes = el('div', 'sa-segment sa-job-panes', '', { role: 'tablist', 'aria-label': 'Части работы' });
    const layout = el('div', 'sa-job', '', { 'data-pane': s.jobPane });
    [['result', 'Результат'], ['process', 'Процесс'], ['refs', 'Референсы']].forEach(([value, label]) => {
      const b = button(label, 'sa-segment-item', () => { s.jobPane = value; layout.setAttribute('data-pane', value); [...panes.children].forEach(child => child.setAttribute('aria-selected', String(child === b))); }, { role: 'tab', 'aria-selected': String(s.jobPane === value) });
      panes.append(b);
    });
    const stage = el('section', 'sa-job-stage', '', { 'aria-label': 'Результат' });
    stage.append(region('stage', 'sa-stage', () => stageView(s, jobId)), region('gallery', 'sa-gallery', () => galleryView(s, jobId)));
    const side = el('aside', 'sa-job-process', '', { 'aria-label': 'Процесс' });
    side.append(region('jobActions', 'sa-job-actions', () => jobActions(s, jobId)), correctionForm(s, jobId), region('process', 'sa-process', () => processView(s, jobId)));
    const refs = el('section', 'sa-job-refs', '', { 'aria-label': 'Референсы' });
    refs.append(region('refs', 'sa-refs', () => refsView(s, jobId)));
    layout.append(stage, side, refs);
    return [top, panes, layout];
  }
  const jobOf = (s, jobId) => s.details.get(jobId)?.request || (s.jobs || []).find(job => job.id === jobId) || null;
  function jobHead(s, jobId) {
    const job = jobOf(s, jobId), error = s.detailErrors.get(jobId);
    const out = [];
    if (!job) {
      if (error) return notice('error', 'Работа не открылась', error, button('Повторить', 'sa-button sa-button-quiet', () => loadDetail(s, jobId)));
      return el('p', 'sa-loading', 'Загружаем работу…', { role: 'status' });
    }
    out.push(el('h2', 'sa-h2', text(job.title) || kindLabel(job.kind)));
    const meta = el('div', 'sa-row sa-job-meta');
    meta.append(chip(jobStatusLabel(job.status), statusTone(job.status)), el('span', '', kindLabel(job.kind)));
    const styleName = styles(s).find(style => style.id === job.styleId)?.name || text(job.styleId);
    if (styleName) meta.append(el('span', '', 'Стиль: ' + styleName));
    const when = date(job.updatedAt);
    if (when) meta.append(el('span', '', 'Обновлено ' + when));
    if (s.detailLoading.has(jobId)) meta.append(el('span', 'sa-loading', 'Обновляем…'));
    out.push(meta);
    if (error) out.push(notice('error', 'Последнее обновление не удалось', error + ' Показаны прежние данные.'));
    return out;
  }
  function selectedIndex(s, jobId, artifacts) {
    const wanted = s.selectedArtifact.get(jobId);
    return artifacts.some(a => a.index === wanted) ? wanted : artifacts[0]?.index;
  }
  function stageView(s, jobId) {
    const job = jobOf(s, jobId);
    if (!job) return el('div', 'sa-stage-empty');
    const artifacts = normalizeArtifacts(job, origin);
    if (!artifacts.length) {
      const tone = statusTone(job.status);
      const copy = tone === 'error' ? 'StoryArt сообщил об ошибке. Подробности в разделе «Процесс».' : tone === 'done' ? 'StoryArt ответил, но не передал изображений. Прочитайте ответ в разделе «Процесс».' : 'StoryArt ещё не прислал изображений. Этапы работы видны в разделе «Процесс».';
      const empty = el('div', 'sa-stage-empty');
      empty.append(el('span', 'sa-stage-sigil', '', { 'aria-hidden': 'true' }), el('strong', '', 'Изображений пока нет'), el('p', '', copy));
      return empty;
    }
    const index = selectedIndex(s, jobId, artifacts), current = artifacts.find(a => a.index === index);
    const viewable = artifacts.filter(a => a.url);
    const figure = el('figure', 'sa-stage-figure');
    const art = picture(current.url, current.label, 'Файл недоступен для просмотра', 'sa-stage-art');
    if (current.url) { const open = button('', 'sa-art-button', e => openLightbox(viewable, viewable.indexOf(current), e?.currentTarget || open), { 'aria-label': `Открыть ${current.label} крупно` }); open.append(art); figure.append(open); }
    else figure.append(art);
    figure.append(el('figcaption', '', current.label));
    return [figure, consentBlock(s, job, current)];
  }
  function consentBlock(s, job, artifact) {
    const box = el('div', 'sa-consent');
    if (job.kind === 'style_create') { box.append(el('p', 'sa-note', 'Опорные изображения стиля утверждаются в StoryArt. Здесь можно отправить поправку или попросить продолжить.')); return box; }
    const sent = s.consent.get(consentKey(job.id, artifact)), busy = s.jobBusy.get(job.id);
    const row = el('div', 'sa-row');
    const approve = button(busy === 'approve' ? 'Отправляем согласие…' : 'Согласовать этот вариант', 'sa-button sa-button-gold', () => consent(s, job, artifact, 'approve'));
    const reject = button(busy === 'reject' ? 'Отправляем отказ…' : 'Отклонить этот вариант', 'sa-button sa-button-quiet', () => consent(s, job, artifact, 'reject'));
    approve.disabled = reject.disabled = !!busy || !artifact.sha256;
    row.append(approve, reject);
    box.append(row);
    if (!artifact.sha256) box.append(el('p', 'sa-note', 'StoryArt не передал контрольную сумму этого варианта, поэтому решение по нему отсюда отправить нельзя.'));
    if (sent === 'approve') box.append(el('p', 'sa-consent-state', 'Согласие отправлено. Ждём, когда StoryArt подтвердит сохранение.', { role: 'status' }));
    if (sent === 'reject') box.append(el('p', 'sa-consent-state', 'Отказ по этому варианту отправлен StoryArt.', { role: 'status' }));
    return box;
  }
  const consentKey = (jobId, artifact) => jobId + ':' + artifact.index + ':' + artifact.sha256;
  async function consent(s, job, artifact, action) {
    // The decision is bound to the candidate the author saw, captured before any await: polling may swap it meanwhile.
    const seen = { index: artifact.index, sha256: artifact.sha256 };
    if (s.jobBusy.has(job.id) || !seen.sha256) return;
    if (ask && action === 'approve' && await ask(`Согласовать «${artifact.label}»?`, 'StoryArt получит согласие на этот конкретный файл. Сохранение в библиотеке подтверждает StoryArt.', 'Отправить согласие') !== 'confirm') return;
    const ok = await act(s, job.id, action, { artifactIndex: seen.index, expectedSha256: seen.sha256 });
    if (ok) { s.consent.set(consentKey(job.id, seen), action); refresh(s, 'stage'); }
  }
  function galleryView(s, jobId) {
    const job = jobOf(s, jobId);
    const artifacts = job ? normalizeArtifacts(job, origin) : [];
    if (artifacts.length < 2) return [];
    const index = selectedIndex(s, jobId, artifacts);
    const list = el('ul', 'sa-strip', '', { 'aria-label': 'Кандидаты этой работы' });
    artifacts.forEach(artifact => {
      const li = el('li');
      const b = button('', 'sa-strip-item', () => { s.selectedArtifact.set(jobId, artifact.index); fill('stage'); [...list.children].forEach(item => item.children[0]?.setAttribute('aria-pressed', String(item === li))); }, { 'aria-pressed': String(artifact.index === index), 'aria-label': artifact.label });
      b.append(picture(artifact.url, '', artifact.label, 'sa-strip-art'));
      li.append(b); list.append(li);
    });
    return list;
  }
  function jobActions(s, jobId) {
    const busy = s.jobBusy.get(jobId);
    const row = el('div', 'sa-row');
    const read = button(busy === 'read' ? 'Проверяем…' : 'Проверить у StoryArt', 'sa-button sa-button-quiet', () => act(s, jobId, 'read'));
    const wait = button(busy === 'wait' ? 'Ждём ответ StoryArt…' : 'Дождаться ответа', 'sa-button sa-button-quiet', () => act(s, jobId, 'wait'));
    const reload = button('Обновить страницу работы', 'sa-button sa-button-quiet', () => loadDetail(s, jobId));
    read.disabled = wait.disabled = !!busy;
    row.append(read, wait, reload);
    const out = [row];
    const note = s.actionNotes.get(jobId), error = s.actionErrors.get(jobId);
    if (error) out.push(notice('error', 'Действие не выполнено', error));
    else if (note) out.push(el('p', 'sa-note', note, { role: 'status' }));
    return out;
  }
  function correctionForm(s, jobId) {
    const form = el('form', 'sa-correction');
    form.noValidate = true;
    const label = el('label', 'sa-field');
    label.append(el('span', 'sa-label', 'Поправка для StoryArt'));
    const input = el('textarea', 'sa-input', '', { rows: 3, maxlength: 4000 });
    input.value = s.corrections.get(jobId) || '';
    input.addEventListener('input', () => s.corrections.set(jobId, input.value));
    label.append(input, el('span', 'sa-hint', 'Поправка уйдёт в тот же чат StoryArt, где идёт работа.'));
    const row = el('div', 'sa-row');
    const send = button('Отправить поправку', 'sa-button sa-button-gold'); send.type = 'submit';
    row.append(send, button('Продолжить работу', 'sa-button sa-button-quiet', () => act(s, jobId, 'continue')));
    form.append(label, row);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const message = (s.corrections.get(jobId) || '').trim();
      if (!message) { s.actionErrors.set(jobId, 'Напишите текст поправки.'); refresh(s, 'jobActions'); input.focus(); return; }
      send.disabled = true;
      const ok = await act(s, jobId, 'correction', { message });
      send.disabled = false;
      if (ok && (s.corrections.get(jobId) || '').trim() === message) { s.corrections.delete(jobId); if (live(s) && s.route.jobId === jobId) input.value = ''; }
    });
    return form;
  }
  async function act(s, jobId, action, extra = {}) {
    if (s.jobBusy.has(jobId)) return false;
    if (!s.revision) { s.actionErrors.set(jobId, NO_REVISION); refresh(s, 'jobActions'); if (!s.projectLoading) loadProject(s, true); return false; }
    s.jobBusy.set(jobId, action); s.actionErrors.delete(jobId); s.actionNotes.delete(jobId);
    refresh(s, 'jobActions', 'stage');
    let ok = false;
    try {
      const r = await call(s, '/api/storyart/jobs/' + encodeURIComponent(jobId) + '/action', { method: 'POST', body: { workspaceRevision: s.revision, action, ...extra } });
      takeRevision(s, r);
      if (r?.ok !== true || r?.accepted === false) throw Object.assign(Error('Сервер не подтвердил доставку действия.'), { unknownOutcome: true });
      ok = true;
      s.actionNotes.set(jobId, { read: 'Запрос на проверку доставлен StoryArt.', wait: 'StoryArt ответил на ожидание. Данные работы обновлены.', correction: 'Поправка доставлена в чат StoryArt.', continue: 'Просьба продолжить доставлена StoryArt.', approve: 'Согласие отправлено. Ждём подтверждения сохранения.', reject: 'Отказ отправлен StoryArt.' }[action]);
    } catch (e) {
      const kind = storyArtErrorKind(e);
      if (kind === 'revision') { s.actionErrors.set(jobId, 'Рабочая область изменилась. Каталог обновлён, проверьте работу и повторите действие.'); loadProject(s, true); }
      else if (kind === 'artifact') s.actionErrors.set(jobId, 'Этот вариант изменился после того, как вы его открыли. Ничего не отправлено. Посмотрите вариант снова и решите заново.');
      else s.actionErrors.set(jobId, (kind === 'unknown' ? 'Неизвестно, дошло ли действие до StoryArt: ' : '') + errorText(e));
    } finally {
      s.jobBusy.delete(jobId);
      refresh(s, 'jobActions', 'stage');
    }
    loadDetail(s, jobId);
    return ok;
  }
  function processView(s, jobId) {
    const detail = s.details.get(jobId), job = jobOf(s, jobId);
    if (!detail) return s.detailErrors.has(jobId) ? el('p', 'sa-quiet', 'Ход работы недоступен, пока страница работы не загрузится.') : el('p', 'sa-loading', 'Загружаем ход работы…', { role: 'status' });
    const process = detail.process, out = [];
    const qa = el('dl', 'sa-qa');
    [['Визуальная проверка', job?.visualQa], ['Проверка канона', job?.canonQa], ['Согласие автора, со слов StoryArt', job?.authorApproval]].forEach(([label, value]) => {
      const item = el('div', 'sa-qa-item');
      item.append(el('dt', '', label), el('dd', '', qaLabel(value)));
      qa.append(item);
    });
    out.push(qa);
    if (text(job?.error)) out.push(notice('error', 'StoryArt сообщил об ошибке', job.error));
    if (!process || process.available !== true) {
      out.push(notice('info', 'Ход работы недоступен', text(process?.reason) || 'StoryArt не передал состояние этой работы.'));
    } else {
      const next = el('div', 'sa-next');
      next.append(el('span', 'sa-label', 'Следующий шаг'), el('p', '', text(process.nextAction) || 'StoryArt не сообщил следующий шаг.'));
      const phase = [text(process.phase), text(process.status)].filter(Boolean);
      if (phase.length) next.append(el('span', 'sa-hint', 'Фаза: ' + phase.join(', ')));
      out.push(next);
      const stages = Array.isArray(process.stages) ? process.stages.filter(stage => stage && typeof stage === 'object') : [];
      if (stages.length) {
        const list = el('ol', 'sa-thread', '', { 'aria-label': 'Этапы работы' });
        stages.forEach(stage => {
          const status = text(stage.status).toLowerCase() || 'unknown';
          const li = el('li', 'sa-thread-item', '', { 'data-status': status });
          li.append(el('span', 'sa-thread-name', stageLabel(stage.id)), el('span', 'sa-thread-status', stageStatusLabel(status)));
          list.append(li);
        });
        out.push(list);
      } else out.push(el('p', 'sa-quiet', 'StoryArt не передал этапы для этой работы.'));
      const events = Array.isArray(process.events) ? process.events.filter(event => event && typeof event === 'object') : [];
      if (events.length) {
        const box = el('details', 'sa-events');
        box.append(el('summary', '', `События (${events.length})`));
        const list = el('ol', 'sa-event-list');
        [...events].reverse().slice(0, 50).forEach(event => {
          const li = el('li');
          const when = date(event.at);
          if (when) li.append(el('time', 'sa-event-time', when));
          li.append(el('span', '', text(event.summary) || text(event.event) || 'Событие без описания'));
          list.append(li);
        });
        box.append(list);
        out.push(box);
      }
    }
    if (text(job?.result)) { const answer = el('details', 'sa-answer'); answer.append(el('summary', '', 'Ответ StoryArt'), el('div', 'sa-pre', job.result)); out.push(answer); }
    const diag = el('details', 'sa-diagnostics');
    diag.append(el('summary', '', 'Диагностика'));
    const dl = el('dl', 'sa-diag-list');
    [['Номер запроса', job?.id], ['Чат StoryArt', job?.threadId], ['Состояние', job?.lifecycleStatus || job?.status], ['Свидетельства', process?.evidence]].forEach(([label, value]) => { if (text(value)) dl.append(el('dt', '', label), el('dd', 'sa-pre', value)); });
    diag.append(dl);
    out.push(diag);
    return out;
  }
  function refsView(s, jobId) {
    const detail = s.details.get(jobId);
    if (!detail) return el('p', 'sa-loading', 'Загружаем референсы работы…', { role: 'status' });
    const buckets = referenceBuckets(detail.process);
    const groups = [
      ['selected', 'Выбрано вами', 'Пожелание автора. Это ещё не значит, что изображение подключено.', buckets.selected, 'Вы не выбирали референсы для этой работы.'],
      ['prepared', 'Подготовлено в плане', 'Что StoryArt включил в план после проверки.', buckets.prepared, buckets.available ? 'StoryArt пока не сообщил о подготовленных референсах.' : 'План StoryArt недоступен.'],
      ['executed', 'Передано при генерации', 'Что записано в исполненном вызове генерации.', buckets.executed, buckets.available ? 'Исполненный вызов пока не зафиксирован.' : 'Сведения об исполненном вызове недоступны.']
    ];
    return groups.map(([state, title, copy, list, empty]) => {
      const section = el('section', 'sa-ref-group sa-ref-group-' + state, '', { 'aria-label': title });
      const head = el('div', 'sa-ref-group-head');
      head.append(el('h3', 'sa-h3', title), el('span', 'sa-count', Array.isArray(list) ? String(list.length) : '—'));
      section.append(head, el('p', 'sa-hint', copy));
      if (!Array.isArray(list) || !list.length) section.append(el('p', 'sa-quiet', empty));
      else {
        const viewable = list.map(ref => ({ id: ref.id, url: safeStoryArtUrl(ref.url, origin), label: referenceDisplayName(ref.name, ref.role) })).filter(item => item.url);
        const grid = el('ul', 'sa-ref-grid sa-ref-grid-compact');
        list.forEach(ref => { const li = el('li'); li.append(referenceCard(ref, { state, onOpen: trigger => openLightbox(viewable, Math.max(0, viewable.findIndex(item => item.id === ref.id)), trigger) })); grid.append(li); });
        section.append(grid);
      }
      return section;
    });
  }

  // Lightbox: Escape closes, arrows move, Tab stays inside, focus returns to the opener.
  function openLightbox(items, index, trigger) {
    const list = items.filter(item => item.url);
    if (!list.length) return;
    closeLightbox(false);
    let i = Math.min(Math.max(0, index), list.length - 1);
    // Mounted on body: the editor scroller is a size container and would otherwise trap position: fixed.
    const overlay = el('div', 'storyart-workspace sa-lightbox', '', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Просмотр изображения', tabindex: '-1' });
    const stage = el('div', 'sa-lightbox-stage');
    const figure = el('figure', 'sa-lightbox-figure');
    const frame = el('div', 'sa-lightbox-frame');
    const caption = el('figcaption', 'sa-lightbox-caption');
    const close = button('', 'sa-lightbox-icon sa-lightbox-close', () => closeLightbox(true), { 'aria-label': 'Закрыть просмотр', title: 'Закрыть (Esc)' });
    const prev = button('', 'sa-lightbox-icon sa-lightbox-arrow sa-lightbox-prev', () => show(i - 1), { 'aria-label': 'Предыдущее изображение', title: 'Предыдущее (←)' });
    const next = button('', 'sa-lightbox-icon sa-lightbox-arrow sa-lightbox-next', () => show(i + 1), { 'aria-label': 'Следующее изображение', title: 'Следующее (→)' });
    prev.hidden = next.hidden = list.length < 2;
    // Zoom: 0 means "fit the whole frame into the screen"; any other value is a multiple of the natural size.
    let scale = 0, img = null, pressedOutside = false;
    const zoomOut = button('−', 'sa-button sa-button-quiet sa-zoom-step', () => zoom((scale || fitScale()) / 1.25), { 'aria-label': 'Уменьшить' });
    const level = el('span', 'sa-zoom-level', '', { 'aria-live': 'polite' });
    const zoomIn = button('+', 'sa-button sa-button-quiet sa-zoom-step', () => zoom((scale || fitScale()) * 1.25), { 'aria-label': 'Увеличить' });
    const fit = button('Вписать', 'sa-button sa-button-quiet', () => zoom(0), { 'aria-label': 'Вписать в экран' });
    const actual = button('100%', 'sa-button sa-button-quiet', () => zoom(1), { 'aria-label': 'Исходный размер' });
    const zoomGroup = el('div', 'sa-lightbox-zoom', '', { role: 'group', 'aria-label': 'Масштаб' });
    zoomGroup.append(zoomOut, level, zoomIn, fit, actual);
    const bar = el('div', 'sa-lightbox-bar');
    bar.append(caption, zoomGroup);
    frame.append(close);
    figure.append(frame);
    stage.append(prev, figure, next);
    // The frame padding leaves room for the close button that sits on the image corner.
    const GUTTER = 44;
    function fitScale() {
      if (!img?.naturalWidth || !figure.clientWidth) return 1;
      return Math.min(1, (figure.clientWidth - GUTTER) / img.naturalWidth, (figure.clientHeight - GUTTER) / img.naturalHeight);
    }
    function zoom(value) {
      scale = value ? Math.min(8, Math.max(0.05, value)) : 0;
      overlay.classList.toggle('is-zoomed', !!scale);
      if (img?.style && img.naturalWidth) img.style.width = Math.max(1, Math.round(img.naturalWidth * (scale || fitScale()))) + 'px';
      level.textContent = Math.round((scale || fitScale()) * 100) + '%';
      fit.setAttribute('aria-pressed', String(!scale));
    }
    function show(n) {
      i = (n + list.length) % list.length;
      img?.remove();
      img = el('img'); img.src = list[i].url; img.alt = list[i].label;
      img.addEventListener('load', () => zoom(scale));
      img.addEventListener('dblclick', () => zoom(scale ? 0 : 1));
      frame.append(img);
      zoom(0);
      caption.textContent = list.length > 1 ? `${list[i].label}, ${i + 1} из ${list.length}` : list[i].label;
    }
    const controls = [prev, next, close, bar, caption, zoomGroup, zoomOut, level, zoomIn, fit, actual];
    // Anything but the picture and the controls counts as "outside"; a drag that starts on the picture never closes.
    const outside = target => target !== img && !(target?.closest ? target.closest('button, .sa-lightbox-bar') : controls.includes(target));
    const onScrollbar = event => scale && event.target === figure && (event.offsetX >= figure.clientWidth || event.offsetY >= figure.clientHeight);
    overlay.addEventListener('pointerdown', event => { pressedOutside = outside(event.target) && !onScrollbar(event); });
    overlay.addEventListener('click', event => {
      const was = pressedOutside; pressedOutside = false;
      if (was && outside(event.target) && !onScrollbar(event)) closeLightbox(true);
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); closeLightbox(true); }
      else if (event.key === 'ArrowLeft' && list.length > 1) { event.preventDefault(); show(i - 1); }
      else if (event.key === 'ArrowRight' && list.length > 1) { event.preventDefault(); show(i + 1); }
      else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn.click(); }
      else if (event.key === '-') { event.preventDefault(); zoomOut.click(); }
      else if (event.key === '0') { event.preventDefault(); zoom(0); }
      else if (event.key === 'Tab') {
        const order = [prev, next, zoomOut, zoomIn, fit, actual, close].filter(b => !b.hidden);
        const at = order.indexOf(document.activeElement);
        event.preventDefault();
        order[(at + (event.shiftKey ? order.length - 1 : 1) + order.length) % order.length].focus();
      }
    });
    const view = typeof window !== 'undefined' ? window : null;
    const onResize = () => { if (!scale) zoom(0); };
    view?.addEventListener?.('resize', onResize);
    overlay.append(stage, bar);
    show(i);
    lightbox = { overlay, trigger, cleanup: () => view?.removeEventListener?.('resize', onResize) };
    (document.body || root).append(overlay);
    zoom(0);
    close.focus();
  }
  function closeLightbox(restoreFocus) {
    if (!lightbox) return;
    const { overlay, trigger, cleanup } = lightbox;
    lightbox = null;
    cleanup?.();
    overlay.remove();
    if (restoreFocus && trigger?.isConnected !== false) trigger?.focus?.();
  }

  return {
    root,
    show() {
      const s = scopeState();
      shown = true;
      render();
      load(s);
      if (!s.jobs && !s.jobsLoading && s.route.screen === 'generate') loadJobs(s);
    },
    hide() { shown = false; stopPoll(); closeLightbox(false); },
    get visible() { return shown; },
    restore(saved) {
      const route = normalizeStoryArtRoute(saved);
      if (!route || route.scope !== getScope()) return false;
      scopeState().route = { screen: route.screen, styleId: route.styleId, jobId: route.jobId, characterId: route.characterId, category: route.category };
      return true;
    },
    // The selected book changed: late responses stay with their own scope and the new scope renders its own state.
    scopeChanged() {
      stopPoll(); closeLightbox(false);
      if (shown) { render(); load(scopeState()); }
    },
    navigate(route) { navigate(scopeState(), route); },
    route: () => routeSnapshot(),
    isLightboxOpen: () => !!lightbox,
    _state: () => scopeState()
  };
}
