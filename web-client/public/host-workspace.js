const cleanText = value => typeof value === 'string' ? value : '';

export const storyArtStatusLabel = status => ({created:'Чат создан',dispatching:'Создаётся чат',setup_pending:'Подготовка чата',running:'Выполняется',inProgress:'Выполняется',completed:'Ответ получен',error:'Ошибка',failed:'Ошибка',cancelled:'Остановлено',interrupted:'Прервано',unknown:'Результат создания неизвестен',unknown_outcome:'Результат создания неизвестен',idle:'Ожидает запроса'})[status] || 'Статус уточняется';

export function storyArtArtifactUrl(value, requestId, origin) {
  const raw = cleanText(value);
  const id = cleanText(requestId);
  if (!raw.startsWith('/api/storyart/artifact?') || !id || !origin) return '';
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || url.pathname !== '/api/storyart/artifact') return '';
    if (url.searchParams.get('requestId') !== id) return '';
    const index = url.searchParams.get('index');
    if (index === null || !/^\d+$/.test(index)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function element(document, tag, className = '', text = '') {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

export function renderStoryArtRequests(document, requests, { origin, loading = false, error = '', onRefresh = () => {}, onOperation = () => {} } = {}) {
  const root = element(document, 'div', 'agent-status-content storyart-content');
  const toolbar = element(document, 'div', 'storyart-toolbar');
  toolbar.append(element(document, 'p', 'subtle-empty', 'Задачи и результаты, сохранённые на StoryArt. Обновление выполняется только по запросу.'));
  const refresh = element(document, 'button', 'button button-quiet', loading ? 'Обновляю…' : 'Обновить список');
  refresh.type = 'button';
  refresh.disabled = loading;
  refresh.addEventListener('click', onRefresh);
  toolbar.append(refresh);
  root.append(toolbar);
  if (error) root.append(element(document, 'p', 'agent-error', error));

  const list = Array.isArray(requests) ? requests : [];
  if (!list.length) {
    root.append(element(document, 'p', 'subtle-empty', loading ? 'Загружаем сохранённые задачи…' : 'Сохранённых задач StoryArt пока нет.'));
    return root;
  }
  const cards = element(document, 'div', 'agent-status-list');
  list.forEach(request => {
    if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || !request.requestId) return;
    const card = element(document, 'article', 'agent-status-row storyart-request');
    const title = cleanText(request.title) || `Задача ${request.requestId}`;
    const status = cleanText(request.status) || 'unknown';
    card.append(element(document, 'strong', '', title));
    const statusRow = element(document, 'div', 'storyart-meta');
    statusRow.append(element(document, 'span', 'agent-status-badge', storyArtStatusLabel(status)));
    if (cleanText(request.threadId)) statusRow.append(element(document, 'span', 'agent-transport-note', `Поток ${request.threadId}`));
    card.append(statusRow);
    if (cleanText(request.error)) card.append(element(document, 'p', 'agent-error', request.error));
    if (cleanText(request.result)) {
      const response = element(document, 'details', 'agent-technical-details');
      response.append(element(document, 'summary', '', 'Ответ StoryArt'), element(document, 'pre', 'storyart-result', request.result));
      card.append(response);
    }

    const artifacts = Array.isArray(request.artifacts) ? request.artifacts : [];
    const validArtifacts = artifacts.map(artifact => ({ artifact, url: storyArtArtifactUrl(artifact?.url, request.requestId, origin) })).filter(item => item.url);
    if (validArtifacts.length) {
      const gallery = element(document, 'div', 'storyart-gallery');
      validArtifacts.forEach(({ artifact, url }, index) => {
        const figure = element(document, 'figure', 'storyart-artifact');
        const image = element(document, 'img');
        image.src = url;
        image.alt = `Кандидат StoryArt ${index + 1}`;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        figure.append(image);
        if (cleanText(artifact?.label)) figure.append(element(document, 'figcaption', '', artifact.label));
        gallery.append(figure);
      });
      card.append(gallery);
    }

    const actions = element(document, 'div', 'storyart-actions');
    for (const [operation, label] of [['read', 'Прочитать результат'], ['wait', 'Проверить завершение']]) {
      const button = element(document, 'button', 'button button-quiet', label);
      button.type = 'button';
      button.addEventListener('click', () => onOperation(operation, request.requestId));
      actions.append(button);
    }
    card.append(actions);
    const correction = element(document, 'form', 'storyart-correction');
    const input = element(document, 'textarea');
    input.rows = 2;
    input.maxLength = 4000;
    input.placeholder = 'Текст уточнения для StoryArt';
    input.setAttribute('aria-label', `Текст уточнения для задачи ${title}`);
    const send = element(document, 'button', 'button button-quiet', 'Отправить уточнение');
    send.type = 'submit';
    correction.append(input, send);
    correction.addEventListener('submit', async event => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      try {
        const sent = await onOperation('send', request.requestId, message);
        if (sent !== false) input.value = '';
      } catch { /* Keep the author's correction available to retry. */ }
    });
    card.append(correction);
    cards.append(card);
  });
  root.append(cards);
  return root;
}
