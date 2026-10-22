import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopHostClient } from '../desktop-host.mjs';

test('desktop bridge requires inherited host identity and pipe', () => {
  assert.throws(() => new DesktopHostClient({ env: {} }), /inherited Codex desktop bridge/);
  const client = new DesktopHostClient({ env: { CODEX_APP_TOOLS_PIPE_PATH: 'inherited', CODEX_THREAD_ID: 'actual-thread' } });
  assert.equal(client.threadId, 'actual-thread');
});

test('desktop bridge rejects arbitrary MCP tool names before starting a child', async () => {
  const client = new DesktopHostClient({
    env: { CODEX_APP_TOOLS_PIPE_PATH: 'inherited', CODEX_THREAD_ID: 'actual-thread' },
    spawnImpl: () => { throw new Error('must not start'); },
  });
  await assert.rejects(client._call('filesystem_read', {}), /not allowed/);
});

test('desktop bridge bounds surfaced errors', async () => {
  const client = new DesktopHostClient({
    env: { CODEX_APP_TOOLS_PIPE_PATH: 'inherited', CODEX_THREAD_ID: 'actual-thread' },
    spawnImpl: () => { throw new Error('x'.repeat(2000)); },
  });
  await assert.rejects(client.listProjects(), error => error.message.length <= 500);
});

test('wait_threads receives its bounded host timeout plus five-second RPC margin', async () => {
  const delays = [];
  const writes = [];
  const client = new DesktopHostClient({
    env: { CODEX_APP_TOOLS_PIPE_PATH: 'inherited', CODEX_THREAD_ID: 'actual-thread' },
    setTimeoutImpl: (_callback, delay) => { delays.push(delay); return delays.length; },
    clearTimeoutImpl: () => {},
  });
  client.ready = Promise.resolve();
  client.child = {
    killed: false,
    stdin: { writable: true, write: line => { writes.push(JSON.parse(line)); } },
  };

  const wait = client.waitThreads({ targets: [{ threadId: 'owned-storyart-thread' }], timeoutMs: 60000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delays, [65000]);
  assert.deepEqual(writes[0].params.arguments, { targets: [{ threadId: 'owned-storyart-thread' }], timeoutMs: 60000 });
  assert.equal(writes[0].params._meta['openai/threadId'], 'actual-thread');
  const [id, pending] = [...client.pending.entries()][0];
  client.pending.delete(id);
  pending.resolve({ content: [{ type: 'text', text: '{"status":"complete"}' }] });
  assert.deepEqual(await wait, { status: 'complete' });

  const ordinary = client._rpc('ordinary', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delays, [65000, 20000]);
  const [ordinaryId, ordinaryPending] = [...client.pending.entries()][0];
  client.pending.delete(ordinaryId);
  ordinaryPending.resolve({ ok: true });
  assert.deepEqual(await ordinary, { ok: true });
});

test('wait_threads rejects unbounded timeout values and caller-supplied extra parameters', async () => {
  const client = new DesktopHostClient({ env: { CODEX_APP_TOOLS_PIPE_PATH: 'inherited', CODEX_THREAD_ID: 'actual-thread' } });
  await assert.rejects(client.waitThreads({ targets: [{ threadId: 'owned' }], timeoutMs: 60001 }), /integer from 0 to 60000/);
  await assert.rejects(client.waitThreads({ targets: [{ threadId: 'owned', hostId: 'other' }], timeoutMs: 1 }), /exactly one owned thread ID/);
});

