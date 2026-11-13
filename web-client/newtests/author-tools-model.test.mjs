import test from 'node:test';
import assert from 'node:assert/strict';
import { diffParagraphs, findEntityAt, pluralWords, streakLabel } from '../public/author-tools-model.js';

test('paragraph diff reports only what changed and keeps order', () => {
  const rows = diffParagraphs('Первый.\nВторой.\nТретий.', 'Первый.\nВторой, новый.\nТретий.\nЧетвёртый.');
  assert.deepEqual(rows, [{ type: 'same', text: 'Первый.' }, { type: 'removed', text: 'Второй.' }, { type: 'added', text: 'Второй, новый.' }, { type: 'same', text: 'Третий.' }, { type: 'added', text: 'Четвёртый.' }]);
  assert.ok(diffParagraphs('а\nб', 'а\nб').every(row => row.type === 'same'));
});

test('entity lookup tolerates Russian case endings and prefers the longer name', () => {
  const entities = [{ name: 'Марта' }, { name: 'Марта Вересова' }, { name: 'перевал' }, { name: 'Архив Старого города' }];
  const line = 'Утром Марту Вересову видели у перевала, а потом в Архиве Старого города.';
  assert.equal(findEntityAt(line, line.indexOf('Марту') + 2, entities).entity.name, 'Марта Вересова');
  assert.equal(findEntityAt(line, line.indexOf('Вересову') + 1, entities).entity.name, 'Марта Вересова');
  assert.equal(findEntityAt(line, line.indexOf('перевала') + 1, entities), null, 'a lower-case common noun is not a name');
  assert.equal(findEntityAt(line, line.indexOf('Старого') + 1, entities).entity.name, 'Архив Старого города');
  assert.equal(findEntityAt(line, line.indexOf('видели') + 1, entities), null);
  assert.equal(findEntityAt('Мартышка прыгнула.', 2, entities), null, 'a longer different word does not match');
});

test('labels use Russian plural forms', () => {
  assert.equal(pluralWords(1), '1 слово'); assert.equal(pluralWords(3), '3 слова'); assert.equal(pluralWords(11), '11 слов');
  assert.equal(streakLabel(2), 'дня подряд');
});
