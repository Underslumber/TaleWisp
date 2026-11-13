import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createWorldApiSettings } from '../living-world-api.mjs';

test('API settings never return credentials and access check performs only models GET', async () => {
  const root = mkdtempSync(resolve('.agent/world-api-test-')), key = 'sk-TEST_PRIVATE_CANARY_1234567890'; let calls = 0;
  const settings = createWorldApiSettings(root, { fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(options.headers.Authorization, 'Bearer ' + key); assert.equal(options.body, undefined); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ data: [{ id: 'gpt-6.1-sol' }] }) }; } });
  try {
    const status = settings.save({ apiKey: key, maxOutputTokens: 2048 }); assert.equal(status.configured, true); assert.ok(!JSON.stringify(status).includes(key));
    const checked = await settings.check(); assert.equal(checked.lastCheck.available, true); assert.equal(checked.lastCheck.generationPerformed, false); assert.equal(calls, 1); assert.equal(checked.creditBalanceKnown, false);
    assert.ok(!JSON.stringify(checked).includes(key)); assert.ok(readFileSync(join(root, 'api-private.json'), 'utf8').includes(key));
    assert.throws(() => settings.save({ apiKey: key, endpoint: 'https://attacker.invalid' }), /Неверные/);
    assert.throws(() => settings.save({ maxOutputTokens: 1000000 }), /Лимит/);
    assert.ok(settings.reservation({ text: 'Пример' }) > 2048 * 10 / 1e6);
    assert.throws(() => settings.reservation({ text: 'x'.repeat(200001) }), /велик/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
