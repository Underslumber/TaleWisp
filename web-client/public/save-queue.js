export function createSaveQueue({ onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const entries = new Map();

  function hasPending() {
    return [...entries.values()].some(entry => entry.timer !== null || entry.pending || entry.inFlight !== null);
  }

  function report() { onChange(hasPending()); }

  function removeIfIdle(entry) {
    if (entry.timer === null && !entry.pending && entry.inFlight === null && entries.get(entry.key) === entry) entries.delete(entry.key);
    report();
  }

  async function run(entry) {
    if (entry.inFlight) return entry.inFlight;
    if (!entry.pending) return;
    entry.pending = false;
    const task = entry.task;
    const operation = Promise.resolve().then(task);
    entry.inFlight = operation;
    report();
    try {
      await operation;
    } finally {
      entry.inFlight = null;
      if (entry.pending && entry.timer === null) void run(entry).catch(() => {});
      else removeIfIdle(entry);
    }
  }

  function get(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, task: null, timer: null, pending: false, inFlight: null };
      entries.set(key, entry);
    }
    return entry;
  }

  function schedule(key, task, delay = 850) {
    const entry = get(key);
    entry.task = task;
    entry.pending = true;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (!entry.inFlight) void run(entry).catch(() => {});
      else report();
    }, delay);
    report();
  }

  async function flush(key) {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimer(entry.timer);
      entry.timer = null;
      entry.pending = true;
    }
    if (entry.inFlight) {
      await entry.inFlight.catch(() => {});
      if (entry.pending && entry.timer === null) await run(entry).catch(() => {});
    } else if (entry.pending) {
      await run(entry).catch(() => {});
    }
  }

  async function flushAll() {
    const keys = [...entries.keys()];
    await Promise.all(keys.map(key => flush(key)));
  }

  function rekey(from, to) {
    if (from === to) return;
    const entry = entries.get(from);
    if (!entry) return;
    const target = entries.get(to);
    if (target && target !== entry) throw new Error('Cannot rekey a save queue entry onto an active key.');
    entries.delete(from);
    entry.key = to;
    entries.set(to, entry);
    report();
  }

  return { schedule, flush, flushAll, hasPending, rekey };
}
