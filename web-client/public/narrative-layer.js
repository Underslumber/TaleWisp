// "Этапы повествования" layer for the CodeMirror editor. A separate StateField with its own decorations: it never
// writes formatting, is never saved with the text and is never sent to Google. Positions map with start assoc=1 and
// end assoc=-1 so an anchor never grows when text is typed at its edges (the opposite of the formatting field).
// Any local edit downgrades a mark at once: inside the quote/context window -> preliminary amber "check"; outside
// -> historic outline. Only a server reload after saving can restore a current (green) state.
import { Decoration, StateEffect, StateField, WidgetType } from './vendor/codemirror.js';

export const setStageMarks = StateEffect.define();
export const setStageLayer = StateEffect.define();
const TONE_PRIORITY = { review: 5, historic: 4, current: 3, proposed: 2, progress: 1 };

// Pure mapping over a CodeMirror ChangeSet-like object ({ mapPos, iterChangedRanges }).
export function mapStageMarks(marks, changes) {
  return marks.map(mark => {
    if (mark.pending === 'lost') return mark;
    const windowFrom = Math.max(0, mark.start - (mark.prefixLength ?? 0)), windowTo = mark.end + (mark.suffixLength ?? 0);
    let edited = false, touched = false;
    changes.iterChangedRanges((fromA, toA) => {
      edited = true;
      if (toA > fromA ? fromA < windowTo && toA > windowFrom : fromA > windowFrom && fromA < windowTo) touched = true;
    });
    if (!edited) return mark;
    const start = changes.mapPos(mark.start, 1), end = changes.mapPos(mark.end, -1);
    if (end <= start) return { ...mark, start, end: start, pending: 'lost' };
    return { ...mark, start, end, pending: touched || mark.pending === 'review' ? 'review' : 'historic' };
  });
}

// Presentation tone after local edits. Strict mode shows historic decisions as "check".
export function effectiveTone(mark) {
  if (mark.pending === 'lost') return null;
  if (mark.tone !== 'current' && mark.tone !== 'historic') return mark.tone;
  const tone = mark.pending === 'review' ? 'review' : mark.pending === 'historic' && mark.tone === 'current' ? 'historic' : mark.tone;
  return tone === 'historic' && mark.strict ? 'review' : tone;
}

export const stageField = StateField.define({
  create: () => ({ visible: true, marks: [] }),
  update(value, tr) {
    if (tr.docChanged && value.marks.length) value = { ...value, marks: mapStageMarks(value.marks, tr.changes) };
    for (const effect of tr.effects) {
      if (effect.is(setStageMarks)) value = { ...value, marks: effect.value };
      if (effect.is(setStageLayer)) value = { ...value, visible: !!effect.value };
    }
    return value;
  },
});

const TONE_TEXT = { current: 'закрыт, фрагмент актуален', historic: 'закрыт автором ранее, текст главы изменён', review: 'нужно проверить фрагмент', proposed: 'предложен к закрытию', progress: 'этап в работе' };
class StageMarker extends WidgetType {
  constructor(ids, label, tone) { super(); this.ids = ids; this.label = label; this.tone = tone; }
  eq(other) { return other.label === this.label && other.tone === this.tone && other.ids.join() === this.ids.join(); }
  toDOM(view) {
    const button = view.dom.ownerDocument.createElement('button');
    button.type = 'button'; button.className = 'tw-stage-marker tw-stage-marker-' + this.tone; button.textContent = this.ids.length > 1 ? '◆' + this.ids.length : '◆';
    button.setAttribute('aria-label', 'Этапы повествования: ' + this.label); button.title = this.label;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => { event.preventDefault(); button.dispatchEvent(new view.dom.ownerDocument.defaultView.CustomEvent('tw-stage-marker', { bubbles: true, detail: { ids: this.ids } })); });
    return button;
  }
  ignoreEvent() { return true; }
}

// One fill per segment (strongest tone wins), one shared margin marker per group, underline instead of fill
// over author highlight. `highlightAt(pos)` reports author highlight formatting.
export function stageDecorations(state, highlightAt = () => false) {
  const { visible, marks } = state.field(stageField), length = state.doc.length;
  if (!visible || !marks.length) return Decoration.none;
  const shown = marks.map(mark => ({ ...mark, view: effectiveTone(mark) })).filter(mark => mark.view && mark.end > mark.start && mark.end <= length);
  if (!shown.length) return Decoration.none;
  const list = [], points = [...new Set(shown.flatMap(mark => [mark.start, mark.end]))].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], covering = shown.filter(mark => mark.start <= a && mark.end >= b);
    if (!covering.length) continue;
    const tone = covering.reduce((best, mark) => (TONE_PRIORITY[mark.view] > TONE_PRIORITY[best] ? mark.view : best), covering[0].view);
    const title = covering.map(mark => `${mark.label} — ${TONE_TEXT[mark.view]}`).join('; ');
    list.push(Decoration.mark({ class: `tw-stage tw-stage-${tone}${highlightAt(a) ? ' tw-stage-underline' : ''}`, attributes: { title, 'data-stage-ids': covering.map(mark => mark.id).join(' ') } }).range(a, b));
  }
  // Group overlapping marks and put one marker at each group start; one line marker per line.
  const sorted = [...shown].sort((x, y) => x.start - y.start), groups = [];
  for (const mark of sorted) { const last = groups.at(-1); if (last && mark.start < last.end) { last.items.push(mark); last.end = Math.max(last.end, mark.end); } else groups.push({ start: mark.start, end: mark.end, items: [mark] }); }
  const lines = new Map();
  for (const group of groups) {
    const tone = group.items.reduce((best, mark) => (TONE_PRIORITY[mark.view] > TONE_PRIORITY[best] ? mark.view : best), group.items[0].view);
    list.push(Decoration.widget({ widget: new StageMarker(group.items.map(mark => mark.id), group.items.map(mark => `${mark.label}: ${TONE_TEXT[mark.view]}`).join('; '), tone), side: -1 }).range(group.start));
    const line = state.doc.lineAt(group.start).from, previous = lines.get(line);
    if (!previous || TONE_PRIORITY[tone] > TONE_PRIORITY[previous]) lines.set(line, tone);
  }
  for (const [from, tone] of lines) list.push(Decoration.line({ class: 'tw-stage-line tw-stage-line-' + tone }).range(from));
  return Decoration.set(list, true);
}
