import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyRecordType, friendlyStatus } from '../public/workspace-labels.js';

test('workspace cards show concise Russian labels for known knowledge types', () => {
  assert.equal(friendlyRecordType('note'), 'Заметка');
  assert.equal(friendlyRecordType('character'), 'Персонаж');
  assert.equal(friendlyRecordType('source-chapter'), 'Исходный текст');
  assert.equal(friendlyRecordType('scene-analysis'), 'Разбор сцены');
  assert.equal(friendlyRecordType('future-internal-code'), 'Материал книги');
});

test('workspace cards translate known states without exposing unknown codes', () => {
  assert.equal(friendlyStatus('unmarked'), 'Без отметки');
  assert.equal(friendlyStatus('confirmed'), 'Подтверждено');
  assert.equal(friendlyStatus('in_progress'), 'В работе');
  assert.equal(friendlyStatus(''), 'Статус не указан');
  assert.equal(friendlyStatus('future_internal_status'), 'Статус указан');
});
