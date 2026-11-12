// Narrative framework panel inside the right inspector (desktop) or the tools dialog (narrow screens).
// The server is authoritative: every decision, link and approval is a CAS/idempotent request; the browser keeps
// only unsaved draft input (localStorage) for recovery and never merges silently.
import { diffPlans, sourceFromEditorIdentity, googleIdentity, documentIdentity, findStage, activeStages, stageFingerprint, FIELD_LABELS, NARRATIVE_LIMITS } from './narrative-model.js';

const LAYER_PREF = 'talewisp.narrative.layer';
const DRAFT_PREFIX = 'talewisp.narrative.v1.';
const TONE_LABELS = { current: 'Актуально', historic: 'Глава изменена · прежнее решение автора', review: 'Требует проверки', lost: 'Привязка потеряна' };
const SOURCE_LABELS = { planned: 'Запланирована, текст не привязан', bound: 'Привязана к тексту', missing: 'Текст сохранён, но глава не найдена в Google', verify: 'Сопоставление требует подтверждения', lost: 'Привязка потеряна', other_manuscript: 'Привязана к прежней основной рукописи', unavailable: 'Текст сейчас недоступен' };
const LOCATED = new Set(['exact', 'intact', 'shifted']);
// The server runs "write by framework" only with a context-window proof from a trusted host adapter and fails
// closed (503 narrative_preflight_unavailable) without one; the browser neither proves nor estimates capacity.
const WRITE_PREFLIGHT_NOTE = '«Писать по каркасу» запускается только после проверки окна модели доверенным адаптером хоста: модель, токенизатор и весь скрытый контекст. Текущий мост runtime такой проверки не предоставляет, поэтому сервер откажет до запуска модели, ничего не обрезая. Обсуждение согласованного плана («Обсудить план») работает без этой проверки.';

export async function sha256Hex(text, crypto = globalThis.crypto) {
  if (!crypto?.subtle) throw new Error('Браузер не может вычислить SHA-256 в этом подключении (нужен HTTPS или localhost).');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const emptyDraft = (kind, chapterId, uid) => kind === 'book'
  ? { kind, title: '', intent: '', outcome: '', constraints: '', lines: [{ id: uid(), title: 'Основная линия', primary: true }], stages: [] }
  : { kind, chapterId, title: '', goal: '', outcome: '', knowledgeBounds: '', stages: [] };
const stripPins = payload => { if (!payload) return null; const { parentPins, ...rest } = payload; return rest; };

export function createNarrativePanel({ document, window, storage, api, notify, ask, root, attachRoot, getEditor, getEditorSource, flushSource, openSource, captureAgentContext, onBadgesChanged, onOpenPanel }) {
  const s = { bookId: null, gen: 0, data: null, loading: false, error: '', seq: 0, tab: 'book', followEditor: true, chapterId: null, filters: { line: '', state: '', chapter: '', showClosed: true }, editing: null, compare: null, closing: null, agentMode: '', draftTarget: '', draftChapterId: null, focus: new Set(), preview: null, layer: readPref(), expanded: false, editorChapterId: null, editorSource: null, syncSeq: 0, openQuote: new Set() };
  const ops = new Map();
  const node = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
  const button = (value, cls, fn, label) => { const n = node('button', cls || 'button button-quiet', value); n.type = 'button'; if (label) n.setAttribute('aria-label', label); if (fn) n.addEventListener('click', fn); return n; };
  const uid = () => (window.crypto?.randomUUID?.() ?? `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/[^A-Za-z0-9_-]/g, '');
  const base = () => `/api/books/${encodeURIComponent(s.bookId)}/narrative`;
  const short = (text, n = 140) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > n ? value.slice(0, n) + '…' : value; };
  const date = value => { const d = new Date(value); return isNaN(d) ? '' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d); };
  function readPref() { try { return storage?.getItem(LAYER_PREF) !== '0'; } catch { return true; } }

  // ---------- Shell ----------
  root.replaceChildren();
  const head = node('header', 'narrative-head'), title = node('h2', '', 'Каркас повествования');
  const summary = node('p', 'narrative-summary'); summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const actions = node('div', 'narrative-head-actions');
  const refreshButton = button('Обновить', 'text-action', () => refresh());
  const expandButton = button('Развернуть', 'text-action', () => setExpanded(!s.expanded));
  expandButton.setAttribute('aria-pressed', 'false');
  actions.append(refreshButton, expandButton, button('Экспорт статусов', 'text-action', () => exportStatuses()));
  const toggles = node('div', 'narrative-toggles');
  const layerLabel = node('label'), layerInput = node('input'); layerInput.type = 'checkbox'; layerInput.checked = s.layer; layerLabel.append(layerInput, document.createTextNode(' Слой «Этапы повествования» в тексте'));
  layerInput.addEventListener('change', () => { s.layer = layerInput.checked; try { storage?.setItem(LAYER_PREF, s.layer ? '1' : '0'); } catch { /* optional */ } pushMarks(); });
  const strictLabel = node('label'), strictInput = node('input'); strictInput.type = 'checkbox'; strictLabel.append(strictInput, document.createTextNode(' Строгая проверка: любая правка главы — «проверить»'));
  strictInput.addEventListener('change', () => setStrict(strictInput.checked));
  toggles.append(layerLabel, strictLabel);
  const tabs = node('div', 'narrative-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Разделы каркаса');
  const tabButtons = [['book', 'Общая линия'], ['chapter', 'Глава'], ['agent', 'Агент']].map(([id, label]) => {
    const tab = button(label, 'narrative-tab', () => { s.tab = id; render(); }); tab.setAttribute('role', 'tab'); tab.dataset.tab = id;
    tab.addEventListener('keydown', event => { if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return; const order = ['book', 'chapter', 'agent'], next = order[(order.indexOf(id) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; s.tab = next; render(); tabs.querySelector(`[data-tab="${next}"]`)?.focus(); });
    tabs.append(tab); return tab;
  });
  head.append(title, actions, summary, toggles, tabs);
  const body = node('div', 'narrative-body'); body.setAttribute('role', 'tabpanel');
  root.append(head, body);
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && s.expanded) { event.stopPropagation(); setExpanded(false); } });
  function setExpanded(value) { s.expanded = value; root.classList.toggle('narrative-expanded', value); document.body.classList.toggle('narrative-expanded-open', value); expandButton.textContent = value ? 'Свернуть' : 'Развернуть'; expandButton.setAttribute('aria-pressed', String(value)); if (value) expandButton.focus(); }

  // ---------- Data ----------
  // Every book switch starts a new load generation. Late replies compare book AND generation, so a reply from an
  // earlier opening of the same book (A → B → A) is recognised as obsolete.
  const isCurrent = (bookId, gen) => s.bookId === bookId && s.gen === gen;
  async function load(bookId) {
    if (bookId === s.bookId && (s.data || s.loading)) return;
    if (s.editing?.dirty) persistLocal();
    s.gen++; s.bookId = bookId || null; s.data = null; s.error = ''; s.editing = null; s.compare = null; s.closing = null; s.preview = null; s.focus.clear(); s.chapterId = null; s.draftTarget = ''; s.draftChapterId = null;
    if (!s.bookId) { render(); onBadgesChanged?.(); return; }
    await refresh();
  }
  async function refresh() {
    if (!s.bookId) return;
    const token = ++s.seq, bookId = s.bookId; s.loading = true; render();
    try { const data = await api(base()); if (token !== s.seq || bookId !== s.bookId) return; s.data = data; s.error = ''; }
    catch (error) { if (token !== s.seq || bookId !== s.bookId) return; s.error = error.message; }
    finally { if (token === s.seq) { s.loading = false; render(); onBadgesChanged?.(); void syncEditor(); } }
  }
  // Mutations reuse one operationId per logical action until a definite answer; a lost reply is resolved by reading
  // the operation receipt, never by replaying the decision with a new id.
  async function send(method, suffix, payload, retryKey) {
    const bookId = s.bookId, gen = s.gen, url = base(), operationId = ops.get(retryKey) ?? uid(); ops.set(retryKey, operationId);
    try {
      const result = await api(url + suffix, { method, body: { ...payload, operationId } });
      ops.delete(retryKey);
      // An obsolete opening of the same book re-reads instead of applying a snapshot older than its own load.
      if (isCurrent(bookId, gen)) { s.data = result.narrative; render(); onBadgesChanged?.(); void syncEditor(); }
      else if (bookId === s.bookId && !s.editing && !s.closing) void refresh();
      return result.receipt;
    } catch (error) {
      if (!error.status) {
        try { const known = await api(url + '/operations/' + encodeURIComponent(operationId)); ops.delete(retryKey); if (bookId === s.bookId) await refresh(); return known.receipt; }
        catch (lookup) { if (lookup.status === 404) throw new Error('Ответ сервера потерян, и операция на сервере не найдена. Повторите действие — будет использован тот же идентификатор операции.'); throw error; }
      }
      ops.delete(retryKey);
      throw error;
    }
  }
  const run = async (fn, success) => { try { const result = await fn(); if (success) notify(typeof success === 'function' ? success(result) : success); return result; } catch (error) { notify(error.message, true); return null; } };

  // ---------- Lookups ----------
  const chapters = () => s.data?.chapters ?? [];
  const chapterById = id => chapters().find(chapter => chapter.chapterId === id) ?? null;
  const identityOf = source => !source ? null : source.kind === 'document' ? documentIdentity(source.id) : source.kind === 'google' && s.data?.textSources?.google?.documentId ? googleIdentity(source.documentId ?? s.data.textSources.google.documentId, source.key) : null;
  const chapterForSource = source => { const identity = identityOf(source); return identity ? chapters().find(chapter => chapter.sourceIdentity === identity) ?? null : null; };
  const selectedChapter = () => s.followEditor ? chapterById(s.editorChapterId) : chapterById(s.chapterId);
  const evidenceFor = (planId, stage) => (s.data?.evidence ?? []).filter(item => item.planId === planId && item.stageId === stage.id && item.contentRevision === stage.contentRevision);
  const proposalsFor = (planId, stage) => (s.data?.proposals ?? []).filter(item => item.planId === planId && item.stageId === stage.id && item.contentRevision === stage.contentRevision && (item.state === 'pending' || item.state === 'stale'));
  const bookStage = id => findStage(s.data?.book?.activeSnapshot?.payload, id) ?? findStage(s.data?.book?.draft, id);

  // Counter for the table of contents and sidebar ("2 из 3 закрыто" / "План не согласован").
  function badgeFor(source) {
    const chapter = chapterForSource(source); if (!chapter) return null;
    return chapter.plan ? chapter.counter : { label: 'План не согласован', approved: false, stale: false };
  }

  // ---------- Editor sync and the stage layer ----------
  const editorKey = () => JSON.stringify([identityOf(s.editorSource), s.editorChapterId]);
  async function syncEditor() {
    const seq = ++s.syncSeq, editor = getEditor?.(), raw = editor?.get?.(), source = raw ? sourceFromEditorIdentity(raw.identity) : getEditorSource?.() ?? null;
    s.editorSource = source;
    const chapter = chapterForSource(source); s.editorChapterId = chapter?.chapterId ?? null;
    if (s.tab === 'chapter' && !s.editing && !s.closing && s.renderedEditorKey !== editorKey()) render();
    if (!editor?.setStageMarks || !raw) return;
    let hash = null; try { hash = await sha256Hex(raw.text, window.crypto); } catch { hash = null; }
    if (seq !== s.syncSeq) return;
    editor.setStageMarks(raw.identity, chapter ? marksFor(chapter, raw.text, hash) : [], { visible: s.layer });
  }
  function pushMarks() { void syncEditor(); }
  function marksFor(chapter, text, hash) {
    const savedHash = chapter.source?.hash, marks = [];
    const stageLabel = item => { const plan = item.planId === s.data?.book?.id ? s.data.book : chapters().find(c => c.plan?.id === item.planId)?.plan; const stage = findStage(plan?.activeSnapshot?.payload, item.stageId); return stage ? `«${stage.title}»` : 'Этап'; };
    const place = (item, tone, mark) => {
      // Offsets belong to the saved text. With unsaved local edits, verify the quote and downgrade at once.
      let start = mark.start, end = mark.end, pending = null;
      if (hash !== savedHash) {
        if (text.slice(start, end) !== mark.quote) { const at = text.indexOf(mark.quote); if (at < 0 || text.indexOf(mark.quote, at + 1) >= 0) return; start = at; end = at + mark.quote.length; }
        pending = text.slice(Math.max(0, start - mark.prefix.length), start) === mark.prefix && text.slice(end, end + mark.suffix.length) === mark.suffix ? 'historic' : 'review';
      }
      marks.push({ id: item.id, start, end, quote: mark.quote, prefixLength: mark.prefix.length, suffixLength: mark.suffix.length, tone, label: stageLabel(item), pending, strict: !!s.data?.strict });
    };
    const progress = new Map((s.data?.progress ?? []).map(row => [`${row.planId}|${row.stageId}|${row.contentRevision}`, row]));
    for (const item of s.data?.evidence ?? []) {
      if (item.chapterId !== chapter.chapterId || !LOCATED.has(item.location)) continue;
      const row = progress.get(`${item.planId}|${item.stageId}|${item.contentRevision}`), decided = row?.state === 'closed' && row.evidenceIds.includes(item.id);
      place(item, decided ? item.tone : 'progress', item);
    }
    for (const proposal of s.data?.proposals ?? []) {
      if (proposal.state !== 'pending' || proposal.chapterId !== chapter.chapterId || proposal.textHash !== savedHash) continue;
      for (const anchor of proposal.anchors) if (Number.isSafeInteger(anchor.start)) place({ ...proposal, id: proposal.id + ':' + anchor.start }, 'proposed', anchor);
    }
    return marks;
  }
  function onMarker({ ids }) {
    const evidenceIds = new Set(ids.map(id => id.split(':')[0]));
    const items = (s.data?.evidence ?? []).filter(item => evidenceIds.has(item.id));
    const proposals = (s.data?.proposals ?? []).filter(item => evidenceIds.has(item.id));
    const first = items[0] ?? proposals[0]; if (!first) return;
    s.tab = first.planId === s.data?.book?.id ? 'book' : 'chapter'; s.filters = { ...s.filters, state: '', showClosed: true };
    onOpenPanel?.(); render();
    const target = root.querySelector(`[data-stage-key="${CSS.escape(`${first.planId}|${first.stageId}`)}"]`);
    target?.scrollIntoView({ block: 'center' }); target?.focus?.();
  }

  // ---------- Rendering ----------
  function render() {
    for (const tab of tabButtons) { const selected = tab.dataset.tab === s.tab; tab.setAttribute('aria-selected', String(selected)); tab.classList.toggle('selected', selected); tab.tabIndex = selected ? 0 : -1; }
    strictInput.checked = !!s.data?.strict; strictInput.disabled = !s.data; refreshButton.disabled = !s.bookId || s.loading;
    summary.textContent = summaryText();
    body.replaceChildren();
    if (!s.bookId) { body.append(node('p', 'subtle-empty', 'Откройте книгу, чтобы задать общую линию и сюжетки глав.')); renderAttach(); return; }
    if (!s.data) { body.append(node('p', s.error ? 'narrative-error' : 'subtle-empty', s.error || 'Загружаю каркас…')); if (s.error) body.append(button('Повторить', '', () => refresh())); renderAttach(); return; }
    if (s.error) body.append(node('p', 'narrative-error', s.error));
    if (s.tab === 'book') renderBookTab();
    else if (s.tab === 'chapter') renderChapterTab();
    else renderAgentTab();
    renderAttach();
  }
  function summaryText() {
    if (!s.data) return s.bookId ? '' : 'Книга не выбрана';
    const book = s.data.book, chapter = selectedChapter();
    const parts = [book?.activeSnapshot ? `Согласовано: каркас v${book.activeSnapshot.version}` : 'Каркас книги не согласован'];
    if (chapter) parts.push(chapter.plan?.activeSnapshot ? `сюжетка «${short(chapter.title, 30)}» v${chapter.plan.activeSnapshot.version}${chapter.compatibility?.compatible === false ? ' · нужно согласовать связь' : ''}` : `«${short(chapter.title, 30)}»: сюжетка не согласована`);
    return parts.join(' · ');
  }
  const statusBadge = status => { const badge = node('span', 'narr-status narr-tone-' + status.tone); badge.append(node('span', 'narr-status-icon', status.icon), node('span', '', status.label)); badge.setAttribute('aria-label', 'Состояние: ' + status.label); return badge; };
  const section = (heading, cls = '') => { const box = node('section', 'narr-section ' + cls); if (heading) box.append(node('h3', '', heading)); return box; };

  function approvalHeader(plan, kind) {
    const box = section('', 'narr-approval');
    const active = plan.activeSnapshot;
    box.append(node('p', 'narr-version', active ? `Согласованная версия ${active.version} · ${date(active.approvedAt)} · sha256 ${active.hash.slice(0, 12)}…` : 'Согласованной версии пока нет — агент не получает этот план для работы по каркасу.'));
    box.append(node('p', 'narr-draft-state', `Черновик ${plan.draftVersion}${plan.draftStatus === 'review' ? ' · на согласовании' : ''} · ${plan.draftDiffersFromActive ? 'отличается от согласованной версии' : 'совпадает с согласованной версией'}`));
    const row = node('div', 'narr-actions');
    row.append(button('Изменить черновик', '', () => startEdit(kind, plan, plan.chapterId)));
    const reviewing = s.compare?.planId === plan.id && s.compare.review;
    if (plan.draftDiffersFromActive) {
      row.append(button(s.compare?.planId === plan.id && !reviewing ? 'Скрыть сравнение' : 'Сравнить версии', '', () => { s.compare = s.compare?.planId === plan.id && !reviewing ? null : { planId: plan.id, against: 'active' }; render(); }));
      if (plan.draftStatus !== 'review') row.append(button('Отправить на согласование', '', () => markReview(plan, kind)));
      const approveButton = button(reviewing ? 'Скрыть версию к согласованию' : 'Проверить и согласовать…', 'button button-primary', () => openApprovalReview(plan, reviewing));
      if (kind === 'chapter' && !s.data.book?.activeSnapshot) { approveButton.disabled = true; approveButton.title = 'Сначала согласуйте общую линию книги'; }
      row.append(approveButton);
    } else if (kind === 'chapter' && plan.activeSnapshot && selectedChapter()?.compatibility?.compatible === false) {
      row.append(button(reviewing ? 'Скрыть версию к согласованию' : 'Проверить и согласовать связь с новой версией каркаса…', 'button button-primary', () => openApprovalReview(plan, reviewing)));
    }
    if (plan.snapshots.length > 1) {
      const select = node('select', 'narr-history'); select.setAttribute('aria-label', 'Сравнить с прежней версией');
      select.append(new Option('Сравнить с прежней версией…', ''));
      for (const snapshot of plan.snapshots) select.append(new Option(`Версия ${snapshot.version} · ${date(snapshot.approvedAt)}`, snapshot.id));
      select.addEventListener('change', async () => { if (!select.value) return; const result = await run(() => api(base() + '/snapshots/' + encodeURIComponent(select.value))); if (result) { s.compare = { planId: plan.id, against: select.value, payload: result.snapshot.payload, version: result.snapshot.version }; render(); } });
      row.append(select);
    }
    box.append(row);
    if (s.compare?.planId === plan.id) box.append(reviewing ? approvalReview(plan, kind) : renderDiff(plan));
    return box;
  }

  // Exact values, not field names: the author approves only what is written out in full on the screen.
  const STAGE_DETAIL_FIELDS = ['expectedChange', 'closureCriterion', 'prerequisites', 'disclosureConstraints', 'participants', 'causality', 'parentStageIds', 'lineId'];
  const HEADER_FIELDS = { book: [['title', 'Название'], ['intent', 'Замысел'], ['outcome', 'Желаемый исход'], ['constraints', 'Ограничения']], chapter: [['title', 'Название сюжетки'], ['goal', 'Что меняется за главу'], ['outcome', 'Исход главы'], ['knowledgeBounds', 'Границы знания и раскрытия']] };
  function fieldText(payload, field, value) {
    if (field === 'prerequisites') return (value ?? []).map(id => `«${findStage(payload, id)?.title ?? id}»`).join(', ');
    if (field === 'parentStageIds') return (value ?? []).map(id => `«${bookStage(id)?.title ?? id}»`).join(', ');
    if (field === 'participants') return (value ?? []).join(', ');
    if (field === 'lineId') return value ? payload?.lines?.find(line => line.id === value)?.title ?? value : '';
    return String(value ?? '');
  }
  const valueNode = (tag, text) => node(tag, 'narr-value', text || '—');
  function stageDetails(payload, stage) {
    const list = node('dl', 'narr-stage-details');
    for (const field of STAGE_DETAIL_FIELDS) {
      if (field === 'lineId' && (payload?.lines ?? []).length < 2) continue;
      const text = fieldText(payload, field, stage[field]); if (!text) continue;
      list.append(node('dt', '', FIELD_LABELS[field] ?? field), node('dd', 'narr-value', text));
    }
    return list;
  }
  function renderDiff(plan) {
    const against = s.compare.against === 'active' ? plan.activeSnapshot?.payload : s.compare.payload;
    const box = node('div', 'narr-diff');
    box.append(node('h4', '', s.compare.against === 'active' ? 'Черновик против согласованной версии' : `Черновик против версии ${s.compare.version}`));
    box.append(diffList(stripPins(against), plan.draft, plan));
    return box;
  }
  function diffList(before, after, plan) {
    const diff = diffPlans(before, after);
    if (diff.empty) return node('p', 'subtle-empty', 'Отличий в содержании нет.');
    const list = node('ul', 'narr-diff-list');
    for (const item of diff.header) { const li = node('li'); li.append(node('strong', '', FIELD_LABELS[item.field] + ':'), node('span', 'narr-diff-was', 'было'), valueNode('del', item.before), node('span', 'narr-diff-was', 'стало'), valueNode('ins', item.after)); list.append(li); }
    if (diff.lines) {
      const li = node('li'), text = payload => (payload?.lines ?? []).map(line => line.title + (line.primary ? ' (основная)' : '')).join('; ');
      li.append(node('strong', '', 'Линии повествования:'), node('span', 'narr-diff-was', 'было'), valueNode('del', text(before)), node('span', 'narr-diff-was', 'стало'), valueNode('ins', text(after))); list.append(li);
    }
    const statuses = plan.statuses ?? {}, position = (payload, id) => (payload?.stages ?? []).findIndex(stage => stage.id === id) + 1;
    for (const item of diff.stages) {
      const label = { added: 'добавлен', removed: 'удалён из черновика', changed: 'изменён', moved: 'перемещён', archived: 'в архив', restored: 'возвращён из архива' }[item.change];
      const li = node('li', 'narr-diff-' + item.change); li.append(node('strong', '', `«${item.title}» — ${label}`));
      if (item.change === 'added') li.append(stageDetails(after, findStage(after, item.id)));
      else if (item.change === 'removed') li.append(stageDetails(before, findStage(before, item.id)));
      else {
        const old = findStage(before, item.id), next = findStage(after, item.id);
        for (const field of item.fields) {
          const row = node('div', 'narr-diff-field');
          row.append(node('span', '', (FIELD_LABELS[field] ?? field) + ':'), node('span', 'narr-diff-was', 'было'), valueNode('del', fieldText(before, field, old[field])), node('span', 'narr-diff-was', 'стало'), valueNode('ins', fieldText(after, field, next[field])));
          li.append(row);
        }
        if (item.moved) li.append(node('p', 'narr-meta', `Порядок: было ${position(before, item.id)}-м, стало ${position(after, item.id)}-м.`));
      }
      if (item.contentChanged) li.append(node('p', 'narr-warning', `Новая редакция r${item.afterRevision ?? '?'}: прежнее закрытие${statuses[item.id]?.state === 'closed' ? ' (этап закрыт)' : ''} к ней не перейдёт без решения автора.`));
      list.append(li);
    }
    return list;
  }
  // The complete server-issued draft that becomes the new immutable version, in author order.
  function candidateView(plan, kind) {
    const d = plan.draft, box = node('section', 'narr-candidate');
    box.append(node('h4', '', `Полный текст версии к согласованию: черновик ${plan.draftVersion} · sha256 ${String(plan.draftHash).slice(0, 12)}…`));
    const head = node('dl', 'narr-stage-details');
    for (const [key, label] of HEADER_FIELDS[kind]) head.append(node('dt', '', label), node('dd', 'narr-value', d[key] || '—'));
    if (kind === 'book') head.append(node('dt', '', 'Линии повествования'), node('dd', 'narr-value', (d.lines ?? []).map(line => line.title + (line.primary ? ' (основная)' : '')).join('; ') || '—'));
    box.append(head);
    const list = node('ol', 'narr-candidate-stages');
    for (const stage of d.stages ?? []) { const li = node('li', stage.archived ? 'is-archived' : ''); li.append(node('strong', '', stage.title + (stage.archived ? ' (в архиве)' : '')), stageDetails(d, stage)); list.append(li); }
    if (!list.children.length) list.append(node('li', 'subtle-empty', 'Этапов нет.'));
    box.append(list); return box;
  }
  function approvalReview(plan, kind) {
    // Everything below and the hash sent on approval come from this one server-issued plan object.
    const shown = { planId: plan.id, draftVersion: plan.draftVersion, draftHash: plan.draftHash, activeSnapshotId: plan.activeSnapshot?.id ?? null, bookSnapshotId: kind === 'chapter' ? s.data.book?.activeSnapshot?.id ?? null : undefined, draft: plan.draft };
    const box = node('div', 'narr-diff narr-review'); box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Версия к согласованию');
    box.append(node('h4', '', plan.activeSnapshot ? `Что изменится относительно согласованной версии ${plan.activeSnapshot.version}` : 'Первая согласованная версия'));
    if (plan.activeSnapshot) box.append(diffList(stripPins(plan.activeSnapshot.payload), plan.draft, plan));
    if (kind === 'chapter' && plan.activeSnapshot && !plan.draftDiffersFromActive) box.append(node('p', 'narr-hint', 'Содержание сюжетки не меняется: новая версия закрепит связь с текущими редакциями родительских этапов общей линии.'));
    box.append(candidateView(plan, kind));
    const approve = button(`Согласовать эту версию (черновик ${plan.draftVersion})`, 'button button-primary', () => approvePlan(shown, kind));
    if (kind === 'chapter' && !s.data.book?.activeSnapshot) { approve.disabled = true; approve.title = 'Сначала согласуйте общую линию книги'; }
    const row = node('div', 'narr-actions'); row.append(approve, button('Отмена', '', () => { s.compare = null; render(); }));
    box.append(row); return box;
  }

  function renderBookTab() {
    const plan = s.data.book;
    if (s.editing?.kind === 'book') { body.append(planEditor()); return; }
    if (!plan) {
      const box = section('Общая линия книги'); box.append(node('p', '', 'Замысел, желаемый исход, ограничения и этапы в авторском порядке. Согласованная версия неизменна; агент работает только по ней.'), button('Создать общую линию', 'button button-primary', () => startEdit('book', null)));
      body.append(box); return;
    }
    body.append(approvalHeader(plan, 'book'));
    const active = plan.activeSnapshot;
    const intro = section(active ? short(active.payload.title, 80) || 'Общая линия' : 'Черновик общей линии');
    const payload = active?.payload ?? plan.draft;
    for (const [label, value] of [['Замысел', payload.intent], ['Желаемый исход', payload.outcome], ['Ограничения', payload.constraints]]) if (value) { const p = node('p', 'narr-field'); p.append(node('strong', '', label + ': '), document.createTextNode(value)); intro.append(p); }
    body.append(intro);
    if (!active) { body.append(node('p', 'subtle-empty', 'Состояния этапов появятся после согласования показанной версии.'), stageListReadOnly(plan.draft)); return; }
    body.append(filters(payload), stageList(plan, 'book'));
  }
  function filters(payload) {
    const box = node('div', 'narr-filters'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Фильтр этапов');
    const line = node('select'); line.setAttribute('aria-label', 'Линия'); line.append(new Option('Все линии', ''));
    for (const item of payload.lines ?? []) line.append(new Option(item.title, item.id, false, s.filters.line === item.id));
    const state = node('select'); state.setAttribute('aria-label', 'Состояние'); for (const [value, label] of [['', 'Все состояния'], ['not_started', 'Не начат'], ['in_progress', 'В работе'], ['proposed', 'Проверить'], ['closed', 'Закрыт'], ['attention', 'Требует проверки']]) state.append(new Option(label, value, false, s.filters.state === value));
    const chapter = node('select'); chapter.setAttribute('aria-label', 'Глава'); chapter.append(new Option('Все главы', ''));
    for (const item of chapters().filter(c => !c.archived)) chapter.append(new Option(short(item.title, 40), item.chapterId, false, s.filters.chapter === item.chapterId));
    const closedLabel = node('label'), closed = node('input'); closed.type = 'checkbox'; closed.checked = s.filters.showClosed; closedLabel.append(closed, document.createTextNode(' Показать закрытые'));
    for (const [input, key] of [[line, 'line'], [state, 'state'], [chapter, 'chapter']]) input.addEventListener('change', () => { s.filters[key] = input.value; render(); });
    closed.addEventListener('change', () => { s.filters.showClosed = closed.checked; render(); });
    if ((payload.lines ?? []).length > 1) box.append(line);
    box.append(state, chapter, closedLabel); return box;
  }
  function visible(plan, stage, status, kind) {
    if (kind !== 'book') return true; // filters belong to the book line; a chapter plot always shows all its stages
    if (!s.filters.showClosed && status.state === 'closed') return false;
    if (s.filters.state === 'attention') { if (!['review', 'lost', 'historic'].includes(status.tone) && status.state !== 'proposed') return false; }
    else if (s.filters.state && status.state !== s.filters.state) return false;
    if (kind === 'book' && s.filters.line && stage.lineId !== s.filters.line) return false;
    if (s.filters.chapter) {
      const linked = evidenceFor(plan.id, stage).some(item => item.chapterId === s.filters.chapter) || (kind === 'book' && activeStages(chapterById(s.filters.chapter)?.plan?.activeSnapshot?.payload).some(child => child.parentStageIds.includes(stage.id)));
      if (!linked) return false;
    }
    return true;
  }
  function stageListReadOnly(payload) {
    const list = node('ol', 'narr-stage-list');
    for (const stage of activeStages(payload)) { const li = node('li', 'narr-stage narr-tone-none'); li.append(node('h4', '', stage.title), node('p', '', stage.expectedChange)); list.append(li); }
    if (!list.children.length) list.append(node('li', 'subtle-empty', 'Этапов пока нет.'));
    return list;
  }
  function stageList(plan, kind) {
    const list = node('ol', 'narr-stage-list'), payload = plan.activeSnapshot.payload;
    for (const stage of activeStages(payload)) {
      const status = plan.statuses[stage.id]; if (!status || !visible(plan, stage, status, kind)) continue;
      list.append(stageCard(plan, stage, status, kind));
    }
    if (!list.children.length) list.append(node('li', 'subtle-empty', 'Нет этапов по выбранному фильтру.'));
    return list;
  }
  function childrenOf(stageId) {
    return chapters().flatMap(chapter => chapter.plan?.activeSnapshot ? activeStages(chapter.plan.activeSnapshot.payload).filter(stage => stage.parentStageIds.includes(stageId)).map(stage => ({ chapter, stage, status: chapter.plan.statuses[stage.id] })) : []);
  }

  function stageCard(plan, stage, status, kind) {
    const key = `${plan.id}|${stage.id}`, card = node('li', 'narr-stage narr-tone-' + status.tone);
    card.dataset.stageKey = key; card.tabIndex = -1; card.setAttribute('aria-label', `${stage.title}: ${status.label}`);
    const top = node('div', 'narr-stage-head'); top.append(statusBadge(status), node('h4', '', stage.title), node('span', 'narr-revision', 'r' + stage.contentRevision));
    card.append(top, node('p', 'narr-expected', stage.expectedChange));
    if (stage.closureCriterion) { const p = node('p', 'narr-field'); p.append(node('strong', '', 'Критерий закрытия: '), document.createTextNode(stage.closureCriterion)); card.append(p); }
    const meta = [];
    if (kind === 'book') { const line = plan.activeSnapshot.payload.lines?.find(item => item.id === stage.lineId); if (line && plan.activeSnapshot.payload.lines.length > 1) meta.push('Линия: ' + line.title); }
    if (kind === 'chapter' && stage.parentStageIds.length) meta.push('Родительские этапы: ' + stage.parentStageIds.map(id => `«${bookStage(id)?.title ?? id}»`).join(', '));
    if (stage.prerequisites.length) meta.push('Предпосылки: ' + stage.prerequisites.map(id => `«${findStage(plan.activeSnapshot.payload, id)?.title ?? id}»`).join(', '));
    if (stage.disclosureConstraints) meta.push('Не раскрывать раньше: ' + short(stage.disclosureConstraints, 160));
    if (stage.participants.length) meta.push('Участники: ' + stage.participants.join(', '));
    if (kind === 'book') { const children = childrenOf(stage.id); if (children.length) meta.push('Раскрывается в главах: ' + [...new Set(children.map(child => child.chapter.title))].map(title => `«${short(title, 30)}»`).join(', ')); }
    for (const text of meta) card.append(node('p', 'narr-meta', text));
    if (kind === 'book' && status.state !== 'closed') {
      const children = childrenOf(stage.id);
      if (children.length && children.every(child => child.status?.state === 'closed')) card.append(node('p', 'narr-hint', 'Все связанные этапы глав закрыты. Общий этап закрывается только отдельным решением автора: проверьте его собственный критерий.'));
    }
    if (status.state === 'closed' && status.closure?.startsWith('no_fragment')) card.append(node('p', 'narr-hint', 'Подтверждено автором без фрагмента: в тексте нет зелёной метки.' + (status.closure === 'no_fragment_changed' ? ' Связанная глава изменилась после решения.' : '')));
    const evidence = evidenceFor(plan.id, stage);
    if (evidence.length) {
      const list = node('ul', 'narr-evidence');
      for (const item of evidence) list.append(evidenceItem(item));
      card.append(list);
    }
    for (const proposal of proposalsFor(plan.id, stage)) card.append(proposalCard(plan, stage, status, proposal));
    const row = node('div', 'narr-actions'), snapshotId = plan.activeSnapshot.id;
    const decide = (action, extra = {}) => run(() => send('POST', `/stages/${encodeURIComponent(stage.id)}/decision`, { planId: plan.id, snapshotId, contentRevision: stage.contentRevision, action, expectedProgressVersion: status.progressVersion, ...extra }, `decision:${key}:${stage.contentRevision}:${action}`),
      { start: 'Этап в работе.', close: 'Закрытие этапа подтверждено.', reopen: 'Этап возвращён в работу; история решения сохранена.' }[action]);
    if (status.stored === 'not_started') row.append(button('Начать', '', () => decide('start')));
    if (status.stored !== 'closed') {
      row.append(button('Связать с выделением', '', () => linkSelection(plan, stage)));
      row.append(button('Подтвердить закрытие…', 'button button-primary', () => { s.closing = s.closing === key ? null : key; render(); }));
    } else row.append(button('Вернуть в работу', '', async () => { if (await ask('Вернуть этап в работу?', 'Решение о закрытии останется в истории, счётчик главы изменится.', 'Вернуть в работу') === 'confirm') decide('reopen'); }));
    card.append(row);
    if (s.closing === key) card.append(closeForm(plan, stage, status, evidence, decide));
    return card;
  }
  function evidenceItem(item) {
    const li = node('li', 'narr-evidence-item narr-tone-' + item.tone), chapter = chapterById(item.chapterId);
    const head = node('span', 'narr-evidence-head', `${TONE_LABELS[item.tone] ?? item.tone} · «${short(chapter?.title, 30)}»${item.origin === 'agent-proposal' ? ' · из предложения агента' : ''}`);
    const quote = node('blockquote', '', s.openQuote.has(item.id) ? item.quote : short(item.quote, 160));
    li.append(head, quote, node('span', 'narr-reason', item.reason ?? ''));
    const row = node('span', 'narr-inline-actions');
    if (LOCATED.has(item.location)) row.append(button('Перейти', 'text-action', () => goTo(item), 'Перейти к фрагменту: ' + short(item.quote, 40)));
    if (item.quote.length > 160) row.append(button(s.openQuote.has(item.id) ? 'Свернуть цитату' : 'Показать цитату', 'text-action', () => { if (s.openQuote.has(item.id)) s.openQuote.delete(item.id); else s.openQuote.add(item.id); render(); }));
    row.append(button('Отвязать', 'text-action', () => run(() => send('POST', `/evidence/${encodeURIComponent(item.id)}/retire`, {}, 'retire:' + item.id), 'Фрагмент отвязан; история сохранена.')));
    li.append(row); return li;
  }
  function proposalCard(plan, stage, status, proposal) {
    const box = node('div', 'narr-proposal narr-proposal-' + proposal.state);
    box.append(node('strong', '', proposal.state === 'pending' ? 'Агент предлагает закрыть этап (квитанция ' + proposal.id.slice(0, 8) + ')' : 'Предложение устарело: ' + (proposal.reason ?? '')));
    box.append(node('p', '', proposal.rationale));
    for (const anchor of proposal.anchors) box.append(node('blockquote', '', short(anchor.quote, 240)));
    const row = node('div', 'narr-actions');
    if (proposal.state === 'pending') {
      const anchor = proposal.anchors.find(item => Number.isSafeInteger(item.start));
      if (anchor) row.append(button('Перейти к цитате', 'text-action', () => goTo({ chapterId: proposal.chapterId, start: anchor.start, end: anchor.end, quote: anchor.quote, location: 'exact' })));
      row.append(button('Принять и закрыть', 'button button-primary', async () => { if (await ask('Принять предложение агента?', 'Сервер перепроверит цитаты по текущему сохранённому тексту и согласованной версии. Этап будет закрыт вашим решением.', 'Принять') === 'confirm') run(() => send('POST', `/proposals/${encodeURIComponent(proposal.id)}/accept`, { expectedProgressVersion: status.progressVersion }, 'accept:' + proposal.id), receipt => receipt?.accepted ? 'Предложение принято, этап закрыт.' : 'Предложение устарело: ' + (receipt?.reason ?? '')); }));
    }
    row.append(button('Отклонить', '', () => run(() => send('POST', `/proposals/${encodeURIComponent(proposal.id)}/reject`, {}, 'reject:' + proposal.id), 'Предложение отклонено.')));
    box.append(row); return box;
  }
  function closeForm(plan, stage, status, evidence, decide) {
    const form = node('form', 'narr-close-form'), usable = evidence.filter(item => LOCATED.has(item.location) && item.tone !== 'lost');
    form.append(node('p', 'narr-hint', `Решение закрывает только редакцию r${stage.contentRevision}. Общий этап книги не закрывается автоматически.`));
    const checks = [];
    if (usable.length) {
      const set = node('fieldset'); set.append(node('legend', '', 'Фрагменты-доказательства'));
      for (const item of usable.slice(0, NARRATIVE_LIMITS.anchorsPerDecision)) { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.value = item.id; input.checked = true; checks.push(input); label.append(input, document.createTextNode(` «${short(item.quote, 90)}» — ${TONE_LABELS[item.tone]}`)); set.append(label); }
      form.append(set);
    } else form.append(node('p', 'subtle-empty', 'Связанных фрагментов нет. Выделите текст и нажмите «Связать с выделением» или закройте без фрагмента.'));
    const noneLabel = node('label', 'narr-check'), none = node('input'); none.type = 'checkbox'; none.checked = !usable.length; noneLabel.append(none, document.createTextNode(' Закрыть без фрагмента (подтверждено автором)'));
    const reason = node('textarea'); reason.rows = 2; reason.maxLength = 2000; reason.placeholder = 'Почему этап выполнен (обязательно без фрагмента)'; reason.setAttribute('aria-label', 'Пояснение решения');
    const basis = node('fieldset', 'narr-basis'); basis.append(node('legend', '', 'Связанные главы (их изменение будет отмечено)'));
    const basisChecks = chapters().filter(chapter => chapter.source.hash).slice(0, 50).map(chapter => { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.value = chapter.chapterId; label.append(input, document.createTextNode(' ' + short(chapter.title, 50))); basis.append(label); return input; });
    const sync = () => { basis.hidden = !none.checked; for (const input of checks) input.disabled = none.checked; };
    none.addEventListener('change', sync); sync();
    const submit = node('button', 'button button-primary', 'Подтвердить закрытие'); submit.type = 'submit';
    form.append(noneLabel, reason, basis, submit, button('Отмена', '', () => { s.closing = null; render(); }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (none.checked) {
        if (!reason.value.trim()) { notify('Для закрытия без фрагмента напишите пояснение.', true); reason.focus(); return; }
        const picked = basisChecks.filter(input => input.checked).map(input => input.value);
        if (picked.length > NARRATIVE_LIMITS.basisChapters) { notify(`Выберите не больше ${NARRATIVE_LIMITS.basisChapters} глав.`, true); return; }
        if (await decide('close', { evidenceIds: [], reason: reason.value.trim(), basisChapterIds: picked })) s.closing = null;
      } else {
        const ids = checks.filter(input => input.checked).map(input => input.value);
        if (!ids.length) { notify('Отметьте хотя бы один фрагмент или выберите закрытие без фрагмента.', true); return; }
        if (await decide('close', { evidenceIds: ids, reason: reason.value.trim() })) s.closing = null;
      }
      render();
    });
    return form;
  }

  // ---------- Evidence from the editor selection ----------
  async function linkSelection(plan, stage) {
    const editor = getEditor?.(), value = editor?.get?.();
    if (!value) { notify('Откройте главу рукописи или локальный черновик и выделите фрагмент.', true); return; }
    const { start, end } = value.selection;
    if (end <= start) { notify('Выделите фрагмент текста, который подтверждает этап.', true); return; }
    const source = sourceFromEditorIdentity(value.identity), chapter = chapterForSource(source);
    if (!source) { notify('Этот текст ещё не сохранён на сервере. Дождитесь сохранения черновика.', true); return; }
    if (!chapter) { notify('Открытый текст не привязан к главе каркаса. Привяжите его на вкладке «Глава».', true); s.tab = 'chapter'; render(); return; }
    const quote = value.text.slice(start, end);
    try { await flushSource?.(source); } catch (error) { notify('Глава не сохранена: ' + error.message + ' Выделение и текст остались в редакторе.', true); return; }
    const after = getEditor?.()?.get?.();
    if (!after || after.identity !== value.identity || after.text !== value.text) { notify('Текст изменился во время сохранения. Выделите фрагмент ещё раз.', true); return; }
    const textHash = await sha256Hex(value.text, window.crypto);
    await run(() => send('POST', `/stages/${encodeURIComponent(stage.id)}/evidence`, { planId: plan.id, snapshotId: plan.activeSnapshot.id, contentRevision: stage.contentRevision, chapterId: chapter.chapterId, textHash, start, end, quote }, `evidence:${plan.id}:${stage.id}:${chapter.chapterId}:${start}:${end}:${textHash}`), 'Фрагмент связан с этапом. Закрытие подтверждается отдельным решением.');
  }
  async function goTo(item) {
    const chapter = chapterById(item.chapterId), ref = chapter?.source?.ref;
    if (!ref || !LOCATED.has(item.location)) { s.openQuote.add(item.id); render(); notify('Фрагмент не найден в текущем тексте; в карточке показана сохранённая цитата.', true); return; }
    const opened = await openSource?.(ref);
    if (!opened) { notify(ref.kind === 'google' ? 'Загрузите эту главу в редактор из оглавления, затем повторите переход.' : 'Не удалось открыть черновик.', true); return; }
    const editor = getEditor?.(), value = editor?.get?.();
    if (!value || identityOf(sourceFromEditorIdentity(value.identity)) !== chapter.sourceIdentity) { notify('Открыт другой текст.', true); return; }
    let { start, end } = item;
    if (value.text.slice(start, end) !== item.quote) {
      const at = value.text.indexOf(item.quote);
      if (at < 0 || value.text.indexOf(item.quote, at + 1) >= 0) { notify('В редакторе есть несохранённые правки; фрагмент нельзя показать однозначно.', true); return; }
      start = at; end = at + item.quote.length; notify('Текст в редакторе изменён после сохранения; позиция предварительная.');
    }
    editor.select(start, end);
  }

  // ---------- Draft editor ----------
  // Every editor instance owns the full storage key of its book and plan, fixed when it opens, and marks the record
  // with its own id. Late replies and timers touch only that instance and only a record it still owns — never the
  // book, form or newer editor of the same plan that is open by then.
  // The latest editor opened for a key owns its record (restoring hands the record over); an older instance — a late
  // reply after A → B → A — writes nothing over it and returns false.
  const localKey = key => `${DRAFT_PREFIX}${s.bookId}.${key}`;
  const owners = new Map();
  function persistLocal(e = s.editing) { if (!e || e.done || owners.get(e.storageKey) !== e.id) return false; try { storage?.setItem(e.storageKey, JSON.stringify({ editorId: e.id, baseVersion: e.baseVersion, planId: e.planId, draft: e.draft, savedAt: new Date().toISOString() })); return true; } catch { /* recovery is best effort; the editor keeps the input */ return false; } }
  function clearLocal(e) {
    try {
      let stored = null; try { stored = JSON.parse(storage?.getItem(e.storageKey) || 'null'); } catch { /* unreadable record */ }
      if (!stored || stored.editorId === undefined || stored.editorId === e.id) storage?.removeItem(e.storageKey);
    } catch { /* optional */ }
  }
  let persistTimer = null;
  const touched = () => { const e = s.editing; e.dirty = true; e.revision = (e.revision ?? 0) + 1; clearTimeout(persistTimer); persistTimer = setTimeout(() => persistLocal(e), 300); };
  function startEdit(kind, plan, chapterId = null) {
    if (s.editing?.dirty && s.editing.key !== (kind === 'book' ? 'book' : 'chapter:' + chapterId)) { notify('Сначала сохраните или отмените открытый черновик.', true); return; }
    const key = kind === 'book' ? 'book' : 'chapter:' + chapterId, storageKey = localKey(key);
    let restored = null; try { restored = JSON.parse(storage?.getItem(storageKey) || 'null'); } catch { restored = null; }
    const usable = restored && restored.draft?.kind === kind && (!plan || restored.planId === plan.id);
    s.editing = { id: uid(), key, storageKey, bookId: s.bookId, kind, planId: plan?.id ?? uid(), chapterId, draft: structuredClone(usable ? restored.draft : plan?.draft ?? emptyDraft(kind, chapterId, uid)), baseVersion: plan?.draftVersion ?? 0, dirty: !!usable, conflict: usable && plan && restored.baseVersion !== plan.draftVersion ? 'Восстановлен ввод, сделанный поверх более старой версии черновика. Сравните его с серверной версией перед сохранением.' : null };
    owners.set(storageKey, s.editing.id);
    if (usable) { persistLocal(s.editing); notify('Восстановлен несохранённый ввод черновика из браузера.'); }
    s.compare = null; render();
  }
  async function cancelEdit() {
    const e = s.editing; if (!e) return;
    if (e.dirty && await ask('Отменить правки черновика?', 'Несохранённые изменения плана будут удалены из браузера.', 'Отменить правки') !== 'confirm') return;
    if (s.editing !== e) return;
    e.done = true; clearLocal(e); s.editing = null; render();
  }
  const field = (label, value, onInput, { multiline = false, max = 4000, required = false } = {}) => {
    const wrap = node('label', 'narr-input'), input = node(multiline ? 'textarea' : 'input');
    if (multiline) input.rows = 2; input.value = value ?? ''; input.maxLength = max; if (required) input.required = true;
    input.addEventListener('input', () => { onInput(input.value); touched(); });
    wrap.append(node('span', '', label + (required ? ' *' : '')), input); return wrap;
  };
  function planEditor() {
    const e = s.editing, d = e.draft, form = node('form', 'narr-editor'), plan = e.kind === 'book' ? s.data.book : chapterById(e.chapterId)?.plan, active = plan?.activeSnapshot?.payload;
    form.setAttribute('aria-label', e.kind === 'book' ? 'Черновик общей линии' : 'Черновик сюжетки главы');
    form.append(node('h3', '', e.kind === 'book' ? 'Черновик общей линии' : `Черновик сюжетки: «${short(chapterById(e.chapterId)?.title, 50)}»`));
    form.append(node('p', 'narr-hint', 'Изменение черновика не меняет согласованную версию: агент получает прежний снимок, пока вы не согласуете новый.'));
    if (e.conflict) {
      const box = node('div', 'narr-conflict'); box.setAttribute('role', 'alert'); box.append(node('p', '', e.conflict));
      if (plan) box.append(button(s.compare?.planId === 'local' ? 'Скрыть отличия' : 'Показать отличия от серверной версии', '', () => { s.compare = s.compare?.planId === 'local' ? null : { planId: 'local' }; render(); }), button('Скачать мой ввод', '', () => download(`talewisp-черновик-плана-${Date.now()}.json`, JSON.stringify(e.draft, null, 2))), button('Загрузить серверную версию', '', async () => { if (await ask('Заменить ввод серверной версией?', 'Скачайте свой ввод, если он нужен: он будет удалён из браузера.', 'Загрузить') !== 'confirm' || s.editing !== e) return; e.done = true; clearLocal(e); s.editing = null; await refresh(); if (s.bookId === e.bookId && !s.editing && s.data) startEdit(e.kind, e.kind === 'book' ? s.data.book : chapterById(e.chapterId)?.plan, e.chapterId); }));
      if (s.compare?.planId === 'local' && plan) { const diff = diffPlans(plan.draft, d), list = node('ul', 'narr-diff'); for (const item of diff.header) list.append(node('li', '', `${FIELD_LABELS[item.field]}: сервер «${short(item.before, 80)}» → ваш ввод «${short(item.after, 80)}»`)); for (const item of diff.stages) list.append(node('li', '', `«${short(item.title, 50)}»: ${item.change}${item.fields.length ? ' (' + item.fields.map(f => FIELD_LABELS[f] ?? f).join(', ') + ')' : ''}`)); if (diff.empty) list.append(node('li', '', 'Отличий нет.')); box.append(list); }
      form.append(box);
    }
    const headFields = e.kind === 'book' ? [['title', 'Название линии книги', false], ['intent', 'Замысел', true], ['outcome', 'Желаемый исход', true], ['constraints', 'Ограничения', true]] : [['title', 'Название сюжетки', false], ['goal', 'Что меняется за главу', true], ['outcome', 'Исход главы', true], ['knowledgeBounds', 'Границы знания и раскрытия', true]];
    const headBox = node('details', 'narr-editor-head'); headBox.open = !d.stages.length || !!active === false; headBox.append(node('summary', '', e.kind === 'book' ? 'Замысел и ограничения' : 'Цель и границы главы'));
    for (const [key, label, multiline] of headFields) headBox.append(field(label, d[key], value => { d[key] = value; }, { multiline, max: key === 'title' ? 300 : 4000 }));
    form.append(headBox);
    if (e.kind === 'book') {
      const lines = node('fieldset', 'narr-lines'); lines.append(node('legend', '', 'Линии повествования'));
      for (const line of d.lines) {
        const row = node('div', 'narr-line-row');
        row.append(field('Линия', line.title, value => { line.title = value; }, { max: 300, required: true }));
        const primaryLabel = node('label', 'narr-check'), primary = node('input'); primary.type = 'radio'; primary.name = 'narr-primary-line'; primary.checked = line.primary; primary.addEventListener('change', () => { for (const item of d.lines) item.primary = item === line; touched(); }); primaryLabel.append(primary, document.createTextNode(' основная'));
        row.append(primaryLabel);
        if (d.lines.length > 1 && !d.stages.some(stage => stage.lineId === line.id)) row.append(button('Удалить линию', 'text-action', () => { d.lines = d.lines.filter(item => item !== line); touched(); render(); }));
        lines.append(row);
      }
      if (d.lines.length < NARRATIVE_LIMITS.lines) lines.append(button('+ Линия', 'text-action', () => { d.lines.push({ id: uid(), title: 'Новая линия', primary: false }); touched(); render(); }));
      form.append(lines);
    }
    const list = node('ol', 'narr-edit-stages');
    d.stages.forEach((stage, index) => list.append(stageEditor(stage, index, active)));
    form.append(node('h4', '', `Этапы в авторском порядке (${d.stages.length})`), list);
    const limit = e.kind === 'book' ? NARRATIVE_LIMITS.bookStages : NARRATIVE_LIMITS.chapterStages;
    const add = button('+ Добавить этап', '', () => { if (d.stages.length >= limit) { notify(`Не больше ${limit} этапов.`, true); return; } d.stages.push({ id: uid(), lineId: e.kind === 'book' ? (d.lines.find(line => line.primary) ?? d.lines[0])?.id ?? null : null, title: '', expectedChange: '', closureCriterion: '', participants: [], prerequisites: [], disclosureConstraints: '', causality: '', parentStageIds: [], archived: false }); touched(); render(); root.querySelector('.narr-edit-stage:last-child input')?.focus(); });
    const reviewLabel = node('label', 'narr-check'), review = node('input'); review.type = 'checkbox'; review.checked = plan?.draftStatus === 'review'; reviewLabel.append(review, document.createTextNode(' Отметить «на согласовании»'));
    const save = node('button', 'button button-primary', 'Сохранить черновик'); save.type = 'submit';
    const row = node('div', 'narr-actions'); row.append(add, reviewLabel, save, button('Отменить', '', () => cancelEdit()));
    form.append(row);
    form.addEventListener('submit', async event => { event.preventDefault(); await saveDraft(review.checked ? 'review' : 'draft'); });
    return form;
  }
  function stageEditor(stage, index, active) {
    const e = s.editing, d = e.draft, li = node('li', 'narr-edit-stage' + (stage.archived ? ' is-archived' : '')), approved = findStage(active, stage.id);
    li.append(field('Название этапа', stage.title, value => { stage.title = value; }, { max: 300, required: true }));
    li.append(field('Ожидаемое изменение', stage.expectedChange, value => { stage.expectedChange = value; }, { multiline: true, required: true }));
    const more = node('details', 'narr-more'); more.append(node('summary', '', 'Критерий, предпосылки, участники, запреты раскрытия'));
    more.append(field('Критерий закрытия', stage.closureCriterion, value => { stage.closureCriterion = value; }, { multiline: true }));
    more.append(field('Участники (через запятую)', stage.participants.join(', '), value => { stage.participants = value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 30); }, { max: 2000 }));
    more.append(field('Не раскрывать раньше / запреты', stage.disclosureConstraints, value => { stage.disclosureConstraints = value; }, { multiline: true }));
    more.append(field('Причина и последствие (свободно)', stage.causality, value => { stage.causality = value; }, { multiline: true, max: 2000 }));
    if (e.kind === 'book' && d.lines.length > 1) { const select = node('select'); select.setAttribute('aria-label', 'Линия этапа'); for (const line of d.lines) select.append(new Option(line.title, line.id, false, line.id === stage.lineId)); select.addEventListener('change', () => { stage.lineId = select.value; touched(); }); more.append(select); }
    const others = d.stages.filter(item => item.id !== stage.id && !item.archived);
    if (others.length) { const set = node('fieldset'); set.append(node('legend', '', 'Предпосылки')); for (const other of others) { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.checked = stage.prerequisites.includes(other.id); input.addEventListener('change', () => { stage.prerequisites = input.checked ? [...stage.prerequisites, other.id] : stage.prerequisites.filter(id => id !== other.id); touched(); }); label.append(input, document.createTextNode(' ' + (other.title || 'без названия'))); set.append(label); } more.append(set); }
    if (e.kind === 'chapter') {
      const parents = activeStages(s.data.book?.activeSnapshot?.payload), set = node('fieldset'); set.append(node('legend', '', 'Родительские этапы общей линии'));
      if (!parents.length) set.append(node('p', 'subtle-empty', 'Сначала согласуйте общую линию книги.'));
      for (const parent of parents) { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.checked = stage.parentStageIds.includes(parent.id); input.addEventListener('change', () => { stage.parentStageIds = input.checked ? [...stage.parentStageIds, parent.id] : stage.parentStageIds.filter(id => id !== parent.id); touched(); }); label.append(input, document.createTextNode(` ${parent.title} (r${parent.contentRevision})`)); set.append(label); }
      more.append(set);
    }
    li.append(more);
    if (approved) {
      const renamedOnly = approved.title !== stage.title && stageFingerprint({ ...approved, title: '' }) === stageFingerprint({ ...stage, title: '' });
      const closed = (e.kind === 'book' ? s.data.book : chapterById(e.chapterId)?.plan)?.statuses?.[stage.id]?.state === 'closed';
      if (renamedOnly) { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.checked = stage.preserveRevision === true; input.addEventListener('change', () => { stage.preserveRevision = input.checked; touched(); }); label.append(input, document.createTextNode(' Только переименование: сохранить прежнюю редакцию и закрытие')); li.append(label); }
      else if (closed && stageFingerprint(approved) !== stageFingerprint(stage)) li.append(node('p', 'narr-warning', 'Смысл этапа изменён: появится новая редакция, прежнее закрытие к ней не перейдёт.'));
    }
    const row = node('div', 'narr-inline-actions');
    const move = delta => { const next = index + delta; if (next < 0 || next >= d.stages.length) return; [d.stages[index], d.stages[next]] = [d.stages[next], d.stages[index]]; touched(); render(); root.querySelectorAll('.narr-edit-stage')[next]?.querySelector('input')?.focus(); };
    row.append(button('↑', 'text-action', () => move(-1), 'Переместить выше: ' + (stage.title || 'этап')), button('↓', 'text-action', () => move(1), 'Переместить ниже: ' + (stage.title || 'этап')));
    row.append(button(stage.archived ? 'Вернуть из архива' : 'В архив', 'text-action', () => { stage.archived = !stage.archived; touched(); render(); }));
    if (!approved) row.append(button('Удалить', 'text-action', () => { d.stages.splice(index, 1); for (const item of d.stages) { item.prerequisites = item.prerequisites.filter(id => id !== stage.id); } touched(); render(); }));
    li.append(row); return li;
  }
  async function saveDraft(status) {
    const e = s.editing; if (!e || e.saving) return;
    const payload = { expectedVersion: e.baseVersion, kind: e.kind, ...(e.kind === 'chapter' ? { chapterId: e.chapterId } : {}), draft: structuredClone(e.draft), status };
    const sentRevision = e.revision ?? 0;
    // Keep recovery input in this editor's own key while the request is in flight.
    e.saving = true; clearTimeout(persistTimer); if (e.dirty) persistLocal(e);
    try {
      const receipt = await send('PUT', `/${encodeURIComponent(e.planId)}/draft`, payload, `draft:${e.planId}:${e.baseVersion}`);
      if (!e.done && (e.revision ?? 0) !== sentRevision) {
        // Typed into this form while the save was in flight: keep it open on top of the saved version.
        e.baseVersion = receipt.draftVersion; const kept = persistLocal(e);
        notify(`Черновик сохранён (версия ${receipt.draftVersion}); ` + (s.editing === e ? 'правки, сделанные во время сохранения, остались в форме.' : kept ? 'правки, сделанные во время сохранения, сохранены в браузере и восстановятся при открытии черновика.' : 'открытая сейчас форма черновика не изменена.'));
        return;
      }
      e.done = true; clearLocal(e);
      if (s.editing === e) { s.editing = null; render(); }
      notify(`Черновик сохранён (версия ${receipt.draftVersion}). Согласованная версия не изменилась.`);
    } catch (error) {
      if (error.status === 409) {
        e.conflict = error.message; persistLocal(e);
        if (s.editing === e && s.bookId === e.bookId) { await refresh(); if (s.editing === e) render(); }
      } else if (e.dirty) persistLocal(e);
      notify(error.message, true);
    } finally { e.saving = false; }
  }
  async function markReview(plan, kind) {
    await run(() => send('PUT', `/${encodeURIComponent(plan.id)}/draft`, { expectedVersion: plan.draftVersion, kind, ...(kind === 'chapter' ? { chapterId: plan.chapterId } : {}), draft: plan.draft, status: 'review' }, `review:${plan.id}:${plan.draftVersion}`), 'Черновик отмечен «на согласовании».');
  }
  function openApprovalReview(plan, reviewing) {
    if (reviewing) { s.compare = null; render(); return; }
    if (s.editing?.dirty) { notify('Сначала сохраните или отмените правки черновика.', true); return; }
    s.compare = { planId: plan.id, against: 'active', review: true }; render();
    root.querySelector('.narr-review')?.scrollIntoView?.({ block: 'start' });
  }
  const planById = id => s.data?.book?.id === id ? s.data.book : chapters().find(chapter => chapter.plan?.id === id)?.plan ?? null;
  // `shown` is the server-issued draft rendered in the review; approval never sends a hash the author has not seen.
  const stillShown = shown => { const plan = planById(shown.planId); return !!plan && s.compare?.planId === shown.planId && s.compare.review && plan.draftHash === shown.draftHash && plan.draftVersion === shown.draftVersion && (plan.activeSnapshot?.id ?? null) === shown.activeSnapshotId && (shown.bookSnapshotId === undefined || (s.data.book?.activeSnapshot?.id ?? null) === shown.bookSnapshotId); };
  async function approvePlan(shown, kind) {
    if (s.editing?.dirty) { notify('Сначала сохраните или отмените правки черновика.', true); return; }
    const bookId = s.bookId, gen = s.gen, plan = planById(shown.planId);
    if (!stillShown(shown)) { notify('Черновик или согласованная версия изменились. Проверьте показанную версию заново.', true); render(); return; }
    const diff = diffPlans(stripPins(plan.activeSnapshot?.payload), shown.draft);
    const lost = diff.stages.filter(item => item.contentChanged && plan.statuses?.[item.id]?.state === 'closed').map(item => `«${item.title}»`);
    const copy = `Будет создана неизменяемая версия ${(plan.activeSnapshot?.version ?? 0) + 1} ровно из показанного черновика ${shown.draftVersion} (sha256 ${String(shown.draftHash).slice(0, 12)}…). Изменений этапов: ${diff.stages.length}.${lost.length ? ' Закрытия не перейдут к новым редакциям: ' + lost.join(', ') + '.' : ''}${kind === 'book' ? ' Сюжетки глав не согласуются молча: несовместимые получат «Нужно согласовать связь».' : ''}`;
    if (await ask('Согласовать показанную версию?', copy, 'Согласовать') !== 'confirm') return;
    if (!isCurrent(bookId, gen) || !stillShown(shown)) { notify('Пока открыт диалог, черновик или каркас изменились. Ничего не согласовано; проверьте показанную версию заново.', true); render(); return; }
    const body = { expectedDraftVersion: shown.draftVersion, shownHash: shown.draftHash, expectedActiveSnapshotId: shown.activeSnapshotId, ...(kind === 'chapter' ? { expectedBookSnapshotId: shown.bookSnapshotId } : {}) };
    const receipt = await run(() => send('POST', `/${encodeURIComponent(shown.planId)}/approve`, body, `approve:${shown.planId}:${shown.draftHash}:${body.expectedBookSnapshotId ?? ''}`));
    if (!receipt) return;
    if (isCurrent(bookId, gen) && s.compare?.planId === shown.planId) { s.compare = null; render(); }
    notify(`Согласована версия ${receipt.version}.` + (receipt.affectedChapters?.length ? ` Нужно согласовать связь для глав: ${receipt.affectedChapters.map(item => `«${chapterById(item.chapterId)?.title ?? item.chapterId}»`).join(', ')}.` : ''));
  }

  // ---------- Chapter tab ----------
  function renderChapterTab() {
    if (s.editing?.kind === 'chapter') { body.append(planEditor()); return; }
    const pick = section('', 'narr-chapter-pick'), select = node('select'); select.setAttribute('aria-label', 'Глава каркаса');
    select.append(new Option('Следовать за открытым текстом', '__follow', false, s.followEditor));
    for (const chapter of chapters().filter(item => !item.archived)) select.append(new Option(`${short(chapter.title, 50)} — ${chapter.plan ? chapter.counter.label : 'нет сюжетки'}`, chapter.chapterId, false, !s.followEditor && s.chapterId === chapter.chapterId));
    select.addEventListener('change', () => { s.followEditor = select.value === '__follow'; s.chapterId = s.followEditor ? null : select.value; render(); });
    pick.append(node('h3', '', 'Глава'), select);
    pick.append(editorBindingBox());
    body.append(pick);
    const chapter = selectedChapter(); s.renderedEditorKey = editorKey();
    if (chapter) body.append(chapterCard(chapter));
    else body.append(node('p', 'subtle-empty', s.followEditor ? 'Открытый текст не связан с главой каркаса. Выберите главу в списке или привяжите текст.' : 'Выберите главу каркаса.'));
    body.append(plannedList());
  }
  function editorBindingBox() {
    const box = node('div', 'narr-editor-binding'), source = s.editorSource, editor = getEditor?.()?.get?.();
    if (!source) { box.append(node('p', 'narr-hint', editor ? 'Открытый текст ещё не сохранён на сервере или не является главой.' : 'В редакторе нет главы или черновика.')); return box; }
    const bound = chapterForSource(source), sourceTitle = source.kind === 'document' ? (s.data.textSources.documents.find(doc => doc.id === source.id)?.title ?? 'черновик') : (s.data.textSources.google?.chapters?.find(item => item.key === source.key)?.title ?? 'глава рукописи');
    box.append(node('p', '', `Открыт текст: «${short(sourceTitle, 50)}» (${source.kind === 'document' ? 'локальный черновик' : 'глава Google'}) — ${bound ? `глава каркаса «${short(bound.title, 40)}»` : 'не привязан к главе каркаса'}.`));
    if (!bound) {
      const row = node('div', 'narr-actions'), target = s.followEditor ? null : chapterById(s.chapterId);
      if (target) row.append(button(`Привязать к «${short(target.title, 30)}»`, '', () => bindTo(target, source)));
      row.append(button('Создать главу каркаса для этого текста', '', async () => { const receipt = await run(() => send('POST', '/chapters', { title: sourceTitle || 'Глава', order: chapters().length }, 'chapter-create:' + identityOf(source))); if (receipt) await bindTo(chapterById(receipt.chapterId), source); }));
      box.append(row);
    }
    return box;
  }
  async function bindTo(chapter, source, { confirmReplace = false } = {}) {
    if (!chapter) return;
    if (chapter.binding && !confirmReplace) {
      if (await ask('Заменить привязку главы?', 'Доказательства закрытия не переносятся на другой текст: прежние фрагменты останутся в истории с пометкой «Привязка потеряна».', 'Заменить привязку') !== 'confirm') return;
      confirmReplace = true;
    }
    if (source.kind === 'google') try { await flushSource?.(source); } catch (error) { notify(error.message, true); return; }
    await run(() => send('POST', `/chapters/${encodeURIComponent(chapter.chapterId)}/bind`, { expectedBindingVersion: chapter.bindingVersion, binding: source.kind === 'document' ? { kind: 'document', id: source.id } : { kind: 'google', key: source.key }, ...(confirmReplace ? { confirmReplace: true } : {}) }, `bind:${chapter.chapterId}:${chapter.bindingVersion}:${identityOf(source)}`), 'Глава каркаса привязана к тексту.');
  }
  function chapterCard(chapter) {
    const box = section(`«${chapter.title}»`, 'narr-chapter');
    const status = node('p', 'narr-source narr-source-' + chapter.source.status, `${SOURCE_LABELS[chapter.source.status] ?? chapter.source.status}${chapter.source.reason && chapter.source.status !== 'bound' ? ': ' + chapter.source.reason : ''}`);
    box.append(status);
    const row = node('div', 'narr-actions');
    const sourceSelect = node('select'); sourceSelect.setAttribute('aria-label', 'Текст для привязки');
    sourceSelect.append(new Option('Привязать к тексту…', ''));
    for (const item of s.data.textSources.google?.chapters ?? []) sourceSelect.append(new Option(`Google: ${short(item.title, 40)}${item.boundTo && item.boundTo !== chapter.chapterId ? ' (занята)' : ''}`, 'g:' + item.key));
    for (const doc of s.data.textSources.documents) sourceSelect.append(new Option(`Черновик: ${short(doc.title, 40)}${doc.boundTo && doc.boundTo !== chapter.chapterId ? ' (занят)' : ''}`, 'd:' + doc.id));
    sourceSelect.addEventListener('change', () => { const value = sourceSelect.value; if (!value) return; bindTo(chapter, value.startsWith('g:') ? { kind: 'google', key: value.slice(2) } : { kind: 'document', id: value.slice(2) }); });
    row.append(sourceSelect);
    // A write receipt proves the apply, not which Google chapter was created: the title is not an identity, so the
    // author maps it explicitly, and evidence of the previous text is never carried over to the chosen chapter.
    if (chapter.transferReceipt) { sourceSelect.setAttribute('aria-label', 'Выберите записанную главу Google вручную'); box.append(node('p', 'narr-hint narr-manual-map', 'Новая глава записана в Google, но квитанция записи не называет её точный идентификатор, поэтому автоматическое сопоставление по названию не выполняется. Выберите записанную главу в списке «Привязать к тексту…». Фрагменты-доказательства прежнего текста к ней не переносятся.')); }
    if (chapter.source.status === 'verify') row.append(button('Подтвердить сопоставление', '', () => bindTo(chapter, chapter.binding.kind === 'google' ? { kind: 'google', key: chapter.binding.key } : { kind: 'document', id: chapter.binding.id }, { confirmReplace: true })));
    if (chapter.binding) row.append(button('Отвязать', 'text-action', async () => { if (await ask('Отвязать главу от текста?', 'План и история сохранятся; фрагменты будут показаны как «Привязка потеряна».', 'Отвязать') === 'confirm') run(() => send('POST', `/chapters/${encodeURIComponent(chapter.chapterId)}/bind`, { expectedBindingVersion: chapter.bindingVersion, binding: null, confirmReplace: true }, 'unbind:' + chapter.chapterId + ':' + chapter.bindingVersion), 'Глава отвязана.'); }));
    const needs = (s.data.evidence ?? []).filter(item => item.chapterId === chapter.chapterId && (item.location === 'intact' || item.location === 'shifted'));
    const basis = (s.data.progress ?? []).filter(row => row.state === 'closed' && row.basis.some(entry => entry.chapterId === chapter.chapterId && entry.textHash !== chapter.source.hash));
    if ((needs.length || basis.length) && chapter.source.hash) row.append(button(`Подтвердить актуальность закрытий главы (${needs.length + basis.length})`, '', () => reconfirmDialog(chapter, needs, basis)));
    row.append(button('Переименовать', 'text-action', async () => { const name = window.prompt('Название главы каркаса', chapter.title); if (name && name.trim() && name !== chapter.title) run(() => send('PUT', `/chapters/${encodeURIComponent(chapter.chapterId)}`, { expectedVersion: chapter.version, title: name.trim() }, 'rename:' + chapter.chapterId + ':' + chapter.version)); }));
    row.append(button(chapter.archived ? 'Вернуть из архива' : 'В архив', 'text-action', () => run(() => send('PUT', `/chapters/${encodeURIComponent(chapter.chapterId)}`, { expectedVersion: chapter.version, archived: !chapter.archived }, 'archive:' + chapter.chapterId + ':' + chapter.version))));
    box.append(row);
    const plan = chapter.plan;
    if (!plan) { box.append(node('p', 'subtle-empty', 'У главы нет сюжетки. Для ещё не написанной главы план можно завести сейчас и привязать текст позже.'), button('Создать сюжетку главы', 'button button-primary', () => startEdit('chapter', null, chapter.chapterId))); return box; }
    box.append(approvalHeader(plan, 'chapter'));
    if (chapter.compatibility && !chapter.compatibility.compatible && plan.activeSnapshot) {
      const alert = node('div', 'narr-conflict'); alert.setAttribute('role', 'alert');
      alert.append(node('p', '', chapter.compatibility.reason === 'book_not_approved' ? 'Общая линия книги не согласована.' : 'Нужно согласовать связь: «Писать по каркасу» для этой главы заблокировано.'));
      const list = node('ul'); for (const problem of chapter.compatibility.problems) list.append(node('li', '', `«${bookStage(problem.stageId)?.title ?? problem.stageId}» r${problem.contentRevision}: ${{ missing: 'этапа больше нет', archived: 'этап в архиве', revision_changed: `теперь r${problem.currentRevision}` }[problem.reason]}`));
      alert.append(list); box.append(alert);
    }
    const goal = plan.activeSnapshot?.payload ?? plan.draft;
    for (const [label, value] of [['Что меняется', goal.goal], ['Исход', goal.outcome], ['Границы знания', goal.knowledgeBounds]]) if (value) { const p = node('p', 'narr-field'); p.append(node('strong', '', label + ': '), document.createTextNode(value)); box.append(p); }
    if (plan.activeSnapshot) { box.append(node('p', 'narr-counter', chapter.counter.label + (chapter.counter.stale ? ' · есть закрытия для проверки' : ''))); box.append(stageList(plan, 'chapter')); }
    else box.append(stageListReadOnly(plan.draft));
    return box;
  }
  function plannedList() {
    const box = section('Запланированные главы', 'narr-planned'), planned = chapters().filter(chapter => !chapter.binding && !chapter.archived);
    const list = node('ul');
    for (const chapter of planned) { const li = node('li'); li.append(button(short(chapter.title, 60), 'text-action', () => { s.followEditor = false; s.chapterId = chapter.chapterId; render(); }), node('span', 'narr-meta', chapter.plan ? ' · ' + chapter.counter.label : ' · без сюжетки')); list.append(li); }
    if (!planned.length) list.append(node('li', 'subtle-empty', 'Все главы каркаса связаны с текстом.'));
    const form = node('form', 'narr-inline-form'), input = node('input'); input.maxLength = 300; input.placeholder = 'Название новой главы'; input.setAttribute('aria-label', 'Название новой запланированной главы');
    const add = node('button', 'button button-quiet', 'Добавить главу'); add.type = 'submit';
    form.append(input, add);
    form.addEventListener('submit', async event => { event.preventDefault(); if (!input.value.trim()) return; const receipt = await run(() => send('POST', '/chapters', { title: input.value.trim(), order: chapters().length }, 'chapter-create:' + input.value.trim()), 'Глава добавлена в каркас.'); if (receipt) { s.followEditor = false; s.chapterId = receipt.chapterId; render(); } });
    box.append(list, form);
    const archived = chapters().filter(chapter => chapter.archived);
    if (archived.length) { const details = node('details'); details.append(node('summary', '', `Архив глав (${archived.length})`)); for (const chapter of archived) details.append(button(short(chapter.title, 60), 'text-action', () => { s.followEditor = false; s.chapterId = chapter.chapterId; render(); })); box.append(details); }
    return box;
  }
  function reconfirmDialog(chapter, evidence, basis) {
    const dialog = node('dialog', 'chapter-review-dialog narr-reconfirm'); dialog.setAttribute('aria-labelledby', 'narr-reconfirm-title');
    const form = node('form', 'chapter-review'); form.method = 'dialog';
    const heading = node('h2', '', 'Подтвердить актуальность закрытий главы'); heading.id = 'narr-reconfirm-title';
    form.append(heading, node('p', '', `Глава «${chapter.title}» изменена после решений. Проверьте каждое закрытие по текущему сохранённому тексту (рабочая версия ${chapter.source.workingVersion ?? '—'}, sha256 ${String(chapter.source.hash).slice(0, 12)}…). Без вашего подтверждения ничего не меняется.`));
    const list = node('ul', 'chapter-review-list');
    for (const item of evidence) { const li = node('li'); li.append(node('strong', '', `Фрагмент (${TONE_LABELS[item.tone]}): `), node('blockquote', '', item.quote), node('span', 'narr-reason', item.reason)); list.append(li); }
    for (const row of basis) { const plan = row.planId === s.data.book?.id ? s.data.book : chapters().find(c => c.plan?.id === row.planId)?.plan; list.append(node('li', '', `Закрытие без фрагмента: «${findStage(plan?.activeSnapshot?.payload, row.stageId)?.title ?? row.stageId}» — ${row.decisionReason}`)); }
    const label = node('label', 'chapter-review-confirm'), check = node('input'); check.type = 'checkbox'; label.append(check, node('span', '', 'Я просмотрел(а) перечисленные закрытия и подтверждаю, что они актуальны для текущего текста.'));
    const actions = node('div', 'dialog-actions'), cancel = node('button', 'button button-quiet', 'Отмена'), apply = node('button', 'button button-primary', 'Подтвердить');
    cancel.value = 'cancel'; apply.value = 'apply'; apply.disabled = true; check.addEventListener('change', () => { apply.disabled = !check.checked; });
    actions.append(cancel, apply); form.append(list, label, actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => {
      if (dialog.returnValue === 'apply' && check.checked) run(() => send('POST', `/chapters/${encodeURIComponent(chapter.chapterId)}/reconfirm`, { textHash: chapter.source.hash, evidence: evidence.map(item => ({ id: item.id, version: item.version })), progress: basis.map(row => ({ planId: row.planId, stageId: row.stageId, contentRevision: row.contentRevision, expectedProgressVersion: row.version })) }, `reconfirm:${chapter.chapterId}:${chapter.source.hash}`), 'Актуальность закрытий подтверждена.');
      dialog.remove();
    }, { once: true });
    dialog.showModal(); cancel.focus();
  }

  // ---------- Agent tab and composer attachment ----------
  function attachedChapterId() { return selectedChapter()?.chapterId ?? null; }
  function renderAgentTab() {
    const box = section('Каркас в запросе агенту', 'narr-agent');
    box.append(modeSelect());
    const chapter = selectedChapter();
    if (s.agentMode === 'write') box.append(node('p', 'narr-hint narr-preflight', WRITE_PREFLIGHT_NOTE));
    box.append(node('p', 'narr-meta', chapter ? `Глава запроса: «${chapter.title}» (вкладка «Глава»).` : 'Глава запроса не выбрана — передаётся только общая линия.'));
    if (s.agentMode === 'discuss') box.append(draftTargetControl(chapter));
    const stages = [...activeStages(s.data.book?.activeSnapshot?.payload).map(stage => ['Книга', stage]), ...activeStages(chapter?.plan?.activeSnapshot?.payload).map(stage => ['Глава', stage])];
    if (stages.length) {
      const details = node('details', 'narr-focus'); details.open = !!s.focusOpen; details.addEventListener('toggle', () => { s.focusOpen = details.open; });
      details.append(node('summary', '', `Сузить задачу до этапов (${s.focus.size || 'все'})`));
      details.append(node('p', 'narr-hint', 'Общие ограничения, предпосылки и запреты раскрытия передаются всегда.'));
      for (const [where, stage] of stages) { const label = node('label', 'narr-check'), input = node('input'); input.type = 'checkbox'; input.checked = s.focus.has(stage.id); input.addEventListener('change', () => { if (input.checked) s.focus.add(stage.id); else s.focus.delete(stage.id); s.focusOpen = true; if (s.preview) { s.preview = null; render(); } else renderAttach(); }); label.append(input, document.createTextNode(` ${where}: ${stage.title}`)); details.append(label); }
      box.append(details);
    }
    box.append(button('Показать контекст для агента', '', () => previewContext()));
    if (s.preview) box.append(previewBox());
    body.append(box, requestList());
  }
  function modeSelect() {
    const label = node('label', 'narr-mode'), select = node('select'); select.setAttribute('aria-label', 'Каркас в запросе агенту');
    for (const [value, text] of [['', 'Без каркаса'], ['write', 'Писать по каркасу'], ['discuss', 'Обсудить план']]) select.append(new Option(text, value, false, s.agentMode === value));
    select.addEventListener('change', () => { s.agentMode = select.value; s.preview = null; render(); });
    label.append(node('span', '', 'Каркас: '), select); return label;
  }
  // The draft to discuss is an explicit author choice, fixed to the chapter it was chosen for; the visible tab
  // never decides it. Preview and send both read this one choice.
  const draftLabel = target => target === 'book' ? 'черновик общей линии' : target === 'chapter' ? `черновик сюжетки «${short(chapterById(s.draftChapterId)?.title, 40)}»` : '';
  function draftTargetControl(chapter) {
    const set = node('fieldset', 'narr-draft-target'); set.append(node('legend', '', 'Неутверждённый черновик в обсуждении'));
    const options = [
      ['', 'Не передавать', true],
      ['book', s.data.book ? `Черновик общей линии (версия ${s.data.book.draftVersion})` : 'Черновик общей линии — ещё не создан', !!s.data.book],
      ['chapter', chapter?.plan ? `Черновик сюжетки «${short(chapter.title, 40)}» (версия ${chapter.plan.draftVersion})` : chapter ? `Черновик сюжетки «${short(chapter.title, 40)}» — ещё не создан` : 'Черновик сюжетки — глава запроса не выбрана', !!chapter?.plan],
    ];
    for (const [value, text, enabled] of options) {
      const label = node('label', 'narr-check'), input = node('input'); input.type = 'radio'; input.name = 'narr-draft-target'; input.value = value; input.disabled = !enabled;
      input.checked = value === 'chapter' ? s.draftTarget === 'chapter' && s.draftChapterId === chapter?.chapterId : s.draftTarget === value;
      input.addEventListener('change', () => { if (!input.checked) return; s.draftTarget = value; s.draftChapterId = value === 'chapter' ? chapter.chapterId : null; s.preview = null; render(); });
      label.append(input, document.createTextNode(' ' + text)); set.append(label);
    }
    if (s.draftTarget === 'chapter' && s.draftChapterId !== (chapter?.chapterId ?? null)) set.append(node('p', 'narr-warning', `Выбран ${draftLabel('chapter')}, а глава запроса теперь ${chapter ? `«${short(chapter.title, 40)}»` : 'не выбрана'}. Выберите черновик заново: запрос не уйдёт с черновиком другой главы.`));
    set.append(node('p', 'narr-hint', 'Черновик передаётся с пометкой «не согласован». Агент обсуждает его, но каркасом остаётся согласованная версия.'));
    return set;
  }
  function previewBox() {
    const box = node('div', 'narr-preview'), manifest = s.preview.manifest;
    const blocks = node('ul'); for (const block of manifest.blocks) blocks.append(node('li', block.size > block.limit ? 'narr-warning' : '', `${{ narrativeContext: 'Каркас', manuscriptContext: 'Главы', 'narrative+manuscript': 'Каркас + главы' }[block.name] ?? block.name}: ${block.size.toLocaleString('ru-RU')} из ${block.limit.toLocaleString('ru-RU')} знаков`));
    box.append(node('p', 'narr-meta', `Книга v${manifest.book?.version ?? '—'}${manifest.chapter ? ` · глава «${short(chapterById(manifest.chapter.chapterId)?.title, 40)}», сюжетка v${manifest.chapter.version ?? 'нет'}` : ''} · текстов: ${manifest.sources.length} · sha256 контекста ${manifest.contextHash.slice(0, 12)}…`), blocks);
    const discussed = manifest.draftDiscussion;
    if (discussed) box.append(node('p', 'narr-meta narr-preview-draft', `Черновик для обсуждения: ${discussed.kind === 'book' ? 'общая линия' : `сюжетка «${short(chapterById(manifest.chapter?.chapterId)?.title, 40)}»`}, версия ${discussed.draftVersion} (не согласован).`));
    box.append(node('p', 'narr-hint', manifest.mode === 'write' ? WRITE_PREFLIGHT_NOTE : 'Для обсуждения сервер проверяет только лимиты блоков: каркас — до 24 000 знаков, главы — до 120 000 (вместе — до 144 000) — и отклоняет превышение без обрезки. Окно модели и полный объём запроса не проверяются: runtime не сообщает размер окна и токенизатор.'));
    const pre = node('pre', 'narr-context-text', s.preview.narrativeContext); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Текст контекста каркаса');
    box.append(pre); return box;
  }
  function requestList() {
    const box = section('Последние запросы по каркасу', 'narr-requests'), list = node('ul');
    for (const request of s.data.requests ?? []) {
      const li = node('li', request.freshness.fresh ? '' : 'narr-stale');
      li.append(node('strong', '', `${date(request.createdAt)} · ${request.mode === 'write' ? 'писать по каркасу' : 'обсуждение'} · ${{ staged: 'подготовлен', running: 'выполняется', completed: 'завершён', failed: 'не выполнен', stopped: 'остановлен' }[request.status] ?? request.status}`));
      li.append(node('span', 'narr-meta', ` · каркас v${request.manifest?.book?.version ?? '—'}${request.manifest?.chapter?.version ? `, сюжетка v${request.manifest.chapter.version}` : ''}`));
      if (!request.freshness.fresh) li.append(node('p', 'narr-warning', 'По предыдущей версии: ' + request.freshness.reasons.join(' ')));
      if (request.statusReason) li.append(node('p', 'narr-meta', request.statusReason));
      if (request.accounting) li.append(node('p', 'narr-meta', `Учтено ${request.accounting.total.toLocaleString('ru-RU')} из ${request.accounting.limit.toLocaleString('ru-RU')} знаков; ${request.accounting.tokenWindow === 'verified' ? 'окно модели подтверждено адаптером хоста.' : 'окно модели не проверено.'}`));
      list.append(li);
    }
    if (!list.children.length) list.append(node('li', 'subtle-empty', 'Запросов по каркасу ещё не было.'));
    box.append(list); return box;
  }
  function renderAttach() {
    if (!attachRoot) return;
    attachRoot.replaceChildren();
    if (!s.bookId || !s.data) return;
    const book = s.data.book?.activeSnapshot, chapter = selectedChapter();
    attachRoot.append(modeSelect());
    if (s.agentMode) {
      const text = s.agentMode === 'write'
        ? (book ? `Каркас v${book.version}${chapter?.plan?.activeSnapshot ? ` + сюжетка v${chapter.plan.activeSnapshot.version}` : ''}${s.focus.size ? ` · этапов: ${s.focus.size}` : ''}` : 'Каркас не согласован')
        : `Обсуждение${book ? ` · каркас v${book.version}` : ''}${s.draftTarget ? ' + ' + draftLabel(s.draftTarget) : ''}`;
      const label = node('span', 'narr-attach-label' + (s.agentMode === 'write' ? ' narr-warning' : ''), s.agentMode === 'write' ? text + ' · нужна проверка окна модели хостом' : text);
      if (s.agentMode === 'write') label.title = WRITE_PREFLIGHT_NOTE;
      attachRoot.append(label);
    }
    attachRoot.append(button('Посмотреть', 'text-action', () => { s.tab = 'agent'; onOpenPanel?.(); render(); }));
  }
  // Builds the `narrative` request reference. Chapter text is never sent: only the manuscript document ID and
  // working-file key captured with the text, plus the SHA-256 of that text; the server reads the saved text and
  // refuses a missing (400) or different (409) document. Book, mode, chapter and draft target are captured once
  // before the first await, so switching the book or chapter meanwhile cannot change what this request refers to.
  async function prepareAgentRequest({ chapters: chapterContexts = [], document: draft = null } = {}) {
    if (!s.agentMode || !s.data) return null;
    const bookId = s.bookId, gen = s.gen, mode = s.agentMode, chapterId = attachedChapterId(), draftTarget = mode === 'discuss' ? s.draftTarget : '';
    const narrative = { mode, ...(chapterId ? { chapterId } : {}), ...(s.focus.size ? { focusStageIds: [...s.focus] } : {}) };
    if (draftTarget === 'book') {
      if (!s.data.book) throw new Error('Черновика общей линии нет. Выберите «Не передавать» на вкладке «Агент».');
      narrative.includeDraft = 'book';
    } else if (draftTarget === 'chapter') {
      if (!chapterId || s.draftChapterId !== chapterId) throw new Error('Черновик сюжетки выбран для другой главы. Выберите черновик заново на вкладке «Агент» каркаса.');
      if (!chapterById(chapterId)?.plan) throw new Error('У главы запроса нет черновика сюжетки.');
      narrative.includeDraft = 'chapter';
    }
    const switched = () => new Error('Книга сменилась во время подготовки запроса по каркасу. Ничего не отправлено; повторите из нужной книги.');
    const sources = chapterContexts.map(item => {
      if (item.bookId && item.bookId !== bookId) throw switched();
      if (typeof item.documentId !== 'string' || !item.documentId || typeof item.sectionId !== 'string' || !item.sectionId) throw new Error('Не удалось определить документ рукописи главы. Обновите оглавление рукописи и повторите.');
      return { documentId: item.documentId, key: item.sectionId, text: item.text };
    });
    if (sources.length) {
      await flushSource?.({ kind: 'google' });
      if (!isCurrent(bookId, gen)) throw switched();
      narrative.sources = await Promise.all(sources.map(async item => ({ kind: 'google', documentId: item.documentId, key: item.key, textHash: await sha256Hex(item.text, window.crypto) })));
    }
    // The local draft is saved first, like a Google chapter: the hash must be of the text the server will read.
    // Text typed or a draft opened while saving makes the captured text obsolete, so nothing is sent.
    if (draft) {
      if (typeof draft.id !== 'string' || !draft.id) throw new Error('Черновик ещё не сохранён на сервере. Дождитесь сохранения и повторите.');
      await flushSource?.({ kind: 'document', id: draft.id });
      if (!isCurrent(bookId, gen)) throw switched();
      const live = getEditor?.()?.get?.();
      if (!live || live.identity !== 'document:' + draft.id || live.text !== draft.text) throw new Error('Черновик изменился во время сохранения. Ничего не отправлено; отправьте запрос ещё раз.');
      narrative.documentHash = await sha256Hex(draft.text, window.crypto);
    }
    if (!isCurrent(bookId, gen)) throw switched();
    return narrative;
  }
  async function previewContext() {
    if (!s.agentMode) { notify('Выберите режим: «Писать по каркасу» или «Обсудить план».', true); return; }
    const bookId = s.bookId, gen = s.gen, url = base(), capture = captureAgentContext?.() ?? {};
    try {
      const narrative = await prepareAgentRequest({ chapters: capture.chapters ?? [], document: capture.document ?? null });
      const result = await api(url + '/context-preview', { method: 'POST', body: { narrative, ...(capture.document ? { documentId: capture.document.id, documentVersion: capture.document.version } : {}), ...(capture.noteId ? { noteId: capture.noteId } : {}), ...(capture.selectedText ? { selectedText: capture.selectedText } : {}) } });
      if (!isCurrent(bookId, gen)) return;
      s.preview = { ...result, request: narrative }; render();
    } catch (error) { if (isCurrent(bookId, gen)) { s.preview = null; render(); } notify(error.message + (error.details?.blocks ? ' ' + error.details.blocks.map(block => `${block.name}: ${block.size}/${block.limit ?? '—'}`).join('; ') : ''), true); }
  }
  async function setStrict(value) {
    if (!s.data) return;
    await run(() => send('PUT', '/prefs', { expectedVersion: s.data.prefsVersion, strict: value }, 'prefs:' + s.data.prefsVersion + ':' + value), value ? 'Строгая проверка включена для этой книги.' : 'Строгая проверка выключена.');
  }

  // ---------- Export ----------
  function download(name, text) {
    const link = document.createElement('a'); link.href = window.URL.createObjectURL(new window.Blob([text], { type: 'application/json;charset=utf-8' })); link.download = name;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => window.URL.revokeObjectURL(link.href), 1000);
  }
  function exportStatuses() {
    if (!s.data) return;
    const planStatuses = plan => plan?.activeSnapshot ? activeStages(plan.activeSnapshot.payload).map(stage => ({ stageId: stage.id, contentRevision: stage.contentRevision, title: stage.title, expectedChange: stage.expectedChange, status: plan.statuses[stage.id]?.label, state: plan.statuses[stage.id]?.state, evidence: evidenceFor(plan.id, stage).map(item => ({ chapter: chapterById(item.chapterId)?.title ?? item.chapterId, quote: item.quote, state: TONE_LABELS[item.tone] ?? item.tone })) })) : [];
    const data = { exportedAt: new Date().toISOString(), bookId: s.bookId, strict: s.data.strict, book: s.data.book ? { version: s.data.book.activeSnapshot?.version ?? null, hash: s.data.book.activeSnapshot?.hash ?? null, stages: planStatuses(s.data.book) } : null, chapters: chapters().map(chapter => ({ chapterId: chapter.chapterId, title: chapter.title, binding: SOURCE_LABELS[chapter.source.status], counter: chapter.counter.label, plan: chapter.plan ? { version: chapter.plan.activeSnapshot?.version ?? null, compatible: chapter.compatibility?.compatible ?? null, stages: planStatuses(chapter.plan) } : null })) };
    download(`talewisp-каркас-статусы-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  }

  // After saved text changes, re-read evidence states; never while the author edits a plan form.
  let textTimer = null;
  function noteTextChanged() { clearTimeout(textTimer); textTimer = setTimeout(() => { if (s.data && !s.editing && !s.closing) void refresh(); }, 4000); }

  render();
  return {
    root, load, refresh, render, syncEditor, badgeFor, onMarker, prepareAgentRequest, noteTextChanged,
    attached: () => !!s.agentMode && !!s.data,
    afterSend: () => { if (s.agentMode) void refresh(); },
    hasUnsavedDraft: () => !!s.editing?.dirty,
  };
}
