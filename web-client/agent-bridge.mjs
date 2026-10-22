import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MAX_LINE_BYTES = 4_000_000;
const DEFAULT_REVISION = process.env.TALEWISP_WORKSPACE_REVISION;
const INTERNAL_TOOL_URL = process.env.TALEWISP_INTERNAL_TOOL_URL;
const INTERNAL_TOOL_TOKEN = process.env.TALEWISP_INTERNAL_TOOL_TOKEN;

function validateConfig() {
  if (!INTERNAL_TOOL_URL || !INTERNAL_TOOL_TOKEN || !DEFAULT_REVISION) throw new Error('Private TaleWisp bridge configuration is incomplete.');
  const url = new URL(INTERNAL_TOOL_URL);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('/api/internal/agent-tool')) throw new Error('Private TaleWisp bridge URL must target the loopback internal tool route.');
  if (INTERNAL_TOOL_TOKEN.length < 32 || /[\r\n]/.test(INTERNAL_TOOL_TOKEN)) throw new Error('Private TaleWisp bridge token is invalid.');
  return url;
}

function protocolError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

export function createBridge({ url = validateConfig(), token = INTERNAL_TOOL_TOKEN, workspaceRevision = DEFAULT_REVISION, fetchImpl = fetch } = {}) {
  let initialized = false;
  let toolsCache = null;
  const toolCall = async (name, args = {}) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: url.origin },
      body: JSON.stringify({ name, arguments: args, workspaceRevision }),
      signal: AbortSignal.timeout(30_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Private TaleWisp tool request failed.');
    return data;
  };
  return {
    async handle(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
      const { method, id, params = {} } = message;
      if (id == null) return null;
      try {
        if (method === 'initialize') {
          initialized = true;
          return { jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'talewisp-private-bridge', version: '0.1.0' } } };
        }
        if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
        if (method === 'tools/list') {
          if (!initialized) return protocolError(id, -32002, 'Initialize the TaleWisp tool bridge first.');
          if (!toolsCache) {
            const catalog = await toolCall('__list_tools', {});
            toolsCache = Array.isArray(catalog.tools) ? catalog.tools : [];
          }
          return { jsonrpc: '2.0', id, result: { tools: toolsCache } };
        }
        if (method === 'tools/call') {
          if (!initialized) return protocolError(id, -32002, 'Initialize the TaleWisp tool bridge first.');
          const name = params.name;
          const tool = toolsCache?.find(item => item.name === name);
          if (!tool) return protocolError(id, -32602, 'Unknown TaleWisp tool.');
          const args = params.arguments ?? {};
          if (!args || typeof args !== 'object' || Array.isArray(args)) return protocolError(id, -32602, 'Tool arguments must be an object.');
          const result = await toolCall(name, args);
          const shaped = result && Array.isArray(result.content) ? result : {
            content: [{ type: 'text', text: JSON.stringify(result?.structuredContent ?? result) }],
            ...(result?.isError ? { isError: true } : {}),
            ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {})
          };
          return { jsonrpc: '2.0', id, result: shaped };
        }
        return protocolError(id, -32601, `Method not found: ${method}`);
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: error.message }], isError: true } };
      }
    },
    async dispatch(line) {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Oversized bridge message.');
      const message = JSON.parse(line);
      const response = await this.handle(message);
      return response ? `${JSON.stringify(response)}\n` : '';
    }
  };
}

export async function runBridge({ input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const url = validateConfig();
  const bridge = createBridge({ url, token: INTERNAL_TOOL_TOKEN, workspaceRevision: DEFAULT_REVISION, fetchImpl });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const outputLine = await bridge.dispatch(line);
      if (outputLine) output.write(outputLine);
    } catch {
      // Keep protocol stdout reserved for MCP. Diagnostics are intentionally private.
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBridge().catch(() => process.exitCode = 1);
}
