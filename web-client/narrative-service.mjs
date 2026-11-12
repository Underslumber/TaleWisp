// Narrative framework service: scope checks, saved-text sources, HTTP routes, agent request staging and the
// receipt-bound proposal channel. All mutations go through narrativeStore.mutate (one transaction each) and read
// saved text synchronously inside it, so validation and the write cannot interleave with a chapter save.
import { randomUUID } from 'node:crypto';
import { scopeKey } from './workspace-scope.mjs';
import {
  NarrativeError, NARRATIVE_LIMITS, ID_PATTERN, canonicalJson, normalizeDraft, assignRevisions, findStage, activeStages, pinParents,
  chapterCompatibility, stageStatus, chapterCounter, googleIdentity, documentIdentity, validId,
} from './public/narrative-model.js';
import { sha256, createAnchor, resolveQuote, assessEvidence } from './narrative-evidence.mjs';
import { buildNarrativeContext, checkBlockBudget } from './narrative-context.mjs';
import { formatManuscriptContext } from './manuscript-context.mjs';

const BOOK = /^[A-Za-z0-9_-]{1,80}$/;
const err = (message, code, status = 409, details) => new NarrativeError(message, code, status, details);
const notFound = message => err(message, 'not_found', 404);
const SAVE_FIRST = 'Сначала сохраните главу: сохранённый текст отличается от показанного. Ваш текст и выделение остаются в редакторе.';
const ACTIVE_LOCATIONS = new Set(['exact', 'intact', 'shifted']);
const keyOf = (planId, stageId, revision) => `${planId}|${stageId}|${revision}`;
const onlyKeys = (value, allowed, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw err(`${name}: неверный формат.`, 'narrative_invalid', 400);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw err(`${name}: неподдерживаемые поля ${extra.join(', ')}.`, 'narrative_invalid', 400);
};

export function createNarrativeService({ narrativeStore: store, selection, readManuscript, getDocument, listDocuments }) {
  function scopeFor(bookId) {
    if (typeof bookId !== 'string' || !BOOK.test(bookId)) throw err('Нужна открытая книга.', 'book_required', 400);
    const active = selection();
    if (!active?.bookId || active.bookId !== bookId) throw err('Открыта другая книга. Выберите книгу заново.', 'book_changed', 409);
    return { key: scopeKey(active), authorId: active.authorId ?? null, seriesId: active.seriesId ?? null, bookId };
  }
  const scopeOfManifest = manifest => ({ key: scopeKey(manifest.scope), authorId: manifest.scope.authorId ?? null, seriesId: manifest.scope.seriesId ?? null, bookId: manifest.scope.bookId });

  // ---------- Saved text sources ----------
  function sourceResolver(scope) {
    let manuscript;
    const ms = () => (manuscript ??= readManuscript(scope.bookId) ?? { status: 'none', reason: 'Основная рукопись не выбрана.' });
    const googleItem = (documentId, key) => {
      const m = ms();
      if (m.status !== 'ok') return { error: m.reason ?? 'Основная рукопись недоступна.', status: 'unavailable' };
      if (m.documentId !== documentId) return { error: 'Основная рукопись книги сменилась; привязка относится к прежнему документу.', status: 'other_manuscript' };
      if (!m.copy) return { error: 'Рабочий файл рукописи ещё не создан. Импортируйте рукопись и сохраните главу.', status: 'unavailable' };
      const item = m.copy.chapters.find(chapter => chapter.key === key);
      return item ? { item, version: m.copy.version } : { error: 'Глава больше не найдена в рабочем файле.', status: 'lost' };
    };
    const resolve = chapter => {
      const binding = chapter?.binding;
      if (!binding) return { status: 'planned', identity: null, aliases: [], reason: 'Текст ещё не привязан.' };
      const aliases = binding.aliases ?? [];
      if (binding.kind === 'document') {
        const identity = documentIdentity(binding.id), doc = getDocument(binding.id);
        if (!doc) return { status: 'lost', identity, aliases, reason: 'Черновик удалён или недоступен.' };
        if (doc.authorId !== scope.authorId || doc.seriesId !== scope.seriesId || doc.bookId !== scope.bookId) return { status: 'lost', identity, aliases, reason: 'Черновик относится к другой книге.' };
        return { status: 'bound', kind: 'document', identity, aliases, text: doc.text, hash: sha256(doc.text), workingVersion: doc.version, title: doc.title, ref: { kind: 'document', id: doc.id } };
      }
      const identity = googleIdentity(binding.documentId, binding.key), found = googleItem(binding.documentId, binding.key);
      if (found.error) return { status: found.status, identity, aliases, reason: found.error };
      const item = found.item;
      const base = { kind: 'google', identity, aliases, text: item.body, hash: sha256(item.body), workingVersion: found.version, title: item.title || item.label || '', ref: { kind: 'google', documentId: binding.documentId, key: item.key }, item };
      // Plain-text chapter ids follow document positions: a renamed index-based chapter may now be another chapter.
      if (['plain', 'preamble', 'whole'].includes(binding.detection) && (item.title !== binding.title || item.label !== binding.label)) return { ...base, status: 'verify', reason: 'Глава распознана не по заголовку Google и изменилась; подтвердите сопоставление.' };
      if (item.missing) return { ...base, status: 'missing', reason: 'Глава не найдена в документе Google; используется сохранённый текст рабочего файла.' };
      return { ...base, status: 'bound' };
    };
    const resolveRef = ref => {
      if (ref?.kind === 'document') return resolve({ binding: { kind: 'document', id: ref.id } });
      if (ref?.kind === 'google') return resolve({ binding: { kind: 'google', documentId: ref.documentId, key: ref.key } });
      return null;
    };
    return { resolve, resolveRef, manuscript: ms, googleItem };
  }

  // ---------- Read model ----------
  function computeState(scope) {
    const prefs = store.prefs(scope), plans = store.plans(scope), chapters = store.chapters(scope);
    const snapshots = new Map(), snapshot = id => { if (!id) return null; if (!snapshots.has(id)) snapshots.set(id, store.snapshot(id)); return snapshots.get(id); };
    const bookPlan = plans.find(plan => plan.kind === 'book') ?? null, bookSnapshot = snapshot(bookPlan?.activeSnapshotId);
    const chapterPlans = new Map(plans.filter(plan => plan.kind === 'chapter').map(plan => [plan.chapterId, plan]));
    const sources = sourceResolver(scope), chapterSources = new Map(chapters.map(chapter => [chapter.chapterId, sources.resolve(chapter)]));
    const evidence = store.evidenceList(scope).filter(item => !item.retiredAt).map(item => ({ ...item, ...assessEvidence(item, chapterSources.get(item.chapterId), { strict: prefs.strict }) }));
    const progress = store.progressForPlans(plans.map(plan => plan.id)), progressMap = new Map(progress.map(row => [keyOf(row.planId, row.stageId, row.contentRevision), row]));
    const proposals = store.proposals(scope);
    const statusOf = (planId, stage) => {
      const key = keyOf(planId, stage.id, stage.contentRevision), row = progressMap.get(key) ?? null;
      const linked = evidence.filter(item => keyOf(item.planId, item.stageId, item.contentRevision) === key);
      const pending = proposals.filter(item => item.state === 'pending' && keyOf(item.planId, item.stageId, item.contentRevision) === key).length;
      const basisChanged = (row?.basis ?? []).some(entry => chapterSources.get(entry.chapterId)?.hash !== entry.textHash);
      return { ...stageStatus({ progress: row, evidence: linked, pendingProposals: pending, basisChanged, strict: prefs.strict }), contentRevision: stage.contentRevision, progressVersion: row?.version ?? 0, evidenceIds: linked.map(item => item.id) };
    };
    return { scope, prefs, plans, chapters, snapshot, bookPlan, bookSnapshot, chapterPlans, sources, chapterSources, evidence, progress, progressMap, proposals, statusOf };
  }

  function planOut(state, plan) {
    if (!plan) return null;
    const active = state.snapshot(plan.activeSnapshotId);
    return {
      id: plan.id, kind: plan.kind, chapterId: plan.chapterId, draft: plan.draft, draftVersion: plan.draftVersion, draftHash: plan.draftHash, draftStatus: plan.draftStatus,
      draftDiffersFromActive: !active || canonicalJson(stripPins(active.payload)) !== canonicalJson(plan.draft),
      activeSnapshot: active, snapshots: store.snapshots(plan.id).map(({ payload, ...meta }) => meta),
      statuses: active ? Object.fromEntries(activeStages(active.payload).map(stage => [stage.id, state.statusOf(plan.id, stage)])) : {},
    };
  }
  const stripPins = payload => { if (!payload) return payload; const { parentPins, ...rest } = payload; return rest; };

  function freshness(state, request) {
    const manifest = request.manifest, reasons = [];
    if ((state.bookPlan?.activeSnapshotId ?? null) !== (manifest.book?.snapshotId ?? null)) reasons.push('Согласована другая версия каркаса книги.');
    if (manifest.chapter && (state.chapterPlans.get(manifest.chapter.chapterId)?.activeSnapshotId ?? null) !== (manifest.chapter.snapshotId ?? null)) reasons.push('Согласована другая версия сюжетки главы.');
    if (manifest.chapter && (store.chapter(state.scope, manifest.chapter.chapterId)?.sourceIdentity ?? null) !== (manifest.chapter.sourceIdentity ?? null)) reasons.push('Привязка главы к тексту изменилась.');
    for (const source of manifest.sources ?? []) {
      const current = state.sources.resolveRef(source.ref);
      if (!current || current.hash !== source.textHash) reasons.push(`Текст «${source.title || 'главы'}» изменён после запроса.`);
    }
    return { fresh: !reasons.length, reasons };
  }

  function view(scope) {
    const state = computeState(scope);
    const m = state.sources.manuscript(), boundBy = new Map(state.chapters.filter(chapter => chapter.sourceIdentity).map(chapter => [chapter.sourceIdentity, chapter.chapterId]));
    const receipts = store.receipts(scope);
    const chapters = state.chapters.map(chapter => {
      const source = state.chapterSources.get(chapter.chapterId), plan = state.chapterPlans.get(chapter.chapterId) ?? null;
      const chapterSnapshot = state.snapshot(plan?.activeSnapshotId), compatibility = plan ? chapterCompatibility(chapterSnapshot, state.bookSnapshot) : null;
      const statuses = chapterSnapshot ? activeStages(chapterSnapshot.payload).map(stage => state.statusOf(plan.id, stage)) : [];
      const pendingKey = chapter.binding?.kind === 'google' && chapter.binding.key.startsWith('new:') ? chapter.binding.key.slice(4) : null;
      const transfer = pendingKey && source.status === 'lost' ? receipts.find(receipt => receipt.documentId === chapter.binding.documentId && receipt.newKeys.includes(pendingKey)) : null;
      return {
        chapterId: chapter.chapterId, title: chapter.title, order: chapter.order, archived: chapter.archived, version: chapter.version, binding: chapter.binding, bindingVersion: chapter.bindingVersion, sourceIdentity: chapter.sourceIdentity,
        source: { status: source.status, reason: source.reason ?? '', title: source.title ?? '', hash: source.hash ?? null, workingVersion: source.workingVersion ?? null, ref: source.ref ?? null },
        plan: planOut(state, plan), compatibility, counter: chapterCounter(statuses, !!chapterSnapshot), transferReceipt: transfer ? transfer.operationId : null,
      };
    });
    const docs = listDocuments().filter(doc => doc.authorId === scope.authorId && doc.seriesId === scope.seriesId && doc.bookId === scope.bookId);
    return {
      bookId: scope.bookId, strict: state.prefs.strict, prefsVersion: state.prefs.version, limits: NARRATIVE_LIMITS,
      book: planOut(state, state.bookPlan), chapters, progress: state.progress,
      evidence: state.evidence.map(({ item, ...rest }) => rest), proposals: state.proposals,
      requests: store.requests(scope, 10).map(request => ({ requestId: request.requestId, mode: request.mode, status: request.status, statusReason: request.statusReason, createdAt: request.createdAt, accounting: request.accounting, manifest: request.manifest, freshness: freshness(state, request) })),
      textSources: {
        google: m.status === 'ok' ? { documentId: m.documentId, name: m.name ?? '', version: m.copy?.version ?? 0, ready: !!m.copy, chapters: (m.copy?.chapters ?? []).map(item => ({ key: item.key, title: item.title || item.label || '', kind: item.kind, missing: !!item.missing, detection: item.detection ?? '', hash: sha256(item.body), boundTo: boundBy.get(googleIdentity(m.documentId, item.key)) ?? null })) } : { status: m.status, reason: m.reason ?? '' },
        documents: docs.map(doc => ({ id: doc.id, title: doc.title, version: doc.version, hash: sha256(doc.text), boundTo: boundBy.get(documentIdentity(doc.id)) ?? null })),
      },
      events: store.events(scope, 40),
    };
  }

  // ---------- Mutations ----------
  const requireOperation = body => { if (typeof body.operationId !== 'string') throw err('Нужен идентификатор операции.', 'operation_required', 400); return body.operationId; };
  const activePlanStage = (scope, planId, snapshotId, stageId, contentRevision) => {
    const plan = store.plan(scope, planId); if (!plan) throw notFound('План не найден в этой книге.');
    if (!plan.activeSnapshotId || plan.activeSnapshotId !== snapshotId) throw err('Каркас согласован заново после показа. Обновите каркас и повторите решение.', 'snapshot_changed');
    const snapshot = store.snapshot(snapshotId), stage = findStage(snapshot.payload, stageId);
    if (!stage || stage.archived || stage.contentRevision !== contentRevision) throw err('Этот этап отсутствует, находится в архиве или изменён в согласованной версии.', 'stage_changed');
    return { plan, snapshot, stage };
  };
  const intIn = (value, name, min = 0) => { if (!Number.isSafeInteger(value) || value < min) throw err(`Поле ${name} должно быть целым числом.`, 'narrative_invalid', 400); return value; };

  function saveDraft(scope, planId, body) {
    onlyKeys(body, ['expectedVersion', 'operationId', 'kind', 'chapterId', 'draft', 'status'], 'Черновик');
    if (!validId(planId)) throw err('Неверный идентификатор плана.', 'narrative_invalid', 400);
    const expectedVersion = intIn(body.expectedVersion, 'expectedVersion');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'draft', body: { planId, ...body } }, ({ event }) => {
      const existing = store.plan(scope, planId), kind = existing?.kind ?? body.kind;
      if (!existing) {
        if (expectedVersion !== 0) throw err('Черновик плана не найден; обновите каркас.', 'draft_conflict');
        if (kind === 'book' && store.bookPlan(scope)) throw err('У книги уже есть общая линия. Обновите каркас.', 'draft_conflict');
        if (kind === 'chapter') {
          if (!validId(body.chapterId) || !store.chapter(scope, body.chapterId)) throw notFound('Глава каркаса не найдена.');
          if (store.chapterPlan(scope, body.chapterId)) throw err('У главы уже есть сюжетка. Обновите каркас.', 'draft_conflict');
        }
      } else {
        if (body.kind !== undefined && body.kind !== existing.kind) throw err('Вид плана нельзя изменить.', 'narrative_invalid', 400);
        if (existing.draftVersion !== expectedVersion) throw err('Черновик плана изменился в другой вкладке. Ваш ввод сохранён в браузере; сравните его с серверной версией.', 'draft_conflict');
      }
      const draft = normalizeDraft(kind, kind === 'chapter' ? { ...body.draft, chapterId: existing?.chapterId ?? body.chapterId } : body.draft);
      if (kind === 'chapter') {
        const bookPlan = store.bookPlan(scope), bookSnapshot = bookPlan?.activeSnapshotId ? store.snapshot(bookPlan.activeSnapshotId) : null;
        for (const stage of draft.stages) for (const id of stage.parentStageIds) {
          const known = findStage(bookPlan?.draft, id) ?? findStage(bookSnapshot?.payload, id);
          if (!known) throw err(`Этап «${stage.title}» ссылается на неизвестный этап общей линии.`, 'narrative_invalid', 400);
        }
      }
      const { stages, index } = assignRevisions(draft.stages, existing?.revisionIndex ?? {});
      const payload = { ...draft, stages }, draftHash = sha256(canonicalJson(payload)), draftStatus = body.status === 'review' ? 'review' : 'draft';
      if (existing) store.updateDraft(planId, expectedVersion, { draft: payload, draftHash, draftStatus, revisionIndex: index });
      else store.insertPlan(scope, { id: planId, kind, chapterId: kind === 'chapter' ? draft.chapterId : null, draft: payload, draftHash, draftStatus, revisionIndex: index });
      event('draft', { planId, draftVersion: expectedVersion }, { planId, draftVersion: expectedVersion + 1, draftHash, draftStatus });
      return { planId, draftVersion: expectedVersion + 1, draftHash };
    });
  }

  function approve(scope, planId, body) {
    onlyKeys(body, ['expectedDraftVersion', 'shownHash', 'expectedActiveSnapshotId', 'expectedBookSnapshotId', 'operationId'], 'Согласование');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'approve', body: { planId, ...body } }, ({ event }) => {
      const plan = store.plan(scope, planId); if (!plan) throw notFound('План не найден в этой книге.');
      if (plan.draftVersion !== body.expectedDraftVersion) throw err('Черновик изменился после показа. Проверьте новую версию перед согласованием.', 'draft_conflict');
      if (plan.draftHash !== body.shownHash) throw err('Показанная версия не совпадает с сохранённым черновиком. Согласовать можно только показанный снимок.', 'shown_hash_mismatch');
      if ((plan.activeSnapshotId ?? null) !== (body.expectedActiveSnapshotId ?? null)) throw err('Согласованная версия изменилась в другой вкладке.', 'approval_conflict');
      normalizeDraft(plan.kind, plan.draft);
      const previous = plan.activeSnapshotId ? store.snapshot(plan.activeSnapshotId) : null;
      let payload = plan.draft, bookSnapshotId = null;
      if (plan.kind === 'chapter') {
        const bookPlan = store.bookPlan(scope);
        if (!bookPlan?.activeSnapshotId) throw err('Сначала согласуйте общую линию книги.', 'book_not_approved');
        if ((body.expectedBookSnapshotId ?? null) !== bookPlan.activeSnapshotId) throw err('Общая линия согласована заново после показа. Проверьте связь сюжетки ещё раз.', 'book_snapshot_changed');
        const bookSnapshot = store.snapshot(bookPlan.activeSnapshotId);
        payload = { ...plan.draft, parentPins: pinParents(plan.draft, bookSnapshot.payload) };
        bookSnapshotId = bookSnapshot.id;
      }
      if (previous && canonicalJson(previous.payload) === canonicalJson(payload)) throw err('Черновик совпадает с действующей согласованной версией.', 'nothing_to_approve');
      const snapshot = store.insertSnapshot({ planId, payload, bookSnapshotId });
      store.setActiveSnapshot(planId, snapshot.id, plan.activeSnapshotId ?? null);
      let affectedChapters = [];
      if (plan.kind === 'book') affectedChapters = store.plans(scope).filter(item => item.kind === 'chapter' && item.activeSnapshotId).map(item => ({ chapterId: item.chapterId, ...chapterCompatibility(store.snapshot(item.activeSnapshotId), snapshot) })).filter(item => !item.compatible).map(({ chapterId, problems }) => ({ chapterId, problems }));
      event('approve', { planId, activeSnapshotId: plan.activeSnapshotId ?? null }, { planId, activeSnapshotId: snapshot.id, version: snapshot.version, hash: snapshot.hash, bookSnapshotId });
      return { planId, snapshotId: snapshot.id, version: snapshot.version, hash: snapshot.hash, affectedChapters };
    });
  }

  function createChapter(scope, body) {
    onlyKeys(body, ['operationId', 'chapterId', 'title', 'order'], 'Глава каркаса');
    if (body.chapterId !== undefined && !validId(body.chapterId)) throw err('Неверный идентификатор главы.', 'narrative_invalid', 400);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300) throw err('Укажите название главы до 300 знаков.', 'narrative_invalid', 400);
    return store.mutate({ scope, operationId: requireOperation(body), action: 'chapter_create', body }, ({ event }) => {
      const chapterId = body.chapterId ?? randomUUID();
      if (store.chapterCount(scope) >= NARRATIVE_LIMITS.chapters) throw err(`В книге не больше ${NARRATIVE_LIMITS.chapters} глав каркаса.`, 'narrative_limit', 413);
      if (store.chapter(scope, chapterId)) throw err('Глава с таким идентификатором уже есть.', 'chapter_conflict');
      const order = Number.isSafeInteger(body.order) ? body.order : store.chapterCount(scope);
      store.insertChapter(scope, { chapterId, title: body.title.trim(), order });
      event('chapter_create', null, { chapterId, title: body.title.trim(), order });
      return { chapterId };
    });
  }

  function updateChapter(scope, chapterId, body) {
    onlyKeys(body, ['operationId', 'expectedVersion', 'title', 'order', 'archived'], 'Глава каркаса');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'chapter_update', body: { chapterId, ...body } }, ({ event }) => {
      const chapter = store.chapter(scope, chapterId); if (!chapter) throw notFound('Глава каркаса не найдена.');
      const title = body.title === undefined ? chapter.title : body.title;
      if (typeof title !== 'string' || !title.trim() || title.length > 300) throw err('Укажите название главы до 300 знаков.', 'narrative_invalid', 400);
      const order = body.order === undefined ? chapter.order : intIn(body.order, 'order');
      store.updateChapter(scope, chapterId, body.expectedVersion, { title: title.trim(), order, archived: body.archived === undefined ? chapter.archived : body.archived === true });
      event('chapter_update', { title: chapter.title, order: chapter.order, archived: chapter.archived }, { title: title.trim(), order, archived: body.archived ?? chapter.archived });
      return { chapterId };
    });
  }

  function bindChapter(scope, chapterId, body) {
    onlyKeys(body, ['operationId', 'expectedBindingVersion', 'binding', 'confirmReplace', 'receiptOperationId'], 'Привязка главы');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'chapter_bind', body: { chapterId, ...body } }, ({ event }) => {
      const chapter = store.chapter(scope, chapterId); if (!chapter) throw notFound('Глава каркаса не найдена.');
      if (chapter.bindingVersion !== body.expectedBindingVersion) throw err('Привязка главы изменилась в другой вкладке. Обновите каркас.', 'binding_conflict');
      const sources = sourceResolver(scope);
      let binding = null, identity = null;
      if (body.receiptOperationId !== undefined) {
        // New Google chapter written by a verified apply: the chapter id follows the creation receipt, not similar text.
        const current = chapter.binding;
        if (current?.kind !== 'google' || !current.key.startsWith('new:')) throw err('Перенос по квитанции возможен только для новой главы.', 'receipt_invalid', 400);
        const receipt = store.receipt(scope, body.receiptOperationId), newKey = current.key.slice(4);
        if (!receipt || receipt.documentId !== current.documentId || !receipt.newKeys.includes(newKey)) throw err('Квитанция записи этой главы не найдена.', 'receipt_invalid');
        const m = sources.manuscript();
        if (m.status !== 'ok' || m.documentId !== current.documentId || !m.copy) throw err('Рабочий файл этой рукописи недоступен.', 'receipt_invalid');
        if (m.copy.chapters.some(item => item.key === current.key)) throw err('Новая глава ещё числится незаписанной в рабочем файле. Обновите рабочий файл после записи.', 'receipt_pending');
        // This provider's receipt proves an apply, not an exact newKey -> Google section ID mapping.
        // A unique title is not identity. Manual binding never carries old-source evidence aliases.
        throw err('Квитанция не содержит подтверждённого ID созданной главы. Сопоставьте главу вручную; доказательства прежнего текста не переносятся.', 'binding_ambiguous');
      } else if (body.binding === null) {
        if (!chapter.binding) throw err('Глава уже не привязана.', 'binding_conflict');
        if (body.confirmReplace !== true) throw err('Подтвердите отвязку главы от текста.', 'rebind_requires_confirmation');
      } else {
        onlyKeys(body.binding, ['kind', 'key', 'id'], 'Привязка');
        if (chapter.binding && body.confirmReplace !== true) throw err('Глава уже привязана к тексту. Подтвердите замену: доказательства не переносятся на другой текст.', 'rebind_requires_confirmation');
        if (body.binding.kind === 'google') {
          const m = sources.manuscript();
          if (m.status !== 'ok' || !m.copy) throw err('Сначала выберите основную рукопись и создайте рабочий файл.', 'manuscript_unavailable');
          const item = typeof body.binding.key === 'string' ? m.copy.chapters.find(chapterItem => chapterItem.key === body.binding.key) : null;
          if (!item) throw notFound('Глава не найдена в рабочем файле рукописи.');
          binding = { kind: 'google', documentId: m.documentId, key: item.key, title: item.title, label: item.label, detection: item.detection };
          identity = googleIdentity(m.documentId, item.key);
        } else if (body.binding.kind === 'document') {
          const doc = typeof body.binding.id === 'string' ? getDocument(body.binding.id) : null;
          if (!doc) throw notFound('Черновик не найден.');
          if (doc.authorId !== scope.authorId || doc.seriesId !== scope.seriesId || doc.bookId !== scope.bookId) throw err('Черновик относится к другой книге.', 'binding_scope');
          binding = { kind: 'document', id: doc.id, title: doc.title };
          identity = documentIdentity(doc.id);
        } else throw err('Неизвестный вид текста.', 'narrative_invalid', 400);
      }
      if (identity) {
        const other = store.chapterBySource(scope, identity);
        if (other && other.chapterId !== chapterId) throw err('Этот текст уже привязан к другой главе каркаса. Неоднозначная привязка не применяется.', 'binding_ambiguous');
      }
      store.bindChapter(scope, chapterId, chapter.bindingVersion, binding, identity);
      event('chapter_bind', { binding: chapter.binding, sourceIdentity: chapter.sourceIdentity }, { binding, sourceIdentity: identity });
      return { chapterId, bindingVersion: chapter.bindingVersion + 1, sourceIdentity: identity };
    });
  }

  function addEvidence(scope, stageId, body) {
    onlyKeys(body, ['operationId', 'planId', 'snapshotId', 'contentRevision', 'chapterId', 'textHash', 'start', 'end', 'quote'], 'Доказательство');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'evidence', body: { stageId, ...body } }, ({ event }) => {
      const { stage, plan } = activePlanStage(scope, body.planId, body.snapshotId, stageId, body.contentRevision);
      const chapter = store.chapter(scope, body.chapterId); if (!chapter) throw notFound('Глава каркаса не найдена.');
      const source = sourceResolver(scope).resolve(chapter);
      if (source.status !== 'bound' && source.status !== 'missing') throw err(source.reason || 'Глава не привязана к сохранённому тексту.', 'source_unavailable');
      if (source.hash !== body.textHash) throw err(SAVE_FIRST, 'save_first');
      if (store.evidenceForStage(plan.id, stage.id, stage.contentRevision).length >= NARRATIVE_LIMITS.evidencePerStage) throw err('У этапа слишком много фрагментов.', 'narrative_limit', 413);
      const anchor = createAnchor(source.text, body);
      const row = store.insertEvidence(scope, { planId: plan.id, stageId: stage.id, contentRevision: stage.contentRevision, chapterId: chapter.chapterId, sourceIdentity: source.identity, workingVersion: source.workingVersion, textHash: source.hash, ...anchor, origin: 'author' });
      event('evidence', null, { evidenceId: row.id, stageId, contentRevision: stage.contentRevision, chapterId: chapter.chapterId, textHash: source.hash });
      return { evidenceId: row.id };
    });
  }

  function decide(scope, stageId, body) {
    onlyKeys(body, ['operationId', 'planId', 'snapshotId', 'contentRevision', 'action', 'expectedProgressVersion', 'evidenceIds', 'reason', 'basisChapterIds'], 'Решение');
    if (!['start', 'close', 'reopen'].includes(body.action)) throw err('Неизвестное действие с этапом.', 'narrative_invalid', 400);
    return store.mutate({ scope, operationId: requireOperation(body), action: 'decision', body: { stageId, ...body } }, ({ event }) => {
      const { plan, stage, snapshot } = activePlanStage(scope, body.planId, body.snapshotId, stageId, body.contentRevision);
      const current = store.progress(plan.id, stage.id, stage.contentRevision), state = current?.state ?? 'not_started';
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length > 2000) throw err('Пояснение длиннее 2000 знаков.', 'narrative_invalid', 400);
      let next;
      if (body.action === 'start') {
        if (state !== 'not_started') throw err('Этап уже начат или закрыт.', 'transition_invalid');
        next = { state: 'in_progress', evidenceIds: [], basis: [] };
      } else if (body.action === 'reopen') {
        if (state !== 'closed') throw err('Вернуть в работу можно только закрытый этап.', 'transition_invalid');
        next = { state: 'in_progress', evidenceIds: [], basis: [] };
      } else {
        if (state === 'closed') throw err('Этап уже закрыт.', 'transition_invalid');
        const ids = body.evidenceIds ?? [];
        if (!Array.isArray(ids) || ids.length > NARRATIVE_LIMITS.anchorsPerDecision || new Set(ids).size !== ids.length) throw err(`Для решения можно указать до ${NARRATIVE_LIMITS.anchorsPerDecision} фрагментов.`, 'narrative_limit', 413);
        const sources = sourceResolver(scope), chapters = new Map();
        const chapterSource = chapterId => { if (!chapters.has(chapterId)) chapters.set(chapterId, sources.resolve(store.chapter(scope, chapterId))); return chapters.get(chapterId); };
        for (const id of ids) {
          const item = store.evidence(scope, id);
          if (!item || item.retiredAt || item.planId !== plan.id || item.stageId !== stage.id || item.contentRevision !== stage.contentRevision) throw err('Фрагмент не относится к этому этапу.', 'evidence_invalid', 400);
          const source = chapterSource(item.chapterId), located = assessEvidence(item, source, {});
          if (!ACTIVE_LOCATIONS.has(located.location) || located.tone === 'lost' || source.status === 'verify') throw err('Один из фрагментов требует проверки или не найден. Свяжите выделение заново.', 'evidence_not_current');
          // The author confirms on the current saved text: an intact or uniquely moved anchor is re-anchored to it.
          if (located.location !== 'exact') store.reanchorEvidence(scope, item.id, item.version, { workingVersion: source.workingVersion, textHash: source.hash, start: located.start, end: located.end, ...anchorWindow(source.text, located.start, located.end) });
        }
        let basis = [];
        if (!ids.length) {
          if (!reason) throw err('Закрытие без фрагмента требует пояснения автора.', 'reason_required', 400);
          const basisIds = body.basisChapterIds ?? [];
          if (!Array.isArray(basisIds) || basisIds.length > NARRATIVE_LIMITS.basisChapters) throw err('Слишком много связанных глав.', 'narrative_limit', 413);
          basis = basisIds.map(chapterId => { const source = chapterSource(chapterId); if (!source?.hash) throw err('Связанная глава не привязана к сохранённому тексту.', 'source_unavailable'); return { chapterId, textHash: source.hash }; });
        }
        next = { state: 'closed', evidenceIds: ids, basis };
        for (const proposal of store.proposals(scope).filter(item => item.state === 'pending' && item.planId === plan.id && item.stageId === stage.id && item.contentRevision === stage.contentRevision)) store.setProposalState(scope, proposal.id, 'pending', 'stale', 'Этап закрыт автором другим решением.');
      }
      const row = store.putProgress({ planId: plan.id, stageId: stage.id, contentRevision: stage.contentRevision, decidedInSnapshotId: snapshot.id, actor: 'author', decisionReason: reason, ...next }, body.expectedProgressVersion ?? -1);
      event('decision:' + body.action, current, row);
      return { planId: plan.id, stageId: stage.id, contentRevision: stage.contentRevision, state: row.state, progressVersion: row.version };
    });
  }
  const anchorWindow = (text, start, end) => { const anchor = createAnchor(text, { start, end, quote: text.slice(start, end) }); return { prefix: anchor.prefix, suffix: anchor.suffix }; };

  function retireEvidence(scope, evidenceId, body) {
    onlyKeys(body, ['operationId'], 'Удаление фрагмента');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'evidence_retire', body: { evidenceId } }, ({ event }) => {
      const item = store.evidence(scope, evidenceId); if (!item || item.retiredAt) throw notFound('Фрагмент не найден.');
      const progress = store.progress(item.planId, item.stageId, item.contentRevision);
      if (progress?.state === 'closed' && progress.evidenceIds.includes(item.id)) throw err('Фрагмент подтверждает закрытие. Сначала верните этап в работу.', 'evidence_in_use');
      store.retireEvidence(scope, evidenceId);
      event('evidence_retire', { evidenceId }, null);
      return { evidenceId };
    });
  }

  function reconfirm(scope, chapterId, body) {
    onlyKeys(body, ['operationId', 'textHash', 'evidence', 'progress'], 'Подтверждение актуальности');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'reconfirm', body: { chapterId, ...body } }, ({ event }) => {
      const chapter = store.chapter(scope, chapterId); if (!chapter) throw notFound('Глава каркаса не найдена.');
      const source = sourceResolver(scope).resolve(chapter);
      if (source.status !== 'bound' && source.status !== 'missing') throw err(source.reason || 'Глава не привязана к сохранённому тексту.', 'source_unavailable');
      if (source.hash !== body.textHash) throw err(SAVE_FIRST, 'save_first');
      const evidence = Array.isArray(body.evidence) ? body.evidence : [], progress = Array.isArray(body.progress) ? body.progress : [];
      if (!evidence.length && !progress.length) throw err('Отметьте закрытия, актуальность которых вы проверили.', 'narrative_invalid', 400);
      if (evidence.length > 500 || progress.length > 500) throw err('Слишком много закрытий в одном подтверждении.', 'narrative_limit', 413);
      const changed = [];
      for (const entry of evidence) {
        const item = store.evidence(scope, entry?.id);
        if (!item || item.retiredAt || item.chapterId !== chapterId) throw err('Фрагмент не относится к этой главе.', 'evidence_invalid', 400);
        if (item.version !== entry.version) throw err('Фрагмент изменился после показа. Обновите перечень.', 'evidence_conflict');
        const located = assessEvidence(item, source, {});
        if (!ACTIVE_LOCATIONS.has(located.location)) throw err(`Фрагмент «${item.quote.slice(0, 40)}» нельзя подтвердить пакетно: ${located.reason}`, 'evidence_not_current');
        if (located.location === 'exact') continue;
        store.reanchorEvidence(scope, item.id, item.version, { workingVersion: source.workingVersion, textHash: source.hash, start: located.start, end: located.end, ...anchorWindow(source.text, located.start, located.end) });
        changed.push({ evidenceId: item.id, before: { textHash: item.textHash, start: item.start, end: item.end }, after: { textHash: source.hash, start: located.start, end: located.end } });
      }
      for (const entry of progress) {
        const row = store.progress(entry?.planId, entry?.stageId, entry?.contentRevision);
        if (!row || row.state !== 'closed' || !store.plan(scope, row.planId) || !row.basis.some(item => item.chapterId === chapterId)) throw err('Решение без фрагмента не связано с этой главой.', 'progress_invalid', 400);
        store.putProgress({ ...row, basis: row.basis.map(item => item.chapterId === chapterId ? { chapterId, textHash: source.hash } : item) }, entry.expectedProgressVersion);
        changed.push({ progress: `${row.planId}|${row.stageId}|${row.contentRevision}` });
      }
      event('reconfirm', { chapterId }, { chapterId, textHash: source.hash, changed });
      return { chapterId, textHash: source.hash, changed: changed.length };
    });
  }

  function acceptProposal(scope, proposalId, body) {
    onlyKeys(body, ['operationId', 'expectedProgressVersion'], 'Принятие предложения');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'proposal_accept', body: { proposalId, ...body } }, ({ event }) => {
      const proposal = store.proposal(scope, proposalId); if (!proposal) throw notFound('Предложение не найдено.');
      if (proposal.state !== 'pending') throw err('Предложение уже обработано или устарело.', 'proposal_conflict');
      const plan = store.plan(scope, proposal.planId);
      const chapter = store.chapter(scope, proposal.chapterId), source = sourceResolver(scope).resolve(chapter);
      const request = store.request(proposal.requestId);
      const manifestState = request ? freshness(computeState(scope), request) : { fresh: false, reasons: ['Исходный запрос не найден.'] };
      let stale = !manifestState.fresh ? manifestState.reasons.join(' ') : null;
      if (!stale && (!plan || plan.activeSnapshotId !== proposal.snapshotId)) stale = 'Согласована другая версия каркаса.';
      else if (source.identity !== proposal.sourceIdentity || source.hash !== proposal.textHash) stale = 'Текст главы изменён после предложения.';
      else if (source.status !== 'bound' && source.status !== 'missing') stale = source.reason || 'Глава недоступна.';
      if (stale) {
        store.setProposalState(scope, proposal.id, 'pending', 'stale', stale);
        event('proposal_stale', { proposalId }, { reason: stale });
        return { proposalId, accepted: false, state: 'stale', reason: stale };
      }
      const { stage, snapshot } = activePlanStage(scope, plan.id, proposal.snapshotId, proposal.stageId, proposal.contentRevision);
      const current = store.progress(plan.id, stage.id, stage.contentRevision);
      if (current?.state === 'closed') throw err('Этап уже закрыт.', 'transition_invalid');
      const evidenceIds = proposal.anchors.map(anchor => {
        createAnchor(source.text, anchor);
        return store.insertEvidence(scope, { planId: plan.id, stageId: stage.id, contentRevision: stage.contentRevision, chapterId: chapter.chapterId, sourceIdentity: source.identity, workingVersion: source.workingVersion, textHash: source.hash, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start, end: anchor.end, origin: 'agent-proposal', proposalId: proposal.id }).id;
      });
      const row = store.putProgress({ planId: plan.id, stageId: stage.id, contentRevision: stage.contentRevision, state: 'closed', decidedInSnapshotId: snapshot.id, actor: 'author', decisionReason: 'Принято предложение агента: ' + proposal.rationale.slice(0, 1500), evidenceIds, basis: [] }, body.expectedProgressVersion ?? -1);
      store.setProposalState(scope, proposal.id, 'pending', 'accepted');
      event('proposal_accept', current, row);
      return { proposalId, accepted: true, state: 'accepted', progressVersion: row.version, evidenceIds };
    });
  }
  function rejectProposal(scope, proposalId, body) {
    onlyKeys(body, ['operationId'], 'Отклонение предложения');
    return store.mutate({ scope, operationId: requireOperation(body), action: 'proposal_reject', body: { proposalId } }, ({ event }) => {
      const proposal = store.proposal(scope, proposalId); if (!proposal) throw notFound('Предложение не найдено.');
      if (proposal.state !== 'pending' && proposal.state !== 'stale') throw err('Предложение уже обработано.', 'proposal_conflict');
      store.setProposalState(scope, proposal.id, proposal.state, 'rejected');
      event('proposal_reject', { proposalId, state: proposal.state }, { proposalId, state: 'rejected' });
      return { proposalId, state: 'rejected' };
    });
  }
  function setPrefs(scope, body) {
    onlyKeys(body, ['operationId', 'expectedVersion', 'strict'], 'Настройки каркаса');
    if (typeof body.strict !== 'boolean') throw err('Укажите строгий режим.', 'narrative_invalid', 400);
    return store.mutate({ scope, operationId: requireOperation(body), action: 'prefs', body }, ({ event }) => {
      const before = store.prefs(scope);
      store.setPrefs(scope, body.expectedVersion, { strict: body.strict });
      event('prefs', before, { strict: body.strict });
      return { strict: body.strict };
    });
  }

  // ---------- Agent request staging ----------
  // Builds the immutable narrative context and manifest from approved snapshots and saved text only.
  function prepare(input, { documentId, documentVersion, noteId, selectedText } = {}) {
    onlyKeys(input, ['mode', 'chapterId', 'focusStageIds', 'includeDraft', 'sources', 'documentHash'], 'Каркас для агента');
    if (input.mode !== 'write' && input.mode !== 'discuss') throw err('Выберите режим: писать по каркасу или обсудить план.', 'narrative_invalid', 400);
    const active = selection(); if (!active?.bookId) throw err('Откройте книгу, чтобы работать по каркасу.', 'book_required', 409);
    const scope = scopeFor(active.bookId), state = computeState(scope);
    if (input.mode === 'write' && noteId !== undefined) throw err('Заметка не служит рукописью главы. Для работы по каркасу откройте главу или черновик; заметку можно обсудить в режиме «Обсудить план».', 'note_not_manuscript', 400);
    if (input.mode === 'write' && input.includeDraft) throw err('Неутверждённый черновик плана можно передать только в режиме обсуждения.', 'narrative_invalid', 400);
    const bookSnapshot = state.bookSnapshot;
    if (input.mode === 'write' && !bookSnapshot) throw err('Каркас книги ещё не согласован. Создайте и согласуйте общую линию; обычный разговор доступен без каркаса.', 'narrative_not_approved');
    let chapter = null;
    if (input.chapterId !== undefined && input.chapterId !== null) {
      const row = validId(input.chapterId) ? store.chapter(scope, input.chapterId) : null; if (!row) throw notFound('Глава каркаса не найдена.');
      const plan = state.chapterPlans.get(row.chapterId) ?? null, snapshot = state.snapshot(plan?.activeSnapshotId), compatibility = snapshot ? chapterCompatibility(snapshot, bookSnapshot) : null;
      if (input.mode === 'write' && plan && !snapshot) throw err('Сюжетка этой главы ещё не согласована. Согласуйте её или удалите черновик сюжетки.', 'chapter_not_approved');
      if (input.mode === 'write' && snapshot && !compatibility.compatible) throw err('Нужно согласовать связь: сюжетка главы ссылается на изменённые или удалённые этапы общей линии.', 'chapter_link_outdated', 409, { problems: compatibility.problems });
      chapter = { chapterId: row.chapterId, title: row.title, planId: plan?.id ?? null, snapshot, compatibility, sourceIdentity: row.sourceIdentity };
    }
    const focusStageIds = input.focusStageIds ?? [];
    if (!Array.isArray(focusStageIds) || focusStageIds.length > 200 || focusStageIds.some(id => !validId(id))) throw err('Выбранные этапы указаны неверно.', 'narrative_invalid', 400);
    for (const id of focusStageIds) if (!activeStages(bookSnapshot?.payload).some(stage => stage.id === id) && !activeStages(chapter?.snapshot?.payload).some(stage => stage.id === id)) throw err('Выбранный этап отсутствует в согласованной версии.', 'stage_changed');
    let draft = null;
    if (input.includeDraft) {
      const plan = input.includeDraft === 'book' ? state.bookPlan : input.includeDraft === 'chapter' && chapter ? state.chapterPlans.get(chapter.chapterId) : null;
      if (!plan) throw err('Черновик для обсуждения не найден.', 'not_found', 404);
      draft = { planId: plan.id, kind: plan.kind, draftVersion: plan.draftVersion, draftHash: plan.draftHash, payload: plan.draft };
    }
    // Saved text pinned by identity and SHA-256 of the specific chapter; the browser text is never a source.
    const sources = [], googleChapters = [];
    const requested = input.sources ?? [];
    if (!Array.isArray(requested) || requested.length > 40) throw err('Выберите не больше 40 глав.', 'narrative_invalid', 400);
    if (requested.length && documentId !== undefined && documentId !== null) throw err('Передайте либо главы рукописи, либо локальный черновик.', 'narrative_invalid', 400);
    for (const entry of requested) {
      onlyKeys(entry, ['kind', 'documentId', 'key', 'textHash'], 'Глава для агента');
      if (entry.kind !== 'google' || typeof entry.key !== 'string' || typeof entry.textHash !== 'string' || typeof entry.documentId !== 'string') throw err('Глава для агента указана неверно: нужна полная привязка рукописи.', 'narrative_invalid', 400);
      const m = state.sources.manuscript();
      if (m.status !== 'ok' || !m.copy) throw err('Рабочий файл рукописи недоступен. Сохраните главу в рабочий файл.', 'save_first');
      if (entry.documentId !== m.documentId) throw err('Основная рукопись изменилась. Обновите главы перед отправкой.', 'manuscript_changed');
      const item = m.copy.chapters.find(value => value.key === entry.key);
      if (!item) throw err('Глава не найдена в рабочем файле. ' + SAVE_FIRST, 'save_first');
      const hash = sha256(item.body);
      if (hash !== entry.textHash) throw err(SAVE_FIRST, 'save_first');
      const identity = googleIdentity(m.documentId, item.key);
      sources.push({ chapterId: store.chapterBySource(scope, identity)?.chapterId ?? null, sourceIdentity: identity, ref: { kind: 'google', documentId: m.documentId, key: item.key }, workingVersion: m.copy.version, textHash: hash, title: item.title || item.label || '' });
      googleChapters.push({ bookId: scope.bookId, documentId: m.documentId, documentName: m.name ?? '', sectionId: item.key, revisionId: item.baseRevision || '', tabTitle: item.tabTitle || '', title: (item.title || item.label || '').slice(0, 400), text: item.body, edited: item.body !== item.baseBody });
    }
    if (documentId !== undefined && documentId !== null) {
      const doc = typeof documentId === 'string' ? getDocument(documentId) : null;
      if (!doc) throw notFound('Черновик не найден.');
      if (sha256(doc.text) !== input.documentHash) throw err(SAVE_FIRST, 'save_first');
      if (doc.authorId !== scope.authorId || doc.seriesId !== scope.seriesId || doc.bookId !== scope.bookId) throw err('Черновик относится к другой книге.', 'binding_scope');
      const identity = documentIdentity(doc.id);
      sources.push({ chapterId: store.chapterBySource(scope, identity)?.chapterId ?? null, sourceIdentity: identity, ref: { kind: 'document', id: doc.id }, workingVersion: doc.version, textHash: sha256(doc.text), title: doc.title });
    }
    if (chapter && input.mode === 'write' && sources.length && !sources.some(source => source.chapterId === chapter.chapterId)) throw err('Открытый текст не привязан к выбранной главе каркаса. Привяжите его или отправьте запрос без текста.', 'source_not_bound');
    let manuscriptContext = null;
    const selected = typeof selectedText === 'string' ? selectedText : '';
    if (googleChapters.length) manuscriptContext = formatManuscriptContext(googleChapters, selected);
    const narrativeContext = buildNarrativeContext({ mode: input.mode, scope: { authorId: scope.authorId, seriesId: scope.seriesId, bookId: scope.bookId }, book: bookSnapshot ? { planId: state.bookPlan.id, snapshot: bookSnapshot } : null, chapter, draft, focusStageIds, sources, strict: state.prefs.strict, statusOf: state.statusOf });
    const blocks = checkBlockBudget({ narrative: narrativeContext.length, manuscript: manuscriptContext?.length ?? 0 });
    const manifest = {
      mode: input.mode, scope: { authorId: scope.authorId, seriesId: scope.seriesId, bookId: scope.bookId },
      book: bookSnapshot ? { planId: state.bookPlan.id, snapshotId: bookSnapshot.id, version: bookSnapshot.version, hash: bookSnapshot.hash } : null,
      chapter: chapter ? { chapterId: chapter.chapterId, planId: chapter.planId, snapshotId: chapter.snapshot?.id ?? null, version: chapter.snapshot?.version ?? null, hash: chapter.snapshot?.hash ?? null, compatible: chapter.compatibility?.compatible ?? null, sourceIdentity: chapter.sourceIdentity ?? null } : null,
      draftDiscussion: draft ? { planId: draft.planId, kind: draft.kind, draftVersion: draft.draftVersion, draftHash: draft.draftHash } : null,
      focusStageIds, sources, strict: state.prefs.strict, contextHash: sha256(narrativeContext), blocks,
    };
    const reviewSource = googleChapters.length === 1 ? { identity: JSON.stringify([scope.bookId, googleChapters[0].documentId, googleChapters[0].sectionId]), title: googleChapters[0].title, text: googleChapters[0].text, version: googleChapters[0].revisionId } : null;
    return { scope, narrativeContext, manuscriptContext, manifest, reviewSource };
  }

  function stageAgentRequest(input, context) {
    const prepared = prepare(input, context), requestId = randomUUID(), { scope } = prepared;
    const manifest = { requestId, ...prepared.manifest, createdAt: new Date().toISOString() };
    store.insertRequest(scope, { requestId, mode: manifest.mode, manifest });
    const update = values => { try { store.updateRequest(requestId, values); } catch { /* lifecycle bookkeeping must not break the turn */ } };
    const request = {
      requestId, mode: manifest.mode,
      // Called by the agent right before turn/start: a changed approved version, binding or chapter text cancels the start.
      beforeTurnStart() {
        const current = store.request(requestId), state = computeState(scopeOfManifest(current.manifest)), result = freshness(state, current);
        if (!result.fresh) { update({ status: 'failed', statusReason: result.reasons.join(' ') }); throw err('Каркас или текст изменились после подготовки запроса: ' + result.reasons.join(' ') + ' Отправьте запрос заново.', 'narrative_changed'); }
      },
      onPreflight: accounting => update({ accounting }),
      onTurnStarted: ({ userMessageId } = {}) => update({ status: 'running', userMessageId: userMessageId ?? undefined }),
      onAssistantMessage: id => { if (id) update({ assistantMessageId: id }); },
      onFinished: status => update({ status: status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed' }),
    };
    return { narrativeContext: prepared.narrativeContext, manuscriptContext: prepared.manuscriptContext, reviewSource: prepared.reviewSource, request, manifest };
  }
  const markAccepted = requestId => { const row = store.request(requestId); if (row?.status === 'staged') store.updateRequest(requestId, { status: 'running' }); };
  const markFailed = (requestId, error) => { const row = store.request(requestId); if (row && (row.status === 'staged' || row.status === 'running')) store.updateRequest(requestId, { status: 'failed', statusReason: String(error?.message ?? 'Запрос не запущен.').slice(0, 500) }); };

  // ---------- Agent proposal channel ----------
  // requestId comes from the server-side active turn, never from tool arguments. Only a pending row is created.
  function proposeClosure(requestId, args, call = {}) {
    const request = store.request(requestId);
    if (!request || request.status !== 'running') throw new Error('Narrative proposal rejected: the request is not active.');
    const allowed = ['stageId', 'contentRevision', 'snapshotId', 'chapterId', 'textHash', 'quotes', 'rationale'];
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(args, key))) throw new Error('Narrative proposal arguments do not match the permitted fields.');
    if (!validId(args.stageId) || !Number.isSafeInteger(args.contentRevision) || typeof args.snapshotId !== 'string' || !validId(args.chapterId) || typeof args.textHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.textHash)) throw new Error('Narrative proposal identifiers are invalid.');
    if (!Array.isArray(args.quotes) || !args.quotes.length || args.quotes.length > NARRATIVE_LIMITS.proposalQuotes || args.quotes.some(quote => !quote || typeof quote !== 'object' || Object.keys(quote).some(key => !['quote', 'prefix', 'suffix'].includes(key)))) throw new Error('Narrative proposal quotes are invalid.');
    if (typeof args.rationale !== 'string' || !args.rationale.trim() || args.rationale.length > 4000) throw new Error('Narrative proposal rationale is required.');
    const manifest = request.manifest, scope = scopeOfManifest(manifest), active = selection();
    if (!active || scopeKey(active) !== scope.key) throw new Error('Narrative proposal rejected: the workspace changed.');
    const pinnedPlan = manifest.book?.snapshotId === args.snapshotId ? manifest.book.planId : manifest.chapter?.snapshotId === args.snapshotId ? manifest.chapter.planId : null;
    if (!pinnedPlan) throw new Error('Narrative proposal rejected: the snapshot is not part of this request.');
    const pinnedSource = (manifest.sources ?? []).find(source => source.chapterId === args.chapterId);
    if (!pinnedSource) throw new Error('Narrative proposal rejected: this chapter text is not pinned to the request.');
    if (pinnedSource.textHash !== args.textHash) throw new Error('Narrative proposal rejected: textHash differs from the pinned chapter text.');
    const snapshot = store.snapshot(args.snapshotId), stage = findStage(snapshot?.payload, args.stageId);
    if (!snapshot || snapshot.planId !== pinnedPlan || !stage || stage.archived || stage.contentRevision !== args.contentRevision) throw new Error('Narrative proposal rejected: unknown stage revision in the pinned snapshot.');
    const operationId = 'agent-' + sha256(requestId + '|' + String(call.turnId ?? '') + '|' + String(call.callId ?? randomUUID())).slice(0, 48);
    return store.mutate({ scope, operationId, action: 'proposal', body: { requestId, ...args }, actor: 'agent' }, ({ event }) => {
      const plan = store.plan(scope, pinnedPlan), chapter = store.chapter(scope, args.chapterId), source = sourceResolver(scope).resolve(chapter);
      if (store.progress(pinnedPlan, stage.id, stage.contentRevision)?.state === 'closed') throw new Error('Narrative proposal rejected: the stage is already closed.');
      const manifestState = freshness(computeState(scope), request);
      let state = manifestState.fresh ? 'pending' : 'stale', reason = manifestState.fresh ? null : manifestState.reasons.join(' '), anchors;
      if (!manifestState.fresh) { /* The whole pinned request, not just this proposal's plan, is stale. */ }
      else if (!plan || plan.activeSnapshotId !== args.snapshotId) { state = 'stale'; reason = 'Согласована другая версия каркаса во время ответа.'; }
      else if (source.identity !== pinnedSource.sourceIdentity || source.hash !== args.textHash) { state = 'stale'; reason = 'Текст главы изменён во время ответа.'; }
      if (state === 'pending') anchors = args.quotes.map(quote => { try { return resolveQuote(source.text, quote); } catch (error) { throw new Error('Narrative proposal rejected: ' + error.message); } });
      else anchors = args.quotes.map(quote => ({ quote: String(quote.quote ?? ''), prefix: String(quote.prefix ?? ''), suffix: String(quote.suffix ?? ''), start: null, end: null }));
      const row = store.insertProposal(scope, { requestId, planId: pinnedPlan, snapshotId: args.snapshotId, stageId: stage.id, contentRevision: stage.contentRevision, chapterId: args.chapterId, sourceIdentity: pinnedSource.sourceIdentity, textHash: args.textHash, anchors, rationale: args.rationale.trim(), state, reason, callRef: JSON.stringify({ turnId: call.turnId ?? null, callId: call.callId ?? null }) });
      event('proposal', null, { proposalId: row.id, requestId, state, stageId: stage.id });
      return { proposalId: row.id, requestId, state, reason, note: 'Saved as a pending proposal for the author. The stage is NOT closed; only the author can accept it.' };
    });
  }

  // Records the creation receipt of new Google chapters right after a verified apply (before the working file is
  // re-imported), so a chapter binding can later follow the receipt instead of similar text.
  function recordApplyReceipt({ bookId, documentId, operationId, newKeys, sentChapters }) {
    if (!Array.isArray(newKeys) || !newKeys.length || typeof operationId !== 'string') return;
    const scope = scopeFor(bookId), m = readManuscript(bookId);
    const priorKeys = m?.status === 'ok' && m.copy ? [...new Set([...m.copy.chapters.map(item => item.key), ...(m.copy.manuscript?.sections ?? []).map(section => section.sectionId)])] : [];
    const sentTitles = Object.fromEntries((Array.isArray(sentChapters) ? sentChapters : []).filter(item => item && typeof item.key === 'string').map(item => [item.key, String(item.title ?? '')]));
    store.insertReceipt(scope, { operationId, bookId, documentId, newKeys, sentTitles, priorKeys });
  }

  // ---------- HTTP ----------
  const ROUTE = /^\/api\/books\/([A-Za-z0-9_-]{1,80})\/narrative(?:\/(.*))?$/;
  function handle(method, pathname, body) {
    const match = pathname.match(ROUTE); if (!match) return null;
    const scope = scopeFor(match[1]), rest = match[2] ?? '', parts = rest ? rest.split('/') : [];
    const done = receipt => ({ status: 200, data: { receipt, narrative: view(scope) } });
    if (method === 'GET' && !parts.length) return { status: 200, data: view(scope) };
    if (method === 'GET' && parts[0] === 'operations' && parts.length === 2) { const receipt = store.operation(scope, parts[1]); if (!receipt) throw notFound('Операция не найдена в этой книге. Это не подтверждает ни успех, ни отказ.'); return { status: 200, data: { receipt } }; }
    if (method === 'GET' && parts[0] === 'snapshots' && parts.length === 2) { const snapshot = store.snapshot(parts[1]); if (!snapshot || !store.plan(scope, snapshot.planId)) throw notFound('Версия не найдена.'); return { status: 200, data: { snapshot } }; }
    if (method === 'POST' && rest === 'context-preview') { const prepared = prepare(body.narrative ?? {}, { documentId: body.documentId, documentVersion: body.documentVersion, noteId: body.noteId, selectedText: body.selectedText }); return { status: 200, data: { narrativeContext: prepared.narrativeContext, manifest: prepared.manifest, manuscriptContextSize: prepared.manuscriptContext?.length ?? 0 } }; }
    if (method === 'PUT' && rest === 'prefs') return done(setPrefs(scope, body));
    if (method === 'POST' && rest === 'chapters') return done(createChapter(scope, body));
    if (parts[0] === 'chapters' && validId(parts[1])) {
      if (method === 'PUT' && parts.length === 2) return done(updateChapter(scope, parts[1], body));
      if (method === 'POST' && parts[2] === 'bind' && parts.length === 3) return done(bindChapter(scope, parts[1], body));
      if (method === 'POST' && parts[2] === 'reconfirm' && parts.length === 3) return done(reconfirm(scope, parts[1], body));
    }
    if (method === 'POST' && parts[0] === 'stages' && validId(parts[1]) && parts.length === 3) {
      if (parts[2] === 'evidence') return done(addEvidence(scope, parts[1], body));
      if (parts[2] === 'decision') return done(decide(scope, parts[1], body));
    }
    if (method === 'POST' && parts[0] === 'evidence' && parts[2] === 'retire' && parts.length === 3) return done(retireEvidence(scope, parts[1], body));
    if (method === 'POST' && parts[0] === 'proposals' && parts.length === 3 && ['accept', 'reject'].includes(parts[2])) return done(parts[2] === 'accept' ? acceptProposal(scope, parts[1], body) : rejectProposal(scope, parts[1], body));
    if (parts.length === 2 && ID_PATTERN.test(parts[0])) {
      if (method === 'PUT' && parts[1] === 'draft') return done(saveDraft(scope, parts[0], body));
      if (method === 'POST' && parts[1] === 'approve') return done(approve(scope, parts[0], body));
    }
    throw notFound('Route not found.');
  }

  return { handle, view: bookId => view(scopeFor(bookId)), stageAgentRequest, prepare, markAccepted, markFailed, proposeClosure, recordApplyReceipt, freshnessOf: requestId => { const request = store.request(requestId); return request ? freshness(computeState(scopeOfManifest(request.manifest)), request) : null; } };
}
