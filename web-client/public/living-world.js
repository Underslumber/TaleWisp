// Main-workspace module. Positions and history come only from committed server checkpoints.
export function createLivingWorld({ api, notify, getScope, isActive, document: doc = document }) {
  const root = doc.createElement('section'); root.className = 'living-world';
  let stageCard = null, stageController = null, stageSnapshot = null;
  let scope = '', generation = 0, refreshVersion = 0, commandQueue = Promise.resolve(), timer = null, state = null, branches = [], cast = [], selected = '', viewpoint = 'author', observer = '', checkpoint = '', target = '', imported = null, draft = null, apiStatus = null;
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, callback, cls = 'button button-quiet') => { const n = el('button', cls, text); n.type = 'button'; n.addEventListener('click', () => void task(callback)); return n; };
  const input = (label, type = 'text', value = '') => { const wrap = el('label', 'lw-field'), n = el('input'); n.type = type; n.value = value; wrap.append(el('span', '', label), n); return { wrap, n }; };
  const select = (label, options, value, callback) => { const wrap = el('label', 'lw-field'), n = el('select'); for (const [id, name] of options) { const o = el('option', '', name); o.value = id; n.append(o); } n.value = value; if (callback) n.addEventListener('change', () => void task(() => callback(n.value))); wrap.append(el('span', '', label), n); return { wrap, n }; };
  const section = (title, text) => { const s = el('section', 'lw-card'); s.append(el('h3', '', title)); if (text) s.append(el('p', 'lw-muted', text)); return s; };
  function title(text, detail) { const n = el('header', 'lw-heading'); n.append(el('p', 'eyebrow', 'ОТДЕЛЬНАЯ ВЕТКА · WORLDX'), el('h1', '', text), el('p', 'lw-muted', detail)); return n; }
  async function task(fn) { try { await fn(); } catch (e) {
    notify(e.message, true);
    let p = root.querySelector('[data-lw-error]');
    if (!p) { root.replaceChildren(title('Живой мир', 'Не удалось загрузить состояние мира.')); p = el('p', 'lw-error'); p.dataset.lwError = ''; root.append(p, button('Повторить загрузку', show)); }
    p.textContent = e.message; p.hidden = false;
  } }
  function stop() { clearTimeout(timer); timer = null; }
  function poll() { stop(); if (!isActive() || !selected || imported) return; timer = setTimeout(() => void task(async () => { await refresh(); poll(); }), 900); }
  async function refresh() {
    if (scope !== getScope()) { scope = getScope(); generation++; selected = ''; state = null; cast = []; observer = ''; checkpoint = ''; }
    const seq = generation, version = ++refreshVersion, current = getScope();
    const status = await api('/api/living-world/status'); if (seq !== generation || current !== getScope()) return;
    branches = status.branches; apiStatus = status.api; if (!selected || !branches.some(b => b.id === selected)) selected = [...branches].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1)?.id || '';
    if (selected) {
      const query = new URLSearchParams({ view: viewpoint }); if (observer) query.set('actorId', observer); if (checkpoint) query.set('checkpoint', checkpoint);
      const next = await api('/api/living-world/branches/' + selected + '?' + query); if (seq !== generation || version !== refreshVersion || current !== getScope()) return;
      const changed = !state || next.revision !== state.revision || next.branchId !== state.branchId || next.view !== state.view || next.actorId !== state.actorId || next.checkpoint !== state.checkpoint || JSON.stringify(next.runtime) !== JSON.stringify(state.runtime) || JSON.stringify(next.quota) !== JSON.stringify(state.quota);
      state = next; if (next.view === 'author') cast = next.actors; observer ||= next.heroId; if (changed) render();
    } else { state = null; render(); }
  }
  function command(operation, args = {}) {
    const branch = selected, commandScope = getScope();
    const pending = commandQueue.then(async () => {
      if (!state || state.replay || branch !== selected || commandScope !== getScope()) throw new Error('Вернитесь к текущему состоянию ветки.');
      stop(); refreshVersion++;
      try { const next = await api('/api/living-world/branches/' + branch + '/command', { method: 'POST', body: { operation, args, expectedRevision: state.revision, requestId: crypto.randomUUID() } }); state = next; render(); await refresh(); }
      finally { poll(); }
    });
    commandQueue = pending.catch(() => {}); return pending;
  }
  async function importWorld() {
    stop();
    stageController?.destroy(); stageController = stageCard = null;
    const extra = root.querySelector('[data-extra-sources]')?.value || '';
    imported = await api('/api/living-world/import', { method: 'POST', body: { sourcePaths: extra.split(/\n|;/).map(x => x.trim()).filter(Boolean) } });
    draft = { name: imported.name + ' · ветка', heroId: '', startLabel: '', tickMinutes: 10, locations: [], characters: [], edges: [], objects: [], scheduled: [], rules: [], stagingNotes: ['Координаты задают только схему; переходы и длительности задаёт автор.'], sources: [] };
    render();
  }
  async function createBranch() {
    if (!draft?.heroId) throw new Error('Добавьте места и персонажа, выберите героя.');
    const result = await api('/api/living-world/branches', { method: 'POST', body: { importId: imported.id, setup: draft, approved: true } });
    selected = result.branchId; checkpoint = ''; imported = draft = null; state = null; await refresh(); poll();
  }
  function render() {
    const focused = doc.activeElement; if (focused && root.contains(focused) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName) && state?.runtime.running) return;
    root.replaceChildren(title('Живой мир', 'Мир из базы TaleWisp. Путешествия, встречи и последствия — в собственной истории, с сохранением исходников.'));
    const error = el('p', 'lw-error'); error.dataset.lwError = ''; error.hidden = !state?.runtime.error; error.textContent = state?.runtime.error || ''; root.append(error);
    const toolbar = el('div', 'lw-toolbar');
    if (branches.length) toolbar.append(select('Ветка', branches.map(b => [b.id, b.name]), selected, async value => { selected = value; state = null; checkpoint = ''; observer = ''; await refresh(); }).wrap);
    toolbar.append(button('Перенести текущую серию', importWorld), button('Обновить', async () => { state = null; await refresh(); })); root.append(toolbar);
    if (!imported) { const paths = input('Дополнительные первоисточники: относительные пути через точку с запятой'); paths.n.dataset.extraSources = ''; paths.n.placeholder = 'Необязательно — сцена из подключённой серии'; root.append(paths.wrap); }
    if (viewpoint === 'author') root.append(apiConnection());
    if (imported) { renderImport(); return; }
    if (!state) {
      const empty = section('Новая история мира', 'Перенесите записи выбранной серии, проверьте постановку и создайте отдельную ветку. Неизвестные положения, даты и дороги останутся открытыми.');
      root.append(empty); return;
    }
    const top = el('div', 'lw-toolbar');
    top.append(select('Обзор', [['author', 'Автор — вся ветка'], ['role', 'Восприятие персонажа']], viewpoint, async value => { viewpoint = value; state = null; await refresh(); }).wrap);
    const actors = cast.length ? cast : state.actors;
    top.append(select('Персонаж', actors.map(a => [a.id, a.name]), observer, async value => { observer = value; state = null; await refresh(); }).wrap);
    top.append(select('История', [['', 'Текущее состояние'], ...state.checkpoints.map(c => [c, 'Снимок ' + Number(c.slice(3))])], checkpoint, async value => { checkpoint = value; state = null; await refresh(); }).wrap);
    top.append(button('Создать ответвление', async () => { const b = await api('/api/living-world/branches/' + selected + '/fork', { method: 'POST', body: { checkpoint: state.checkpoint } }); selected = b.branchId; state = null; checkpoint = ''; await refresh(); })); root.append(top);
    const status = el('div', 'lw-status'); status.append(el('strong', '', state.runtime.busy ? 'Вычисляется новый такт…' : state.runtime.running ? 'Мир развивается' : state.replay ? 'Просмотр записанной истории' : 'На паузе'), el('span', '', `${state.startLabel || 'Начало ветки'} · +${state.elapsed * state.tickMinutes} мин · ревизия ${state.revision}`)); root.append(status);
    const layout = el('div', 'lw-layout'), main = el('div', 'lw-main'), side = el('div', 'lw-side'); layout.append(main, side); root.append(layout);
    main.append(map());
    const participants = section('Участники', 'Выберите персонажа, чтобы посмотреть доступную ему память и следить за ним в сцене.');
    for (const actor of state.actors) {
      const location = state.locations.find(l => l.id === actor.location), trip = state.travels[actor.id];
      const row = button(actor.name + ' · ' + (trip ? trip.status === 'blocked' ? 'переход закрыт' : 'в пути' : location?.name || 'место не раскрыто'), async () => { observer = actor.id; state = null; await refresh(); stageController?.camera('follow', actor.id); });
      row.classList.add('lw-participant'); row.classList.toggle('lw-participant-selected', actor.id === observer); participants.append(row);
    }
    const focusedActor = state.actors.find(a => a.id === observer);
    if (focusedActor?.goal) participants.append(el('p', 'lw-muted', focusedActor.goal));
    side.append(participants);
    if (viewpoint === 'author' && !state.replay) controls(main, side);
    const journal = section('События', 'Только произошедшее в выбранном снимке. В режиме персонажа скрытые события отсутствуют.');
    const list = el('ol', 'lw-events'); for (const event of state.events.slice(-60).reverse()) { const li = el('li'); li.append(el('span', 'lw-time', '+' + event.tick * state.tickMinutes + ' мин'), el('span', '', event.text)); list.append(li); }
    if (!list.children.length) journal.append(el('p', 'lw-muted', 'Первые события появятся после действия или шага.')); journal.append(list); main.append(journal);
    const memory = section('Память и знание', 'Сообщение собеседника не становится доказанным фактом. Чужие мысли не передаются.');
    const own = state.memories[observer] || state.memories[state.heroId] || [];
    for (const m of own.slice(-12).reverse()) { const row = el('div', 'lw-memory'); row.append(el('small', 'lw-muted', ({ hearsay: 'Сообщение', belief: 'Убеждение', observation: 'Наблюдение', entry_memory: 'Начальное знание' })[m.kind] || m.kind), el('p', '', m.text)); memory.append(row); }
    if (!own.length) memory.append(el('p', 'lw-muted', 'У этого участника пока нет записанных воспоминаний.')); side.append(memory);
    if (viewpoint === 'author') {
      const info = section('Постановка', 'Изменения симуляции не применяются к рукописи или канону.');
      for (const note of state.stagingNotes || []) info.append(el('p', 'lw-muted', note));
      info.append(el('p', 'lw-muted', `Модельные вызовы: ${state.quota?.used || 0} / ${state.quota?.limit || 0}. Replay не вызывает модель.`)); side.append(info);
    }
  }
  function map() {
    if (!stageCard) {
      stageCard = section('Сцена мира', ''); stageCard.classList.add('lw-scene-card');
      const tools = el('div', 'lw-camera-tools');
      const expand = button('Развернуть', () => { expand.textContent = stageCard.classList.toggle('lw-scene-expanded') ? 'Свернуть' : 'Развернуть'; });
      tools.append(button('−', () => stageController?.camera('out')), button('+', () => stageController?.camera('in')),
        button('Вся сцена', () => stageController?.camera('fit')), button('Следить за героем', () => stageController?.camera('follow', state.heroId)), expand);
      const frame = el('div', 'lw-scene-frame'), host = el('div', 'lw-stage-host'), overlay = el('div', 'lw-stage-labels');
      host.setAttribute('aria-label', 'Игровая сцена WorldX: местность, персонажи и перемещения'); host.setAttribute('role', 'img');
      frame.append(host, overlay); stageCard.append(tools, frame);
      stageCard.append(el('p', 'lw-stage-caption', 'WORLDX / PHASER · Перетаскивайте сцену, приближайте колесом. Оформление и фигурки условные; позиции и реплики — из ветки.'));
      const currentCard = stageCard;
      host.append(el('p', 'lw-stage-loading', 'Загружается игровая сцена WorldX…'));
      void task(async () => {
        const { createWorldStage } = await import('./vendor/living-world-stage.js');
        if (stageCard !== currentCard) return;
        host.replaceChildren();
        stageController = createWorldStage(host, overlay, (kind, id) => {
          if (kind === 'location') { target = id; render(); }
          else { observer = id; state = null; void task(refresh); }
        });
        stageController.update(stageSnapshot);
      });
    }
    stageSnapshot = state; stageController?.update(state);
    const old = stageCard.querySelector('.lw-place-options'); old?.remove();
    const destinations = el('div', 'lw-place-options');
    if (viewpoint === 'author' && !state.replay) {
      const step = button('Шаг мира', () => command('step')); step.disabled = state.runtime.busy || state.runtime.running;
      destinations.append(step, button('Пауза', () => api('/api/living-world/branches/' + selected + '/pause', { method: 'POST', body: {} })));
    }
    for (const location of state.locations) {
      const n = button(location.name, () => { target = location.id; render(); });
      n.classList.toggle('lw-place-picked', target === location.id); destinations.append(n);
    }
    stageCard.append(destinations); return stageCard;
  }
  function controls(main, side) {
    const playback = section('Ход времени'), bar = el('div', 'lw-toolbar'), steps = input('Горизонт, тактов', 'number', 6); steps.n.min = '1'; steps.n.max = '24';
    const step = button('Один шаг', () => command('step'), 'button button-primary'); step.disabled = state.runtime.busy || state.runtime.running;
    const run = button('Продолжить', async () => { await api('/api/living-world/branches/' + selected + '/run', { method: 'POST', body: { ticks: Number(steps.n.value) } }); state = null; await refresh(); }); run.disabled = state.runtime.busy || state.runtime.running;
    bar.append(step, run, button('Пауза', async () => { await api('/api/living-world/branches/' + selected + '/pause', { method: 'POST', body: {} }); state = null; await refresh(); }), steps.wrap, button('Сохранить снимок', () => command('checkpoint'))); playback.append(bar); main.append(playback);
    const actions = section('Действия'), actor = select('Участник', state.actors.map(a => [a.id, a.name]), observer, null), destination = state.locations.find(l => l.id === target);
    actions.append(actor.wrap, el('p', 'lw-muted', destination ? 'Выбрано: ' + destination.name : 'Выберите место на карте.'));
    const route = button('Отправиться к выбранному месту', async () => { if (!target) throw new Error('Выберите место на карте.'); await command('queueIntent', { actorId: actor.n.value, actionType: 'route', targetId: target }); }, 'button button-primary'); route.disabled = !target || state.runtime.busy; actions.append(route);
    actions.append(button('Продолжить прерванный переход', () => command('queueIntent', { actorId: actor.n.value, actionType: 'resumeTravel' })));
    const recipient = select('Собеседник', state.actors.map(a => [a.id, a.name]), state.actors.find(a => a.id !== observer)?.id, null), words = input('Сказать');
    actions.append(recipient.wrap, words.wrap, button('Передать реплику', async () => { await command('queueIntent', { actorId: actor.n.value, actionType: 'speech', targetId: recipient.n.value, text: words.n.value }); })); side.append(actions);
    const autonomy = section('Самостоятельность', 'Модель получает только пакет своего персонажа. Герой управляется автором, пока автономия героя не включена явно.');
    const mode = select('Режим', [['manual', 'Авторские действия'], ['plans', 'Заданные планы NPC'], ['llm', 'Самостоятельные решения модели']], state.mode, null), limit = input('Разрешить ещё вызовов', 'number', 4); limit.n.min = '0'; limit.n.max = '40';
    const provider = select('Вариант работы', [['codex', 'Codex · текущая подписка'], ['openai', 'OpenAI API · отдельные кредиты']], state.provider || 'codex', null), budget = input('API-бюджет этой сессии, $', 'number', 1); budget.n.min = '0'; budget.n.step = '0.1';
    autonomy.append(mode.wrap, provider.wrap, limit.wrap, budget.wrap); const enabled = [];
    for (const a of state.actors) { const check = input(a.name, 'checkbox'); check.n.checked = state.autonomyActors?.includes(a.id) === true; autonomy.append(check.wrap); enabled.push([a.id, check.n]); }
    const hero = input('Разрешить самостоятельные решения героя', 'checkbox'); hero.n.checked = state.autonomousHero;
    autonomy.append(hero.wrap, button('Применить управление', () => command('configure', { mode: mode.n.value, provider: provider.n.value, apiBudgetUsd: Number(budget.n.value), autonomyActors: enabled.filter(([, n]) => n.checked).map(([id]) => id), autonomousHero: hero.n.checked, modelLimit: Number(limit.n.value) })));
    autonomy.append(el('p', 'lw-muted', `API: оценка по измеренным токенам $${(state.quota?.apiMeasuredUsd || 0).toFixed(4)}; зарезервировано не более $${(state.quota?.apiReservedUsd || 0).toFixed(4)}. Это локальный учёт, не баланс программы.`)); side.append(autonomy);
    const events = section('Вмешательство автора', 'Событие изменяет только эту ветку. Удалённые участники не узнают о нём автоматически.');
    const where = select('Место', state.locations.map(l => [l.id, l.name]), target || state.locations[0]?.id, null), description = input('Что происходит'), after = input('Через тактов (0 — сейчас)', 'number', 0), edge = select('Изменить переход', [['', 'Не менять переходы'], ...state.edges.map(e => [e.id, e.from + ' → ' + e.to])], '', null), edgeState = select('Доступность', [['false', 'Закрыт'], ['true', 'Открыт']], 'false', null);
    events.append(where.wrap, description.wrap, after.wrap, edge.wrap, edgeState.wrap, button('Внести событие', () => command(Number(after.n.value) > 0 ? 'scheduleEvent' : 'intervene', { location: where.n.value, text: description.n.value, ...(Number(after.n.value) > 0 ? { at: state.elapsed + Number(after.n.value) } : {}), ...(edge.n.value ? { edgeId: edge.n.value, open: edgeState.n.value === 'true' } : {}) }))); side.append(events);
  }
  function apiConnection() {
    const details = el('details', 'lw-api'), summary = el('summary', '', 'API для мира · ' + (apiStatus?.configured ? 'ключ сохранён на сервере' : 'не подключён')); details.append(summary);
    details.append(el('p', 'lw-muted', 'Дополнительный вариант, не заменяющий Codex. GPT-6.1 Sol / medium. Все решения проходят TaskWarden. Ключ не передаётся WorldX и не сохраняется в браузере.'));
    const key = input('API-ключ', 'password'), project = input('Project ID (необязательно)'), output = input('Предел ответа, токенов', 'number', apiStatus?.maxOutputTokens || 4096);
    key.n.autocomplete = 'new-password'; key.n.placeholder = apiStatus?.configured ? 'Оставьте пустым, чтобы сохранить текущий' : 'sk-…'; output.n.min = '512'; output.n.max = '8192';
    details.append(key.wrap, project.wrap, output.wrap, button('Сохранить подключение', async () => {
      const body = { maxOutputTokens: Number(output.n.value) }; if (key.n.value) body.apiKey = key.n.value.trim(); if (project.n.value) body.projectId = project.n.value.trim();
      await api('/api/living-world/api-settings', { method: 'POST', body }); key.n.value = ''; state = null; await refresh();
    }), button('Проверить доступ без генерации', async () => { apiStatus = await api('/api/living-world/api-check', { method: 'POST', body: {} }); notify(apiStatus.lastCheck?.available ? 'Доступ к GPT-6.1 Sol подтверждён. Платная генерация не выполнялась.' : 'Ключ принят, но GPT-6.1 Sol не найден среди доступных моделей.', !apiStatus.lastCheck?.available); state = null; await refresh(); }));
    const link = el('a', '', 'Программа API-кредитов и срок их действия'); link.href = 'https://developers.openai.com/api/docs/guides/chatgpt-api-credits'; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link);
    return details;
  }
  function renderImport() {
    root.append(title(imported.name, `Перенесено источников: ${imported.sourceCount}. Сущностей: ${imported.entities.length}. Это снимок базы, а не новые знания каждого персонажа.`));
    for (const gap of imported.gaps) root.append(el('p', 'lw-muted', gap));
    const layout = el('div', 'lw-layout'), setup = section('Начальная постановка', 'Добавляйте места и участников из источников. Связи, длительности и начальные знания подтверждаются только для этой ветки.'), library = section('Библиотека мира'); layout.append(setup, library); root.append(layout);
    const name = input('Название ветки', 'text', draft.name), time = input('Момент начала', 'text', draft.startLabel), minutes = input('Минут в такте', 'number', draft.tickMinutes); setup.append(name.wrap, time.wrap, minutes.wrap);
    const sources = select('Источник', imported.sources.map(s => [s.path, `${s.title} · ${s.status}`]), imported.sources[0]?.path, null), preview = el('pre', 'lw-source'); library.append(sources.wrap, preview);
    let source = null;
    sources.n.addEventListener('change', () => void task(loadSource));
    async function loadSource() { source = await api('/api/living-world/imports/' + imported.id + '/source?' + new URLSearchParams({ path: sources.n.value })); preview.textContent = source.text; } void task(loadSource);
    const entityName = input('Имя места или персонажа'), goal = input('Собственная цель персонажа'), place = select('Начальное место', draft.locations.map(l => [l.id, l.name]), draft.locations[0]?.id, null);
    library.append(entityName.wrap, goal.wrap, place.wrap);
    const ref = () => { if (!source) throw new Error('Сначала выберите источник.'); return { path: source.path, sha256: source.sha256, fragmentId: source.id }; };
    library.append(button('Добавить место из источника', () => { const n = draft.locations.length; draft.locations.push({ id: 'loc_' + crypto.randomUUID().slice(0, 8), name: entityName.n.value || source.title, description: '', x: 100 + n % 4 * 220, y: 100 + Math.floor(n / 4) * 150, encounters: true, source: ref() }); syncDraft(); render(); }));
    library.append(button('Добавить персонажа из источника', () => { if (!goal.n.value.trim() || !place.n.value) throw new Error('Укажите цель и начальное место.'); const id = 'actor_' + crypto.randomUUID().slice(0, 8); draft.characters.push({ id, name: entityName.n.value || source.title, role: draft.heroId ? 'npc' : 'hero', location: place.n.value, goal: goal.n.value, speakingStyle: '', knowledge: [], plan: [], source: ref() }); draft.heroId ||= id; syncDraft(); render(); }));
    setup.append(el('p', '', 'Места: ' + (draft.locations.map(l => l.name).join(', ') || 'ещё не добавлены')), el('p', '', 'Участники: ' + (draft.characters.map(c => c.name).join(', ') || 'ещё не добавлены')));
    const from = select('Переход от', draft.locations.map(l => [l.id, l.name]), '', null), to = select('Куда', draft.locations.map(l => [l.id, l.name]), '', null), duration = input('Длительность в тактах', 'number', '');
    setup.append(from.wrap, to.wrap, duration.wrap, button('Добавить направленный переход', () => { if (!from.n.value || from.n.value === to.n.value || Number(duration.n.value) < 1) throw new Error('Нужны разные места и явная длительность.'); draft.edges.push({ id: 'edge_' + crypto.randomUUID().slice(0, 8), from: from.n.value, to: to.n.value, ticks: Number(duration.n.value), open: true, provenance: 'approved_staging: авторская постановка в интерфейсе' }); syncDraft(); render(); }));
    const knownBy = select('Начальные знания участника', draft.characters.map(c => [c.id, c.name]), draft.heroId, null);
    library.append(knownBy.wrap, button('Выдать текст выбранного источника этому участнику', () => { const actor = draft.characters.find(a => a.id === knownBy.n.value); if (!actor || !source) throw new Error('Выберите участника и прочитайте источник.'); actor.knowledge.push({ text: source.text, kind: 'entry_memory', source: ref() }); syncDraft(); render(); }));
    library.append(button('Сохранить источник как правило мира', () => { draft.rules.push({ text: source.text, source: ref(), executable: false }); syncDraft(); render(); }));
    setup.append(el('p', 'lw-muted', `Переходов: ${draft.edges.length}. Правил с источниками: ${draft.rules.length}. Неподдержанные механики не исполняются автоматически.`));
    const details = el('details'), summary = el('summary', '', 'Полная постановка и планы участников'), json = el('textarea', 'lw-json'); json.value = JSON.stringify(draft, null, 2); json.rows = 14; details.append(summary, json, button('Применить полный состав', () => { draft = JSON.parse(json.value); render(); })); setup.append(details);
    function syncDraft() { draft.name = name.n.value; draft.startLabel = time.n.value; draft.tickMinutes = Number(minutes.n.value); }
    setup.append(button('Подтвердить постановку и создать ветку', async () => { syncDraft(); await createBranch(); }, 'button button-primary'), button('Отменить импорт', () => { imported = draft = null; render(); }));
  }
  async function show() { if (scope !== getScope()) { scope = getScope(); selected = ''; state = null; observer = ''; checkpoint = ''; imported = draft = null; } generation++; state = null; root.replaceChildren(title('Живой мир', 'Подключаем состояние выбранной серии…')); await task(refresh); poll(); }
  function hide() { generation++; stop(); stageController?.destroy(); stageController = stageCard = null; }
  return { root, show, hide };
}
