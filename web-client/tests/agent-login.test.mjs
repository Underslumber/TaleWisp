import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../agent.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'talewisp-agent-login-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new Map();
  const store = { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => settings.set(key, value), listMessages: () => [], addMessage() {} };
  const calls = [];
  let accountReads = 0;
  const runner = new EventEmitter();
  runner.closed = false;
  runner.effectiveConfig = { config: { sandbox_mode: 'read-only', approval_policy: 'never', features: { shell_tool: false, apps: false, multi_agent: false }, agents: { enabled: false }, mcp_servers: { talewisp: { enabled: true, required: true, enabled_tools: ['talewisp_project_status', 'talewisp_onboarding_status', 'talewisp_list_files', 'talewisp_read_file', 'talewisp_search', 'talewisp_scene_context'] } } } };
  runner.initialize = async () => {};
  runner.request = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'account/read') return ++accountReads > 1 ? { account: { type: 'chatgpt', email: 'writer@example.test', planType: 'plus' } } : { account: null };
    if (method === 'model/list') return { data: [{ id: 'chatgpt-subscription-model', displayName: 'ChatGPT model' }] };
    if (method === 'account/login/start') return params.type === 'chatgptDeviceCode' ? { verificationUrl: 'https://auth.example.test/device', userCode: 'ABCD-EFGH', loginId: 'login-1' } : { authUrl: 'https://auth.example.test/login' };
    if (method === 'account/rateLimits/read') return {};
    return {};
  };
  runner.stop = async () => { runner.closed = true; };
  const agent = new AgentService({ dataDir: join(root, 'data'), store, vaultPath: join(root, 'vault'), talewispMcpPath: join(root, 'mcp.py'), runnerFactory: () => runner });
  return { agent, runner, calls };
}

test('ChatGPT sign-in refreshes account and subscription model catalog only after successful completion', async t => {
  const { agent, runner, calls } = fixture(t);
  const started = await agent.login();
  assert.equal(started.authUrl, 'https://auth.example.test/login');
  assert.equal(agent.status().authenticated, false);
  assert.equal(agent.status().loginPending, true);

  agent._notification({ method: 'account/login/completed', params: { success: true } });
  await agent.refreshPromise;

  assert.equal(agent.status().authenticated, true);
  assert.equal(agent.status().loginPending, false);
  assert.deepEqual(agent.status().models, [{ id: 'chatgpt-subscription-model', displayName: 'ChatGPT model', supportedReasoningEfforts: [] }]);
  assert.equal(calls.some(({ method, params }) => method === 'account/read' && params.refreshToken === true), true);
  assert.equal(calls.some(({ method }) => method === 'model/list'), true);
  await runner.stop();
});

test('failed login completion clears pending state and reports a retryable sign-in error', async t => {
  const { agent, runner } = fixture(t);
  await agent.login();
  agent._notification({ method: 'account/login/completed', params: { success: false } });
  assert.equal(agent.status().loginPending, false);
  assert.match(agent.status().error, /Вход в ChatGPT не завершён/);
  await runner.stop();
});

test('device-code sign-in uses only the app-server device-code mode', async t => {
  const { agent, runner, calls } = fixture(t);
  const started = await agent.login({ method: 'device' });
  assert.equal(started.verificationUrl, 'https://auth.example.test/device');
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.equal(started.loginId, 'login-1');
  const request = calls.find(({ method }) => method === 'account/login/start');
  assert.deepEqual(request.params, { type: 'chatgptDeviceCode' });
  await runner.stop();
});
