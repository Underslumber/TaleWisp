// Conditional requests and compression for files under public/. Every asset is still revalidated
// on each load (cache-control: no-cache), but an unchanged file answers 304 with no body, and text
// assets travel gzipped. Compressed bodies are kept in memory and rebuilt when the file changes.
import { readFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt', '.md', '.ttf']);
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;

export const acceptsGzip = header => String(header ?? '').split(',').some(part => {
  const [name, ...params] = part.trim().toLowerCase().split(';').map(item => item.trim());
  if (name !== 'gzip' && name !== '*') return false;
  const q = params.find(param => param.startsWith('q='));
  return !q || Number(q.slice(2)) > 0;
});

export const etagMatches = (header, etag) => String(header ?? '').split(',').some(part => {
  const value = part.trim();
  return value === '*' || value === etag || value === `W/${etag}`;
});

export function createStaticAssets({ readFileImpl = readFile, maxCachedBytes = 32 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let cachedBytes = 0;
  const drop = key => { const old = cache.get(key); if (old) { cache.delete(key); cachedBytes -= old.body.length; } };
  /** Returns the validator and, for a compressible file the client accepts gzipped, the gzipped body. */
  async function describe({ file, extension, stat, acceptEncoding }) {
    const version = `${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}`;
    const compress = COMPRESSIBLE.has(extension) && stat.size >= MIN_COMPRESS_BYTES && stat.size <= MAX_COMPRESS_BYTES && acceptsGzip(acceptEncoding);
    if (!compress) return { etag: `"${version}"`, body: null, compressible: COMPRESSIBLE.has(extension) };
    let entry = cache.get(file);
    if (!entry || entry.version !== version) {
      const body = await gzipAsync(await readFileImpl(file));
      drop(file);
      entry = { version, body };
      cache.set(file, entry); cachedBytes += body.length;
      for (const key of cache.keys()) { if (cachedBytes <= maxCachedBytes || key === file) break; drop(key); }
    }
    return { etag: `"${version}-gz"`, body: entry.body, compressible: true };
  }
  return { describe };
}
