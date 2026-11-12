import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeRefreshController } from '../public/knowledge-refresh-controller.js';

test('polling is bounded to one timer, ignores stale completion, and stops when the view leaves', async () => {
  const timers = new Map(); let next = 1, active = true, calls = 0, release;
  const controller = createKnowledgeRefreshController({
    intervalMs: 2500, isActive: () => active,
    refresh: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    setTimer: fn => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
  });
  controller.start(); controller.start(); assert.equal(timers.size, 1);
  const [id, tick] = [...timers.entries()][0]; timers.delete(id); const pending = tick();
  controller.stop(); release(); await pending; assert.equal(timers.size, 0); assert.equal(controller.running, false); assert.equal(calls, 1);
});

test('active poll schedules exactly one next pass and leaving the map prevents another request', async () => {
  const timers = new Map(); let next = 1, active = true, calls = 0;
  const controller = createKnowledgeRefreshController({
    isActive: () => active, refresh: async () => { calls++; },
    setTimer: fn => { const id = next++; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id),
  });
  controller.start();
  let [id, tick] = [...timers.entries()][0]; timers.delete(id); await tick(); assert.equal(calls, 1); assert.equal(timers.size, 1);
  active = false; [id, tick] = [...timers.entries()][0]; timers.delete(id); await tick(); assert.equal(calls, 1); assert.equal(timers.size, 0); assert.equal(controller.running, false);
});
