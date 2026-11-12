import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../store.mjs';
import { createNarrativeService } from '../narrative-service.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const TEXT1 = 'Утро. Кай нашёл ключ под камнем. Он решил вернуться домой. Вечер.';
const TEXT2 = 'Вторая глава. Мира ждёт у ворот.';
let counter = 0; const op = () => 'op-' + (++counter).toString().padStart(6, '0');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tw-narrative-')), store = openStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const selection = { authorId: 'author_1', seriesId: 'series_1', bookId: 'book_1' };
  const chapter = (key, title, body, extra = {}) => ({ key, kind: 'section', sectionId: key, title, label: title, hasHeading: true, detection: 'heading', body, baseBody: body, baseTitle: title, baseRevision: 'rev1', tabTitle: 'Книга', ...extra });
  const manuscript = { status: 'ok', documentId: 'doc_main', name: 'Рукопись', copy: { version: 1, chapters: [chapter('sec-1', 'Глава 1', TEXT1), chapter('sec-2', 'Глава 2', TEXT2)], manuscript: { sections: [{ sectionId: 'sec-1' }, { sectionId: 'sec-2' }] } } };
  const service = createNarrativeService({ narrativeStore: store.narrative, selection: () => selection, readManuscript: () => manuscript, getDocument: id => store.getDocument(id), listDocuments: () => store.listDocuments() });
  const call = (method, suffix, body = {}) => service.handle(method, '/api/books/book_1/narrative' + suffix, body).data;
  const edit = (key, body) => { const item = manuscript.copy.chapters.find(x => x.key === key); item.body = body; manuscript.copy.version++; };
  return { store, service, call, manuscript, selection, edit, chapter };
}
const stage = (id, extra = {}) => ({ id, lineId: 'line-main', title: 'Этап ' + id, expectedChange: 'Изменение ' + id, ...extra });
const bookDraft = stages => ({ title: 'Линия', intent: 'Замысел', lines: [{ id: 'line-main', title: 'Основная', primary: true }], stages });

async function approvedBook(f, stages) {
  const created = f.call('PUT', '/book-plan-1/draft', { expectedVersion: 0, kind: 'book', draft: bookDraft(stages), operationId: op() });
  const plan = created.narrative.book;
  f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: plan.draftVersion, shownHash: plan.draftHash, expectedActiveSnapshotId: null, operationId: op() });
  return f.call('GET', '').book;
}
const decide = (f, plan, stageId, action, extra = {}) => {
  const st = plan.statuses[stageId];
  return f.call('POST', `/stages/${stageId}/decision`, { planId: plan.id, snapshotId: plan.activeSnapshot.id, contentRevision: st.contentRevision, action, expectedProgressVersion: st.progressVersion, operationId: op(), ...extra });
};

test('approved snapshots are immutable; the agent context keeps the old snapshot until a new one is approved', async t => {
  const f = setup(t);
  const book = await approvedBook(f, [stage('stage-a'), stage('stage-b')]);
  assert.equal(book.activeSnapshot.version, 1);
  const first = f.service.prepare({ mode: 'write' }).narrativeContext;
  assert.match(first, /APPROVED NARRATIVE FRAMEWORK/); assert.match(first, /Этап stage-a/);
  // A changed draft is not used by the agent until approved.
  f.call('PUT', '/book-plan-1/draft', { expectedVersion: book.draftVersion, draft: bookDraft([stage('stage-a', { title: 'Новое имя', expectedChange: 'Другое' }), stage('stage-b')]), operationId: op() });
  assert.equal(f.service.prepare({ mode: 'write' }).narrativeContext, first);
  const stale = f.call('GET', '').book;
  assert.throws(() => f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: stale.draftVersion, shownHash: 'f'.repeat(64), expectedActiveSnapshotId: stale.activeSnapshot.id, operationId: op() }), error => error.code === 'shown_hash_mismatch');
  f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: stale.draftVersion, shownHash: stale.draftHash, expectedActiveSnapshotId: stale.activeSnapshot.id, operationId: op() });
  const second = f.service.prepare({ mode: 'write' }).narrativeContext;
  assert.match(second, /Новое имя/); assert.doesNotMatch(second, /Этап stage-a/);
  const old = f.call('GET', `/snapshots/${book.activeSnapshot.id}`).snapshot;
  assert.equal(old.payload.stages[0].title, 'Этап stage-a', 'snapshot payload never changes');
  assert.throws(() => f.call('PUT', '/book-plan-1/draft', { expectedVersion: 1, draft: bookDraft([]), operationId: op() }), error => error.status === 409 && error.code === 'draft_conflict');
});

test('reorder and re-approval keep closures; a new content revision does not inherit a closure; reopen keeps history', async t => {
  const f = setup(t);
  let book = await approvedBook(f, [stage('stage-a'), stage('stage-b')]);
  decide(f, book, 'stage-a', 'close', { evidenceIds: [], reason: 'Решено в черновике сцены', basisChapterIds: [] });
  book = f.call('GET', '').book;
  assert.equal(book.statuses['stage-a'].label, 'Подтверждено автором без фрагмента');
  f.call('PUT', '/book-plan-1/draft', { expectedVersion: book.draftVersion, draft: bookDraft([stage('stage-b'), stage('stage-a')]), operationId: op() });
  book = f.call('GET', '').book;
  f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: book.draftVersion, shownHash: book.draftHash, expectedActiveSnapshotId: book.activeSnapshot.id, operationId: op() });
  book = f.call('GET', '').book;
  assert.deepEqual(book.activeSnapshot.payload.stages.map(s => s.id), ['stage-b', 'stage-a']);
  assert.equal(book.statuses['stage-a'].state, 'closed', 'reorder + re-approval keeps the closure');
  f.call('PUT', '/book-plan-1/draft', { expectedVersion: book.draftVersion, draft: bookDraft([stage('stage-b'), stage('stage-a', { closureCriterion: 'Строже' })]), operationId: op() });
  book = f.call('GET', '').book;
  f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: book.draftVersion, shownHash: book.draftHash, expectedActiveSnapshotId: book.activeSnapshot.id, operationId: op() });
  book = f.call('GET', '').book;
  assert.equal(book.statuses['stage-a'].contentRevision, 2);
  assert.equal(book.statuses['stage-a'].state, 'not_started', 'a changed meaning is a new revision without the old closure');
  const history = f.call('GET', '').progress.find(row => row.stageId === 'stage-a' && row.contentRevision === 1);
  assert.equal(history.state, 'closed', 'the historic closure of r1 is kept');
  decide(f, book, 'stage-b', 'start');
  book = f.call('GET', '').book;
  decide(f, book, 'stage-b', 'close', { evidenceIds: [], reason: 'Готово', basisChapterIds: [] });
  book = f.call('GET', '').book;
  decide(f, book, 'stage-b', 'reopen', { reason: 'Нужно переписать' });
  const events = f.call('GET', '').events.map(event => event.action);
  assert.ok(events.includes('decision:reopen') && events.includes('decision:close'));
  assert.equal(f.call('GET', '').book.statuses['stage-b'].state, 'in_progress');
});

test('operations are idempotent; a reused id with another body is refused; stale progress versions are refused', async t => {
  const f = setup(t);
  const book = await approvedBook(f, [stage('stage-a')]);
  const id = op(), body = { planId: book.id, snapshotId: book.activeSnapshot.id, contentRevision: 1, action: 'start', expectedProgressVersion: 0, operationId: id };
  const first = f.call('POST', '/stages/stage-a/decision', body).receipt;
  const replay = f.call('POST', '/stages/stage-a/decision', body).receipt;
  assert.equal(replay.replayed, true); assert.equal(replay.progressVersion, first.progressVersion);
  assert.equal(f.call('GET', '').events.filter(event => event.action === 'decision:start').length, 1, 'retry with the same id creates no second event');
  assert.equal(f.call('GET', `/operations/${id}`).receipt.progressVersion, 1);
  assert.throws(() => f.call('POST', '/stages/stage-a/decision', { ...body, action: 'close', reason: 'x', evidenceIds: [] }), error => error.code === 'operation_conflict');
  assert.throws(() => f.call('POST', '/stages/stage-a/decision', { ...body, action: 'close', reason: 'x', evidenceIds: [], operationId: op() }), error => error.code === 'progress_conflict');
  assert.throws(() => f.call('GET', '/operations/op-unknown-1'), error => error.status === 404);
});

test('chapter plot pins parent revisions; a changed parent blocks writing until the link is re-approved, keeping local closures; parents never auto-close', async t => {
  const f = setup(t);
  let book = await approvedBook(f, [stage('stage-p')]);
  const chapterId = f.call('POST', '/chapters', { title: 'Глава 1', operationId: op() }).receipt.chapterId;
  const chapterDraft = { title: 'Сюжетка', goal: 'Кай находит ключ', stages: [{ id: 'stage-l1', title: 'Находка', expectedChange: 'Ключ найден', parentStageIds: ['stage-p'] }] };
  f.call('PUT', '/chapter-plan-1/draft', { expectedVersion: 0, kind: 'chapter', chapterId, draft: chapterDraft, operationId: op() });
  let chapter = f.call('GET', '').chapters[0];
  assert.equal(chapter.counter.label, 'План не согласован');
  assert.throws(() => f.service.prepare({ mode: 'write', chapterId }), error => error.code === 'chapter_not_approved');
  f.call('POST', '/chapter-plan-1/approve', { expectedDraftVersion: 1, shownHash: chapter.plan.draftHash, expectedActiveSnapshotId: null, expectedBookSnapshotId: book.activeSnapshot.id, operationId: op() });
  chapter = f.call('GET', '').chapters[0];
  assert.deepEqual(chapter.plan.activeSnapshot.payload.parentPins, [{ stageId: 'stage-p', contentRevision: 1 }]);
  decide(f, chapter.plan, 'stage-l1', 'close', { evidenceIds: [], reason: 'Сцена написана', basisChapterIds: [] });
  book = f.call('GET', '').book;
  assert.equal(book.statuses['stage-p'].state, 'not_started', 'closing every child stage does not close the parent');
  assert.equal(f.call('GET', '').chapters[0].counter.label, '1 из 1 закрыто');
  // The parent's meaning changes: the chapter link becomes incompatible.
  f.call('PUT', '/book-plan-1/draft', { expectedVersion: book.draftVersion, draft: bookDraft([stage('stage-p', { expectedChange: 'Иначе' })]), operationId: op() });
  book = f.call('GET', '').book;
  const approval = f.call('POST', '/book-plan-1/approve', { expectedDraftVersion: book.draftVersion, shownHash: book.draftHash, expectedActiveSnapshotId: book.activeSnapshot.id, operationId: op() }).receipt;
  assert.deepEqual(approval.affectedChapters.map(item => item.chapterId), [chapterId]);
  chapter = f.call('GET', '').chapters[0];
  assert.equal(chapter.compatibility.compatible, false);
  assert.throws(() => f.service.prepare({ mode: 'write', chapterId }), error => error.code === 'chapter_link_outdated');
  assert.ok(f.service.prepare({ mode: 'discuss', chapterId }).narrativeContext.includes('NOT compatible'), 'discussion stays available and is explicit');
  const book2 = f.call('GET', '').book;
  f.call('POST', '/chapter-plan-1/approve', { expectedDraftVersion: chapter.plan.draftVersion, shownHash: chapter.plan.draftHash, expectedActiveSnapshotId: chapter.plan.activeSnapshot.id, expectedBookSnapshotId: book2.activeSnapshot.id, operationId: op() });
  chapter = f.call('GET', '').chapters[0];
  assert.equal(chapter.compatibility.compatible, true);
  assert.equal(chapter.plan.statuses['stage-l1'].state, 'closed', 're-approving the link keeps unchanged local closures');
  assert.match(f.service.prepare({ mode: 'write', chapterId }).narrativeContext, /CHAPTER PLOT/);
});

test('evidence is anchored to saved text; browser hash mismatch, edits, strict mode, ambiguity and rebinding are reported honestly', async t => {
  const f = setup(t);
  const book = await approvedBook(f, [stage('stage-a')]);
  const chapterId = f.call('POST', '/chapters', { title: 'Глава 1', operationId: op() }).receipt.chapterId;
  f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 0, binding: { kind: 'google', key: 'sec-1' }, operationId: op() });
  const start = TEXT1.indexOf('Кай нашёл'), end = TEXT1.indexOf(' Он решил'), quote = TEXT1.slice(start, end);
  const evidence = hash => ({ planId: book.id, snapshotId: book.activeSnapshot.id, contentRevision: 1, chapterId, textHash: hash, start, end, quote, operationId: op() });
  assert.throws(() => f.call('POST', '/stages/stage-a/evidence', evidence(sha(TEXT1 + 'не сохранено'))), error => error.status === 409 && error.code === 'save_first');
  assert.throws(() => f.call('POST', '/stages/stage-a/evidence', { ...evidence(sha(TEXT1)), quote: 'подмена' }), error => error.code === 'evidence_mismatch');
  const evidenceId = f.call('POST', '/stages/stage-a/evidence', evidence(sha(TEXT1))).receipt.evidenceId;
  let plan = f.call('GET', '').book;
  decide(f, plan, 'stage-a', 'close', { evidenceIds: [evidenceId] });
  const state = () => { const data = f.call('GET', ''); return { status: data.book.statuses['stage-a'], evidence: data.evidence.find(item => item.id === evidenceId) }; };
  assert.equal(state().status.label, 'Закрыт · фрагмент актуален');
  f.edit('sec-1', TEXT1 + ' Добавлен абзац.');
  assert.equal(state().evidence.location, 'intact'); assert.equal(state().status.label, 'Закрыт автором · глава изменена');
  f.call('PUT', '/prefs', { expectedVersion: 0, strict: true, operationId: op() });
  assert.equal(state().status.label, 'Закрыт ранее · проверить фрагмент', 'strict mode is presentation only');
  f.call('PUT', '/prefs', { expectedVersion: 1, strict: false, operationId: op() });
  f.edit('sec-1', 'Новое начало. ' + TEXT1);
  assert.equal(state().evidence.location, 'shifted');
  f.edit('sec-1', TEXT1 + ' ' + TEXT1);
  assert.equal(state().evidence.location, 'ambiguous'); assert.equal(state().status.label, 'Закрыт ранее · проверить фрагмент');
  f.edit('sec-1', TEXT1.replace('Утро.', 'Полдень!'));
  assert.equal(state().evidence.location, 'window_changed');
  f.edit('sec-1', 'Совсем другой текст.');
  assert.equal(state().evidence.location, 'lost'); assert.equal(state().status.label, 'Закрыт ранее · фрагмент не найден');
  // Reconfirmation is explicit and only for intact/shifted anchors.
  f.edit('sec-1', 'Пролог. ' + TEXT1);
  const current = f.call('GET', ''), item = current.evidence.find(x => x.id === evidenceId), chapter = current.chapters[0];
  assert.throws(() => f.call('POST', `/chapters/${chapterId}/reconfirm`, { textHash: sha('другое'), evidence: [{ id: item.id, version: item.version }], operationId: op() }), error => error.code === 'save_first');
  f.call('POST', `/chapters/${chapterId}/reconfirm`, { textHash: chapter.source.hash, evidence: [{ id: item.id, version: item.version }], operationId: op() });
  assert.equal(state().status.label, 'Закрыт · фрагмент актуален');
  // Replacing the binding never carries evidence to another text.
  assert.throws(() => f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, binding: { kind: 'google', key: 'sec-2' }, operationId: op() }), error => error.code === 'rebind_requires_confirmation');
  f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, binding: { kind: 'google', key: 'sec-2' }, confirmReplace: true, operationId: op() });
  assert.equal(state().evidence.tone, 'lost');
  // A second chapter cannot claim the same text.
  const other = f.call('POST', '/chapters', { title: 'Дубль', operationId: op() }).receipt.chapterId;
  assert.throws(() => f.call('POST', `/chapters/${other}/bind`, { expectedBindingVersion: 0, binding: { kind: 'google', key: 'sec-2' }, operationId: op() }), error => error.code === 'binding_ambiguous');
  // Changing the main manuscript keeps the plan but not the evidence.
  f.manuscript.documentId = 'doc_other';
  const moved = f.call('GET', '');
  assert.equal(moved.chapters[0].source.status, 'other_manuscript'); assert.ok(moved.book.activeSnapshot);
});

test('creation receipts without exact Google IDs require manual binding even with a unique matching title', async t => {
  const f = setup(t);
  f.manuscript.copy.chapters.push({ ...f.chapter('new:abc', 'Новая глава', 'Черновик новой главы'), kind: 'new', sectionId: '', newKey: 'abc', detection: 'new' });
  const chapterId = f.call('POST', '/chapters', { title: 'Будущая', operationId: op() }).receipt.chapterId;
  f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 0, binding: { kind: 'google', key: 'new:abc' }, operationId: op() });
  f.service.recordApplyReceipt({ bookId: 'book_1', documentId: 'doc_main', operationId: 'apply-op-1', newKeys: ['abc'], sentChapters: [{ key: 'abc', title: 'Новая глава' }] });
  assert.throws(() => f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, receiptOperationId: 'apply-op-1', operationId: op() }), error => error.code === 'receipt_pending');
  // The working file is re-imported after the verified write: the new key is retired and a section appears.
  f.manuscript.copy.chapters = f.manuscript.copy.chapters.filter(item => item.key !== 'new:abc');
  f.manuscript.copy.chapters.push(f.chapter('h.created', 'Новая глава', 'Черновик новой главы'), f.chapter('h.other', 'Новая глава', 'Дубль'));
  assert.equal(f.call('GET', '').chapters[0].transferReceipt, 'apply-op-1');
  assert.throws(() => f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, receiptOperationId: 'apply-op-1', operationId: op() }), error => error.code === 'binding_ambiguous');
  f.manuscript.copy.chapters = f.manuscript.copy.chapters.filter(item => item.key !== 'h.other');
  assert.throws(() => f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, receiptOperationId: 'apply-op-1', operationId: op() }), error => error.code === 'binding_ambiguous');
  f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 1, binding: {kind:'google',key:'h.created'}, confirmReplace:true, operationId: op() });
  const chapter = f.call('GET', '').chapters[0];
  assert.equal(chapter.chapterId, chapterId); assert.equal(chapter.binding.key, 'h.created'); assert.equal(chapter.binding.via, undefined); assert.equal(chapter.binding.aliases, undefined);
});

test('agent proposals are request-bound, pending only, stale after text changes, and accepted only by the author', async t => {
  const f = setup(t);
  const book = await approvedBook(f, [stage('stage-a')]);
  const chapterId = f.call('POST', '/chapters', { title: 'Глава 1', operationId: op() }).receipt.chapterId;
  f.call('POST', `/chapters/${chapterId}/bind`, { expectedBindingVersion: 0, binding: { kind: 'google', key: 'sec-1' }, operationId: op() });
  const staged = f.service.stageAgentRequest({ mode: 'write', chapterId, sources: [{ kind: 'google', documentId: 'doc_main', key: 'sec-1', textHash: sha(TEXT1) }] }, {});
  assert.match(staged.manuscriptContext, /Кай нашёл ключ/);
  assert.equal(staged.manifest.sources[0].chapterId, chapterId);
  const args = { stageId: 'stage-a', contentRevision: 1, snapshotId: book.activeSnapshot.id, chapterId, textHash: sha(TEXT1), quotes: [{ quote: 'Кай нашёл ключ под камнем.' }], rationale: 'Ключ найден — критерий выполнен.' };
  assert.throws(() => f.service.proposeClosure(staged.request.requestId, args), /not active/, 'a staged request that never started cannot propose');
  staged.request.onTurnStarted({ userMessageId: 'm1' });
  assert.throws(() => f.service.proposeClosure(staged.request.requestId, { ...args, action: 'approve' }), /permitted fields/);
  assert.throws(() => f.service.proposeClosure(staged.request.requestId, { ...args, textHash: 'a'.repeat(64) }), /pinned/);
  assert.throws(() => f.service.proposeClosure(staged.request.requestId, { ...args, quotes: [{ quote: 'выдуманная цитата' }] }), /не найдена/);
  const receipt = f.service.proposeClosure(staged.request.requestId, args, { turnId: 't1', callId: 'c1' });
  assert.equal(receipt.state, 'pending');
  assert.equal(f.service.proposeClosure(staged.request.requestId, args, { turnId: 't1', callId: 'c1' }).replayed, true);
  let data = f.call('GET', '');
  assert.equal(data.book.statuses['stage-a'].state, 'proposed'); assert.equal(data.book.statuses['stage-a'].stored, 'not_started', 'a proposal is not stored state');
  f.edit('sec-1', TEXT1 + ' Правка.');
  const stale = f.service.proposeClosure(staged.request.requestId, args, { turnId: 't1', callId: 'c2' });
  assert.equal(stale.state, 'stale');
  assert.equal(f.service.freshnessOf(staged.request.requestId).fresh, false);
  const accept = f.call('POST', `/proposals/${receipt.proposalId}/accept`, { expectedProgressVersion: 0, operationId: op() }).receipt;
  assert.equal(accept.accepted, false); assert.equal(accept.state, 'stale');
  f.edit('sec-1', TEXT1);
  staged.request.onFinished('completed');
  assert.throws(() => f.service.proposeClosure(staged.request.requestId, args, { turnId: 't1', callId: 'c3' }), /not active/, 'after the turn no proposal is accepted');
  const second = f.service.stageAgentRequest({ mode: 'write', chapterId, sources: [{ kind: 'google', documentId: 'doc_main', key: 'sec-1', textHash: sha(TEXT1) }] }, {});
  second.request.onTurnStarted({});
  const fresh = f.service.proposeClosure(second.request.requestId, args, { turnId: 't2', callId: 'c1' });
  data = f.call('GET', '');
  const accepted = f.call('POST', `/proposals/${fresh.proposalId}/accept`, { expectedProgressVersion: data.book.statuses['stage-a'].progressVersion, operationId: op() }).receipt;
  assert.equal(accepted.accepted, true);
  data = f.call('GET', '');
  assert.equal(data.book.statuses['stage-a'].label, 'Закрыт · фрагмент актуален');
  assert.equal(data.evidence[0].origin, 'agent-proposal');
});

test('agent staging: approval required for writing, browser text is never a source, notes are not manuscripts, budget is explicit', async t => {
  const f = setup(t);
  assert.throws(() => f.service.prepare({ mode: 'write' }), error => error.code === 'narrative_not_approved');
  assert.ok(f.service.prepare({ mode: 'discuss' }).narrativeContext.includes('APPROVED NARRATIVE FRAMEWORK'), 'discussion without a plan is allowed');
  await approvedBook(f, [stage('stage-a', { disclosureConstraints: 'Не раскрывать имя отца до финала' })]);
  assert.match(f.service.prepare({ mode: 'write', focusStageIds: ['stage-a'] }).narrativeContext, /FUTURE DISCLOSURE CONSTRAINTS[\s\S]*имя отца/);
  assert.throws(() => f.service.prepare({ mode: 'write', sources: [{ kind: 'google', documentId: 'doc_main', key: 'sec-1', textHash: sha('подменённый браузерный текст') }] }), error => error.status === 409 && error.code === 'save_first');
  assert.throws(() => f.service.prepare({ mode: 'write', sources: [{ kind: 'google', documentId: 'doc_main', key: 'sec-1', textHash: sha(TEXT1), text: TEXT1 }] }), /неподдерживаемые поля/);
  assert.throws(() => f.service.prepare({ mode: 'write' }, { noteId: 'n1' }), error => error.code === 'note_not_manuscript');
  assert.throws(() => f.service.prepare({ mode: 'write', includeDraft: 'book' }), /обсуждения/);
  const doc = f.store.createDocument({ title: 'Черновик', text: 'Локальный текст главы.', authorId: 'author_1', seriesId: 'series_1', bookId: 'book_1' });
  assert.throws(() => f.service.prepare({ mode: 'write', documentHash: sha('другое') }, { documentId: doc.id, documentVersion: doc.version }), error => error.code === 'save_first');
  const local = f.service.prepare({ mode: 'write', documentHash: sha(doc.text) }, { documentId: doc.id, documentVersion: doc.version });
  assert.equal(local.manifest.sources[0].sourceIdentity, JSON.stringify(['document', doc.id]));
  f.manuscript.copy.chapters[0].body = 'х'.repeat(130_000);
  assert.throws(() => f.service.prepare({ mode: 'write', sources: [{ kind: 'google', documentId: 'doc_main', key: 'sec-1', textHash: sha('х'.repeat(130_000)) }] }), error => error.status === 413 && error.code === 'agent_context_too_large' && error.details.blocks.some(block => block.name === 'manuscriptContext'));
});

test('a project relink of a book with narrative data is refused before anything moves; export includes the framework', async t => {
  const f = setup(t);
  await approvedBook(f, [stage('stage-a')]);
  const doc = f.store.createDocument({ title: 'Черновик', text: 'x', authorId: 'author_1', seriesId: 'series_1', bookId: 'book_1' });
  const before = f.store.project.revision();
  assert.throws(() => f.store.project.commit({ expectedRevision: before, action: 'relink', write: ({ moveScope, changeId }) => moveScope(['author_1', 'series_1', 'book_1'], ['author_1', 'series_1', 'book_2'], changeId) }), error => error.status === 409 && /каркас/.test(error.message));
  assert.equal(f.store.getDocument(doc.id).bookId, 'book_1', 'no scoped row moved');
  assert.equal(f.store.project.revision(), before);
  assert.ok(f.store.project.countScope(['author_1', 'series_1', 'book_1']).narrative > 0);
  const exported = f.store.exportData().narrative;
  assert.equal(exported.plans.length, 1); assert.equal(exported.snapshots.length, 1);
});

test('scope: another open book cannot read or change this framework', async t => {
  const f = setup(t);
  await approvedBook(f, [stage('stage-a')]);
  f.selection.bookId = 'book_2';
  assert.throws(() => f.service.handle('GET', '/api/books/book_1/narrative', {}), error => error.code === 'book_changed');
  const other = f.service.handle('GET', '/api/books/book_2/narrative', {}).data;
  assert.equal(other.book, null, 'plans of another book are never returned');
});

test('chapter creation without client ID replays the original receipt after a lost reply', t => {
  const f=setup(t), body={title:'Новая',operationId:op()};
  const first=f.call('POST','/chapters',body).receipt;
  const retry=f.call('POST','/chapters',body).receipt;
  assert.equal(retry.chapterId,first.chapterId);assert.equal(retry.replayed,true);
  assert.equal(f.call('GET','').chapters.length,1);
});

test('title-only draft changes do not invalidate the saved chapter hash; foreign Google identity does',async t=>{
  const f=setup(t);await approvedBook(f,[stage('stage-a')]);
  const doc=f.store.createDocument({...f.selection,title:'До',text:'Тот же текст'});
  f.store.updateDocument(doc.id,{title:'После',text:doc.text,version:doc.version});
  const prepared=f.service.prepare({mode:'write',documentHash:sha(doc.text)},{documentId:doc.id,documentVersion:doc.version});
  assert.equal(prepared.manifest.sources[0].workingVersion,2);
  assert.throws(()=>f.service.prepare({mode:'write',sources:[{kind:'google',documentId:'old_doc',key:'sec-1',textHash:sha(TEXT1)}]}),e=>e.code==='manuscript_changed'&&e.status===409);
  assert.throws(()=>f.service.prepare({mode:'write',sources:[{kind:'google',key:'sec-1',textHash:sha(TEXT1)}]}),e=>e.code==='narrative_invalid');
});

test('proposal creation and acceptance validate the whole request after its parent book changes',async t=>{
  const f=setup(t);let book=await approvedBook(f,[stage('stage-parent')]);
  const chapterId=f.call('POST','/chapters',{title:'Глава',operationId:op()}).receipt.chapterId;
  f.call('POST',`/chapters/${chapterId}/bind`,{expectedBindingVersion:0,binding:{kind:'google',key:'sec-1'},operationId:op()});
  f.call('PUT','/chapter-plan-1/draft',{expectedVersion:0,kind:'chapter',chapterId,draft:{title:'План',stages:[{id:'stage-local',title:'Находка',expectedChange:'Найден ключ',parentStageIds:['stage-parent']}]},operationId:op()});
  let chapter=f.call('GET','').chapters[0];
  f.call('POST','/chapter-plan-1/approve',{expectedDraftVersion:1,shownHash:chapter.plan.draftHash,expectedActiveSnapshotId:null,expectedBookSnapshotId:book.activeSnapshot.id,operationId:op()});
  chapter=f.call('GET','').chapters[0];
  const request=f.service.stageAgentRequest({mode:'write',chapterId,sources:[{kind:'google',documentId:'doc_main',key:'sec-1',textHash:sha(TEXT1)}]},{});
  request.request.onTurnStarted({});
  const args={stageId:'stage-local',contentRevision:1,snapshotId:chapter.plan.activeSnapshot.id,chapterId,textHash:sha(TEXT1),quotes:[{quote:'Кай нашёл ключ под камнем.'}],rationale:'Найден ключ'};
  const proposal=f.service.proposeClosure(request.request.requestId,args,{turnId:'turn1',callId:'before'});
  f.call('PUT','/book-plan-1/draft',{expectedVersion:book.draftVersion,draft:bookDraft([stage('stage-parent',{closureCriterion:'Новый критерий'})]),operationId:op()});
  book=f.call('GET','').book;
  f.call('POST','/book-plan-1/approve',{expectedDraftVersion:book.draftVersion,shownHash:book.draftHash,expectedActiveSnapshotId:book.activeSnapshot.id,operationId:op()});
  const late=f.service.proposeClosure(request.request.requestId,args,{turnId:'turn1',callId:'after'});
  assert.equal(late.state,'stale');
  const accepted=f.call('POST',`/proposals/${proposal.proposalId}/accept`,{expectedProgressVersion:0,operationId:op()}).receipt;
  assert.equal(accepted.accepted,false);assert.equal(accepted.state,'stale');
  assert.equal(f.call('GET','').chapters[0].plan.statuses['stage-local'].state,'not_started');
});

test('first chapter approval invalidates a request pinned before any chapter snapshot existed',async t=>{
  const f=setup(t),book=await approvedBook(f,[stage('stage-a')]);
  const chapterId=f.call('POST','/chapters',{title:'Глава',operationId:op()}).receipt.chapterId;
  f.call('POST',`/chapters/${chapterId}/bind`,{expectedBindingVersion:0,binding:{kind:'google',key:'sec-1'},operationId:op()});
  const staged=f.service.stageAgentRequest({mode:'write',chapterId,sources:[{kind:'google',documentId:'doc_main',key:'sec-1',textHash:sha(TEXT1)}]},{});
  assert.equal(staged.manifest.chapter.snapshotId,null);staged.request.onTurnStarted({});
  const args={stageId:'stage-a',contentRevision:1,snapshotId:book.activeSnapshot.id,chapterId,textHash:sha(TEXT1),quotes:[{quote:'Кай нашёл ключ под камнем.'}],rationale:'Ключ найден'};
  const before=f.service.proposeClosure(staged.request.requestId,args,{turnId:'turn1',callId:'before-first-plot'});
  f.call('PUT','/chapter-plan-1/draft',{expectedVersion:0,kind:'chapter',chapterId,draft:{title:'Первая сюжетка',stages:[{id:'stage-local',title:'Локальный этап',expectedChange:'Новое условие'}]},operationId:op()});
  const plot=f.call('GET','').chapters[0].plan;
  f.call('POST','/chapter-plan-1/approve',{expectedDraftVersion:plot.draftVersion,shownHash:plot.draftHash,expectedActiveSnapshotId:null,expectedBookSnapshotId:book.activeSnapshot.id,operationId:op()});
  assert.equal(f.service.freshnessOf(staged.request.requestId).fresh,false);
  const after=f.service.proposeClosure(staged.request.requestId,args,{turnId:'turn1',callId:'after-first-plot'});
  assert.equal(after.state,'stale');
  const accepted=f.call('POST',`/proposals/${before.proposalId}/accept`,{expectedProgressVersion:0,operationId:op()}).receipt;
  assert.equal(accepted.accepted,false);assert.equal(f.call('GET','').book.statuses['stage-a'].state,'not_started');
});
