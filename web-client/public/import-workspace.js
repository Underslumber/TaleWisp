export const IMPORT_LIMITS = Object.freeze({ files: 12, fileBytes: 5 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
export const IMPORT_EXTENSIONS = Object.freeze(['.fb2', '.txt', '.md', '.markdown', '.html', '.htm', '.docx', '.epub', '.json']);

export function importAgentCanRun(status, { busy = false, agentRunning = false, fileCount = 0 } = {}) {
  return !busy && !agentRunning && Number.isInteger(fileCount) && fileCount > 0 &&
    !['complete', 'published', 'awaiting_publish_confirmation'].includes(status);
}

const extensionOf = name => {
  const value = typeof name === 'string' ? name.toLowerCase() : '';
  const dot = value.lastIndexOf('.');
  return dot >= 0 ? value.slice(dot) : '';
};

export function validateImportSelection(authorPseudonym, seriesName, files, existingFileCount = 0, existingBytes = 0) {
  const selected = Array.from(files || []);
  const errors = [];
  if (typeof authorPseudonym !== 'string' || !authorPseudonym.trim()) errors.push('Укажите авторский псевдоним.');
  if (typeof seriesName !== 'string' || !seriesName.trim()) errors.push('Укажите название серии.');
  if (!selected.length) errors.push('Выберите хотя бы один исходный файл.');
  if (selected.length + existingFileCount > IMPORT_LIMITS.files) errors.push(`В одной базе может быть не более ${IMPORT_LIMITS.files} файлов.`);
  let totalBytes = existingBytes;
  const names = new Set();
  for (const file of selected) {
    const name = typeof file?.name === 'string' ? file.name : '';
    const extension = extensionOf(name);
    const key = name.toLocaleLowerCase('en-US');
    if (!name || !IMPORT_EXTENSIONS.includes(extension)) errors.push(`Формат файла «${name || 'без названия'}» не поддерживается.`);
    if (names.has(key)) errors.push(`Файл «${name}» выбран дважды.`);
    names.add(key);
    if (!Number.isFinite(file?.size) || file.size < 0) errors.push(`Не удалось определить размер файла «${name}».`);
    else if (file.size > IMPORT_LIMITS.fileBytes) errors.push(`Файл «${name}» превышает 5 МиБ.`);
    else totalBytes += file.size;
  }
  if (totalBytes > IMPORT_LIMITS.totalBytes) errors.push('Общий размер источников превышает 20 МиБ.');
  return { valid: errors.length === 0, errors, files: selected, totalBytes, verifiedSnapshots: selected.filter(file => extensionOf(file.name) === '.json').length };
}

export function arrayBufferToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

export function readFileBase64(file, FileReaderImpl = globalThis.FileReader) {
  return new Promise((resolve, reject) => {
    if (typeof FileReaderImpl !== 'function') { reject(new Error('Чтение файла недоступно в этом браузере.')); return; }
    const reader = new FileReaderImpl();
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}».`));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) { reject(new Error(`Не удалось прочитать файл «${file.name}».`)); return; }
      try { resolve(arrayBufferToBase64(reader.result)); } catch (error) { reject(error); }
    };
    reader.readAsArrayBuffer(file);
  });
}

export function importStatusLabel(value) {
  const known = {
    awaiting_sources: 'Ожидает исходные файлы',
    awaiting_prepare: 'Источники загружены, ожидают подготовки',
    needs_author: 'Нужен авторский псевдоним',
    needs_series: 'Нужно название серии',
    needs_prepare: 'Нужно подготовить источники',
    prepared_for_analysis: 'Источники подготовлены для анализа',
    candidate_ready_for_review: 'Кандидат ожидает независимую проверку',
    PASS: 'Проверки пройдены',
    checked: 'Проверки выполнены',
    awaiting_publish_confirmation: 'Ожидает подтверждения публикации',
    complete: 'Все этапы завершены',
    published: 'Опубликовано',
    failed: 'Ошибка',
    blocked: 'Ожидает выполнения условий',
    interrupted: 'Прервано до завершения',
    incomplete: 'Не завершено'
  };
  return known[value] || (typeof value === 'string' && value.startsWith('needs_') ? 'Требуется дополнительный шаг' : 'Состояние обновлено');
}

export function formatImportBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КиБ`;
  return `${(value / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} МиБ`;
}

const el = (doc, tag, className, value) => {
  const item = doc.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
};

function manifestView(doc, parent, proposal, { api, ask, notify, jobId, onPublished, refresh, published }) {
  if (!proposal || proposal.status !== 'awaiting_publish_confirmation' || !Array.isArray(proposal.files)) return;
  const section = el(doc, 'section', 'import-manifest');
  section.append(el(doc, 'h3', '', 'Манифест публикации'));
  section.append(el(doc, 'p', 'import-explanation', `Будут записаны файлы серии в каталоге ${proposal.catalogRelativePath || 'каталога выбранного автора'}.`));
  const list = el(doc, 'ul', 'import-manifest-list');
  proposal.files.forEach(file => {
    const row = el(doc, 'li', '');
    row.append(el(doc, 'strong', '', file.relativePath || 'Файл без пути'));
    row.append(el(doc, 'span', '', `${formatImportBytes(file.bytes)} · SHA-256 ${file.sha256 || 'не передан'}`));
    list.append(row);
  });
  section.append(list);
  section.append(el(doc, 'p', 'import-hash', `Хеш манифеста: ${proposal.manifestSha256 || 'не передан'}`));
  const concrete = !!proposal.manifestSha256 && typeof proposal.catalogRelativePath === 'string' && proposal.catalogRelativePath.length > 0 && proposal.files.length > 0 && proposal.files.every(file => typeof file.relativePath === 'string' && Number.isInteger(file.bytes) && typeof file.sha256 === 'string' && file.sha256.length > 0);
  if (!concrete) {
    section.append(el(doc, 'p', 'import-error', 'Публикация заблокирована: сервер не передал полный манифест с путями, размерами и хешами каждого файла.'));
    parent.append(section);
    return;
  }
  if (published) {
    section.append(el(doc, 'p', 'import-published', 'Этот манифест уже опубликован.'));
    parent.append(section);
    return;
  }
  const publish = el(doc, 'button', 'button button-primary', 'Опубликовать подтверждённую базу');
  publish.type = 'button';
  publish.addEventListener('click', async () => {
    const copy = `Будут опубликованы ${proposal.files.length} файлов в ${proposal.catalogRelativePath}. Манифест SHA-256: ${proposal.manifestSha256}. Сверьте список файлов, размеры и хеши выше.`;
    if (await ask('Подтвердите публикацию', copy, 'Опубликовать') !== 'confirm') return;
    publish.disabled = true;
    try {
      const result = await api(`/api/imports/${encodeURIComponent(jobId)}/publish`, { method: 'POST', body: { confirmed: true } });
      notify('Публикация завершена. Обновляю каталог авторов и серий.');
      await onPublished?.(result);
      await refresh();
    } catch (error) { notify(error.message, true); publish.disabled = false; }
  });
  section.append(publish);
  parent.append(section);
}

export function createImportWorkspace({ document: doc = globalThis.document, api, notify = () => {}, ask = async () => 'cancel', getModel = () => '', onPublished = async () => {} } = {}) {
  const root = el(doc, 'section', 'import-workspace');
  root.setAttribute('aria-labelledby', 'import-heading');
  const header = el(doc, 'div', 'special-heading');
  const headingCopy = el(doc, 'div');
  headingCopy.append(el(doc, 'div', 'eyebrow', 'ИМПОРТ ИСТОЧНИКОВ'));
  const title = el(doc, 'h1', '', 'Создать базу серии'); title.id = 'import-heading'; headingCopy.append(title);
  headingCopy.append(el(doc, 'p', '', 'Источники сначала разбираются в отдельной задаче. В базу автора они попадут только после завершения проверок и подтверждения манифеста.'));
  header.append(headingCopy); root.append(header);
  const form = el(doc, 'form', 'import-form');
  const pseudonymLabel = el(doc, 'label', 'import-field', 'Авторский псевдоним');
  const pseudonym = el(doc, 'input'); pseudonym.name = 'authorPseudonym'; pseudonym.required = true; pseudonym.maxLength = 120; pseudonym.autocomplete = 'off'; pseudonymLabel.append(pseudonym);
  const seriesLabel = el(doc, 'label', 'import-field', 'Название серии');
  const series = el(doc, 'input'); series.name = 'seriesName'; series.required = true; series.maxLength = 180; series.autocomplete = 'off'; seriesLabel.append(series);
  const filesLabel = el(doc, 'label', 'import-field', 'Книги и подтверждённые источники');
  const fileInput = el(doc, 'input'); fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = IMPORT_EXTENSIONS.join(','); fileInput.setAttribute('aria-describedby', 'import-file-help'); filesLabel.append(fileInput);
  const fileHelp = el(doc, 'p', 'import-help', 'До 12 файлов, до 5 МиБ на файл и 20 МиБ суммарно. Поддерживаются FB2, TXT, Markdown, HTML, DOCX, EPUB; JSON — только проверенный снимок TaleWisp schema v1, его проверит нативный импортёр. Содержимое читается только после нажатия кнопки загрузки.'); fileHelp.id = 'import-file-help';
  const fileNames = el(doc, 'ul', 'import-file-list');
  fileInput.addEventListener('change', () => {
    fileNames.replaceChildren();
    Array.from(fileInput.files || []).forEach(file => { const row = el(doc, 'li', '', `${file.name} · ${formatImportBytes(file.size)}`); fileNames.append(row); });
  });
  const upload = el(doc, 'button', 'button button-primary', 'Загрузить выбранные файлы'); upload.type = 'button';
  const newTask = el(doc, 'button', 'button button-quiet', 'Новая задача импорта'); newTask.type = 'button'; newTask.hidden = true;
  const runAgent = el(doc, 'button', 'button button-quiet', 'Создать базу с агентом'); runAgent.type = 'button'; runAgent.disabled = true;
  const formStatus = el(doc, 'div', 'import-inline-status'); formStatus.setAttribute('role', 'status'); formStatus.setAttribute('aria-live', 'polite');
  form.append(pseudonymLabel, seriesLabel, filesLabel, fileHelp, fileNames, upload, formStatus, runAgent, newTask); root.append(form);
  const known = el(doc, 'details', 'import-known-jobs');
  const knownSummary = el(doc, 'summary', '', 'Предыдущие задачи импорта'); known.append(knownSummary);
  const knownList = el(doc, 'div', 'import-known-list'); known.append(knownList); root.append(known);
  const current = el(doc, 'section', 'import-current'); current.setAttribute('aria-live', 'polite'); root.append(current);
  const refreshButton = el(doc, 'button', 'button button-quiet', 'Обновить состояние'); refreshButton.type = 'button';
  const refreshJobs = el(doc, 'button', 'button button-quiet', 'Обновить список задач'); refreshJobs.type = 'button';
  let activeJob = null, activeStatus = null, uploadedNames = new Set(), busy = false, agentRequested = false;

  function displayStage(status) {
    if (!status) return 'Задача ещё не создана';
    if (status.published) return importStatusLabel('published');
    return importStatusLabel(status.stage || status.status || status.phase);
  }
  function renderCurrent() {
    current.replaceChildren();
    if (!activeJob) { runAgent.disabled = true; return; }
    const heading = el(doc, 'h2', '', `Задача ${activeJob.jobId || ''}`);
    current.append(heading, el(doc, 'p', 'import-stage', displayStage(activeStatus)));
    if (activeStatus?.error) current.append(el(doc, 'p', 'import-error', activeStatus.error));
    if (activeStatus?.question) current.append(el(doc, 'p', 'import-explanation', activeStatus.question));
    const blockers = Array.isArray(activeStatus?.blockers) ? activeStatus.blockers : Array.isArray(activeStatus?.needs) ? activeStatus.needs : [];
    if (blockers.length) {
      const details = el(doc, 'details', 'import-technical-details'); details.append(el(doc, 'summary', '', 'Что требуется для продолжения'));
      const list = el(doc, 'ul'); blockers.forEach(item => list.append(el(doc, 'li', '', typeof item === 'string' ? item : item?.title || item?.label || item?.id || 'Условие'))); details.append(list); current.append(details);
    }
    current.append(refreshButton);
    const proposal = activeStatus?.proposal || activeJob.proposal;
    manifestView(doc, current, proposal, { api, ask, notify, jobId: activeJob.jobId, onPublished, refresh: loadCurrentStatus, published: !!activeStatus?.published });
    const count = activeStatus?.fileCount ?? activeStatus?.uploads?.length ?? activeJob.fileCount ?? uploadedNames.size;
    runAgent.disabled = !importAgentCanRun(activeStatus?.status, { busy, agentRunning: agentRequested, fileCount: count });
    newTask.hidden = !activeJob;
    pseudonym.readOnly = !!activeJob;
    series.readOnly = !!activeJob;
  }
  async function loadCurrentStatus() {
    if (!activeJob?.jobId) return;
    try {
      const [job, agent] = await Promise.all([api(`/api/imports/${encodeURIComponent(activeJob.jobId)}`), api('/api/agent/status')]);
      activeStatus = job; agentRequested = agent.running === true; renderCurrent();
    }
    catch (error) { formStatus.textContent = `Не удалось обновить состояние задачи: ${error.message}`; }
  }
  async function loadKnownJobs() {
    knownList.replaceChildren(el(doc, 'p', 'subtle-empty', 'Загружаю сохранённые задачи…'));
    try {
      const response = await api('/api/imports');
      const jobs = Array.isArray(response.jobs) ? response.jobs : [];
      knownList.replaceChildren();
      if (!jobs.length) { knownList.append(el(doc, 'p', 'subtle-empty', 'Предыдущих задач пока нет.')); return; }
      jobs.forEach(job => {
        const button = el(doc, 'button', 'import-known-job'); button.type = 'button';
        button.append(el(doc, 'strong', '', `${job.authorPseudonym || 'Автор'} · ${job.seriesName || 'Серия'}`), el(doc, 'span', '', importStatusLabel(job.status)));
        button.addEventListener('click', async () => {
          activeJob = job; agentRequested = true; uploadedNames = new Set();
          if (job.authorPseudonym) pseudonym.value = job.authorPseudonym;
          if (job.seriesName) series.value = job.seriesName;
          await loadCurrentStatus();
        });
        knownList.append(button);
      });
    } catch (error) { knownList.replaceChildren(el(doc, 'p', 'import-error', `Не удалось загрузить список задач: ${error.message}`)); }
  }
  upload.addEventListener('click', async () => {
    const selectedFiles = Array.from(fileInput.files || []);
    const alreadyUploaded = new Set(uploadedNames);
    const pendingFiles = activeJob ? selectedFiles.filter(file => !alreadyUploaded.has(file.name.toLocaleLowerCase('en-US'))) : selectedFiles;
    const validation = validateImportSelection(pseudonym.value, series.value, pendingFiles, activeJob ? (activeStatus?.fileCount ?? uploadedNames.size) : 0, activeJob ? (activeStatus?.totalBytes ?? 0) : 0);
    if (!validation.valid) { formStatus.textContent = validation.errors.join(' '); notify(validation.errors[0], true); return; }
    if (busy) return;
    busy = true; upload.disabled = true; runAgent.disabled = true;
    try {
      if (!activeJob?.jobId || activeStatus?.status === 'published') {
        activeJob = await api('/api/imports', { method: 'POST', body: { authorPseudonym: pseudonym.value.trim(), seriesName: series.value.trim() } });
        activeStatus = activeJob; uploadedNames = new Set(); agentRequested = false;
        pseudonym.readOnly = true; series.readOnly = true; newTask.hidden = false;
      }
      const pending = selectedFiles.filter(file => !uploadedNames.has(file.name.toLocaleLowerCase('en-US')));
      if (!pending.length) throw new Error('Все выбранные файлы уже загружены в эту задачу.');
      formStatus.textContent = 'Проверены псевдоним, название и ограничения. Начинаю читать файлы после вашего явного нажатия.';
      for (let index = 0; index < pending.length; index++) {
        const file = pending[index];
        const contentBase64 = await readFileBase64(file);
        await api(`/api/imports/${encodeURIComponent(activeJob.jobId)}/sources`, { method: 'POST', body: { name: file.name, contentBase64, sourceKind: 'book' } });
        uploadedNames.add(file.name.toLocaleLowerCase('en-US'));
        formStatus.textContent = `Загружено файлов: ${uploadedNames.size}. Последний файл: ${file.name}.`;
        await loadCurrentStatus();
      }
      await loadCurrentStatus(); await loadKnownJobs();
      runAgent.disabled = false;
      notify('Источники загружены в отдельную задачу импорта.');
    } catch (error) {
      formStatus.textContent = `Загрузка остановилась: ${error.message}`;
      await loadCurrentStatus();
      notify(error.message, true);
    } finally { busy = false; upload.disabled = false; renderCurrent(); }
  });
  runAgent.addEventListener('click', async () => {
    if (!activeJob?.jobId || busy) return;
    if (!pseudonym.value.trim() || !series.value.trim()) { notify('Сначала укажите авторский псевдоним и название серии.', true); return; }
    const fileCount = activeStatus?.fileCount ?? activeStatus?.uploads?.length ?? activeJob.fileCount ?? uploadedNames.size;
    if (!fileCount) { notify('Сначала явно загрузите исходные файлы.', true); return; }
    const mode = 'series_base';
    const text = `Создай базу серии по этим книгам. Авторский псевдоним: ${pseudonym.value.trim()}. Название серии: ${series.value.trim()}. Загружено файлов: ${fileCount}. Работай только с отдельной задачей импорта ${activeJob.jobId}; не используй активный черновик или другие серии.`;
    busy = true; runAgent.disabled = true; formStatus.textContent = 'Передаю выбранному агенту только задачу импорта и её файлы.';
    try {
      await api('/api/agent/message', { method: 'POST', body: { text, mode, importJobId: activeJob.jobId, authorPseudonym: pseudonym.value.trim(), seriesName: series.value.trim(), fileCount, model: getModel() || undefined } });
      agentRequested = true;
      notify('Задача создания базы передана агенту. Состояние и этапы можно обновлять здесь.');
      await loadCurrentStatus(); await loadKnownJobs();
    } catch (error) { formStatus.textContent = `Задача не запущена: ${error.message}`; notify(error.message, true); }
    finally { busy = false; renderCurrent(); }
  });
  newTask.addEventListener('click', () => {
    activeJob = null; activeStatus = null; uploadedNames = new Set(); agentRequested = false;
    pseudonym.readOnly = false; series.readOnly = false; formStatus.textContent = 'Готово к созданию отдельной задачи. Выбранные файлы сохранены в форме.'; renderCurrent();
  });
  refreshButton.addEventListener('click', loadCurrentStatus);
  refreshJobs.addEventListener('click', loadKnownJobs);
  known.append(refreshJobs);
  void loadKnownJobs();
  return root;
}
