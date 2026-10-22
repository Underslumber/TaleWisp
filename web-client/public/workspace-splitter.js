// Resizable boundary between the writing area and the desktop inspector (agent / context / history).
export const SPLITTER_DEFAULTS = { minEditor: 420, minInspector: 300, maxInspector: 960, handle: 10, step: 24, bigStep: 120, defaultRatio: 0.3 };

// Width of the inspector for a grid of `total` px: never below its minimum, never squeezing the editor below its own.
export function clampInspectorWidth(total, desired, options = {}) {
  const o = { ...SPLITTER_DEFAULTS, ...options };
  const room = Math.max(0, total - o.handle - o.minEditor);
  const max = Math.max(o.minInspector, Math.min(o.maxInspector, room));
  const value = Number.isFinite(desired) ? desired : max;
  return Math.round(Math.min(max, Math.max(o.minInspector, value)));
}

export function readStoredRatio(storage, key) {
  try { const value = Number(storage?.getItem(key)); return Number.isFinite(value) && value > 0.05 && value < 0.95 ? value : null; }
  catch { return null; }
}

export function createWorkspaceSplitter({ window, document, grid, handle, storage, key = 'talewisp.workspace.inspectorRatio', isActive = () => true, options = {} }) {
  const o = { ...SPLITTER_DEFAULTS, ...options };
  let ratio = readStoredRatio(storage, key) ?? o.defaultRatio, width = null, drag = null;
  const total = () => grid.getBoundingClientRect().width;

  function apply(next, { persist = false } = {}) {
    const gridWidth = total();
    if (!gridWidth) return;
    width = clampInspectorWidth(gridWidth, next, o);
    grid.style.setProperty('--inspector-width', width + 'px');
    handle.setAttribute('aria-valuemin', String(o.minInspector));
    handle.setAttribute('aria-valuemax', String(clampInspectorWidth(gridWidth, Infinity, o)));
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuetext', `Панель справа ${width} px, текст ${Math.max(0, Math.round(gridWidth - o.handle - width))} px`);
    if (persist) { ratio = width / gridWidth; try { storage?.setItem(key, ratio.toFixed(4)); } catch { /* storage may be disabled */ } }
  }
  function sync() { if (isActive()) apply(ratio * total()); }
  function reset() { ratio = o.defaultRatio; apply(ratio * total(), { persist: true }); }
  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null; handle.classList.remove('is-dragging'); document.body.classList.remove('is-resizing-workspace');
    apply(width, { persist: true });
  }

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !isActive()) return;
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    drag = { id: event.pointerId };
    handle.classList.add('is-dragging'); document.body.classList.add('is-resizing-workspace');
    handle.focus({ preventScroll: true });
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    apply(grid.getBoundingClientRect().right - event.clientX - o.handle / 2);
  });
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  handle.addEventListener('dblclick', () => { if (isActive()) reset(); });
  handle.addEventListener('keydown', event => {
    if (!isActive()) return;
    const current = width ?? clampInspectorWidth(total(), ratio * total(), o);
    const step = event.shiftKey ? o.bigStep : o.step;
    const next = {
      ArrowLeft: current + step, ArrowRight: current - step, PageUp: current + o.bigStep, PageDown: current - o.bigStep,
      Home: o.minInspector, End: Infinity,
    }[event.key];
    if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
    if (next === undefined) return;
    event.preventDefault();
    apply(next, { persist: true });
  });

  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(() => sync()) : null;
  observer?.observe(grid);
  window.addEventListener('resize', sync);
  sync();
  return { sync, reset, width: () => width, destroy() { observer?.disconnect(); window.removeEventListener('resize', sync); } };
}
