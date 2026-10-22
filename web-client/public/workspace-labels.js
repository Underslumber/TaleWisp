const TYPE_LABELS = new Map([
  ['note', 'Заметка'],
  ['character', 'Персонаж'],
  ['event', 'Событие'],
  ['location', 'Место'],
  ['world', 'Мир'],
  ['plot', 'Сюжет'],
  ['scene-analysis', 'Разбор сцены'],
  ['source-chapter', 'Исходный текст'],
  ['manuscript-source', 'Исходный текст'],
  ['style', 'Стиль письма'],
  ['glossary', 'Словарь'],
  ['timeline', 'Хронология'],
  ['relationship', 'Отношения'],
  ['knowledge', 'Знание']
]);

const STATUS_LABELS = new Map([
  ['unmarked', 'Без отметки'],
  ['confirmed', 'Подтверждено'],
  ['approved', 'Подтверждено'],
  ['draft', 'Черновик'],
  ['in-progress', 'В работе'],
  ['complete', 'Завершено'],
  ['completed', 'Завершено'],
  ['source', 'Источник'],
  ['pending', 'Ожидает проверки'],
  ['proposed', 'Предложено'],
  ['rejected', 'Отклонено'],
  ['historical', 'Историческая запись'],
  ['active', 'Действует'],
  ['inactive', 'Не действует'],
  ['open', 'Открытый вопрос'],
  ['hypothesis', 'Гипотеза'],
  ['disputed', 'Спорное'],
  ['canon', 'Канон']
]);

export function friendlyRecordType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (TYPE_LABELS.has(type)) return TYPE_LABELS.get(type);
  if (/source|manuscript/.test(type)) return 'Исходный текст';
  if (/scene.?analysis|analysis/.test(type)) return 'Разбор сцены';
  return type ? 'Материал книги' : 'Запись книги';
}

export function friendlyStatus(value) {
  const status = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return STATUS_LABELS.get(status) || (status ? 'Статус указан' : 'Статус не указан');
}
