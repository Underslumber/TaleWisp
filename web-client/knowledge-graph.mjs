const NODE_LIMIT = 500;
const EDGE_LIMIT = 2000;

const slash = value => String(value ?? '').replaceAll('\\', '/');

function metadataFor(text = '') {
  const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const values = {};
  if (match) for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!pair) continue;
    let value = pair[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[pair[1]] = value;
  }
  return values;
}

function titleFor(file, metadata) {
  if (metadata.title) return String(metadata.title);
  const body = String(file.text ?? '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
  const heading = body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  return heading || String(file.path).replace(/\.(?:md|markdown|txt)$/i, '').split('/').at(-1);
}

function folderGroups(paths) {
  const groups = new Map();
  for (const path of paths) {
    const folders = path.split('/').slice(0, -1);
    let parentId = null;
    for (let i = 0; i < folders.length; i++) {
      const relativeFolder = folders.slice(0, i + 1).join('/');
      const id = `folder:${relativeFolder}`;
      if (!groups.has(id)) groups.set(id, { id, label: folders[i], parentId });
      parentId = id;
    }
  }
  return [...groups.values()];
}

/** Build a graph only from rows already selected and read by the workspace service. */
export function buildKnowledgeGraph({ files = [], scope = 'active', selection = null, resolveTarget, sourceTruncated = false, totalNodes = files.length, maxNodes = NODE_LIMIT, maxEdges = EDGE_LIMIT } = {}) {
  if (typeof resolveTarget !== 'function') throw new TypeError('resolveTarget must be a function.');
  const ordered = [...files].map(file => ({ ...file, path: slash(file.path) })).sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  const returned = ordered.slice(0, maxNodes);
  const visiblePaths = new Set(returned.map(file => file.path));
  const nodes = returned.map(file => {
    const meta = metadataFor(file.text);
    return {
      id: file.path,
      path: file.path,
      title: titleFor(file, meta),
      type: String(meta.type || 'note'),
      recordKind: String(meta.record_kind || ''),
      status: String(meta.status || meta.canon_status || 'unmarked'),
      groupId: file.path.includes('/') ? `folder:${file.path.split('/').slice(0, -1).join('/')}` : null,
      linksCount: 0
    };
  });
  const nodeByPath = new Map(nodes.map(node => [node.path, node]));
  const edges = [];
  const edgeKeys = new Set();
  let unresolvedCount = 0;
  let ambiguousCount = 0;
  let edgeTruncated = false;
  for (const file of returned) {
    const node = nodeByPath.get(file.path);
    const wiki = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = wiki.exec(String(file.text ?? '')))) {
      node.linksCount++;
      const result = resolveTarget(match[1], file.path);
      if (result?.status === 'ambiguous') { ambiguousCount++; continue; }
      if (result?.status !== 'resolved') { unresolvedCount++; continue; }
      const target = slash(result.path);
      if (!visiblePaths.has(target)) continue;
      if (target === file.path) continue;
      const id = `${file.path}\u0000${target}\u0000wikilink`;
      if (edgeKeys.has(id)) continue;
      if (edges.length >= maxEdges) { edgeTruncated = true; continue; }
      edgeKeys.add(id);
      edges.push({ id: `${file.path}->${target}:wikilink`, source: file.path, target, kind: 'wikilink' });
    }
  }
  return {
    nodes,
    edges,
    groups: folderGroups(returned.map(file => file.path)),
    scope: scope === 'unassigned' ? 'unassigned' : 'active',
    selection: scope === 'unassigned' ? null : selection,
    truncated: sourceTruncated || ordered.length > returned.length || edgeTruncated,
    unresolvedCount,
    ambiguousCount,
    totalNodes
  };
}
