export function createOpenController(onBusy = () => {}) {
  let sequence = 0;
  let active = null;

  function begin() {
    active = ++sequence;
    onBusy(true);
    return active;
  }

  function isCurrent(token) {
    return active === token;
  }

  function finish(token, commit) {
    if (!isCurrent(token)) return false;
    active = null;
    onBusy(false);
    commit?.();
    return true;
  }

  function invalidate() {
    sequence += 1;
    active = null;
    onBusy(false);
  }

  return { begin, isCurrent, finish, invalidate };
}
