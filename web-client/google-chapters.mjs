// Chapter-level reading and reviewed, revision-guarded writing of the main Google manuscript.
// Pure planning/verification lives here; the journal, lock and OAuth primitives stay in google.mjs.
import { createHash } from 'node:crypto';

const DOCS = 'https://docs.googleapis.com/v1/documents';
const TEXT_STYLE_FIELDS = [
  'backgroundColor', 'baselineOffset', 'bold', 'fontSize', 'foregroundColor',
  'italic', 'link', 'smallCaps', 'strikethrough', 'underline', 'weightedFontFamily',
];
const PARAGRAPH_STYLE_FIELDS = [
  'namedStyleType', 'alignment', 'lineSpacing', 'direction', 'spacingMode', 'spaceAbove', 'spaceBelow',
  'indentFirstLine', 'indentStart', 'indentEnd', 'keepLinesTogether', 'keepWithNext', 'avoidWidowAndOrphan', 'pageBreakBefore',
];
const HEADING_STYLE = /^HEADING_([1-6])$/;
const PLAIN_HEADING = /^(?:(?:глава|chapter)\s+[\p{L}\p{N}]+(?:\s*[.:—–-].{0,100})?|(?:пролог|эпилог|prologue|epilogue)(?:\s*[.:—–-].{0,100})?)$/iu;
const OBJECT_MARKS = { inlineObjectElement: '⟦изображение⟧', footnoteReference: '⟦сноска⟧', pageBreak: '⟦разрыв страницы⟧', columnBreak: '⟦разрыв колонки⟧', horizontalRule: '⟦линия⟧', equation: '⟦формула⟧', person: '⟦упоминание⟧', richLink: '⟦ссылка-чип⟧', autoText: '⟦автотекст⟧' };
export const TABLE_MARK = '⟦Таблица — изменить можно только в оригинале Google⟧';
export const TOC_MARK = '⟦Оглавление Google — не часть текста⟧';
const MAX_WRITE_SECTIONS = 40;
const MAX_NEW_CHAPTERS = 20;
const MAX_WRITE_TEXT = 1_500_000;
const MAX_DIFF_CELLS = 4_000_000;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/;

export function chapterError(message, code, status = 409, extra = {}) {
  return Object.assign(new Error(message), { code, status }, extra);
}

const sha = value => createHash('sha256').update(value).digest('hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
}
const stableJson = value => JSON.stringify(stable(value));

function cleanIndices(value) {
  if (Array.isArray(value)) return value.map(cleanIndices);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'startIndex' && key !== 'endIndex').map(([key, child]) => [key, cleanIndices(child)]));
}

// Structural identity of an unchanged block. Adjacent runs with identical styling are merged because
// Google may split or join runs when neighbouring text is inserted, without any visible change.
function normalizeElement(item) {
  const clean = cleanIndices(item);
  if (clean?.paragraph?.elements) {
    const merged = [];
    for (const element of clean.paragraph.elements) {
      const last = merged.at(-1);
      if (element.textRun && last?.textRun && stableJson({ ...element.textRun, content: '' }) === stableJson({ ...last.textRun, content: '' })) {
        last.textRun = { ...last.textRun, content: (last.textRun.content ?? '') + (element.textRun.content ?? '') };
      } else merged.push(structuredClone(element));
    }
    clean.paragraph = { ...clean.paragraph, elements: merged };
  }
  return stable(clean);
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) if (source && Object.hasOwn(source, field)) out[field] = structuredClone(source[field]);
  return out;
}

function tabEntries(raw) {
  const out = [];
  const visit = (tab, depth, path) => {
    const tabId = tab.tabProperties?.tabId ?? '';
    const title = tab.tabProperties?.title || 'Вкладка без названия';
    const tabPath = [...path, title];
    out.push({ tabId, title, depth, path: tabPath, documentTab: tab.documentTab ?? {} });
    for (const child of tab.childTabs ?? []) visit(child, depth + 1, tabPath);
  };
  for (const tab of raw?.tabs ?? []) visit(tab, 0, []);
  if (!out.length) out.push({ tabId: '', title: raw?.title || 'Документ', depth: 0, path: [raw?.title || 'Документ'], documentTab: raw ?? {} });
  return out;
}

function readParagraph(item) {
  const paragraph = item.paragraph, style = paragraph.paragraphStyle ?? {};
  let text = '', editable = Number.isInteger(item.startIndex) && Number.isInteger(item.endIndex), reason = editable ? '' : 'у абзаца нет индексов Google';
  let cursor = item.startIndex;
  const lock = why => { editable = false; reason ||= why; };
  for (const element of paragraph.elements ?? []) {
    if (element.textRun) {
      const content = element.textRun.content ?? '';
      if (element.startIndex !== cursor || element.endIndex !== element.startIndex + content.length) lock('индексы текста не совпадают со структурой Google');
      if (element.textRun.suggestedInsertionIds?.length || element.textRun.suggestedDeletionIds?.length || Object.keys(element.textRun.suggestedTextStyleChanges ?? {}).length) lock('в абзаце есть непринятые предложения правок');
      text += content;
      cursor = Number.isInteger(element.endIndex) ? element.endIndex : cursor + content.length;
    } else {
      const kind = Object.keys(element).find(key => key !== 'startIndex' && key !== 'endIndex') ?? 'object';
      text += OBJECT_MARKS[kind] ?? '⟦объект⟧';
      lock(kind === 'inlineObjectElement' ? 'в абзаце есть изображение' : kind === 'footnoteReference' ? 'в абзаце есть ссылка на сноску' : 'в абзаце есть встроенный объект Google');
      cursor = Number.isInteger(element.endIndex) ? element.endIndex : cursor;
    }
  }
  if (cursor !== item.endIndex) lock('индексы абзаца не совпадают со структурой Google');
  if (Object.keys(paragraph.suggestedParagraphStyleChanges ?? {}).length || Object.keys(paragraph.suggestedBulletChanges ?? {}).length) lock('в абзаце есть непринятые предложения оформления');
  if ((paragraph.positionedObjectIds ?? []).length) lock('к абзацу привязан объект Google');
  if (text.endsWith('\n')) text = text.slice(0, -1); else lock('абзац не завершается переводом строки');
  if (text.includes('\u000b')) { lock('в абзаце есть мягкий перенос строки'); text = text.replaceAll('\u000b', '⏎'); }
  if (FORBIDDEN_TEXT.test(text)) { lock('в абзаце есть служебные символы'); text = text.replace(new RegExp(FORBIDDEN_TEXT.source, 'g'), '·'); }
  return { kind: 'paragraph', startIndex: item.startIndex, endIndex: item.endIndex, text, editable, lockReason: reason, namedStyleType: style.namedStyleType ?? 'NORMAL_TEXT', headingId: style.headingId ?? '', hasBullet: !!paragraph.bullet, element: item };
}

function readBlock(item, i) {
  let block;
  if (item.paragraph) block = readParagraph(item);
  else if (item.table) block = { kind: 'table', text: TABLE_MARK, editable: false, lockReason: 'таблица' };
  else if (item.tableOfContents) block = { kind: 'toc', text: TOC_MARK, editable: false, lockReason: 'автоматическое оглавление Google' };
  else if (item.sectionBreak) block = { kind: 'sectionBreak', hidden: true, text: '', editable: false, lockReason: 'разрыв раздела' };
  else block = { kind: 'other', text: '⟦объект⟧', editable: false, lockReason: 'неизвестный элемент Google' };
  return { ...block, i, startIndex: item.startIndex ?? null, endIndex: item.endIndex ?? null, element: item };
}

const headingLevel = block => {
  const match = block.kind === 'paragraph' && HEADING_STYLE.exec(block.namedStyleType);
  return match && block.text.trim() ? Number(match[1]) : 0;
};
const words = text => (text.trim() ? text.trim().split(/\s+/u).length : 0);

export function extractManuscript(raw) {
  if (!raw || typeof raw !== 'object') throw chapterError('Google вернул пустой документ.', 'CHAPTER_DOCUMENT_INVALID', 502);
  const tabs = [], sections = [], usedIds = new Set();
  for (const entry of tabEntries(raw)) {
    const blocks = (entry.documentTab.body?.content ?? []).map(readBlock);
    const tab = { tabId: entry.tabId, title: entry.title, depth: entry.depth, path: entry.path, blocks, detection: 'whole', sectionIds: [] };
    let starts = blocks.filter(block => headingLevel(block) > 0).map(block => ({ block, level: headingLevel(block) }));
    if (starts.length) tab.detection = 'heading';
    else {
      starts = blocks.filter(block => block.kind === 'paragraph' && block.text.trim().length <= 120 && PLAIN_HEADING.test(block.text.trim())).map(block => ({ block, level: 1 }));
      if (starts.length) tab.detection = 'plain';
    }
    const ranges = [];
    if (!starts.length) { if (blocks.some(block => !block.hidden)) ranges.push({ from: 0, to: blocks.length, detection: 'whole', heading: null, level: 0 }); }
    else {
      if (blocks.slice(0, starts[0].block.i).some(block => !block.hidden && (block.kind !== 'paragraph' || block.text.trim()))) ranges.push({ from: 0, to: starts[0].block.i, detection: 'preamble', heading: null, level: 0 });
      starts.forEach((start, k) => ranges.push({ from: start.block.i, to: k + 1 < starts.length ? starts[k + 1].block.i : blocks.length, detection: tab.detection, heading: start.block, level: start.level }));
    }
    for (const range of ranges) {
      const visible = blocks.slice(range.from, range.to).filter(block => !block.hidden);
      const body = range.heading ? visible.filter(block => block !== range.heading) : visible;
      let sectionId = range.detection === 'heading' && range.heading.headingId ? `h:${entry.tabId}:${range.heading.headingId}`
        : range.detection === 'plain' ? `p:${entry.tabId}:${range.heading.startIndex}`
        : range.detection === 'preamble' ? `pre:${entry.tabId}` : `all:${entry.tabId}`;
      if (usedIds.has(sectionId)) sectionId += `:${range.heading?.startIndex ?? range.from}`;
      usedIds.add(sectionId);
      const title = range.heading ? range.heading.text : '';
      const bodyText = body.map(block => block.text).join('\n');
      const label = range.heading ? title.trim() : range.detection === 'preamble' ? `Начало вкладки «${entry.title}» (до первого заголовка)` : `Весь текст вкладки «${entry.title}» (заголовков нет)`;
      const section = {
        sectionId, tabId: entry.tabId, tabTitle: entry.title, tabPath: entry.path, tabDepth: entry.depth,
        detection: range.detection, level: range.level, hasHeading: !!range.heading, headingId: range.heading?.headingId ?? '',
        namedStyleType: range.heading?.namedStyleType ?? '', title, label,
        startIndex: visible[0]?.startIndex ?? null, endIndex: visible.at(-1)?.endIndex ?? null,
        paragraphCount: body.length, wordCount: words(title) + words(bodyText), lockedCount: visible.filter(block => !block.editable).length,
        hash: sha(stableJson({ title, body: bodyText })).slice(0, 40),
        from: range.from, to: range.to, heading: range.heading, bodyBlocks: body, bodyText,
      };
      sections.push(section); tab.sectionIds.push(sectionId);
    }
    tabs.push(tab);
  }
  return { documentId: raw.documentId ?? '', title: raw.title ?? '', revisionId: raw.revisionId ?? '', tabs, sections, raw };
}

export function publicManuscript(model) {
  return {
    documentId: model.documentId, title: model.title, revisionId: model.revisionId,
    headingsFound: model.tabs.some(tab => tab.detection === 'heading'),
    tabs: model.tabs.map(tab => ({ tabId: tab.tabId, title: tab.title, depth: tab.depth, path: tab.path, detection: tab.detection, sectionCount: tab.sectionIds.length })),
    sections: model.sections.map((section, order) => publicSection(section, order, false)),
  };
}

export function publicSection(section, order, withText) {
  const out = {
    sectionId: section.sectionId, order, tabId: section.tabId, tabTitle: section.tabTitle, tabPath: section.tabPath, tabDepth: section.tabDepth,
    detection: section.detection, level: section.level, hasHeading: section.hasHeading, headingId: section.headingId, namedStyleType: section.namedStyleType,
    title: section.title, label: section.label, startIndex: section.startIndex, endIndex: section.endIndex,
    paragraphCount: section.paragraphCount, wordCount: section.wordCount, lockedCount: section.lockedCount, hash: section.hash,
  };
  if (withText) {
    out.body = section.bodyText;
    out.locked = section.bodyBlocks.flatMap((block, index) => block.editable ? [] : [{ paragraph: index, text: block.text, reason: block.lockReason }]);
    if (section.heading && !section.heading.editable) out.titleLocked = section.heading.lockReason;
  }
  return out;
}

function normalizeInputText(value, label, { allowEmpty = true, max = MAX_WRITE_TEXT } = {}) {
  if (typeof value !== 'string') throw chapterError(`${label}: нужен текст.`, 'CHAPTER_INPUT_INVALID', 400);
  const text = value.replace(/\r\n?/g, '\n');
  if (text.length > max) throw chapterError(`${label}: текст слишком большой для одной записи.`, 'CHAPTER_INPUT_INVALID', 413);
  if (FORBIDDEN_TEXT.test(text)) throw chapterError(`${label}: в тексте есть служебные символы, которые нельзя записать в Google Docs.`, 'CHAPTER_INPUT_INVALID', 400);
  if (!allowEmpty && !text.trim()) throw chapterError(`${label}: текст не может быть пустым.`, 'CHAPTER_INPUT_INVALID', 400);
  return text;
}

function diffParagraphs(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) throw chapterError('Правка слишком большая для точного сравнения. Сохраните изменения меньшими частями.', 'CHAPTER_DIFF_TOO_LARGE', 413);
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const ops = [];
  for (let k = 0; k < start; k++) ops.push({ type: 'keep', o: k, d: k });
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) { ops.push({ type: 'keep', o: start + i, d: start + j }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push({ type: 'del', o: start + i++ });
    else ops.push({ type: 'ins', d: start + j++ });
  }
  while (i < n) ops.push({ type: 'del', o: start + i++ });
  while (j < m) ops.push({ type: 'ins', d: start + j++ });
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: 'keep', o: endA + k, d: endB + k });
  return ops;
}

// Minimal edit script (Myers) between two code-point arrays: '=' keep, '-' delete, '+' insert.
// Returns null when it would cost more than `budget` steps.
function editScript(a, b, budget) {
  const n = a.length, m = b.length, max = n + m, off = max + 1;
  const v = new Int32Array(2 * max + 3), trace = [];
  let work = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; work++; }
      v[off + k] = x; work++;
      if (x >= n && y >= m) { trace.push(v.slice(off - d, off + d + 1)); return backtrackScript(trace, n, m); }
    }
    trace.push(v.slice(off - d, off + d + 1));
    if (work > budget) return null;
  }
  return null;
}
function backtrackScript(trace, n, m) {
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1], at = k => prev[k + d - 1], k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1, prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push('='); x--; y--; }
    ops.push(down ? '+' : '-');
    if (down) y--; else x--;
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}

// Character-level changes inside one paragraph as separate hunks, so every unchanged character between
// two edits stays in place with its own runs (bold, italic, links). Works on code points, so a UTF-16
// surrogate pair is never split. `exact: false` marks the coarse fallback for very large rewrites: one
// replacement between the common prefix and suffix; the planner allows it only when no formatting is lost.
function charHunks(before, after) {
  if (before === after) return { hunks: [], exact: true };
  const a = Array.from(before), b = Array.from(after);
  const offsets = list => { const out = [0]; for (const ch of list) out.push(out.at(-1) + ch.length); return out; };
  const ua = offsets(a), ub = offsets(b);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midA = a.slice(pre, a.length - suf), midB = b.slice(pre, b.length - suf);
  let middle = !midA.length || !midB.length ? null : editScript(midA, midB, MAX_DIFF_CELLS), exact = true;
  if (!middle) {
    exact = !midA.length || !midB.length;
    middle = [...Array(midA.length).fill('-'), ...Array(midB.length).fill('+')];
  }
  const hunks = [];
  let x = pre, y = pre, open = null;
  const close = () => { if (open) hunks.push({ pre: ua[open.x], deleteLength: ua[x] - ua[open.x], insert: after.slice(ub[open.y], ub[y]) }); open = null; };
  for (const op of middle) {
    if (op === '=') { close(); x++; y++; continue; }
    open ??= { x, y };
    if (op === '-') x++; else y++;
  }
  close();
  return { hunks, exact };
}

const isPlainHeading = text => text.length <= 120 && PLAIN_HEADING.test(text);

const range = (tabId, startIndex, endIndex) => ({ startIndex, endIndex, ...(tabId ? { tabId } : {}) });
const location = (tabId, index) => ({ index, ...(tabId ? { tabId } : {}) });

function firstRunStyle(block) {
  const run = (block?.element?.paragraph?.elements ?? []).find(element => element.textRun && (element.textRun.content ?? '').replace(/\n$/, ''));
  const style = pick(run?.textRun?.textStyle ?? {}, TEXT_STYLE_FIELDS);
  delete style.link; // a hyperlink on the reference run must never spread to new text
  return style;
}
function styleRef(block, fallbackNamedStyle = 'NORMAL_TEXT') {
  if (!block) return { paragraphStyle: { namedStyleType: fallbackNamedStyle }, textStyle: {}, namedStyleType: fallbackNamedStyle, hasBullet: false };
  const paragraphStyle = pick(block.element.paragraph.paragraphStyle ?? {}, PARAGRAPH_STYLE_FIELDS);
  paragraphStyle.namedStyleType ??= block.namedStyleType || fallbackNamedStyle;
  return { paragraphStyle, textStyle: firstRunStyle(block), namedStyleType: paragraphStyle.namedStyleType, hasBullet: block.hasBullet };
}
const isBodyParagraph = block => block?.kind === 'paragraph' && !HEADING_STYLE.test(block.namedStyleType) && !['TITLE', 'SUBTITLE'].includes(block.namedStyleType) && !block.hasBullet && block.text.trim();

function bodyReference(model, tab, section) {
  const own = section?.bodyBlocks.find(isBodyParagraph);
  if (own) return styleRef(own);
  const center = section?.from ?? 0;
  const candidates = tab.blocks.filter(isBodyParagraph).sort((x, y) => Math.abs(x.i - center) - Math.abs(y.i - center));
  return styleRef(candidates[0] ?? null);
}
function titleReference(model, tab, section) {
  if (section?.heading) return styleRef(section.heading);
  const heading = model.sections.find(item => item.tabId === tab.tabId && item.heading)?.heading;
  if (heading) return styleRef(heading);
  return styleRef(null, 'HEADING_1');
}

export function buildChapterPlan(model, { edits = [], newChapters = [] } = {}) {
  if (!Array.isArray(edits) || !Array.isArray(newChapters)) throw chapterError('Неверный формат правок глав.', 'CHAPTER_INPUT_INVALID', 400);
  if (edits.length > MAX_WRITE_SECTIONS) throw chapterError(`За одну запись можно сохранить не больше ${MAX_WRITE_SECTIONS} глав.`, 'CHAPTER_INPUT_INVALID', 413);
  if (newChapters.length > MAX_NEW_CHAPTERS) throw chapterError(`За одну запись можно добавить не больше ${MAX_NEW_CHAPTERS} новых глав.`, 'CHAPTER_INPUT_INVALID', 413);
  let totalText = 0;
  const tabsById = new Map(model.tabs.map(tab => [tab.tabId, tab]));
  const work = new Map(); // tabId -> { mods, dels, groups, afterAnchors }
  const tabWork = tabId => {
    if (!work.has(tabId)) work.set(tabId, { mods: new Map(), owners: new Map(), hunks: new Map(), dels: new Set(), groups: new Map(), afterAnchors: new Set() });
    return work.get(tabId);
  };
  const changes = [], unchanged = [], warnings = new Set(), seenSections = new Set(), pendingGaps = [], newTitles = [];
  const locked = (section, block) => chapterError(`«${section.label}»: изменён фрагмент, который TaleWisp не может безопасно записать (${block.lockReason || 'защищённая структура'}). Внесите эту правку в оригинале Google.`, 'CHAPTER_STRUCTURE_LOCKED', 409, { sectionId: section.sectionId });
  const undetectable = (section, title) => chapterError(`«${title}» не появится в оглавлении как отдельная глава: во вкладке «${section.tabTitle}» нет стилей заголовков Google, и главы распознаются только по строкам «Глава N», «Пролог», «Эпилог». Назовите главу, например, «Глава 7. ${title.slice(0, 60)}», или оформите заголовки в оригинале Google стилем «Заголовок». Ничего не записано.`, 'CHAPTER_TITLE_UNDETECTABLE', 409, { sectionId: section.sectionId });

  for (const edit of edits) {
    if (!edit || typeof edit.sectionId !== 'string' || typeof edit.baseHash !== 'string') throw chapterError('У правки главы нет идентификатора или исходной версии.', 'CHAPTER_INPUT_INVALID', 400);
    let section = model.sections.find(item => item.sectionId === edit.sectionId && item.hash === edit.baseHash);
    if (!section) {
      const sameHash = model.sections.filter(item => item.hash === edit.baseHash && item.sectionId.split(':')[1] === edit.sectionId.split(':')[1]);
      if (sameHash.length === 1) section = sameHash[0];
    }
    if (!section) throw chapterError('Глава изменилась в Google после загрузки в редактор. Загрузите её заново и перенесите правки — автоматическое слияние не выполняется.', 'CHAPTER_SECTION_CHANGED', 409, { sectionId: edit.sectionId });
    if (seenSections.has(section.sectionId)) throw chapterError('Одна и та же глава передана дважды.', 'CHAPTER_INPUT_INVALID', 400);
    seenSections.add(section.sectionId);
    const tab = tabsById.get(section.tabId), state = tabWork(section.tabId);
    const body = normalizeInputText(edit.body ?? '', `«${section.label}»`);
    totalText += body.length;
    const paragraphs = [];
    if (section.heading) {
      const titleText = normalizeInputText(edit.title ?? section.title, `Заголовок «${section.label}»`, { allowEmpty: false, max: 300 });
      if (titleText.includes('\n')) throw chapterError('Заголовок главы должен быть одной строкой.', 'CHAPTER_INPUT_INVALID', 400);
      if (titleText !== section.title) {
        if (!section.heading.editable) throw locked(section, section.heading);
        // A plain-text heading is a chapter only while its line reads «Глава N», «Пролог» or «Эпилог».
        if (section.detection === 'plain' && !isPlainHeading(titleText.trim())) throw undetectable(section, titleText.trim());
        state.mods.set(section.heading.i, titleText); state.owners.set(section.heading.i, section);
        paragraphs.push({ change: 'title', before: section.title, after: titleText });
      }
    }
    const original = section.bodyBlocks.map(block => block.text);
    const desired = body === '' && !original.length ? [] : body.split('\n');
    const ops = diffParagraphs(original, desired);
    let run = { dels: [], ins: [] }, prevKeep = null;
    const flush = nextKeep => {
      const pairs = Math.min(run.dels.length, run.ins.length);
      for (let k = 0; k < pairs; k++) {
        const block = section.bodyBlocks[run.dels[k]], after = desired[run.ins[k]];
        if (block.text === after) continue;
        if (block.kind !== 'paragraph' || !block.editable) throw locked(section, block);
        state.mods.set(block.i, after); state.owners.set(block.i, section); paragraphs.push({ change: 'modified', before: block.text, after });
      }
      for (const o of run.dels.slice(pairs)) {
        const block = section.bodyBlocks[o];
        if (block.kind !== 'paragraph' || !block.editable) throw locked(section, block);
        if (block.i === tab.blocks.length - 1) {
          state.mods.set(block.i, ''); state.owners.set(block.i, section); paragraphs.push({ change: 'emptied', before: block.text });
          warnings.add('Последний абзац вкладки нельзя удалить через Google Docs API — он будет очищен.');
        } else { state.dels.add(block.i); paragraphs.push({ change: 'deleted', before: block.text }); }
      }
      const extra = run.ins.slice(pairs).map(d => desired[d]);
      if (extra.length) {
        const prevBlock = pairs ? section.bodyBlocks[run.dels[pairs - 1]] : prevKeep !== null ? section.bodyBlocks[prevKeep] : section.heading ?? tab.blocks[section.from - 1];
        const nextBlock = nextKeep !== null ? section.bodyBlocks[nextKeep] : tab.blocks[section.to];
        pendingGaps.push({ tab, section, prevBlock, nextBlock, order: 0, paragraphs: extra.map(text => ({ text, role: 'body' })) });
        for (const text of extra) paragraphs.push({ change: 'inserted', after: text });
      }
      run = { dels: [], ins: [] };
    };
    for (const op of ops) {
      if (op.type === 'keep') { if (run.dels.length || run.ins.length) flush(op.o); prevKeep = op.o; }
      else if (op.type === 'del') run.dels.push(op.o);
      else run.ins.push(op.d);
    }
    if (run.dels.length || run.ins.length) flush(null);
    if (paragraphs.some(item => item.change === 'modified' || item.change === 'title')) warnings.add('Новые символы внутри изменённого абзаца получают оформление соседнего текста; остальное оформление абзаца сохраняется.');
    if (paragraphs.length) changes.push({ kind: 'edit', sectionId: section.sectionId, tabId: section.tabId, tabTitle: section.tabTitle, title: section.label, paragraphs });
    else unchanged.push(section.sectionId);
  }

  const keys = new Set();
  newChapters.forEach((chapter, index) => {
    if (!chapter || typeof chapter.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(chapter.key) || keys.has(chapter.key)) throw chapterError('У новой главы нет уникального ключа.', 'CHAPTER_INPUT_INVALID', 400);
    keys.add(chapter.key);
    const title = normalizeInputText(chapter.title, 'Заголовок новой главы', { allowEmpty: false, max: 300 }).trim();
    if (title.includes('\n')) throw chapterError('Заголовок новой главы должен быть одной строкой.', 'CHAPTER_INPUT_INVALID', 400);
    const body = normalizeInputText(chapter.body ?? '', `Новая глава «${title}»`);
    totalText += body.length + title.length;
    const anchor = model.sections.find(item => item.sectionId === chapter.anchorSectionId);
    if (!anchor || !['after', 'before'].includes(chapter.where)) throw chapterError(`Место вставки новой главы «${title}» больше не найдено в документе. Выберите его заново.`, 'CHAPTER_ANCHOR_MISSING', 409);
    const tab = tabsById.get(anchor.tabId);
    const prevBlock = chapter.where === 'after' ? tab.blocks[anchor.to - 1] : tab.blocks[anchor.from - 1];
    const nextBlock = chapter.where === 'after' ? tab.blocks[anchor.to] : tab.blocks[anchor.from];
    const titleRef = titleReference(model, tab, anchor), bodyRef = bodyReference(model, tab, anchor);
    // Without a Google heading style the new title is only found again as a plain «Глава/Пролог/Эпилог» line;
    // anything else would silently become text of the previous chapter, so it is refused before writing.
    if (!HEADING_STYLE.test(titleRef.namedStyleType) && !isPlainHeading(title)) throw undetectable(anchor, title);
    // A chapter whose earlier write was accepted but not confirmed (lost response, failed readback) is already
    // in the tab under this title; inserting it again would duplicate it. Refused on stage and on Apply's re-plan.
    if (model.sections.some(item => item.tabId === anchor.tabId && item.hasHeading && item.title.trim() === title) || newTitles.some(item => item.tabId === anchor.tabId && item.title === title)) {
      throw chapterError(`Глава «${title}» уже есть во вкладке «${anchor.tabTitle}» — возможно, она уже записана. Обновите оглавление и проверьте документ. Ничего не записано.`, 'CHAPTER_TITLE_EXISTS', 409);
    }
    newTitles.push({ tabId: anchor.tabId, title });
    const lines = body === '' ? [] : body.split('\n');
    pendingGaps.push({ tab, section: anchor, prevBlock, nextBlock, order: 1 + index, paragraphs: [{ text: title, role: 'title', ref: titleRef }, ...lines.map(text => ({ text, role: 'body', ref: bodyRef }))] });
    changes.push({ kind: 'new', key: chapter.key, tabId: anchor.tabId, tabTitle: anchor.tabTitle, title, where: chapter.where, anchorLabel: anchor.label, headingStyle: titleRef.namedStyleType, paragraphs: lines.map(text => ({ change: 'inserted', after: text })) });
  });
  if (totalText > MAX_WRITE_TEXT) throw chapterError('Слишком много текста для одной записи. Сохраните главы частями.', 'CHAPTER_INPUT_INVALID', 413);

  // Resolve insertion gaps only after every deletion is known, so anchors never point at removed text.
  for (const gap of pendingGaps) {
    const state = tabWork(gap.tab.tabId);
    let next = gap.nextBlock;
    while (next?.kind === 'paragraph' && state.dels.has(next.i)) next = gap.tab.blocks[next.i + 1];
    let mode, anchor;
    if (next?.kind === 'paragraph') { mode = 'before'; anchor = next; }
    else {
      let prev = gap.prevBlock;
      while (prev?.kind === 'paragraph' && state.dels.has(prev.i)) prev = gap.tab.blocks[prev.i - 1];
      // The paragraph that gets split must be plain text, so its runs can be verified after the write.
      if (prev?.kind !== 'paragraph' || !prev.editable) throw chapterError(`«${gap.section.label}»: новый текст пришлось бы вставить между таблицами или другими объектами Google. Добавьте его в оригинале.`, 'CHAPTER_ANCHOR_UNSUPPORTED', 409, { sectionId: gap.section.sectionId });
      mode = 'afterLast'; anchor = prev; state.afterAnchors.add(prev.i);
    }
    const bodyRef = bodyReference(model, gap.tab, gap.section);
    const key = `${mode}:${anchor.i}`;
    if (!state.groups.has(key)) state.groups.set(key, { mode, anchor, items: [] });
    state.groups.get(key).items.push({ order: gap.order, paragraphs: gap.paragraphs.map(item => ({ ...item, ref: item.ref ?? bodyRef })) });
  }

  const requests = [], expected = {};
  for (const [tabId, state] of work) {
    const tab = tabsById.get(tabId), ops = [];
    for (const [i, after] of state.mods) {
      const block = tab.blocks[i], diff = charHunks(block.text, after);
      if (!diff.exact) requireUniformStyle(tab, block, diff.hunks[0], state.owners.get(i));
      state.hunks.set(i, diff.hunks);
      // One delete/insert pair per hunk; the characters between hunks are never touched.
      for (const hunk of diff.hunks) {
        const at = block.startIndex + hunk.pre, list = [];
        if (hunk.deleteLength > 0) list.push({ deleteContentRange: { range: range(tabId, at, at + hunk.deleteLength) } });
        if (hunk.insert) list.push({ insertText: { location: location(tabId, at), text: hunk.insert } });
        if (list.length) ops.push({ at, priority: 1, list });
      }
    }
    for (const i of state.dels) { const block = tab.blocks[i]; ops.push({ at: block.startIndex, priority: 1, list: [{ deleteContentRange: { range: range(tabId, block.startIndex, block.endIndex) } }] }); }
    for (const group of state.groups.values()) {
      group.paragraphs = group.items.sort((x, y) => x.order - y.order).flatMap(item => item.paragraphs);
      const texts = group.paragraphs.map(item => item.text);
      const at = group.mode === 'before' ? group.anchor.startIndex : group.anchor.endIndex - 1;
      const text = group.mode === 'before' ? texts.map(value => value + '\n').join('') : '\n' + texts.join('\n');
      const list = [{ insertText: { location: location(tabId, at), text } }];
      let offset = group.mode === 'before' ? at : at + 1;
      for (const item of group.paragraphs) {
        const paragraphRange = range(tabId, offset, offset + item.text.length + 1);
        list.push({ updateParagraphStyle: { range: paragraphRange, paragraphStyle: item.ref.paragraphStyle, fields: PARAGRAPH_STYLE_FIELDS.join(',') } });
        if (item.text.length) list.push({ updateTextStyle: { range: range(tabId, offset, offset + item.text.length), textStyle: item.ref.textStyle, fields: TEXT_STYLE_FIELDS.join(',') } });
        if (group.anchor.hasBullet && !item.ref.hasBullet) list.push({ deleteParagraphBullets: { range: paragraphRange } });
        offset += item.text.length + 1;
      }
      ops.push({ at, priority: group.mode === 'afterLast' ? 0 : 2, list });
    }
    ops.sort((x, y) => y.at - x.at || x.priority - y.priority);
    for (const op of ops) requests.push(...op.list);
    expected[tabId] = orderExpected(tab, state);
  }
  const review = {
    documentId: model.documentId, documentTitle: model.title, revisionId: model.revisionId,
    requestCount: requests.length, changes, unchanged, warnings: [...warnings],
  };
  const planHash = sha(stableJson({ documentId: model.documentId, revisionId: model.revisionId, requests, expected }));
  review.planHash = planHash;
  return { requests, expected, review, planHash, newTitles, touchedTabs: [...work.keys()] };
}

// Coarse replacement of a very large rewrite: allowed only when every replaced character and both
// neighbours share one run style, so no unchanged formatting can be dropped. Otherwise refuse this chapter.
function requireUniformStyle(tab, block, hunk, section) {
  const { styles, previousNewline } = paragraphStyles(tab, block);
  const seen = new Set([...styles.slice(hunk.pre, hunk.pre + hunk.deleteLength), hunk.pre > 0 ? styles[hunk.pre - 1] : previousNewline, styles[hunk.pre + hunk.deleteLength]].filter(Boolean));
  if (seen.size > 1) throw chapterError(`«${section?.label ?? 'Глава'}»: абзац «${block.text.slice(0, 40)}…» переписан слишком сильно, чтобы TaleWisp мог точно сохранить его смешанное оформление (жирный, курсив, ссылки). Разбейте правку на меньшие части или внесите её в оригинале Google. Ничего не записано.`, 'CHAPTER_FORMAT_UNSAFE', 409, { sectionId: section?.sectionId });
}

// Run properties of every UTF-16 unit of a text-only paragraph (newline included), run-length encoded.
// Returns null when the paragraph holds anything but text runs.
function runStyles(element) {
  const out = [];
  for (const item of element?.paragraph?.elements ?? []) {
    if (!item.textRun) return null;
    const { content = '', ...rest } = item.textRun;
    if (!content.length) continue;
    const style = stableJson(cleanIndices({ ...rest, textStyle: rest.textStyle ?? {} })), last = out.at(-1);
    if (last?.[0] === style) last[1] += content.length; else out.push([style, content.length]);
  }
  return out;
}
const expandRuns = runs => runs.flatMap(([style, count]) => Array(count).fill(style));
const paragraphShape = element => stableJson(cleanIndices({ paragraphStyle: element?.paragraph?.paragraphStyle ?? {}, bullet: element?.paragraph?.bullet ?? null }));
function lastRunStyle(element) {
  const run = (element?.paragraph?.elements ?? []).findLast(item => item.textRun);
  return run ? stableJson(cleanIndices({ ...run.textRun, content: undefined, textStyle: run.textRun.textStyle ?? {} })) : undefined;
}

function paragraphStyles(tab, block) {
  const runs = runStyles(block.element), previous = tab.blocks[block.i - 1];
  return { runs, styles: expandRuns(runs ?? []), previousNewline: previous?.kind === 'paragraph' ? lastRunStyle(previous.element) : undefined };
}

// A changed paragraph keeps its paragraph properties and the exact runs of every unchanged character —
// including the characters between two separate edits. Only genuinely new characters may differ: Google
// gives them the style of a neighbour of their own hunk.
function editedExpectation(tab, block, text, hunks, splitAfter) {
  const { runs, styles, previousNewline } = paragraphStyles(tab, block), segments = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.pre > cursor) segments.push({ keep: cursor, length: hunk.pre - cursor });
    if (hunk.insert.length) segments.push({ insert: hunk.insert.length, inherited: [...new Set([hunk.pre > 0 ? styles[hunk.pre - 1] : previousNewline, styles[hunk.pre + hunk.deleteLength]].filter(Boolean))] });
    cursor = hunk.pre + hunk.deleteLength;
  }
  if (block.text.length > cursor) segments.push({ keep: cursor, length: block.text.length - cursor });
  const out = { type: 'edited', text, namedStyleType: block.namedStyleType, paragraph: paragraphShape(block.element), runs, segments };
  // New paragraphs inserted after this one split it: its newline becomes a fresh one inheriting the preceding character.
  if (splitAfter) out.newlineFrom = [...new Set([styles.at(-1), styles.length > 1 ? styles.at(-2) : previousNewline].filter(Boolean))];
  return out;
}

function verifyEdited(want, got) {
  if (got.kind !== 'paragraph' || got.text !== want.text || got.namedStyleType !== want.namedStyleType) return 'changed_text_mismatch';
  if (paragraphShape(got.element) !== want.paragraph) return 'changed_paragraph_style_changed';
  const runs = runStyles(got.element);
  if (!runs) return 'changed_text_mismatch';
  const have = expandRuns(runs), old = expandRuns(want.runs);
  if (have.length !== want.text.length + 1) return 'changed_text_mismatch';
  let k = 0;
  for (const segment of want.segments) {
    if (segment.insert) {
      for (const end = k + segment.insert; k < end; k++) if (!segment.inherited.includes(have[k])) return 'inserted_text_style_unexpected';
    } else {
      for (let o = segment.keep; o < segment.keep + segment.length; o++, k++) if (have[k] !== old[o]) return 'changed_paragraph_runs_changed';
    }
  }
  if (want.newlineFrom ? !want.newlineFrom.includes(have.at(-1)) : have.at(-1) !== old.at(-1)) return 'changed_paragraph_runs_changed';
  return '';
}

function orderExpected(tab, state) {
  const plan = [];
  const groupItems = (mode, block) => (state.groups.get(`${mode}:${block.i}`)?.paragraphs ?? []).map(item => ({ type: 'text', text: item.text, namedStyleType: item.ref.namedStyleType }));
  for (const block of tab.blocks) {
    plan.push(...groupItems('before', block));
    if (!state.dels.has(block.i)) {
      if (state.mods.has(block.i) || state.afterAnchors.has(block.i)) plan.push(editedExpectation(tab, block, state.mods.get(block.i) ?? block.text, state.hunks.get(block.i) ?? [], state.afterAnchors.has(block.i)));
      else plan.push({ type: 'same', shape: normalizeElement(block.element) });
    }
    plan.push(...groupItems('afterLast', block));
  }
  return plan;
}

const TAB_SIDE_PARTS = ['headers', 'footers', 'footnotes', 'inlineObjects', 'positionedObjects', 'documentStyle', 'namedStyles'];

export function verifyChapterReadback(before, plan, afterRaw) {
  let after;
  try { after = extractManuscript(afterRaw); } catch { return { ok: false, reason: 'readback_unparseable' }; }
  if (!after.revisionId) return { ok: false, reason: 'readback_without_revision' };
  if (after.tabs.length !== before.tabs.length || after.tabs.some((tab, i) => tab.tabId !== before.tabs[i].tabId)) return { ok: false, reason: 'tab_structure_changed' };
  const beforeEntries = tabEntries(before.raw), afterEntries = tabEntries(afterRaw);
  for (let t = 0; t < before.tabs.length; t++) {
    const oldTab = before.tabs[t], newTab = after.tabs[t];
    for (const part of TAB_SIDE_PARTS) {
      if (stableJson(cleanIndices(beforeEntries[t].documentTab[part] ?? null)) !== stableJson(cleanIndices(afterEntries[t].documentTab[part] ?? null))) return { ok: false, reason: `tab_${part}_changed`, tabId: oldTab.tabId };
    }
    const expected = plan.expected[oldTab.tabId];
    if (!expected) {
      if (oldTab.blocks.length !== newTab.blocks.length || oldTab.blocks.some((block, i) => stableJson(normalizeElement(block.element)) !== stableJson(normalizeElement(newTab.blocks[i].element)))) return { ok: false, reason: 'untouched_tab_changed', tabId: oldTab.tabId };
      continue;
    }
    if (expected.length !== newTab.blocks.length) return { ok: false, reason: 'paragraph_count_mismatch', tabId: oldTab.tabId };
    // Existing plain-heading or heading chapters must still be found the same way after the write.
    if (oldTab.detection !== 'whole' && newTab.detection !== oldTab.detection) return { ok: false, reason: 'chapter_detection_changed', tabId: oldTab.tabId };
    for (let i = 0; i < expected.length; i++) {
      const want = expected[i], got = newTab.blocks[i];
      if (want.type === 'same') {
        if (stableJson(want.shape) !== stableJson(normalizeElement(got.element))) return { ok: false, reason: 'unchanged_block_changed', tabId: oldTab.tabId, block: i };
      } else if (want.type === 'edited') {
        const reason = verifyEdited(want, got);
        if (reason) return { ok: false, reason, tabId: oldTab.tabId, block: i };
      } else if (got.kind !== 'paragraph' || got.text !== want.text || got.namedStyleType !== want.namedStyleType) {
        return { ok: false, reason: 'changed_text_mismatch', tabId: oldTab.tabId, block: i };
      }
    }
  }
  // A written new chapter must be its own chapter on reread, never hidden inside the previous one.
  for (const item of plan.newTitles ?? []) {
    if (!after.sections.some(section => section.tabId === item.tabId && section.hasHeading && section.title.trim() === item.title)) return { ok: false, reason: 'new_chapter_not_detected', tabId: item.tabId };
  }
  return { ok: true, revisionId: after.revisionId };
}

// Russian, author-facing projection of service errors. Codes are lowercase so server.mjs forwards them.
export function chapterErrorResponse(error, context = 'read') {
  const code = typeof error?.code === 'string' ? error.code : '';
  const httpStatus = Number(/HTTP (\d{3})/.exec(error?.message ?? '')?.[1] ?? 0);
  const table = {
    GOOGLE_NOT_CONNECTED: [401, 'Google не подключён. Подключите Google в настройках, чтобы открыть рукопись.', 'google_not_connected'],
    GOOGLE_NOT_CONFIGURED: [503, 'Подключение Google ещё не настроено. Откройте настройки и завершите настройку Google.', 'google_not_configured'],
    GOOGLE_SCOPE_REQUIRED: [403, 'У подключения Google нет доступа к документам. Переподключите Google и разрешите доступ к Google Docs.', 'google_scope_required'],
    GOOGLE_REVISION_CONFLICT: [409, 'Документ изменился в Google после проверки. Обновите оглавление, загрузите главы заново и проверьте правки ещё раз. Ничего не записано.', 'revision_conflict'],
    GOOGLE_REVIEW_CHANGED: [409, 'Точный план записи изменился после проверки. Откройте проверку заново — без неё запись не выполняется.', 'review_changed'],
    GOOGLE_OPERATION_ID_REUSED: [409, 'Этот номер операции уже использован для других правок. Откройте проверку заново.', 'operation_id_reused'],
    GOOGLE_OUTCOME_UNKNOWN: [409, 'Результат записи в Google неизвестен. Повторная запись не выполняется: откройте оригинал, проверьте текст и подтвердите проверку.', 'outcome_unknown'],
    GOOGLE_CHAPTER_NEEDS_REVIEW: [409, 'Google принял запись, но проверка результата не совпала с планом. Откройте оригинал и проверьте документ; новые записи заблокированы до вашей проверки.', 'outcome_unknown'],
    GOOGLE_DOCUMENT_OPERATION_PENDING: [409, 'Предыдущая запись в этот документ ждёт вашей проверки. Откройте оригинал, проверьте его и подтвердите проверку, затем повторите.', 'operation_pending'],
    GOOGLE_OPERATION_ACTIVE: [409, 'Запись в этот документ уже выполняется. Дождитесь её завершения.', 'operation_active'],
    GOOGLE_OPERATION_RECONCILED: [409, 'Эта операция уже проверена вручную и не повторяется. Откройте проверку заново.', 'operation_reconciled'],
    GOOGLE_OPERATION_REJECTED: [409, 'Google отклонил эту запись; повтор не выполняется. Откройте проверку заново.', 'operation_rejected'],
    GOOGLE_STORAGE_UNAVAILABLE: [503, 'Журнал операций Google недоступен, поэтому запись не начата.', 'google_storage_unavailable'],
    GOOGLE_OAUTH_FAILED: [502, 'Google не подтвердил вход. Переподключите Google.', 'google_oauth_failed'],
    GOOGLE_OAUTH_UNAVAILABLE: [502, 'Сервер входа Google недоступен. Повторите позже.', 'google_unavailable'],
    GOOGLE_DOCUMENT_ID_INVALID: [400, 'У выбранного файла нет корректного идентификатора Google Docs.', 'google_document_invalid'],
  };
  if (code === 'GOOGLE_NETWORK_UNKNOWN') return context === 'write' ? { status: 409, message: table.GOOGLE_OUTCOME_UNKNOWN[1], code: 'outcome_unknown' } : { status: 502, message: 'Google не ответил. Проверьте связь и повторите чтение.', code: 'google_unavailable' };
  if (table[code]) { const [status, message, lower] = table[code]; return { status, message, code: lower }; }
  if (code === 'GOOGLE_API_ERROR') {
    if (httpStatus === 403 || httpStatus === 404) return { status: 403, message: 'Нет доступа к документу Google или он удалён. Проверьте, что подключённый аккаунт может открыть этот файл.', code: 'google_no_access' };
    if (httpStatus === 401) return { status: 401, message: 'Сессия Google истекла. Переподключите Google.', code: 'google_not_connected' };
    if (error.status >= 500) return { status: 502, message: context === 'write' ? table.GOOGLE_OUTCOME_UNKNOWN[1] : 'Google временно недоступен. Повторите позже.', code: context === 'write' ? 'outcome_unknown' : 'google_unavailable' };
    return { status: 400, message: `Google отклонил запрос${httpStatus ? ` (HTTP ${httpStatus})` : ''}. Ничего не записано.`, code: 'google_api_error' };
  }
  if (code.startsWith('CHAPTER_')) return { status: Number.isInteger(error.status) ? error.status : 409, message: error.message, code: code.toLowerCase(), ...(error.sectionId ? { sectionId: error.sectionId } : {}) };
  return { status: Number.isInteger(error?.status) && error.status < 500 ? error.status : 502, message: Number.isInteger(error?.status) && error.status < 500 && /[а-яё]/i.test(error.message ?? '') ? error.message : 'Не удалось выполнить операцию с Google.', code: 'google_error' };
}

export function createChapterOperations({ apiRequest, getRawDocument, readJournal, writeJournal, reserveDocument, listPendingOperations, capabilities, activeRuns, runKey }) {
  async function requireDocs(write = false) {
    const state = await capabilities();
    if (!state.configured) throw chapterError('Google OAuth is not configured.', 'GOOGLE_NOT_CONFIGURED', 503);
    if (!state.authenticated) throw chapterError('Google is not connected.', 'GOOGLE_NOT_CONNECTED', 401);
    if (!(write ? state.canDirectEditDocs : state.canReadDocs)) throw chapterError('Google Docs scope is missing.', 'GOOGLE_SCOPE_REQUIRED', 403);
  }
  async function load(documentId) {
    const raw = await getRawDocument(documentId);
    if (raw?.documentId && raw.documentId !== documentId) throw chapterError('Google вернул другой документ.', 'CHAPTER_DOCUMENT_INVALID', 502);
    return extractManuscript({ ...raw, documentId });
  }
  async function readManuscript(documentId) {
    await requireDocs(false);
    const model = await load(documentId);
    return { ...publicManuscript(model), pendingOperations: await listPendingOperations(documentId) };
  }
  async function readSections(documentId, sectionIds) {
    if (!Array.isArray(sectionIds) || !sectionIds.length || sectionIds.length > 200 || sectionIds.some(id => typeof id !== 'string' || id.length > 400)) throw chapterError('Выберите от одной до 200 глав.', 'CHAPTER_INPUT_INVALID', 400);
    await requireDocs(false);
    const model = await load(documentId);
    const wanted = new Set(sectionIds), sections = [];
    model.sections.forEach((section, order) => { if (wanted.has(section.sectionId)) sections.push(publicSection(section, order, true)); });
    return { documentId, title: model.title, revisionId: model.revisionId, sections, missing: sectionIds.filter(id => !sections.some(section => section.sectionId === id)) };
  }
  async function stageChapterChanges(documentId, payload = {}) {
    await requireDocs(true);
    const model = await load(documentId);
    const plan = buildChapterPlan(model, payload);
    if (!plan.requests.length) throw chapterError('В выбранных главах нет изменений для записи.', 'CHAPTER_NO_CHANGES', 400);
    return { review: plan.review, pendingOperations: await listPendingOperations(documentId) };
  }
  async function applyChapterChanges(documentId, { revisionId, planHash, operationId, edits = [], newChapters = [] } = {}) {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw chapterError('Нужен уникальный номер операции.', 'CHAPTER_INPUT_INVALID', 400);
    if (typeof revisionId !== 'string' || !revisionId || typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) throw chapterError('Запись возможна только после проверки точных изменений.', 'CHAPTER_INPUT_INVALID', 400);
    const signature = sha(stableJson({ kind: 'chapter_write', documentId, revisionId, planHash, edits, newChapters }));
    const prior = await readJournal(operationId);
    if (prior) {
      if (prior.signature !== signature || prior.documentId !== documentId) throw chapterError('Operation ID reused.', 'GOOGLE_OPERATION_ID_REUSED', 409);
      if (prior.state === 'succeeded') return { ...prior.result, replayed: true };
      if (prior.state === 'conflict') throw chapterError('Revision conflict.', 'GOOGLE_REVISION_CONFLICT', 409);
      if (prior.state === 'rejected') throw chapterError('Rejected.', 'GOOGLE_OPERATION_REJECTED', 409);
      if (prior.state === 'author_reviewed') throw chapterError('Reconciled.', 'GOOGLE_OPERATION_RECONCILED', 409);
      throw chapterError('Outcome unknown.', 'GOOGLE_OUTCOME_UNKNOWN', 409, { operationId });
    }
    const key = runKey(documentId);
    if (activeRuns.has(key)) throw chapterError('Active.', 'GOOGLE_OPERATION_ACTIVE', 409);
    activeRuns.set(key, operationId);
    const entry = { operationId, signature, kind: 'chapter_write', documentId, state: 'started', createdAt: new Date().toISOString() };
    let reserved = false;
    try {
      await requireDocs(true);
      const model = await load(documentId);
      if (model.revisionId !== revisionId) throw chapterError('Revision conflict.', 'GOOGLE_REVISION_CONFLICT', 409);
      const plan = buildChapterPlan(model, { edits, newChapters });
      if (plan.planHash !== planHash || !plan.requests.length) throw chapterError('Review changed.', 'GOOGLE_REVIEW_CHANGED', 409);
      await reserveDocument(entry);
      reserved = true;
      await writeJournal(operationId, entry);
      Object.assign(entry, { state: 'outcome_unknown', phase: 'chapter_write', revisionId, planHash, requestStartedAt: new Date().toISOString() });
      await writeJournal(operationId, entry);
      try {
        await apiRequest(`${DOCS}/${encodeURIComponent(documentId)}:batchUpdate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requests: plan.requests, writeControl: { requiredRevisionId: revisionId } }),
        });
      } catch (error) {
        if (error.code === 'GOOGLE_REVISION_CONFLICT') { entry.state = 'conflict'; await writeJournal(operationId, entry); throw error; }
        if (error.code === 'GOOGLE_API_ERROR' && error.status < 500) { entry.state = 'rejected'; entry.phase = 'chapter_write_rejected'; await writeJournal(operationId, entry); throw error; }
        entry.phase = 'chapter_write_outcome_unknown'; await writeJournal(operationId, entry);
        throw chapterError('Outcome unknown.', 'GOOGLE_OUTCOME_UNKNOWN', 409, { operationId });
      }
      let afterRaw;
      try { afterRaw = await getRawDocument(documentId); }
      catch { entry.phase = 'chapter_readback_failed'; await writeJournal(operationId, entry); throw chapterError('Outcome unknown.', 'GOOGLE_OUTCOME_UNKNOWN', 409, { operationId }); }
      const verdict = verifyChapterReadback(model, plan, afterRaw);
      if (!verdict.ok) {
        Object.assign(entry, { state: 'needs_review', phase: 'chapter_verification_failed', verification: verdict });
        await writeJournal(operationId, entry);
        throw chapterError('Needs review.', 'GOOGLE_CHAPTER_NEEDS_REVIEW', 409, { operationId });
      }
      entry.state = 'succeeded';
      entry.result = {
        operationId, documentId, previousRevisionId: revisionId, revisionId: verdict.revisionId, verified: true,
        editedSections: plan.review.changes.filter(item => item.kind === 'edit').map(item => item.sectionId),
        newChapters: plan.review.changes.filter(item => item.kind === 'new').map(item => item.key),
        requestCount: plan.requests.length,
      };
      entry.completedAt = new Date().toISOString();
      await writeJournal(operationId, entry);
      return entry.result;
    } catch (error) {
      if (reserved && entry.state === 'started') { entry.state = 'rejected'; await writeJournal(operationId, entry).catch(() => {}); }
      throw error;
    } finally {
      if (activeRuns.get(key) === operationId) activeRuns.delete(key);
    }
  }
  return { readManuscript, readSections, stageChapterChanges, applyChapterChanges };
}
