export function googleNoteBody(payload) {
  const lines = [payload.title, '', 'Статус: черновая заметка', '', payload.text];
  const source = [];
  for (const [label, value] of [['Источник', payload.sourceUrl], ['Вкладка или диапазон', payload.sourceTabOrRange], ['Цитата источника', payload.quote], ['Версия источника', payload.sourceRevision]]) {
    if (typeof value === 'string' && value) source.push(`${label}: ${value}`);
  }
  if (source.length) lines.push('', ...source);
  return `${lines.join('\n')}\n`;
}
