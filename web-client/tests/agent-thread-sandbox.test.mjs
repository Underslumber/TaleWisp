import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../agent.mjs';

test('thread start uses installed read-only SandboxMode while turn start keeps SandboxPolicy readOnly', async t => {
  const root = mkdtempSync(join(tmpdir(), 'talewisp-agent-thread-sandbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new Map();
  const store = {
    getSetting: key => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
    listMessages: () => [],
    addMessage() {},
  };
  const calls = [];
  const runner = {
    closed: false,
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'model/list') return { data: [{ id: 'fixture-model' }] };
      if (method === 'thread/start') return { thread: { id: 'fixture-thread' } };
      return {};
    },
  };
  const agent = new AgentService({ dataDir: join(root, 'data'), store, runnerFactory: () => runner });
  agent.runner = runner;

  await agent.message({ text: 'Fixture request' });

  const thread = calls.find(call => call.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal(thread.params.approvalPolicy, 'never');
  const turn = calls.find(call => call.method === 'turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  agent._completeTurn();
});
