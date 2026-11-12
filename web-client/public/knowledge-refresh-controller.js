export function createKnowledgeRefreshController({ refresh, isActive, intervalMs = 2500, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, running = false, request = 0;
  const schedule = () => {
    if (!running || timer !== null || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    timer = setTimer(async () => {
      timer = null;
      if (!running) return;
      if (!isActive()) { stop(); return; }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { schedule(); return; }
      const token = ++request;
      try { await refresh(); } catch { /* A transient poll failure leaves the last good graph visible. */ }
      if (running && token === request && isActive()) schedule(); else if (running && !isActive()) stop();
    }, intervalMs);
  };
  const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { if (timer !== null) clearTimer(timer); timer = null; } else schedule(); };
  function start() {
    if (running) return;
    running = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);
    schedule();
  }
  function stop() {
    if (!running) return;
    running = false; request++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
  }
  return { start, stop, get running() { return running; } };
}
