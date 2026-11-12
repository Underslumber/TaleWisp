import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDraft, assignRevisions, diffPlans, locateAnchor, anchorContext, stageStatus, chapterCounter, pinParents, chapterCompatibility,
  evidenceTone, sourceFromEditorIdentity, canonicalJson, NarrativeError, NARRATIVE_LIMITS,
} from '../public/narrative-model.js';

const stage = (id, extra = {}) => ({ id, lineId: 'line-main', title: 'Этап ' + id, expectedChange: 'Меняется ' + id, ...extra });
const book = stages => ({ title: 'Линия', lines: [{ id: 'line-main', title: 'Основная', primary: true }], stages });

test('draft validation: required fields, unknown or archived prerequisites, cycles, limits and one primary line', () => {
  assert.equal(normalizeDraft('book', book([stage('stage-a')])).stages[0].title, 'Этап stage-a');
  assert.throws(() => normalizeDraft('book', book([{ ...stage('stage-a'), expectedChange: ' ' }])), /Ожидаемое изменение/);
  assert.throws(() => normalizeDraft('book', book([stage('stage-a', { prerequisites: ['stage-x'] })])), /неизвестный этап/);
  assert.throws(() => normalizeDraft('book', book([stage('stage-a', { prerequisites: ['stage-b'] }), stage('stage-b', { archived: true })])), /в архиве/);
  assert.throws(() => normalizeDraft('book', book([stage('stage-a', { prerequisites: ['stage-b'] }), stage('stage-b', { prerequisites: ['stage-a'] })])), /цикл/);
  assert.throws(() => normalizeDraft('book', book([stage('stage-a'), stage('stage-a')])), /повторяется/);
  assert.throws(() => normalizeDraft('book', { ...book([]), lines: [{ id: 'line-a1', title: 'A', primary: true }, { id: 'line-b1', title: 'B', primary: true }] }), /Основной/);
  const many = Array.from({ length: NARRATIVE_LIMITS.chapterStages + 1 }, (_, i) => ({ id: 'stage-' + String(i).padStart(4, '0'), title: 't', expectedChange: 'e' }));
  assert.throws(() => normalizeDraft('chapter', { chapterId: 'chapter-1', stages: many }), error => error instanceof NarrativeError && error.status === 413);
  assert.throws(() => normalizeDraft('chapter', { stages: [] }), /главе каркаса/);
});

test('content revision changes only with the deterministic field set; reorder, line, archive and explicit rename keep it', () => {
  const first = assignRevisions(normalizeDraft('book', book([stage('stage-a'), stage('stage-b')])).stages, {});
  assert.deepEqual(first.stages.map(s => s.contentRevision), [1, 1]);
  const reordered = assignRevisions(normalizeDraft('book', book([stage('stage-b'), stage('stage-a', { archived: true, participants: ['Кай'], causality: 'потому что' })])).stages, first.index);
  assert.deepEqual(reordered.stages.map(s => [s.id, s.contentRevision]), [['stage-b', 1], ['stage-a', 1]]);
  const changed = assignRevisions(normalizeDraft('book', book([stage('stage-a', { closureCriterion: 'Новый критерий' })])).stages, reordered.index);
  assert.equal(changed.stages[0].contentRevision, 2);
  const renamed = assignRevisions(normalizeDraft('book', book([stage('stage-a', { closureCriterion: 'Новый критерий', title: 'Имя', preserveRevision: true })])).stages, changed.index);
  assert.equal(renamed.stages[0].contentRevision, 2, 'explicit author choice keeps the revision for a pure rename');
  assert.equal(renamed.stages[0].preserveRevision, undefined, 'the flag is not stored');
  const renameAndChange = assignRevisions(normalizeDraft('book', book([stage('stage-a', { closureCriterion: 'Другой', title: 'Имя 2', preserveRevision: true })])).stages, renamed.index);
  assert.equal(renameAndChange.stages[0].contentRevision, 3, 'preserveRevision cannot hide a change of meaning');
  const prereqOrder = assignRevisions(normalizeDraft('book', book([stage('stage-c', { prerequisites: ['stage-d', 'stage-e'] }), stage('stage-d'), stage('stage-e')])).stages, {});
  const swapped = assignRevisions(normalizeDraft('book', book([stage('stage-c', { prerequisites: ['stage-e', 'stage-d'] }), stage('stage-d'), stage('stage-e')])).stages, prereqOrder.index);
  assert.equal(swapped.stages[0].contentRevision, 1);
});

test('chapter link pins parent pairs; parent revision change or archive breaks compatibility, reorder does not', () => {
  const parent = { stages: [{ id: 'stage-p1', contentRevision: 1, archived: false }, { id: 'stage-p2', contentRevision: 3, archived: false }] };
  const chapter = normalizeDraft('chapter', { chapterId: 'chapter-1', stages: [{ id: 'stage-l1', title: 'Л', expectedChange: 'е', parentStageIds: ['stage-p2'] }] });
  const pins = pinParents(chapter, parent);
  assert.deepEqual(pins, [{ stageId: 'stage-p2', contentRevision: 3 }]);
  const snapshot = { payload: { ...chapter, parentPins: pins } };
  assert.equal(chapterCompatibility(snapshot, { payload: { stages: [...parent.stages].reverse() } }).compatible, true);
  assert.deepEqual(chapterCompatibility(snapshot, { payload: { stages: [{ id: 'stage-p2', contentRevision: 4 }] } }).problems[0].reason, 'revision_changed');
  assert.equal(chapterCompatibility(snapshot, { payload: { stages: [{ id: 'stage-p2', contentRevision: 3, archived: true }] } }).problems[0].reason, 'archived');
  assert.throws(() => pinParents(chapter, { stages: [] }), /отсутствует/);
  assert.equal(chapterCompatibility(null, { payload: parent }).compatible, false);
});

test('anchors: exact, intact, deterministic shift, ambiguity, changed window and loss are distinguished', () => {
  const text = 'Начало. Кай выбирает дорогу домой. Конец главы.';
  const start = text.indexOf('Кай выбирает'), end = start + 'Кай выбирает дорогу'.length;
  const anchor = { quote: text.slice(start, end), start, end, textHash: 'h1', ...anchorContext(text, start, end, 8) };
  assert.equal(locateAnchor(text, 'h1', anchor).location, 'exact');
  assert.equal(locateAnchor(text + ' Дописано.', 'h2', anchor).location, 'intact');
  const shifted = locateAnchor('Вставка. ' + text, 'h3', anchor); assert.equal(shifted.location, 'shifted'); assert.equal(shifted.start, start + 9);
  assert.equal(locateAnchor(text + ' ' + text, 'h4', anchor).location, 'ambiguous', 'repeated quote with context is never auto-selected');
  assert.equal(locateAnchor(text.replace('Начало. ', 'Иное! '), 'h5', anchor).location, 'window_changed');
  assert.equal(locateAnchor('Совсем другой текст.', 'h6', anchor).location, 'lost');
  const emoji = 'А😀Б';
  assert.equal(anchorContext(emoji, 3, 4, 2).prefix, '😀');
  assert.equal(anchorContext(emoji, 3, 4, 1).prefix, '', 'context never splits a surrogate pair');
});

test('status labels: closure tones, strict mode, proposal overlay and closure without fragment', () => {
  assert.equal(stageStatus({}).label, 'Не начат');
  assert.equal(stageStatus({ progress: { state: 'in_progress' }, pendingProposals: 1 }).state, 'proposed');
  const closed = { state: 'closed', evidenceIds: ['e1'] };
  assert.equal(stageStatus({ progress: closed, evidence: [{ id: 'e1', tone: 'current' }] }).label, 'Закрыт · фрагмент актуален');
  assert.equal(stageStatus({ progress: closed, evidence: [{ id: 'e1', tone: 'historic' }] }).label, 'Закрыт автором · глава изменена');
  assert.equal(stageStatus({ progress: closed, evidence: [{ id: 'e1', tone: 'review' }] }).label, 'Закрыт ранее · проверить фрагмент');
  assert.equal(stageStatus({ progress: { state: 'closed', evidenceIds: [] } }).label, 'Подтверждено автором без фрагмента');
  assert.equal(stageStatus({ progress: { state: 'closed', evidenceIds: [] }, basisChanged: true, strict: true }).tone, 'review');
  assert.equal(stageStatus({ progress: closed, evidence: [{ id: 'e1', tone: 'current' }], pendingProposals: 2 }).state, 'closed', 'a proposal never reopens a closed stage');
  assert.equal(evidenceTone('intact', { strict: false }), 'historic');
  assert.equal(evidenceTone('intact', { strict: true }), 'review');
  assert.equal(evidenceTone('exact', { bindingOk: false }), 'lost');
});

test('counter is navigation, not a quality score; without an approved plan it says so', () => {
  assert.deepEqual(chapterCounter([], false), { label: 'План не согласован', closed: 0, total: 0, stale: false, approved: false });
  const counter = chapterCounter([{ state: 'closed', tone: 'current' }, { state: 'closed', tone: 'historic' }, { state: 'in_progress', tone: 'progress' }], true);
  assert.equal(counter.label, '2 из 3 закрыто'); assert.equal(counter.stale, true);
});

test('diff names changed fields, moves, archives and marks content changes that do not inherit closures', () => {
  const before = { kind: 'book', title: 'A', stages: [{ id: 'stage-a', title: 'A', expectedChange: 'x', contentRevision: 1 }, { id: 'stage-b', title: 'B', expectedChange: 'y', contentRevision: 1 }] };
  const after = { kind: 'book', title: 'A2', stages: [{ id: 'stage-b', title: 'B', expectedChange: 'y', contentRevision: 1 }, { id: 'stage-a', title: 'A', expectedChange: 'x2', contentRevision: 2 }, { id: 'stage-c', title: 'C', expectedChange: 'z' }] };
  const diff = diffPlans(before, after);
  assert.equal(diff.header[0].field, 'title');
  assert.deepEqual(diff.stages.find(s => s.id === 'stage-a').fields, ['expectedChange']);
  assert.equal(diff.stages.find(s => s.id === 'stage-a').contentChanged, true);
  assert.equal(diff.stages.find(s => s.id === 'stage-b').change, 'moved');
  assert.equal(diff.stages.find(s => s.id === 'stage-c').change, 'added');
  assert.equal(diffPlans(before, before).empty, true);
});

test('editor identities map to app sources; unsaved local drafts and malformed ids are not sources', () => {
  assert.deepEqual(sourceFromEditorIdentity('document:abc'), { kind: 'document', id: 'abc' });
  assert.equal(sourceFromEditorIdentity('document:local-1'), null);
  assert.deepEqual(sourceFromEditorIdentity(JSON.stringify(['b', 'd', 'one'])), { kind: 'google', bookId: 'b', documentId: 'd', key: 'one' });
  assert.equal(sourceFromEditorIdentity('note:1'), null);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});
