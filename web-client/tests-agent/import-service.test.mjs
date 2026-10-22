import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createImportService } from '../import-service.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pythonExecutable = process.env.PYTHON || 'python';

async function fixture(t, options = {}) {
  const base = path.join(projectRoot, '.agent', 'import-service-tests');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = path.join(root, 'app-data');
  const catalogRoot = path.join(root, 'catalog');
  await fs.mkdir(catalogRoot, { recursive: true });
  const service = createImportService({ dataDir, catalogRoot, projectRoot, pythonExecutable, ...options });
  return { root, dataDir, catalogRoot, service };
}

async function createJob(service, source = 'Короткая заметка для теста.') {
  const created = await service.create({ authorPseudonym: 'Тестовый Автор', seriesName: 'Тестовая Серия' });
  await service.upload({ jobId: created.jobId, name: 'notes.md', contentBase64: Buffer.from(source).toString('base64'), sourceKind: 'notes' });
  return created.jobId;
}

test('pseudonym is required before upload and native prepare/status use an isolated vault', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.create({ seriesName: 'Серия' }), /author pseudonym/i);
  const jobId = await createJob(service);
  const savedStatus = await service.status(jobId);
  assert.equal(savedStatus.authorPseudonym, 'Тестовый Автор');
  assert.equal(savedStatus.seriesName, 'Тестовая Серия');
  assert.equal((await service.list()).jobs[0].jobId, jobId);
  const prepared = await service.run({ jobId, action: 'prepare' });
  assert.equal(prepared.status, 'prepared_for_analysis');
  assert.equal(prepared.author_pseudonym, 'Тестовый Автор');
  assert.equal((await service.status(jobId)).status, 'prepared_for_analysis');
  assert.match(prepared.series_path, /^00 Автор\//);
});

test('upload validates base64, bounded supported extensions, source kind, and path-like names', async (t) => {
  const { service } = await fixture(t);
  const { jobId } = await service.create({ authorPseudonym: 'Автор', seriesName: 'Серия' });
  await assert.rejects(() => service.upload({ jobId, name: 'x.txt', contentBase64: '!!!!', sourceKind: 'notes' }), /base64/i);
  await assert.rejects(() => service.upload({ jobId, name: 'x.pdf', contentBase64: Buffer.from('x').toString('base64'), sourceKind: 'book' }), /verified extraction/i);
  await assert.rejects(() => service.upload({ jobId, name: '../x.txt', contentBase64: Buffer.from('x').toString('base64'), sourceKind: 'book' }), /plain filename/i);
  await assert.rejects(() => service.upload({ jobId, name: 'x.txt', contentBase64: Buffer.from('x').toString('base64') }), /sourceKind/i);
  await assert.rejects(() => service.upload({ jobId, name: 'x.txt', contentBase64: 'YQ', sourceKind: 'book' }), /base64/i);
});

test('native verified extraction snapshots are accepted as JSON sources; large source text is read in bounded exact ranges', async (t) => {
  const { service } = await fixture(t);
  const { jobId } = await service.create({ authorPseudonym: 'Автор', seriesName: 'Серия' });
  const text = 'Источник.' + ' абвгдежз'.repeat(150_000);
  const snapshot = { schema: 'talewisp-source-snapshot-v1', metadata: { title: 'Большой источник', source_kind: 'notes' }, provenance: { origin: 'user-upload', extractor: 'verified test snapshot', extraction_status: 'complete', completeness: { text: true, images: true, media: true }, limitations: [] }, sections: [{ title: 'Полный текст', blocks: [{ text }] }], images: [] };
  await service.upload({ jobId, name: 'snapshot.json', contentBase64: Buffer.from(JSON.stringify(snapshot)).toString('base64'), sourceKind: 'notes' });
  const prepared = await service.run({ jobId, action: 'prepare' });
  const chapterPath = prepared.books[0].chapter_paths[0];
  await assert.rejects(() => service.read(jobId, chapterPath), (error) => error.code === 'READ_RANGE_REQUIRED' && error.status === 413);
  const first = await service.read(jobId, chapterPath, { startChar: 0, maxChars: 64000 });
  assert.equal(first.range.start, 0);
  assert.equal(first.range.end, 64000);
  assert.equal(first.eof, false);
  assert.equal(first.complete, false);
  assert.equal(first.text.length, 64000);
  assert.equal(first.originalSha256.length, 64);
  assert.equal(first.chunkSha256.length, 64);
  await assert.rejects(() => service.read(jobId, chapterPath, { startChar: 0, maxChars: 64001 }), /64000/i);
});

test('upload cannot proceed without a job and repeated prepare cannot replace its source session', async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(() => service.upload({ jobId: '../escape', name: 'x.txt', contentBase64: 'eA==', sourceKind: 'notes' }), /job/i);
  const jobId = await createJob(service);
  await service.run({ jobId, action: 'prepare' });
  await assert.rejects(() => service.upload({ jobId, name: 'later.txt', contentBase64: 'eA==', sourceKind: 'notes' }), /closed/i);
  await assert.rejects(() => service.run({ jobId, action: 'prepare' }), /already started/i);
});

test('read only exposes exact source/candidate/analysis references and returns complete content with hash', async (t) => {
  const { service } = await fixture(t);
  const source = 'Первая строка.\nВторая строка.';
  const jobId = await createJob(service, source);
  const prepared = await service.run({ jobId, action: 'prepare' });
  const corpusPath = prepared.books[0].corpus_path;
  const corpus = await service.read(jobId, corpusPath);
  assert.equal(corpus.truncated, false);
  assert.equal(JSON.parse(corpus.text).chapters[0].blocks[0].text, source);
  assert.equal(corpus.sha256.length, 64);
  const inventory = await service.inventory(jobId);
  assert.ok(inventory.files.some((file) => file.path === corpusPath && file.sha256 === corpus.sha256 && file.complete));
  assert.ok(inventory.files.every((file) => !path.isAbsolute(file.path)));
  await assert.rejects(() => service.read(jobId, 'job.json'), /allowlist/i);
  await assert.rejects(() => service.read(jobId, '../outside.txt'), /relative path/i);
});

test('a native PASS machine-check receipt is readable through its exact checked path', async (t) => {
  const { service, dataDir } = await fixture(t);
  const jobId = await createJob(service, 'Evidence for the native check.');
  const prepared = await service.run({ jobId, action: 'prepare' });
  const corpus = JSON.parse((await service.read(jobId, prepared.books[0].corpus_path)).text);
  const block = corpus.chapters[0].blocks[0];
  const sharedLayers = Object.fromEntries(
    ['series_passport', 'world', 'rules', 'entities', 'glossary', 'style', 'chronology', 'knowledge', 'uncertainties']
      .map((key) => [key, { status: 'unknown', summary: 'Не установлено источником.', evidence: [] }])
  );
  sharedLayers.uncertainties.summary = 'Неизвестны автор записки и владелец шарфа.';
  sharedLayers.uncertainties.evidence = [{ block_id: block.id, quote: block.text }];
  await service.saveAnalysis(jobId, {
    read_chapters: [{ book_id: prepared.books[0].book_id, chapter_id: corpus.chapters[0].id, block_ids: [block.id], images_read: [], images_uncertain: [] }],
    image_transcripts: [], scenes: [], events: [], entities: [], rules: [], threads: [], knowledge: [], style: [],
    contradictions: ['Пустой ящик затем содержит шарф.'], open_questions: ['Кто оставил записку?'], shared_layers: sharedLayers
  });
  const finalized = await service.run({ jobId, action: 'finalize' });
  assert.equal(finalized.status, 'candidate_ready_for_review');
  const checked = await service.run({ jobId, action: 'check' });
  assert.equal(checked.status, 'PASS');
  assert.equal(checked.machine_checks_path, `.talewisp/imports/${prepared.session_id}/machine-checks.json`);
  const jobPath = path.join(dataDir, 'imports', jobId, 'job.json');
  const persisted = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  for (const key of ['books', 'source_path', 'corpus_index_path']) delete persisted.native[key];
  await fs.writeFile(jobPath, JSON.stringify(persisted));
  const restoredStatus = await service.status(jobId);
  assert.ok(restoredStatus.source_path);
  const indexed = await service.read(jobId, restoredStatus.corpus_index_path);
  assert.equal(JSON.parse(indexed.text).series, 'Тестовая Серия');
  const restoredCorpus = await service.read(jobId, restoredStatus.books[0].corpus_path);
  assert.equal(JSON.parse(restoredCorpus.text).book_id, restoredStatus.books[0].book_id);
  const restoredChapter = await service.read(jobId, restoredStatus.books[0].chapter_paths[0]);
  assert.match(restoredChapter.text, /Evidence for the native check\./);
  const sourceInventory = await service.inventory(jobId);
  assert.ok(sourceInventory.files.some((file) => file.path === restoredStatus.corpus_index_path));
  assert.ok(sourceInventory.files.some((file) => file.path === restoredStatus.books[0].chapter_paths[0]));
  const uncertaintyPath = finalized.candidate_paths['00 Автор/Тестовый Автор/Тестовая Серия/99 Проверка/Неопределённости и противоречия.md'];
  const uncertaintyReport = (await service.read(jobId, uncertaintyPath)).text;
  assert.match(uncertaintyReport, /Неизвестны автор записки и владелец шарфа\./);
  assert.match(uncertaintyReport, /Evidence for the native check\./);
  assert.match(uncertaintyReport, /Пустой ящик затем содержит шарф\./);
  assert.match(uncertaintyReport, /Кто оставил записку\?/);
  assert.doesNotMatch(uncertaintyReport, /Явные противоречия и открытые вопросы не указаны\./);
  const repeatedFinalize = await service.run({ jobId, action: 'finalize' });
  assert.equal(repeatedFinalize.status, 'candidate_ready_for_review');
  await assert.rejects(() => service.read(jobId, checked.machine_checks_path), /allowlist/i);
  const checkedAgain = await service.run({ jobId, action: 'check' });
  assert.equal(checkedAgain.status, 'PASS');
  const receipt = await service.read(jobId, checkedAgain.machine_checks_path);
  assert.deepEqual(JSON.parse(receipt.text), {
    status: 'PASS', session_id: prepared.session_id, candidate_sha256: finalized.candidate_sha256,
    issues: { baseline_drift: [], unexpected_new_paths: [], candidate_errors: [], source_errors: [] }
  });
  const inventory = await service.inventory(jobId);
  assert.ok(inventory.files.some((file) => file.path === checkedAgain.machine_checks_path && file.sha256 === receipt.sha256));
});

test('analysis and acceptance stay behind native semantic, check, and actual-review gates', async (t) => {
  const { service } = await fixture(t);
  const jobId = await createJob(service);
  await service.run({ jobId, action: 'prepare' });
  await assert.rejects(() => service.run({ jobId, action: 'finalize' }), /analysis/i);
  await assert.rejects(() => service.saveReview(jobId, {}), /candidate/i);
  await assert.rejects(() => service.run({ jobId, action: 'accept' }), /review/i);
});

test('tampered upload is caught by the authoritative native check after a valid staged candidate', async (t) => {
  const { service, dataDir } = await fixture(t);
  const jobId = await createJob(service, 'Known literal evidence.');
  const prepared = await service.run({ jobId, action: 'prepare' });
  const corpus = JSON.parse((await service.read(jobId, prepared.books[0].corpus_path)).text);
  const block = corpus.chapters[0].blocks[0];
  const evidence = [{ block_id: block.id, quote: block.text }];
  const analysis = {
    read_chapters: [{ book_id: prepared.books[0].book_id, chapter_id: corpus.chapters[0].id, block_ids: [block.id], images_read: [], images_uncertain: [] }],
    image_transcripts: [], scenes: [], events: [], entities: [], rules: [], threads: [], knowledge: [], style: [],
    shared_layers: Object.fromEntries(['series_passport', 'world', 'rules', 'entities', 'glossary', 'style', 'chronology', 'knowledge', 'uncertainties'].map((key) => [key, { status: 'unknown', summary: 'Не установлено источником.', evidence: [] }]))
  };
  await service.saveAnalysis(jobId, analysis);
  const finalized = await service.run({ jobId, action: 'finalize' });
  assert.equal(finalized.status, 'candidate_ready_for_review');
  const jobPath = path.join(dataDir, 'imports', jobId, 'job.json');
  const job = JSON.parse(await fs.readFile(jobPath, 'utf8'));
  await fs.writeFile(job.uploads[0].path, 'tampered after prepare');
  const checked = await service.run({ jobId, action: 'check' });
  assert.equal(checked.status, 'FAIL');
  const candidate = Object.values(finalized.candidate_paths)[0];
  const content = await service.read(jobId, candidate);
  assert.ok(content.text.length > 0);
  await assert.rejects(() => service.saveReview(jobId, { status: 'PASS', review_type: 'independent', session_id: prepared.session_id, candidate_sha256: finalized.candidate_sha256, coverage: 'Фиктивно', findings: [], receiptId: 'not-verified' }), /check/i);
  await assert.rejects(() => service.publish({ jobId, confirmed: true }), /accepted job/i);
  assert.equal(evidence[0].quote, 'Known literal evidence.');
});

test('even a valid-looking review is accepted only with a caller-verified independent receipt; publish preserves conflicts', async (t) => {
  const receipt = { ok: true };
  const { service, catalogRoot } = await fixture(t, { reviewReceiptVerifier: async ({ review }) => review.receipt === receipt });
  const jobId = await createJob(service, 'Evidence stays literal.');
  const prepared = await service.run({ jobId, action: 'prepare' });
  const corpus = JSON.parse((await service.read(jobId, prepared.books[0].corpus_path)).text);
  const block = corpus.chapters[0].blocks[0];
  const analysis = {
    read_chapters: [{ book_id: prepared.books[0].book_id, chapter_id: corpus.chapters[0].id, block_ids: [block.id], images_read: [], images_uncertain: [] }],
    image_transcripts: [], scenes: [], events: [], entities: [], rules: [], threads: [], knowledge: [], style: [],
    shared_layers: Object.fromEntries(['series_passport', 'world', 'rules', 'entities', 'glossary', 'style', 'chronology', 'knowledge', 'uncertainties'].map((key) => [key, { status: 'unknown', summary: 'Не установлено источником.', evidence: [] }]))
  };
  await service.saveAnalysis(jobId, analysis);
  const finalized = await service.run({ jobId, action: 'finalize' });
  assert.equal((await service.run({ jobId, action: 'check' })).status, 'PASS');
  const review = { status: 'PASS', review_type: 'independent', session_id: prepared.session_id, candidate_sha256: finalized.candidate_sha256, coverage: 'Проверены все кандидаты и исходный корпус.', findings: [], receiptId: 'review-receipt-1', receipt };
  await service.saveReview(jobId, review);
  const accepted = await service.run({ jobId, action: 'accept' });
  assert.equal(accepted.status, 'complete');
  assert.ok(accepted.proposal.files.length > 0);
  assert.ok(accepted.proposal.files.every((file) => file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256)));
  const acceptedStatus = await service.status(jobId);
  assert.match((await service.read(jobId, acceptedStatus.books[0].corpus_path)).text, /Evidence stays literal\./);
  assert.match((await service.read(jobId, acceptedStatus.books[0].chapter_paths[0])).text, /Evidence stays literal\./);
  assert.ok((await service.inventory(jobId)).files.some((file) => file.path === acceptedStatus.corpus_index_path));
  await assert.rejects(() => service.read(jobId, Object.values(finalized.candidate_paths)[0]), /allowlist/i);
  const outcomes = await Promise.allSettled([service.publish({ jobId, confirmed: true }), service.publish({ jobId, confirmed: true })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const published = outcomes.find((outcome) => outcome.status === 'fulfilled').value;
  assert.equal(published.status, 'published');
  const output = path.join(catalogRoot, ...published.catalogRelativePath.split('/'));
  assert.ok((await fs.readdir(output)).length > 0);
  await assert.rejects(() => service.publish({ jobId, confirmed: true }), /already exists/i);
});

test('existing author passport and series remain untouched; symlink destinations are rejected', async (t) => {
  const { service, catalogRoot } = await fixture(t, { reviewReceiptVerifier: async ({ review }) => review.token === true });
  const authorDir = path.join(catalogRoot, '00 Автор', 'Тестовый Автор');
  await fs.mkdir(authorDir, { recursive: true });
  const passport = path.join(authorDir, 'Автор.md');
  await fs.writeFile(passport, 'preserve exactly');
  const jobId = await createJob(service);
  const prepared = await service.run({ jobId, action: 'prepare' });
  const corpus = JSON.parse((await service.read(jobId, prepared.books[0].corpus_path)).text);
  const block = corpus.chapters[0].blocks[0];
  await service.saveAnalysis(jobId, {
    read_chapters: [{ book_id: prepared.books[0].book_id, chapter_id: corpus.chapters[0].id, block_ids: [block.id], images_read: [], images_uncertain: [] }], image_transcripts: [], scenes: [], events: [], entities: [], rules: [], threads: [], knowledge: [], style: [],
    shared_layers: Object.fromEntries(['series_passport', 'world', 'rules', 'entities', 'glossary', 'style', 'chronology', 'knowledge', 'uncertainties'].map((key) => [key, { status: 'unknown', summary: 'Не установлено.', evidence: [] }]))
  });
  const finalized = await service.run({ jobId, action: 'finalize' });
  await service.run({ jobId, action: 'check' });
  await service.saveReview(jobId, { status: 'PASS', review_type: 'independent', session_id: prepared.session_id, candidate_sha256: finalized.candidate_sha256, coverage: 'Все исходники и кандидаты.', findings: [], receiptId: 'review-receipt-2', token: true });
  await service.run({ jobId, action: 'accept' });
  const output = await service.publish({ jobId, confirmed: true });
  assert.equal(await fs.readFile(passport, 'utf8'), 'preserve exactly');
  assert.ok((await fs.stat(path.join(authorDir, 'Тестовая Серия'))).isDirectory());
  assert.match(output.catalogRelativePath, /^00 Автор\/Тестовый Автор\/Тестовая Серия$/);

  const second = await createJob(service, 'another source');
  const prep2 = await service.run({ jobId: second, action: 'prepare' });
  const corpus2 = JSON.parse((await service.read(second, prep2.books[0].corpus_path)).text);
  const b = corpus2.chapters[0].blocks[0];
  await service.saveAnalysis(second, { read_chapters: [{ book_id: prep2.books[0].book_id, chapter_id: corpus2.chapters[0].id, block_ids: [b.id], images_read: [], images_uncertain: [] }], image_transcripts: [], scenes: [], events: [], entities: [], rules: [], threads: [], knowledge: [], style: [], shared_layers: Object.fromEntries(['series_passport', 'world', 'rules', 'entities', 'glossary', 'style', 'chronology', 'knowledge', 'uncertainties'].map((key) => [key, { status: 'unknown', summary: 'Не установлено.', evidence: [] }])) });
  const fin2 = await service.run({ jobId: second, action: 'finalize' });
  await service.run({ jobId: second, action: 'check' });
  await service.saveReview(second, { status: 'PASS', review_type: 'independent', session_id: prep2.session_id, candidate_sha256: fin2.candidate_sha256, coverage: 'Все исходники и кандидаты.', findings: [], receiptId: 'review-receipt-3', token: true });
  await service.run({ jobId: second, action: 'accept' });
  const link = path.join(authorDir, 'Тестовая Серия 2');
  try {
    await fs.symlink(path.join(authorDir, 'Тестовая Серия'), link, 'junction');
    await assert.rejects(() => service.publish({ jobId: second, confirmed: true }), /already exists|symbolic|unsafe/i);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') t.diagnostic('Symlink creation unavailable on this host; destination conflict behavior was covered by existing-series test.');
    else throw error;
  }
});

test('parallel uploads serialize size and metadata updates; native timeout holds the job lock until close', async (t) => {
  const { service } = await fixture(t);
  const { jobId } = await service.create({ authorPseudonym: 'Автор', seriesName: 'Серия' });
  const bytes = Buffer.alloc(5 * 1024 * 1024, 65).toString('base64');
  const uploads = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => service.upload({ jobId, name: `source-${index}.txt`, contentBase64: bytes, sourceKind: 'notes' })));
  assert.equal(uploads.filter((item) => item.status === 'fulfilled').length, 4, JSON.stringify(uploads.map((item) => item.status === 'rejected' ? item.reason.message : 'ok')));
  assert.equal(uploads.filter((item) => item.status === 'rejected').length, 1);
  const publicStatus = await service.status(jobId);
  assert.equal(publicStatus.fileCount, 4);
  assert.equal(publicStatus.totalBytes, 20 * 1024 * 1024);

  let closeAt = 0;
  let killed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = { end() {} };
    child.kill = () => {
      if (!killed) {
        killed = true;
        child.stderr.write('private local path must not escape');
        closeAt = Date.now() + 90;
        setTimeout(() => { child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGTERM'); }, 90);
      }
      return true;
    };
    return child;
  };
  const timed = await fixture(t, { spawnProcess, nativeTimeoutMs: 10, nativeKillGraceMs: 500 });
  const timedJobId = await createJob(timed.service);
  let uploadFinished = false;
  const runResult = timed.service.run({ jobId: timedJobId, action: 'prepare' }).then(() => null, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const queuedUpload = timed.service.upload({ jobId: timedJobId, name: 'after.txt', contentBase64: 'YQ==', sourceKind: 'notes' }).then((value) => { uploadFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(uploadFinished, false, 'same-job mutation must remain queued while the native child is alive');
  const runError = await runResult;
  assert.equal(runError.code, 'CLI_TIMEOUT');
  assert.equal(runError.status, 504);
  assert.equal(runError.message.includes('private local path'), false);
  await queuedUpload;
  assert.ok(Date.now() >= closeAt);
});
