import test from 'node:test';
import assert from 'node:assert/strict';
import { extractManuscript, buildChapterPlan, verifyChapterReadback, createChapterOperations, chapterErrorResponse } from '../google-chapters.mjs';

// Disposable fake Google documents only. Indexes are UTF-16 code units, exactly as the Docs API reports them.
function tab(tabId, title, items, childTabs = []) {
  let index = 1;
  const content = [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }];
  for (const item of items) {
    if (item.table) { content.push({ startIndex: index, endIndex: index + 6, table: { rows: 1, columns: 1, tableRows: [] } }); index += 6; continue; }
    if (item.toc) { content.push({ startIndex: index, endIndex: index + 4, tableOfContents: { content: [] } }); index += 4; continue; }
    const p = typeof item === 'string' ? { text: item } : item, runs = [];
    let cursor = index;
    if (p.image) { runs.push({ startIndex: cursor, endIndex: cursor + 1, inlineObjectElement: { inlineObjectId: 'kix.image' } }); cursor += 1; }
    // `runs` describes mixed formatting: [{ text, style }]; the paragraph newline belongs to the last run.
    const parts = p.runs ?? [{ text: p.text, style: p.bold ? { bold: true } : {} }];
    parts.forEach((part, k) => {
      const content = part.text + (k === parts.length - 1 ? '\n' : '');
      runs.push({ startIndex: cursor, endIndex: cursor + content.length, textRun: { content, textStyle: part.style ?? {} } }); cursor += content.length;
    });
    content.push({ startIndex: index, endIndex: cursor, paragraph: { elements: runs, paragraphStyle: { namedStyleType: p.style ?? 'NORMAL_TEXT', direction: 'LEFT_TO_RIGHT', ...(p.align ? { alignment: p.align } : {}), ...(p.headingId ? { headingId: p.headingId } : {}) } } });
    index = cursor;
  }
  const noise = { content: [{ startIndex: 0, endIndex: 11, paragraph: { elements: [{ startIndex: 0, endIndex: 11, textRun: { content: 'Колонтитул\n', textStyle: {} } }], paragraphStyle: { namedStyleType: 'HEADING_1' } } }] };
  return { tabProperties: { tabId, title }, documentTab: { body: { content }, headers: { 'kix.h': noise }, footers: { 'kix.f': noise }, footnotes: { 'kix.n': noise } }, childTabs };
}
const doc = (revisionId, tabs) => ({ documentId: 'doc-1', title: 'Рукопись', revisionId, tabs });
const H = (text, headingId, style = 'HEADING_1') => ({ text, headingId, style });

const baseTabs = () => [
  tab('t.main', 'Книга', [
    'Посвящение маме 🙂.',
    H('Глава 1', 'h.one'), 'Старый текст абзаца.', { text: 'Жирный абзац без правок.', bold: true }, { table: true }, 'После таблицы.',
    H('Сцена 1.1', 'h.scene', 'HEADING_2'), 'Сцена.',
    H('Глава 2', 'h.two'), 'Текст два.',
  ], [tab('t.child', 'Черновики', [H('Глава 3', 'h.three'), 'Во вложенной вкладке.'])]),
  tab('t.plain', 'Старое', ['Пролог', 'Вступление.', 'Глава 1', 'Строка.']),
  tab('t.whole', 'Заметки', ['Просто текст без заголовков.']),
];

const walk = (value, visit) => { if (Array.isArray(value)) value.forEach(item => walk(item, visit)); else if (value && typeof value === 'object') { visit(value); Object.values(value).forEach(item => walk(item, visit)); } };
const located = requests => { const out = []; walk(requests, node => { if (Number.isInteger(node.startIndex) || Number.isInteger(node.index)) out.push(node); }); return out; };

// Independent fake executor of a Docs batchUpdate. Each tab body becomes one unit per UTF-16 code unit, and
// requests run in order, so every index is interpreted in the coordinates left by the requests before it —
// exactly like Google. Inserted text inherits the style of the character before it (or after it at a block
// start); an inserted newline splits the paragraph and copies its paragraph style (Google assigns new heading IDs).
function executeBatch(raw, requests, revisionId = 'rev-2') {
  const out = structuredClone(raw), units = new Map();
  const visit = t => {
    const list = [];
    for (const item of t.documentTab.body.content) {
      if (item.sectionBreak) continue;
      const { startIndex, endIndex, ...rest } = item;
      if (!item.paragraph) { for (let k = startIndex; k < endIndex; k++) list.push({ ch: '\u0000', block: rest }); continue; }
      for (const element of item.paragraph.elements) {
        if (!element.textRun) { const { startIndex: a, endIndex: b, ...object } = element; list.push({ ch: '￼', object }); continue; }
        const text = element.textRun.content;
        for (let k = 0; k < text.length; k++) list.push({ ch: text[k], style: structuredClone(element.textRun.textStyle ?? {}) });
      }
      const { elements, ...para } = item.paragraph;
      list.at(-1).para = structuredClone(para);
    }
    units.set(t.tabProperties.tabId, { tab: t, list, touched: false });
    (t.childTabs ?? []).forEach(visit);
  };
  out.tabs.forEach(visit);
  const target = where => { const entry = units.get(where.tabId); assert.ok(entry, 'every request names an existing tab'); entry.touched = true; return entry.list; };
  const assign = (dst, src, fields) => { for (const field of fields.split(',')) { if (Object.hasOwn(src, field)) dst[field] = structuredClone(src[field]); else delete dst[field]; } };
  const paragraphs = (list, from, to, fn) => {
    let start = 0;
    list.forEach((unit, k) => {
      if (unit.block) { start = k + 1; return; }
      if (unit.ch !== '\n') return;
      if (start < to && k >= from) fn(unit.para);
      start = k + 1;
    });
  };
  for (const request of requests) {
    if (request.insertText) {
      const { location: loc, text } = request.insertText, list = target(loc), pos = loc.index - 1;
      assert.ok(pos >= 0 && pos <= list.length, 'insertion inside the tab');
      assert.ok(!(list[pos - 1]?.block && list[pos - 1].block === list[pos]?.block), 'never inserts inside a table');
      const left = list[pos - 1], source = left && left.style ? left : list[pos];
      const paragraphEnd = list.slice(pos).find(unit => unit.ch === '\n' && unit.para);
      const added = Array.from({ length: text.length }, (_, k) => ({ ch: text[k], style: structuredClone(source?.style ?? {}) }));
      for (const unit of added) if (unit.ch === '\n') { unit.para = structuredClone(paragraphEnd.para); delete unit.para.paragraphStyle?.headingId; }
      list.splice(pos, 0, ...added);
    } else if (request.deleteContentRange) {
      const { range } = request.deleteContentRange, list = target(range);
      const removed = list.slice(range.startIndex - 1, range.endIndex - 1);
      assert.equal(removed.length, range.endIndex - range.startIndex, 'deletion inside the tab');
      assert.ok(removed.every(unit => !unit.block && !unit.object), 'never deletes tables or inline objects');
      list.splice(range.startIndex - 1, removed.length);
    } else if (request.updateParagraphStyle) {
      const { range, paragraphStyle, fields } = request.updateParagraphStyle;
      paragraphs(target(range), range.startIndex - 1, range.endIndex - 1, para => { para.paragraphStyle ??= {}; assign(para.paragraphStyle, paragraphStyle, fields); });
    } else if (request.updateTextStyle) {
      const { range, textStyle, fields } = request.updateTextStyle, list = target(range);
      for (let k = range.startIndex - 1; k < range.endIndex - 1; k++) { assert.ok(list[k].style, 'text style only on text'); assign(list[k].style, textStyle, fields); }
    } else if (request.deleteParagraphBullets) {
      const { range } = request.deleteParagraphBullets;
      paragraphs(target(range), range.startIndex - 1, range.endIndex - 1, para => { delete para.bullet; });
    } else assert.fail('unexpected request ' + Object.keys(request)[0]);
  }
  for (const { tab: t, list, touched } of units.values()) {
    if (!touched) continue;
    const content = [t.documentTab.body.content.find(item => item.sectionBreak)];
    let index = 1, k = 0;
    while (k < list.length) {
      if (list[k].block) {
        const block = list[k].block, from = index;
        while (k < list.length && list[k].block === block) { k++; index++; }
        content.push({ startIndex: from, endIndex: index, ...structuredClone(block) });
        continue;
      }
      const from = index, elements = [];
      for (;;) {
        const unit = list[k++], last = elements.at(-1);
        if (unit.object) elements.push({ startIndex: index, endIndex: index + 1, ...structuredClone(unit.object) });
        else if (last?.textRun && JSON.stringify(last.textRun.textStyle) === JSON.stringify(unit.style)) { last.textRun.content += unit.ch; last.endIndex++; }
        else elements.push({ startIndex: index, endIndex: index + 1, textRun: { content: unit.ch, textStyle: structuredClone(unit.style) } });
        index++;
        if (unit.ch === '\n' && unit.para) { content.push({ startIndex: from, endIndex: index, paragraph: { elements, ...structuredClone(unit.para) } }); break; }
      }
    }
    t.documentTab.body.content = content;
  }
  out.revisionId = revisionId;
  return out;
}

test('extracts chapters across nested tabs with real UTF-16 ranges, keeps the preamble and ignores headers/footers/footnotes', () => {
  const model = extractManuscript(doc('rev-1', baseTabs()));
  const ids = model.sections.map(section => section.sectionId);
  assert.deepEqual(ids.slice(0, 5), ['pre:t.main', 'h:t.main:h.one', 'h:t.main:h.scene', 'h:t.main:h.two', 'h:t.child:h.three']);
  const preamble = model.sections[0];
  assert.equal(preamble.detection, 'preamble');
  assert.equal(preamble.bodyText, 'Посвящение маме 🙂.');
  assert.equal(preamble.endIndex - preamble.startIndex, 'Посвящение маме 🙂.\n'.length, 'emoji counts as two UTF-16 units');
  const one = model.sections[1];
  assert.equal(one.level, 1); assert.equal(one.headingId, 'h.one');
  assert.match(one.bodyText, /Старый текст абзаца\.\nЖирный абзац без правок\.\n⟦Таблица/);
  assert.equal(model.sections[2].level, 2);
  const child = model.tabs.find(item => item.tabId === 't.child');
  assert.equal(child.depth, 1); assert.deepEqual(child.path, ['Книга', 'Черновики']);
  assert.ok(!model.sections.some(section => /Колонтитул/.test(section.bodyText + section.title)), 'headers, footers and footnotes are never manuscript text');
});

test('labels the plain-heading fallback and offers a whole-tab section when there are no headings', () => {
  const model = extractManuscript(doc('rev-1', baseTabs()));
  const plain = model.sections.filter(section => section.tabId === 't.plain');
  assert.deepEqual(plain.map(section => [section.detection, section.title]), [['plain', 'Пролог'], ['plain', 'Глава 1']]);
  const whole = model.sections.filter(section => section.tabId === 't.whole');
  assert.equal(whole.length, 1); assert.equal(whole[0].detection, 'whole');
  assert.match(whole[0].label, /заголовков нет/); assert.equal(whole[0].bodyText, 'Просто текст без заголовков.');
  const toc = extractManuscript(doc('rev-1', [tab('t', 'T', [{ toc: true }, H('Глава', 'h.a'), 'Текст.'])]));
  assert.ok(!toc.sections.some(section => section.detection === 'heading' && /Оглавление/.test(section.bodyText)), 'the Google TOC never becomes chapter text');
});

test('a multi-paragraph edit becomes one minimal, tab-targeted batch whose real execution leaves formatting and other blocks alone', () => {
  const raw = doc('rev-1', baseTabs()), model = extractManuscript(raw);
  const one = model.sections.find(section => section.sectionId === 'h:t.main:h.one');
  const bold = one.bodyBlocks.find(block => block.text.startsWith('Жирный'));
  const body = one.bodyText.replace('Старый текст абзаца.', 'Новый текст абзаца.\nВторой новый абзац.');
  const plan = buildChapterPlan(model, { edits: [{ sectionId: one.sectionId, baseHash: one.hash, title: 'Глава 1', body }] });
  assert.ok(plan.requests.length > 0);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(buildChapterPlan(model, { edits: [{ sectionId: one.sectionId, baseHash: one.hash, title: 'Глава 1', body }] }).planHash, plan.planHash, 'review binding is deterministic');
  const nodes = located(plan.requests);
  assert.ok(nodes.every(node => node.tabId === 't.main'), 'every range/location names its tab explicitly');
  // Mutation anchors run from the end of the tab. A style request may only follow an insertion and only
  // cover that freshly inserted text, in the coordinates that exist after it (original indexes no longer apply).
  let lastAnchor = Infinity, fresh = null;
  for (const request of plan.requests) {
    const anchor = request.insertText?.location.index ?? request.deleteContentRange?.range.startIndex;
    if (anchor !== undefined) {
      assert.ok(anchor <= lastAnchor, 'mutation anchors are ordered from the end of the tab'); lastAnchor = anchor;
      fresh = request.insertText ? { start: anchor, end: anchor + request.insertText.text.length + (request.insertText.text.startsWith('\n') ? 1 : 0) } : null;
      continue;
    }
    const styled = (request.updateParagraphStyle ?? request.updateTextStyle ?? request.deleteParagraphBullets).range;
    assert.ok(fresh && styled.startIndex >= fresh.start && styled.endIndex <= fresh.end, 'style requests touch only the paragraphs just inserted');
  }
  const inserted = []; walk(plan.requests, node => { if (node.insertText) inserted.push(node.insertText.text); });
  assert.ok(inserted.join('').length < 40, 'only the changed characters are written, not the whole chapter or book');

  // Execute the batch exactly as Google would and inspect the old bold paragraph at its new position.
  const result = executeBatch(raw, plan.requests), after = extractManuscript(result);
  const main = after.tabs.find(item => item.tabId === 't.main');
  const boldAfter = main.blocks.filter(block => block.text === bold.text);
  assert.equal(boldAfter.length, 1, 'the untouched bold paragraph still exists exactly once');
  assert.ok(boldAfter[0].startIndex > bold.startIndex, 'it moved because a paragraph was inserted before it');
  assert.deepEqual(boldAfter[0].element.paragraph.elements.map(element => [element.textRun.content, element.textRun.textStyle]), [['Жирный абзац без правок.\n', { bold: true }]], 'its text and runs are exact');
  assert.deepEqual(boldAfter[0].element.paragraph.paragraphStyle, bold.element.paragraph.paragraphStyle, 'its paragraph style is exact');
  const added = main.blocks.find(block => block.text === 'Второй новый абзац.');
  assert.deepEqual(added.element.paragraph.elements.map(element => element.textRun.textStyle), [{}], 'bold does not leak into the inserted paragraph');
  assert.equal(after.sections.find(section => section.sectionId === one.sectionId).bodyText, body);
  for (const id of ['h:t.main:h.two', 'h:t.child:h.three', 'pre:t.main']) assert.equal(after.sections.find(section => section.sectionId === id).hash, model.sections.find(section => section.sectionId === id).hash, id + ' is unchanged');
  assert.deepEqual(verifyChapterReadback(model, plan, result), { ok: true, revisionId: 'rev-2' }, 'the executed result passes readback verification');
  assert.ok(plan.review.changes.some(change => change.kind === 'edit' && change.paragraphs.some(p => p.after === 'Второй новый абзац.')));
});

test('readback of a changed paragraph keeps the runs of every unchanged character and its paragraph properties', () => {
  const tabsWith = paragraph => [tab('t.main', 'Книга', [H('Глава 1', 'h.one'), paragraph, 'Хвост.'])];
  const original = { align: 'JUSTIFIED', runs: [{ text: 'Обычный ' }, { text: 'жирный 🙂', style: { bold: true } }, { text: ' конец.', style: { italic: true } }] };
  const raw = doc('rev-1', tabsWith(original)), model = extractManuscript(raw), section = model.sections[0];
  const plan = buildChapterPlan(model, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.bodyText.replace('🙂', '🙃') }] });
  const inserted = []; walk(plan.requests, node => { if (node.insertText) inserted.push(node.insertText.text); });
  assert.deepEqual(inserted, ['🙃'], 'only the emoji is rewritten');
  const exact = executeBatch(raw, plan.requests);
  assert.deepEqual(verifyChapterReadback(model, plan, exact), { ok: true, revisionId: 'rev-2' }, 'the exact readback is accepted; the new emoji inherited the bold of its neighbour');
  const readback = runs => doc('rev-2', tabsWith({ ...original, runs }));
  const fail = (value, reason) => assert.deepEqual(verifyChapterReadback(model, plan, value), { ok: false, reason, tabId: 't.main', block: 2 });
  // The demonstrated loss: same text, but unchanged characters of the edited paragraph lost their bold.
  fail(readback([{ text: 'Обычный ' }, { text: 'жирный 🙃' }, { text: ' конец.', style: { italic: true } }]), 'changed_paragraph_runs_changed');
  fail(readback([{ text: 'Обычный ' }, { text: 'жирный 🙃', style: { bold: true } }, { text: ' конец.' }]), 'changed_paragraph_runs_changed');
  fail(doc('rev-2', tabsWith({ runs: [{ text: 'Обычный ' }, { text: 'жирный 🙃', style: { bold: true } }, { text: ' конец.', style: { italic: true } }] })), 'changed_paragraph_style_changed');
  fail(readback([{ text: 'Обычный ' }, { text: 'жирный ', style: { bold: true } }, { text: '🙃', style: { underline: true } }, { text: ' конец.', style: { italic: true } }]), 'inserted_text_style_unexpected');
  // Google may also give new characters the style of the following neighbour; that is allowed explicitly.
  assert.equal(verifyChapterReadback(model, plan, readback([{ text: 'Обычный ' }, { text: 'жирный ', style: { bold: true } }, { text: '🙃 конец.', style: { italic: true } }])).ok, true);

  // A paragraph appended at the end of a tab splits the last paragraph; its text and runs must survive.
  const appended = buildChapterPlan(model, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.bodyText + '\nНовый финал.' }] });
  const appendedResult = executeBatch(raw, appended.requests);
  assert.deepEqual(extractManuscript(appendedResult).sections[0].bodyText, section.bodyText + '\nНовый финал.');
  assert.deepEqual(verifyChapterReadback(model, appended, appendedResult), { ok: true, revisionId: 'rev-2' });
});

test('two separated edits around unchanged bold, italic and linked spans keep those runs exactly; damaged runs are rejected', () => {
  const link = { link: { url: 'https://example.com/a' }, underline: true };
  const runs = [{ text: 'А начало, ' }, { text: 'важно', style: { bold: true } }, { text: ' и ' }, { text: 'курсив', style: { italic: true } }, { text: ', ' }, { text: 'ссылка', style: link }, { text: ' конец Б.' }];
  const raw = doc('rev-1', [tab('t.main', 'Книга', [H('Глава 1', 'h.one'), { runs }, 'Хвост.'])]), model = extractManuscript(raw), section = model.sections[0];
  const body = section.bodyText.replace('А начало', 'Я начало').replace('конец Б.', 'конец Ю!');
  const plan = buildChapterPlan(model, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body }] });
  const inserted = []; walk(plan.requests, node => { if (node.insertText) inserted.push(node.insertText.text); });
  assert.deepEqual(inserted, ['Ю!', 'Я'], 'two hunks, written from the end; the formatted middle is not rewritten');
  const executed = executeBatch(raw, plan.requests);
  const paragraph = extractManuscript(executed).tabs[0].blocks.find(block => block.text === body.split('\n')[0]);
  assert.deepEqual(paragraph.element.paragraph.elements.map(element => [element.textRun.content, element.textRun.textStyle]), [
    ['Я начало, ', {}], ['важно', { bold: true }], [' и ', {}], ['курсив', { italic: true }], [', ', {}], ['ссылка', link], [' конец Ю!\n', {}],
  ], 'bold, italic and the link survive exactly between the two edits');
  assert.deepEqual(verifyChapterReadback(model, plan, executed), { ok: true, revisionId: 'rev-2' });
  const damage = (text, style) => {
    const copy = structuredClone(executed);
    for (const item of copy.tabs[0].documentTab.body.content) for (const element of item.paragraph?.elements ?? []) if (element.textRun?.content === text) element.textRun.textStyle = style;
    return verifyChapterReadback(model, plan, copy).reason;
  };
  assert.equal(damage('важно', {}), 'changed_paragraph_runs_changed', 'lost bold between the edits is detected');
  assert.equal(damage('ссылка', { underline: true }), 'changed_paragraph_runs_changed', 'a lost link is detected');
  assert.equal(damage('курсив', { italic: true, bold: true }), 'changed_paragraph_runs_changed', 'added formatting is detected');
});

test('a huge rewrite of a mixed-format paragraph is refused before writing; a huge uniform rewrite stays exact', () => {
  const mixed = { runs: [{ text: 'а'.repeat(1500) }, { text: 'жирное', style: { bold: true } }, { text: 'б'.repeat(1500) }] };
  const model = extractManuscript(doc('rev-1', [tab('t', 'T', [H('Глава', 'h.a'), mixed, 'Хвост.'])])), section = model.sections[0];
  const body = section.bodyText.replace(/а/g, 'в').replace(/б/g, 'г');
  assert.throws(() => buildChapterPlan(model, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава', body }] }), error => error.code === 'CHAPTER_FORMAT_UNSAFE' && error.status === 409 && error.sectionId === section.sectionId && /оформление/.test(error.message));
  const raw = doc('rev-1', [tab('t', 'T', [H('Глава', 'h.a'), 'а'.repeat(3000), 'Хвост.'])]), plain = extractManuscript(raw), only = plain.sections[0];
  const plan = buildChapterPlan(plain, { edits: [{ sectionId: only.sectionId, baseHash: only.hash, title: 'Глава', body: only.bodyText.replace(/а/g, 'в') }] });
  assert.equal(verifyChapterReadback(plain, plan, executeBatch(raw, plan.requests)).ok, true);
});

test('a new chapter in a plain-heading tab must be recognisable; after the write it is found as its own chapter next to the original fallback sections', () => {
  const raw = doc('rev-1', [tab('t.plain', 'Старое', ['Пролог', 'Вступление.', 'Глава 1', 'Строка.']), tab('t.whole', 'Заметки', ['Просто текст.'])]);
  const model = extractManuscript(raw), prolog = model.sections.find(section => section.tabId === 't.plain' && section.title === 'Пролог');
  const chapter = (title, anchorSectionId = prolog.sectionId) => ({ key: 'n1', title, body: 'Текст новой.', anchorSectionId, where: 'after' });
  assert.throws(() => buildChapterPlan(model, { newChapters: [chapter('Новая встреча')] }), error => error.code === 'CHAPTER_TITLE_UNDETECTABLE' && error.status === 409 && /Глава N/.test(error.message));
  assert.throws(() => buildChapterPlan(model, { edits: [{ sectionId: prolog.sectionId, baseHash: prolog.hash, title: 'Встреча', body: prolog.bodyText }] }), { code: 'CHAPTER_TITLE_UNDETECTABLE' }, 'renaming a plain heading into an unrecognisable line is refused too');

  const plan = buildChapterPlan(model, { newChapters: [chapter('Глава 1. Новая встреча')] });
  const executed = executeBatch(raw, plan.requests), after = extractManuscript(executed);
  assert.deepEqual(after.sections.filter(section => section.tabId === 't.plain').map(section => [section.detection, section.title, section.bodyText]), [
    ['plain', 'Пролог', 'Вступление.'], ['plain', 'Глава 1. Новая встреча', 'Текст новой.'], ['plain', 'Глава 1', 'Строка.'],
  ], 'create → execute → extract finds the new chapter separately and keeps both original fallback chapters');
  assert.deepEqual(verifyChapterReadback(model, plan, executed), { ok: true, revisionId: 'rev-2' });
  assert.equal(verifyChapterReadback(model, { ...plan, newTitles: [{ tabId: 't.plain', title: 'Невидимая' }] }, executed).reason, 'new_chapter_not_detected', 'a hidden new chapter is never a success');

  // A tab without any headings gets a Google heading: the new chapter is found and the old text stays whole.
  const whole = model.sections.find(section => section.tabId === 't.whole');
  const wholePlan = buildChapterPlan(model, { newChapters: [chapter('Новая встреча', whole.sectionId)] });
  const wholeExecuted = executeBatch(raw, wholePlan.requests), wholeAfter = extractManuscript(wholeExecuted).sections.filter(section => section.tabId === 't.whole');
  assert.deepEqual(wholeAfter.map(section => [section.hasHeading, section.title, section.bodyText]), [[false, '', 'Просто текст.'], [true, 'Новая встреча', 'Текст новой.']]);
  assert.equal(verifyChapterReadback(model, wholePlan, wholeExecuted).ok, true);
});

test('stale base hashes and changes to locked paragraphs are refused for the affected chapter only', () => {
  const model = extractManuscript(doc('rev-1', baseTabs()));
  const two = model.sections.find(section => section.sectionId === 'h:t.main:h.two');
  assert.throws(() => buildChapterPlan(model, { edits: [{ sectionId: two.sectionId, baseHash: 'outdated', title: 'Глава 2', body: 'x' }] }), error => error.code === 'CHAPTER_SECTION_CHANGED' && error.sectionId === two.sectionId);
  const locked = extractManuscript(doc('rev-1', [tab('t', 'T', [H('Глава', 'h.a'), { text: 'Подпись к рисунку.', image: true }, 'Обычный.'])]));
  const section = locked.sections[0];
  assert.throws(() => buildChapterPlan(locked, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава', body: section.bodyText.replace('Подпись', 'Новая подпись') }] }), error => error.status === 409 && /[а-яё]/i.test(error.message));
  const allowed = buildChapterPlan(locked, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава', body: section.bodyText.replace('Обычный.', 'Обычный, но исправленный.') }] });
  assert.ok(allowed.requests.length > 0, 'editing a neighbouring plain paragraph is still possible');
});

function fakeGoogle(initial) {
  const journal = new Map(), reservations = [], calls = [];
  let current = initial, onWrite = () => { throw Error('unexpected write'); };
  const primitives = {
    apiRequest: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return onWrite(); },
    getRawDocument: async () => structuredClone(current),
    readJournal: async id => (journal.has(id) ? structuredClone(journal.get(id)) : null),
    writeJournal: async (id, entry) => { journal.set(id, structuredClone(entry)); },
    reserveDocument: async entry => { reservations.push(entry.operationId); },
    listPendingOperations: async () => [],
    capabilities: async () => ({ configured: true, authenticated: true, canReadDocs: true, canDirectEditDocs: true }),
    activeRuns: new Map(), runKey: id => 'docs:' + id,
  };
  return { ops: createChapterOperations(primitives), journal, reservations, calls, set: value => { current = value; }, writes: fn => { onWrite = fn; } };
}
const simpleTabs = (paragraph, extra = []) => [tab('t.main', 'Книга', [H('Глава 1', 'h.one'), paragraph, { text: 'Жирный.', bold: true }, ...extra, H('Глава 2', 'h.two'), 'Текст два.']), tab('t.other', 'Другая', ['Не трогать.'])];

test('apply re-reads, guards the reviewed revision, journals before writing, verifies the readback and never writes twice', async () => {
  const google = fakeGoogle(doc('rev-1', simpleTabs('Старый текст.')));
  const read = await google.ops.readSections('doc-1', ['h:t.main:h.one']);
  const section = read.sections[0];
  const edits = [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.body.replace('Старый', 'Новый') }];
  const { review } = await google.ops.stageChapterChanges('doc-1', { edits, newChapters: [] });
  assert.equal(review.revisionId, 'rev-1');
  google.writes(() => { assert.equal(google.journal.get('op-edit-0001').state, 'outcome_unknown', 'journal is durable before the request'); google.set(doc('rev-2', simpleTabs('Новый текст.'))); return {}; });
  const result = await google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-edit-0001', edits, newChapters: [] });
  assert.equal(result.verified, true); assert.equal(result.revisionId, 'rev-2'); assert.deepEqual(result.editedSections, [section.sectionId]);
  assert.equal(google.calls.length, 1);
  assert.match(google.calls[0].url, /doc-1:batchUpdate$/);
  assert.deepEqual(google.calls[0].body.writeControl, { requiredRevisionId: 'rev-1' });
  assert.deepEqual(google.reservations, ['op-edit-0001']);
  assert.equal(google.journal.get('op-edit-0001').state, 'succeeded');
  const replay = await google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-edit-0001', edits, newChapters: [] });
  assert.equal(replay.replayed, true); assert.equal(google.calls.length, 1, 'a repeated Apply returns the journaled result without a second write');
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-edit-0001', edits: [{ ...edits[0], body: 'другое' }], newChapters: [] }), { code: 'GOOGLE_OPERATION_ID_REUSED' });
});

test('a changed document or plan is a conflict before any write', async () => {
  const google = fakeGoogle(doc('rev-1', simpleTabs('Старый текст.')));
  const section = (await google.ops.readSections('doc-1', ['h:t.main:h.one'])).sections[0];
  const edits = [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.body.replace('Старый', 'Новый') }];
  const { review } = await google.ops.stageChapterChanges('doc-1', { edits });
  google.set(doc('rev-9', simpleTabs('Старый текст.')));
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-conflict-1', edits }), { code: 'GOOGLE_REVISION_CONFLICT' });
  google.set(doc('rev-1', simpleTabs('Старый текст.')));
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: 'f'.repeat(64), operationId: 'op-conflict-2', edits }), { code: 'GOOGLE_REVIEW_CHANGED' });
  assert.equal(google.calls.length, 0);
  google.writes(() => { throw Object.assign(Error('Google rejected requiredRevisionId'), { code: 'GOOGLE_REVISION_CONFLICT' }); });
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-conflict-3', edits }), { code: 'GOOGLE_REVISION_CONFLICT' });
  assert.equal(google.journal.get('op-conflict-3').state, 'conflict');
  assert.equal(chapterErrorResponse({ code: 'GOOGLE_REVISION_CONFLICT' }, 'write').status, 409);
});

test('a lost response stays outcome-unknown and is never retried; a mismatching readback needs author review', async () => {
  const google = fakeGoogle(doc('rev-1', simpleTabs('Старый текст.')));
  const section = (await google.ops.readSections('doc-1', ['h:t.main:h.one'])).sections[0];
  const edits = [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.body.replace('Старый', 'Новый') }];
  const { review } = await google.ops.stageChapterChanges('doc-1', { edits });
  google.writes(() => { throw Object.assign(Error('socket hang up'), { code: 'GOOGLE_NETWORK_UNKNOWN' }); });
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-unknown-1', edits }), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  assert.equal(google.journal.get('op-unknown-1').state, 'outcome_unknown');
  await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-unknown-1', edits }), { code: 'GOOGLE_OUTCOME_UNKNOWN' });
  assert.equal(google.calls.length, 1, 'unknown result is not retried');
  assert.equal(chapterErrorResponse({ code: 'GOOGLE_OUTCOME_UNKNOWN' }, 'write').code, 'outcome_unknown');

  // Google "succeeds" but the bold neighbour lost its style and another tab changed: verification must fail.
  const second = fakeGoogle(doc('rev-1', simpleTabs('Старый текст.')));
  const s2 = (await second.ops.readSections('doc-1', ['h:t.main:h.one'])).sections[0];
  const e2 = [{ sectionId: s2.sectionId, baseHash: s2.hash, title: 'Глава 1', body: s2.body.replace('Старый', 'Новый') }];
  const r2 = (await second.ops.stageChapterChanges('doc-1', { edits: e2 })).review;
  const damaged = doc('rev-2', simpleTabs('Новый текст.'));
  damaged.tabs[0].documentTab.body.content.find(item => item.paragraph?.elements[0].textRun?.content === 'Жирный.\n').paragraph.elements[0].textRun.textStyle = {};
  second.writes(() => { second.set(damaged); return {}; });
  await assert.rejects(second.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: r2.planHash, operationId: 'op-review-1', edits: e2 }), { code: 'GOOGLE_CHAPTER_NEEDS_REVIEW' });
  assert.equal(second.journal.get('op-review-1').state, 'needs_review');
});

test('verification detects changes in untouched tabs', () => {
  const before = extractManuscript(doc('rev-1', simpleTabs('Старый текст.')));
  const section = before.sections.find(item => item.sectionId === 'h:t.main:h.one');
  const plan = buildChapterPlan(before, { edits: [{ sectionId: section.sectionId, baseHash: section.hash, title: 'Глава 1', body: section.bodyText.replace('Старый', 'Новый') }] });
  assert.equal(verifyChapterReadback(before, plan, doc('rev-2', simpleTabs('Новый текст.'))).ok, true);
  const otherChanged = doc('rev-2', simpleTabs('Новый текст.'));
  otherChanged.tabs[1] = tab('t.other', 'Другая', ['Изменено кем-то.']);
  assert.equal(verifyChapterReadback(before, plan, otherChanged).ok, false);
});

test('a new chapter is inserted once at the chosen place with a heading style, and a repeated Apply does not duplicate it', async () => {
  const google = fakeGoogle(doc('rev-1', simpleTabs('Текст один.')));
  const newChapters = [{ key: 'new-chapter-1', title: 'Глава 1½', body: 'Первый абзац.\nВторой абзац.', anchorSectionId: 'h:t.main:h.one', where: 'after' }];
  const { review } = await google.ops.stageChapterChanges('doc-1', { edits: [], newChapters });
  const change = review.changes.find(item => item.kind === 'new');
  assert.equal(change.title, 'Глава 1½'); assert.equal(change.where, 'after');
  const after = doc('rev-2', [tab('t.main', 'Книга', [H('Глава 1', 'h.one'), 'Текст один.', { text: 'Жирный.', bold: true }, H('Глава 1½', 'h.new'), 'Первый абзац.', 'Второй абзац.', H('Глава 2', 'h.two'), 'Текст два.']), tab('t.other', 'Другая', ['Не трогать.'])]);
  google.writes(() => { google.set(after); return {}; });
  const apply = () => google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-new-0001', edits: [], newChapters });
  const result = await apply();
  assert.deepEqual(result.newChapters, ['new-chapter-1']);
  const body = google.calls[0].body;
  const texts = []; walk(body.requests, node => { if (node.insertText) texts.push(node.insertText.text); });
  assert.match(texts.join(''), /Глава 1½/); assert.match(texts.join(''), /Второй абзац\./);
  const styled = []; walk(body.requests, node => { if (node.updateParagraphStyle) styled.push(node.updateParagraphStyle); });
  assert.ok(styled.some(item => item.paragraphStyle?.namedStyleType === 'HEADING_1' && item.range.tabId === 't.main'));
  assert.ok(located(body.requests).every(node => node.tabId === 't.main'));
  const original = doc('rev-1', simpleTabs('Текст один.')), originalModel = extractManuscript(original), plan = buildChapterPlan(originalModel, { newChapters });
  assert.deepEqual(plan.requests, body.requests, 'the applied batch is exactly the reviewed plan');
  const executed = executeBatch(original, plan.requests), executedModel = extractManuscript(executed);
  assert.deepEqual(executedModel.sections.map(section => section.title).filter(Boolean), ['Глава 1', 'Глава 1½', 'Глава 2']);
  assert.equal(executedModel.tabs[0].blocks.find(block => block.text === 'Глава 1½').namedStyleType, 'HEADING_1');
  assert.equal(verifyChapterReadback(originalModel, plan, executed).ok, true);
  assert.equal((await apply()).replayed, true);
  assert.equal(google.calls.length, 1, 'the new chapter is written exactly once');
});

test('a new chapter title already in the same tab, or repeated in one batch, is refused before writing; another tab is not affected', () => {
  const model = extractManuscript(doc('rev-1', simpleTabs('Текст один.')));
  const chapter = (key, title, anchorSectionId = 'h:t.main:h.one') => ({ key, title, body: 'Абзац.', anchorSectionId, where: 'after' });
  assert.throws(() => buildChapterPlan(model, { newChapters: [chapter('a', '  Глава 2 ')] }), error => error.code === 'CHAPTER_TITLE_EXISTS' && error.status === 409 && /уже есть во вкладке «Книга»/.test(error.message));
  assert.throws(() => buildChapterPlan(model, { newChapters: [chapter('a', 'Глава 9'), chapter('b', ' Глава 9')] }), { code: 'CHAPTER_TITLE_EXISTS' });
  const plan = buildChapterPlan(model, { newChapters: [chapter('a', 'Глава 2', 'all:t.other'), chapter('b', 'Глава 9'), chapter('c', 'Глава 9', 'all:t.other')] });
  assert.ok(plan.requests.length > 0, 'the same title in another tab is allowed');
  assert.deepEqual(chapterErrorResponse(Object.assign(new Error('x'), { code: 'CHAPTER_TITLE_EXISTS', status: 409 }), 'write'), { status: 409, message: 'x', code: 'chapter_title_exists' });
});

test('after an applied batch whose reply was lost or whose readback needs review, the same new chapter is refused on stage and Apply after reconciliation — no second batch', async () => {
  for (const mode of ['lost', 'review']) {
    const original = doc('rev-1', simpleTabs('Текст один.')), google = fakeGoogle(original);
    const newChapters = [{ key: 'new-chapter-1', title: 'Глава 1½', body: 'Первый абзац.\nВторой абзац.', anchorSectionId: 'h:t.main:h.one', where: 'after' }];
    const { review } = await google.ops.stageChapterChanges('doc-1', { edits: [], newChapters });
    google.writes(() => {
      const executed = executeBatch(original, google.calls.at(-1).body.requests);
      if (mode === 'review') executed.tabs[1] = tab('t.other', 'Другая', ['Изменено кем-то во время записи.']);
      google.set(executed); // Google applied the batch
      if (mode === 'lost') throw Object.assign(Error('socket hang up'), { code: 'GOOGLE_NETWORK_UNKNOWN' });
      return {};
    });
    await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-1', planHash: review.planHash, operationId: 'op-dup-0001', edits: [], newChapters }), { code: mode === 'lost' ? 'GOOGLE_OUTCOME_UNKNOWN' : 'GOOGLE_CHAPTER_NEEDS_REVIEW' });
    assert.equal(chapterErrorResponse({ code: mode === 'lost' ? 'GOOGLE_NETWORK_UNKNOWN' : 'GOOGLE_CHAPTER_NEEDS_REVIEW' }, 'write').code, 'outcome_unknown');
    google.journal.set('op-dup-0001', { ...google.journal.get('op-dup-0001'), state: 'author_reviewed' }); // the author reconciled
    await assert.rejects(google.ops.stageChapterChanges('doc-1', { edits: [], newChapters }), { code: 'CHAPTER_TITLE_EXISTS', status: 409 }, mode + ': stage refuses the duplicate');
    await assert.rejects(google.ops.stageChapterChanges('doc-1', { edits: [], newChapters: [{ ...newChapters[0], key: 'new-chapter-2', title: ' Глава 1½  ' }] }), { code: 'CHAPTER_TITLE_EXISTS' }, 'a trimmed copy under a fresh key too');
    await assert.rejects(google.ops.applyChapterChanges('doc-1', { revisionId: 'rev-2', planHash: 'f'.repeat(64), operationId: 'op-dup-0002', edits: [], newChapters }), { code: 'CHAPTER_TITLE_EXISTS' }, mode + ': Apply re-plans and refuses as well');
    assert.equal(google.calls.length, 1, mode + ': batchUpdate ran exactly once');
    assert.equal(google.journal.has('op-dup-0002'), false, 'the refused Apply never started an operation');
    assert.deepEqual(google.reservations, ['op-dup-0001']);
  }
});
