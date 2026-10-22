// «Настройки проекта»: tiles of authors, series, books and companion files, plus the archive of hidden links.
// Everything is stored by the server (/api/project…); this module only renders and submits explicit changes.

export const PROJECT_SECTIONS = [
  ['books', 'Книги'], ['attachments', 'Связанные файлы'], ['series', 'Серии'], ['authors', 'Авторы'], ['archive', 'Архив связанных файлов'],
];

const KIND_LABELS = { 'google-doc': 'Google Docs', 'vault-book': 'Исходные материалы из хранилища', 'vault-file': 'Файл базы серии' };
export const attachmentKindLabel = kind => KIND_LABELS[kind] || 'Связанный файл';
const ORIGIN_LABELS = { vault: 'из хранилища', logical: 'создано в TaleWisp' };
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return n + ' ' + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many); };

// Joins the flat server view into tiles with their current links and readable trails.
export function projectModel(view) {
  const authors = new Map((view?.authors ?? []).map(row => [row.id, row]));
  const series = new Map((view?.series ?? []).map(row => [row.id, row]));
  const books = new Map((view?.books ?? []).map(row => [row.id, row]));
  const bookTrail = book => { const s = series.get(book?.seriesId), a = s && authors.get(s.authorId); return [a?.name, s?.name, book?.name].filter(Boolean); };
  const attachmentTile = item => { const book = books.get(item.bookId); return { ...item, kindLabel: attachmentKindLabel(item.kind), trail: book ? bookTrail(book) : ['Книга не найдена'], seriesId: book?.seriesId ?? item.seriesId ?? null }; };
  return {
    revision: view?.revision ?? 0,
    agentBusy: !!view?.agentBusy,
    agentContext: view?.agentContext ?? { status: 'ready', error: null },
    active: view?.active ?? null,
    authors: (view?.authors ?? []).map(author => {
      const own = (view?.series ?? []).filter(row => row.authorId === author.id);
      return { ...author, trail: [author.name], seriesCount: own.length, bookCount: own.reduce((sum, row) => sum + (row.bookIds?.length ?? 0), 0) };
    }),
    series: (view?.series ?? []).map(row => ({ ...row, trail: [authors.get(row.authorId)?.name, row.name].filter(Boolean), bookCount: row.bookIds?.length ?? 0, active: view?.active?.seriesId === row.id })),
    books: (view?.books ?? []).map(book => ({ ...book, trail: bookTrail(book), authorId: series.get(book.seriesId)?.authorId ?? null })),
    attachments: (view?.attachments ?? []).map(attachmentTile),
    archived: (view?.archived ?? []).map(attachmentTile),
    byId: { author: authors, series, book: books },
    bookTrail,
  };
}

// Which server request an editor submits. IDs never change on rename.
export function projectRequest(kind, op, { id, body = {} } = {}) {
  const collection = { author: 'authors', series: 'series', book: 'books', attachment: 'attachments' }[kind];
  if (!collection) throw new Error('Неизвестный тип элемента проекта.');
  const path = '/api/project/' + collection + (op === 'create' ? '' : '/' + encodeURIComponent(id) + (op === 'archive' || op === 'restore' ? '/' + op : ''));
  return { path, method: 'POST', body };
}

// True when the change moves the open book's scope; the server then requires confirmActive.
export function needsActiveConfirmation(kind, entity, draft, model) {
  const active = model?.active; if (!active || !entity) return false;
  if (kind === 'book') return entity.id === active.bookId && draft.seriesId !== undefined && draft.seriesId !== entity.seriesId;
  if (kind === 'series') return entity.id === active.seriesId && draft.authorId !== undefined && draft.authorId !== entity.authorId;
  if (kind === 'create-book') return active.seriesId === draft.seriesId && active.bookId === null;
  return false;
}

// Plain-language consequences shown before saving.
export function changeConsequence(kind, entity, draft, model) {
  const lines = [], renamed = draft.name !== undefined && draft.name.trim() !== '' && draft.name.trim() !== entity?.name;
  if (kind === 'attachment') {
    const target = draft.bookId && draft.bookId !== entity.bookId ? model.byId.book.get(draft.bookId) : null;
    if (target) lines.push(`Файл будет связан с книгой «${target.name}» вместо «${entity.bookName ?? 'прежней книги'}». Сам документ и другие его связи не меняются.`);
    if (draft.name !== undefined && draft.name.trim() !== (entity.name ?? '')) lines.push(draft.name.trim() ? 'Новое имя видно только в TaleWisp; документ и файл не переименовываются.' : `Вернётся исходное имя «${entity.defaultName}».`);
    return lines;
  }
  if (renamed) lines.push('Новое название хранится в TaleWisp; папки и файлы хранилища не переименовываются, ID не меняется.');
  if (kind === 'series' && draft.authorId && draft.authorId !== entity.authorId) {
    const author = model.byId.author.get(draft.authorId);
    lines.push(`Серия и её книги (${entity.bookCount ?? 0}) перейдут к автору «${author?.name ?? '—'}». Черновики, заметки, сообщения, предложения, история поручений и задания StoryArt этих книг переедут вместе с ними.`);
  }
  if (kind === 'book' && draft.seriesId && draft.seriesId !== entity.seriesId) {
    const target = model.byId.series.get(draft.seriesId), author = target && model.byId.author.get(target.authorId);
    lines.push(`Книга перейдёт в серию «${target?.name ?? '—'}» автора «${author?.name ?? '—'}». Её черновики, заметки, сообщения, предложения и связанные файлы переедут вместе с ней.`);
    if (target && !target.hasKnowledgeBase) lines.push('У этой серии нет базы знаний в хранилище: источники серии будут недоступны, пока книга в ней.');
  }
  if (needsActiveConfirmation(kind, entity, draft, model)) lines.push('Это открытая книга: перед сохранением черновики будут сохранены, затем агент и источники переключатся только после подтверждения сервера.');
  return lines;
}

// Explicit flush → confirm → submit; a server-side confirmation request is answered the same way once.
export async function submitProjectChange({ api, request, needsConfirm = false, confirmActive, flushDrafts }) {
  const confirmAndFlush = async () => { if (!(await confirmActive())) return false; await flushDrafts(); return true; };
  let body = { ...request.body };
  if (needsConfirm) { if (!(await confirmAndFlush())) return { cancelled: true }; body.confirmActive = true; }
  try { return await api(request.path, { method: request.method, body }); }
  catch (error) {
    if (error?.code !== 'active_confirmation_required' || body.confirmActive) throw error;
    if (!(await confirmAndFlush())) return { cancelled: true };
    return await api(request.path, { method: request.method, body: { ...body, confirmActive: true } });
  }
}

export const friendlyProjectError = error => {
  if (error?.code === 'project_conflict') return 'Настройки проекта изменились в другом окне. Экран обновлён — проверьте и повторите.';
  if (error?.code === 'agent_busy') return 'Агент сейчас работает. Дождитесь ответа или остановите его, затем повторите.';
  return error?.message || 'Не удалось сохранить изменение.';
};

export function createProjectSettings({ document, api, notify, ask, flushDrafts, onCommitted, onBack, openGoogleDocument, openSourceFile, openBook }) {
  const ui = { view: null, model: null, loading: false, error: '', section: 'books', editing: null, creating: null, attaching: null, sources: new Map(), busy: false, formError: '', container: null };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, cls, fn, disabled = false) => { const n = el('button', cls, text); n.type = 'button'; n.disabled = disabled; if (fn) n.addEventListener('click', fn); return n; };
  const field = (label, control) => { const wrap = el('label', 'project-field'); wrap.append(el('span', '', label), control); return wrap; };
  const input = (value, placeholder, onInput) => { const n = el('input'); n.type = 'text'; n.value = value ?? ''; n.placeholder = placeholder ?? ''; n.maxLength = 200; n.addEventListener('input', () => onInput(n.value)); return n; };
  const select = (options, value, onChange) => { const n = el('select'); for (const [id, label] of options) { const o = el('option', '', label); o.value = id; n.append(o); } n.value = value ?? ''; n.addEventListener('change', () => onChange(n.value)); return n; };
  const locked = () => ui.busy || ui.model?.agentBusy;

  async function load() {
    ui.loading = true; ui.error = ''; paint();
    try { ui.view = await api('/api/project'); ui.model = projectModel(ui.view); }
    catch (error) { ui.error = error.message || 'Настройки проекта недоступны.'; }
    finally { ui.loading = false; paint(); }
  }
  async function commit(request, { needsConfirm = false, success } = {}) {
    if (locked()) return;
    ui.busy = true; ui.formError = ''; paint();
    try {
      const result = await submitProjectChange({ api, request, needsConfirm, flushDrafts,
        confirmActive: async () => (await ask('Изменение затрагивает открытую книгу', 'Черновики будут сохранены на сервере, затем агент и источники переключатся на новое место книги. Если сохранение не удастся, ничего не изменится.', 'Сохранить и переключить')) === 'confirm' });
      if (result?.cancelled) return;
      ui.view = result.project; ui.model = projectModel(ui.view); ui.editing = null; ui.creating = null; ui.attaching = null;
      if (result.warning) notify(result.warning, true); else if (success) notify(success);
      await onCommitted?.(result);
    } catch (error) {
      ui.formError = friendlyProjectError(error);
      if (error?.code === 'project_conflict') { try { ui.view = await api('/api/project'); ui.model = projectModel(ui.view); } catch {} }
    } finally { ui.busy = false; paint(); }
  }

  function chips(values) { const row = el('div', 'project-tile-chips'); for (const value of values.filter(Boolean)) row.append(el('span', 'project-chip', value)); return row; }
  function trail(parts) { const n = el('p', 'project-tile-trail', parts.join(' / ')); n.title = parts.join(' / '); return n; }
  function tile(kind, eyebrow, name, { active = false } = {}) {
    const n = el('article', 'project-tile project-tile-' + kind + (active ? ' is-active' : '')); n.append(el('span', 'project-tile-eyebrow', eyebrow), el('h3', 'project-tile-name', name)); return n;
  }
  function editorFooter(lines, onSave, saveLabel = 'Сохранить') {
    const box = el('div', 'project-editor-footer');
    if (lines.length) { const list = el('ul', 'project-consequences'); for (const line of lines) list.append(el('li', '', line)); box.append(list); }
    if (ui.formError) box.append(el('p', 'project-form-error', ui.formError));
    const actions = el('div', 'project-tile-actions');
    actions.append(button(ui.busy ? 'Сохраняю…' : saveLabel, 'button button-primary', onSave, locked()), button('Отмена', 'button button-quiet', () => { ui.editing = null; ui.creating = null; ui.attaching = null; ui.formError = ''; paint(); }, ui.busy));
    box.append(actions); return box;
  }
  const startEdit = (kind, entity, draft) => { ui.editing = { kind, id: entity.id, draft }; ui.creating = null; ui.attaching = null; ui.formError = ''; paint(); };
  const isEditing = (kind, id) => ui.editing?.kind === kind && ui.editing.id === id;
  const seriesOptions = () => ui.model.series.map(row => [row.id, row.trail.join(' — ')]);
  const bookOptions = () => ui.model.books.map(row => [row.id, row.trail.slice(1).join(' — ')]);

  function authorTile(author) {
    const n = tile('author', 'Автор · ' + (ORIGIN_LABELS[author.origin] || ''), author.name);
    n.append(chips([plural(author.seriesCount, 'серия', 'серии', 'серий'), plural(author.bookCount, 'книга', 'книги', 'книг'), author.path ? 'Папка: ' + author.path : null]));
    if (isEditing('author', author.id)) {
      const draft = ui.editing.draft;
      n.append(field('Имя автора', input(draft.name, author.vaultName || 'Имя', value => { draft.name = value; })));
      n.append(editorFooter(changeConsequence('author', author, draft, ui.model), () => commit(projectRequest('author', 'update', { id: author.id, body: { name: draft.name, expectedRevision: ui.model.revision } }), { success: 'Имя автора сохранено.' })));
    } else n.append(actionsRow([button('Переименовать', 'button button-quiet', () => startEdit('author', author, { name: author.name }), locked())]));
    return n;
  }
  function seriesTile(row) {
    const n = tile('series', 'Серия · ' + (ORIGIN_LABELS[row.origin] || ''), row.name, { active: row.active });
    n.append(trail(row.trail), chips([plural(row.bookCount, 'книга', 'книги', 'книг'), row.hasKnowledgeBase ? 'есть база знаний' : 'без базы знаний', row.active ? 'открыта сейчас' : null]));
    if (isEditing('series', row.id)) {
      const draft = ui.editing.draft;
      n.append(field('Название серии', input(draft.name, row.vaultName || 'Название', value => { draft.name = value; })));
      n.append(field('Автор', select(ui.model.authors.map(a => [a.id, a.name]), draft.authorId, value => { draft.authorId = value; paint(); })));
      const body = () => { const out = { expectedRevision: ui.model.revision }; if (draft.name.trim() !== row.name) out.name = draft.name; if (draft.authorId !== row.authorId) out.authorId = draft.authorId; return out; };
      n.append(editorFooter(changeConsequence('series', row, draft, ui.model), () => commit(projectRequest('series', 'update', { id: row.id, body: body() }), { needsConfirm: needsActiveConfirmation('series', row, draft, ui.model), success: 'Серия сохранена.' })));
    } else n.append(actionsRow([button('Изменить', 'button button-quiet', () => startEdit('series', row, { name: row.name, authorId: row.authorId }), locked())]));
    return n;
  }
  function bookTile(book) {
    const n = tile('book', 'Книга · ' + (ORIGIN_LABELS[book.origin] || ''), book.name, { active: book.active });
    n.append(trail(book.trail), chips([plural(book.attachmentCount, 'связанный файл', 'связанных файла', 'связанных файлов'), book.archivedCount ? 'в архиве: ' + book.archivedCount : null, book.active ? 'открыта сейчас' : null]));
    if (isEditing('book', book.id)) {
      const draft = ui.editing.draft;
      n.append(field('Название книги', input(draft.name, book.vaultName || 'Название', value => { draft.name = value; })));
      n.append(field('Серия', select(seriesOptions(), draft.seriesId, value => { draft.seriesId = value; paint(); })));
      const body = () => { const out = { expectedRevision: ui.model.revision }; if (draft.name.trim() !== book.name) out.name = draft.name; if (draft.seriesId !== book.seriesId) out.seriesId = draft.seriesId; return out; };
      n.append(editorFooter(changeConsequence('book', book, draft, ui.model), () => commit(projectRequest('book', 'update', { id: book.id, body: body() }), { needsConfirm: needsActiveConfirmation('book', book, draft, ui.model), success: 'Книга сохранена.' })));
    } else if (ui.attaching?.bookId === book.id) n.append(attachForm(book));
    else n.append(actionsRow([
      book.active ? null : button('Открыть книгу', 'button button-quiet', () => openBook?.({ authorId: book.authorId, seriesId: book.seriesId, bookId: book.id }), locked()),
      button('Изменить', 'button button-quiet', () => startEdit('book', book, { name: book.name, seriesId: book.seriesId }), locked()),
      button('Прикрепить файл', 'button button-quiet', () => { ui.attaching = { bookId: book.id, mode: 'google', googleDocument: '', sourcePath: '', name: '' }; ui.editing = null; ui.creating = null; ui.formError = ''; paint(); }, locked()),
    ]));
    return n;
  }
  function attachForm(book) {
    const draft = ui.attaching, box = el('div', 'project-attach-form');
    const series = ui.model.byId.series.get(book.seriesId);
    const modes = el('div', 'project-segmented'); modes.setAttribute('role', 'radiogroup');
    for (const [mode, label] of [['google', 'Google Docs'], ['source', 'Файл базы серии']]) {
      const b = button(label, 'project-segment' + (draft.mode === mode ? ' is-selected' : ''), () => { draft.mode = mode; ui.formError = ''; paint(); }, mode === 'source' && !series?.hasKnowledgeBase);
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(draft.mode === mode)); modes.append(b);
    }
    box.append(modes);
    if (draft.mode === 'google') box.append(field('Ссылка или ID документа Google Docs', input(draft.googleDocument, 'https://docs.google.com/document/d/…', value => { draft.googleDocument = value; })));
    else {
      const cached = ui.sources.get(book.id);
      if (!cached) { box.append(el('p', 'project-muted', 'Загружаю файлы серии…')); api('/api/project/sources?bookId=' + encodeURIComponent(book.id)).then(result => { ui.sources.set(book.id, result); paint(); }).catch(error => { ui.sources.set(book.id, { files: [], reason: error.message }); paint(); }); }
      else if (!cached.files.length) box.append(el('p', 'project-muted', cached.reason || 'В базе серии нет текстовых файлов.'));
      else box.append(field('Файл из базы серии', select([['', 'Выберите файл…'], ...cached.files.map(file => [file, file])], draft.sourcePath, value => { draft.sourcePath = value; })));
      if (cached?.truncated) box.append(el('p', 'project-muted', 'Показаны первые 2000 файлов.'));
    }
    box.append(field('Отображаемое имя (необязательно)', input(draft.name, 'Как показывать файл в книге', value => { draft.name = value; })));
    const body = () => { const out = { bookId: book.id, expectedRevision: ui.model.revision, ...(draft.name.trim() ? { name: draft.name } : {}) }; return draft.mode === 'google' ? { ...out, googleDocument: draft.googleDocument } : { ...out, sourcePath: draft.sourcePath }; };
    box.append(editorFooter(['Файл станет сопутствующим материалом книги. Он не становится текстом книги и не копируется; Google Docs открывается только по кнопке на плитке файла.'],
      () => commit(projectRequest('attachment', 'create', { body: body() }), { success: 'Файл прикреплён к книге.' }), 'Прикрепить'));
    return box;
  }
  function attachmentTile(item, archived) {
    const n = tile('attachment', attachmentKindLabel(item.kind), item.name);
    n.append(trail(item.trail), chips([item.path ? 'Путь: ' + item.path : null, item.googleDocumentId ? 'Google ID: ' + item.googleDocumentId.slice(0, 10) + '…' : null, archived ? 'скрыт ' + new Date(item.archivedAt).toLocaleDateString('ru-RU') : null]));
    if (archived) {
      n.append(el('p', 'project-muted', 'Связь скрыта из рабочего списка книги. Документ и файлы не удалялись.'));
      if (ui.formError && ui.editing?.id === item.id) n.append(el('p', 'project-form-error', ui.formError));
      n.append(actionsRow([button('Восстановить', 'button button-primary', () => { ui.editing = { kind: 'restore', id: item.id, draft: {} }; commit(projectRequest('attachment', 'restore', { id: item.id, body: { expectedRevision: ui.model.revision } }), { success: `«${item.name}» снова в списке книги.` }); }, locked())]));
      return n;
    }
    if (isEditing('attachment', item.id)) {
      const draft = ui.editing.draft;
      n.append(field('Отображаемое имя', input(draft.name, item.defaultName, value => { draft.name = value; })));
      n.append(field('Книга', select(bookOptions(), draft.bookId, value => { draft.bookId = value; paint(); })));
      const body = () => { const out = { expectedRevision: ui.model.revision }; if (draft.name.trim() !== item.name) out.name = draft.name.trim(); if (draft.bookId !== item.bookId) out.bookId = draft.bookId; return out; };
      n.append(editorFooter(changeConsequence('attachment', item, draft, ui.model), () => commit(projectRequest('attachment', 'update', { id: item.id, body: body() }), { success: 'Связанный файл сохранён.' })));
      return n;
    }
    n.append(actionsRow([
      item.googleDocumentId ? button('Открыть в Google Docs', 'button button-quiet', () => openGoogleDocument?.({ googleDocumentId: item.googleDocumentId, name: item.name })) : null,
      item.sourceAvailable ? button('Открыть исходник', 'button button-quiet', () => openSourceFile?.(item)) : null,
      button('Изменить', 'button button-quiet', () => startEdit('attachment', item, { name: item.name, bookId: item.bookId }), locked()),
      button('В архив', 'button button-quiet project-archive-action', async () => {
        if ((await ask('Скрыть связанный файл?', `«${item.name}» исчезнет из списка книги «${item.bookName ?? ''}» и останется в разделе «Архив связанных файлов». Документ Google Docs и файлы хранилища не удаляются; связи этого файла с другими книгами не меняются.`, 'В архив')) !== 'confirm') return;
        commit(projectRequest('attachment', 'archive', { id: item.id, body: { expectedRevision: ui.model.revision } }), { success: 'Файл перенесён в архив. Восстановить его можно в «Архиве связанных файлов».' });
      }, locked()),
    ]));
    return n;
  }
  function actionsRow(items) { const row = el('div', 'project-tile-actions'); row.append(...items.filter(Boolean)); return row; }

  function createTile(kind) {
    const labels = { author: ['Новый автор', 'Автор появится только в TaleWisp; папка в хранилище не создаётся.'], series: ['Новая серия', 'Логическая серия без базы знаний; позже к её книгам можно прикрепить Google Docs.'], book: ['Новая книга', 'Самостоятельная книга: Google Docs не обязателен, его можно прикрепить сразу или позже.'] }[kind];
    const n = el('article', 'project-tile project-tile-create');
    if (ui.creating?.kind !== kind) {
      const open = button('+ ' + labels[0], 'project-create-trigger', () => { ui.creating = { kind, draft: { name: '', authorId: ui.model.authors[0]?.id ?? '', seriesId: ui.model.active?.seriesId ?? ui.model.series[0]?.id ?? '', googleDocument: '' } }; ui.editing = null; ui.attaching = null; ui.formError = ''; paint(); }, locked() || (kind === 'series' && !ui.model.authors.length) || (kind === 'book' && !ui.model.series.length));
      n.append(open, el('p', 'project-muted', labels[1])); return n;
    }
    const draft = ui.creating.draft;
    n.append(el('h3', 'project-tile-name', labels[0]), field('Название', input(draft.name, '', value => { draft.name = value; })));
    if (kind === 'series') n.append(field('Автор', select(ui.model.authors.map(a => [a.id, a.name]), draft.authorId, value => { draft.authorId = value; })));
    if (kind === 'book') {
      n.append(field('Серия', select(seriesOptions(), draft.seriesId, value => { draft.seriesId = value; paint(); })));
      n.append(field('Google Docs (необязательно): ссылка или ID', input(draft.googleDocument, 'Можно оставить пустым', value => { draft.googleDocument = value; })));
    }
    const body = () => ({ name: draft.name, expectedRevision: ui.model.revision, ...(kind === 'series' ? { authorId: draft.authorId } : {}), ...(kind === 'book' ? { seriesId: draft.seriesId, ...(draft.googleDocument.trim() ? { googleDocument: draft.googleDocument.trim() } : {}) } : {}) });
    const confirm = kind === 'book' && needsActiveConfirmation('create-book', null, draft, ui.model);
    const success = { author: 'Автор создан.', series: 'Серия создана.', book: 'Книга создана.' }[kind];
    n.append(editorFooter([labels[1], ...(confirm ? ['Открытая серия пока без книг: после сохранения черновиков откроется новая книга. Заметки и черновики серии останутся общими для серии.'] : [])], () => commit(projectRequest(kind, 'create', { body: body() }), { needsConfirm: confirm, success }), 'Создать'));
    return n;
  }

  function sectionContent() {
    const m = ui.model, grid = el('div', 'project-tile-grid');
    if (ui.section === 'authors') { grid.append(...m.authors.map(authorTile), createTile('author')); }
    if (ui.section === 'series') { grid.append(...m.series.map(seriesTile), createTile('series')); }
    if (ui.section === 'books') { grid.append(...m.books.map(bookTile), createTile('book')); }
    if (ui.section === 'attachments') {
      if (!m.attachments.length) grid.append(emptyTile('Связанных файлов пока нет', 'Прикрепите Google Docs или файл базы серии на плитке книги.'));
      grid.append(...m.attachments.map(item => attachmentTile(item, false)));
    }
    if (ui.section === 'archive') {
      if (!m.archived.length) grid.append(emptyTile('Архив пуст', 'Скрытые связанные файлы появятся здесь, и их можно будет восстановить.'));
      grid.append(...m.archived.map(item => attachmentTile(item, true)));
    }
    return grid;
  }
  const emptyTile = (head, text) => { const n = el('div', 'project-empty'); n.append(el('strong', '', head), el('span', '', text)); return n; };

  function paint() {
    const root = ui.container; if (!root) return;
    const head = el('div', 'special-heading project-heading'), copy = el('div');
    copy.append(el('div', 'eyebrow', 'НАСТРОЙКИ · ПРОЕКТ'), el('h1', '', 'Настройки проекта'), el('p', '', 'Названия и связи авторов, серий, книг и связанных файлов. Хранятся в TaleWisp; файлы хранилища и Google Docs не меняются.'));
    const tools = el('div', 'project-heading-actions'); tools.append(button('← Все настройки', 'button button-quiet', () => onBack?.()), button('Обновить', 'button button-quiet', load, ui.loading || ui.busy));
    head.append(copy, tools);
    const parts = [head];
    if (ui.loading && !ui.model) parts.push(emptyTile('Загружаю проект', 'Получаю авторов, серии, книги и связанные файлы.'));
    else if (ui.error && !ui.model) { const box = emptyTile('Настройки проекта недоступны', ui.error); box.append(button('Повторить', 'button button-quiet', load)); parts.push(box); }
    else if (ui.model) {
      const m = ui.model;
      if (m.agentContext?.status === 'detached') parts.push(banner('warning', 'Агент отключён от открытой книги: ' + (m.agentContext.error || '') + ' Откройте книгу заново, чтобы переподключить его.'));
      if (m.agentBusy) parts.push(banner('info', 'Агент сейчас работает — изменения станут доступны после завершения ответа.'));
      if (ui.error) parts.push(banner('warning', ui.error));
      if (ui.formError && !ui.editing && !ui.creating && !ui.attaching) parts.push(banner('warning', ui.formError));
      const tabs = el('div', 'project-sections'); tabs.setAttribute('role', 'tablist');
      const counts = { authors: m.authors.length, series: m.series.length, books: m.books.length, attachments: m.attachments.length, archive: m.archived.length };
      for (const [key, label] of PROJECT_SECTIONS) {
        const b = button('', 'project-section' + (ui.section === key ? ' is-selected' : ''), () => { ui.section = key; ui.editing = null; ui.creating = null; ui.attaching = null; ui.formError = ''; paint(); });
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(ui.section === key)); b.append(el('span', '', label), el('span', 'project-section-count', String(counts[key]))); tabs.append(b);
      }
      parts.push(tabs, sectionContent());
    }
    root.replaceChildren(...parts);
  }
  const banner = (tone, text) => { const n = el('div', 'project-banner project-banner-' + tone, text); n.setAttribute('role', tone === 'warning' ? 'alert' : 'status'); return n; };

  return {
    render(container, { section } = {}) { ui.container = container; if (section) ui.section = section; paint(); return load(); },
    state: ui,
  };
}
