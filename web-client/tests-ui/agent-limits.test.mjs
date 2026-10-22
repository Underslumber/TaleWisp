import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRateLimits, remainingFromUsed, toUsedPercent, limitLevel, formatWindowPeriod,
  formatResetRelative, remainingLabel, windowTitle, limitDisplayName
} from '../public/agent-limits.js';

const RESET_SECONDS = 1761040800; // epoch seconds, as the Codex app-server sends resetsAt
const NOW = RESET_SECONDS * 1000 - 45 * 60000;

// Shape forwarded by agent.mjs: `limits = rateLimitsByLimitId ?? rateLimits`.
const codexByLimitId = {
  codex: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: RESET_SECONDS },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: RESET_SECONDS + 5 * 86400 },
    credits: { hasCredits: true, unlimited: false, balance: '0' },
    planType: 'plus', accessToken: 'secret-token-must-not-leak'
  }
};

test('Codex byLimitId fixture: 47% used is reported as 53% remaining, never 47% remaining', () => {
  const result = normalizeRateLimits(codexByLimitId, { now: NOW });
  assert.equal(result.status, 'known');
  assert.equal(result.windows.length, 2);
  assert.equal(result.summary.slot, 'primary');
  assert.equal(result.summary.usedPercent, 47);
  assert.equal(result.summary.remainingPercent, 53);
  assert.equal(result.summaryReason, 'most-restrictive');
  assert.equal(remainingLabel(result.summary.remainingPercent), 'Осталось 53%');
  assert.notEqual(remainingLabel(result.summary.remainingPercent), 'Осталось 47%');
  assert.equal(result.summary.resetsAt, RESET_SECONDS * 1000, 'epoch seconds become milliseconds');
  assert.equal(formatResetRelative(result.summary.resetsAt, NOW), 'через 45 мин');
  assert.equal(windowTitle(result.summary), 'Codex · окно: 5 ч');
  assert.equal(windowTitle(result.windows[1]), 'Codex · окно: неделя');
});

test('only selected fields survive normalization (no plan, tokens or raw keys)', () => {
  const serialized = JSON.stringify(normalizeRateLimits(codexByLimitId, { now: NOW }));
  assert.doesNotMatch(serialized, /secret-token|accessToken|planType|plus/);
});

test('app-server read wrapper: byLimitId wins, falls back to the single snapshot', () => {
  const snapshot = { primary: { usedPercent: 80, windowDurationMins: 60 } };
  assert.equal(normalizeRateLimits({ rateLimits: snapshot, rateLimitsByLimitId: null }).summary.remainingPercent, 20);
  const both = normalizeRateLimits({ rateLimits: snapshot, rateLimitsByLimitId: codexByLimitId }, { now: NOW });
  assert.equal(both.windows.length, 2, 'the same data is not counted twice');
  assert.equal(both.summary.remainingPercent, 53);
});

test('absent, null and garbage data are unknown, not zero', () => {
  for (const input of [undefined, null, '', 'codex: 47%', 42, true, {}, [], { rateLimits: null, rateLimitsByLimitId: null }]) {
    const result = normalizeRateLimits(input);
    assert.equal(result.status, 'unknown', JSON.stringify(input));
    assert.equal(result.summary, null);
    assert.deepEqual(result.windows, []);
  }
  assert.equal(remainingLabel(null), 'Остаток неизвестен');
  assert.equal(limitLevel(null), 'unknown');
});

test('a window without a valid percentage stays visible as unknown', () => {
  for (const usedPercent of [undefined, null, 'abc', true, {}, [], NaN, Infinity, -Infinity]) {
    const result = normalizeRateLimits({ codex: { primary: { usedPercent, windowDurationMins: 300 } } });
    assert.equal(result.status, 'unknown', String(usedPercent));
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].remainingPercent, null);
    assert.equal(result.windows[0].windowMinutes, 300);
  }
});

test('0% used is 100% remaining and 100% used is 0% remaining (known, not unknown)', () => {
  const fresh = normalizeRateLimits({ primary: { usedPercent: 0 } });
  assert.equal(fresh.status, 'known');
  assert.equal(fresh.summary.remainingPercent, 100);
  const spent = normalizeRateLimits({ primary: { usedPercent: 100 } });
  assert.equal(spent.status, 'known');
  assert.equal(spent.summary.remainingPercent, 0);
  assert.equal(remainingLabel(0), 'Осталось 0%');
  assert.equal(limitLevel(0), 'critical');
});

test('out-of-range and fractional percentages are clamped and floored', () => {
  assert.equal(toUsedPercent(-20), 0);
  assert.equal(toUsedPercent(140), 100);
  assert.equal(toUsedPercent('47'), 47);
  assert.equal(toUsedPercent('47 %'), 47);
  assert.equal(toUsedPercent('47abc'), null);
  assert.equal(remainingFromUsed(47.4), 52, 'never promise more than is left');
  assert.equal(remainingFromUsed(47), 53);
  assert.equal(remainingFromUsed(NaN), null);
  assert.equal(remainingFromUsed('47'), null);
  assert.equal(normalizeRateLimits({ primary: { usedPercent: -5 } }).summary.remainingPercent, 100);
  assert.equal(normalizeRateLimits({ primary: { usedPercent: 250 } }).summary.remainingPercent, 0);
});

test('multiple capped windows: summary is the most restrictive, primary wins a tie', () => {
  const result = normalizeRateLimits({
    codex: { primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } },
    codex_other: { limitName: 'GPT-6.1-Sol', primary: { usedPercent: 30, windowDurationMins: 300 } }
  });
  assert.equal(result.windows.length, 3);
  assert.equal(result.summary.remainingPercent, 0);
  assert.equal(result.summary.slot, 'primary');
  assert.equal(result.summary.limitId, 'codex');
  assert.equal(result.summaryReason, 'most-restrictive');
  assert.equal(result.windows[2].limitLabel, 'GPT-6.1-Sol');
  assert.equal(limitDisplayName('codex_other'), 'Codex other');
});

test('secondary window is chosen when it is the stricter one', () => {
  const result = normalizeRateLimits({ codex: { primary: { usedPercent: 10 }, secondary: { usedPercent: 91 } } });
  assert.equal(result.summary.slot, 'secondary');
  assert.equal(result.summary.remainingPercent, 9);
  assert.equal(limitLevel(9), 'critical');
});

test('a single known window is labelled as the only window', () => {
  const result = normalizeRateLimits({ codex: { primary: { usedPercent: 47 }, secondary: { usedPercent: 'n/a', windowDurationMins: 10080 } } });
  assert.equal(result.summary.remainingPercent, 53);
  assert.equal(result.summaryReason, 'only');
  assert.equal(result.windows.length, 2, 'the unknown window is still listed in details');
});

test('legacy snake_case, windows[] arrays and relative resets are supported', () => {
  const legacy = normalizeRateLimits({ primary: { used_percent: 20, window_minutes: 60, resets_at: RESET_SECONDS } }, { now: NOW });
  assert.equal(legacy.summary.remainingPercent, 80);
  assert.equal(legacy.summary.windowMinutes, 60);
  assert.equal(legacy.summary.resetsAt, RESET_SECONDS * 1000);
  const list = normalizeRateLimits([{ limitId: 'a', windows: [{ usedPercent: 5, resetsInSeconds: 7200 }] }], { now: NOW });
  assert.equal(list.summary.remainingPercent, 95);
  assert.equal(formatResetRelative(list.summary.resetsAt, NOW), 'через 2 ч');
  const iso = normalizeRateLimits({ primary: { usedPercent: 1, resetsAt: '2026-10-21T12:00:00Z' } });
  assert.equal(iso.summary.resetsAt, Date.parse('2026-10-21T12:00:00Z'));
  const bad = normalizeRateLimits({ primary: { usedPercent: 1, resetsAt: 'tomorrow-ish', windowDurationMins: -5 } });
  assert.equal(bad.summary.resetsAt, null);
  assert.equal(bad.summary.windowMinutes, null);
});

test('credits stay in details and never imply unlimited quota', () => {
  const onlyCredits = normalizeRateLimits({ codex: { credits: { hasCredits: true, unlimited: true, balance: '12.5' } } });
  assert.equal(onlyCredits.status, 'unknown', 'unlimited credits are not an unlimited quota');
  assert.equal(onlyCredits.summary, null);
  assert.deepEqual(onlyCredits.credits.map(({ hasCredits, unlimited, balance }) => ({ hasCredits, unlimited, balance })), [{ hasCredits: true, unlimited: true, balance: 12.5 }]);
  const reached = normalizeRateLimits({ codex: { primary: { usedPercent: 10 }, spendControlReached: true } });
  assert.equal(reached.spendControlReached, true);
  assert.equal(reached.summary.remainingPercent, 90);
});

test('period and reset formatters', () => {
  assert.equal(formatWindowPeriod(300), '5 ч');
  assert.equal(formatWindowPeriod(10080), 'неделя');
  assert.equal(formatWindowPeriod(20160), '2 недели');
  assert.equal(formatWindowPeriod(1440), 'сутки');
  assert.equal(formatWindowPeriod(4320), '3 дня');
  assert.equal(formatWindowPeriod(45), '45 мин');
  assert.equal(formatWindowPeriod(null), '');
  assert.equal(formatWindowPeriod(NaN), '');
  assert.equal(formatResetRelative(NOW - 1000, NOW), 'срок сброса наступил');
  assert.equal(formatResetRelative(NOW + 3 * 86400000, NOW), 'через 3 дн.');
  assert.equal(formatResetRelative(null, NOW), '');
});

test('long or control-character limit names are sanitized', () => {
  const name = limitDisplayName('x', 'Лимит\u0000\u001b[31m' + 'я'.repeat(100));
  assert.doesNotMatch(name, /[\u0000-\u001f]/);
  assert.ok(name.length <= 60);
  assert.equal(limitDisplayName('', ''), 'Аккаунт');
});
