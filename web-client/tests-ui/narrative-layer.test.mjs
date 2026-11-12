import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EditorState } from '../public/vendor/codemirror.js';
import { stageField, setStageMarks, setStageLayer, effectiveTone, stageDecorations } from '../public/narrative-layer.js';

const doc = 'Пролог. Кай выбирает дорогу. Эпилог.';
const start = doc.indexOf('Кай'), end = doc.indexOf(' Эпилог');
const mark = (extra = {}) => ({ id: 'e1', start, end, quote: doc.slice(start, end), prefixLength: 4, suffixLength: 4, tone: 'current', label: '«Выбор»', ...extra });
const make = (marks = [mark()]) => EditorState.create({ doc, extensions: [stageField] }).update({ effects: setStageMarks.of(marks) }).state;
const marksOf = state => state.field(stageField).marks;

test('anchors never grow at their edges: start assoc=1, end assoc=-1', () => {
  let state = make();
  state = state.update({ changes: { from: start, insert: 'ВСТАВКА ' } }).state;
  let [m] = marksOf(state);
  assert.equal(state.doc.sliceString(m.start, m.end), 'Кай выбирает дорогу.');
  state = state.update({ changes: { from: m.end, insert: ' ХВОСТ' } }).state;
  [m] = marksOf(state);
  assert.equal(state.doc.sliceString(m.start, m.end), 'Кай выбирает дорогу.');
});

test('a local edit downgrades at once: inside the window -> check, outside -> historic, deleted -> hidden', () => {
  const inside = make().update({ changes: { from: start + 4, to: start + 12, insert: 'решает' } }).state;
  assert.equal(marksOf(inside)[0].pending, 'review'); assert.equal(effectiveTone(marksOf(inside)[0]), 'review');
  const prefix = make().update({ changes: { from: start - 2, insert: '!' } }).state;
  assert.equal(marksOf(prefix)[0].pending, 'review', 'context window edits need a check');
  const outside = make().update({ changes: { from: doc.length, insert: ' Новый абзац.' } }).state;
  assert.equal(marksOf(outside)[0].pending, 'historic'); assert.equal(effectiveTone(marksOf(outside)[0]), 'historic');
  assert.equal(effectiveTone({ ...marksOf(outside)[0], strict: true }), 'review', 'strict mode turns a historic decision into a check');
  const again = outside.update({ changes: { from: 0, insert: 'X' } }).state;
  assert.equal(marksOf(again)[0].pending, 'historic', 'a historic mark is not silently restored to current');
  const removed = make().update({ changes: { from: start, to: end } }).state;
  assert.equal(marksOf(removed)[0].pending, 'lost'); assert.equal(effectiveTone(marksOf(removed)[0]), null);
  const review = make([mark({ tone: 'progress' })]).update({ changes: { from: 0, insert: 'X' } }).state;
  assert.equal(effectiveTone(marksOf(review)[0]), 'progress', 'in-progress markers are neutral and stay neutral');
});

test('the layer is separate from formatting: own decorations, toggle, never part of text or rich data', () => {
  const state = make([mark(), mark({ id: 'e2', start: start + 4, end: end + 2, tone: 'review', label: '«Другой»' })]);
  assert.ok(stageDecorations(state).size > 0);
  const hidden = state.update({ effects: setStageLayer.of(false) }).state;
  assert.equal(stageDecorations(hidden).size, 0);
  assert.equal(state.doc.toString(), doc);
  const editor = readFileSync(new URL('../public/rich-text-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /stageField/); assert.match(editor, /get\(\)\{const range=view\.state\.selection\.main;return \{text:view\.state\.doc\.toString\(\),rich:structuredClone\(view\.state\.field\(richField\)\)/, 'get() returns only text and formatting');
  assert.doesNotMatch(readFileSync(new URL('../public/narrative-layer.js', import.meta.url), 'utf8'), /marksField|richField/, 'the layer does not reuse the review/format fields');
});
