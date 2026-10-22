// Pure normalization of account rate-limit data for the agent quota gauge.
// Accepts the shapes the runtime forwards (rateLimitsByLimitId maps, a single
// rateLimits snapshot, wrappers holding either, arrays, and legacy snake_case
// windows). Missing or malformed values stay unknown; they never become 0.

const SNAPSHOT_KEYS = ['primary', 'secondary', 'windows', 'credits', 'limitId', 'limit_id', 'limitName', 'limit_name'];
const WINDOW_KEYS = ['usedPercent', 'used_percent'];
const SLOT_ORDER = { primary: 0, secondary: 1, window: 2 };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasAny = (value, keys) => keys.some(key => Object.hasOwn(value, key));

/** Finite number or strict numeric string → number; anything else → null. */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+(?:\.\d+)?\s*%?\s*$/.test(value)) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Used percent clamped to 0..100, or null when unknown. */
export function toUsedPercent(value) {
  const n = toFiniteNumber(value);
  return n === null ? null : Math.min(100, Math.max(0, n));
}

/** Remaining whole percent. Floors so the gauge never promises more than is left. */
export function remainingFromUsed(used) {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const clamped = Math.min(100, Math.max(0, used));
  return Math.min(100, Math.max(0, Math.floor(100 - clamped + 1e-9)));
}

function toTimestampMs(value, now) {
  if (typeof value === 'string' && value.trim() && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function toDurationMinutes(value) {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function normalizeWindow(raw, slot, now) {
  if (!isObject(raw)) return null;
  const usedPercent = toUsedPercent(raw.usedPercent ?? raw.used_percent);
  const windowMinutes = toDurationMinutes(raw.windowDurationMins ?? raw.window_minutes ?? raw.windowMinutes);
  let resetsAt = toTimestampMs(raw.resetsAt ?? raw.resets_at, now);
  if (resetsAt === null) {
    const inSeconds = toFiniteNumber(raw.resetsInSeconds ?? raw.resets_in_seconds);
    if (inSeconds !== null && inSeconds >= 0 && Number.isFinite(now)) resetsAt = now + inSeconds * 1000;
  }
  if (usedPercent === null && windowMinutes === null && resetsAt === null) return null;
  return { slot, usedPercent, remainingPercent: remainingFromUsed(usedPercent), windowMinutes, resetsAt };
}

function normalizeCredits(raw) {
  if (!isObject(raw)) return null;
  const credits = {
    hasCredits: typeof raw.hasCredits === 'boolean' ? raw.hasCredits : typeof raw.has_credits === 'boolean' ? raw.has_credits : null,
    unlimited: typeof raw.unlimited === 'boolean' ? raw.unlimited : null,
    balance: toFiniteNumber(raw.balance)
  };
  return credits.hasCredits === null && credits.unlimited === null && credits.balance === null ? null : credits;
}

const safeText = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';

/** Human name for a limit id such as "codex" or "codex_other". */
export function limitDisplayName(limitId, limitName) {
  const name = safeText(limitName);
  if (name) return name;
  const id = safeText(limitId);
  if (!id) return 'Аккаунт';
  const words = id.split(/[_\-\s]+/).filter(Boolean);
  return words.map((word, index) => index === 0 ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
}

function snapshotList(input) {
  if (Array.isArray(input)) return input.filter(isObject).map(snapshot => [null, snapshot]);
  if (!isObject(input)) return [];
  if (Object.hasOwn(input, 'rateLimitsByLimitId') || Object.hasOwn(input, 'rateLimits')) {
    const byId = snapshotList(input.rateLimitsByLimitId);
    return byId.length ? byId : snapshotList(input.rateLimits);
  }
  if (hasAny(input, SNAPSHOT_KEYS) || hasAny(input, WINDOW_KEYS)) return [[null, input]];
  return Object.entries(input).filter(([, value]) => isObject(value)).map(([key, value]) => [key, value]);
}

/**
 * Normalize runtime rate-limit data.
 * @returns {{ status: 'known'|'unknown', windows: object[], summary: object|null,
 *   summaryReason: 'most-restrictive'|'only'|null, credits: object[], spendControlReached: boolean }}
 */
export function normalizeRateLimits(input, { now = Date.now() } = {}) {
  const windows = [], credits = [];
  let spendControlReached = false;
  snapshotList(input).forEach(([key, snapshot], snapshotIndex) => {
    const limitId = safeText(snapshot.limitId ?? snapshot.limit_id) || safeText(key) || '';
    const limitLabel = limitDisplayName(limitId, snapshot.limitName ?? snapshot.limit_name);
    const found = [];
    if (hasAny(snapshot, WINDOW_KEYS)) found.push(normalizeWindow(snapshot, 'window', now));
    found.push(normalizeWindow(snapshot.primary, 'primary', now), normalizeWindow(snapshot.secondary, 'secondary', now));
    if (Array.isArray(snapshot.windows)) snapshot.windows.forEach(entry => found.push(normalizeWindow(entry, 'window', now)));
    found.filter(Boolean).forEach((window, index) => windows.push({
      ...window, id: `${limitId || 'limit-' + snapshotIndex}:${window.slot}:${index}`, limitId, limitLabel
    }));
    const credit = normalizeCredits(snapshot.credits);
    if (credit) credits.push({ ...credit, limitId, limitLabel });
    if ((snapshot.spendControlReached ?? snapshot.spend_control_reached) === true) spendControlReached = true;
  });
  const known = windows.filter(window => window.remainingPercent !== null);
  const summary = known.slice().sort((a, b) =>
    a.remainingPercent - b.remainingPercent || SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot])[0] || null;
  return {
    status: summary ? 'known' : 'unknown',
    windows,
    summary,
    summaryReason: !summary ? null : known.length > 1 ? 'most-restrictive' : 'only',
    credits,
    spendControlReached
  };
}

/** Visual level for a remaining percent. */
export function limitLevel(remaining) {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 10) return 'critical';
  if (remaining <= 30) return 'low';
  return 'ok';
}

const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

/** "5 ч", "неделя", "3 дня", "45 мин"; '' when unknown. */
export function formatWindowPeriod(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes === 10080) return 'неделя';
  if (minutes % 10080 === 0) { const w = minutes / 10080; return `${w} ${plural(w, 'неделя', 'недели', 'недель')}`; }
  if (minutes === 1440) return 'сутки';
  if (minutes % 1440 === 0) { const d = minutes / 1440; return `${d} ${plural(d, 'день', 'дня', 'дней')}`; }
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${Math.round(minutes)} мин`;
}

/** Relative time until reset: "через 45 мин", "через 3 ч", "через 6 дн."; '' when unknown. */
export function formatResetRelative(resetsAt, now = Date.now()) {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || !Number.isFinite(now)) return '';
  const minutes = Math.round((resetsAt - now) / 60000);
  if (minutes <= 0) return 'срок сброса наступил';
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `через ${hours} ч`;
  return `через ${Math.round(hours / 24)} дн.`;
}

/** Brief headline label: "Осталось 53%" or "Остаток неизвестен". */
export function remainingLabel(remaining) {
  return typeof remaining === 'number' && Number.isFinite(remaining) ? `Осталось ${remaining}%` : 'Остаток неизвестен';
}

/** Short title of one window, e.g. "Codex · неделя". */
export function windowTitle(window, { includeLimit = true } = {}) {
  if (!window) return '';
  const period = formatWindowPeriod(window.windowMinutes);
  const slot = window.slot === 'primary' ? 'основное окно' : window.slot === 'secondary' ? 'дополнительное окно' : 'окно';
  const tail = period ? `окно: ${period}` : slot;
  return includeLimit ? `${window.limitLabel} · ${tail}` : tail;
}
