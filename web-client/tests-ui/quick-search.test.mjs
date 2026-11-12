import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuickSearchModel } from '../public/quick-search.js';

function harness(search) {
  const timers = [], changes = [];
  const model = createQuickSearchModel({ search, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: id => { timers[id - 1] = null; }, onChange: state => changes.push(state) });
  const flush = async () => { for (const fn of timers.splice(0)) await fn?.(); await new Promise(resolve => setImmediate(resolve)); };
  return { model, changes, flush };
}

test('short queries do not search; a typed query is debounced into one request', async () => {
  const calls = [];
  const h = harness(async query => { calls.push(query); return { cards: [{ path: 'a.md', title: 'Анна' }, { path: 'b.md', title: 'Анна-Мария' }], matchedCount: 2 }; });
  h.model.setQuery('а'); await h.flush();
  assert.deepEqual(calls, []); assert.equal(h.model.snapshot().status, 'idle');
  h.model.setQuery('ан'); h.model.setQuery('анн'); h.model.setQuery(' анна ');
  assert.equal(h.model.snapshot().status, 'loading');
  await h.flush();
  assert.deepEqual(calls, ['анна']);
  assert.equal(h.model.snapshot().status, 'ready'); assert.equal(h.model.current().path, 'a.md');
});

test('arrow keys wrap around the results and a new query resets the choice', async () => {
  const h = harness(async () => ({ cards: [{ path: '1' }, { path: '2' }, { path: '3' }] }));
  h.model.setQuery('глава'); await h.flush();
  h.model.move(-1); assert.equal(h.model.current().path, '3');
  h.model.move(1); assert.equal(h.model.current().path, '1');
  h.model.move(1); h.model.setQuery('главы'); await h.flush();
  assert.equal(h.model.current().path, '1');
});

test('a slow earlier answer never replaces a newer one, and failures surface as an error state', async () => {
  const pending = [];
  const h = harness(query => new Promise((resolve, reject) => pending.push({ query, resolve, reject })));
  h.model.setQuery('первый'); await h.flush();
  h.model.setQuery('второй'); await h.flush();
  pending[1].resolve({ cards: [{ path: 'new' }] }); await h.flush();
  pending[0].resolve({ cards: [{ path: 'old' }] }); await h.flush();
  assert.equal(h.model.current().path, 'new');
  h.model.setQuery('третий'); await h.flush();
  pending[2].reject(new Error('Нет связи')); await h.flush();
  assert.equal(h.model.snapshot().status, 'error'); assert.equal(h.model.snapshot().error, 'Нет связи'); assert.equal(h.model.current(), null);
  h.model.reset(); assert.equal(h.model.snapshot().status, 'idle');
});

test('no more than twenty results are kept and an empty answer is reported as such', async () => {
  const h = harness(async query => query === 'пусто' ? { cards: [] } : { cards: Array.from({ length: 50 }, (_, i) => ({ path: String(i) })), matchedCount: 50 });
  h.model.setQuery('много'); await h.flush();
  assert.equal(h.model.snapshot().results.length, 20); assert.equal(h.model.snapshot().matched, 50);
  h.model.setQuery('пусто'); await h.flush();
  assert.equal(h.model.snapshot().status, 'empty');
});
