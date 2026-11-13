// API credentials stay in the main server, outside every WorldX branch permission root.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get } from 'node:https';
import { getCACertificates } from 'node:tls';
import { worldError } from './living-world-import.mjs';

// Use Windows' trusted CA store as well as Node's bundled roots for this fixed
// endpoint. TLS verification stays enabled; no redirects or custom hosts.
function fetchModels(url, options) {
  if (url !== 'https://api.openai.com/v1/models') throw worldError('Недопустимый адрес проверки OpenAI.');
  return new Promise((resolveResponse, reject) => {
    const request = get(url, { headers: options.headers, signal: options.signal, ca: [...getCACertificates('default'), ...getCACertificates('system')], rejectUnauthorized: true }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; if (text.length > 2_000_000) response.destroy(new Error('Ответ списка моделей слишком велик.')); });
      response.on('error', reject);
      response.on('end', () => resolveResponse({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(text) }));
    });
    request.on('error', error => reject(worldError('Не удалось подключиться к OpenAI API: ' + (error.code || 'network error'), 502)));
  });
}

export function createWorldApiSettings(root, { fetchImpl = fetchModels } = {}) {
  const file = join(root, 'api-private.json');
  const stored = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const credentials = () => { const c = stored(); return { apiKey: c.apiKey || process.env.OPENAI_API_KEY || '', projectId: c.projectId || '', maxOutputTokens: c.maxOutputTokens || 4096 }; };
  const status = () => ({ configured: !!credentials().apiKey, model: 'gpt-6.1-sol', effort: 'medium', maxOutputTokens: credentials().maxOutputTokens,
    creditBalanceKnown: false, creditProgramUrl: 'https://developers.openai.com/api/docs/guides/chatgpt-api-credits',
    pricingUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol', pricingDate: '2026-11-12', inputUsdPerMillion: 2, outputUsdPerMillion: 10,
    lastCheck: stored().lastCheck || null });
  function save(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['apiKey', 'projectId', 'maxOutputTokens'].includes(k))) throw worldError('Неверные параметры API.');
    const c = stored();
    if (body.apiKey) { if (typeof body.apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,1000}$/.test(body.apiKey)) throw worldError('Неверный формат API-ключа.'); c.apiKey = body.apiKey; delete c.lastCheck; }
    if (body.projectId !== undefined) { if (typeof body.projectId !== 'string' || body.projectId && !/^proj_[A-Za-z0-9_-]{1,150}$/.test(body.projectId)) throw worldError('Неверный project ID.'); c.projectId = body.projectId; }
    if (body.maxOutputTokens !== undefined) { if (!Number.isInteger(body.maxOutputTokens) || body.maxOutputTokens < 512 || body.maxOutputTokens > 8192) throw worldError('Лимит ответа: от 512 до 8192 токенов.'); c.maxOutputTokens = body.maxOutputTokens; }
    const temp = file + '.' + randomUUID(); writeFileSync(temp, JSON.stringify(c), { encoding: 'utf8', mode: 0o600, flush: true }); renameSync(temp, file);
    return status();
  }
  async function check() {
    const c = credentials(); if (!c.apiKey) throw worldError('Сначала сохраните API-ключ.', 409);
    const response = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + c.apiKey, ...(c.projectId ? { 'OpenAI-Project': c.projectId } : {}) }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw worldError('OpenAI API отклонил проверку доступа (HTTP ' + response.status + ').', 409);
    const result = await response.json(), available = result.data?.some(m => m.id === 'gpt-6.1-sol');
    const current = stored(); current.lastCheck = { at: new Date().toISOString(), available: !!available, generationPerformed: false };
    const temp = file + '.' + randomUUID(); writeFileSync(temp, JSON.stringify(current), { encoding: 'utf8', mode: 0o600, flush: true }); renameSync(temp, file);
    return status();
  }
  function reservation(packet) {
    const bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8'); if (bytes > 200000) throw worldError('Пакет роли слишком велик для ограниченной API-генерации.', 409);
    // Conservative byte/token bound plus room for the controller's fixed instructions.
    return ((bytes + 4096) * 2 + credentials().maxOutputTokens * 10) / 1_000_000;
  }
  return { status, save, check, credentials, reservation };
}
