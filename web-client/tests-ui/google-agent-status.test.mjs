import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_AGENT_API_PREFIX, googleAgentStatusText } from '../public/google-agent-status.js';

test('agent connection state comes only from the independent agent endpoint contract', () => {
  assert.equal(GOOGLE_AGENT_API_PREFIX, '/api/google/agent');
  assert.match(googleAgentStatusText({ configured: true, authenticated: false, google: { authenticated: true } }), /не подключён/);
  assert.match(googleAgentStatusText({ configured: true, authenticated: true }), /отдельную OAuth авторизацию/);
});

test('missing or unconfigured agent status never appears connected', () => {
  assert.match(googleAgentStatusText(null), /не подтверждён/);
  assert.match(googleAgentStatusText({ configured: false, authenticated: false }), /не настроен/);
});
