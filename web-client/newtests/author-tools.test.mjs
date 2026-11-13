import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createAuthorTools, countWords } from '../author-tools.mjs';
import { buildBookFile, paragraphsOf, zip } from '../book-export.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function unzip(buffer) {
  const files = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), start = offset + 30 + nameLength + extra, body = buffer.subarray(start, start + size);
    files.set(name, method === 0 ? body : inflateRawSync(body)); offset = start + size;
  }
  return files;
}
function fixture(t, { chapters, cards = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'author-tools-')), root = join(dir, 'series'); mkdirSync(root);
  let clock = Date.UTC(2026, 10, 12, 9, 0, 0), copy = null; const settings = new Map();
  const context = { authorId: 'a', authorName: 'Анна Вересова', seriesId: 's', seriesName: 'Хроники перевала', bookId: 'book1', bookName: 'Зимняя тропа', documentId: 'doc1' };
  const tools = createAuthorTools({ dataDir: join(dir, 'data'), now: () => clock,
    manuscriptFiles: { read: () => copy, save: (bookId, documentId, version, next) => (copy = { bookId, documentId, version: version + 1, chapters: next }), importDocument: () => copy, view: value => value },
    store: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value), listDocuments: () => [{ id: 'd1', bookId: 'book1', title: 'Набросок финала', text: 'Марта нашла ключ в архиве.', updatedAt: '2026-11-01' }], listNotes: () => [{ id: 'n1', title: 'Идеи', text: 'Перевал закрыт до весны.' }] },
    workspaceService: { root: () => root, cards: ({ q = '' } = {}) => ({ cards: cards.filter(card => !q || card.title.toLowerCase().includes(q.toLowerCase())) }), journal: () => [], undoProposal: id => ({ id, state: 'reverted' }) },
    bookContext: () => context, pluginCall: async (name, args) => ({ content: [{ text: JSON.stringify({ status: 'FAIL', findings: [{ severity: 'FAIL', code: 'appearance_after_death', record: 'assertions:a2', message: 'Live appearance follows recorded death', evidence: { path: 'scene.md', quote: 'Старик открыл дверь' } }] }) }], args }) });
  t.after(() => { tools.close(); rmSync(dir, { recursive: true, force: true }); });
  const chapter = (key, body, extra = {}) => ({ key, kind: 'section', hasHeading: true, title: `Глава ${key}`, label: key, body, baseBody: body, baseTitle: `Глава ${key}`, ...extra });
  if (chapters) copy = { bookId: 'book1', documentId: 'doc1', version: 1, chapters };
  return { tools, context, root, chapter, advance: ms => { clock += ms; }, save: next => tools.manuscriptFiles.save('book1', 'doc1', copy?.version ?? 0, next) };
}

test('word counting ignores punctuation and counts Cyrillic words', () => {
  assert.equal(countWords('— Привет, мир! Это тест-драйв.'), 4);
  assert.equal(countWords('   '), 0);
});

test('chapter history keeps the Google baseline, refines one open version and starts a new one after ten minutes', t => {
  const f = fixture(t);
  f.save([f.chapter('1', 'Правка один.', { baseBody: 'Исходный текст.' })]);
  let versions = f.tools.history(f.context, '1').versions;
  assert.deepEqual(versions.map(v => v.label), ['', 'Из Google']);
  f.advance(60_000); f.save([f.chapter('1', 'Правка два.', { baseBody: 'Исходный текст.' })]);
  versions = f.tools.history(f.context, '1').versions;
  assert.equal(versions.length, 2, 'a save inside the open window refines the same version');
  assert.equal(f.tools.version(f.context, versions[0].id).body, 'Правка два.');
  assert.equal(f.tools.version(f.context, versions[1].id).body, 'Исходный текст.');
  f.advance(11 * 60_000); f.save([f.chapter('1', 'Правка три.', { baseBody: 'Исходный текст.' })]);
  assert.equal(f.tools.history(f.context, '1').versions.length, 3);
  f.save([f.chapter('1', 'Правка три.', { baseBody: 'Исходный текст.' })]);
  assert.equal(f.tools.history(f.context, '1').versions.length, 3, 'unchanged text adds nothing');
  const pinned = f.tools.pin(f.context, { id: versions[0].id, label: 'Перед редактурой' });
  assert.equal(pinned.pinned, true);
  assert.throws(() => f.tools.version({ ...f.context, bookId: 'other' }, versions[0].id), /не найдена/);
});

test('statistics report daily progress against the first total seen that day and keep goals', t => {
  const f = fixture(t);
  f.save([f.chapter('1', 'раз два три')]);
  f.advance(60_000); f.save([f.chapter('1', 'раз два три четыре пять')]);
  let stats = f.tools.stats(f.context);
  assert.equal(stats.totalWords, 5); assert.equal(stats.today, 2); assert.equal(stats.streak, 1);
  f.advance(24 * 3600_000); f.save([f.chapter('1', 'раз два три четыре пять шесть')]);
  stats = f.tools.setGoals(f.context, { targetWords: 1000, dailyGoal: 50 });
  assert.equal(stats.today, 1); assert.equal(stats.streak, 2); assert.equal(stats.targetWords, 1000); assert.equal(stats.dailyGoal, 50);
  assert.throws(() => f.tools.setGoals(f.context, { targetWords: -1 }), /неотрицательным/);
});

test('export builds valid containers with chapter text and formatting', t => {
  const f = fixture(t, {});
  f.save([f.chapter('1', 'Первый абзац с выделением.\n\nВторой <абзац> & точка.', { rich: { v: 1, ranges: [{ start: 15, end: 25, style: { bold: true } }] } })]);
  const epub = f.tools.exportBook(f.context, 'epub'), files = unzip(epub.bytes);
  assert.equal(epub.filename, 'Зимняя тропа.epub');
  assert.equal([...files.keys()][0], 'mimetype'); assert.equal(files.get('mimetype').toString(), 'application/epub+zip');
  assert.match(files.get('OEBPS/chapter-001.xhtml').toString(), /<strong>выделением<\/strong>/);
  assert.match(files.get('OEBPS/chapter-001.xhtml').toString(), /Второй &lt;абзац&gt; &amp; точка\./);
  assert.match(files.get('OEBPS/content.opf').toString(), /<dc:creator>Анна Вересова<\/dc:creator>/);
  const docx = unzip(f.tools.exportBook(f.context, 'docx').bytes);
  assert.match(docx.get('word/document.xml').toString(), /<w:b\/><\/w:rPr><w:t xml:space="preserve">выделением<\/w:t>/);
  const fb2 = f.tools.exportBook(f.context, 'fb2').bytes.toString('utf8');
  assert.match(fb2, /<last-name>Вересова<\/last-name>/); assert.match(fb2, /<strong>выделением<\/strong>/);
  assert.throws(() => f.tools.exportBook(f.context, 'pdf'), /EPUB, DOCX и FB2/);
  assert.equal(paragraphsOf('a\n\n\nb', null).length, 2);
  assert.equal(unzip(zip([{ name: 'x.txt', data: 'hello' }])).get('x.txt').toString(), 'hello');
  assert.throws(() => buildBookFile({ format: 'pdf' }), /Unknown/);
});

test('timeline, entities and continuity findings come from continuity contracts in the series folder', async t => {
  const f = fixture(t, { cards: [{ path: 'people/marta.md', title: 'Марта', type: 'character', excerpt: 'Проводница.', status: 'confirmed' }] });
  const evidence = quote => ({ path: 'scene.md', sha256: sha('x'), quote });
  writeFileSync(join(f.root, 'continuity.json'), JSON.stringify({ version: 1,
    scenes: [{ id: 's2', title: 'Перевал', status: 'confirmed', story_order: 20, narrative_order: 10, evidence: evidence('q2') }, { id: 's1', title: 'Архив', status: 'confirmed', story_order: 10, narrative_order: 20, evidence: evidence('q1') }],
    entities: [{ id: 'old', name: 'Старик', status: 'confirmed', evidence: evidence('Старик жил у перевала') }, { id: 'marta', name: 'Марта', status: 'confirmed', evidence: evidence('Марта') }],
    facts: [{ id: 'key', text: 'Ключ лежит в архиве.', truth: 'true', status: 'confirmed', evidence: evidence('ключ') }],
    assertions: [{ id: 'a1', kind: 'death', scene_id: 's1', entity_id: 'old', status: 'confirmed', evidence: evidence('Старик умер') }, { id: 'a2', kind: 'learn', scene_id: 's2', entity_id: 'marta', fact_id: 'key', status: 'confirmed', evidence: evidence('Марта узнала') }] }));
  writeFileSync(join(f.root, 'other.json'), '{"version":2}');
  const story = f.tools.timeline({});
  assert.deepEqual(story.events.map(event => event.sceneId), ['s1', 's2']);
  assert.equal(story.events[0].items[0].label, 'Смерть'); assert.equal(story.events[1].items[0].fact, 'Ключ лежит в архиве.');
  assert.deepEqual(f.tools.timeline({ axis: 'narrative' }).events.map(event => event.sceneId), ['s2', 's1']);
  assert.deepEqual(f.tools.timeline({ entity: 'marta' }).events.map(event => event.sceneId), ['s2']);
  const names = f.tools.entities().entities;
  const marta = names.find(item => item.name === 'Марта');
  assert.equal(marta.path, 'people/marta.md'); assert.equal(marta.knows[0].fact, 'Ключ лежит в архиве.');
  assert.ok(names.some(item => item.name === 'Старик' && item.type === 'entity'));
  const report = await f.tools.continuity(f.context, { text: 'Утром Старик открыл дверь и вышел на тропу.' });
  assert.equal(report.contracts[0].status, 'FAIL');
  const failure = report.findings.find(item => item.severity === 'fail');
  assert.deepEqual(failure.range, { start: 6, end: 25 });
  assert.ok(report.findings.some(item => item.code === 'mention_after_recorded_death' && item.range.start === 6));
  assert.equal(report.scope, 'listed_records_only');
});

test('project search covers chapters, local documents, notes and knowledge cards', async t => {
  const f = fixture(t, { cards: [{ path: 'places/pass.md', title: 'Перевал', type: 'place', excerpt: 'Седловина.', status: 'confirmed' }] });
  f.save([f.chapter('7', 'К вечеру они вышли на перевал и увидели огни.')]);
  const { results } = f.tools.search(f.context, 'перевал');
  assert.deepEqual(new Set(results.map(row => row.kind)), new Set(['chapter', 'note', 'card']));
  assert.equal(results.find(row => row.kind === 'chapter').offset, 'К вечеру они вышли на перевал'.indexOf('перевал'));
  assert.equal(f.tools.search(f.context, 'ключ').results[0].kind, 'document');
  assert.deepEqual(f.tools.search(f.context, 'я').results, []);
  const routed = await f.tools.handle('GET', '/api/tools/search', {}, new URLSearchParams({ q: 'огни' }));
  assert.equal(routed.data.results.length, 1);
  assert.equal(await f.tools.handle('GET', '/api/other', {}, new URLSearchParams()), null);
  await assert.rejects(f.tools.handle('GET', '/api/tools/nope', {}, new URLSearchParams()), /Route not found/);
  const file = await f.tools.handle('GET', '/api/tools/export', {}, new URLSearchParams({ format: 'fb2' }));
  assert.equal(file.file.mimeType, 'application/x-fictionbook+xml');
});

test('roleplay view lists only author-applied starts and reads the scene through the plugin', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'author-tools-rp-'));
  const proposals = [
    { id: 'p1', tool: 'talewisp_roleplay_start', state: 'applied', title: 'Сцена у перевала', arguments: { session_id: 'pass-1' }, appliedAt: '2026-11-10T10:00:00Z' },
    { id: 'p2', tool: 'talewisp_roleplay_start', state: 'pending', title: 'Не начата', arguments: { session_id: 'draft-2' } },
    { id: 'p3', tool: 'talewisp_card_update', state: 'applied', title: 'Карточка', arguments: {} }
  ];
  const calls = [];
  const tools = createAuthorTools({ dataDir: join(dir, 'data'), manuscriptFiles: { read: () => null, save: () => null, importDocument: () => null, view: value => value }, store: { getSetting: () => null, setSetting: () => {}, listDocuments: () => [], listNotes: () => [] },
    workspaceService: { root: () => dir, cards: () => ({ cards: [] }), journal: () => [], listProposals: () => proposals.map(({ id, tool, state, title }) => ({ id, tool, state, title })), proposal: id => proposals.find(row => row.id === id) },
    bookContext: () => ({ bookId: 'b', documentId: 'd' }),
    pluginCall: async (name, args) => { calls.push([name, args]); return name === 'talewisp_roleplay_status' ? { structuredContent: { session_id: 'pass-1', run_state: 'active', phase: 'hero_action', turn_number: 2, revision: 7, hero_id: 'Марта', formatting_ready: false, branch_id: 'secret-branch' } } : { structuredContent: { phase: 'hero_action', run_state: 'active', scene_design: { twist: 'hidden' }, turns: [{ turn: 1, situation: { text: 'Снег закрыл тропу.' }, hero_action: 'Марта идёт вдоль скалы.', consequence: 'Камень срывается вниз.' }, { turn: 2, situation: { text: 'Впереди огонь.' } }] } }; } });
  // Close the database before removing its folder: Windows refuses to delete an open file.
  t.after(() => { tools.close(); rmSync(dir, { recursive: true, force: true }); });
  const list = (await tools.handle('GET', '/api/tools/roleplay', {}, new URLSearchParams())).data;
  assert.deepEqual(list.sessions.map(row => row.sessionId), ['pass-1']);
  assert.deepEqual(list.sessions[0].status, { runState: 'active', phase: 'hero_action', turn: 2, revision: 7, heroId: 'Марта', formattingReady: false });
  const scene = (await tools.handle('GET', '/api/tools/roleplay/scene', {}, new URLSearchParams({ session: 'pass-1' }))).data;
  assert.deepEqual(scene.turns, [{ turn: 1, situation: 'Снег закрыл тропу.', heroAction: 'Марта идёт вдоль скалы.', consequence: 'Камень срывается вниз.' }, { turn: 2, situation: 'Впереди огонь.', heroAction: '', consequence: '' }]);
  assert.equal(JSON.stringify(scene).includes('hidden'), false, 'only the played turns leave the server');
  await assert.rejects(tools.handle('GET', '/api/tools/roleplay/scene', {}, new URLSearchParams({ session: 'draft-2' })), { status: 404 });
  assert.equal(calls.filter(([name]) => name === 'talewisp_roleplay_packet').length, 1);
});
