export function createPanelLifecycle() {
  let generation = 0;
  let viewGeneration = 0;
  let activeView = null;
  let historySequence = 0;
  const homes = new WeakMap();

  return {
    begin() { return ++generation; },
    invalidate() { return ++generation; },
    currentGeneration() { return generation; },
    isCurrent(token) { return token === generation; },
    beginView(view) { activeView = view; return { view, generation: ++viewGeneration }; },
    isCurrentView(request, view) { return request?.generation === viewGeneration && request.view === view && activeView === view; },
    replaceView(panel, view, children = []) {
      if (activeView !== view) return false;
      panel.replaceChildren(...children);
      return true;
    },
    rememberHome(panel) {
      if (!homes.has(panel)) homes.set(panel, { parent: panel.parentNode, next: panel.nextSibling });
      return homes.get(panel);
    },
    restoreHome(panel) {
      const home = homes.get(panel);
      if (!home?.parent) return false;
      home.parent.insertBefore(panel, home.next?.parentNode === home.parent ? home.next : null);
      return true;
    },
    beginHistory(context) {
      return { ...context, sequence: ++historySequence };
    },
    isCurrentHistory(request, context) {
      return request.sequence === historySequence
        && request.generation === context.generation
        && request.key === context.key
        && request.draftId === context.draftId;
    }
  };
}
