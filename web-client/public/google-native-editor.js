const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export function googleDocumentEditUrl(documentId) {
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) {
    throw new TypeError('Invalid Google Docs document ID');
  }
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export function createGoogleNativeEditor({ document, googleDocument, onBack }) {
  const editUrl = googleDocumentEditUrl(googleDocument?.documentId);
  const root = document.createElement('section');
  root.className = 'google-native-editor';

  const toolbar = document.createElement('div');
  toolbar.className = 'google-native-toolbar';
  const title = document.createElement('h2');
  title.className = 'google-native-title';
  title.textContent = googleDocument?.title || 'Документ Google Docs';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'button button-quiet';
  back.textContent = 'Закрыть документ';
  back.addEventListener('click', () => onBack?.());

  const externalLink = document.createElement('a');
  externalLink.className = 'google-native-link';
  externalLink.textContent = 'Открыть в Google Docs';
  externalLink.href = editUrl;
  externalLink.target = '_blank';
  externalLink.rel = 'noopener noreferrer';
  toolbar.append(title, back, externalLink);

  const notice = document.createElement('p');
  notice.className = 'google-native-notice';
  notice.textContent = 'Это оригинал Google Docs. Для редактирования войдите в Google под аккаунтом с правами на файл. Если редактор не загрузился или просит вход, откройте «Открыть в Google Docs», войдите в отдельной вкладке и обновите эту страницу.';

  const frame = document.createElement('iframe');
  frame.className = 'google-native-frame';
  frame.title = `Редактор Google Docs: ${googleDocument?.title || 'Документ Google Docs'}`;
  frame.src = editUrl;
  frame.allowFullscreen = true;
  frame.allow = 'clipboard-read; clipboard-write; microphone; camera; fullscreen';

  root.append(toolbar, notice, frame);
  return root;
}
