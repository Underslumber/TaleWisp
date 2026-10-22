import { createConceptMatcher, withConceptMentions, resolveConceptReference } from './concept-links.js';
import { createSaveQueue } from './save-queue.js';
import { createOpenController } from './open-controller.js';
import { readNavigation, writeNavigation } from './navigation-state.js';
import { createPanelLifecycle } from './panel-lifecycle.js';
import { ensureEditableDocument } from './editor-draft.js';
import { renderSafeMarkdown } from './markdown.js';
import { friendlyRecordType, friendlyStatus } from './workspace-labels.js';
import { createKnowledgeMap } from './knowledge-map.js';
import { GOOGLE_AGENT_API_PREFIX, googleAgentStatusText } from './google-agent-status.js';
import { buildWorkspaceSelectionRequest, normalizeTargetWords, PRIMARY_VIEWS, queuedActionApprovalLabel, queuedActionPreview, unwrapProposalResponse } from './workspace-adapters.js';
import { availabilityLabel, buildAgentMessagePayload, buildWorkflowViewModel, delegationStatusLabel, scenarioCanRun } from './agent-workflows.js';
import { createImportWorkspace } from './import-workspace.js';
import { renderStoryArtRequests } from './host-workspace.js';
import { createGoogleNativeEditor } from './google-native-editor.js';
import { createDeck } from './deck.js';
import { attachmentKindLabel, createProjectSettings, friendlyProjectError, projectRequest } from './project-settings.js';
import { createAgentPanel } from './agent-panel.js';
import { createWorkspaceSplitter } from './workspace-splitter.js';
import { createChapterWorkspace } from './chapter-workspace.js';
import { createStoryArtWorkspace } from './storyart-workspace.js';
import { classifyAgentMessage } from './chat-message.js';
class DraftMap extends Map {
  set(key, value) {
    if (String(key).startsWith('document:')) {
      const targetWords = normalizeTargetWords(value?.targetWords);
      value = { ...value, targetWords, savedTargetWords: normalizeTargetWords(value?.savedTargetWords ?? targetWords) };
    }
    return super.set(key, value);
  }
}
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = { docs: [], notes: [], current: null, view: 'documents', mainRoute: 'documents', googleViewSurface: 'main', drafts: new DraftMap(), selectedText: '', sources: new Set(), agent: null, agentWorkflowMode: '', messages: [], storyArtRequests: [], storyArtLoading: false, storyArtError: '', googleDoc: null, googleTab: null, googleAttempts: new Map(), googleUncertain: new Map(), googlePickerQuery: '', googlePickerFiles: [], googlePickerNextPageToken: '', history: [], selectedHistory: null, focus: false, sidebarOpen: false, activeTool: 'agent', catalog: null, overview: null, proposalIds: [], scope: 'active' };
  const editor = $('#document-editor'), title = $('#document-title'), text = $('#document-text'), special = $('#special-view'), chat = $('#chat-messages');
  let navigationReady = false, navigationRevision = 0, authMode = 'local';
  // Top card rail. Browsing stays local; the final choice goes through selectWorkspace().
  const deck = createDeck({
    document, window,
    elements: { root: $('#deck'), body: $('#deck-body'), trail: $('#deck-trail'), rail: $('#deck-rail'), anchorSlot: $('#deck-anchor'), status: $('#deck-status'), prev: $('#deck-prev'), next: $('#deck-next'), toggle: $('#deck-toggle'), toggleLabel: $('#deck-toggle-label'), path: $('#book-path'), foot: $('#deck-foot') },
    onCommit: ids => commitWorkspaceSelection(ids),
    onOpenImports: () => showToolPanel('imports'),
    onRetryCatalog: () => loadCatalog(),
    onOpenUnassigned: () => openUnassignedKnowledge()
  });
  function rememberNavigation() {
    if (!navigationReady) return;
    try { writeNavigation(window.localStorage, { ...state, googleNativeOpen: !!state.googleNativeOpen, editor: special.classList.contains('hidden'), googleDocumentId: state.googleDoc?.documentId, googleTabId: state.googleTab?.tabId }); } catch { /* Storage may be disabled. */ }
  }
  state.knowledgeScope = 'active';
  let knowledgeGraph = null;
  let knowledgeMap = null, knowledgeViewRevision = 0, knowledgeCardRequest = 0, knowledgeWorkspaceChanging = false;
  let saveQueue, stream = null, portal = null, returnFocus = null, editorBusyState = null, ignoreWorkspaceClose = false, pendingWorkspaceCloseGeneration = null, agentLoginUrl = '', agentLoginCode = '', googleLoginUrl = '', googleAgentLoginUrl = '';
  const openController = createOpenController(setEditorBusy);
  const panelLifecycle = createPanelLifecycle(), mainGoogleLifecycle = createPanelLifecycle(), toolGoogleLifecycle = createPanelLifecycle();
  [$('#agent-pane'), $('#context-pane'), special].forEach(panel => panelLifecycle.rememberHome(panel));
  // Function declarations below are hoisted; callbacks only run after user actions.
  const agentPanel = createAgentPanel({ document, window, root: $('#agent-pane'), onOpenContext: () => showToolPanel('context'), onDrawerOpen: name => { if (name === 'storyart') refreshStoryArtRequests(); if (name === 'tasks') loadMovedDelegations(); } });
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  function svgIcon(name, cls = 'icon') { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '/assets/icons/lucide-sprite.svg#' + name); svg.append(use); return svg; }
  const hasDesktopInspector = () => window.matchMedia('(min-width: 1024px)').matches;
  const btn = (value, cls, fn) => { const n = node('button', cls, value); n.type = 'button'; if (fn) n.addEventListener('click', fn); return n; };
  const id = () => crypto.randomUUID ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const safe = x => typeof x === 'string' ? x : '';
  function notify(message, error = false) { const n = node('div', 'toast' + (error ? ' error' : ''), message); $('#toast-region').append(n); setTimeout(() => n.remove(), 4500); }
  function setSave(kind, message) {
    const dirty = [...state.drafts.values()].some(item => item.dirty);
    if (kind === 'saved' && dirty) {
      const failed = [...state.drafts.values()].some(item => item.dirty && item.saveError);
      kind = failed ? 'error' : 'saving'; message = failed ? 'Не удалось сохранить · изменения сохранены локально' : 'Есть несохранённые изменения';
    }
    else if (kind === 'saved' && saveQueue?.hasPending()) { kind = 'saving'; message = 'Сохранение…'; }
    const e = $('#save-indicator'); e.classList.toggle('saving', kind === 'saving'); e.classList.toggle('error', kind === 'error'); $('span', e).textContent = message;
  }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {}); if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    let response; try { response = await fetch(path, { ...options, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body) }); } catch { throw Error('Нет связи с сервером TaleWisp. Проверьте, что сервер запущен.'); }
    const json = (response.headers.get('content-type') || '').includes('application/json'), data = json ? await response.json().catch(() => ({})) : await response.text().catch(() => '');
    if (!response.ok) { const e = Error(safe(data.error) || 'Ошибка сервера ' + response.status); e.status = response.status; e.code = safe(data.code); if (safe(data.sectionId)) e.sectionId = data.sectionId; throw e; } return data;
  }
  const localStore = (() => { try { return window.localStorage; } catch { return null; } })();
  // Main StoryArt section. The module keeps its drafts, uploads and selections per selected book.
  const storyArtScope = () => { const active = state.catalog?.active; return active ? [active.authorId || '', active.seriesId || '', active.bookId || ''].join('/') : ''; };
  const storyArt = createStoryArtWorkspace({
    document, window, root: document.createElement('div'), api, notify, ask, getScope: storyArtScope,
    renderMarkdown: (container, value) => renderSafeMarkdown(container, value),
    isActive: () => state.view === 'storyart' && !special.classList.contains('hidden'),
    onRouteChange: route => { state.storyArt = route; rememberNavigation(); }
  });
  // Google manuscript chapters live in the editor pane; the desktop inspector is resizable next to it.
  const chapters = createChapterWorkspace({
    document, window, storage: localStore, api, notify, ask,
    elements: { toggle: $('#chapter-toggle'), rail: $('#chapter-rail'), body: $('#editor-body'), scroll: $('#editor-scroll'), documentEditor: editor, pane: $('#editor-pane'), kindLabel: $('#editor-kind-label'), crumbTitle: $('#crumb-title'), historyButton: $('#history-button'), readonlyBadge: $('#readonly-badge') },
    onActiveChange: active => { state.chapterMode = active; if (active) { wordCount(); selection(); } else renderCurrent(); },
    onSelection: () => selection(),
    onTextChange: () => { wordCount(); selection(); },
    showEditor: showChapterEditor,
    openSettings: () => showToolPanel('settings')
  });
  const splitter = createWorkspaceSplitter({
    window, document, grid: $('.workspace-grid'), handle: $('#workspace-splitter'), storage: localStore,
    isActive: () => hasDesktopInspector() && !state.focus && getComputedStyle($('#desktop-inspector')).display !== 'none'
  });
  function showChapterEditor() {
    stash(); openController.invalidate();
    state.view = 'documents'; state.mainRoute = 'documents'; state.googleViewSurface = 'main';
    mainGoogleLifecycle.beginView('documents'); toolGoogleLifecycle.beginView('closed');
    navState(); closeSpecial(); mobilePane('editor');
    if (state.sidebarOpen) toggleSidebar(false);
  }
  function currentKey() { return state.current ? state.current.kind + ':' + state.current.id : ''; }
  function draft() { return state.drafts.get(currentKey()); }
  function stash() { const d = draft(); if (!d || d.readonly) return; d.title = title.value; d.text = text.value; d.dirty = d.title !== d.savedTitle || d.text !== d.savedText || d.status !== d.savedStatus || d.targetWords !== d.savedTargetWords; }
  function setEditorBusy(busy) {
    if (busy) {
      if (!editorBusyState) editorBusyState = { titleDisabled: title.disabled, textReadOnly: text.readOnly };
      title.disabled = true; text.readOnly = true;
    } else if (editorBusyState) {
      title.disabled = editorBusyState.titleDisabled; text.readOnly = editorBusyState.textReadOnly;
      editorBusyState = null;
    }
  }
  function date(value) { const d = new Date(value); return isNaN(d) ? 'недавно' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d); }
  function wordCount() { const source = chapters?.active() ? chapters.currentText() : text.value; const n = source.trim() ? source.trim().split(/\s+/u).length : 0; const a = n % 10, b = n % 100; const w = a === 1 && b !== 11 ? 'слово' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'слова' : 'слов'; $('#word-count').textContent = n + ' ' + w; }
  // An open manuscript chapter owns the editor chrome; the local draft keeps its state underneath.
  function renderCurrent() { renderDraftCurrent(); if (chapters?.active()) { chapters.refreshChrome(); wordCount(); selection(); } }
  function renderDraftCurrent() {
    const d = draft(), kind = state.current && state.current.kind;
    if (!d) {
      title.value = ''; text.value = ''; title.disabled = false; text.readOnly = false;
      const routeTitle = ({ documents: 'Выберите черновик', notes: 'Все заметки', knowledge: 'Поиск источников', google: 'Документы', settings: 'Подключения' })[state.view] || 'Выберите черновик';
      $('#crumb-title').textContent = kind === 'note' ? 'Выберите заметку' : routeTitle;
      $('#document-updated').textContent = 'Новый локальный черновик'; $('#document-version').textContent = 'Не сохранён'; $('#editor-kind-label').textContent = kind === 'note' ? 'Заметка' : 'Локальный черновик'; $('#readonly-badge').classList.add('hidden'); setSave('saved', 'Все изменения сохранены'); wordCount(); selection(); $('#history-button').disabled = true; return;
    }
    title.value = d.title || ''; text.value = d.text || ''; title.disabled = !!d.readonly; text.readOnly = !!d.readonly;
    $('#editor-kind-label').textContent = d.readonly ? 'Источник базы знаний' : kind === 'note' ? 'Заметка' : 'Локальный черновик';
    $('#readonly-badge').classList.toggle('hidden', !d.readonly); $('#document-updated').textContent = d.updatedAt ? 'Изменён ' + date(d.updatedAt) : 'Локальный черновик';
    $('#document-version').textContent = d.version ? 'Версия ' + d.version : 'Не сохранён'; $('#crumb-title').textContent = d.title || 'Без названия';
    setSave(d.dirty ? 'saving' : 'saved', d.dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены');
    $('#history-button').disabled = kind !== 'document' || !d.id; wordCount(); selection();
  }
  function scheduleSave() {
    if (!state.current) ensureEditableDraft();
    if (draft()?.readonly) return;
    stash(); wordCount(); selection(); setSave('saving', 'Сохранение…');
    const key = currentKey(), item = draft(); item.saveError = false;
    saveQueue.schedule(key, () => persistDraft(item));
  }
  function ensureEditableDraft() {
    const result = ensureEditableDocument(state, { title: title.value, text: text.value }, 'local-' + id());
    const item = result.draft;
    if (result.created) {
      navState();
      $('#editor-kind-label').textContent = 'Локальный черновик';
      $('#document-updated').textContent = 'Локальный черновик';
      $('#document-version').textContent = 'Не сохранён';
      $('#readonly-badge').classList.add('hidden');
      $('#history-button').disabled = true;
      renderLists();
    }
    return item;
  }
  function keyForDraft(item) {
    for (const [key, value] of state.drafts) if (value === item) return key;
    return null;
  }
  async function persistDraft(d) {
    const key = keyForDraft(d), kind = key?.split(':', 1)[0];
    if (!key || !d?.dirty || d.readonly) return;
    const sentTitle = d.title, sentText = d.text, sentVersion = d.version;
    try {
      let result;
      if (kind === 'document') result = d.id ? await api('/api/documents/' + encodeURIComponent(d.id), { method: 'PUT', body: { title: sentTitle, text: sentText, version: sentVersion, status: d.status, targetWords: normalizeTargetWords(d.targetWords) } }) : await api('/api/documents', { method: 'POST', body: { title: sentTitle, text: sentText, status: d.status, targetWords: normalizeTargetWords(d.targetWords) } });
      else result = d.id ? await api('/api/notes/' + encodeURIComponent(d.id), { method: 'PUT', body: { title: sentTitle, text: sentText, documentId: d.documentId || null, version: sentVersion } }) : await api('/api/notes', { method: 'POST', body: { title: sentTitle, text: sentText, documentId: d.documentId || null } });
      const item = result.document || result.note, wasCurrent = draft() === d, liveTitle = d.title, liveText = d.text;
      const selectionRange = wasCurrent ? { start: text.selectionStart, end: text.selectionEnd } : null;
      Object.assign(d, { id: item.id, title: liveTitle === sentTitle ? item.title : liveTitle, text: liveText === sentText ? item.text : liveText, version: item.version, updatedAt: item.updatedAt, savedTitle: item.title, savedText: item.text, savedStatus: item.status ?? d.status, savedTargetWords: item.targetWords ?? d.targetWords });
      d.dirty = d.title !== d.savedTitle || d.text !== d.savedText || d.status !== d.savedStatus || d.targetWords !== d.savedTargetWords; d.saveError = false;
      const newKey = kind + ':' + item.id;
      if (key !== newKey) { state.drafts.delete(key); state.drafts.set(newKey, d); saveQueue.rekey(key, newKey); if (wasCurrent) state.current.id = item.id; }
      summary(kind === 'document' ? state.docs : state.notes, item);
      if (wasCurrent) {
        renderCurrent();
        if (selectionRange) {
          text.setSelectionRange(Math.min(selectionRange.start, text.value.length), Math.min(selectionRange.end, text.value.length));
          selection();
        }
      }
      renderLists();
      rememberNavigation();
    } catch (e) {
      if (e.status === 409 && draft() === d) {
        await conflict(d, kind);
        if (!d.dirty) { d.saveError = false; setSave('saved', 'Все изменения сохранены'); return; }
      }
      else if (e.status === 409) { d.conflict = true; notify('Версия изменилась на сервере. Откройте этот черновик, чтобы вручную разрешить конфликт.', true); }
      else notify(e.message, true);
      d.saveError = true; setSave('error', e.status === 409 ? 'Конфликт версии' : 'Не удалось сохранить');
      throw e;
    }
  }
  function summary(list, item) { const i = list.findIndex(x => x.id === item.id), row = { id: item.id, title: item.title, updatedAt: item.updatedAt, version: item.version, documentId: item.documentId }; if (i < 0) list.unshift(row); else list[i] = { ...list[i], ...row }; }
  async function ask(head, copy, confirmText = 'Продолжить', altText = '') {
    const dialog = $('#action-dialog'), form = $('form', dialog); $('#dialog-title').textContent = head; $('#dialog-copy').textContent = copy; $('#dialog-confirm').textContent = confirmText;
    $('#dialog-alternate')?.remove(); if (altText) { const alt = btn(altText, 'button button-quiet'); alt.id = 'dialog-alternate'; alt.addEventListener('click', e => { e.preventDefault(); dialog.close('alternate'); }); $('.dialog-actions', form).prepend(alt); }
    dialog.showModal(); return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  }
  async function conflict(d, kind) {
    d.conflict = true; setSave('error', 'Конфликт версии'); let latest;
    try { latest = kind === 'document' ? (await api('/api/documents/' + encodeURIComponent(d.id))).document : (await api('/api/notes')).notes.find(x => x.id === d.id); } catch (e) { notify('Не удалось загрузить серверную версию: ' + e.message, true); return; }
    const choice = await ask('Документ изменился в другом месте', 'Автоматическое объединение не выполняется. Загрузите серверную версию или сохраните свой текст отдельной копией.', 'Загрузить серверную версию', 'Сохранить мой текст отдельной копией');
    if (choice === 'confirm') { Object.assign(d, { title: latest.title, text: latest.text, version: latest.version, updatedAt: latest.updatedAt, savedTitle: latest.title, savedText: latest.text, dirty: false, saveError: false }); renderCurrent(); }
    if (choice === 'alternate') { const titleCopy = (d.title || 'Черновик') + ' — локальная копия'; try { const saved = kind === 'document' ? (await api('/api/documents', { method: 'POST', body: { title: titleCopy, text: d.text } })).document : (await api('/api/notes', { method: 'POST', body: { title: titleCopy, text: d.text, documentId: d.documentId || null } })).note; summary(kind === 'document' ? state.docs : state.notes, saved); draftAdd(kind, saved); await openItem(kind, saved.id); notify('Создана отдельная копия вашего текста.'); } catch (e) { notify(e.message, true); } }
    d.conflict = false;
  }
  function draftAdd(kind, item) { const targetWords = normalizeTargetWords(item.targetWords); state.drafts.set(kind + ':' + item.id, { ...item, targetWords, text: safe(item.text), savedText: safe(item.text), savedTitle: safe(item.title), savedStatus: item.status, savedTargetWords: targetWords, dirty: false, readonly: false }); }
  async function create(kind) { openController.invalidate(); chapters?.deactivate(); const localId = 'local-' + id(); state.drafts.set(kind + ':' + localId, { id: null, title: '', text: '', version: 0, status: 'draft', targetWords: null, savedTitle: '', savedText: '', savedStatus: 'draft', savedTargetWords: null, dirty: true, documentId: kind === 'note' && state.current?.kind === 'document' ? state.current.id : null }); state.current = { kind, id: localId }; state.view = kind === 'note' ? 'notes' : 'documents'; state.mainRoute = state.view; state.googleViewSurface = 'main'; mainGoogleLifecycle.beginView(state.mainRoute); toolGoogleLifecycle.beginView('closed'); resetHistory(); navState(); closeSpecial(); renderCurrent(); if (kind === 'document') renderLists(); title.focus(); scheduleSave(); }
  function resetHistory() {
    state.history = []; state.selectedHistory = null;
    $('#history-list').replaceChildren(empty('Откройте документ', 'Выберите «История», чтобы загрузить его версии.'));
    $('#history-compare').classList.add('hidden');
    $$('.context-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.context === 'context'));
    $('#context-view').classList.remove('hidden'); $('#history-view').classList.add('hidden');
  }
  function activateOpenItem(kind, itemId) {
    chapters?.deactivate();
    if (state.current?.kind !== kind || state.current?.id !== itemId) resetHistory();
    state.current = { kind, id: itemId }; state.view = kind === 'note' ? 'notes' : 'documents'; state.mainRoute = state.view; state.googleViewSurface = 'main'; mainGoogleLifecycle.beginView(state.mainRoute); toolGoogleLifecycle.beginView('closed');
    navState(); closeSpecial(); renderCurrent(); renderLists();
    if (draft()?.dirty) scheduleSave();
    mobilePane('editor');
    if (state.sidebarOpen) toggleSidebar(false);
  }
  async function openItem(kind, itemId) {
    stash();
    const token = openController.begin();
    const key = kind + ':' + itemId, cached = state.drafts.get(key);
    if (cached && !cached.needsLoad) {
      openController.finish(token, () => activateOpenItem(kind, itemId));
      return;
    }
    try {
      const item = kind === 'document'
        ? (await api('/api/documents/' + encodeURIComponent(itemId))).document
        : (await api('/api/notes')).notes.find(x => x.id === itemId);
      if (!openController.isCurrent(token)) return;
      if (!item) throw Error('Запись больше не найдена.');
      openController.finish(token, () => {
        draftAdd(kind, item);
        activateOpenItem(kind, itemId);
      });
    } catch (e) {
      openController.finish(token, () => notify(e.message, true));
    }
  }
  function navState() { navigationRevision++; chapters?.noteRoute(); queueMicrotask(rememberNavigation); $$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === state.view)); $('#crumb-area').textContent = ({ documents: 'Черновики', overview: 'Обзор', notes: 'Заметки', knowledge: 'База знаний', google: 'Google Docs', settings: 'Настройки', proposals: 'Предложения', storyart: 'StoryArt' })[state.view] || ''; }
  function hideGoogleNativeEditor() {
    const wasOpen = state.googleNativeOpen;
    state.googleNativeOpen = false;
    $('#google-native-host').replaceChildren();
    $('#google-native-host').classList.add('hidden');
    $('.app-shell').classList.remove('google-native-workspace');
    if (wasOpen) renderCurrent();
  }
  function closeSpecial() { hideGoogleNativeEditor(); knowledgeViewRevision++; knowledgeCardRequest++; knowledgeMap?.destroy(); knowledgeMap = null; document.getElementById('concept-definition-dialog')?.remove(); special.classList.remove('storyart-view'); special.classList.add('hidden'); editor.classList.remove('hidden'); $('.app-shell').classList.remove('primary-workspace-view'); }
  function restorePortal() {
    if (portal) {
      const { panel } = portal;
      panelLifecycle.restoreHome(panel);
      panel.classList.add('hidden'); panel.classList.remove('portal-active');
    }
    portal = null;
    $('#tool-content').replaceChildren();
    $('#desktop-tool-content').replaceChildren();
  }
  function closeWorkspace() {
    const generation = panelLifecycle.invalidate(), dialog = $('#workspace-dialog');
    if (state.googleViewSurface === 'tool') toolGoogleLifecycle.beginView('closed');
    if (dialog.open) { pendingWorkspaceCloseGeneration = generation; dialog.close(); }
  }
  function toolPaletteClick(e) {
    const action = e.target.closest('[data-agent-action]');
    if (action) { agentShortcut(action.dataset.agentAction); return; }
    const button = e.target.closest('[data-tool]'); if (button) showToolPanel(button.dataset.tool);
  }
  function showToolPalette() {
    panelLifecycle.begin();
    panelLifecycle.beginView('tools');
    if (state.sidebarOpen) toggleSidebar(false);
    state.activeTool = 'tools';
    if (hasDesktopInspector()) {
      const dialog = $('#workspace-dialog');
      if (dialog.open) { ignoreWorkspaceClose = true; dialog.close(); }
      restorePortal(); if (!PRIMARY_VIEWS.has(state.view) && !state.googleNativeOpen) closeSpecial();
      const palette = $('#tool-palette').cloneNode(true);
      palette.removeAttribute('id');
      palette.classList.remove('hidden'); palette.addEventListener('click', toolPaletteClick);
      $('#desktop-tool-content').replaceChildren(palette);
      $$('[data-inspector]').forEach(tab => tab.classList.remove('selected'));
      $('#desktop-inspector').classList.add('active');
      return;
    }
    const dialog = $('#workspace-dialog');
    if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
    restorePortal();
    $('#workspace-dialog-title').textContent = 'Инструменты';
    $('#tool-palette').classList.remove('hidden'); $('#tool-content').classList.add('hidden');
    $('#workspace-back').classList.add('hidden');
  }
  async function showToolPanel(tool) {
    if (PRIMARY_VIEWS.has(tool)) { showPrimaryView(tool); return; }
    const generation = panelLifecycle.begin();
    panelLifecycle.beginView(tool);
    const primaryRouteActive = PRIMARY_VIEWS.has(state.view);
    if (!PRIMARY_VIEWS.has(tool)) state.activeTool = tool;
    if (state.sidebarOpen) toggleSidebar(false);
    const desktop = hasDesktopInspector();
    const dialog = $('#workspace-dialog');
    if (desktop) {
      if (dialog.open) { ignoreWorkspaceClose = true; dialog.close(); }
    } else if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
    restorePortal();
    if (!primaryRouteActive && !state.googleNativeOpen) closeSpecial();
    $('#tool-palette').classList.add('hidden');
    const slot = desktop ? $('#desktop-tool-content') : $('#tool-content');
    slot.classList.remove('hidden');
    if (!desktop) $('#workspace-back').classList.remove('hidden');
    $('#desktop-inspector').classList.toggle('active', desktop);
    $$('[data-inspector]').forEach(tab => tab.classList.toggle('selected', tab.dataset.inspector === tool));
    const titles = { knowledge:'База знаний', notes:'Заметки', google:'Google Docs', history:'История', settings:'Настройки', agent:'Агент', context:'Контекст', imports:'Импорт книг' };
    if (!desktop) $('#workspace-dialog-title').textContent = titles[tool] || 'Инструменты';
    const historyKey = currentKey(), historyDraftId = draft()?.id ?? null;
    let panel;
    if (tool === 'agent') panel = $('#agent-pane');
    else if (tool === 'context' || tool === 'history') {
      panel = $('#context-pane');
      const history = tool === 'history';
      $$('.context-tab').forEach(t => t.classList.toggle('active', (t.dataset.context === 'history') === history));
      $('#context-view').classList.toggle('hidden', history); $('#history-view').classList.toggle('hidden', !history);
      if (history) {
        await loadHistory(generation);
        if (!panelLifecycle.isCurrent(generation) || state.activeTool !== tool || hasDesktopInspector() !== desktop || (!desktop && !dialog.open) || currentKey() !== historyKey || (draft()?.id ?? null) !== historyDraftId) return;
      }
    } else if (!PRIMARY_VIEWS.has(tool)) {
      panel = special;
      state.view = ['notes','knowledge','google','settings','proposals','overview'].includes(tool) ? tool : 'documents';
      if (tool === 'google') { state.googleViewSurface = 'tool'; toolGoogleLifecycle.beginView('google'); }
      else if (state.googleViewSurface === 'main' && !['agent','context','history'].includes(tool)) mainGoogleLifecycle.beginView(tool);
      else if (state.googleViewSurface === 'tool' && !['agent','context','history'].includes(tool)) toolGoogleLifecycle.beginView(tool);
      navState(); special.replaceChildren(); special.classList.remove('hidden', 'storyart-view');
      if (tool === 'knowledge') knowledge();
      if (tool === 'proposals') proposals();
      if (tool === 'overview') loadOverview().then(renderOverview);
      if (tool === 'google') renderGoogle();
      if (tool === 'settings') settings();
      if (tool === 'notes') renderNotes();
      if (tool === 'notes') loadOverview();
      if (tool === 'imports') special.append(createImportWorkspace({ document, api, notify, ask, getModel: () => $('#model-select').value, onPublished: refreshAfterImportPublish }));
    }
    panelLifecycle.rememberHome(panel);
    portal = { panel };
    panel.classList.remove('hidden'); panel.classList.add('portal-active'); slot.replaceChildren(panel);
    if (tool === 'agent') selection();
  }
  async function refreshAfterImportPublish(result) {
    const catalog = await api('/api/workspace/catalog');
    state.catalog = catalog; renderCatalogSelectors();
    const selection = result?.selection;
    if (!selection?.authorId || !selection?.seriesId || !selection?.bookId) return;
    const author = catalog.authors?.find(item => item.id === selection.authorId);
    const series = author?.series?.find(item => item.id === selection.seriesId);
    const book = series?.books?.find(item => item.id === selection.bookId);
    if (!author || !series || !book) return;
    $('#author-select').value = author.id;
    fillSelect($('#series-select'), 'Серия', author.series, series.id);
    fillSelect($('#book-select'), 'Книга', series.books, book.id);
    await selectWorkspace();
  }
  function heading(kicker, head, desc) { const h = node('div', 'special-heading'), c = node('div'); c.append(node('div', 'eyebrow', kicker), node('h1', '', head), node('p', '', desc)); h.append(c); return h; }
  function empty(head, desc) { const n = node('div', 'empty-state'); n.append(node('strong', '', head), node('span', '', desc)); return n; }
  function renderLists() {
    const localDocs = localDraftSummaries('document'), localNotes = localDraftSummaries('note');
    $('#document-count').textContent = state.docs.length + localDocs.length; $('#note-count').textContent = state.notes.length + localNotes.length;
    const list = $('#sidebar-documents'); list.replaceChildren();
    const docs = state.docs.concat(localDocs);
    if (!docs.length) list.append(node('div', 'sidebar-empty', 'Ваши черновики появятся здесь после создания.'));
    docs.forEach(d => { const b = btn('', 'sidebar-doc' + (state.current?.kind === 'document' && state.current.id === d.id ? ' current' : ''), () => openItem('document', d.id)); b.append(node('span', 'doc-bullet', '·'), node('span', '', (d.title || 'Без названия') + (state.scope === 'all' && !d.seriesId ? ' · Без привязки' : ''))); list.append(b); });
    if (state.view === 'notes') renderNotes();
    renderContextSources(); renderContextNotes();
  }
  function localDraftSummaries(kind) {
    const prefix = kind + ':local-';
    return [...state.drafts.entries()].filter(([key, value]) => key.startsWith(prefix) && !value.id).map(([key, value]) => ({ id: key.slice(kind.length + 1), title: value.title || (kind === 'note' ? 'Новая заметка' : 'Новый черновик'), updatedAt: value.updatedAt || new Date().toISOString(), documentId: value.documentId || null }));
  }
  function renderNotes() {
    if (state.view !== 'notes') return; special.replaceChildren(); special.classList.remove('hidden'); editor.classList.toggle('hidden', !hasDesktopInspector());
    const h = heading('ЗАМЕТКИ АВТОРА', 'Заметки', 'Идеи и вопросы хранятся отдельно от базы знаний. Заметку можно связать с открытым черновиком.'); h.append(btn(state.scope === 'all' ? 'Только выбранная книга' : 'Показать все области', 'button button-quiet', () => loadLists(state.scope === 'all' ? 'active' : 'all')), btn('＋ Новая заметка', 'button button-primary', () => { closeWorkspace(); create('note'); })); special.append(h);
    const sourceNotes = (state.overview?.notes || []).filter(n => !state.notes.some(saved => (n.id && saved.id === n.id) || (n.path && saved.path === n.path)));
    const notes = state.notes.concat(sourceNotes, localDraftSummaries('note'));
    if (!notes.length) { special.append(empty('Здесь пока тихо', 'Создайте заметку, чтобы сохранить идею или вопрос.')); return; }
    const rows = node('div', 'note-list'); notes.forEach(n => { const row = node('div', 'note-row'), copy = node('div', 'note-row-copy'); copy.append(node('strong', '', n.title || 'Без названия'), node('span', '', n.path ? friendlyRecordType(n.recordKind || n.record_kind || n.metadata?.record_kind || n.type) : date(n.updatedAt) + (n.documentId ? ' · связана с черновиком' : ''))); row.append(copy, btn('Открыть', 'note-open', () => { closeWorkspace(); if (n.id) openItem('note', n.id); else if (n.path) showKnowledgeCard(n, null); })); rows.append(row); }); special.append(rows);
  }
  function fillSelect(select, placeholder, items, selected) {
    select.replaceChildren(); const first = document.createElement('option'); first.value = ''; first.textContent = placeholder; select.append(first);
    (items || []).forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; select.append(option); });
    select.value = selected || ''; select.disabled = !(items || []).length;
  }
  function activeCatalogItems() {
    const a = state.catalog?.authors?.find(x => x.id === state.catalog.active?.authorId);
    const s = a?.series?.find(x => x.id === state.catalog.active?.seriesId);
    return { author: a, series: s };
  }
  // Reopens a companion Google Doc the author had explicitly opened, only if it is still attached to the open book.
  function restoreOpenedCompanionDocument(documentId) {
    const { series } = activeCatalogItems();
    const book = series?.books?.find(item => item.id === state.catalog?.active?.bookId);
    const companion = typeof documentId === 'string' && documentId ? (book?.attachments || []).find(item => item.kind === 'google-doc' && item.googleDocumentId === documentId) : null;
    if (!companion) return false;
    return showGoogleNativeEditor({ documentId: companion.googleDocumentId, title: companion.name });
  }
  function renderCatalogSelectors() {
    if (!state.catalog) return;
    const { author, series } = activeCatalogItems();
    fillSelect($('#author-select'), 'Автор', state.catalog.authors, author?.id);
    fillSelect($('#series-select'), 'Серия', author?.series, series?.id);
    fillSelect($('#book-select'), 'Книга', series?.books, state.catalog.active?.bookId);
    const crumb = $('#crumb-area');
    if (author && series) crumb.title = [author.name, series.name, series.books?.find(x => x.id === state.catalog.active.bookId)?.name].filter(Boolean).join(' / ');
    deck.update(state.catalog, { error: state.catalogError || '' });
    void chapters?.syncBook(state.catalog.active?.bookId ?? null);
  }
  async function loadCatalog() {
    try { state.catalog = await api('/api/workspace/catalog'); state.catalogError = ''; renderCatalogSelectors(); reportAgentContext(); }
    catch (e) { state.catalogError = e.message; deck.update(state.catalog, { error: e.message }); notify('Каталог книг пока недоступен: ' + e.message, true); }
  }
  // Final step of the card rail: fill the model selects and run the unchanged selection flow.
  async function commitWorkspaceSelection(ids) {
    if (state.agent?.running) return { ok: false, error: 'Агент сейчас отвечает. Дождитесь завершения или остановите ответ, затем смените книгу.' };
    if (knowledgeWorkspaceChanging) return { ok: false, error: 'Рабочая книга уже переключается. Дождитесь результата.' };
    const author = state.catalog?.authors?.find(x => x.id === ids?.authorId), series = author?.series?.find(x => x.id === ids?.seriesId);
    if (!author || !series) return { ok: false, error: 'Выбранная серия больше не найдена в каталоге. Обновите выбор.' };
    fillSelect($('#author-select'), 'Автор', state.catalog.authors, author.id);
    fillSelect($('#series-select'), 'Серия', author.series, series.id);
    fillSelect($('#book-select'), 'Книга', series.books, ids.bookId || '');
    state.workspaceSelectionError = '';
    await selectWorkspace();
    const active = state.catalog?.active || {};
    const confirmed = active.authorId === ids.authorId && active.seriesId === ids.seriesId && (active.bookId ?? null) === (ids.bookId ?? null);
    if (confirmed && !state.workspaceSelectionError) return { ok: true };
    return { ok: false, error: state.workspaceSelectionError || 'Сервер не подтвердил выбор. Открыта прежняя рабочая область.' };
  }
  function openUnassignedKnowledge() {
    state.knowledgeScope = 'unassigned'; state.knowledgeSelectedPath = null; state.knowledgeSelectedConceptId = null;
    rememberNavigation(); deck.close(); showPrimaryView('knowledge');
  }
  async function selectWorkspace() {
    if (knowledgeWorkspaceChanging) return;
    let reloadKnowledge = false;
    state.workspaceSelectionError = '';
    try {
      stash();
      for (const key of [...state.drafts.keys()]) await saveQueue.flush(key);
      if ([...state.drafts.values()].some(x => x.dirty || x.saveError)) throw Error('Сначала сохраните все изменения черновиков.');
      const ids = buildWorkspaceSelectionRequest(state.catalog, $('#author-select').value, $('#series-select').value, $('#book-select').value);
      if (!ids) throw Error('Выберите существующие автора, серию и книгу. Для серии без книг книга не требуется.');
      knowledgeWorkspaceChanging = true; reloadKnowledge = true;
      document.getElementById('concept-definition-dialog')?.remove();
      knowledgeViewRevision++; knowledgeCardRequest++; state.knowledgeSelectedPath = null; state.knowledgeSelectedConceptId = null;
      knowledgeMap?.destroy(); knowledgeMap = null;
      if (state.view === 'knowledge') special.replaceChildren(node('div', 'subtle-empty', 'Переключаю рабочую книгу…'));
      state.catalog = await api('/api/workspace/select', { method: 'POST', body: ids });
      storyArt.scopeChanged();
      openController.invalidate();
      hideGoogleNativeEditor();
      state.googleDoc = null; state.googleTab = null;
      state.sources.clear(); state.selectedText = ''; state.current = null; renderCurrent(); renderContextSources();
      // A book opens its own workspace; companion Google Docs open only from their attachment tile.
      closeWorkspace(); restorePortal(); switchView('documents');
      await Promise.all([loadLists(), loadOverview(), loadAgent()]);
      renderCatalogSelectors();
      rememberNavigation();
      notify('Рабочая книга переключена.');
    } catch (e) { state.workspaceSelectionError = e.message; renderCatalogSelectors(); notify(e.message, true); }
    finally {
      if (reloadKnowledge) { knowledgeWorkspaceChanging = false; if (state.view === 'knowledge') showPrimaryView('knowledge'); }
    }
  }
  async function loadOverview() {
    try { state.overview = await api('/api/workspace/overview'); if (state.view === 'overview') renderOverview(); else if (state.view === 'notes') renderNotes(); }
    catch (e) { if (state.view === 'overview') special.replaceChildren(empty('Обзор недоступен', e.message)); }
  }
  // Companion files of the open book. They are never the book itself and open only by an explicit tile action.
  function renderAttachmentTiles(items) {
    const section = node('section', 'overview-section overview-attachments'), head = node('div', 'overview-section-head');
    head.append(node('h2', '', 'Связанные файлы'), btn('Настроить связи', 'button button-quiet', () => openProjectSettings('attachments')));
    section.append(head, node('p', 'overview-attachments-note', 'Сопутствующие материалы книги: Google Docs и файлы базы серии. Они не входят в текст и подсчёт слов книги.'));
    const grid = node('div', 'attachment-tiles');
    if (!items.length) grid.append(node('div', 'subtle-empty', 'У этой книги пока нет связанных файлов. Прикрепить Google Docs можно в «Настройках проекта».'));
    for (const item of items) {
      const tile = node('article', 'attachment-tile attachment-' + item.kind);
      tile.append(node('span', 'attachment-kind', attachmentKindLabel(item.kind)), node('strong', '', item.name));
      if (item.path) { const where = node('span', 'attachment-path', item.path); where.title = item.path; tile.append(where); }
      const actions = node('div', 'attachment-actions');
      if (item.googleDocumentId) actions.append(btn('Открыть в Google Docs', 'button button-quiet', () => openCompanionGoogleDocument(item)));
      if (item.sourceAvailable) actions.append(btn('Открыть исходник', 'text-action', () => openAttachmentSource(item)));
      actions.append(btn('В архив', 'text-action', () => archiveAttachmentFromOverview(item)));
      tile.append(actions); grid.append(tile);
    }
    section.append(grid); return section;
  }
  async function archiveAttachmentFromOverview(item) {
    if (await ask('Скрыть связанный файл?', `«${item.name}» исчезнет из списка книги и останется в «Настройки → Настройки проекта → Архив связанных файлов». Документ Google Docs и файлы хранилища не удаляются.`, 'В архив') !== 'confirm') return;
    try {
      const result = await api(projectRequest('attachment', 'archive', { id: item.id }).path, { method: 'POST', body: { expectedRevision: state.catalog?.projectRevision ?? 0 } });
      await applyProjectResult(result);
      notify(result.warning || 'Файл перенесён в архив. Восстановить его можно в «Настройках проекта».', !!result.warning);
    } catch (e) { notify(friendlyProjectError(e), true); if (e.code === 'project_conflict') await loadCatalog(); }
  }
  // Opens a companion Google Doc from its attachment tile (overview or project settings).
  // The attachment already carries the document ID and title for the native editor.
  // Both counters only grow, so leaving and returning (or switching the book and back) still cancels a pending open:
  // navigationRevision is bumped by every navState() call; companionOpenRequest also by a confirmed active-book change.
  let companionOpenRequest = 0;
  function invalidateCompanionOpen() { companionOpenRequest++; }
  async function openCompanionGoogleDocument(attachment) {
    const documentId = attachment?.googleDocumentId, title = attachment?.name || 'Google Docs';
    if (!documentId) { notify('У связанного файла нет ID документа Google Docs.', true); return false; }
    const request = ++companionOpenRequest, startedNavigation = navigationRevision;
    const context = () => [state.view, state.mainRoute, state.settingsPane, state.catalog?.active?.authorId, state.catalog?.active?.seriesId, state.catalog?.active?.bookId ?? null].join('\u0000');
    const startedIn = context();
    const isCurrent = () => request === companionOpenRequest && navigationRevision === startedNavigation && !knowledgeWorkspaceChanging && context() === startedIn;
    try {
      stash();
      for (const key of [...state.drafts.keys()]) await saveQueue.flush(key);
      if ([...state.drafts.values()].some(x => x.dirty || x.saveError)) throw Error('Сначала сохраните все изменения черновиков — документ Google Docs не открыт.');
    } catch (e) { if (isCurrent()) notify(e.message, true); return false; }
    // The author may have clicked another file, switched the book or left the screen while drafts were saving.
    if (!isCurrent()) return false;
    return showGoogleNativeEditor({ documentId, title });
  }
  async function flushAllDrafts() {
    stash();
    for (const key of [...state.drafts.keys()]) await saveQueue.flush(key);
    if ([...state.drafts.values()].some(x => x.dirty || x.saveError)) throw Object.assign(Error('Сначала сохраните все изменения черновиков — настройки проекта не изменены.'), { code: 'drafts_unsaved' });
  }
  // The server already switched (or detached) the agent context; the client follows its confirmed catalog.
  async function applyProjectResult(result) {
    if (result?.catalog) { state.catalog = result.catalog; state.catalogError = ''; }
    if (result?.activeChanged || result?.agentContext?.status === 'detached') {
      openController.invalidate(); invalidateCompanionOpen(); hideGoogleNativeEditor(); state.googleDoc = null; state.googleTab = null;
      state.sources.clear(); state.selectedText = ''; renderContextSources();
      knowledgeViewRevision++; knowledgeCardRequest++; state.knowledgeSelectedPath = null; state.knowledgeSelectedConceptId = null;
    }
    renderCatalogSelectors(); reportAgentContext();
    await Promise.all([loadLists(), loadOverview(), loadAgent()]);
  }
  let reportedAgentContext = '';
  function reportAgentContext() {
    const context = state.catalog?.agentContext, key = context?.status === 'detached' ? context.error || 'detached' : '';
    if (key && key !== reportedAgentContext) notify('Агент отключён от открытой книги: ' + key + ' Откройте книгу заново в верхней ленте.', true);
    reportedAgentContext = key;
  }
  const projectSettings = createProjectSettings({
    document, api, notify, ask,
    flushDrafts: flushAllDrafts,
    onCommitted: applyProjectResult,
    onBack: () => showPrimaryView('settings'),
    openGoogleDocument: item => openCompanionGoogleDocument(item),
    openSourceFile: item => openAttachmentSource(item),
    openBook: async ids => { const result = await commitWorkspaceSelection(ids); if (!result.ok) notify(result.error, true); },
  });
  // A companion file is read by its attachment ID, so it stays openable after its book moves to another series.
  const openAttachmentSource = item => showKnowledgeCard({ scope: 'active', attachmentId: item.id, path: item.path, title: item.name }, null);
  function openProjectSettings(section = '') { state.settingsPane = 'project'; state.settingsSection = section; showPrimaryView('settings'); }
  function renderOverview() {
    if (!state.overview) { special.replaceChildren(empty('Загружаю обзор', 'Получаю материалы выбранной книги.')); return; }
    const data = state.overview, h = heading('РАБОЧАЯ КНИГА', 'Обзор', 'Материалы выбранной книги, заметки и ход работы.');
    const refresh = btn('Обновить', 'button button-quiet', loadOverview); h.append(refresh); special.replaceChildren(h);
    const progress = node('section', 'workspace-progress'); progress.append(node('h2', '', 'Прогресс'));
    const meters = node('div', 'progress-metrics');
    meters.append(metric('Слова', data.progress?.words), metric('Черновики', data.progress?.draftCount), metric('Завершено', data.progress?.completedCount)); progress.append(meters);
    const currentDraft = draft();
    if (currentDraft && !currentDraft.readonly) {
      const controls = node('div', 'progress-controls');
      const status = document.createElement('select'); status.setAttribute('aria-label', 'Статус черновика');
      [['draft','Черновик'],['in_progress','В работе'],['completed','Завершён']].forEach(([v,label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label; status.append(o); }); status.value = currentDraft.status || 'draft';
      const target = document.createElement('input'); target.type = 'number'; target.min = '0'; target.max = '10000000'; target.value = String(normalizeTargetWords(currentDraft.targetWords)); target.placeholder = 'Цель по словам'; target.setAttribute('aria-label', 'Цель по словам');
      const save = btn('Сохранить статус и цель', 'button button-quiet', async () => { currentDraft.status = status.value; currentDraft.targetWords = normalizeTargetWords(target.value); currentDraft.dirty = true; stash(); scheduleSave(); try { await saveQueue.flush(currentKey()); await loadOverview(); notify('Прогресс сохранён.'); } catch {} });
      controls.append(status, target, save); progress.append(controls);
    } else progress.append(node('p', 'subtle-empty', 'Откройте локальный черновик, чтобы задать его статус и цель.'));
    special.append(progress);
    const manuscripts = node('section', 'overview-section'); manuscripts.append(node('h2', '', 'Исходный текст'));
    const cards = node('div', 'manuscript-cards');
    const sourceItems = (data.manuscripts || []).filter(item => !/scene.?analysis|analysis/i.test(String(item.recordKind || item.record_kind || item.type || '')));
    const analysisItems = (data.sceneAnalyses || []).concat((data.manuscripts || []).filter(item => /scene.?analysis|analysis/i.test(String(item.recordKind || item.record_kind || item.type || ''))));
    if (!sourceItems.length) cards.append(empty('Исходный текст не найден', 'Каталог не вернул главы или другие исходные файлы книги.'));
    else sourceItems.forEach(item => { const card = node('article', 'manuscript-card'); card.append(node('strong', '', item.title || item.path), node('span', '', [friendlyRecordType(item.recordKind || item.record_kind || item.metadata?.record_kind || item.type), Number.isFinite(item.words) ? item.words + ' слов' : '', friendlyStatus(item.status)].filter(Boolean).join(' · '))); card.append(btn('Открыть для чтения', 'text-action', () => showKnowledgeCard({ scope: 'active', path: item.path, title: item.title || item.path, type: item.type, recordKind: item.recordKind || item.record_kind || item.metadata?.record_kind }, null))); cards.append(card); });
    manuscripts.append(cards); special.append(manuscripts);
    special.append(renderAttachmentTiles(data.attachments || []));
    if (analysisItems.length) { const analysis = node('section', 'overview-section'); analysis.append(node('h2', '', 'Разборы сцен и анализы')); const analysisCards = node('div', 'manuscript-cards'); analysisItems.forEach(item => { const card = node('article', 'manuscript-card'); card.append(node('strong', '', item.title || item.path), node('span', '', [friendlyRecordType(item.recordKind || item.record_kind || item.metadata?.record_kind || item.type), Number.isFinite(item.words) ? item.words + ' слов' : '', item.status ? friendlyStatus(item.status) : ''].filter(Boolean).join(' · ')), btn('Открыть разбор', 'text-action', () => showKnowledgeCard({ scope: 'active', path: item.path, title: item.title || item.path, type: item.type, recordKind: item.recordKind || item.record_kind || item.metadata?.record_kind }, null))); analysisCards.append(card); }); analysis.append(analysisCards); special.append(analysis); }
    const notes = node('section', 'overview-section'); notes.append(node('h2', '', 'Заметки книги'));
    const noteCards = node('div', 'overview-note-cards');
    (data.notes || []).forEach(item => { const card = node('article', 'overview-note-card'); card.append(node('strong', '', item.title || item.path), node('span', '', friendlyRecordType(item.recordKind || item.record_kind || item.type)), btn('Открыть', 'button button-quiet', () => item.id ? openItem('note', item.id) : item.path ? showKnowledgeCard(item, null) : notify('Запись не содержит пути для чтения.'))); noteCards.append(card); });
    if (!noteCards.childNodes.length) noteCards.append(node('div', 'subtle-empty', 'Заметок в этой книге пока нет.'));
    notes.append(noteCards, btn('Новая заметка', 'button button-quiet', () => create('note'))); special.append(notes);
    const style = node('section', 'overview-section style-status'); style.append(node('h2', '', 'Стиль письма'));
    const styleExcluded = data.style?.excluded === true;
    if (styleExcluded) style.append(node('p', 'style-excluded', 'Исключён для этой серии. Автоматически не активируется.'));
    else if (data.style?.available) { style.append(node('p', '', 'Доступны подтверждённые правила и лексические предпочтения выбранной серии.')); style.append(btn('Писать в стиле серии', 'button button-primary', () => startCapability('style', 'Напиши фрагмент с учётом подтверждённых правил выбранной серии.'))); }
    else style.append(node('p', 'subtle-empty', 'Подтверждённый стиль для выбранной серии недоступен.'));
    special.append(style);
    const capabilities = node('section', 'overview-section capability-list'); capabilities.append(node('h2', '', 'Инструменты TaleWisp'));
    (data.capabilities || []).forEach(tool => { const row = node('article', 'capability-row'); const copy = node('div'); copy.append(node('strong', '', tool.title || tool.name), node('span', '', tool.description || tool.mode || '')); row.append(copy, btn(tool.mode === 'read' ? 'Открыть' : 'Подготовить', 'button button-quiet', () => startCapability(tool.name, 'Выполни действие «' + (tool.title || tool.name) + '». Уточни нужный ввод в форме ниже; подготовь только предложение на проверку.'))); capabilities.append(row); });
    if (!data.capabilities?.length) capabilities.append(node('div', 'subtle-empty', 'Каталог инструментов не передан сервером.'));
    special.append(capabilities);
  }
  function metric(label, value) { const el = node('div', 'progress-metric'); el.append(node('strong', '', Number.isFinite(value) ? new Intl.NumberFormat('ru-RU').format(value) : '—'), node('span', '', label)); return el; }
  function startCapability(name, prompt) {
    const form = node('form', 'capability-form'), input = document.createElement('textarea'); input.rows = 3; input.placeholder = 'Параметры или контекст действия'; input.setAttribute('aria-label', 'Параметры инструмента');
    const submit = btn('Передать выбранному агенту', 'button button-primary'); submit.type = 'submit'; form.append(node('strong', '', 'Инструмент: ' + name), input, submit);
    form.addEventListener('submit', e => { e.preventDefault(); $('#chat-input').value = prompt + (input.value.trim() ? '\nПараметры автора: ' + input.value.trim() : ''); showToolPanel('agent'); $('#chat-input').focus(); });
    const existing = $('.capability-form', special); existing?.remove(); special.append(form); input.focus();
  }
  function renderSpecial(view) { showPrimaryView(view); }
  function showPrimaryView(view) {
    if (!PRIMARY_VIEWS.has(view)) return;
    hideGoogleNativeEditor();
    if (view !== 'storyart') storyArt.hide();
    if (view !== 'knowledge') { document.getElementById('concept-definition-dialog')?.remove(); knowledgeViewRevision++; knowledgeCardRequest++; knowledgeMap?.destroy(); knowledgeMap = null; }
    special.classList.toggle('knowledge-map-view', view === 'knowledge');
    special.classList.toggle('storyart-view', view === 'storyart');
    const dialog = $('#workspace-dialog');
    if (dialog.open) closeWorkspace();
    if (portal?.panel === special) restorePortal();
    state.view = view;
    state.mainRoute = view; state.googleViewSurface = 'main'; mainGoogleLifecycle.beginView(view); toolGoogleLifecycle.beginView('closed');
    navState();
    editor.classList.add('hidden');
    special.classList.remove('hidden');
    $('.app-shell').classList.add('primary-workspace-view');
    special.replaceChildren();
    if (view === 'knowledge') knowledge();
    if (view === 'proposals') proposals();
    if (view === 'overview') loadOverview();
    if (view === 'google') renderGoogle();
    if (view === 'settings') settings();
    if (view === 'notes') { renderNotes(); loadOverview(); }
    if (view === 'storyart') { special.append(storyArt.root); storyArt.show(); }
  }
  function switchView(view) {
    if (view === 'documents') {
      storyArt.hide(); closeWorkspace(); if (!hasDesktopInspector() || portal?.panel === special) restorePortal(); closeSpecial(); state.view = state.current?.kind === 'note' ? 'notes' : 'documents'; state.mainRoute = state.view; state.googleViewSurface = 'main'; mainGoogleLifecycle.beginView(state.mainRoute); toolGoogleLifecycle.beginView('closed');
      navState(); renderLists();
    } else if (PRIMARY_VIEWS.has(view)) showPrimaryView(view);
    if (state.sidebarOpen) toggleSidebar(false);
  }
  async function knowledge() {
    special.append(heading('ПЕРВОИСТОЧНИКИ · ТОЛЬКО ЧТЕНИЕ', 'База знаний', 'Ищите в подключённом хранилище и отмечайте источники для контекста агента.'));
    const starter = node('div', 'knowledge-starters'); special.append(starter);
    const search = node('label', 'search-wrap'); search.append(svgIcon('search')); const input = node('input'); input.type = 'search'; input.placeholder = 'Поиск по источникам…'; input.setAttribute('aria-label', 'Поиск по базе знаний'); search.append(input); special.append(search);
    const layout = node('div', 'knowledge-layout'), results = node('div', 'knowledge-results'), reader = node('div', 'knowledge-reader'); results.append(empty('Введите запрос', 'Поиск читает настроенную базу знаний.')); reader.append(empty('Выберите источник', 'Содержимое отображается только для чтения.')); layout.append(results, reader); special.append(layout);
    api('/api/knowledge/status').then(s => {
      if (s.configured === false) { starter.append(empty('База не настроена', 'Проверьте подключение хранилища на сервере.')); return; }
      starter.append(node('strong', '', s.name || 'Активная серия'));
      if (!Array.isArray(s.starterSources) || !s.starterSources.length) { starter.append(node('span', '', 'Стартовые источники для этой серии не указаны. Используйте поиск по нужной теме.')); return; }
      starter.append(node('span', '', 'Основные записи активной серии:'));
      const list = node('div', 'knowledge-starter-list');
      s.starterSources.forEach(file => { const b = btn('', 'knowledge-result'); b.append(node('strong', '', file.title || file.path), node('span', '', file.path)); b.addEventListener('click', () => openKnowledge(file, b, reader, results)); list.append(b); });
      starter.append(list);
    }).catch(e => starter.append(node('span', '', 'Не удалось загрузить список активной серии: ' + e.message)));
    let timer; input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => { const q = input.value.trim(); if (!q) return; results.replaceChildren(node('div', 'subtle-empty', 'Поиск…')); reader.replaceChildren(empty('Выберите источник', 'Содержимое отображается только для чтения.')); try { const r = await api('/api/knowledge?q=' + encodeURIComponent(q)); results.replaceChildren(); if (r.configured === false) { results.append(empty('База не настроена', 'Проверьте подключение хранилища на сервере.')); return; } if (r.truncated === true) results.append(node('div', 'knowledge-truncated', 'Показана ограниченная часть результатов. Уточните запрос, чтобы найти нужный фрагмент.')); if (!r.files?.length) { results.append(empty('Ничего не найдено', 'Попробуйте другое слово или форму.')); return; } r.files.forEach(f => { const b = btn('', 'knowledge-result'); b.append(node('strong', '', f.title || f.path), node('span', '', f.path), node('span', '', safe(f.excerpt).slice(0, 180))); b.addEventListener('click', () => openKnowledge(f, b, reader, results)); results.append(b); }); } catch (e) { results.replaceChildren(empty('Поиск недоступен', e.message)); } }, 260); });
  }
  async function openKnowledge(file, buttonNode, reader, results) {
    $$('.knowledge-result', results).forEach(x => x.classList.toggle('selected', x === buttonNode)); reader.replaceChildren(node('div', 'subtle-empty', 'Загружаю источник…'));
    try { const r = await api('/api/knowledge/file?path=' + encodeURIComponent(file.path)); reader.replaceChildren(node('h2', '', file.title || file.path), node('div', 'source-path', r.path));
      const controls = node('div', 'knowledge-controls'), check = document.createElement('input'); check.type = 'checkbox'; check.className = 'select-source'; check.checked = state.sources.has(r.path); check.addEventListener('change', () => { if (check.checked) state.sources.add(r.path); else state.sources.delete(r.path); renderContextSources(); }); controls.append(check, node('span', '', 'Добавить источник в контекст агента')); reader.append(controls, node('pre', '', safe(r.text)));
    } catch (e) { reader.replaceChildren(empty('Источник не открыт', e.message)); }
  }
  async function knowledge() {
    const revision = ++knowledgeViewRevision;
    knowledgeGraph = null;
    knowledgeCardRequest++;
    knowledgeMap?.destroy(); knowledgeMap = null;
    special.classList.add('knowledge-map-view');
    if (knowledgeWorkspaceChanging) { special.append(node('div', 'subtle-empty', 'Переключаю рабочую книгу…')); return; }
    const header = heading('ВАША ИСТОРИЯ В СВЯЗЯХ', 'База знаний', 'Исследуйте термины по вложенным разделам. Нажмите на термин, чтобы открыть его определение или пояснение и источники.');
    header.classList.add('knowledge-heading');
    special.append(header);
    const top = node('div', 'knowledge-map-scope-row');
    const scope = document.createElement('select'); scope.setAttribute('aria-label', 'Область базы знаний');
    [['active','Выбранная серия'],['unassigned','Без привязки к автору (' + (state.catalog?.unassigned?.cardCount || 0) + ')']].forEach(([value,label]) => { const option = document.createElement('option'); option.value=value; option.textContent=label; scope.append(option); });
    scope.value = state.knowledgeScope;
    const refresh = btn('Обновить карту', 'button button-quiet');
    top.append(scope, refresh); header.append(top);
    const mapHost = node('section', 'knowledge-map-host'); mapHost.setAttribute('aria-label', 'Карта базы знаний');
    const reader = node('section', 'knowledge-reader'); reader.setAttribute('aria-label', 'Выбранная запись');
    reader.append(empty('Информация о понятии', 'Выберите термин на карте или в списке. Здесь появятся пояснение, частности и источники.'));
    const workspace = node('div', 'knowledge-concept-workspace'); workspace.append(mapHost, reader); special.append(workspace);
    let request = 0;
    const load = async () => {
      const token = ++request, requestedScope = state.knowledgeScope;
      knowledgeGraph = null;
      reader.replaceChildren(empty('Информация о понятии', 'Выберите термин на карте или в списке.'));
      const cardBaseline = ++knowledgeCardRequest;
      knowledgeMap?.destroy(); knowledgeMap = null;
      mapHost.replaceChildren(node('div', 'subtle-empty', 'Собираю карту выбранной области…'));
      refresh.disabled = true;
      try {
        const rawGraph = await api('/api/knowledge/graph' + (requestedScope === 'unassigned' ? '?scope=unassigned' : ''));
        const graph = rawGraph.mode === 'concepts' ? withConceptMentions(rawGraph) : rawGraph;
        if (token !== request || revision !== knowledgeViewRevision || state.view !== 'knowledge' || !mapHost.isConnected || requestedScope !== state.knowledgeScope) return;
        mapHost.replaceChildren(); knowledgeGraph = graph;
        knowledgeMap = createKnowledgeMap({ container: mapHost, graph, onSelect: record => graph.mode === 'concepts' ? showConceptDefinition(record) : showKnowledgeCard(record, null) });
        if (knowledgeCardRequest !== cardBaseline) return; // a newer explicit card request owns the reader
        if (graph.mode === 'concepts') {
          if (state.knowledgeSelectedConceptId && knowledgeMap.select(state.knowledgeSelectedConceptId)) { const selected = graph.nodes.find(n => n.id === state.knowledgeSelectedConceptId); if (selected) showConceptDefinition(selected); }
          else if (state.knowledgeSelectedPath) showKnowledgeCard({ path: state.knowledgeSelectedPath }, null);
          return;
        }
        if (state.knowledgeSelectedPath && knowledgeMap.select(state.knowledgeSelectedPath)) {
          const selected = graph.nodes.find(record => record.path === state.knowledgeSelectedPath);
          if (selected) showKnowledgeCard(selected, null);
        }
      } catch (e) {
        if (token === request && revision === knowledgeViewRevision && mapHost.isConnected && state.view === 'knowledge') mapHost.replaceChildren(empty('Карта не загружена', e.message), btn('Попробовать снова', 'button button-quiet', load));
      } finally { if (token === request && revision === knowledgeViewRevision) refresh.disabled = false; }
    };
    scope.addEventListener('change', () => {
      state.knowledgeScope = scope.value; state.knowledgeSelectedPath = null; state.knowledgeSelectedConceptId = null; document.getElementById('concept-definition-dialog')?.remove();
      rememberNavigation();
      reader.replaceChildren(empty('Выберите понятие', 'Карта и записи относятся только к выбранной области.')); load();
    });
    refresh.addEventListener('click', load);
    await load();
  }
  function showConceptDefinition(concept) {
    state.knowledgeSelectedConceptId = concept.id;
    state.knowledgeSelectedPath = null;
    rememberNavigation();
    document.getElementById('concept-definition-dialog')?.remove();
    const reader = $('.knowledge-reader', special); if (!reader) return;
    knowledgeCardRequest++;
    const dialog = node('section', 'concept-definition'); dialog.id = 'concept-information';
    dialog.setAttribute('aria-labelledby', 'concept-definition-title');
    const header = node('header', 'concept-definition-header'), heading = node('div');
    heading.append(node('div', 'concept-definition-path', (concept.breadcrumb || []).join(' › ')));
    const title = node('h2', '', concept.title); title.id = 'concept-definition-title'; heading.append(title);
    let placement = concept; while (placement) { if (placement.status === 'provisional-placement') { heading.append(node('p', 'concept-placement-notice', 'Частность: размещение в этой ветви предварительное.')); break; } placement = knowledgeGraph?.nodes.find(n=>n.id===placement.parentId); }
    const close = btn('Свернуть', 'concept-definition-close', () => { state.knowledgeSelectedConceptId = null; state.knowledgeSelectedPath = null; rememberNavigation(); reader.replaceChildren(empty('Информация о понятии', 'Выберите термин на карте или в списке.')); }); header.append(heading, close);
    const content = node('div', 'concept-definition-content');
    const definitions = concept.definitions?.length ? concept.definitions : [{ text: concept.definition || concept.summary || 'В подключённых источниках отдельное определение пока не найдено.', sourceTitle: '', version: '', status: 'navigation' }];
    const versionLabel = node('label', 'concept-definition-version', 'Определение или пояснение из источника');
    const versions = document.createElement('select'); versions.setAttribute('aria-label', 'Версия определения');
    definitions.forEach((definition, i) => { const option = document.createElement('option'); option.value = i; option.textContent = [definition.sourceTitle, definition.version].filter(Boolean).join(' · ') || 'Пояснение структуры'; versions.append(option); });
    versionLabel.append(versions); if (definitions.length > 1) content.append(versionLabel);
    const provenance = node('div', 'concept-definition-provenance'), body = node('article', 'concept-definition-body');
    const renderDefinition = () => {
      const definition = definitions[Number(versions.value) || 0];
      provenance.textContent = [definition.sourceTitle, definition.version, definition.status === 'versioned-source' ? 'Версия источника; не подтверждение действующего канона.' : definition.status === 'author-grounded' ? 'Рабочая сверка по авторским уточнениям.' : definition.status === 'supported-source' ? 'Сведения импортированного источника; актуальность проверяется по авторским уточнениям.' : 'Навигационное пояснение.'].filter(Boolean).join(' · ');
      renderSafeMarkdown(body, definition.text, [], reference => showKnowledgeCard(reference, null), reference => resolveAgentReference(reference, reader));
      for (const wiki of body.querySelectorAll('[data-wiki-target]')) {
        const raw = wiki.dataset.wikiTarget, anchor = raw.includes('#') ? raw.slice(raw.indexOf('#')+1) : '';
        const ids = resolveConceptReference({target:raw,label:wiki.textContent,anchor}, knowledgeGraph?.nodes || [], definition.path || '');
        if (!ids.length || ids.length===1 && ids[0]===concept.id) continue;
        const link = btn(wiki.textContent, 'knowledge-inline-link concept-term-link', () => ids.length===1 ? openConcept(ids[0]) : showConceptCandidates(wiki.textContent, ids));
        link.dataset.conceptTarget = ids.join(','); wiki.replaceWith(link);
      }
      const matcher = createConceptMatcher(knowledgeGraph?.nodes || []);
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), texts = [];
      while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('button,a,code,pre')) texts.push(walker.currentNode);
      for (const textNode of texts) {
        const matches = matcher(textNode.textContent, concept.id); if (!matches.length) continue;
        const fragment = document.createDocumentFragment(); let cursor = 0;
        for (const match of matches) {
          fragment.append(document.createTextNode(textNode.textContent.slice(cursor, match.start)));
          const link = btn(match.text, 'knowledge-inline-link concept-term-link', () => match.id ? openConcept(match.id) : showConceptCandidates(match.text, match.ids));
          link.dataset.conceptTarget = match.id || match.ids.join(','); fragment.append(link); cursor = match.end;
        }
        fragment.append(document.createTextNode(textNode.textContent.slice(cursor))); textNode.replaceWith(fragment);
      }
    };
    versions.addEventListener('change', renderDefinition); renderDefinition(); content.append(provenance, body);
    const refs = node('div', 'concept-definition-sources');
    for (const ref of concept.sourceRefs || []) {
      if (ref.path) refs.append(btn('Открыть источник: ' + (ref.title || ref.path), '', () => showKnowledgeCard({ path: ref.path, anchor: ref.anchor }, null)));
      if (ref.url) { const link = node('a', '', 'Google Docs: ' + (ref.title || concept.title)); link.href = ref.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; refs.append(link); }
    }
    if (refs.childNodes.length) content.append(refs);
    const children = (knowledgeGraph?.nodes || []).filter(n => n.parentId === concept.id);
    if (children.length) {
      const particulars = node('section', 'concept-particulars'); particulars.append(node('h3', '', 'Вложенные понятия и примеры'));
      for (const child of children) particulars.append(btn(child.title, 'concept-particular-link', () => openConcept(child.id)));
      content.append(particulars);
    }
    const related = (knowledgeGraph?.edges || []).filter(e => e.kind === 'related' && (e.source === concept.id || e.target === concept.id));
    if (related.length) {
      const section = node('section', 'concept-particulars'); section.append(node('h3', '', 'Связи и упоминания'));
      const seen = new Set();
      for (const edge of related) { const target = edge.source === concept.id ? edge.target : edge.source; if (seen.has(target)) continue; seen.add(target); const term = knowledgeGraph.nodes.find(n=>n.id===target); if (term) { const sourceTerm = knowledgeGraph.nodes.find(n=>n.id===edge.source), targetTerm = knowledgeGraph.nodes.find(n=>n.id===edge.target); const link = btn((sourceTerm?.title || '') + ' — ' + (edge.label || 'Упоминание') + ' → ' + (targetTerm?.title || ''), 'concept-particular-link', () => openConcept(target)); link.title = edge.basis || ''; section.append(link); if (edge.basis?.startsWith('[Отношение] ')) { const evidence = node('details', 'concept-relation-evidence'); evidence.append(node('summary', '', 'Основание связи'), node('p', '', edge.basis.replace('[Отношение] ', ''))); section.append(evidence); } } }
      content.append(section);
    }
    dialog.append(header, content); reader.replaceChildren(dialog);
    if (window.matchMedia('(max-width:1100px)').matches) {
      reader.tabIndex = -1; reader.focus({preventScroll:true}); reader.scrollIntoView({block:'nearest'});
    }
  }
  function showConceptCandidates(label, ids) {
    const reader = $('.knowledge-reader', special); if (!reader) return;
    const panel = node('section', 'concept-definition'); panel.append(node('h2', '', label));
    panel.append(node('p', '', 'В базе есть несколько записей с этим названием. Выберите значение или источник:'));
    for (const id of ids) { const term = knowledgeGraph?.nodes.find(n=>n.id===id); if (!term) continue; const version = term.definitions?.[0]?.version || ''; panel.append(btn([...term.breadcrumb || [],term.title].join(' › ') + (version ? ' · ' + version : ''), 'concept-particular-link', () => openConcept(id))); }
    reader.replaceChildren(panel);
  }
  function openConcept(id) {
    id = knowledgeGraph?.redirects?.[id] || id;
    const concept = knowledgeGraph?.nodes.find(n => n.id === id); if (!concept) return;
    knowledgeMap?.select(id); showConceptDefinition(concept);
  }
  async function showKnowledgeCard(card, buttonNode) {
    if (card.scope === 'active' && state.knowledgeScope !== 'active') { state.knowledgeScope='active'; await showToolPanel('knowledge'); }
    if (!card.anchor && card.target?.includes('#')) card = { ...card, anchor: card.target.slice(card.target.indexOf('#') + 1) };
    if (state.view !== 'knowledge' || !$('.knowledge-reader')) await showToolPanel('knowledge');
    const reader = $('.knowledge-reader', special), results = $('.knowledge-results', special);
    if (!reader) return;
    const cardRequest = ++knowledgeCardRequest;
    // Companion attachments are identified by id; their catalog-relative path must never be restored as an ordinary knowledge path.
    state.knowledgeSelectedPath = card.attachmentId ? null : card.path;
    state.knowledgeSelectedConceptId = null;
    rememberNavigation();
    if (!card.attachmentId) knowledgeMap?.select(card.path);
    if (buttonNode && results) $$('.knowledge-result', results).forEach(x => x.classList.toggle('selected', x === buttonNode));
    reader.replaceChildren(node('div', 'subtle-empty', 'Загружаю карточку…'));
    try {
      const requestedScope=state.knowledgeScope;
      const r = card.attachmentId ? await api('/api/project/attachments/' + encodeURIComponent(card.attachmentId) + '/source') : await api('/api/knowledge/card?path=' + encodeURIComponent(card.path) + (requestedScope==='unassigned'?'&scope=unassigned':''));
      if (cardRequest !== knowledgeCardRequest || !reader.isConnected || state.view!=='knowledge' || state.knowledgeScope!==requestedScope) return;
      const heading = node('header', 'knowledge-card-head'); heading.append(node('h2', '', r.title || card.title || r.path), node('span', 'source-path', friendlyRecordType(r.recordKind || r.record_kind || r.metadata?.record_kind || card.recordKind || card.record_kind || card.metadata?.record_kind || r.type || card.type)));
      const controls = node('div', 'knowledge-controls'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.sources.has(r.path); check.setAttribute('aria-label', 'Добавить источник в контекст агента'); check.addEventListener('change', () => { if (check.checked) state.sources.add(r.path); else state.sources.delete(r.path); renderContextSources(); }); controls.append(check, node('span', '', 'Добавить источник в контекст агента'));
      controls.append(btn('Скопировать в новый локальный черновик', 'button button-quiet', async () => { await create('document'); const copyTitle = (r.title || card.title || 'Новый черновик') + ' — копия'; title.value = copyTitle; text.value = safe(r.body); scheduleSave(); notify('Создан отдельный локальный черновик из открытой карточки.'); }));
      const body = node('article', 'knowledge-markdown'); renderSafeMarkdown(body, r.body, r.links || [], link => showKnowledgeCard(link, null), reference => resolveAgentReference(reference, reader));
      body.querySelectorAll('h1,h2,h3,h4').forEach(h => { h.id = h.textContent.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''); });
      const links = node('details', 'knowledge-links'); const summaryText = node('summary', '', 'Связанные записи (' + (r.links || []).length + ')'); links.append(summaryText);
      (r.links || []).forEach(link => { const row = node('div', 'knowledge-link-row'); if (link.path && link.status !== 'ambiguous') row.append(btn(link.label || link.target, 'text-action', () => showKnowledgeCard(link, null))); else if (link.status === 'ambiguous') row.append(btn((link.label || link.target) + ' · выбрать совпадение', 'text-action', () => resolveAgentReference(link, reader))); else row.append(node('span', '', (link.label || link.target) + ' · ссылка не разрешена')); links.append(row); });
      const backlinks = node('details', 'knowledge-links'); backlinks.append(node('summary', '', 'Упоминания (' + (r.backlinks || []).length + ')'));
      (r.backlinks || []).forEach(back => backlinks.append(btn(back.title || back.path, 'text-action', () => showKnowledgeCard(back, null))));
      const metadata = node('details', 'knowledge-metadata'); metadata.append(node('summary', '', 'Технические сведения'), node('pre', '', JSON.stringify(r.metadata || {}, null, 2)));
      if (state.knowledgeScope==='unassigned') { check.disabled=true; check.checked=false; controls.children[1].textContent='Запись без привязки — просмотр отдельно от контекста выбранной серии'; }
      if (r.readOnly) { check.disabled=true; check.checked=false; controls.children[1].textContent='Связанный файл — только просмотр, в базу знаний и текст книги не добавляется'; }
      reader.replaceChildren(heading, controls, body, links, backlinks, metadata); renderContextSources();
      if (card.anchor) { let anchor = String(card.anchor); try { anchor = decodeURIComponent(anchor); } catch {} const slug = anchor.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''); const targetHeading = [...body.querySelectorAll('h1,h2,h3,h4')].find(h => h.id === anchor || h.id === slug || h.textContent === anchor); targetHeading?.scrollIntoView({ block: 'start' }); }
    } catch (e) { if (cardRequest === knowledgeCardRequest && reader.isConnected && state.view === 'knowledge') reader.replaceChildren(empty('Карточка не открыта', e.message)); }
  }
  async function resolveAgentReference(reference, row) {
    const referenceScope=reference.scope || state.knowledgeScope;
    const holder = node('div', 'message-link-choices', 'Ищу запись базы знаний…'); row.append(holder);
    try {
      const result = await api('/api/knowledge/cards?q=' + encodeURIComponent(reference.target) + (referenceScope==='unassigned'?'&scope=unassigned':''));
      if (state.knowledgeScope!==referenceScope || !holder.isConnected) return;
      const cards = result.cards || [];
      const exact = cards.filter(card => String(card.title || '').trim().toLocaleLowerCase() === reference.target.trim().toLocaleLowerCase());
      if (exact.length === 1 && !result.truncated) { await showKnowledgeCard({ ...exact[0], scope: referenceScope, anchor: reference.anchor, target: reference.target }, null); return; }
      const options = exact.length ? exact : cards;
      holder.replaceChildren(node('span', '', exact.length > 1 || result.truncated ? 'Есть несколько возможных совпадений. Выберите нужное:' : 'Выберите подходящую запись:'));
      if (!options.length) holder.replaceChildren(node('span', '', 'Совпадений в выбранной базе нет.'));
      options.slice(0, 12).forEach(card => holder.append(btn(card.title || card.path, 'text-action', () => { if(state.knowledgeScope===referenceScope) showKnowledgeCard({ ...card, scope: referenceScope, anchor: reference.anchor, target: reference.target }, null); })));
      if (result.truncated) holder.append(node('span', '', 'Список совпадений ограничен.'));
    } catch (e) { holder.replaceChildren(node('span', '', 'Ссылку не удалось разрешить: ' + e.message)); }
  }
  async function proposals() {
    special.replaceChildren();
    const h = heading('ПРОВЕРКА АВТОРА', 'Предложения', 'Каждое изменение можно прочитать целиком до отдельного решения применить его.'); special.append(h);
    const list = node('div', 'proposal-list'), detail = node('section', 'proposal-detail'); special.append(list, detail);
    const load = async () => { try { const r = await api('/api/proposals'); state.proposalIds = (r.proposals || []).map(x => x.id); list.replaceChildren(); if (!r.proposals?.length) list.append(empty('Нет ожидающих предложений', 'Инструменты появятся здесь после подготовки конкретного изменения.')); r.proposals.forEach(p => { const row = node('article', 'proposal-row'); row.append(node('strong', '', p.title || p.path || p.tool || 'Предложение'), node('span', '', [p.state, p.summary, p.createdAt ? date(p.createdAt) : ''].filter(Boolean).join(' · ')), btn('Проверить', 'button button-quiet', () => openProposal(p.id, detail))); list.append(row); }); } catch (e) { list.replaceChildren(empty('Предложения не загружены', e.message)); } };
    h.append(btn('Обновить список', 'button button-quiet', load)); await load();
  }
  function appendQueuedActionPreview(detail, p) {
    const preview = queuedActionPreview(p);
    const section = node('section', 'queued-action-preview');
    section.append(node('h3', '', 'Проверка действия'), node('p', 'proposal-summary', preview.tool || 'Параметры действия'));
    if (preview.kind === 'native') {
      section.append(node('strong', '', 'Целевой файл: ' + preview.target));
      const before = node('details', 'proposal-side'); before.append(node('summary', '', 'Снимок источника до применения'), node('pre', '', typeof preview.before === 'string' ? preview.before : 'Будет создан новый файл.'));
      const after = node('details', 'proposal-side'); after.open = true; after.append(node('summary', '', 'Предлагаемое содержимое'), node('pre', '', preview.after));
      section.append(before, after);
      if (!preview.valid) section.append(node('p', 'action-review-invalid', 'Нельзя применить: нет полного сохранённого снимка native review. Подготовьте новое предложение.'));
    } else if (preview.kind === 'google') {
      section.append(node('p', 'proposal-summary', 'Google Docs · документ ' + safe(preview.documentId) + ' · диапазон ' + String(preview.startIndex ?? '') + '–' + String(preview.endIndex ?? '')));
      section.append(node('h4', '', 'Точная цитата'), node('pre', 'proposal-diff', safe(preview.quote)));
      if (preview.replacement !== undefined) section.append(node('h4', '', 'Предлагаемая замена'), node('pre', 'proposal-diff', safe(preview.replacement)));
      if (preview.comment !== undefined) section.append(node('h4', '', 'Текст комментария'), node('pre', 'proposal-diff', safe(preview.comment)));
    } else if (preview.kind === 'googleDirectEdit') {
      section.append(node('p', 'proposal-summary', `Google Docs · ${safe(preview.documentTitle || preview.documentId)} · вкладка ${safe(preview.tabId)} · позиции ${preview.startIndex}–${preview.endIndex} · ревизия ${safe(preview.revisionId)}`));
      section.append(node('h4', '', 'Фрагмент, который будет заменён'), node('pre', 'proposal-diff', preview.quote));
      section.append(node('h4', '', 'Текст после прямой замены'), node('pre', 'proposal-diff', preview.replacement));
    } else if (preview.kind === 'googleInsert') {
      section.append(node('p', 'proposal-summary', `Google Docs · ${safe(preview.documentTitle || preview.documentId)} · вкладка ${safe(preview.tabId)} · позиция ${preview.index} · ревизия ${safe(preview.revisionId)}`));
      section.append(node('h4', '', 'До вставки'), node('pre', 'proposal-diff', preview.before === '' ? 'Вставленного текста ещё нет.' : preview.before ?? 'Снимок отсутствует'));
      section.append(node('h4', '', 'После вставки'), node('pre', 'proposal-diff', preview.after));
      if (preview.anchor) section.append(node('h4', '', 'Контекст вокруг точки вставки'), node('p', 'proposal-summary', `До точки: ${preview.anchor.before || 'начало контекста'} · после точки: ${preview.anchor.after || 'конец контекста'}`));
    } else if (preview.kind === 'googleCreateNote') {
      section.append(node('p', 'proposal-summary', `Новый документ Google Docs · ${safe(preview.title)}`));
      if (preview.sourceUrl || preview.sourceTabOrRange || preview.sourceRevision) section.append(node('p', 'proposal-summary', `Источник: ${safe(preview.sourceUrl || '')} ${safe(preview.sourceTabOrRange || '')} · ревизия ${safe(preview.sourceRevision || '')}`));
      if (preview.quote) section.append(node('h4', '', 'Цитата источника'), node('pre', 'proposal-diff', preview.quote));
      section.append(node('h4', '', 'Документ до создания'), node('pre', 'proposal-diff', 'Документ ещё не существует.'));
      section.append(node('h4', '', 'Содержимое нового документа'), node('pre', 'proposal-diff', preview.after));
    } else if (preview.kind === 'googleReply') {
      section.append(node('p', 'proposal-summary', `Google Docs · ${safe(preview.documentTitle || preview.documentId)} · ветка ${safe(preview.commentId)} · хеш комментария ${safe(preview.commentHash)}`));
      section.append(node('h4', '', 'Комментарий, на который отвечают'), node('pre', 'proposal-diff', preview.commentText));
      section.append(node('h4', '', 'Текущее состояние ветки'), node('pre', 'proposal-diff', preview.before ?? preview.commentText));
      section.append(node('h4', '', 'Текст ответа в ветке'), node('pre', 'proposal-diff', preview.after));
    } else if (preview.kind === 'googleSheet') {
      section.append(node('p', 'proposal-summary', `Google Sheets · таблица ${safe(preview.spreadsheetId)} · диапазон ${safe(preview.range)}`));
      const table = (label, rows) => {
        section.append(node('h4', '', label));
        const wrapper = node('div', 'sheet-change-table-wrap');
        const grid = node('table', 'sheet-change-table');
        const body = node('tbody');
        rows.forEach((row, rowIndex) => {
          const tr = node('tr');
          row.forEach((value, colIndex) => {
            const cell = node('td', '', value === null || value === undefined ? '' : String(value));
            cell.setAttribute('aria-label', `Строка ${rowIndex + 1}, столбец ${colIndex + 1}`);
            tr.append(cell);
          });
          body.append(tr);
        });
        grid.append(body); wrapper.append(grid); section.append(wrapper);
      };
      if (Array.isArray(preview.beforeValues)) table('До изменения', preview.beforeValues);
      if (Array.isArray(preview.values)) table('После изменения', preview.values);
      section.append(node('p', 'proposal-summary', `Хеш снимка до изменения: ${safe(preview.beforeHash || 'не передан')} · ID операции: ${safe(preview.operationId || 'не передан')}`));
      if (!preview.valid) section.append(node('p', 'action-review-invalid', 'Нельзя применить: нет одинаковых непустых таблиц значений до и после, диапазона, хеша снимка или ID операции.'));
    }
    if (['googleDirectEdit', 'googleInsert', 'googleCreateNote', 'googleReply'].includes(preview.kind) && !preview.valid) section.append(node('p', 'action-review-invalid', 'Применение заблокировано: данные действия не совпадают с проверенным сервером снимком до и после. Запросите новое предложение.'));
    const args = node('details', 'knowledge-metadata'); args.append(node('summary', '', 'Полные технические параметры'), node('pre', '', JSON.stringify(preview.arguments, null, 2)));
    section.append(args); detail.append(section);
    return preview;
  }
  async function openProposal(idValue, detail) {
    detail.replaceChildren(node('div', 'subtle-empty', 'Загружаю предложение…'));
    try { const response = await api('/api/proposals/' + encodeURIComponent(idValue)), p = unwrapProposalResponse(response); detail.replaceChildren(node('h2', '', p.title || p.path || 'Предложение'), node('p', 'proposal-summary', p.summary || ''));
      const path = p.path ? node('div', 'source-path', p.path) : null; if (path) detail.append(path);
      const preview = p.tool ? appendQueuedActionPreview(detail, p) : null;
      const reviewedGoogleKinds = ['googleDirectEdit', 'googleInsert', 'googleCreateNote', 'googleReply'];
      if (p.diff && !reviewedGoogleKinds.includes(preview?.kind)) { detail.append(node('h3', '', 'Изменения'), node('pre', 'proposal-diff', p.diff)); }
      if (!p.tool) { const before = node('details', 'proposal-side'); before.append(node('summary', '', 'До изменения'), node('pre', '', typeof p.before === 'string' ? p.before : 'Новый файл')); const after = node('details', 'proposal-side'); after.open = true; after.append(node('summary', '', 'После изменения'), node('pre', '', safe(p.after))); detail.append(before, after); }
      if (p.state === 'pending') { const reject = btn('Отклонить', 'button button-quiet', async () => { try { await api('/api/proposals/' + encodeURIComponent(p.id) + '/reject', { method: 'POST', body: {} }); await proposals(); notify('Предложение отклонено.'); } catch (e) { notify(e.message, true); } }); const approvalLabel = queuedActionApprovalLabel(preview?.kind); const apply = btn(approvalLabel, 'button button-primary', async () => { if (preview && !preview.valid) return notify('Нельзя применить без полного снимка изменений.', true); const target = preview?.kind === 'googleCreateNote' ? preview.title : preview?.kind === 'googleReply' ? preview.commentId : preview?.documentTitle || preview?.documentId || preview?.target || p.path || p.title || p.tool; if (await ask('Подтвердите конкретное действие', `Будет выполнено: ${approvalLabel} · ${target}. Сверьте показанные данные до и после. Продолжить?`, approvalLabel) !== 'confirm') return; try { await api('/api/proposals/' + encodeURIComponent(p.id) + '/apply', { method: 'POST', body: { confirmed: true } }); notify('Предложение применено.'); await loadLists(); await loadOverview(); await proposals(); } catch (e) { notify(e.message, true); } }); if (preview && !preview.valid) apply.disabled = true; const actions = node('div', 'proposal-actions'); actions.append(reject, apply); detail.append(actions); }
    } catch (e) { detail.replaceChildren(empty('Предложение не открыто', e.message)); }
  }
  function renderContextSources() { $('#chat-context-label').textContent = state.selectedText ? 'Выделение · ' + state.selectedText.length + ' зн.' : state.sources.size ? state.sources.size + ' источн.' : 'Контекст не выбран'; const box = $('#selected-sources'); if (!box) return; box.replaceChildren(); if (!state.sources.size) { box.append(node('div', 'subtle-empty', 'Источники не выбраны')); return; } state.sources.forEach(path => { const row = node('label', 'source-chip'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.addEventListener('change', () => { state.sources.delete(path); renderContextSources(); }); row.append(check, node('span', '', path)); box.append(row); }); }
  function renderContextNotes() { const box = $('#context-notes'); if (!box) return; box.replaceChildren(); const active = state.catalog?.active || {}; const notes = state.notes.filter(n => n.seriesId && n.seriesId === active.seriesId && (!n.bookId || n.bookId === active.bookId)); if (!notes.length) { box.append(node('div', 'subtle-empty', 'Заметок выбранной книги пока нет')); return; } notes.slice(0, 4).forEach(n => { const row = node('div', 'note-context-card'); row.append(node('span', '', (n.title || 'Без названия') + ': ' + safe(n.text).slice(0, 100)), node('small', '', n.documentId ? 'Связана с черновиком' : 'Отдельная заметка')); box.append(row); }); }
  function createGoogleAgentConnection() {
    const section = node('section', 'google-setup google-agent-setup');
    section.setAttribute('aria-labelledby', 'google-agent-heading');
    const title = node('h2', '', 'Подключение Google для агента'); title.id = 'google-agent-heading';
    section.append(title, node('p', '', 'Используется отдельный OAuth client для агентского доступа. Подключение Google Docs для сайта не авторизует агента.'));
    const status = node('div', 'google-status-note', 'Проверяю отдельное подключение агента…');
    status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Статус подключения агента к Google');
    const sheetsStatus = node('p', 'google-agent-sheets-status', 'Статус доступа к таблицам будет показан после проверки подключения.');
    const sheetsLogin = btn('Разрешить доступ к Google Sheets', 'button button-quiet', () => googleAgentLogin(connection, true)); sheetsLogin.classList.add('hidden');
    const driveReplyStatus = node('p', 'google-agent-drive-reply-status', 'Статус доступа к ответам в комментариях будет показан после проверки подключения.');
    const driveReplyLogin = btn('Разрешить ответы в комментариях Google Docs', 'button button-quiet', () => googleAgentLogin(connection, { includeDriveFile: true })); driveReplyLogin.classList.add('hidden');
    const setup = node('div', 'google-agent-credentials hidden');
    setup.append(node('p', '', 'Введите OAuth client ID и secret, созданные отдельно для агента. Secret будет очищен после сохранения или ошибки.'));
    const redirectLabel = node('label', 'google-setup-field', 'URI перенаправления агента');
    const redirectInput = document.createElement('input'); redirectInput.type = 'text'; redirectInput.readOnly = true; redirectInput.setAttribute('aria-label', 'URI перенаправления OAuth агента');
    const copyRedirect = btn('Копировать URI', 'button button-quiet', async () => { try { await navigator.clipboard.writeText(redirectInput.value); notify('URI перенаправления агента скопирован.'); } catch { redirectInput.focus(); redirectInput.select(); notify('Выделите URI и скопируйте его вручную.'); } });
    redirectLabel.append(redirectInput, copyRedirect);
    const clientLabel = node('label', 'google-setup-field', 'OAuth client ID агента');
    const clientInput = document.createElement('input'); clientInput.type = 'text'; clientInput.autocomplete = 'off'; clientInput.spellcheck = false; clientInput.setAttribute('aria-label', 'Google OAuth agent client ID'); clientLabel.append(clientInput); setup.append(clientLabel);
    const secretLabel = node('label', 'google-setup-field', 'OAuth client secret агента');
    const secretInput = document.createElement('input'); secretInput.type = 'password'; secretInput.autocomplete = 'new-password'; secretInput.setAttribute('aria-label', 'Google OAuth agent client secret'); secretLabel.append(secretInput); setup.append(secretLabel);
    const save = btn('Сохранить настройки агента', 'button button-primary', async () => {
      if (!clientInput.value.trim() || !secretInput.value) return notify('Укажите OAuth client ID агента и его client secret.', true);
      save.disabled = true;
      try {
        await api(GOOGLE_AGENT_API_PREFIX + '/configure', { method: 'POST', body: { clientId: clientInput.value.trim(), clientSecret: secretInput.value } });
        secretInput.value = ''; await refreshGoogleAgentStatus(connection); notify('Настройки отдельного OAuth client агента сохранены.');
      } catch { secretInput.value = ''; notify('Не удалось сохранить настройки OAuth агента.', true); save.disabled = false; }
    });
    setup.append(save);
    const controls = node('div', 'google-toolbar');
    const login = btn('Подключить агента к Google', 'button button-primary', () => googleAgentLogin(connection)); login.disabled = true;
    const disconnect = btn('Отключить агента', 'button button-quiet', () => googleAgentDisconnect(connection)); disconnect.classList.add('hidden');
    const refresh = btn('Обновить статус агента', 'button button-quiet', () => refreshGoogleAgentStatus(connection));
    controls.append(login, disconnect, sheetsLogin, driveReplyLogin, refresh);
    section.append(redirectLabel, status, sheetsStatus, driveReplyStatus, setup, controls);
    const connection = { status, sheetsStatus, sheetsLogin, driveReplyStatus, driveReplyLogin, setup, redirectInput, clientInput, secretInput, save, login, disconnect };
    refreshGoogleAgentStatus(connection);
    return section;
  }
  async function refreshGoogleAgentStatus(connection) {
    try {
      const s = await api(GOOGLE_AGENT_API_PREFIX + '/status');
      connection.redirectInput.value = safe(s.redirectUri);
      const configured = s.configured === true && s.requiresClientConfiguration !== true;
      connection.setup.classList.toggle('hidden', configured);
      connection.status.textContent = googleAgentStatusText(s);
      connection.sheetsLogin.classList.toggle('hidden', s.authenticated !== true || s.canWriteSheets === true);
      connection.driveReplyLogin.classList.toggle('hidden', s.authenticated !== true || s.canReply === true);
      if (s.authenticated !== true) connection.sheetsStatus.textContent = 'Подключение к Google Sheets агенту не подтверждено, поэтому операции с таблицами недоступны.';
      else if (s.canWriteSheets === true) connection.sheetsStatus.textContent = s.canReadSheets === true ? 'Чтение и запись таблиц подтверждены.' : 'Запись таблиц подтверждена; чтение не сообщено.';
      else if (s.canReadSheets === true) connection.sheetsStatus.textContent = 'Чтение таблиц доступно. Для записи связанного индекса нужно отдельно разрешить Google Sheets.';
      else connection.sheetsStatus.textContent = 'Навык может описывать работу с таблицами, но подключение Google Sheets не подтверждено. Для связанного индекса требуется отдельное разрешение.';
      if (s.authenticated !== true) connection.driveReplyStatus.textContent = 'Подключение к Google не подтверждено; доступ для ответа в комментариях не проверен.';
      else if (s.canReply === true) connection.driveReplyStatus.textContent = 'Доступ к ответам в существующих комментариях Google Docs подтверждён.';
      else connection.driveReplyStatus.textContent = 'Доступ для ответа в существующих комментариях Google Docs не подтверждён. Разрешение можно запросить отдельно кнопкой ниже.';
      connection.login.disabled = !configured;
      connection.login.classList.toggle('hidden', s.authenticated === true);
      connection.disconnect.classList.toggle('hidden', s.authenticated !== true);
      connection.save.disabled = false;
      if (!s.authenticated && googleAgentLoginUrl) appendGoogleAgentLoginLink(connection.status, googleAgentLoginUrl);
    } catch (e) {
      connection.status.textContent = 'Статус отдельного подключения агента недоступен: ' + e.message;
      connection.login.disabled = true;
      connection.disconnect.classList.add('hidden');
      connection.sheetsLogin.classList.add('hidden');
      connection.sheetsStatus.textContent = 'Не удалось проверить, разрешён ли доступ агента к Google Sheets.';
      connection.driveReplyLogin.classList.add('hidden');
      connection.driveReplyStatus.textContent = 'Не удалось проверить доступ агента для ответов в комментариях Google Docs.';
      connection.setup.classList.add('hidden');
    }
  }
  function appendGoogleAgentLoginLink(status, url) {
    const link = node('a', 'google-native-link', 'Открыть страницу отдельного входа агента в Google');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    status.append(document.createElement('br'), link);
  }
  async function googleAgentLogin(connection, options = false) {
    const includeSheets = options === true || options?.includeSheets === true;
    const includeDriveFile = typeof options === 'object' && options?.includeDriveFile === true;
    const popup = window.open('about:blank', '_blank');
    try {
      const body = {};
      if (includeSheets) body.includeSheets = true;
      if (includeDriveFile) body.includeDriveFile = true;
      const r = await api(GOOGLE_AGENT_API_PREFIX + '/login', { method: 'POST', body });
      if (!r.authUrl) throw Error('Сервер не вернул ссылку авторизации агента.');
      googleAgentLoginUrl = r.authUrl;
      const purpose = includeDriveFile ? 'Разрешите доступ для ответа в существующих комментариях Google Docs' : includeSheets ? 'Разрешите доступ к Google Sheets' : 'Завершите отдельный вход агента в Google';
      if (popup) { popup.opener = null; popup.location.replace(r.authUrl); notify(`${purpose} в новой вкладке, затем обновите статус. Разрешение появится только после подтверждения Google и проверки статуса.`); }
      else { appendGoogleAgentLoginLink(connection.status, r.authUrl); notify('Браузер заблокировал всплывающее окно. Откройте отдельную ссылку входа агента в панели Google Docs.'); }
    } catch (e) { popup?.close(); notify(e.message, true); }
  }
  async function googleAgentDisconnect(connection) {
    if (await ask('Отключить агента от Google?', 'Это отключит только отдельную авторизацию агента.') !== 'confirm') return;
    try { await api(GOOGLE_AGENT_API_PREFIX + '/disconnect', { method: 'POST', body: {} }); await refreshGoogleAgentStatus(connection); notify('Агент Google отключён.'); }
    catch (e) { notify(e.message, true); }
  }
  function renderGoogle() {
    if (state.googleNativeOpen) return;
    const surface = state.googleViewSurface;
    if (surface === 'main' ? state.mainRoute !== 'google' : state.view !== 'google') return;
    const lifecycle = surface === 'main' ? mainGoogleLifecycle : toolGoogleLifecycle;
    state.googleViewRequest = { surface, token: lifecycle.beginView('google') };
    lifecycle.replaceView(special, 'google');
    special.append(heading('GOOGLE WORKSPACE', 'Google Docs', 'Чтение документа и точные нативные предложения или комментарии к выделению.'));
    const status = node('div', 'google-status-note', 'Проверяю подключение…');
    const setup = node('section', 'google-setup hidden');
    setup.append(node('h2', '', 'Настройка Google OAuth'), node('p', '', 'Создайте OAuth client типа «Веб-приложение» в Google Cloud Console. Добавьте показанный URI в список разрешённых URI перенаправления и внесите данные здесь. Секрет сохраняется только в защищённой конфигурации локального сервера.'));
    const consoleLink = node('a', 'google-native-link', 'Открыть Google Cloud Console'); consoleLink.href = 'https://console.cloud.google.com/apis/credentials'; consoleLink.target = '_blank'; consoleLink.rel = 'noopener noreferrer'; setup.append(consoleLink);
    const redirectLabel = node('label', 'google-setup-field', 'URI перенаправления');
    const redirectInput = document.createElement('input'); redirectInput.type = 'text'; redirectInput.readOnly = true; redirectInput.value = ''; redirectInput.setAttribute('aria-label', 'URI перенаправления OAuth');
    const copyRedirect = btn('Копировать URI', 'button button-quiet', async () => { try { await navigator.clipboard.writeText(redirectInput.value); notify('URI перенаправления скопирован.'); } catch { redirectInput.focus(); redirectInput.select(); notify('Выделите URI и скопируйте его вручную.'); } });
    redirectLabel.append(redirectInput, copyRedirect); setup.append(redirectLabel);
    const clientLabel = node('label', 'google-setup-field', 'Client ID'); const clientInput = document.createElement('input'); clientInput.type = 'text'; clientInput.autocomplete = 'off'; clientInput.spellcheck = false; clientInput.setAttribute('aria-label', 'Google OAuth client ID'); clientLabel.append(clientInput); setup.append(clientLabel);
    const secretLabel = node('label', 'google-setup-field', 'Client secret'); const secretInput = document.createElement('input'); secretInput.type = 'password'; secretInput.autocomplete = 'new-password'; secretInput.setAttribute('aria-label', 'Google OAuth client secret'); secretLabel.append(secretInput); setup.append(secretLabel);
    const saveConfig = btn('Сохранить настройки', 'button button-primary', async () => {
      if (!clientInput.value.trim() || !secretInput.value) return notify('Укажите Client ID и Client secret из Google Cloud Console.', true);
      saveConfig.disabled = true;
      try { await api('/api/google/configure', { method: 'POST', body: { clientId: clientInput.value.trim(), clientSecret: secretInput.value } }); secretInput.value = ''; await showToolPanel('google'); notify('OAuth настройки сохранены локально. Теперь подключите Google Docs.'); }
      catch (e) { secretInput.value = ''; notify('Не удалось сохранить OAuth настройки: ' + e.message, true); saveConfig.disabled = false; }
    });
    setup.append(saveConfig); special.append(status, setup, createGoogleAgentConnection());
    const workspaceNodes = [];
    const pending = node('div', 'google-pending');
    workspaceNodes.push(pending);
    if (state.googleDoc?.documentId) {
      const docLink = node('a', 'google-native-link', 'Открыть оригинал в Google Docs');
      docLink.href = 'https://docs.google.com/document/d/' + encodeURIComponent(state.googleDoc.documentId) + '/edit';
      docLink.target = '_blank'; docLink.rel = 'noopener noreferrer'; pending.append(docLink);
    }
    const operations = Array.isArray(state.googleDoc?.pendingOperations) ? state.googleDoc.pendingOperations : [];
    const localUncertain = state.googleDoc?.documentId && state.googleUncertain.get(state.googleDoc.documentId);
    if (operations.length || localUncertain) {
      pending.append(node('strong', '', 'Операция требует сверки в оригинале. Новые изменения заблокированы.'));
      operations.forEach(operation => {
        const row = node('div', 'google-pending-operation');
        row.append(node('span', '', 'ID ' + safe(operation.operationId) + ' · ' + safe(operation.state) + (operation.phase ? ' · ' + safe(operation.phase) : '')));
        if (operation.active === true) {
          row.append(node('span', '', 'Дождитесь завершения, затем обновите состояние.'));
          row.append(btn('Обновить состояние', 'button button-quiet', () => readGoogle(state.googleDoc.documentId)));
        } else {
          row.append(btn('Я проверил результат в Google Docs', 'button button-primary', () => reconcileGoogle(state.googleDoc.documentId, operation.operationId)));
        }
        pending.append(row);
      });
      if (localUncertain && !operations.some(x => x.operationId === localUncertain.operationId)) {
        const row = node('div', 'google-pending-operation');
        row.append(node('span', '', 'ID ' + localUncertain.operationId + ' · состояние ещё не подтверждено'));
        row.append(btn('Обновить состояние', 'button button-quiet', () => readGoogle(state.googleDoc.documentId)));
        pending.append(row);
      }
    }
    if (pending.childNodes.length) special.append(pending);
    const connect = node('div', 'google-toolbar'); const login = btn('Подключить Google', 'button button-primary', googleLogin), disconnect = btn('Отключить', 'button button-quiet', googleDisconnect), refresh = btn('Обновить статус', 'button button-quiet', () => refreshGoogleStatus(status, setup, workspaceNodes, redirectInput, login, disconnect, loadDocuments)); connect.append(login, disconnect, refresh); special.append(connect); workspaceNodes.push(connect);
    const picker = node('section', 'google-picker');
    const pickerHeading = node('h2', '', 'Ваши документы Google Docs');
    const searchRow = node('div', 'google-toolbar'), search = document.createElement('input'); search.type = 'search'; search.maxLength = 100; search.placeholder = 'Найти документ по названию'; search.setAttribute('aria-label', 'Поиск документов Google Docs'); search.value = state.googlePickerQuery;
    const pickerStatus = node('p', 'google-status-note', 'Документы появятся после подключения Google.');
    const pickerList = node('div', 'google-picker-list');
    const more = btn('Показать ещё', 'button button-quiet', () => loadDocuments(state.googlePickerQuery, state.googlePickerNextPageToken, true)); more.hidden = true;
    const loadDocuments = async (query = '', pageToken = '', append = false) => {
      const request = (state.googlePickerRequest ?? 0) + 1; state.googlePickerRequest = request;
      state.googlePickerQuery = query;
      if (!append) { state.googlePickerNextPageToken = ''; more.hidden = true; }
      pickerStatus.textContent = 'Загружаю список документов…';
      more.disabled = true;
      try {
        const params = new URLSearchParams({ q: query });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await api('/api/google/documents?' + params.toString());
        if (request !== state.googlePickerRequest) return;
        const files = Array.isArray(page.files) ? page.files : [];
        state.googlePickerFiles = append ? [...state.googlePickerFiles, ...files] : files;
        state.googlePickerNextPageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : '';
        pickerList.replaceChildren();
        if (!state.googlePickerFiles.length) pickerList.append(node('p', 'google-status-note', 'Документы не найдены.'));
        state.googlePickerFiles.forEach(file => {
          const row = node('div', 'google-picker-row');
          const title = btn(file.title || 'Документ без названия', 'google-picker-document', () => openGoogleInEditor(file.id));
          const modified = file.modifiedTime ? new Date(file.modifiedTime) : null;
          row.append(title);
          if (modified && !Number.isNaN(modified.getTime())) row.append(node('span', 'google-picker-date', modified.toLocaleDateString()));
          pickerList.append(row);
        });
        pickerStatus.textContent = state.googlePickerFiles.length ? `Показано документов: ${state.googlePickerFiles.length}` : 'Документы не найдены.';
        more.hidden = !state.googlePickerNextPageToken;
      } catch (e) {
        if (request === state.googlePickerRequest) pickerStatus.textContent = e.message;
      } finally {
        if (request === state.googlePickerRequest) more.disabled = false;
      }
    };
    const searchDocuments = () => loadDocuments(search.value.trim());
    searchRow.append(search, btn('Найти', 'button button-quiet', searchDocuments));
    search.addEventListener('keydown', event => { if (event.key === 'Enter') searchDocuments(); });
    picker.append(pickerHeading, searchRow, pickerStatus, pickerList, more); special.append(picker); workspaceNodes.push(picker);
    const idRow = node('div', 'google-toolbar'), input = document.createElement('input'); input.placeholder = 'Или укажите ID документа вручную'; input.setAttribute('aria-label', 'ID документа Google Docs'); idRow.append(input, btn('Загрузить по ID', 'button button-quiet', () => openGoogleInEditor(input.value.trim()))); special.append(idRow); workspaceNodes.push(idRow);
    const docTitle = node('h2', 'google-title', ''), tabs = node('div', 'google-tabs'), meta = node('div', 'google-doc-meta', 'Документ не загружен'), area = document.createElement('textarea'); area.className = 'google-text'; area.readOnly = true; area.placeholder = 'Текст вкладки появится здесь.'; area.setAttribute('aria-label', 'Текст Google Docs, только чтение'); const range = node('div', 'google-doc-meta', 'Выделите непрерывный фрагмент.'); special.append(docTitle, tabs, meta, area, range); workspaceNodes.push(docTitle, tabs, meta, area, range);
    const actions = node('div', 'google-actions'), replacement = document.createElement('input'), commentText = document.createElement('input'); replacement.placeholder = 'Предлагаемый текст'; commentText.placeholder = 'Текст комментария'; replacement.setAttribute('aria-label', 'Предлагаемая замена'); commentText.setAttribute('aria-label', 'Текст комментария');
    const suggestButton = btn('Предложить замену', 'button button-primary', () => googleOperation('suggest', area, replacement.value, ''));
    const commentButton = btn('Комментарий', 'button button-quiet', () => googleOperation('comment', area, '', commentText.value));
    actions.append(replacement, suggestButton, commentText, commentButton); special.append(actions); workspaceNodes.push(actions);
    area.addEventListener('select', () => { range.textContent = area.selectionEnd > area.selectionStart ? 'Выделено ' + (area.selectionEnd - area.selectionStart) + ' символов · цитата будет проверена по версии и UTF-16 диапазону' : 'Выделите непрерывный фрагмент.'; });
    refreshGoogleStatus(status, setup, workspaceNodes, redirectInput, login, disconnect, loadDocuments);
    if (state.googleDoc) { input.value = state.googleDoc.documentId; docTitle.textContent = state.googleDoc.title || 'Документ Google Docs'; meta.textContent = 'Версия ' + (state.googleDoc.revisionId || 'не указана'); (state.googleDoc.tabs || []).forEach(t => { const b = btn(t.title || t.tabId, 'google-tab' + (state.googleTab?.tabId === t.tabId ? ' selected' : ''), () => { state.googleTab = t; rememberNavigation(); area.value = t.text; meta.textContent = (t.title || 'Вкладка') + ' · версия ' + (state.googleDoc.revisionId || 'не указана'); $$('.google-tab', tabs).forEach(x => x.classList.toggle('selected', x === b)); }); tabs.append(b); }); if (state.googleTab) area.value = state.googleTab.text; }
    const blocked = !!operations.length || !!localUncertain;
    replacement.disabled = commentText.disabled = suggestButton.disabled = commentButton.disabled = blocked;
    if (blocked) status.textContent = 'Есть незавершённая Google Docs операция. Проверьте её в оригинале перед новыми изменениями.';
  }
  async function refreshGoogleStatus(status, setup, workspaceNodes, redirectInput, login, disconnect, loadDocuments) {
    try {
      const s = await api('/api/google/status'); redirectInput.value = s.redirectUri || '';
      const needsSetup = s.requiresClientConfiguration === true; setup.classList.toggle('hidden', !needsSetup); workspaceNodes.forEach(el => el.classList.toggle('hidden', needsSetup));
      if (needsSetup) status.textContent = 'Сначала настройте OAuth client. Документы пока не подключены.';
      else if (s.configured === false) { status.textContent = googleUnconfiguredText(s.reason); login.disabled = true; }
      else if (s.authenticated) { status.textContent = 'Google Docs подключён. Здесь можно читать документ; правки агента появятся в «Предложениях» для проверки и применения.'; login.classList.add('hidden'); googleLoginUrl = ''; await loadDocuments?.(state.googlePickerQuery); }
      else { status.textContent = 'Google Docs не подключён. Авторизация откроется отдельно.'; login.disabled = false; login.classList.remove('hidden'); }
      disconnect.classList.toggle('hidden', !s.authenticated);
      if (!s.authenticated && googleLoginUrl) { const link = node('a', 'google-native-link', 'Открыть страницу входа Google'); link.href = googleLoginUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; status.append(document.createElement('br'), link); }
    } catch (e) { status.textContent = 'Подключение недоступно: ' + e.message; }
  }
  async function googleLogin() {
    const popup = window.open('about:blank', '_blank');
    try {
      const r = await api('/api/google/login', { method: 'POST', body: {} }); if (!r.authUrl) throw Error('Сервер не вернул ссылку авторизации.');
      googleLoginUrl = r.authUrl;
      if (popup) { popup.opener = null; popup.location.replace(r.authUrl); }
      else { const note = $('.google-status-note', special); if (note) { const link = node('a', 'google-native-link', 'Открыть страницу входа Google'); link.href = r.authUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; note.append(document.createElement('br'), link); } notify('Браузер заблокировал всплывающее окно. Откройте ссылку в панели Google Docs.'); }
      if (popup) notify('Завершите вход Google в новой вкладке, затем обновите статус подключения.');
    } catch (e) { popup?.close(); notify(e.message, true); }
  }
  async function googleDisconnect() { if (await ask('Отключить Google Docs?', 'Документы и локальные черновики не удаляются.') !== 'confirm') return; try { await api('/api/google/disconnect', { method: 'POST', body: {} }); state.googleDoc = null; state.googleTab = null; renderGoogle(); notify('Google Docs отключён.'); } catch (e) { notify(e.message, true); } }
  async function openGoogleInEditor(documentId) {
    stash();
    const doc = await readGoogle(documentId, true, true);
    if (!doc) return;
    showGoogleNativeEditor(doc);
  }
  function showGoogleNativeEditor(doc) {
    let surface;
    try { surface = createGoogleNativeEditor({ document, googleDocument: doc, onBack: () => switchView('documents') }); }
    catch { notify('Не удалось открыть редактор Google Docs: некорректный ID документа.', true); return false; }
    openController.invalidate();
    closeWorkspace(); restorePortal();
    state.googleNativeOpen = true;
    state.googleDoc = doc; state.googleTab = null;
    state.view = state.mainRoute = 'documents'; state.googleViewSurface = 'main';
    toolGoogleLifecycle.beginView('closed');
    mainGoogleLifecycle.beginView('documents');
    state.googleViewRequest = null;
    special.classList.add('hidden'); editor.classList.add('hidden');
    $('.app-shell').classList.remove('primary-workspace-view');
    $('.app-shell').classList.add('google-native-workspace');
    $('#google-native-host').replaceChildren(surface);
    $('#google-native-host').classList.remove('hidden');
    $('#crumb-title').textContent = doc.title || 'Google Docs';
    navState(); mobilePane('editor');
    $('#crumb-area').textContent = 'Книга';
    if (state.sidebarOpen) toggleSidebar(false);
    return true;
  }
  async function readGoogle(documentId, quiet = false, showErrors = !quiet) {
    if (!documentId) { if (showErrors) notify('Введите ID документа Google Docs.', true); return null; }
    const viewRequest = state.googleViewRequest;
    const readRequest = (state.googleReadRequest ?? 0) + 1; state.googleReadRequest = readRequest;
    const isCurrentRead = () => {
      if (!viewRequest || state.googleViewSurface !== viewRequest.surface || readRequest !== state.googleReadRequest) return false;
      const main = viewRequest.surface === 'main';
      return (main ? state.mainRoute : state.view) === 'google' && (main ? mainGoogleLifecycle : toolGoogleLifecycle).isCurrentView(viewRequest.token, 'google');
    };
    try {
      const r = await api('/api/google/read', { method: 'POST', body: { documentId } });
      if (!isCurrentRead()) return null;
      state.googleDoc = r.document; state.googleTab = state.googleDoc.tabs?.[0] || null;
      if (Array.isArray(state.googleDoc.pendingOperations)) {
        const pendingIds = new Set(state.googleDoc.pendingOperations.map(x => x.operationId));
        for (const [fingerprint, attempt] of state.googleAttempts)
          if (attempt.documentId === documentId && !pendingIds.has(attempt.operationId)) state.googleAttempts.delete(fingerprint);
        const uncertain = state.googleUncertain.get(documentId);
        if (!uncertain || !pendingIds.has(uncertain.operationId)) state.googleUncertain.delete(documentId);
      }
      renderGoogle(); if (!quiet) notify('Документ загружен. Правки можно подготовить с агентом.');
      rememberNavigation();
      return state.googleDoc;
    } catch (e) { if (isCurrentRead() && showErrors) notify(e.message, true); return null; }
  }
  function mapRange(tab, start, end) {
    if (!tab || end <= start || !Array.isArray(tab.segments)) return null;
    if (tab.segments.map(x => safe(x.text)).join('') !== safe(tab.text)) return null;
    let offset = 0, from = null, to = null, covered = start;
    for (const segment of tab.segments) { const s = safe(segment.text), a = Math.max(0, start - offset), b = Math.min(s.length, end - offset); if (b > a) { const gs = Number(segment.startIndex) + a, ge = Number(segment.startIndex) + b; if (!Number.isFinite(gs) || !Number.isFinite(ge)) return null; if (from === null) from = gs; else if (gs !== to) return null; if (offset + a !== covered) return null; covered = offset + b; to = ge; } offset += s.length; }
    if (covered !== end || from === null) return null; return { startIndex: from, endIndex: to, quote: tab.text.slice(start, end) };
  }
  async function googleOperation(type, area, replacement, comment) {
    const doc = state.googleDoc, tab = state.googleTab, range = mapRange(tab, area.selectionStart, area.selectionEnd);
    if (!doc || !tab) return notify('Сначала загрузите вкладку документа.', true);
    if (googleWritesBlocked(doc)) return notify('Сначала сверьте незавершённую операцию в оригинале Google Docs.', true);
    if (!range) return notify('Выделение нельзя точно сопоставить с индексами Google Docs. Операция остановлена; документ не изменён.', true);
    if (type === 'suggest' && !replacement || type === 'comment' && !comment) return notify('Заполните поле операции.', true);
    const copy = 'Будет отправлена операция для точной цитаты: «' + range.quote.slice(0, 180) + (range.quote.length > 180 ? '…' : '') + '». Сервер сверит версию и UTF-16 диапазон.';
    if (await ask(type === 'suggest' ? 'Отправить предложение в Google Docs?' : 'Добавить комментарий к фрагменту?', copy) !== 'confirm') return;
    if (state.googleDoc !== doc || state.googleTab !== tab || googleWritesBlocked(doc)) return notify('Состояние документа изменилось. Загрузите его и повторите проверку.', true);
    const fingerprint = JSON.stringify([doc.documentId, tab.tabId, type, range.startIndex, range.endIndex, range.quote, replacement, comment]);
    let attempt = state.googleAttempts.get(fingerprint);
    if (!attempt) {
      const body = { documentId: doc.documentId, tabId: tab.tabId, revisionId: doc.revisionId, ...range, operationId: id() };
      if (type === 'suggest') body.replacement = replacement; else body.text = comment;
      attempt = { documentId: doc.documentId, operationId: body.operationId, body, inFlight: false };
      state.googleAttempts.set(fingerprint, attempt);
    }
    if (attempt.inFlight) return;
    attempt.inFlight = true;
    state.googleUncertain.set(doc.documentId, attempt);
    $$('.google-actions input, .google-actions button').forEach(control => { control.disabled = true; });
    try {
      await api('/api/google/' + type, { method: 'POST', body: attempt.body });
      attempt.inFlight = false; state.googleUncertain.set(doc.documentId, attempt);
      notify('Операция принята. Проверьте результат в оригинале Google Docs.');
      const fresh = await readGoogle(doc.documentId, true);
      if (fresh && Array.isArray(fresh.pendingOperations)) {
        const unresolved = fresh.pendingOperations.some(x => x.operationId === attempt.operationId);
        if (!unresolved) { state.googleUncertain.delete(doc.documentId); state.googleAttempts.delete(fingerprint); renderGoogle(); }
      } else if (!fresh) renderGoogle();
    } catch (e) {
      attempt.inFlight = false; state.googleUncertain.set(doc.documentId, attempt);
      notify(e.message, true);
      const fresh = await readGoogle(doc.documentId, true);
      if (fresh && Array.isArray(fresh.pendingOperations) && !fresh.pendingOperations.some(x => x.operationId === attempt.operationId)) {
        state.googleUncertain.delete(doc.documentId); state.googleAttempts.delete(fingerprint); renderGoogle();
      } else if (!fresh) renderGoogle();
    }
  }
  function googleWritesBlocked(doc) {
    return !!(doc && ((Array.isArray(doc.pendingOperations) && doc.pendingOperations.length) || state.googleUncertain.has(doc.documentId)));
  }
  async function reconcileGoogle(documentId, operationId) {
    const copy = 'Откройте оригинал Google Docs по ссылке на панели и лично проверьте, что произошло с операцией ' + operationId + '. Подтверждение запишет только факт вашей проверки; оно не является машинной или визуальной верификацией.';
    if (await ask('Сверить результат в Google Docs', copy, 'Я проверил результат в Google Docs') !== 'confirm') return;
    try {
      await api('/api/google/reconcile', { method: 'POST', body: { documentId, operationId, authorReviewed: true } });
    } catch (e) {
      notify(e.message, true);
      await readGoogle(documentId, true);
      return;
    }
    const fresh = await readGoogle(documentId, true);
    if (!fresh || !Array.isArray(fresh.pendingOperations)) {
      state.googleUncertain.set(documentId, { operationId }); renderGoogle();
      return notify('Сверка отправлена, но актуальное состояние не удалось прочитать. Новые изменения остаются заблокированы.');
    }
    if (fresh.pendingOperations.some(x => x.operationId === operationId)) {
      notify('Операция остаётся незавершённой. Проверьте документ и состояние ещё раз.', true);
      return;
    }
    state.googleUncertain.delete(documentId);
    for (const [fingerprint, attempt] of state.googleAttempts) if (attempt.documentId === documentId && attempt.operationId === operationId) state.googleAttempts.delete(fingerprint);
    renderGoogle();
    notify('Авторская проверка записана. Машинная и визуальная проверка не заявляются.');
  }
  function settings() {
    const pane = state.settingsPane, section = state.settingsSection; state.settingsPane = ''; state.settingsSection = '';
    if (pane === 'project') { const host = node('div', 'project-settings'); special.append(host); projectSettings.render(host, section ? { section } : {}); return; }
    special.append(heading('ПРОСТРАНСТВО', 'Настройки', 'Состояние сервера и подключений. Секреты остаются на сервере.'));
    const project = node('button', 'settings-card project-settings-entry'); project.type = 'button';
    const projectCopy = node('span', 'project-settings-entry-copy'); projectCopy.append(node('span', 'eyebrow', 'АВТОРЫ · СЕРИИ · КНИГИ · ФАЙЛЫ'), node('strong', '', 'Настройки проекта'), node('span', '', 'Переименовать и перепривязать авторов, серии, книги и связанные Google Docs; архив скрытых файлов.'));
    project.append(svgIcon('book-open', 'icon project-settings-entry-icon'), projectCopy, node('span', 'project-settings-entry-go', 'Открыть →'));
    project.addEventListener('click', () => openProjectSettings()); special.append(project);
    const card = node('div', 'settings-card'); card.append(node('h2', '', 'Сервер TaleWisp'), node('p', '', 'Статус загружается из текущего сервера.')); const status = node('div', 'settings-status', 'Загружаю…'); card.append(btn('Обновить статус', 'button button-quiet', loadStatus), status); special.append(card);
    Promise.all([api('/api/status').catch(e => ({ error: e.message })), api('/api/agent/status').catch(e => ({ error: e.message })), api('/api/google/status').catch(e => ({ error: e.message }))]).then(([app, agent, google]) => { status.replaceChildren(); const appValue = typeof app.app === 'string' ? app.app : (app.app && (app.app.name || app.app.displayName)) || 'TaleWisp'; status.append(setting('Приложение', app.error || (appValue + ' · ' + (app.version || 'версия неизвестна'))), setting('Агент', agent.error || agentLabel(agent)), setting('Google Docs', google.error || (google.authenticated ? 'Подключён' : google.configured === false ? googleUnconfiguredText(google.reason) : 'Не подключён'))); });
    const ac = node('div', 'settings-card'); ac.append(node('h2', '', 'Агент и подписка'), node('p', '', 'Используется поддерживаемая авторизация ChatGPT/Codex. Платный API не используется.'), btn('Подключить runtime', 'button button-primary', connectAgent), btn('Войти в ChatGPT / Codex', 'button button-quiet', () => loginAgent())); special.append(ac);
    const gc = node('div', 'settings-card'); gc.append(node('h2', '', 'Google Docs'), node('p', '', 'Оригинал остаётся в Google Docs. Предложения отправляются нативным способом.'), btn('Открыть Google Docs', 'button button-quiet', () => switchView('google'))); special.append(gc, btn('Скачать экспорт данных', 'button button-quiet export-wide', exportData));
    if (authMode === 'password') { const session = node('div', 'settings-card'); session.append(node('h2', '', 'Доступ к пространству'), node('p', '', 'Вход сохранён в этом браузере согласно выбранному сроку запоминания.'), btn('Выйти на этом устройстве', 'button button-quiet', async () => { try { await api('/api/logout', { method: 'POST', body: {} }); window.location.reload(); } catch (e) { notify(e.message, true); } })); special.append(session); }
  }
  function setting(name, value) { const row = node('div', 'setting-row'); row.append(node('span', '', name), node('strong', '', value)); return row; }
  function googleUnconfiguredText(reason) {
    if (reason === 'missing_google_oauth_configuration') return 'Google OAuth не настроен на сервере. Задайте GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET.';
    return 'Google OAuth не настроен на сервере. Проверьте параметры подключения.';
  }
  function accountLabel(account) {
    if (typeof account === 'string') return account;
    if (!account || typeof account !== 'object') return '';
    const plan = typeof account.planType === 'string' && account.planType ? 'ChatGPT ' + account.planType[0].toUpperCase() + account.planType.slice(1) : '';
    return [typeof account.email === 'string' ? account.email : '', plan].filter(Boolean).join(' · ') || (account.type === 'chatgpt' ? 'Аккаунт ChatGPT' : 'Аккаунт подключён');
  }
  function renderAgentWorkflowStatus() {
    const data = buildWorkflowViewModel(state.agent || {}), availability = $('#agent-availability-content');
    const scenarioSelect = $('#agent-mode'), previousMode = state.agentWorkflowMode || scenarioSelect.value;
    availability.replaceChildren();
    const availableCount = [...data.skills, ...data.scenarios].filter(item => item.availability === 'available').length;
    const hasAvailability = [...data.skills, ...data.scenarios].some(item => item.availability !== 'unknown');
    const catalogEmpty = !data.skills.length && !data.scenarios.length;
    $('#agent-availability-count').textContent = catalogEmpty ? '—' : String(hasAvailability ? availableCount : data.skills.length + data.scenarios.length);
    agentPanel.describeToggle('skills', catalogEmpty ? 'Навыки и сценарии: runtime не передал каталог'
      : `Навыки и сценарии: ${data.skills.length} навыков, ${data.scenarios.length} сценариев` + (hasAvailability ? `, доступно ${availableCount}` : ''));
    if (!data.skills.length && !data.scenarios.length) {
      availability.append(node('p', 'subtle-empty', 'Runtime пока не передал каталог навыков и сценариев. Наличие навыка само по себе не подтверждает подключение к внешнему сервису.'));
    }
    if (data.skills.length) {
      const skillsHeading = node('h3', 'agent-status-heading', 'Навыки');
      const skills = node('div', 'agent-status-list');
      data.skills.forEach(skill => {
        const row = node('article', 'agent-status-row');
        row.append(node('strong', '', skill.title), node('span', 'agent-status-badge ' + skill.availability, availabilityLabel(skill.availability)));
        if (skill.description) row.append(node('p', '', skill.description));
        if (skill.gates.length || skill.transports.length) {
          const details = document.createElement('details'); details.className = 'agent-technical-details';
          details.append(node('summary', '', 'Условия и подключение'));
          if (skill.gates.length) details.append(node('p', '', 'Требуется: ' + skill.gates.join(', ')));
          if (skill.transports.length) details.append(node('p', '', 'Переданное runtime подключение: ' + skill.transports.join(', ')));
          row.append(details);
        } else row.append(node('span', 'agent-transport-note', 'Подключение к внешнему сервису не подтверждено runtime.'));
        skills.append(row);
      });
      availability.append(skillsHeading, skills);
    }
    scenarioSelect.replaceChildren();
    if (!data.scenarios.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'Сценарии не переданы runtime'; scenarioSelect.append(option); scenarioSelect.disabled = true;
      state.agentWorkflowMode = '';
    } else {
      data.scenarios.forEach(scenario => {
        const option = document.createElement('option'); option.value = scenario.id;
        option.textContent = scenario.title + (scenario.availability === 'available' ? '' : ' · ' + availabilityLabel(scenario.availability));
        option.disabled = !scenarioCanRun(scenario); scenarioSelect.append(option);
      });
      const preserved = data.scenarios.find(item => item.id === previousMode && scenarioCanRun(item));
      const selected = preserved || data.scenarios.find(scenarioCanRun) || data.scenarios[0];
      scenarioSelect.value = selected.id; scenarioSelect.disabled = !data.scenarios.some(scenarioCanRun);
      state.agentWorkflowMode = selected.id;
      const scenariosHeading = node('h3', 'agent-status-heading', 'Сценарии');
      const scenarios = node('div', 'agent-status-list');
      data.scenarios.forEach(scenario => {
        const row = node('article', 'agent-status-row');
        row.append(node('strong', '', scenario.title), node('span', 'agent-status-badge ' + scenario.availability, availabilityLabel(scenario.availability)));
        if (scenario.optIn) row.append(node('span', 'agent-transport-note', 'Явный запуск: сценарий включается только после его выбора и отправки сообщения.'));
        if (scenario.gates.length) {
          const details = document.createElement('details'); details.className = 'agent-technical-details'; details.append(node('summary', '', 'Что требуется'));
          details.append(node('p', '', scenario.gates.join(', '))); row.append(details);
        }
        if (scenarioCanRun(scenario)) {
          // Selecting only sets the composer scenario; nothing is sent until the author submits.
          const current = scenarioSelect.value === scenario.id;
          const choose = btn(current ? 'Выбран' : 'Выбрать', 'button button-quiet scenario-choose', () => {
            scenarioSelect.value = scenario.id; state.agentWorkflowMode = scenario.id; updateScenarioHelp(data.scenarios);
            renderAgentWorkflowStatus(); agentPanel.closeDrawer({ restoreFocus: false }); $('#chat-input').focus();
          });
          choose.setAttribute('aria-pressed', String(current)); choose.setAttribute('aria-label', (current ? 'Выбран сценарий: ' : 'Выбрать сценарий: ') + scenario.title);
          row.append(choose);
        }
        scenarios.append(row);
      });
      availability.append(scenariosHeading, scenarios);
    }
    updateScenarioHelp(data.scenarios);

    const delegationContent = $('#agent-delegation-content'), delegations = data.delegations;
    $('#agent-delegation-count').textContent = state.agent?.contractVersion ? String(delegations.length) : '—';
    const runningDelegations = delegations.filter(item => item.status === 'running').length;
    const failedDelegations = delegations.filter(item => item.status === 'failed').length;
    agentPanel.describeToggle('tasks', !state.agent?.contractVersion ? 'Делегированные задачи: статус не передан runtime'
      : `Делегированные задачи: ${delegations.length}` + (runningDelegations ? `, выполняется ${runningDelegations}` : '') + (failedDelegations ? `, с ошибкой ${failedDelegations}` : ''),
      { attention: runningDelegations ? 'running' : failedDelegations ? 'error' : '' });
    delegationContent.replaceChildren();
    if (!delegations.length) {
      delegationContent.append(node('p', 'subtle-empty', state.agent?.contractVersion ? 'Пока нет записей о делегированных задачах.' : 'Статус делегирования не передан runtime.'));
      renderMovedDelegations(delegationContent);
      return;
    }
    const rows = node('div', 'agent-status-list');
    delegations.slice().reverse().forEach(item => {
      const row = node('article', 'agent-delegation-row ' + item.status);
      const heading = node('div', 'agent-delegation-heading');
      heading.append(node('strong', '', item.role), node('span', 'agent-status-badge ' + item.status, delegationStatusLabel(item.status)));
      row.append(heading);
      if (item.error) row.append(node('p', 'agent-delegation-error', item.error));
      else if (item.result && item.status === 'completed') row.append(node('p', 'agent-delegation-result', item.result));
      const operational = document.createElement('details'); operational.className = 'agent-technical-details';
      operational.append(node('summary', '', 'Подробности выполнения'));
      const facts = [
        ['Фаза', item.phase], ['Модель', item.model], ['Уровень рассуждения', item.effort],
        ['Идентификатор задачи', item.id], ['Идентификатор диалога', item.threadId],
        ['Начато', formatAgentTimestamp(item.startedAt)], ['Завершено', formatAgentTimestamp(item.completedAt)]
      ].filter(([, value]) => value);
      facts.forEach(([label, value]) => operational.append(node('p', '', label + ': ' + value)));
      if (item.result && item.status !== 'completed') operational.append(node('p', '', 'Результат: ' + item.result));
      if (item.error) operational.append(node('p', 'agent-delegation-error', 'Ошибка: ' + item.error));
      row.append(operational); rows.append(row);
    });
    delegationContent.append(rows);
    renderMovedDelegations(delegationContent);
  }
  const delegationScope = () => JSON.stringify([state.catalog?.active?.authorId ?? null,state.catalog?.active?.seriesId ?? null,state.catalog?.active?.bookId ?? null]);
  async function loadMovedDelegations() {
    const scope = delegationScope();
    try {
      const data = await api('/api/workspace/delegations');
      if (delegationScope() !== scope || data.scopeKey !== scope) return;
      state.movedDelegations = data;
      const content = $('#agent-delegation-content');
      $('.moved-delegation-history',content)?.remove();
      renderMovedDelegations(content);
    } catch (error) { if (delegationScope() === scope) notify('Не удалось загрузить историю прежних файлов: '+error.message,true); }
  }
  function renderMovedDelegations(container) {
    const data = state.movedDelegations;
    if (data?.scopeKey !== delegationScope() || !data.moved?.length) return;
    const history = node('details','agent-technical-details moved-delegation-history');
    history.append(node('summary','','История прежних файлов · '+data.moved.reduce((n,x)=>n+x.rows.length,0)));
    data.moved.forEach(archive => {
      archive.rows.forEach(item => {
        const row = node('article','agent-delegation-row');
        row.append(node('strong','',item.role || 'Задача'),node('p','',delegationStatusLabel(item.status)));
        if (item.result) row.append(node('p','agent-delegation-result',item.result));
        if (item.error) row.append(node('p','agent-delegation-error',item.error));
        const details = node('details','agent-technical-details');
        details.append(node('summary','','Подробности выполнения'));
        for (const [label,value] of [['Задача',item.id],['Диалог',item.threadId],['Модель',item.model],['Завершено',formatAgentTimestamp(item.completedAt)]]) if (value) details.append(node('p','',label+': '+value));
        row.append(details); history.append(row);
      });
      if (archive.raw) history.append(node('pre','',archive.raw));
    });
    container.append(history);
  }
  function formatAgentTimestamp(value) {
    if (!value) return '';
    const dateValue = new Date(value);
    return Number.isNaN(dateValue.getTime()) ? value : dateValue.toLocaleString('ru-RU');
  }
  function updateScenarioHelp(scenarios = []) {
    const selected = scenarios.find(item => item.id === $('#agent-mode').value), help = $('#agent-mode-help');
    const input = $('#chat-input');
    if (selected?.id === 'code_review') {
      help.textContent = 'Вставьте исходный и изменённый код с разделителями ```js, ```mjs или ```json.';
      input.placeholder = 'Вставьте исходный и изменённый код…';
      return;
    }
    input.placeholder = 'Напишите сообщение агенту…';
    if (!selected) { help.textContent = 'Runtime должен сообщить доступные сценарии. Выбор режима не запускает действие.'; return; }
    help.textContent = selected.optIn
      ? 'Явный режим. Он начнётся только после отправки сообщения с выбранным сценарием.'
      : 'Выбор сценария сам по себе ничего не запускает. Отправьте сообщение, чтобы начать.';
  }
  function agentLabel(a) { return a.running ? 'Выполняется' : a.authenticated ? 'Подключён' + (accountLabel(a.account) ? ' · ' + accountLabel(a.account) : '') : 'Не подключён'; }
  function renderAgent() {
    const a = state.agent || {}, pill = $('#agent-status-pill'), label = a.error ? 'Сервер недоступен' : a.running ? 'Выполняется' : a.loginPending ? 'Вход…' : a.authenticated && a.available === false ? 'Runtime отключён' : a.authenticated ? 'Подключён' : 'Не подключён'; $('span', pill).textContent = label; pill.dataset.tip = label + ' · аккаунт и вход'; pill.classList.toggle('online', !!a.authenticated && !a.running); pill.classList.toggle('busy', !!a.running);
    $('#agent-dot').className = 'connection-dot' + (a.authenticated ? ' online' : '') + (a.running ? ' busy' : ''); $('#agent-sidebar-title').textContent = a.error ? 'Агент недоступен' : a.running ? 'Агент работает' : a.authenticated ? accountLabel(a.account) || 'Агент подключён' : 'Агент не подключён'; $('#agent-sidebar-detail').textContent = a.error || (a.authenticated ? 'Runtime доступен' : 'Нужен вход в Codex'); $('#agent-account-detail').textContent = a.error || (a.authenticated ? accountLabel(a.account) || 'Аккаунт подключён' : 'Используется подписка аккаунта'); $('#agent-connect').textContent = 'Подключить runtime';
    const loginStatus = $('#agent-login-status'); loginStatus.replaceChildren(); loginStatus.classList.toggle('hidden', !a.loginPending && !agentLoginUrl && !a.error && a.authenticated);
    if (a.loginPending) {
      loginStatus.append(node('span', '', 'Проверяем вход ChatGPT и доступный каталог моделей…'));
      if (agentLoginUrl) {
        if (agentLoginCode) loginStatus.append(node('strong', '', 'Код устройства: ' + agentLoginCode));
        const link = node('a', 'agent-login-link', 'Открыть страницу входа'); link.href = agentLoginUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; loginStatus.append(link);
      }
    }
    else if (a.authenticated) { agentLoginUrl = ''; agentLoginCode = ''; loginStatus.classList.add('hidden'); }
    else if (agentLoginUrl) {
      loginStatus.append(node('span', '', 'Завершите вход в открытой вкладке ChatGPT. После возврата статус аккаунта обновится автоматически.'));
      if (agentLoginCode) loginStatus.append(node('strong', '', 'Код устройства: ' + agentLoginCode));
      const link = node('a', 'agent-login-link', 'Открыть страницу входа'); link.href = agentLoginUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; loginStatus.append(link);
    } else if (a.error) {
      loginStatus.append(node('span', '', friendlyAgentError(a.error)), btn('Обновить статус', 'button button-quiet', loadAgent));
      if (!a.authenticated) {
        const loginActions = node('div', 'agent-banner-actions');
        loginActions.append(btn('Войти через ChatGPT', 'button button-primary', () => loginAgent()), btn('Войти кодом устройства', 'button button-quiet', () => loginAgent('device')));
        loginStatus.append(loginActions);
      }
    }
    else if (!a.authenticated) {
      loginStatus.append(node('strong', 'agent-banner-title', 'Агент не подключён'), node('span', '', 'Войдите через ChatGPT. Для телефона или удалённой машины можно войти по коду устройства.'));
      const loginActions = node('div', 'agent-banner-actions');
      loginActions.append(btn('Войти через ChatGPT', 'button button-primary', () => loginAgent()), btn('Войти кодом устройства', 'button button-quiet', () => loginAgent('device')));
      loginStatus.append(loginActions);
    }
    if (a.authenticated && a.available === false && !a.error && !a.loginPending) {
      loginStatus.classList.remove('hidden');
      loginStatus.append(node('span', '', 'Аккаунт подключён, но runtime сейчас не принимает сообщения.'), btn('Подключить runtime', 'button button-quiet', connectAgent));
    }
    loginStatus.dataset.tone = a.error ? 'error' : a.loginPending || agentLoginUrl ? 'pending' : 'info';
    const models = Array.isArray(a.models) ? a.models : [], old = $('#model-select').value; $('#model-select').replaceChildren(); models.forEach(m => { const o = document.createElement('option'); o.value = m.id; o.textContent = m.displayName || m.id; $('#model-select').append(o); }); if (!models.length) { const o = document.createElement('option'); o.textContent = 'Нет доступных моделей'; $('#model-select').append(o); } if (models.some(m => m.id === old)) $('#model-select').value = old;
    $('#model-select').disabled = !a.authenticated || !models.length; $('#chat-input').disabled = !a.authenticated || !a.available || !models.length; $('#chat-send').disabled = !a.authenticated || !a.available || !models.length; $('#agent-stop').classList.toggle('hidden', !a.running); agentPanel.syncState(a); agentPanel.renderLimits(a.limits, { authenticated: !!a.authenticated });
    renderAgentWorkflowStatus();
  }
  async function loadAgent() { agentPanel.markLoading(); try { state.agent = await api('/api/agent/status'); state.messages = state.agent.messages || []; renderAgent(); renderConversationTabs(); renderMessages(); } catch (e) { state.agent = { error: e.message, messages: [] }; renderAgent(); } }
  function renderConversationTabs() {
    const tabs=$('#chat-tabs'), archive=$('#chat-archive-list'); if(!tabs||!archive)return; tabs.replaceChildren();archive.replaceChildren();
    const conversations=state.agent?.conversations||[];
    for(const item of conversations){const target=item.archived?archive:tabs, row=document.createElement('span');row.className='chat-tab-row';
      const tab=btn(item.title||'Диалог','chat-tab'+(item.id===state.agent.activeConversationId?' active':''),()=>switchConversation(item.id));tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(item.id===state.agent.activeConversationId));tab.disabled=!!state.agent.running;row.append(tab);
      const action=btn(item.archived?'Восстановить':'В архив',item.archived?'chat-restore':'chat-archive-action',()=>changeConversation(item.id,item.archived?'restore':'archive'));action.setAttribute('aria-label',(item.archived?'Восстановить ':'Архивировать ')+item.title);action.disabled=!!state.agent?.running;row.append(action);target.append(row);
    }
    $('#chat-new').disabled=!!state.agent?.running;
  }
  async function switchConversation(id){try{state.agent=await api('/api/agent/conversations/activate',{method:'POST',body:{id}});state.messages=state.agent.messages||[];renderConversationTabs();renderMessages();}catch(error){notify(error.message,true);}}
  async function changeConversation(id,action){try{state.agent=await api(`/api/agent/conversations/${encodeURIComponent(id)}/${action}`,{method:'POST',body:{}});state.messages=state.agent.messages||[];renderConversationTabs();renderMessages();}catch(error){notify(error.message,true);}}
  async function createConversation(){try{state.agent=await api('/api/agent/conversations/create',{method:'POST',body:{}});state.messages=state.agent.messages||[];renderConversationTabs();renderMessages();$('#chat-input').focus();}catch(error){notify(error.message,true);}}
  function renderMessages() {
    chat.replaceChildren(); if (!state.messages.length) { const emptyChat = node('div', 'empty-chat'), emptyIcon = node('span', 'empty-orbit'); emptyIcon.append(svgIcon('sparkles')); emptyChat.append(emptyIcon, node('strong', '', 'Рабочий диалог'), node('p', '', state.agent?.authenticated ? 'Напишите сообщение, чтобы начать разговор.' : 'Сообщения появятся после подключения runtime.')); chat.append(emptyChat); return; }
    state.messages.forEach(m => { const role = m.role === 'user' ? 'user' : 'assistant', row = node('div', 'chat-message ' + role), classification=classifyAgentMessage(m.text), technical=role==='assistant'&&classification.technical, bubble = node('div', 'message-bubble'); if(technical){row.append(node('span','message-role','Агент · служебное сообщение'));if(classification.summary)row.append(node('p','message-summary',classification.summary));const details=node('details','message-technical');details.append(node('summary','','Технические подробности · раскрыть'));renderSafeMarkdown(bubble,safe(m.text),m.knowledgeLinks||m.links||[],link=>showKnowledgeCard(link,null),reference=>resolveAgentReference(reference,row));details.append(bubble);row.append(details);}else{renderSafeMarkdown(bubble,safe(m.text),m.knowledgeLinks||m.links||[],link=>showKnowledgeCard(link,null),reference=>resolveAgentReference(reference,row));row.append(node('span','message-role',role==='user'?'Вы':'Агент'),bubble);} if(role==='assistant'&&classification.insertableProse){const actions=node('div','message-actions');actions.append(btn('Вставить в черновик','',()=>insertProposal(m.text)));row.append(actions);} chat.append(row); }); chat.scrollTop = chat.scrollHeight;
  }
  function insertProposal(value) {
    if (!state.googleNativeOpen && state.chapterMode) {
      const chapterText = prompt('Добавить предложение в конец открытой главы? Правка останется в браузере до вашей проверки и записи в Google.', value); if (chapterText === null) return;
      if (chapters.appendText(chapterText)) notify('Текст добавлен в главу. В Google он попадёт только после проверки и подтверждения записи.');
      else notify('Откройте главу рукописи, чтобы вставить предложение.', true);
      return;
    }
    if (state.googleNativeOpen || !state.current || draft()?.readonly) return notify('Откройте локальный черновик или заметку, чтобы вставить предложение.', true);
    const textToAdd = prompt('Добавить предложение в конец локального черновика? Текст можно изменить.', value); if (textToAdd === null) return; text.value += (text.value && !text.value.endsWith('\n') ? '\n\n' : '') + textToAdd; scheduleSave(); notify('Текст добавлен в локальный черновик.');
  }
  function friendlyAgentError(message) {
    if (/could not start|ENOENT|app-server.*unavailable/i.test(message)) return 'Не удалось запустить Codex runtime. Проверьте, что Codex установлен, затем обновите статус.';
    if (/model\/list|model catalog/i.test(message)) return 'Аккаунт проверен, но каталог моделей пока недоступен. Обновите статус runtime.';
    if (/not meet the required read-only/i.test(message)) return 'Runtime не прошёл проверку настроек доступа. Подключение остановлено.';
    return 'Не удалось завершить вход или проверку подписки: ' + message;
  }
  async function connectAgent() { try { await api('/api/agent/connect', { method: 'POST', body: {} }); await loadAgent(); if (state.agent?.error) notify(friendlyAgentError(state.agent.error), true); else notify('Статус подписки и каталога моделей обновлён.'); } catch (e) { notify(friendlyAgentError(e.message), true); await loadAgent(); } }
  async function loginAgent(method = 'browser') {
    const popup = method === 'browser' ? window.open('about:blank', '_blank') : null;
    agentLoginUrl = ''; agentLoginCode = ''; state.agent = { ...state.agent, loginPending: true, error: null }; renderAgent();
    try {
      const r = await api('/api/agent/login', { method: 'POST', body: { method } });
      agentLoginUrl = r.authUrl || r.verificationUrl || ''; agentLoginCode = r.userCode || '';
      if (!agentLoginUrl) throw Error('Сервер входа не вернул ссылку. Обновите статус runtime и повторите попытку.');
      if (popup) { popup.opener = null; popup.location.replace(agentLoginUrl); }
      await loadAgent();
      if (method === 'device') notify('Введите код устройства на странице входа ChatGPT. Статус аккаунта обновится после завершения входа.');
      else if (!popup) notify('Вход подготовлен. Откройте ссылку в панели входа; браузер заблокировал всплывающее окно.');
    } catch (e) { popup?.close(); state.agent = { ...state.agent, loginPending: false, error: e.message }; renderAgent(); notify(friendlyAgentError(e.message), true); }
  }
  async function stopAgent() { try { await api('/api/agent/stop', { method: 'POST', body: {} }); notify('Остановка запрошена. Проверяю статус…'); await loadAgent(); } catch (e) { notify(e.message, true); } }
  async function sendMessage(e) {
    e.preventDefault();
    const input = $('#chat-input'), message = input.value.trim();
    if (!message) return;
    const reviewerRequested = $('#review-request').checked;
    // The active manuscript chapter replaces the local draft as agent context; the server binds its provenance.
    const capturedChapter = !state.googleNativeOpen && chapters?.active() ? chapters.agentContext() : null;
    const capturedChapters = capturedChapter ? chapters.agentContexts() : [];
    const capturedCurrent = !state.googleNativeOpen && !capturedChapter && state.current ? { ...state.current } : null;
    const capturedDraft = state.googleNativeOpen || capturedChapter ? null : draft();
    const capturedSelection = state.googleNativeOpen ? '' : state.selectedText;
    const capturedSources = [...state.sources];
    const capturedText = capturedDraft ? capturedDraft.text : '';
    const key = capturedCurrent ? capturedCurrent.kind + ':' + capturedCurrent.id : '';
    try {
      if (key) await saveQueue.flush(key);
      if (capturedDraft && (capturedDraft.dirty || capturedDraft.saveError || capturedDraft.text !== capturedText))
        throw Error('Текст не удалось зафиксировать. Исправьте состояние сохранения и отправьте сообщение ещё раз.');
      const body = { ...buildAgentMessagePayload(message, $('#agent-mode').value, reviewerRequested), model: $('#model-select').value || undefined };
      if (capturedCurrent && capturedDraft && draft() === capturedDraft) {
        if (capturedCurrent.kind === 'document' && capturedDraft.id) {
          body.documentId = capturedDraft.id;
          body.documentVersion = capturedDraft.version;
        }
      }
      if (capturedSelection && (!capturedChapter || (capturedChapters.length === 1 && capturedChapters[0].sectionId === capturedChapter.sectionId))) body.selectedText = capturedSelection;
      if (capturedChapter && capturedChapters.length <= 1) body.manuscriptChapter = capturedChapters[0] ?? capturedChapter;
      if (capturedChapters.length > 1) body.manuscriptChapters = capturedChapters;
      if (capturedSources.length) body.knowledgePaths = capturedSources;
      await api('/api/agent/message', { method: 'POST', body });
      if (input.value.trim() === message) { input.value = ''; if (reviewerRequested) $('#review-request').checked = false; }
      await loadAgent();
    } catch (err) { notify(err.message, true); }
  }
  function agentShortcut(action) {
    const actions = {
      continue: 'Продолжи работу с активным черновиком. Соблюдай авторские указания и не меняй текст без моего действия.',
      revise: 'Предложи локальную правку для текущего выделения. Сохрани смысл; покажи вариант, не применяй его.',
      check: 'Проверь активный текст и выбранные источники. Сначала назови конкретные проблемы и привяжи их к фрагментам.'
    };
    const prompt = actions[action]; if (!prompt) return;
    const target = state.selectedText ? ' Выделение — мой точный фрагмент для работы.' : ' Работай с открытым черновиком.';
    $('#chat-input').value = prompt + target;
    showToolPanel('agent'); $('#chat-input').focus();
  }
  function selection() {
    const chapterActive = !!chapters?.active();
    if (chapterActive) state.selectedText = chapters.selectedText();
    else { if (!state.current || draft()?.readonly) return; const a = text.selectionStart, b = text.selectionEnd; state.selectedText = b > a ? text.value.slice(a, b) : ''; }
    $('#selection-info').textContent = state.selectedText ? state.selectedText.length + ' знаков выделено' : 'Без выделения';
    $('#selected-preview').textContent = state.selectedText ? '«' + state.selectedText.slice(0, 180) + (state.selectedText.length > 180 ? '…' : '') + '»' : 'Выделите текст в документе, чтобы передать агенту точный фрагмент.';
    $('#chat-context-label').textContent = state.selectedText ? 'Выделение · ' + state.selectedText.length + ' зн.' : chapterActive ? chapters.contextLabel() : state.sources.size ? state.sources.size + ' источн.' : 'Контекст не выбран';
  }
  async function loadHistory(panelGeneration = panelLifecycle.currentGeneration()) {
    const key = currentKey(), draftId = draft()?.id ?? null;
    const request = panelLifecycle.beginHistory({ generation: panelGeneration, key, draftId });
    const isCurrent = () => panelLifecycle.isCurrentHistory(request, {
      generation: panelLifecycle.currentGeneration(), key: currentKey(), draftId: draft()?.id ?? null
    });
    if (state.current?.kind !== 'document' || !draftId) {
      if (isCurrent()) $('#history-list').replaceChildren(empty('История недоступна', 'Сначала сохраните документ.'));
      return false;
    }
    try {
      const result = await api('/api/documents/' + encodeURIComponent(draftId) + '/history');
      if (!isCurrent()) return false;
      state.history = result.versions || [];
      renderHistory();
      return true;
    } catch (e) {
      if (!isCurrent()) return false;
      $('#history-list').replaceChildren(empty('Не удалось загрузить историю', e.message));
      return false;
    }
  }
  function renderStoryArtWorkspace() {
    $('#storyart-request-count').textContent = state.storyArtLoading ? '…' : state.storyArtError ? '!' : String(state.storyArtRequests.length);
    agentPanel.describeToggle('storyart', state.storyArtLoading ? 'Иллюстрации StoryArt: загружаем список'
      : state.storyArtError ? 'Иллюстрации StoryArt: список не загружен, есть ошибка' : `Иллюстрации StoryArt: задач ${state.storyArtRequests.length}`,
      { attention: state.storyArtLoading ? 'running' : state.storyArtError ? 'error' : '' });
    $('#storyart-request-content').replaceChildren(renderStoryArtRequests(document, state.storyArtRequests, {
      origin: window.location.origin,
      loading: state.storyArtLoading,
      error: state.storyArtError,
      onRefresh: () => refreshStoryArtRequests(),
      onOperation: (operation, requestId, message) => operateStoryArt(operation, requestId, message),
      onOpenWorkspace: () => { if (state.sidebarOpen) toggleSidebar(false); showPrimaryView('storyart'); storyArt.navigate({ screen: 'jobs' }); }
    }));
  }
  async function refreshStoryArtRequests() {
    if (state.storyArtLoading) return;
    state.storyArtLoading = true; state.storyArtError = ''; renderStoryArtWorkspace();
    try {
      const result = await api('/api/storyart/requests');
      state.storyArtRequests = Array.isArray(result.requests) ? result.requests : [];
    } catch (error) {
      state.storyArtError = error.message;
    } finally {
      state.storyArtLoading = false; renderStoryArtWorkspace();
    }
  }
  async function operateStoryArt(operation, requestId, message) {
    try {
      await api('/api/storyart/operation', { method: 'POST', body: { operation, requestId, ...(operation === 'send' ? { message } : {}) } });
      await refreshStoryArtRequests();
      return !state.storyArtError;
    } catch (error) {
      state.storyArtError = error.message; renderStoryArtWorkspace();
      return false;
    }
  }
  function renderHistory() {
    const list = $('#history-list'); list.replaceChildren(); $('#history-compare').classList.add('hidden'); if (!state.history.length) { list.append(empty('Версий пока нет', 'Версии появятся после сохранения изменений.')); return; }
    state.history.forEach(v => { const b = btn('', 'history-item' + (state.selectedHistory?.id === v.id ? ' selected' : ''), () => { state.selectedHistory = v; renderHistory(); }); b.append(node('strong', '', 'Версия ' + v.version + ' · ' + (v.title || 'Без названия')), node('span', '', date(v.createdAt))); list.append(b); });
    if (state.selectedHistory) { const actions = node('div', 'history-actions'); actions.append(btn('Сравнить с текущей', 'button button-quiet', compare), btn('Восстановить версию', 'button button-quiet', restore)); list.append(actions); }
  }
  function compare() { const v = state.selectedHistory, d = draft(); if (!v || !d) return; const a = safe(v.text).split('\n'), b = safe(d.text).split('\n'), out = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] === b[i]) { if (a[i] !== undefined) out.push('  ' + a[i]); } else { if (a[i] !== undefined) out.push('− ' + a[i]); if (b[i] !== undefined) out.push('+ ' + b[i]); } } const box = $('#history-compare'); box.textContent = out.join('\n') || 'Текущая версия совпадает.'; box.classList.remove('hidden'); }
  async function restore() { const d = draft(), v = state.selectedHistory; if (!d || !v) return; if (await ask('Восстановить версию?', 'Восстановление запишет выбранный текст новой версией. Сначала сохраните текущий текст.') !== 'confirm') return; if (d.dirty) return notify('Сначала дождитесь сохранения текущего текста.', true); try { const r = await api('/api/documents/' + encodeURIComponent(d.id) + '/restore', { method: 'POST', body: { historyId: v.id, version: d.version } }); Object.assign(d, { ...r.document, savedText: r.document.text, savedTitle: r.document.title, dirty: false }); renderCurrent(); await loadHistory(); notify('Версия восстановлена новой записью истории.'); } catch (e) { notify(e.message, true); } }
  async function exportData() { try { const data = await api('/api/export', { method: 'POST', body: {} }); const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })); a.href = url; a.download = 'talewisp-export-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('Экспорт скачан из данных сервера.'); } catch (e) { notify('Экспорт недоступен: ' + e.message, true); } }
  function mobilePane(name) { $$('.mobile-tab').forEach(x => x.classList.toggle('selected', x.dataset.pane === name)); $('#editor-pane').classList.toggle('mobile-hide', name !== 'editor'); $('#agent-pane').classList.toggle('mobile-show', name === 'agent'); $('#context-pane').classList.toggle('mobile-show', name === 'context'); }
  function toggleSidebar(open = !state.sidebarOpen) {
    state.sidebarOpen = open; $('#mobile-overlay').classList.toggle('open', open); $('.sidebar').classList.toggle('open', open);
    $('#mobile-menu').setAttribute('aria-expanded', String(open));
    if (open) ($('.sidebar .nav-item.active') || $('.sidebar .nav-item'))?.focus({ preventScroll: true });
    // Closing the drawer hides it; do not leave focus on an invisible item (overlay tap, section switch).
    else if ($('#mobile-menu').offsetParent && (document.activeElement === document.body || $('.sidebar').contains(document.activeElement))) $('#mobile-menu').focus({ preventScroll: true });
  }
  function bind() {
    $$('.nav-item[data-view]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.view))); $('#new-document').addEventListener('click', () => create('document')); $('#new-note-inline').addEventListener('click', () => create('note')); $('#context-new-note').addEventListener('click', () => { closeWorkspace(); create('note'); });
    $('#author-select').addEventListener('change', () => { const author = state.catalog?.authors?.find(x => x.id === $('#author-select').value); fillSelect($('#series-select'), 'Серия', author?.series, ''); fillSelect($('#book-select'), 'Книга', [], ''); });
    $('#series-select').addEventListener('change', () => { const author = state.catalog?.authors?.find(x => x.id === $('#author-select').value); const series = author?.series?.find(x => x.id === $('#series-select').value); fillSelect($('#book-select'), 'Книга', series?.books, ''); if (series && Array.isArray(series.books) && series.books.length === 0) void selectWorkspace(); });
    $('#book-select').addEventListener('change', selectWorkspace);
    title.addEventListener('input', scheduleSave); text.addEventListener('input', scheduleSave); ['select', 'keyup', 'mouseup'].forEach(t => text.addEventListener(t, selection));
    $('#send-selection').addEventListener('click', () => { if (!state.selectedText) return notify('Сначала выделите фрагмент в документе.', true); showToolPanel('agent'); $('#chat-input').focus(); });
    $('#dock-tools').addEventListener('click', showToolPalette); $('#dock-agent').addEventListener('click', () => showToolPanel('agent')); $('#dock-context').addEventListener('click', () => showToolPanel('context'));
    $('#desktop-tools').addEventListener('click', showToolPalette);
    $$('[data-inspector]').forEach(tab => tab.addEventListener('click', () => showToolPanel(tab.dataset.inspector)));
    $('#tool-palette').addEventListener('click', toolPaletteClick);
    $('#workspace-back').addEventListener('click', showToolPalette); $('#workspace-close').addEventListener('click', closeWorkspace);
    $('#workspace-dialog').addEventListener('cancel', () => { pendingWorkspaceCloseGeneration = panelLifecycle.invalidate(); });
    $('#workspace-dialog').addEventListener('close', () => {
      if (ignoreWorkspaceClose) { ignoreWorkspaceClose = false; return; }
      const closingGeneration = pendingWorkspaceCloseGeneration;
      pendingWorkspaceCloseGeneration = null;
      if (closingGeneration === null) panelLifecycle.invalidate();
      else if (!panelLifecycle.isCurrent(closingGeneration)) return;
      restorePortal();
      if (!PRIMARY_VIEWS.has(state.view) && !state.googleNativeOpen) closeSpecial();
      if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null;
    });
    $$('.agent-actions [data-agent-action]').forEach(b => b.addEventListener('click', () => agentShortcut(b.dataset.agentAction)));
    $('#agent-mode').addEventListener('change', () => { state.agentWorkflowMode = $('#agent-mode').value; updateScenarioHelp(buildWorkflowViewModel(state.agent || {}).scenarios); });
    $('#chat-form').addEventListener('submit', sendMessage); $('#chat-new').addEventListener('click',createConversation); $('#agent-connect').addEventListener('click', connectAgent); $('#agent-refresh').addEventListener('click', () => { loadAgent(); if (agentPanel.drawer === 'storyart') refreshStoryArtRequests(); }); $('#agent-stop').addEventListener('click', stopAgent); $('#sidebar-agent-action').addEventListener('click', () => showToolPanel('agent'));
    $('#history-button').addEventListener('click', () => showToolPanel('history'));
    $$('.context-tab').forEach(t => t.addEventListener('click', () => { const history = t.dataset.context === 'history'; $$('.context-tab').forEach(x => x.classList.toggle('active', x === t)); $('#context-view').classList.toggle('hidden', history); $('#history-view').classList.toggle('hidden', !history); if (history) loadHistory(); }));
    $('#clear-context').addEventListener('click', () => { state.sources.clear(); state.selectedText = ''; renderContextSources(); selection(); notify('Выбранный контекст очищен.'); }); $('#browse-knowledge').addEventListener('click', () => switchView('knowledge')); $('#export-button').addEventListener('click', exportData);
    $('#focus-mode').addEventListener('click', () => { state.focus = !state.focus; $('.app-shell').classList.toggle('focus-mode', state.focus); $('#focus-mode').setAttribute('aria-pressed', String(state.focus)); splitter.sync(); });
    $('#mobile-menu').addEventListener('click', () => toggleSidebar());
    $('#mobile-overlay').addEventListener('click', () => toggleSidebar(false));
    $('#folio-close').addEventListener('click', () => { toggleSidebar(false); $('#mobile-menu').focus({ preventScroll: true }); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.sidebarOpen) { toggleSidebar(false); $('#mobile-menu').focus({ preventScroll: true }); } });
  }
  async function loadStatus() { await Promise.all([loadAgent(), api('/api/google/status').catch(() => null)]); }
  async function loadLists(scope = 'active') { try { state.scope = scope; const suffix = scope === 'all' ? '?scope=all' : ''; const [d, n] = await Promise.all([api('/api/documents' + suffix), api('/api/notes' + suffix)]); state.docs = d.documents || []; state.notes = n.notes || []; state.docs.forEach(x => { if (!state.drafts.has('document:' + x.id)) state.drafts.set('document:' + x.id, { ...x, text: '', savedTitle: x.title, savedText: '', savedStatus: x.status, savedTargetWords: x.targetWords, dirty: false, needsLoad: true }); }); state.notes.forEach(x => { if (!state.drafts.has('note:' + x.id)) state.drafts.set('note:' + x.id, { ...x, text: '', savedTitle: x.title, savedText: '', savedStatus: x.status, savedTargetWords: x.targetWords, dirty: false, needsLoad: true }); }); renderLists(); } catch (e) { notify(e.message, true); } }
  function resumeDirtySaves() {
    for (const item of state.drafts.values()) {
      const key = keyForDraft(item);
      if (key && item.dirty) saveQueue.schedule(key, () => persistDraft(item), 0);
    }
  }
  function events() { try { stream = new EventSource('/api/events', { withCredentials: true }); stream.addEventListener('agent', e => { let d; try { d = JSON.parse(e.data); } catch { return; } if (d.type === 'delta' && d.text && (!d.conversationId || d.conversationId === state.agent?.activeConversationId)) { const last = state.messages.at(-1); if (last?.role === 'assistant') last.text = (last.text || '') + d.text; else state.messages.push({ role: 'assistant', text: d.text }); renderMessages(); } if (['message', 'status', 'error', 'approval', 'delegation', 'delegation-receipt'].includes(d.type)) loadAgent(); }); } catch { /* Manual refresh remains available. */ } }
  async function initializeAuthenticatedWorkspace() {
    let savedNavigation = null;
    try { savedNavigation = readNavigation(window.localStorage); } catch { /* Storage may be disabled. */ }
    const initialRevision = navigationRevision;
    await Promise.all([loadLists(), loadAgent(), loadCatalog()]);
    await loadOverview();
    if (savedNavigation && navigationRevision === initialRevision) {
      state.knowledgeScope = savedNavigation.knowledgeScope;
      state.knowledgeSelectedConceptId = savedNavigation.knowledgeSelectedConceptId;
      state.knowledgeSelectedPath = savedNavigation.knowledgeSelectedPath;
      state.storyArt = savedNavigation.storyArt;
      storyArt.restore(savedNavigation.storyArt);
      const current = savedNavigation.current;
      if (current && !savedNavigation.googleNativeOpen && (current.kind === 'document' ? state.docs : state.notes).some(item => item.id === current.id)) await openItem(current.kind, current.id);
      if (savedNavigation.view !== 'documents' && !(['documents', 'notes'].includes(savedNavigation.view) && savedNavigation.editor && state.current)) showPrimaryView(savedNavigation.view);
      if (savedNavigation.view === 'google' && savedNavigation.googleDocumentId) {
        const restored = await readGoogle(savedNavigation.googleDocumentId, true);
        const tab = restored?.tabs?.find(tab => tab.tabId === savedNavigation.googleTabId);
        if (tab) { state.googleTab = tab; renderGoogle(); }
        if (restored && savedNavigation.googleNativeOpen) showGoogleNativeEditor(restored);
      }
    }
    // Opening a book never opens its companion Google Docs; only an explicitly opened document is restored.
    if (savedNavigation?.googleNativeOpen && savedNavigation.view === 'documents' && navigationRevision === initialRevision) restoreOpenedCompanionDocument(savedNavigation.googleDocumentId);
    navigationReady = true;
    rememberNavigation();
    events();
    resumeDirtySaves();
  }
  async function bootstrap() {
    try { const b = await api('/api/bootstrap'); authMode = b.authMode || 'local'; if (b.local && !b.authenticated) await api('/api/session', { method: 'POST', body: { local: true } }); if (b.local || b.authenticated) await initializeAuthenticatedWorkspace(); else locked(authMode, b.username); }
    catch (e) { notify(e.message, true); deck.update(state.catalog, { error: e.message }); loadAgent(); }
  }
  function locked(mode = 'token', username = '') {
    const panel = node('section', 'locked-screen'), lockMark = node('div', 'locked-mark'); lockMark.append(svgIcon('book-open')); panel.append(lockMark, node('div', 'eyebrow', 'TALEWISP · ЗАЩИЩЁННЫЙ ДОСТУП'), node('h1', '', 'Вход в пространство'));
    const form = document.createElement('form'); if (mode === 'password') form.className = 'password-login-form';
    let body, secret;
    if (mode === 'password') {
      panel.append(node('p', '', 'Введите логин и пароль. Отметьте запоминание, чтобы оставаться в системе на этом устройстве.'));
      const user = document.createElement('input'); user.name = 'username'; user.autocomplete = 'username'; user.placeholder = 'Логин'; user.setAttribute('aria-label', 'Логин'); user.required = true; user.maxLength = 128; if (username) user.value = username;
      secret = document.createElement('input'); secret.name = 'password'; secret.type = 'password'; secret.autocomplete = 'current-password'; secret.placeholder = 'Пароль'; secret.setAttribute('aria-label', 'Пароль'); secret.required = true; secret.maxLength = 1024;
      const rememberLabel = document.createElement('label'), remember = document.createElement('input'); remember.type = 'checkbox'; remember.setAttribute('aria-label', 'Запомнить это устройство на 90 дней'); remember.checked = true; rememberLabel.append(remember, document.createTextNode(' Запомнить это устройство на 90 дней')); form.append(user, secret, rememberLabel); body = () => ({ username: user.value, password: secret.value, remember: remember.checked });
    } else {
      panel.append(node('p', '', 'Введите токен доступа, настроенный на этом сервере.'));
      secret = document.createElement('input'); secret.type = 'password'; secret.autocomplete = 'current-password'; secret.placeholder = 'Токен сервера'; secret.required = true; form.append(secret); body = () => ({ token: secret.value });
    }
    const submit = btn('Войти', 'button button-primary'); submit.type = 'submit'; form.append(submit); form.addEventListener('submit', async e => { e.preventDefault(); submit.disabled = true; try { await api('/api/session', { method: 'POST', body: body() }); await initializeAuthenticatedWorkspace(); panel.remove(); } catch (err) { notify(err.message, true); submit.disabled = false; } }); panel.append(form); document.body.append(panel);
  }
  saveQueue = createSaveQueue({ onChange: () => setSave('saved', 'Все изменения сохранены') });
  window.addEventListener('beforeunload', event => {
    stash();
    const unsaved = [...state.drafts.values()].some(item => item.dirty) || saveQueue.hasPending() || chapters.hasUnsafeDrafts();
    if (unsaved) { event.preventDefault(); event.returnValue = ''; }
  });
  bind(); renderLists(); renderCurrent(); renderContextSources(); renderContextNotes();
  let desktopInspector = hasDesktopInspector();
  if (desktopInspector) showToolPanel('agent');
  window.addEventListener('resize', () => {
    const next = hasDesktopInspector();
    if (next === desktopInspector) return;
    panelLifecycle.invalidate();
    desktopInspector = next;
    if (next) state.activeTool === 'tools' ? showToolPalette() : showToolPanel(state.activeTool || 'agent');
    else { closeWorkspace(); restorePortal(); if (!PRIMARY_VIEWS.has(state.view) && !state.googleNativeOpen) closeSpecial(); }
  });
  bootstrap();
})();
