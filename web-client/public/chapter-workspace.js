// Chapter workspace inside the editor pane: main-manuscript choice, Google table of contents,
// group loading, per-chapter editing with local persistence, new chapters, reviewed write-back.
import {
  createScopeGuard, scopeKeyOf, storageKeyOf, isDirty, detectionLabel, sectionTitle, wordsLabel, loadedFromSection, mergeLoaded,
  rebaseOnRemote, newChapterItem, buildWritePayload, writeSnapshot, adoptCreated, settleAfterWrite, serializeState, parseState, googleDocUrl, mergeWorkingChapter,
  isQuarantined, quarantineNew, markAttempt,
} from './manuscript-model.js';
import { createWorkingCopyClient } from './working-copy-client.js';

// Apply errors after which the server guarantees that this operation wrote nothing: refused before the batch
// (re-read, revision, plan, chapter checks, another run active) or an atomic batch rejected by Google.
// Everything else — including a lost reply — leaves the sent new chapters quarantined as unknown.
const NOTHING_WRITTEN = new Set(['revision_conflict', 'review_changed', 'operation_rejected', 'operation_active', 'google_api_error', 'google_no_access']);
const nothingWritten = error => NOTHING_WRITTEN.has(error?.code) || (typeof error?.code === 'string' && error.code.startsWith('chapter_'));

const RAIL_PREF = 'talewisp.chapters.railOpen';
const DRAWER_BELOW = 760;

export function createChapterWorkspace({ document, window, storage, api, notify, ask, elements, onActiveChange, onSelection, onTextChange, showEditor, openSettings }) {
  const { toggle, rail, body: editorBody, scroll, documentEditor, pane, kindLabel, crumbTitle, historyButton, readonlyBadge } = elements;
  const guard = createScopeGuard();
  // `reading` covers chapter reads only; `writing` covers review/apply. A read never shows write progress.
  const s = { bookId: null, info: null, manuscript: null, tocState: 'idle', tocError: '', tocCode: '', checked: new Set(), loaded: [], activeKey: null, active: false, pending: [], reading: false, writing: false, railOpen: readPref(), drawerOpen: false, drawer: false };
  // Every route change in the app and every exit from chapter mode bumps `view`; a late response may still
  // fill the list of loaded chapters, but it never navigates the author back into the editor.
  let view = 0, opening = false;
  // Reads are sequenced per resource (the newest table-of-contents read and the newest read of each chapter
  // win) and stamped with the write epoch: a read started before or during a write to Google may hold the
  // pre-write text, so it is never applied once that write has returned.
  // `liveOperation` is the Apply this tab is waiting for; any other quarantined new chapter has an unknown result.
  let tocSeq = 0, claimSeq = 0, writeEpoch = 0, writeBusy = false, liveOperation = null;
  const sectionClaims = new Map();
  s.agentKeys = new Set();
  const fileScopes = new Set();
  const fileChapters = new Map();
  const working = createWorkingCopyClient({ api, onStatus: (scope, status) => {
    if (scope.bookId === s.bookId && scope.documentId === documentId()) {
      if (status.status === 'error') notify('Рабочий файл не сохранён: ' + status.error + ' Ваш текст остаётся в браузере.', true);
      renderSaveBar();
    }
  } });
  const fileScope = () => ({ bookId: s.bookId, documentId: documentId() });
  const claimSections = ids => { const claim = ++claimSeq; for (const id of ids) sectionClaims.set(id, claim); return claim; };
  const ownsSection = (id, claim) => sectionClaims.get(id) === claim;
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const button = (value, cls, fn) => { const n = node('button', cls, value); n.type = 'button'; if (fn) n.addEventListener('click', fn); return n; };
  const uid = () => (window.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, '');
  const documentId = () => s.info?.binding?.documentId ?? null;
  const current = () => s.loaded.find(item => item.key === s.activeKey) ?? null;
  function readPref() { try { return storage?.getItem(RAIL_PREF) !== '0'; } catch { return true; } }

  // ---------- Editor surface (same typography classes as local drafts) ----------
  const editor = node('div', 'document-editor chapter-editor'); editor.id = 'chapter-editor';
  const strip = node('nav', 'chapter-strip'); strip.setAttribute('aria-label', 'Загруженные главы');
  const prev = button('‹', 'tool-button tool-icon chapter-step', () => step(-1)); prev.setAttribute('aria-label', 'Предыдущая загруженная глава');
  const switcher = node('select', 'chapter-switch'); switcher.setAttribute('aria-label', 'Перейти к загруженной главе');
  const next = button('›', 'tool-button tool-icon chapter-step', () => step(1)); next.setAttribute('aria-label', 'Следующая загруженная глава');
  const closeChapter = button('Убрать из редактора', 'text-action chapter-unload', () => unload(s.activeKey));
  strip.append(prev, switcher, next, closeChapter);
  const titleInput = node('input', 'document-title'); titleInput.id = 'chapter-title'; titleInput.maxLength = 300; titleInput.setAttribute('aria-label', 'Заголовок главы');
  const meta = node('div', 'document-meta chapter-meta');
  const notice = node('div', 'chapter-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
  const textarea = node('textarea', 'writing-surface'); textarea.id = 'chapter-text'; textarea.setAttribute('aria-label', 'Текст главы'); textarea.placeholder = 'Текст главы…';
  editor.append(strip, titleInput, meta, notice, textarea);
  documentEditor.after(editor);
  const backdrop = node('div', 'chapter-rail-backdrop'); backdrop.addEventListener('click', () => closeDrawer());
  editorBody.append(backdrop);

  switcher.addEventListener('change', () => open(switcher.value));
  titleInput.addEventListener('input', () => { const item = current(); if (!item || titleInput.readOnly) return; item.title = titleInput.value; edited(); });
  textarea.addEventListener('input', () => { const item = current(); if (!item) return; item.body = textarea.value; edited(); });
  for (const type of ['select', 'keyup', 'mouseup', 'focus']) textarea.addEventListener(type, () => onSelection());
  toggle.addEventListener('click', () => (s.drawer ? (s.drawerOpen ? closeDrawer() : openDrawer()) : setRailOpen(!s.railOpen)));
  rail.addEventListener('keydown', event => { if (event.key === 'Escape' && s.drawer && s.drawerOpen) { event.stopPropagation(); closeDrawer(); } });

  function edited() { persist(); renderMeta(); renderSwitcher(); renderSaveBar(); renderToc(false); onTextChange(); }

  // ---------- Local persistence (never lost on chapter/book/route switch or reload) ----------
  // The in-memory copy is written first and always wins on restore, so switching books never drops drafts,
  // even when browser storage is missing or full. Scopes whose dirty drafts exist only in memory are tracked
  // in `unsafe`: the page then refuses to unload silently and offers a download of the unsaved text.
  const memory = new Map(), unsafe = new Set();
  let saveTimer = null;
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 250); }
  function persistNow(doc = documentId()) {
    clearTimeout(saveTimer); saveTimer = null;
    if (!s.bookId || !doc) return true;
    return store(storageKeyOf(s.bookId, doc), serializeState(s), s.loaded.some(isDirty));
  }
  // The single save path for any manuscript's drafts, open or not.
  function store(key, value, dirty) {
    const wasUnsafe = unsafe.has(key);
    memory.set(key, value);
    if (fileScopes.has(key)) {
      const parsed = parseState(value);
      // Binding identity is encoded in the scope map, never parsed from a delimiter.
      const scope = scopeByStorageKey.get(key);
      if (parsed && scope) {
        const saved = fileChapters.get(key) ?? new Map();
        for (const item of parsed.loaded) saved.set(item.key, item);
        fileChapters.set(key, saved);
        working.queue(scope, parsed.loaded);
      }
    }
    try {
      if (!storage) throw new Error('storage unavailable');
      storage.setItem(key, value);
      unsafe.delete(key);
    } catch {
      if (dirty) unsafe.add(key); else unsafe.delete(key);
      if (unsafe.has(key) && !wasUnsafe) notify('Браузер не сохраняет правки глав (хранилище отключено или переполнено). Текст держится только в этой вкладке: не закрывайте её, пока не запишете правки в Google или не скачаете копию.', true);
    }
    if (wasUnsafe !== unsafe.has(key)) renderSaveBar();
    return !unsafe.has(key);
  }
  function restore() {
    const doc = documentId(), key = doc ? storageKeyOf(s.bookId, doc) : null; let parsed = null;
    try { parsed = key ? parseState(memory.has(key) ? memory.get(key) : storage?.getItem(key)) : null; } catch { parsed = null; }
    s.loaded = parsed?.loaded ?? []; s.activeKey = parsed?.activeKey ?? null; s.checked = new Set(parsed?.checked ?? []);
    s.agentKeys = new Set(parsed?.agentKeys ?? []);
    if (!current()) s.activeKey = s.loaded[0]?.key ?? null;
  }
  const scopeByStorageKey = new Map();
  function registerFile(scope) {
    const key = storageKeyOf(scope.bookId, scope.documentId);
    fileScopes.add(key); scopeByStorageKey.set(key, scope);
    return key;
  }
  async function loadWorking({ refresh = false } = {}) {
    const scope = fileScope(), token = guard.begin();
    if (!scope.documentId || !s.info?.workingCopySupported) return;
    registerFile(scope);
    if (refresh && s.loaded.some(isDirty) && await ask('Загрузить рабочий файл?', 'Текст загруженных глав будет заменён версиями из рабочего файла. Сначала сохраните нужные браузерные правки отдельной копией.', 'Загрузить') !== 'confirm') return;
    try {
      let copy = await working.read(scope);
      if (!guard.isCurrent(token)) return;
      if (!copy) copy = await working.importDocument(scope);
      if (!guard.isCurrent(token)) return;
      const key = storageKeyOf(scope.bookId, scope.documentId);
      fileScopes.add(key); scopeByStorageKey.set(key, scope);
      if (copy) {
        s.manuscript = copy.manuscript; s.pending = copy.manuscript.pendingOperations ?? []; s.tocState = 'ready';
        // A browser recovery draft wins over file text, including after a failed save.
        fileChapters.set(key, new Map(copy.chapters.map(x => [x.key, x])));
        let collision = false;
        const browser = new Map((refresh ? [] : s.loaded).filter(isDirty).map(x => [x.key, x]));
        s.loaded = copy.chapters.map(x => {
          const local = browser.get(x.key); browser.delete(x.key);
          if (local && (isDirty(x) || local.baseHash !== x.baseHash) && (local.title !== x.title || local.body !== x.body)) collision = true;
          return local ?? x;
        });
        s.loaded.push(...browser.values());
        if (collision) working.conflict(scope, 'В рабочем файле и браузере есть разные незаписанные правки. Скачайте браузерную копию перед загрузкой рабочего файла.');
        if (!current()) s.activeKey = s.loaded[0]?.key ?? null;
        persistNow(); renderAll();
      }
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
  }
  async function importWorking() {
    if (s.writing || s.reading) { notify('Дождитесь окончания чтения или записи глав.', true); return; }
    const scope = fileScope(), token = guard.begin();
    registerFile(scope);
    if (!working.state(scope).ready) {
      await loadWorking();
      if (guard.isCurrent(token) && working.state(scope).ready) notify('Рабочий файл книги сохранён. Выберите одну или несколько глав.');
      return;
    }
    try {
      persistNow(); await working.flush(scope);
      const sent = new Map(s.loaded.map(x => [x.key, { title: x.title, body: x.body }]));
      const copy = await working.importDocument(scope);
      if (!guard.isCurrent(token)) return;
      s.manuscript = copy.manuscript; s.pending = copy.manuscript.pendingOperations ?? []; s.tocState = 'ready';
      const byKey = new Map(s.loaded.map(x => [x.key, x]));
      fileChapters.set(storageKeyOf(scope.bookId, scope.documentId), new Map(copy.chapters.map(x => [x.key, x])));
      // All chapters live in the file; loading into the editor remains an independent choice.
      s.loaded = copy.chapters.filter(x => byKey.has(x.key)).map(x => mergeWorkingChapter(byKey.get(x.key), x, sent.get(x.key)));
      persistNow(); renderAll();
      notify('Рабочий файл книги сохранён. Выберите одну или несколько глав.');
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
  }
  function exportWorking() {
    persistNow();
    const all = new Map(fileChapters.get(storageKeyOf(s.bookId, documentId())) ?? []);
    for (const item of s.loaded) all.set(item.key, item);
    const parts = [...all.values()].map(item => `${item.hasHeading ? '# ' + item.title + '\n\n' : ''}${item.body}`);
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(new window.Blob([parts.join('\n\n')], { type: 'text/markdown;charset=utf-8' }));
    link.download = 'talewisp-книга.md'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => window.URL.revokeObjectURL(link.href), 1000);
  }
  async function recoverWorking() {
    if (s.writing || s.reading) { notify('Дождитесь окончания чтения или записи глав.', true); return; }
    const scope = fileScope(), token = guard.begin();
    persistNow();
    try {
      const result = await working.recover(scope, () => {
        if (!guard.isCurrent(token)) throw new Error('Книга сменилась. Восстановление отменено.');
        return s.loaded;
      }, async (copy, chapters) => guard.isCurrent(token) && await recoveryDialog(copy, chapters) && guard.isCurrent(token));
      if (!result || !guard.isCurrent(token)) return;
      fileChapters.set(storageKeyOf(scope.bookId, scope.documentId), new Map(result.chapters.map(x => [x.key, x])));
      persistNow(); await working.flush(scope); renderAll();
      notify('Браузерная версия сохранена в рабочем файле. Текст редактора сохранён; запись в Google снова доступна.');
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
  }
  function recoveryDialog(copy, chapters) {
    return new Promise(resolve => {
      const dialog = node('dialog', 'chapter-review-dialog'); dialog.setAttribute('aria-labelledby', 'working-recovery-title');
      const form = node('form', 'chapter-review'); form.method = 'dialog';
      const heading = node('h2', '', 'Сохранить браузерную версию в рабочий файл'); heading.id = 'working-recovery-title';
      const head = node('header', 'chapter-review-head');
      head.append(heading, node('p', '', `Текущая версия рабочего файла: ${copy.version}. Ниже показаны точные изменения. Будут сохранены перечисленные браузерные версии; Google этой операцией не изменяется. Если файл изменится после чтения, сохранение будет отклонено.`));
      const list = node('div', 'chapter-review-list'), before = new Map(copy.chapters.map(x => [x.key, x]));
      for (const item of chapters) {
        const old = before.get(item.key);
        const a = old ? `${old.hasHeading ? old.title + '\n\n' : ''}${old.body}` : '';
        const b = `${item.hasHeading ? item.title + '\n\n' : ''}${item.body}`;
        if (a === b) continue;
        const block = node('section', 'chapter-review-change'); block.append(node('h3', '', item.title || item.label || 'Глава'));
        const rows = node('ol', 'chapter-review-rows'); rows.append(reviewRow({ change: 'modified', before: a, after: b })); block.append(rows); list.append(block);
      }
      if (!list.children.length) list.append(node('p', '', 'Текст уже совпадает с рабочим файлом. Подтверждение восстановит сохранение после сверки текущей версии.'));
      const label = node('label', 'chapter-review-confirm'), check = node('input'); check.type = 'checkbox';
      label.append(check, node('span', '', 'Я проверил(а) изменения и выбираю показанные браузерные версии для рабочего файла.'));
      const actions = node('div', 'dialog-actions'), cancel = node('button', 'button button-quiet', 'Отмена'), apply = node('button', 'button button-primary', 'Сохранить браузерную версию');
      cancel.value = 'cancel'; apply.value = 'apply'; apply.disabled = true;
      check.addEventListener('change', () => { apply.disabled = !check.checked; }); actions.append(cancel, apply);
      form.append(head, list, label, actions); dialog.append(form);
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'apply' && check.checked); dialog.remove(); }, { once: true });
      document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  function exportUnsaved() {
    persistNow();
    const parts = [];
    for (const key of unsafe) {
      for (const item of parseState(memory.get(key))?.loaded.filter(isDirty) ?? []) {
        parts.push(`=== ${item.kind === 'new' ? `Новая глава (${item.where === 'after' ? 'после' : 'перед'} «${item.anchorLabel ?? ''}»)` : sectionTitle(item)} ===\n${item.hasHeading ? item.title + '\n\n' : ''}${item.body}\n`);
      }
    }
    if (!parts.length) { notify('Незаписанных правок нет.'); return; }
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(new window.Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' }));
    link.download = 'talewisp-незаписанные-главы.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => window.URL.revokeObjectURL(link.href), 1000);
  }
  window.addEventListener('pagehide', () => persistNow());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistNow(); });

  // ---------- Rail: docked column in a wide editor, drawer in a narrow one ----------
  function updateRailMode() {
    const drawer = pane.getBoundingClientRect().width < DRAWER_BELOW;
    if (drawer !== s.drawer) { s.drawer = drawer; s.drawerOpen = false; }
    renderRailVisibility();
  }
  function renderRailVisibility() {
    const visible = s.drawer ? s.drawerOpen : s.railOpen;
    rail.hidden = !visible;
    editorBody.classList.toggle('rail-drawer', s.drawer);
    editorBody.classList.toggle('drawer-open', s.drawer && s.drawerOpen);
    toggle.setAttribute('aria-expanded', String(visible));
  }
  function setRailOpen(open) { s.railOpen = open; try { storage?.setItem(RAIL_PREF, open ? '1' : '0'); } catch { /* optional */ } renderRailVisibility(); if (open) ensureToc(); }
  function openDrawer() { s.drawerOpen = true; renderRailVisibility(); ensureToc(); (rail.querySelector('button, select, input') ?? rail).focus({ preventScroll: true }); }
  function closeDrawer() { if (!s.drawerOpen) return; s.drawerOpen = false; renderRailVisibility(); toggle.focus({ preventScroll: true }); }
  rail.tabIndex = -1;
  if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(updateRailMode).observe(pane);
  window.addEventListener('resize', updateRailMode);

  // ---------- Book and manuscript binding ----------
  async function syncBook(bookId) {
    if (bookId !== s.bookId) {
      persistNow(); // the in-memory copy keeps this book's drafts even if browser storage fails
      deactivate();
      Object.assign(s, { bookId, info: null, manuscript: null, tocState: 'idle', tocError: '', tocCode: '', checked: new Set(), loaded: [], activeKey: null, pending: [], reading: false });
      guard.enter(scopeKeyOf(bookId, ''));
      renderAll();
    }
    await refreshBinding();
  }
  // An in-flight binding read is shared only within the same book scope; a newer book or a forced
  // refresh (after the author changes the manuscript) starts its own read and the old one is ignored.
  let bindingRequest = null;
  async function refreshBinding({ force = false } = {}) {
    if (!s.bookId) { renderAll(); return; }
    if (!force && bindingRequest && bindingRequest.bookId === s.bookId && guard.isCurrent(bindingRequest.token)) return bindingRequest.promise;
    const request = { bookId: s.bookId, token: guard.begin() };
    const live = () => bindingRequest === request && guard.isCurrent(request.token) && s.bookId === request.bookId;
    bindingRequest = request;
    request.promise = (async () => {
      try {
        const info = await api('/api/manuscript');
        if (!live() || info.bookId !== request.bookId) return;
        const before = documentId();
        s.info = info;
        if (documentId() !== before) {
          persistBeforeSwitch(before);
          guard.enter(scopeKeyOf(s.bookId, documentId()));
          s.manuscript = null; s.tocState = 'idle'; s.pending = []; s.reading = false;
          restore();
          if (documentId()) {
            await loadWorking();
            if (bindingRequest !== request || s.bookId !== request.bookId) return;
            if (!s.manuscript && (s.railOpen || s.loaded.length)) loadToc();
          }
        }
        renderAll();
      } catch (error) { if (live()) { s.info = { error: error.message, candidates: [] }; renderAll(); } }
      finally { if (bindingRequest === request) bindingRequest = null; }
    })();
    return request.promise;
  }
  // The binding of the current book changed under loaded chapters: keep the previous manuscript's drafts.
  function persistBeforeSwitch(previousDocumentId) {
    if (previousDocumentId && s.loaded.length) persistNow(previousDocumentId);
  }
  async function bind(attachmentId) {
    const binding = s.info?.binding;
    if (binding && binding.attachmentId !== attachmentId) {
      const copy = s.loaded.some(isDirty)
        ? 'Правки глав прежней рукописи, ещё не записанные в Google, останутся в этом браузере и вернутся, если снова выбрать прежний файл. Сами документы Google не изменяются.'
        : 'Главы будут читаться из выбранного файла. Документы Google и связанные файлы книги не изменяются.';
      if (await ask('Сменить основную рукопись?', copy, 'Сменить') !== 'confirm') { renderPicker(); return; }
    }
    persistNow();
    const token = guard.begin();
    try {
      await api('/api/manuscript/bind', { method: 'POST', body: { bookId: s.bookId, attachmentId } });
      if (!guard.isCurrent(token)) return;
      deactivate();
      await refreshBinding({ force: true }); // a read started before the POST must not decide the new binding
      notify('Основная рукопись книги выбрана.');
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
  }

  // ---------- Table of contents and loading ----------
  function ensureToc() { if (documentId() && s.tocState === 'idle') loadToc(); }
  // Resolves to true only when this read was applied.
  async function loadToc() {
    const doc = documentId(); if (!doc) return false;
    const token = guard.begin(), seq = ++tocSeq, epoch = writeEpoch;
    s.tocState = 'loading'; s.tocError = ''; renderToc();
    const overtaken = () => { s.tocState = s.manuscript ? 'ready' : 'idle'; renderAll(); return false; };
    try {
      const result = await api('/api/manuscript/read', { method: 'POST', body: { bookId: s.bookId } });
      if (!guard.isCurrent(token) || result.binding?.documentId !== doc || seq !== tocSeq) return false;
      if (epoch !== writeEpoch) return overtaken();
      s.manuscript = result.manuscript; s.pending = result.manuscript.pendingOperations ?? []; s.tocState = 'ready';
      const byId = new Map(s.manuscript.sections.map(section => [section.sectionId, section]));
      s.checked = new Set([...s.checked].filter(id => byId.has(id)));
      for (const item of s.loaded) if (item.kind === 'section') { const section = byId.get(item.sectionId); item.missing = !section; item.stale = !!section && section.hash !== item.baseHash; }
      sortLoaded(); renderAll();
      return true;
    } catch (error) {
      if (!guard.isCurrent(token) || seq !== tocSeq) return false;
      if (epoch !== writeEpoch) return overtaken();
      s.tocState = 'error'; s.tocError = error.message; s.tocCode = error.code || ''; renderToc();
      return false;
    }
  }
  // Author-initiated reads wait for a running write; its settlement re-reads the written chapters itself.
  function requestSections(ids, options) {
    if (s.writing) { notify('Дождитесь окончания записи в Google — затем главы можно загрузить.', true); return; }
    return loadSections(ids, options);
  }
  let readSeq = 0;
  async function loadSections(ids, { openFirst = true } = {}) {
    if (!ids.length) { notify('Отметьте одну или несколько глав.', true); return; }
    const token = guard.begin(), startedView = view, seq = ++readSeq, epoch = writeEpoch, claim = claimSections(ids);
    s.reading = true; renderTocActions();
    try {
      const cached = s.info?.workingCopySupported && working.state(fileScope()).ready ? fileChapters.get(storageKeyOf(s.bookId, documentId())) : null;
      const result = cached ? { working: true, sections: ids.map(id => cached.get(id)).filter(Boolean), missing: ids.filter(id => !cached.has(id)) }
        : await api('/api/manuscript/sections', { method: 'POST', body: { bookId: s.bookId, sectionIds: ids } });
      if (!guard.isCurrent(token)) return;
      if (epoch !== writeEpoch) { notify('Чтение глав пересеклось с записью в Google и не применено, чтобы не вернуть прежний текст. Загрузите главы ещё раз.', true); return; }
      // The author left the chapter editor (or returned to it) meanwhile: keep the text, do not navigate.
      const left = view !== startedView;
      let conflicts = 0, firstKey = null;
      for (const section of result.sections) {
        if (!ownsSection(section.sectionId, claim)) continue; // a newer read of this chapter already answered or is pending
        const fresh = result.working ? structuredClone(section) : loadedFromSection(section, result.revisionId);
        const index = s.loaded.findIndex(item => item.kind === 'section' && item.sectionId === section.sectionId);
        if (index < 0) {
          const saved = fileChapters.get(storageKeyOf(s.bookId, documentId()))?.get(fresh.key);
          const merged = mergeLoaded(saved, fresh); if (merged.conflict) conflicts++;
          s.loaded.push(merged);
        }
        else { const merged = mergeLoaded(s.loaded[index], fresh); if (merged.conflict) conflicts++; s.loaded[index] = merged; }
        firstKey ??= fresh.key;
      }
      sortLoaded();
      if (result.missing?.length) notify('Часть отмеченных глав больше не найдена в документе. Обновите оглавление.', true);
      if (conflicts) notify('В Google изменились главы, в которых есть ваши незаписанные правки. Ваш текст сохранён — откройте главу, чтобы решить, как продолжить.', true);
      s.checked.clear(); persist();
      if (openFirst && !left && firstKey) open(firstKey);
      else {
        renderAll();
        if (openFirst && left && firstKey) notify('Главы загружены. Они ждут в списке «Загружены в редактор» — откройте нужную, когда вернётесь к тексту.');
      }
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
    finally {
      if (seq === readSeq) s.reading = false;
      if (guard.isCurrent(token)) { renderTocActions(); renderSaveBar(); renderMeta(); }
    }
  }
  function sortLoaded() {
    const order = new Map((s.manuscript?.sections ?? []).map(section => [section.sectionId, section.order]));
    const rank = item => item.kind === 'new' ? (order.get(item.anchorSectionId) ?? 1e9) + (item.where === 'after' ? 0.5 : -0.5) : order.get(item.sectionId) ?? 1e9;
    s.loaded = s.loaded.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i).map(x => x.item);
    const keys = new Set(s.loaded.map(x => x.key));
    s.agentKeys = new Set([...s.agentKeys].filter(key => keys.has(key)));
  }

  // ---------- Opening, switching and unloading chapters ----------
  function open(key) {
    if (!s.loaded.some(item => item.key === key)) return;
    s.activeKey = key; persist();
    activate();
    if (s.drawer) closeDrawer();
    textarea.focus({ preventScroll: true });
  }
  function step(delta) {
    const index = s.loaded.findIndex(item => item.key === s.activeKey), target = s.loaded[index + delta];
    if (target) open(target.key);
  }
  async function unload(key) {
    const item = s.loaded.find(x => x.key === key); if (!item) return;
    if (isDirty(item) && await ask('Убрать главу из редактора?', `В «${item.kind === 'new' ? item.title || 'новой главе' : sectionTitle(item)}» есть правки, не записанные в Google. Они будут удалены из браузера.`, 'Убрать') !== 'confirm') return;
    const index = s.loaded.indexOf(item);
    s.loaded.splice(index, 1);
    s.agentKeys.delete(key); onSelection();
    if (s.activeKey === key) s.activeKey = (s.loaded[index] ?? s.loaded[index - 1])?.key ?? null;
    persistNow();
    if (!s.activeKey) deactivate(); else renderAll();
  }
  function activate() {
    if (!s.active) {
      s.active = true; scroll.dataset.chapterMode = 'on';
      opening = true;
      try { showEditor(); } finally { opening = false; } // the app's own route change for this open is not a leave
    }
    renderAll(); onActiveChange(true);
  }
  // Leaving chapter mode always cancels pending navigation, even when no chapter was open yet.
  function deactivate() {
    view++;
    if (!s.active) return;
    persistNow(); s.active = false; delete scroll.dataset.chapterMode; renderAll(); onActiveChange(false);
  }
  function noteRoute() { if (!opening) view++; }

  // ---------- New chapters ----------
  function createNewChapter(form) {
    const title = form.title.value.trim(), anchor = s.manuscript?.sections.find(section => section.sectionId === form.anchor.value);
    if (!title) { notify('Введите заголовок новой главы.', true); form.title.focus(); return; }
    if (!anchor) { notify('Выберите место вставки из оглавления.', true); return; }
    const item = newChapterItem({ key: uid(), title, anchorSectionId: anchor.sectionId, where: form.where.value === 'before' ? 'before' : 'after', anchorLabel: sectionTitle(anchor), tabTitle: anchor.tabTitle, tabId: anchor.tabId });
    s.loaded.push(item); sortLoaded(); form.reset(); open(item.key);
  }

  // ---------- Review and explicit write-back ----------
  function renderWriting() { renderSaveBar(); renderMeta(); renderTocActions(); }
  // The author may keep typing while the review and the write are pending. The write sends one captured
  // payload; its settlement compares against that snapshot, so later typing is never discarded and a
  // written new chapter is never sent again — even when the author switched book or manuscript meanwhile.
  async function reviewAndWrite() {
    const doc = documentId(); if (!doc || writeBusy || s.writing) return;
    const payload = buildWritePayload(s.loaded);
    if (s.loaded.some(item => item.kind === 'new' && !isQuarantined(item) && !item.title.trim())) { notify('У новой главы нет заголовка.', true); return; }
    if (!payload.edits.length && !payload.newChapters.length) {
      notify(s.loaded.some(isQuarantined)
        ? 'Нет правок, которые нужно записать в Google. Новые главы с неизвестным результатом записи повторно не отправляются — проверьте оригинал и свяжите их с главой из оглавления.'
        : 'Нет правок, которые нужно записать в Google.');
      return;
    }
    persistNow();
    const snapshot = writeSnapshot(s.loaded), scope = { bookId: s.bookId, documentId: doc }, before = s.manuscript?.sections ?? [];
    const token = guard.begin();
    writeBusy = true;
    try {
      s.writing = true; renderWriting();
      if (s.info?.workingCopySupported && working.state(scope).ready) await working.flush(scope);
      let staged;
      try { staged = await api('/api/manuscript/stage', { method: 'POST', body: { bookId: scope.bookId, documentId: doc, ...payload } }); }
      catch (error) { if (guard.isCurrent(token)) await handleWriteError(error); return; }
      finally { s.writing = false; if (guard.isCurrent(token)) renderWriting(); }
      if (!guard.isCurrent(token)) return;
      if (!await reviewDialog(staged.review) || !guard.isCurrent(token)) return;
      const operationId = uid();
      // Before anything can be written, the new chapters of this attempt are quarantined and that state is
      // saved durably. Whatever happens next (lost reply, reload, scope switch), they are never inserted again.
      if (payload.newChapters.length) {
        const marked = quarantineNew(s.loaded, payload.newChapters, { operationId, scope });
        if (marked.missing.length) { notify('Новая глава была убрана из редактора во время проверки. Запись отменена, в Google ничего не записано.', true); return; }
        s.loaded = marked.items;
        if (!persistNow()) {
          s.loaded = markAttempt(s.loaded, operationId, 'release');
          persistNow(); renderAll();
          notify('Новые главы не отправлены: браузер не может надёжно сохранить отметку о записи (хранилище отключено или переполнено), а без неё после сбоя связи глава могла бы добавиться дважды. В Google ничего не записано. Освободите место в браузере или запишите сначала правки без новых глав.', true);
          return;
        }
        if (s.info?.workingCopySupported && working.state(scope).ready) {
          try { await working.flush(scope); }
          catch (error) {
            s.loaded = markAttempt(s.loaded, operationId, 'release');
            persistNow(); renderAll();
            notify('В Google ничего не отправлено: рабочий файл не удалось сохранить. Отметка попытки снята. Восстановите сохранение рабочего файла и повторите запись. ' + error.message, true);
            return;
          }
        }
      }
      liveOperation = operationId;
      s.writing = true;
      if (payload.newChapters.length) renderAll(); else renderWriting();
      let response;
      writeEpoch++; // reads started before this point may hold the pre-write text
      try { response = await api('/api/manuscript/apply', { method: 'POST', body: { bookId: scope.bookId, documentId: doc, revisionId: staged.review.revisionId, planHash: staged.review.planHash, operationId, ...payload, confirmed: true } }); }
      catch (error) {
        writeEpoch++; liveOperation = null;
        const released = nothingWritten(error);
        // Bound to the attempt and its own book/manuscript, even if the author has left it meanwhile.
        if (payload.newChapters.length) updateScope(scope, items => markAttempt(items, operationId, released ? 'release' : 'unknown'));
        if (guard.isCurrent(token)) {
          if (payload.newChapters.length && !released) notify('Новые главы этой записи отмечены «результат записи неизвестен» и повторно не отправляются. Откройте оригинал: если глава там есть, свяжите черновик с ней.', true);
          await handleWriteError(error);
        }
        return;
      }
      writeEpoch++; liveOperation = null; // reads started while the write was in flight are ambiguous too
      if (inScope(scope)) await settle(scope, response.result, snapshot, before);
      else settleLocal(scope, response.result, snapshot);
      retireSettled(scope, response.result);
      if (s.info?.workingCopySupported && inScope(scope)) {
        try {
          await working.flush(scope);
          const copy = await working.importDocument(scope);
          if (inScope(scope)) { fileChapters.set(storageKeyOf(scope.bookId, scope.documentId), new Map(copy.chapters.map(x => [x.key, x]))); s.manuscript = copy.manuscript; renderAll(); }
        } catch (error) { notify('Google обновлён, но обновить рабочий файл не удалось: ' + error.message, true); }
      }
      notify(response.result.newChapters?.length ? 'Изменения записаны в Google и проверены чтением. Новые главы появились в оглавлении.' : 'Изменения записаны в Google и проверены чтением.');
    } catch (error) {
      if (guard.isCurrent(token)) notify(error.message, true);
    } finally {
      writeBusy = false; s.writing = false; liveOperation = null; renderWriting();
    }
  }
  const inScope = scope => s.bookId === scope.bookId && documentId() === scope.documentId;
  function retireSettled(scope, result) {
    const key = storageKeyOf(scope.bookId, scope.documentId), saved = fileChapters.get(key);
    const live = inScope(scope) ? s.loaded : (parseState(memory.get(key))?.loaded ?? []);
    const keys = new Set(live.map(x => x.key)), written = new Set(result.newChapters ?? []), retired = [];
    for (const item of saved?.values() ?? []) if (item.kind === 'new' && written.has(item.newKey) && item.write?.operationId === result.operationId && !keys.has(item.key)) retired.push({ key: item.key, operationId: result.operationId });
    for (const item of retired) saved.delete(item.key);
    working.retire(scope, retired);
  }
  // Applies `fn` to the drafts of one manuscript: the live list when it is open, otherwise its stored copy.
  function updateScope(scope, fn) {
    if (inScope(scope)) { s.loaded = fn(s.loaded); persistNow(); renderAll(); return; }
    const key = storageKeyOf(scope.bookId, scope.documentId);
    let parsed = null;
    try { parsed = parseState(memory.has(key) ? memory.get(key) : storage?.getItem(key)); } catch { parsed = null; }
    if (!parsed) return;
    const loaded = fn(parsed.loaded);
    store(key, serializeState({ loaded, activeKey: parsed.activeKey, checked: parsed.checked }), loaded.some(isDirty));
  }
  // Written chapters → their sections in the re-read table of contents. Plain-text chapter IDs follow
  // document indexes, so a match needs the same tab, detection and the title that was sent. A new chapter is
  // tied to its created section only when exactly one section with its title appeared and none existed before.
  function mapWritten(result, snapshot, before) {
    const mapping = new Map(), sections = s.manuscript.sections;
    for (const item of s.loaded) {
      if (item.kind !== 'section') continue;
      const title = snapshot.get(item.key)?.title ?? item.baseTitle;
      const candidates = sections.filter(section => !mapping.has(section.sectionId) && section.tabId === item.tabId && section.detection === item.detection && (item.hasHeading ? section.title === title : section.label === item.label));
      const match = candidates.find(section => section.sectionId === item.sectionId) ?? (candidates.length === 1 ? candidates[0] : null);
      if (match) mapping.set(match.sectionId, { sectionId: item.sectionId });
    }
    const written = new Set(result?.newChapters ?? []);
    for (const item of s.loaded) {
      if ((item.kind !== 'new' && item.kind !== 'written') || !written.has(item.newKey) || !snapshot.has(item.key)) continue;
      const title = snapshot.get(item.key).title.trim();
      const named = list => list.filter(section => section.hasHeading && section.title.trim() === title && (!item.tabId || section.tabId === item.tabId));
      const appeared = named(sections).filter(section => !mapping.has(section.sectionId));
      if (!named(before).length && appeared.length === 1) mapping.set(appeared[0].sectionId, { newKey: item.newKey });
    }
    return mapping;
  }
  // A lost re-read (the author left, and maybe came back: A → B → A) is never used. The write is settled at
  // once from its snapshot; if the written manuscript is open again, one fresh re-read ties the written
  // chapters to Google, otherwise they stay as safe `written`/stale items.
  async function settle(scope, result, snapshot, before, retry = true) {
    const token = guard.begin(), lost = () => !guard.isCurrent(token);
    const fallback = () => {
      settleLocal(scope, result, snapshot);
      if (!inScope(scope)) return;
      if (retry) return settle(scope, result, snapshot, before, false);
      notify('Запись подтверждена, но перечитать главы из Google не удалось. Ваш текст сохранён в браузере; записанные главы отмечены — загрузите их заново перед следующей записью.', true);
    };
    let refreshed = await loadToc();
    if (lost()) return fallback();
    const freshByOld = new Map(), created = new Map();
    if (refreshed) {
      const mapping = mapWritten(result, snapshot, before);
      if (mapping.size) {
        const ids = [...mapping.keys()], claim = claimSections(ids), epoch = writeEpoch;
        try {
          const fresh = await api('/api/manuscript/sections', { method: 'POST', body: { bookId: scope.bookId, sectionIds: ids } });
          if (lost()) return fallback();
          if (epoch !== writeEpoch) refreshed = false;
          else for (const section of fresh.sections) {
            if (!ownsSection(section.sectionId, claim)) continue;
            const target = mapping.get(section.sectionId), loaded = loadedFromSection(section, fresh.revisionId);
            if (target.newKey) created.set(target.newKey, loaded); else freshByOld.set(target.sectionId, loaded);
          }
        } catch {
          if (lost()) return fallback();
          refreshed = false;
        }
      }
    }
    // Settle the live list as it is now, including everything typed while the write was pending. A new
    // chapter already settled as `written` by a lost re-read is tied to its created chapter here as well.
    const active = current(), previousKey = s.activeKey;
    s.loaded = settleAfterWrite(s.loaded, freshByOld, result, snapshot, created)
      .map(item => (item.kind === 'written' && snapshot.has(item.key) && created.has(item.newKey) ? adoptCreated(created.get(item.newKey), item) : item));
    const moved = active?.kind === 'section' ? freshByOld.get(active.sectionId)?.key : active?.kind === 'new' || active?.kind === 'written' ? created.get(active.newKey)?.key : null;
    s.activeKey = moved ?? (current() ? s.activeKey : s.loaded[0]?.key ?? null);
    sortLoaded(); persistNow();
    if (!refreshed) notify('Запись подтверждена, но перечитать главы из Google не удалось. Ваш текст сохранён в браузере; записанные главы отмечены — загрузите их заново перед следующей записью.', true);
    if (s.loaded.some(item => item.kind === 'written' && snapshot.has(item.key))) notify('Новая глава записана в Google, а правки, сделанные после отправки, сохранены отдельно. Повторно глава не добавляется — свяжите её с записанной главой в оглавлении.', true);
    settledView(previousKey);
  }
  // Settles a verified write without a re-read. The result belongs strictly to the book/document it was sent
  // to: when that manuscript is open now, its live list is authoritative (it holds everything typed since,
  // also after leaving and returning); otherwise its stored copy, memory first. Choosing and saving the state
  // happen synchronously. Repeating it is harmless: written items stay written, removed ones stay removed.
  function settleLocal(scope, result, snapshot) {
    if (inScope(scope)) {
      const previousKey = s.activeKey;
      s.loaded = settleAfterWrite(s.loaded, new Map(), result, snapshot);
      if (!current()) s.activeKey = s.loaded[0]?.key ?? null;
      sortLoaded(); persistNow();
      settledView(previousKey);
      return;
    }
    const key = storageKeyOf(scope.bookId, scope.documentId);
    let parsed = null;
    try { parsed = parseState(memory.has(key) ? memory.get(key) : storage?.getItem(key)); } catch { parsed = null; }
    if (!parsed) return;
    const loaded = settleAfterWrite(parsed.loaded, new Map(), result, snapshot);
    store(key, serializeState({ loaded, activeKey: loaded.some(item => item.key === parsed.activeKey) ? parsed.activeKey : loaded[0]?.key ?? null, checked: parsed.checked }), loaded.some(isDirty));
  }
  // Never opens the editor or changes the route; the agent learns when the open chapter is a different one.
  function settledView(previousKey) {
    if (!s.activeKey) { deactivate(); return; }
    renderAll();
    if (s.active && s.activeKey !== previousKey) onActiveChange(true);
  }
  // Ties a `written` new chapter — or, on the author's explicit choice, a new chapter whose write result is
  // unknown — to an existing chapter in Google, keeping the author's latest text as a dirty edit of that chapter.
  const linkable = item => item.kind === 'written' || (isQuarantined(item) && item.write.operationId !== liveOperation);
  async function linkWritten(key, sectionId) {
    if (!sectionId) return;
    if (s.writing) { notify('Дождитесь окончания записи в Google.', true); return; }
    if (s.loaded.some(item => item.kind === 'section' && item.sectionId === sectionId)) { notify('Эта глава уже загружена в редактор. Перенесите текст в неё вручную.', true); return; }
    const token = guard.begin(), epoch = writeEpoch, claim = claimSections([sectionId]);
    try {
      const result = await api('/api/manuscript/sections', { method: 'POST', body: { bookId: s.bookId, sectionIds: [sectionId] } });
      if (!guard.isCurrent(token)) return;
      if (epoch !== writeEpoch || !ownsSection(sectionId, claim)) { notify('Документ менялся во время чтения. Повторите.', true); return; }
      const section = result.sections.find(item => item.sectionId === sectionId), index = s.loaded.findIndex(item => item.key === key && linkable(item));
      if (!section?.hasHeading || index < 0) { notify('Эта глава не найдена в документе. Обновите оглавление и выберите главу заново.', true); return; }
      if (s.loaded.some(item => item.kind === 'section' && item.sectionId === sectionId)) { notify('Эта глава уже загружена в редактор. Перенесите текст в неё вручную.', true); return; }
      const adopted = adoptCreated(loadedFromSection(section, result.revisionId), s.loaded[index]);
      s.loaded[index] = adopted;
      if (s.activeKey === key) s.activeKey = adopted.key;
      sortLoaded(); persistNow(); renderAll();
    } catch (error) { if (guard.isCurrent(token)) notify(error.message, true); }
  }
  async function handleWriteError(error) {
    notify(error.message, true);
    if (error.code === 'chapter_section_changed' && error.sectionId) {
      const item = s.loaded.find(x => x.kind === 'section' && x.sectionId === error.sectionId);
      if (item) { item.stale = true; await loadSections([error.sectionId], { openFirst: false }); }
      return;
    }
    if (['revision_conflict', 'review_changed', 'outcome_unknown', 'operation_pending', 'chapter_anchor_missing', 'chapter_title_exists'].includes(error.code)) await loadToc();
  }
  async function reconcile(operation) {
    if (await ask('Подтвердить ручную проверку?', 'Подтверждайте только после того, как открыли оригинал в Google и убедились, в каком состоянии документ. Операция не будет повторена; после подтверждения запись снова станет доступна.', 'Я проверил(а) документ') !== 'confirm') return;
    try {
      await api('/api/google/reconcile', { method: 'POST', body: { documentId: documentId(), operationId: operation.operationId, authorReviewed: true } });
      notify('Проверка подтверждена. Обновите главы перед новой записью.');
      await loadToc();
    } catch (error) { notify(error.message, true); }
  }

  function reviewDialog(review) {
    return new Promise(resolve => {
      const dialog = node('dialog', 'chapter-review-dialog'); dialog.setAttribute('aria-labelledby', 'chapter-review-title');
      const form = node('form', 'chapter-review'); form.method = 'dialog';
      const head = node('header', 'chapter-review-head');
      const heading = node('h2', '', 'Проверка перед записью в Google'); heading.id = 'chapter-review-title';
      head.append(heading, node('p', '', `Документ «${review.documentTitle}», ревизия ${String(review.revisionId).slice(0, 12)}…. Будет отправлен один атомарный запрос (${review.requestCount} операций) с защитой ревизии: если документ изменится, ничего не запишется. Неизменённые абзацы, другие главы и вкладки, таблицы, изображения и комментарии не затрагиваются.`));
      const list = node('div', 'chapter-review-list');
      for (const warning of review.warnings ?? []) list.append(node('p', 'chapter-review-warning', warning));
      for (const change of review.changes) {
        const block = node('section', 'chapter-review-change');
        block.append(node('h3', '', change.kind === 'new' ? `Новая глава «${change.title}»` : `«${change.title}»`));
        block.append(node('p', 'chapter-review-where', change.kind === 'new'
          ? `${change.where === 'after' ? 'После' : 'Перед'} «${change.anchorLabel}» · вкладка «${change.tabTitle}» · стиль заголовка: ${styleName(change.headingStyle)}`
          : `Вкладка «${change.tabTitle}»`));
        const rows = node('ol', 'chapter-review-rows');
        for (const paragraph of change.paragraphs) rows.append(reviewRow(paragraph));
        if (!change.paragraphs.length && change.kind === 'new') rows.append(node('li', 'chapter-review-row', 'Только заголовок, без текста.'));
        block.append(rows); list.append(block);
      }
      const confirmLabel = node('label', 'chapter-review-confirm'), check = node('input'); check.type = 'checkbox';
      confirmLabel.append(check, node('span', '', 'Я проверил(а) эти точные изменения и хочу записать их в Google-документ.'));
      const actions = node('div', 'dialog-actions'), cancel = node('button', 'button button-quiet', 'Отмена'), apply = node('button', 'button button-primary', 'Записать в Google');
      cancel.value = 'cancel'; apply.value = 'apply'; apply.disabled = true;
      check.addEventListener('change', () => { apply.disabled = !check.checked; });
      actions.append(cancel, apply);
      form.append(head, list, confirmLabel, actions); dialog.append(form);
      dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'apply' && check.checked); dialog.remove(); }, { once: true });
      document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  function reviewRow(paragraph) {
    const row = node('li', 'chapter-review-row change-' + paragraph.change);
    const label = { modified: 'Изменён абзац', deleted: 'Удалён абзац', emptied: 'Абзац очищен', inserted: 'Новый абзац', title: 'Изменён заголовок' }[paragraph.change] ?? paragraph.change;
    row.append(node('span', 'chapter-review-kind', label));
    if (paragraph.change === 'modified' || paragraph.change === 'title') {
      const { pre, suf } = commonEnds(paragraph.before, paragraph.after);
      row.append(marked('del', paragraph.before, pre, suf), marked('ins', paragraph.after, pre, suf));
    } else if (paragraph.before !== undefined) row.append(node('del', '', paragraph.before || '(пустой абзац)'));
    else row.append(node('ins', '', paragraph.after || '(пустой абзац)'));
    return row;
  }
  function marked(tag, text, pre, suf) {
    const el = node(tag);
    el.append(document.createTextNode(text.slice(0, pre)), node('mark', '', text.slice(pre, text.length - suf) || '∅'), document.createTextNode(text.slice(text.length - suf)));
    return el;
  }
  function commonEnds(a, b) {
    let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    return { pre, suf };
  }
  const styleName = value => /^HEADING_(\d)$/.test(value ?? '') ? `Заголовок ${value.slice(-1)}` : value === 'NORMAL_TEXT' ? 'обычный текст' : value || 'как у соседних глав';

  // ---------- Rendering ----------
  function renderAll() { renderRailVisibility(); renderRail(); renderEditor(); refreshChrome(); }
  const railParts = {};
  function renderRail() {
    rail.replaceChildren();
    const head = node('header', 'chapter-rail-head');
    head.append(node('h2', '', 'Главы рукописи'));
    const closeRail = button('×', 'icon-button chapter-rail-close', () => (s.drawer ? closeDrawer() : setRailOpen(false))); closeRail.setAttribute('aria-label', 'Скрыть главы');
    head.append(closeRail);
    railParts.picker = node('section', 'manuscript-picker'); railParts.pending = node('section', 'chapter-pending');
    railParts.tocActions = node('div', 'chapter-toc-actions'); railParts.toc = node('section', 'chapter-toc'); railParts.loaded = node('section', 'chapter-loaded');
    railParts.create = node('section', 'chapter-create'); railParts.save = node('section', 'chapter-save');
    rail.append(head, railParts.picker, railParts.pending, railParts.save, railParts.tocActions, railParts.toc, railParts.loaded, railParts.create);
    renderPicker(); renderPending(); renderSaveBar(); renderTocActions(); renderToc(); renderLoaded(); renderCreate();
  }
  function renderPicker() {
    const box = railParts.picker; if (!box) return; box.replaceChildren();
    if (!s.bookId) { box.append(node('p', 'subtle-empty', 'Выберите книгу в верхней ленте — главы читаются из основной рукописи книги.')); return; }
    if (s.info?.error) { box.append(node('p', 'chapter-error', s.info.error), button('Повторить', 'button button-quiet', () => refreshBinding())); return; }
    if (!s.info) { box.append(node('p', 'subtle-empty', 'Проверяю связанные файлы книги…')); return; }
    const candidates = s.info.candidates ?? [], binding = s.info.binding;
    if (binding) {
      const line = node('p', 'manuscript-current');
      line.append(node('span', 'manuscript-label', 'Основная рукопись'), node('strong', '', binding.name));
      const link = node('a', 'text-action', 'Открыть оригинал'); link.href = googleDocUrl(binding.documentId); link.target = '_blank'; link.rel = 'noopener noreferrer';
      line.append(link); box.append(line);
    } else {
      box.append(node('p', 'manuscript-invite', s.info.staleBinding
        ? 'Прежний основной файл больше не связан с книгой. Выберите основную рукопись заново.'
        : 'Выберите Google-документ, который считается рукописью этой книги. Главы будут читаться из него; остальные связанные файлы останутся сопутствующими.'));
    }
    if (!candidates.length) { box.append(node('p', 'subtle-empty', 'У книги нет связанных Google-документов. Прикрепите файл в «Настройки → Настройки проекта».')); return; }
    if (binding && candidates.length === 1) return;
    const row = node('div', 'manuscript-choose'), select = node('select'); select.setAttribute('aria-label', 'Основная рукопись книги');
    if (!binding) select.append(new Option('— выберите файл —', ''));
    for (const item of candidates) select.append(new Option(item.name, item.attachmentId, false, item.attachmentId === binding?.attachmentId));
    const choose = button(binding ? 'Сменить' : 'Сделать основной', 'button button-quiet', () => { if (select.value) bind(select.value); });
    const sync = () => { choose.disabled = !select.value || select.value === binding?.attachmentId; };
    select.addEventListener('change', sync); sync();
    row.append(select, choose); box.append(row);
  }
  function renderPending() {
    const box = railParts.pending; if (!box) return; box.replaceChildren(); box.hidden = !s.pending.length;
    for (const operation of s.pending) {
      const card = node('div', 'chapter-alert');
      card.append(node('strong', '', operation.active ? 'Запись в Google выполняется' : 'Результат прошлой записи неизвестен'));
      card.append(node('p', '', operation.active ? 'Дождитесь окончания.' : 'Новые записи в этот документ заблокированы, повтор не выполняется. Откройте оригинал, проверьте текст, затем подтвердите проверку.'));
      const actions = node('div', 'chapter-alert-actions');
      const link = node('a', 'text-action', 'Открыть оригинал'); link.href = googleDocUrl(documentId()); link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
      if (!operation.active) actions.append(button('Я проверил(а) документ', 'button button-quiet', () => reconcile(operation)));
      card.append(actions); box.append(card);
    }
  }
  function renderSaveBar() {
    const box = railParts.save; if (!box) return; box.replaceChildren();
    const dirty = documentId() ? s.loaded.filter(isDirty).length : 0; box.hidden = !dirty && !unsafe.size && !s.info?.workingCopySupported;
    if (s.info?.workingCopySupported && documentId()) {
      const state = working.state(fileScope());
      box.append(node('p', 'chapter-note', state.status === 'error' ? 'Рабочий файл не сохранён: ' + state.error : state.status === 'saving' ? 'Сохраняю рабочий файл…' : state.ready ? `Рабочий файл книги · версия ${state.version}` : 'Рабочий файл ещё не создан.'));
      box.append(button('Импортировать / обновить рабочий файл', 'button button-quiet', importWorking));
      if (state.ready) box.append(button('Загрузить рабочий файл', 'text-action', () => loadWorking({ refresh: true })));
      if (state.ready) box.append(button('Скачать рабочий текст', 'text-action', exportWorking));
      if (state.status === 'error') box.append(button('Сохранить браузерную версию в рабочий файл…', 'button button-primary', recoverWorking));
    }
    if (unsafe.size) {
      const alert = node('div', 'chapter-alert');
      alert.append(node('p', '', 'Браузер не сохраняет правки глав: незаписанный текст есть только в этой вкладке. Не закрывайте и не перезагружайте её, пока не запишете правки в Google или не скачаете копию.'));
      alert.append(button('Скачать незаписанные правки', 'button button-quiet', exportUnsaved));
      box.append(alert);
    }
    if (!dirty) return;
    box.append(node('p', '', `${dirty} ${dirty === 1 ? 'глава с правками' : 'глав с правками'} — ${unsafe.size ? 'держатся в этой вкладке' : 'сохранены в браузере'}, в Google ещё не записаны.`));
    const write = button(s.writing ? 'Готовлю проверку…' : 'Проверить и записать в Google…', 'button button-primary', reviewAndWrite);
    write.disabled = s.writing || s.pending.length > 0; box.append(write);
  }
  function renderTocActions() {
    const box = railParts.tocActions; if (!box) return; box.replaceChildren();
    box.hidden = !documentId();
    if (!documentId()) return;
    const refresh = button(s.tocState === 'loading' ? 'Читаю…' : 'Обновить оглавление', 'button button-quiet', () => { if (!s.writing) { if (s.info?.workingCopySupported) importWorking(); else loadToc(); } }); refresh.disabled = s.tocState === 'loading' || s.writing;
    const count = s.checked.size;
    const load = button(s.reading ? 'Загружаю…' : `Загрузить выбранные${count ? ` (${count})` : ''}`, 'button button-primary', () => requestSections([...s.checked]));
    load.disabled = !count || s.reading || s.writing;
    box.append(refresh, load);
    if (s.manuscript?.sections.length) {
      const all = s.checked.size === s.manuscript.sections.length;
      box.append(button(all ? 'Снять выбор' : 'Выбрать все', 'text-action', () => { s.checked = all ? new Set() : new Set(s.manuscript.sections.map(x => x.sectionId)); persist(); renderToc(); renderTocActions(); }));
    }
  }
  function renderToc(full = true) {
    const box = railParts.toc; if (!box) return;
    if (!full && s.tocState === 'ready') { for (const marker of box.querySelectorAll('[data-dirty-for]')) { const item = s.loaded.find(x => x.sectionId === marker.dataset.dirtyFor); marker.hidden = !isDirty(item); } return; }
    box.replaceChildren(); box.hidden = !documentId();
    if (!documentId()) return;
    if (s.tocState === 'loading' && !s.manuscript) { box.append(node('p', 'subtle-empty', 'Читаю структуру документа в Google…')); return; }
    if (s.tocState === 'error') {
      box.append(node('p', 'chapter-error', s.tocError));
      if (['google_not_connected', 'google_not_configured', 'google_scope_required'].includes(s.tocCode) && openSettings) box.append(button('Открыть подключение Google', 'button button-quiet', () => openSettings()));
      return;
    }
    if (!s.manuscript) { box.append(button('Прочитать оглавление', 'button button-quiet', () => loadToc())); return; }
    if (!s.manuscript.sections.length) { box.append(node('p', 'subtle-empty', 'В документе нет текста.')); return; }
    if (!s.manuscript.headingsFound) box.append(node('p', 'chapter-note', 'В документе нет стилей заголовков Google. Главы показаны по строкам «Глава…», «Пролог», «Эпилог» или как весь текст вкладки.'));
    const loadedIds = new Set(s.loaded.filter(x => x.kind === 'section').map(x => x.sectionId));
    for (const tab of s.manuscript.tabs) {
      const sections = s.manuscript.sections.filter(section => section.tabId === tab.tabId);
      if (!sections.length && s.manuscript.tabs.length > 1) continue;
      const group = node('div', 'toc-tab'); group.style.setProperty('--tab-depth', String(tab.depth));
      if (s.manuscript.tabs.length > 1) group.append(node('h3', 'toc-tab-title', tab.path.join(' › ')));
      const list = node('ul', 'toc-list');
      for (const section of sections) {
        const li = node('li', 'toc-item'); li.style.setProperty('--level', String(Math.max(0, section.level - 1)));
        const id = 'toc-' + section.order, check = node('input'); check.type = 'checkbox'; check.id = id; check.checked = s.checked.has(section.sectionId);
        check.addEventListener('change', () => { if (check.checked) s.checked.add(section.sectionId); else s.checked.delete(section.sectionId); persist(); renderTocActions(); });
        const label = node('label', 'toc-label'); label.htmlFor = id;
        const metaText = [detectionLabel(section), wordsLabel(section.wordCount), section.lockedCount ? 'есть защищённые фрагменты' : ''].filter(Boolean).join(' · ');
        label.append(node('span', 'toc-title', sectionTitle(section)), node('span', 'toc-meta', metaText));
        li.append(check, label);
        if (loadedIds.has(section.sectionId)) {
          const dirtyMark = node('span', 'toc-dirty', '●'); dirtyMark.dataset.dirtyFor = section.sectionId; dirtyMark.title = 'Есть правки, не записанные в Google'; dirtyMark.hidden = !isDirty(s.loaded.find(x => x.sectionId === section.sectionId));
          li.append(dirtyMark, button('Открыть', 'text-action toc-open', () => open(section.sectionId)));
        }
        list.append(li);
      }
      group.append(list); box.append(group);
    }
  }
  function renderLoaded() {
    const box = railParts.loaded; if (!box) return; box.replaceChildren(); box.hidden = !s.loaded.length;
    if (!s.loaded.length) return;
    box.append(node('h3', '', 'Загружены в редактор'));
    box.append(node('p', 'chapter-note', 'Для агента: без отметок — активная глава; с отметками — выбранные главы вместе.'));
    const list = node('ul', 'loaded-list');
    for (const item of s.loaded) {
      const li = node('li', 'loaded-item' + (item.key === s.activeKey && s.active ? ' is-active' : ''));
      const go = button((isDirty(item) ? '● ' : '') + itemLabel(item), 'loaded-open', () => open(item.key));
      if (item.key === s.activeKey && s.active) go.setAttribute('aria-current', 'true');
      const agentCheck = node('input'); agentCheck.type = 'checkbox'; agentCheck.checked = s.agentKeys.has(item.key);
      agentCheck.setAttribute('aria-label', 'Передать агенту: ' + itemLabel(item));
      agentCheck.addEventListener('change', () => { if (agentCheck.checked) s.agentKeys.add(item.key); else s.agentKeys.delete(item.key); persist(); onSelection(); });
      li.append(agentCheck, go);
      if (item.conflict || item.stale) li.append(node('span', 'loaded-flag', 'изменена в Google'));
      if (item.missing) li.append(node('span', 'loaded-flag', 'не найдена в документе'));
      list.append(li);
    }
    box.append(list);
  }
  function renderCreate() {
    const box = railParts.create; if (!box) return; box.replaceChildren(); box.hidden = !s.manuscript?.sections.length;
    if (box.hidden) return;
    const details = node('details', 'chapter-create-box'); details.append(node('summary', '', 'Новая глава'));
    const form = node('form', 'chapter-create-form');
    const title = node('input'); title.name = 'title'; title.maxLength = 300; title.placeholder = 'Заголовок новой главы'; title.setAttribute('aria-label', 'Заголовок новой главы');
    const where = node('select'); where.name = 'where'; where.setAttribute('aria-label', 'Положение новой главы'); where.append(new Option('после', 'after'), new Option('перед', 'before'));
    const anchor = node('select'); anchor.name = 'anchor'; anchor.setAttribute('aria-label', 'Глава-ориентир');
    const current = s.loaded.find(x => x.key === s.activeKey && x.kind === 'section');
    for (const section of s.manuscript.sections) anchor.append(new Option(`${s.manuscript.tabs.length > 1 ? section.tabTitle + ' › ' : ''}${sectionTitle(section)}`, section.sectionId, false, section.sectionId === (current?.sectionId ?? s.manuscript.sections.at(-1).sectionId)));
    const place = node('div', 'chapter-create-place'); place.append(where, anchor);
    const submit = node('button', 'button button-quiet', 'Создать и открыть'); submit.type = 'submit';
    form.append(title, place, node('p', 'chapter-note', 'Глава появится в Google только после проверки и подтверждения записи.'), submit);
    form.addEventListener('submit', event => { event.preventDefault(); createNewChapter(form); });
    details.append(form); box.append(details);
  }
  function itemLabel(item) {
    if (isQuarantined(item)) return `${item.write.operationId === liveOperation ? 'Записывается' : 'Результат неизвестен'}: ${item.title || 'без заголовка'}`;
    if (item.kind === 'new') return `Новая: ${item.title || 'без заголовка'}`;
    if (item.kind === 'written') return `Записана: ${item.title || 'без заголовка'}`;
    return sectionTitle(item);
  }
  function renderSwitcher() {
    switcher.replaceChildren();
    for (const item of s.loaded) switcher.append(new Option((isDirty(item) ? '● ' : '') + itemLabel(item), item.key, false, item.key === s.activeKey));
    const index = s.loaded.findIndex(item => item.key === s.activeKey);
    prev.disabled = index <= 0; next.disabled = index < 0 || index >= s.loaded.length - 1;
  }
  function renderEditor() {
    const item = current();
    renderSwitcher();
    if (!item) { titleInput.value = ''; textarea.value = ''; titleInput.readOnly = true; textarea.readOnly = true; meta.replaceChildren(); notice.hidden = true; return; }
    if (titleInput.value !== (item.hasHeading ? item.title : item.label)) titleInput.value = item.hasHeading ? item.title : item.label;
    titleInput.readOnly = !item.hasHeading || !!item.titleLocked;
    textarea.readOnly = false;
    if (textarea.value !== item.body) textarea.value = item.body;
    renderMeta(); renderNotice(item);
  }
  function renderMeta() {
    const item = current(); meta.replaceChildren(); if (!item) return;
    const dot = () => { const n = node('span', 'meta-separator', '✦'); n.setAttribute('aria-hidden', 'true'); return n; };
    meta.append(node('span', '', s.info?.binding?.name ? `«${s.info.binding.name}»` : 'Рукопись Google'));
    if (item.tabTitle) meta.append(dot(), node('span', '', `вкладка «${item.tabTitle}»`));
    meta.append(dot(), node('span', '', item.kind === 'new' ? `новая глава ${item.where === 'after' ? 'после' : 'перед'} «${item.anchorLabel}»` : detectionLabel(item)));
    meta.append(dot(), node('span', 'chapter-state' + (isDirty(item) ? ' is-dirty' : ''), isQuarantined(item) ? (item.write.operationId === liveOperation ? 'Отправлена в Google, ждём ответа' : 'Результат записи в Google неизвестен — повторно не отправляется; текст сохранён в браузере') : isDirty(item) ? 'Правки сохранены в браузере, в Google не записаны' : 'Совпадает с загруженной версией Google'));
    if (documentId() && item.kind === 'section') { const link = node('a', 'text-action', 'Открыть в Google'); link.href = googleDocUrl(documentId(), { tabId: item.tabId, headingId: item.headingId }); link.target = '_blank'; link.rel = 'noopener noreferrer'; meta.append(dot(), link); }
    if (isDirty(item) && documentId()) { const write = button('Проверить и записать…', 'text-action', reviewAndWrite); write.disabled = s.writing || s.pending.length > 0; meta.append(dot(), write); }
  }
  function renderNotice(item) {
    notice.replaceChildren(); const parts = [];
    if (item.conflict && item.remote) {
      const p = node('p', 'chapter-alert');
      p.append(node('span', '', 'Эта глава изменилась в Google после загрузки. Ваш текст сохранён. Чтобы записать его, сравните с актуальной версией: проверка покажет, что именно заменится. '));
      p.append(button('Сравнивать с актуальной версией Google', 'button button-quiet', () => { const i = s.loaded.indexOf(item); s.loaded[i] = rebaseOnRemote(item); persistNow(); renderAll(); }));
      parts.push(p);
    } else if (item.stale) {
      const p = node('p', 'chapter-alert'); p.append(node('span', '', 'Оглавление показывает, что глава изменилась в Google. '), button('Загрузить актуальную версию', 'button button-quiet', () => requestSections([item.sectionId], { openFirst: false })));
      parts.push(p);
    }
    if (item.kind === 'written') {
      const box = node('div', 'chapter-alert');
      box.append(node('p', '', 'Эта новая глава уже записана в Google. Правки, сделанные после отправки, сохранены здесь и в Google ещё не записаны. Повторно глава не добавляется: выберите записанную главу, чтобы продолжить как её правку.'));
      const sections = (s.manuscript?.sections ?? []).filter(section => section.hasHeading && (!item.tabId || section.tabId === item.tabId));
      const named = sections.filter(section => section.title.trim() === item.baseTitle.trim());
      if (sections.length) {
        const select = node('select', 'chapter-link-select'); select.setAttribute('aria-label', 'Записанная глава в Google');
        for (const section of named.length ? named : sections) select.append(new Option(sectionTitle(section), section.sectionId));
        select.value = (named.length === 1 ? named[0] : (named.length ? named : sections)[0]).sectionId;
        box.append(select, button('Связать с этой главой', 'button button-quiet', () => linkWritten(item.key, select.value)));
      } else box.append(button('Прочитать оглавление', 'button button-quiet', () => loadToc()));
      parts.push(box);
    }
    if (isQuarantined(item)) {
      const box = node('div', 'chapter-alert');
      if (item.write.operationId === liveOperation) box.append(node('p', '', 'Эта новая глава отправлена в Google, ждём ответа. Пока результат не известен, она повторно не отправляется; правки здесь сохраняются.'));
      else {
        box.append(node('p', '', `Результат записи этой новой главы в Google неизвестен${item.write.sent?.title ? ` (отправлена как «${item.write.sent.title}»)` : ''}. Она могла быть записана, поэтому повторно не отправляется — даже если в оглавлении её не видно. Откройте оригинал и проверьте документ. Если глава там есть, свяжите этот черновик с ней: ваш текст станет правкой этой главы. Если главы нет, создайте новую главу и перенесите в неё текст.`));
        const link = node('a', 'text-action', 'Открыть оригинал'); link.href = googleDocUrl(documentId()); link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link);
        const sections = (s.manuscript?.sections ?? []).filter(section => section.hasHeading && (!item.tabId || section.tabId === item.tabId));
        const sentTitle = (item.write.sent?.title ?? item.title).trim(), named = sections.filter(section => section.title.trim() === sentTitle);
        if (sections.length) {
          const select = node('select', 'chapter-link-select'); select.setAttribute('aria-label', 'Глава в Google для этого черновика');
          for (const section of named.length ? named : sections) select.append(new Option(sectionTitle(section), section.sectionId));
          select.value = (named.length ? named : sections)[0].sectionId;
          box.append(select, button('Связать с этой главой', 'button button-quiet', () => linkWritten(item.key, select.value)));
        }
        box.append(button(s.manuscript ? 'Перечитать оглавление' : 'Прочитать оглавление', 'button button-quiet', () => { if (!s.writing) loadToc(); }));
      }
      parts.push(box);
    }
    if (item.missing) parts.push(node('p', 'chapter-alert', 'Глава больше не найдена в документе по прежнему месту. Ваш текст сохранён в браузере; скопируйте его или добавьте как новую главу.'));
    if (item.locked?.length) parts.push(node('p', 'chapter-note', `Защищённые фрагменты (${item.locked.length}): ${item.locked.slice(0, 3).map(x => x.reason).join('; ')}${item.locked.length > 3 ? '…' : ''}. Их нельзя менять здесь — запись такой правки будет остановлена; измените их в оригинале.`));
    if (item.titleLocked) parts.push(node('p', 'chapter-note', `Заголовок защищён: ${item.titleLocked}.`));
    notice.append(...parts); notice.hidden = !parts.length;
  }
  function refreshChrome() {
    toggle.hidden = !s.bookId;
    if (!s.active) return;
    const item = current();
    kindLabel.textContent = item?.kind === 'new' ? 'Новая глава рукописи' : 'Глава рукописи Google';
    crumbTitle.textContent = item ? (item.kind === 'new' ? item.title || 'Новая глава' : sectionTitle(item)) : 'Главы рукописи';
    readonlyBadge.classList.add('hidden'); historyButton.disabled = true;
  }

  updateRailMode();
  renderAll();

  return {
    async flushWorking() { persistNow(); if (s.info?.workingCopySupported && documentId()) await working.flush(fileScope()); },
    syncBook,
    deactivate,
    noteRoute,
    refreshChrome,
    // True while some book's unsaved chapter text exists only in this tab (browser storage failed).
    hasUnsafeDrafts: () => { persistNow(); return unsafe.size > 0; },
    active: () => s.active && !!current(),
    selectedText: () => (s.active ? textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) : ''),
    currentText: () => { const item = current(); return item ? `${item.hasHeading ? item.title : ''}\n${item.body}` : ''; },
    hasUnsaved: () => s.loaded.some(isDirty),
    agentContext() {
      const item = current(); if (!s.active || !item || !documentId()) return null;
      return { bookId: s.bookId, documentId: documentId(), sectionId: item.sectionId || item.key, revisionId: item.baseRevision || '', tabTitle: item.tabTitle || '', title: (item.kind === 'new' || item.hasHeading ? item.title : item.label).slice(0, 400), text: item.body, edited: isDirty(item) };
    },
    agentContexts() {
      if (!s.active || !documentId()) return [];
      const chosen = s.agentKeys.size ? s.loaded.filter(x => s.agentKeys.has(x.key)) : [current()].filter(Boolean);
      return chosen.map(item => ({ bookId: s.bookId, documentId: documentId(), sectionId: item.sectionId || item.key, revisionId: item.baseRevision || '', tabTitle: item.tabTitle || '', title: (item.kind === 'new' || item.hasHeading ? item.title : item.label).slice(0, 400), text: item.body, edited: isDirty(item) }));
    },
    contextLabel: () => { const selected = s.loaded.filter(x => s.agentKeys.has(x.key)); if (selected.length) return `Главы для агента · ${selected.length}`; const item = current(); return item ? 'Глава · ' + (item.kind === 'new' ? item.title : sectionTitle(item)).slice(0, 40) : ''; },
    appendText(value) {
      const item = current(); if (!item) return false;
      item.body += (item.body && !item.body.endsWith('\n') ? '\n' : '') + value;
      renderEditor(); edited(); return true;
    },
  };
}
