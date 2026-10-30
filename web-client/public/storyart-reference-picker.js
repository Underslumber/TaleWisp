const MODES = [['auto', 'Авто'], ['confirm', 'С подтверждением'], ['manual', 'Вручную']];
const ROLE_LABELS = { STAGING_ONLY: 'Поза и постановка', POSE_SOFT: 'Поза', AUX_POSE: 'Поза', AUX_CAMERA: 'Ракурс', HUMAN_POSE_SOFT: 'Поза человека', HAND_GESTURE_ONLY: 'Кисти и жест', GROUP_COMPOSITION_SOFT: 'Композиция группы', ANIMAL_OR_DETAIL_SOFT: 'Животное или деталь', CLOTHING_REFERENCE: 'Одежда', DRAWING_TECHNIQUE: 'Приём рисунка' };
const SOURCE_LABELS = { POSE_ATLAS: 'Атлас поз', PINTEREST_SKETCH: 'Скетчи действий и жестов', COSTUME_DB_01: 'Одежда', DRAWING_GUIDES: 'Учебные примеры' };
const ANGLES = { front: 'Спереди', back: 'Сзади', side: 'Сбоку', high: 'Сверху', low: 'Снизу', oblique: 'Под углом', diag: 'Три четверти' };
const key = item => `${item.pool}:${item.id}`;
const groupOf = rec => rec?.pool === 'POSE_ATLAS' && (rec.group_id || rec.groupId) ? `POSE_ATLAS:${rec.group_id || rec.groupId}` : '';
const sameOriginImage = value => typeof value === 'string' && value.startsWith('/api/storyart/reference-image?') ? value : '';
const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); });
export function referenceObjectLabel(record) {
  if (record.pool === 'POSE_ATLAS' && (record.group_id || record.groupId)) return 'Ракурс одной позы';
  if (record.pool === 'COSTUME_DB_01') return 'Референс одежды';
  if (record.pool === 'DRAWING_GUIDES') return 'Учебный пример';
  if (record.kind === 'GROUP_SCENE' || record.role === 'GROUP_COMPOSITION_SOFT') return 'Групповая композиция';
  if (record.parent_id || record.parentId || record.provenance?.parent_id) return 'Фрагмент исходного листа';
  if (record.kind === 'SINGLE_POSE' || record.role === 'HUMAN_POSE_SOFT') return 'Одиночный скетч';
  return 'Референс';
}
export function referenceTargetKey(body) {
  return JSON.stringify({ kind: body.kind || 'generation', styleId: body.styleId || '', characterId: body.characterId || '', prompt: body.prompt || '', referenceIds: [...(body.referenceIds || [])].sort(), uploadIds: [...(body.uploadIds || [])].sort(), options: Object.fromEntries(Object.entries(body.options || {}).filter(([k]) => k !== 'bodyLibrary').sort(([a], [b]) => a.localeCompare(b))) });
}
export function createReferencePickerState(mode = 'confirm') {
  return { mode, enabled: false, plan: null, attempt: null, targetKey: '', items: [], pinned: [], meta: new Map(), groups: new Map(), view: new Map(), catalogue: null, filters: { q: '', category: '', pool: '', subject: '', offset: 0 }, openLibrary: false, busy: false, error: '', feedback: '', timer: null, epoch: 0, requestEpoch: 0 };
}

export function createReferencePickerController({ state: r, request, getTarget, revision, isVisible, repaint, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  const changed = () => repaint();
  // Pose atlas records arrive grouped: cache every real view and the group's view list.
  const remember = record => { r.groups ||= new Map(); r.meta.set(key(record), record); const g = groupOf(record); if (g && record.views?.length) { r.groups.set(g, record.views); for (const v of record.views) r.meta.set(key(v), { ...v, group_id: v.group_id || record.group_id || record.groupId }); } };
  const need = i => { const m = r.meta.get(key(i)); return !m || !!groupOf(m) && !r.groups?.has(groupOf(m)); };
  const stop = () => { if (r.timer !== null) cancel(r.timer); r.timer = null; };
  const run = async fn => { if (r.busy) return; r.busy = true; r.error = ''; changed(); try { return await fn(); } catch (e) { r.error = e.message || 'Не удалось обновить подбор.'; } finally { r.busy = false; changed(); } };
  const target = () => { const built = getTarget(); if (built.error) throw Error(built.error); return built.body; };
  const stale = body => !!r.plan && (r.targetKey !== referenceTargetKey(body) || !!r.plan.revision && !!r.catalogue?.revision && r.plan.revision !== r.catalogue.revision || !!r.plan.workspaceRevision && r.plan.workspaceRevision !== revision());
  async function hydrate(items) {
    await Promise.all(items.filter(need).map(async item => {
      try { const data = await request(`/api/storyart/references?q=${encodeURIComponent(item.id)}&limit=100&grouped=1`); for (const record of data.records || []) remember(record); } catch { /* Keep the selected source visible with an honest unavailable preview. */ }
    }));
  }
  async function adopt(plan) {
    r.plan = plan;
    if (!['selecting', 'dispatching', 'unknown'].includes(plan.status)) { r.items = [...(plan.selections || [])]; await hydrate([...r.items, ...(plan.alternatives || [])]); }
    changed(); schedule();
  }
  function schedule() {
    stop();
    if (!r.foreground && r.enabled && r.plan?.status === 'selecting' && isVisible()) r.timer = later(() => { r.timer = null; poll().catch(() => {}); }, 5000);
  }
  async function poll() {
    if (!r.plan || !isVisible()) return;
    const id = r.plan.id, epoch = r.epoch;
    try { const result = await request(`/api/storyart/references/plans/${id}`); if (epoch === r.epoch && r.plan?.id === id) await adopt(result.plan); }
    catch (e) { if (epoch === r.epoch) { r.error = e.message; changed(); } }
  }
  async function loadLibrary() {
    const serial = ++r.requestEpoch;
    const params = new URLSearchParams(Object.entries({ ...r.filters, limit: 24, grouped: 1 }).filter(([,v]) => v !== ''));
    try {
      const data = await request(`/api/storyart/references?${params}`);
      if (serial !== r.requestEpoch) return;
      r.catalogue = data; for (const record of data.records || []) remember(record);
      if (r.plan && r.plan.revision !== data.revision) r.error = 'Библиотека обновилась. Выполните новый подбор для актуальных референсов.';
      changed();
    } catch (e) { if (serial === r.requestEpoch) { r.error = e.message; changed(); } }
  }
  async function start(body = target()) {
    const signature = referenceTargetKey(body);
    if (r.attempt && r.targetKey !== signature && ['unknown', 'dispatching'].includes(r.plan?.status)) throw Error('Исход прежнего подбора не подтверждён. Проверьте его перед новой попыткой.');
    r.targetKey = signature;
    r.attempt ||= { requestId: uuid(), mode: r.mode, subject: r.filters.subject === 'MALE' || r.filters.subject === 'FEMALE' ? r.filters.subject : '', target: body, workspaceRevision: revision() };
    const epoch = ++r.epoch;
    // A lost acknowledgement must never become a new agent task on the next click.
    r.plan = { id: r.attempt.requestId, status: 'unknown', selections: [] };
    const result = await request('/api/storyart/references/plans', { method: 'POST', body: r.attempt });
    if (epoch !== r.epoch) throw Error('Режим подбора изменился во время запроса.');
    if (r.catalogue && result.plan.revision && r.catalogue.revision !== result.plan.revision) await loadLibrary();
    await adopt(result.plan);
    return result.plan;
  }
  async function save(confirm) {
    const body = target();
    if (stale(body)) throw Error('Задание изменилось. Обновите подбор перед подтверждением.');
    if (!r.plan) { const chosen = [...r.items]; await start(body); r.items = chosen; }
    if (r.plan.revision !== r.catalogue?.revision && r.catalogue && r.mode === 'manual') throw Error('Каталог изменился. Обновите подбор.');
    ++r.epoch; stop();
    const result = await request(`/api/storyart/references/plans/${r.plan.id}`, { method: 'POST', body: { items: r.items, confirm, workspaceRevision: revision() } });
    await adopt(result.plan);
  }
  function resetPlan() { stop(); r.epoch++; r.plan = null; r.attempt = null; r.targetKey = ''; r.error = ''; r.pinned = []; r.replaceKey = null; }
  const api = {
    stop, resume: schedule, stale: () => { try { return stale(target()); } catch { return !!r.plan; } },
    enable(value) { r.enabled = value; if (!value) stop(); else if (r.mode === 'manual') { r.openLibrary = true; loadLibrary(); } changed(); },
    mode(value) { if (r.busy || ['selecting', 'dispatching', 'unknown'].includes(r.plan?.status)) return; resetPlan(); r.mode = value; r.openLibrary = value === 'manual'; changed(); if (r.openLibrary) loadLibrary(); },
    browse() { r.openLibrary = !r.openLibrary; changed(); if (r.openLibrary && !r.catalogue) loadLibrary(); },
    showSelection() { r.openLibrary = false; changed(); },
    filter(field, value) { r.filters[field] = value; if (field !== 'offset') r.filters.offset = 0; return loadLibrary(); },
    loadLibrary,
    choose(record) { if (r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(r.plan?.status)) return; if (!r.plan && r.mode !== 'manual') r.mode = 'manual'; const ident = key(record); if (r.replaceKey === ident) { r.replaceKey = null; changed(); return; } if (r.replaceKey && r.items.some(i => key(i) === ident)) { r.error = 'Этот референс уже в наборе. Выберите другой источник для замены.'; changed(); return; } if (r.replaceKey) { r.items = r.items.filter(i => key(i) !== r.replaceKey); r.pinned = r.pinned.filter(k => k !== r.replaceKey); r.replaceKey = null; } if (r.items.some(i => key(i) === ident)) { r.items = r.items.filter(i => key(i) !== ident); r.pinned = r.pinned.filter(k => k !== ident); } else { if (r.items.length >= 12) { r.error = 'В набор можно добавить до 12 референсов.'; changed(); return; } const pool = r.catalogue?.pools?.find(p => p.id === record.pool); r.items.push({ pool: record.pool, id: record.id, sha256: record.sha256, role: record.role || pool?.roles?.[0] || '', title: record.title }); } if (r.plan?.status === 'ready') r.plan.status = 'awaiting_confirmation'; changed(); },
    replace(item) { r.replaceKey = key(item); r.openLibrary = true; changed(); if (!r.catalogue) loadLibrary(); },
    angle(item, view) {
      const g = groupOf(r.meta.get(key(item)) || item); if (!g || groupOf(r.meta.get(key(view)) || view) !== g) return;
      const old = key(item), next = key(view), at = r.items.findIndex(i => key(i) === old);
      // Unselected pose: only the local preview changes until the author adds it.
      if (at < 0) { (r.view ||= new Map()).set(g, next); changed(); return; }
      if (r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(r.plan?.status) || old === next) return;
      if (r.items.some(i => key(i) === next)) { r.error = 'Этот ракурс уже в наборе.'; changed(); return; }
      const prev = r.items[at];
      r.items = r.items.map((i, n) => n === at ? { pool: view.pool, id: view.id, sha256: view.sha256, role: prev.role, title: view.title, groupId: view.group_id || prev.groupId } : i);
      r.pinned = r.pinned.map(k => k === old ? next : k); if (r.replaceKey === old) r.replaceKey = next;
      (r.view ||= new Map()).set(g, next); r.error = '';
      if (r.plan?.status === 'ready') r.plan.status = 'awaiting_confirmation'; changed();
    },
    role(item, value) { if (r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(r.plan?.status)) return; item.role = value; if (r.plan?.status === 'ready') r.plan.status = 'awaiting_confirmation'; changed(); },
    pin(item) { if (r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(r.plan?.status)) return; const ident = key(item); r.pinned = r.pinned.includes(ident) ? r.pinned.filter(x => x !== ident) : [...r.pinned, ident]; changed(); },
    start: () => run(async () => { if (['selecting', 'unknown', 'dispatching', 'in_use'].includes(r.plan?.status)) throw Error('Сначала дождитесь подтверждённого результата текущего подбора.'); if (!r.plan || api.stale() || r.plan.status === 'review_required') { resetPlan(); await start(); } }),
    refresh: () => run(poll),
    rebindManual: () => run(async () => { if (r.mode !== 'manual') return; const chosen = [...r.items]; resetPlan(); await start(); r.items = chosen; changed(); }),
    retry: () => run(async () => { if (!r.attempt || !['unknown', 'dispatching'].includes(r.plan?.status)) return; if (referenceTargetKey(target()) !== r.targetKey) throw Error('Прежняя попытка относится к другому заданию. Проверьте её статус.'); await start(r.attempt.target); }),
    confirm: () => run(() => save(true)),
    regenerate: () => run(async () => {
      if (!['ready', 'awaiting_confirmation', 'review_required'].includes(r.plan?.status)) throw Error('Сначала проверьте результат текущего подбора.');
      if (!r.feedback.trim()) throw Error('Напишите, что изменить в подборе.');
      if (api.stale()) throw Error('Задание изменилось. Сначала обновите подбор.');
      const message = r.feedback, pinned = [...r.pinned];
      // Persist local replacements before pins are interpreted by the server.
      await save(false);
      ++r.epoch; stop(); r.plan.status = 'unknown'; changed();
      const result = await request(`/api/storyart/references/plans/${r.plan.id}/regenerate`, { method: 'POST', body: { message, pinned, workspaceRevision: revision() } });
      r.feedback = ''; await adopt(result.plan);
    }),
    async ensure(body) {
      if (!r.enabled) return null;
      if (r.busy) throw Error('Дождитесь завершения подбора.');
      if (stale(body)) throw Error('Задание изменилось. Обновите подбор референсов.');
      if (r.mode !== 'auto') { if (r.plan?.status !== 'ready') throw Error('Подтвердите набор референсов перед отправкой.'); return r.plan.id; }
      r.foreground = true; stop();
      try {
      if (!r.plan) await start(body);
      const frozen = referenceTargetKey(body), deadline = Date.now() + 15 * 60_000;
      while (r.plan.status === 'selecting') {
        if (!r.enabled || !isVisible() || referenceTargetKey(target()) !== frozen) throw Error('Автоподбор приостановлен: откройте актуальное задание и продолжите.');
        if (Date.now() > deadline) throw Error('Агент ещё подбирает референсы. Обновите статус позже.');
        await new Promise(resolve => later(resolve, 5000)); await poll();
      }
      if (r.plan.status !== 'ready') throw Error(r.plan.error || 'Агентский подбор пока не подтверждён.');
      if (!r.enabled || referenceTargetKey(target()) !== frozen) throw Error('Задание изменилось во время подбора.');
      return r.plan.id;
      } finally { r.foreground = false; schedule(); }
    }
  };
  return api;
}

export function renderReferencePicker({ document, state: r, controller: c, onEnable = () => {}, onMode = () => {}, openImage = () => {} }) {
  const el = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value) n.textContent = value; return n; };
  const button = (label, fn, cls = '') => { const n = el('button', `sa-button ${cls.split(/\s+/).includes('sa-button-gold') ? '' : 'sa-button-quiet'} ${cls}`, label); n.type = 'button'; n.addEventListener('click', fn); return n; };
  const box = el('section', 'sa-reference-picker');
  const title = el('label', 'sa-check'); const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = r.enabled;
  toggle.addEventListener('change', () => { onEnable(toggle.checked); c.enable(toggle.checked); }); title.append(toggle, el('strong', '', 'Использовать референсы')); box.append(title);
  if (!r.enabled) { box.append(el('p', 'sa-hint', 'Поза, жесты, одежда и другие детали из библиотеки StoryArt.')); return box; }
  const modes = el('div', 'sa-picker-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Способ выбора референсов');
  for (const [id, label] of MODES) { const b = button(label, () => { c.mode(id); onMode(r.mode); }); b.setAttribute('aria-pressed', String(r.mode === id)); b.disabled = r.busy || ['selecting', 'dispatching', 'unknown', 'in_use'].includes(r.plan?.status); modes.append(b); } box.append(modes);
  box.append(el('p', 'sa-hint', ({ auto: 'Агент выберет подходящий набор и передаст его в работу при отправке задания.', confirm: 'Агент предложит набор и альтернативы. Перед генерацией вы подтвердите выбор.', manual: 'Выберите референсы из всей библиотеки и укажите, для чего их использовать.' })[r.mode]));
  const status = r.plan?.status;
  const statuses = { selecting: 'Агент подбирает референсы…', unknown: 'Исход запуска подбора не подтверждён. Новая попытка автоматически не создаётся.', dispatching: 'Передаём подбор агенту…', awaiting_confirmation: 'Набор ждёт вашего подтверждения', ready: 'Набор готов', in_use: 'Набор передан в работу', review_required: 'Набор требует уточнения' };
  if (statuses[status]) { const line = el('p', 'sa-picker-status', statuses[status]); line.setAttribute('role', 'status'); box.append(line); }
  if (r.error || r.plan?.error) { const error = el('p', 'sa-picker-error', r.error || r.plan.error); error.setAttribute('role', 'alert'); box.append(error); }
  if (c.stale()) box.append(el('p', 'sa-picker-error', 'Задание изменилось. Этот набор нужно обновить.'));
  if (r.plan?.reason) { box.append(el('p', 'sa-note sa-picker-reason', r.plan.reason)); if (!r.items.length && !r.openLibrary) box.append(button('Выбрать вручную по изображениям', c.browse, 'sa-button-gold')); }
  if (r.replaceKey) box.append(el('p', 'sa-note', 'Выберите замену в предложенных вариантах или в библиотеке. Остальной набор сохранится.'));
  if (r.items.length) {
    const tray = el('div', 'sa-picker-tray'); tray.append(el('strong', '', status === 'ready' ? `Подтверждено: ${r.items.length}` : `В наборе: ${r.items.length}`), button('Показать набор', c.showSelection));
    if (!['selecting', 'unknown', 'dispatching', 'in_use', 'ready'].includes(status)) { const confirm = button('Подтвердить', c.confirm, 'sa-button-gold'); confirm.disabled = r.busy || c.stale(); tray.append(confirm); } box.append(tray);
  }
  const viewsOf = rec => { const g = groupOf(rec); return g ? r.groups?.get(g) || rec.views || [] : []; };
  const shownItem = base => { const rec = r.meta.get(key(base)) || base, g = groupOf(rec); if (!g || r.items.some(i => key(i) === key(base))) return base; const views = viewsOf(rec); const v = views.find(x => key(x) === r.view?.get(g)) || views.find(x => r.items.some(i => key(i) === key(x))); return v ? { pool: v.pool, id: v.id, sha256: v.sha256, title: v.title, groupId: v.group_id } : base; };
  const rows = items => {
    const grid = el('div', 'sa-picker-grid');
    for (const base of items) { const item = shownItem(base);
      const record = r.meta.get(key(item)) || item; const card = el('article', 'sa-picker-card'); const image = sameOriginImage(record.previewUrl);
      const art = button('', () => { if (image) openImage(image, record.title || item.id); }, 'sa-picker-art');
      if (image) { const img = el('img'); img.src = image; img.alt = record.title || 'Референс'; img.loading = 'lazy'; img.addEventListener('error', () => art.replaceChildren(el('span', '', 'Просмотр сейчас недоступен'))); art.append(img); }
      else art.append(el('span', '', record.previewReason || 'Просмотр требует проверки StoryArt'));
      art.disabled = !image; card.append(art, el('strong', 'sa-picker-name', record.title || item.title || item.id));
      const views = viewsOf(record);
      if (views.length > 1) {
        // Filmstrip of the pose's real views: switching is local, never a new agent request.
        const locked = r.items.some(i => key(i) === key(item)) && (r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(status));
        const at = Math.max(0, views.findIndex(v => key(v) === key(item))), nameOf = v => ANGLES[v.angle] || v.angle || v.title || v.id;
        const strip = el('div', 'sa-angle-strip'); strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', `Ракурсы позы: ${views.length}`);
        const setView = v => { r.angleFocus = key(v); c.angle(item, v); Promise.resolve().then(() => { r.angleFocus = null; }); };
        const chips = views.map((v, n) => {
          const on = n === at, b = el('button', on ? 'sa-angle is-active' : 'sa-angle'); b.type = 'button'; b.title = nameOf(v); b.setAttribute('aria-label', `Ракурс: ${nameOf(v)}`); b.setAttribute('aria-pressed', String(on)); b.tabIndex = on ? 0 : -1; b.disabled = locked;
          const fallback = () => el('span', 'sa-angle-alt', nameOf(v).slice(0, 2));
          const src = sameOriginImage(r.meta.get(key(v))?.previewUrl || v.previewUrl);
          if (src) { const img = el('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.addEventListener('error', () => b.replaceChildren(fallback())); b.append(img); } else b.append(fallback());
          b.addEventListener('click', () => { if (!on) setView(v); });
          b.addEventListener('keydown', e => { const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; const to = e.key === 'Home' ? 0 : e.key === 'End' ? views.length - 1 : step ? (n + step + views.length) % views.length : -1; if (to < 0) return; e.preventDefault(); chips[to]?.focus(); if (to !== at) setView(views[to]); });
          if (r.angleFocus === key(v)) { r.angleFocus = null; Promise.resolve().then(() => { if (b.isConnected) b.focus(); }); }
          strip.append(b); return b;
        });
        const cap = el('p', 'sa-angle-caption'); cap.setAttribute('aria-live', 'polite'); cap.append(el('strong', '', nameOf(views[at])), el('span', '', `${at + 1} / ${views.length}`));
        card.append(strip, cap);
      }
      else if (record.angle) card.append(el('span', 'sa-hint', ANGLES[record.angle] || record.angle));
      const selected = r.items.some(i => key(i) === key(item));
      card.append(el('span', 'sa-hint', referenceObjectLabel(record)), el('span', 'sa-hint', SOURCE_LABELS[item.pool] || item.pool), el('span', 'sa-picker-badge', record.subject_label_status === 'UNKNOWN' ? 'Требует проверки' : 'Кандидат'));
      const pick = button(selected ? 'Убрать из набора' : r.replaceKey ? 'Выбрать замену' : !r.plan && r.mode !== 'manual' ? 'Выбрать вручную' : 'Добавить в набор', () => c.choose({ ...record, ...item })); pick.disabled = r.busy || ['selecting', 'unknown', 'in_use'].includes(status); card.append(pick);
      if (selected) {
        const replace = button('Заменить', () => c.replace(item)); replace.disabled = r.busy || ['selecting', 'unknown', 'in_use'].includes(status); card.append(replace);
        const chosen = r.items.find(i => key(i) === key(item)); const pool = r.catalogue?.pools?.find(p => p.id === item.pool); const roles = record.role ? [record.role] : pool?.roles || [chosen.role];
        const use = el('label', 'sa-field'); use.append(el('span', 'sa-hint', 'Использовать для')); const select = el('select', 'sa-input'); for (const role of roles) { const option = el('option', '', ROLE_LABELS[role] || role); option.value = role; select.append(option); } select.value = chosen.role; select.disabled = r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(status); select.addEventListener('change', () => c.role(chosen, select.value)); use.append(select); card.append(use);
        if (r.mode !== 'manual') { const pin = button(r.pinned.includes(key(item)) ? 'Закреплён' : 'Закрепить', () => c.pin(item)); pin.disabled = r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(status); pin.setAttribute('aria-pressed', String(r.pinned.includes(key(item)))); card.append(pin); }
      }
      if (record.group_id && viewsOf(record).length < 2) card.append(button('Ракурсы этой позы', () => { r.openLibrary = true; c.filter('q', record.group_id); }));
      const parentId = record.parent_id || record.parentId || record.provenance?.parent_id;
      if (parentId) card.append(button('Материалы исходного листа', () => { r.openLibrary = true; c.filter('q', parentId); }));
      if (record.group_display || record.provenance) { const details = el('details', 'sa-picker-details'); details.append(el('summary', '', 'Источник и примечания')); if (record.group_display) details.append(el('p', 'sa-hint', record.group_display)); const note = record.provenance?.review_notes || record.provenance?.review_evidence || record.provenance?.contact_evidence; if (note) details.append(el('p', 'sa-hint', String(note))); card.append(details); }
      grid.append(card);
    } return grid;
  };
  if (r.items.length) { box.append(el('h3', 'sa-h3', `Выбрано для генерации · ${r.items.length}`), (g => (g?.classList?.add('sa-picker-selected'), g))(rows(r.items))); }
  const selGroups = new Set(r.items.map(i => groupOf(r.meta.get(key(i)) || i)).filter(Boolean)), seenAlt = new Set();
  // One card per pose: alternatives never repeat a selected pose or each other.
  const alternatives = (r.plan?.alternatives || []).filter(item => { const g = groupOf(r.meta.get(key(item)) || item); if (r.items.some(s => key(s) === key(item)) || g && (selGroups.has(g) || seenAlt.has(g))) return false; if (g) seenAlt.add(g); return true; });
  if (alternatives.length) box.append(el('h3', 'sa-h3', 'Другие варианты — нажмите изображение для просмотра'), (g => (g?.classList?.add('sa-picker-alts'), g))(rows(alternatives)));
  const actions = el('div', 'sa-row');
  if (r.mode !== 'manual') { const b = button(c.stale() || status === 'review_required' ? 'Обновить подбор' : 'Подобрать референсы', c.start); b.disabled = r.busy || ['selecting', 'unknown', 'dispatching', 'in_use'].includes(status) || ['ready', 'awaiting_confirmation'].includes(status) && !c.stale(); actions.append(b); }
  else if (c.stale()) actions.append(button('Обновить набор для задания', c.rebindManual));
  actions.append(button(r.openLibrary ? 'Свернуть библиотеку' : 'Выбрать по изображениям из всей библиотеки', c.browse, r.openLibrary ? undefined : 'sa-button-gold'));
  if (status === 'selecting' || status === 'unknown') actions.append(button('Обновить статус', c.refresh));
  if (status === 'unknown') actions.append(button('Повторить ту же попытку', c.retry));
  if (r.items.length && !['selecting', 'unknown', 'dispatching', 'in_use'].includes(status)) { const b = button('Подтвердить набор', c.confirm, 'sa-button-gold'); b.disabled = r.busy || c.stale(); actions.append(b); }
  box.append(actions);
  if (r.items.length && r.mode !== 'manual' && ['ready', 'awaiting_confirmation', 'review_required'].includes(status)) {
    const label = el('label', 'sa-field'); label.append(el('span', 'sa-label', 'Что изменить в подборе?')); const input = el('textarea', 'sa-input'); input.value = r.feedback; input.maxLength = 1500; input.disabled = r.busy; input.placeholder = 'Например: более спокойная поза, другой ракурс'; input.addEventListener('input', () => { r.feedback = input.value; }); label.append(input); box.append(label, button('Подобрать другие, сохранив закреплённые', c.regenerate));
  }
  if (r.openLibrary) {
    const filters = el('div', 'sa-picker-filters'); const query = el('input', 'sa-input'); query.type = 'search'; query.placeholder = 'Поиск по действию, описанию или тегам'; query.value = r.filters.q; query.addEventListener('input', () => { r.filters.q = query.value; }); query.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); c.filter('q', query.value); } }); filters.append(query, button('Найти', () => c.filter('q', query.value)));
    const dropdown = (name, choices) => { const select = el('select', 'sa-input'); select.setAttribute('aria-label', name === 'category' ? 'Назначение референса' : name === 'pool' ? 'Источник' : 'Субъект'); for (const [value, title] of choices) { const option = el('option', '', title); option.value = value; select.append(option); } select.value = r.filters[name]; select.addEventListener('change', () => c.filter(name, select.value)); filters.append(select); };
    dropdown('category', [['', 'Все назначения'], ...(r.catalogue?.categories || []).map(x => [x.id, `${x.label} · ${x.count}`])]);
    dropdown('pool', [['', 'Все источники'], ...(r.catalogue?.pools || []).map(x => [x.id, SOURCE_LABELS[x.id] || x.id])]); dropdown('subject', [['', 'Все'], ['MALE', 'Мужские'], ['FEMALE', 'Женские'], ['UNKNOWN', 'Без подтверждённой метки']]);
    box.append(filters);
    if (!r.catalogue) box.append(el('p', 'sa-hint', 'Загружаем библиотеку…'));
    else { box.append(el('p', 'sa-hint', `Найдено: ${r.catalogue.total}. Категории могут пересекаться.`), (g => (g?.classList?.add('sa-picker-library'), g))(rows(r.catalogue.records || []))); const nav = el('div', 'sa-row'); const back = button('Назад', () => c.filter('offset', Math.max(0, r.filters.offset - 24))); back.disabled = !r.filters.offset; const next = button('Дальше', () => c.filter('offset', r.filters.offset + 24)); next.disabled = r.filters.offset + 24 >= r.catalogue.total; nav.append(back, next); box.append(nav); }
  }
  box.append(el('p', 'sa-hint', 'Подтверждение набора не меняет утверждённую внешность персонажа. Совместимость источников StoryArt проверит перед использованием.'));
  return box;
}
