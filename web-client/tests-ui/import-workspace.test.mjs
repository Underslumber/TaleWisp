import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_LIMITS, importAgentCanRun, importStatusLabel, validateImportSelection } from '../public/import-workspace.js';

const file = (name, size = 1) => ({ name, size });

test('series import validates required identity, supported types, duplicates, and size limits', () => {
  assert.equal(validateImportSelection('', '', [file('book.fb2')]).valid, false);
  assert.equal(validateImportSelection('Author', 'Series', [file('book.exe')]).valid, false);
  assert.equal(validateImportSelection('Author', 'Series', [file('book.fb2'), file('BOOK.FB2')]).valid, false);
  assert.equal(validateImportSelection('Author', 'Series', [file('large.txt', IMPORT_LIMITS.fileBytes + 1)]).valid, false);
  assert.equal(validateImportSelection('Author', 'Series', [file('ok.docx'), file('snapshot.json')]).valid, true);
});

test('series import enforces aggregate and existing-job limits', () => {
  const maxFile = file('book.txt', IMPORT_LIMITS.fileBytes);
  assert.equal(validateImportSelection('A', 'S', [maxFile, file('b.txt', IMPORT_LIMITS.fileBytes)], 0, 15 * 1024 * 1024).valid, false);
  assert.equal(validateImportSelection('A', 'S', Array.from({ length: 2 }, (_, i) => file(`${i}.txt`)), 11, 0).valid, false);
});

test('delegation labels distinguish interrupted and incomplete jobs', () => {
  assert.equal(importStatusLabel('interrupted'), 'Прервано до завершения');
  assert.equal(importStatusLabel('incomplete'), 'Не завершено');
});

test('a prepared import and current candidate can resume only when the actual agent is idle', () => {
  for (const status of ['awaiting_sources', 'prepared_for_analysis', 'candidate_ready_for_review']) {
    assert.equal(importAgentCanRun(status, { fileCount: 1 }), true);
    assert.equal(importAgentCanRun(status, { fileCount: 1, agentRunning: true }), false);
    assert.equal(importAgentCanRun(status, { fileCount: 1, busy: true }), false);
  }
  assert.equal(importAgentCanRun('candidate_ready_for_review', { fileCount: 0 }), false);
  for (const status of ['complete', 'published', 'awaiting_publish_confirmation']) {
    assert.equal(importAgentCanRun(status, { fileCount: 1 }), false);
  }
});
