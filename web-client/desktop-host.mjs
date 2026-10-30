import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MCP_SCRIPT = 'C:/Users/Hatzy/.codex/plugins/cache/openai-bundled/codex-app-tools/26.1023.51421/server.mjs';
const ALLOWED_TOOLS = new Set([
  'list_projects', 'create_thread', 'send_message_to_thread', 'read_thread', 'wait_threads',
]);
const MAX_LINE = 1024 * 1024;
const MAX_ERROR = 500;

function shortError(value) {
  const text = String(value?.message ?? value ?? 'Desktop host request failed')
    .replace(/[\r\n\t]+/g, ' ').slice(0, MAX_ERROR);
  return new Error(text || 'Desktop host request failed');
}

function parseToolPayload(result) {
  if (!result || result.isError) throw shortError(result?.content?.map(x => x.text || '').join(' ') || 'Desktop host rejected the request');
  const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';
  if (!text) return result.structuredContent ?? {};
  try { return JSON.parse(text); } catch { return { text: text.slice(0, 20000) }; }
}

/** Narrow client for the official bundled desktop MCP server. The caller identity is inherited. */
export class DesktopHostClient {
  constructor({ env = process.env, spawnImpl = spawn, timeoutMs = 20000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (!env.CODEX_APP_TOOLS_PIPE_PATH || !env.CODEX_THREAD_ID) {
      throw new Error('The inherited Codex desktop bridge is unavailable in this process.');
    }
    this.env = env;
    this.threadId = env.CODEX_THREAD_ID;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = Math.min(Math.max(timeoutMs, 1000), 60000);
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.child = null;
    this.nextId = 0;
    this.pending = new Map();
    this.ready = null;
    this.closed = false;
  }

  async _start() {
    if (this.closed) throw new Error('Desktop host client is closed.');
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(this.env.CODEX_MCP_NODE_PATH || process.execPath, [MCP_SCRIPT], {
          env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) { reject(shortError(error)); return; }
      this.child = child;
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        if (line.length > MAX_LINE) { this._failAll('Desktop host returned an oversized protocol line.'); return; }
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id === undefined) return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(shortError(message.error.message));
        else waiter.resolve(message.result);
      });
      child.stderr?.resume();
      child.once('error', error => { this._failAll(error); reject(shortError(error)); });
      child.once('exit', code => {
        this._failAll(`Desktop host process exited (${Number.isInteger(code) ? code : 'unknown'}).`);
      });
      this._rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'talewisp-storyart-bridge', version: '1.0.0' },
      }).then(() => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
        resolve();
      }, error => reject(error));
    });
    try { await this.ready; } catch (error) {
      this.ready = null;
      this._failAll(error);
      if (this.child && !this.child.killed) this.child.kill();
      this.child = null;
      throw error;
    }
  }

  _failAll(error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(shortError(error)); }
    this.pending.clear();
  }

  _rpc(method, params, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed || !child.stdin.writable) return reject(new Error('Desktop host process is unavailable.'));
      const id = ++this.nextId;
      const boundedTimeout = Math.min(Math.max(timeoutMs, 1000), 65000);
      const timer = this.setTimeoutImpl(() => {
        this.pending.delete(id);
        reject(new Error('Desktop host request timed out.'));
      }, boundedTimeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (!error) return;
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id); this.clearTimeoutImpl(timer); reject(shortError(error));
      });
    });
  }

  async _call(name, args = {}, rpcTimeoutMs = this.timeoutMs) {
    if (!ALLOWED_TOOLS.has(name)) throw new Error('This desktop host operation is not allowed.');
    await this._start();
    const response = await this._rpc('tools/call', {
      name, arguments: args, _meta: { 'openai/threadId': this.threadId },
    }, rpcTimeoutMs);
    return parseToolPayload(response);
  }

  async listTools() {
    await this._start();
    const result = await this._rpc('tools/list', {});
    const names = Array.isArray(result?.tools) ? result.tools.map(tool => tool.name).filter(name => ALLOWED_TOOLS.has(name)) : [];
    return [...new Set(names)];
  }

  async listProjects() { return this._call('list_projects', {}); }
  async createThread(args) { return this._call('create_thread', args); }
  async sendMessage(args) { return this._call('send_message_to_thread', args); }
  async readThread(args) { return this._call('read_thread', args); }
  async waitThreads(input = {}) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['targets', 'timeoutMs'].includes(key))) {
      throw new Error('StoryArt wait accepts only the owned thread ID and a bounded timeout.');
    }
    const { targets, timeoutMs = 0 } = input;
    if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0]?.threadId !== 'string'
      || !targets[0].threadId || targets[0].threadId.length > 200
      || Object.keys(targets[0]).some(key => key !== 'threadId')) {
      throw new Error('StoryArt wait requires exactly one owned thread ID.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) {
      throw new Error('StoryArt wait timeout must be an integer from 0 to 60000 milliseconds.');
    }
    const boundedArgs = { targets: [{ threadId: targets[0].threadId }], timeoutMs };
    const rpcTimeoutMs = Math.max(this.timeoutMs, timeoutMs + 5000);
    return this._call('wait_threads', boundedArgs, rpcTimeoutMs);
  }

  async close() {
    this.closed = true;
    this._failAll('Desktop host client closed.');
    if (this.child && !this.child.killed) {
      this.child.kill();
      await new Promise(resolve => {
        if (this.child.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 1000);
        this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.child = null; this.ready = null;
  }
}

export function createDesktopHostClient(options) { return new DesktopHostClient(options); }

