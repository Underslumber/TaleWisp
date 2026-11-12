import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join, resolve, sep } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 1000;
const MAX_RELATED = 5000;
const MAX_SOURCE_FILES = 3000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_DEPTH = 12;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const MAX_SECTION_CHARS = 256 * 1024;
const SOURCE_METADATA_FIELDS = new Set(['record_kind','id','line_id','identity','identity_parent','character_period','work_title','narrative_status','updated','status','scope','valid_from','valid_until']);
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const categories = [
  ['knowledge:root','Знания',null], ['category:world','Мир','knowledge:root'], ['category:history','История','knowledge:root'],
  ['category:rules','Правила','category:world'], ['category:entities','Сущности','category:world'],
  ['category:plot','Сюжет','category:history'], ['category:characters','Персонажи','category:history'],
  ['category:main-characters','Главные','category:characters'], ['category:secondary-characters','Второстепенные','category:characters'], ['category:extras','Массовка','category:characters']
].map(([id,title,parentId]) => ({id,title,parentId,kind:parentId===null||id.startsWith('category:')?'category':'category',type:'category',status:'navigation',definition:'',sourceRefs:[]}));
const isInside = (root, target) => target === root || target.startsWith(root + sep);
const validateRelative = (root, path, safePath) => {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Concept source path must be a safe relative path.');
  if (!['.md','.markdown','.txt'].includes(extname(path).toLowerCase()) || path.split('/').some(part => part.startsWith('.') || /^(?:config(?:uration)?|credentials?|secrets?|internal|служебное|node_modules)$/i.test(part))) fail('Concept source path is not an allowed story text source.');
  let target;
  try { target = safePath(root, path); } catch { fail('Concept source path is unavailable or unsafe.'); }
  if (!isInside(resolve(root), resolve(target)) || !lstatSync(target).isFile()) fail('Concept source path must resolve to a regular file in the active series.');
  return path;
};
const validateGoogleDoc = url => {
  if (typeof url !== 'string') fail('External concept references must be Google Docs URLs.');
  let parsed; try { parsed = new URL(url); } catch { fail('External concept reference URL is invalid.'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.google.com' || parsed.username || parsed.password || !/^\/document\/d\/[A-Za-z0-9_-]+(?:\/|$)/.test(parsed.pathname)) fail('External concept references must be credential-free Google Docs document URLs.');
  return url;
};

// Project only explicit structured records. Chapter prose and service files are
// not graph entries; symlinks and hidden/service trees are never traversed.
function liveSourceRecords(root) {
  const records = [];
  let totalBytes = 0, visited = 0;
  const walk = (directory, depth) => {
    if (depth > MAX_SOURCE_DEPTH) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || /^(?:node_modules|99_Служебное|служебное)$/i.test(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
      if (++visited > MAX_SOURCE_FILES) fail('Live concept source scan exceeded its file limit.');
      const st = statSync(full);
      totalBytes += st.size;
      if (totalBytes > MAX_SOURCE_BYTES) fail('Live concept sources exceeded their byte limit.');
      const path = full.slice(root.length + 1).split(sep).join('/');
      const text = readFileSync(full, 'utf8');
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) continue;
      const fields = Object.create(null);
      for (const line of match[1].split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
        if (m) fields[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
      }
      const id = fields.id, lineId = fields.line_id, recordKind = fields.record_kind;
      if (!(recordKind === 'entity' && id) && !(recordKind === 'book-plot-line' && lineId)) continue;
      const body = text.slice(match[0].length);
      const title = fields.title || body.match(/^\s*#\s+(.+?)\s*$/m)?.[1] || entry.name.replace(/\.md$/i, '');
      records.push({ fields, id: recordKind === 'entity' ? id : lineId, kind: recordKind, path, title, body: body.trim(), archived: /(?:^|[,\[\s])archive-version(?:$|[,\]\s])/i.test(fields.narrative_status || ''), bytes: st.size });
    }
  };
  walk(root, 0);
  return records;
}

const normalizedText = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
const headingSlug = value => String(value ?? '').toLocaleLowerCase('ru').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
function markdownHeadings(text) {
  const rows = [];
  const pattern = /^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*\r?$/gm;
  for (const match of text.matchAll(pattern)) {
    const title = match[2].trim();
    rows.push({ level:match[1].length, title, slug:headingSlug(title), start:match.index, end:match.index + match[0].length });
  }
  return rows;
}
function sourceDocument(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = Object.create(null);
  for (const line of front?.[1]?.split(/\r?\n/) || []) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*?)\s*$/);
    if (m) fields[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const body = front ? text.slice(front[0].length) : text;
  const title = fields.title || body.match(/^\s*#\s+(.+?)\s*$/m)?.[1] || '';
  return { fields, body, title, headings:markdownHeadings(body) };
}
function extractBoundText(body, binding) {
  if (binding.wholeDocument === true) return body && body.length <= MAX_SECTION_CHARS ? body : null;
  if (binding.anchor) {
    const headings = markdownHeadings(body), heading = headings.find(item => item.slug === binding.anchor);
    if (!heading) return null;
    const next = headings.find(item => item.start > heading.start && item.level <= heading.level);
    const text = body.slice(heading.end, next?.start ?? body.length).trim();
    return text && text.length <= MAX_SECTION_CHARS ? text : null;
  }
  if (Number.isInteger(binding.paragraphIndex)) {
    const paragraphs = body.split(/\r?\n\s*\r?\n/).map(part => part.trim()).filter(Boolean);
    const text = paragraphs[binding.paragraphIndex];
    return text && text.length <= MAX_SECTION_CHARS ? text : null;
  }
  return null;
}
function deriveBinding(definition, sourceText, refAnchor) {
  const document = sourceDocument(sourceText);
  const requestedAnchor = definition.anchor || refAnchor;
  if (requestedAnchor) {
    const heading = document.headings.find(item => item.slug === headingSlug(requestedAnchor));
    return heading ? { anchor:heading.slug, sourceTitle:heading.title } : null;
  }
  const needle = normalizedText(definition.text);
  if (!needle) return null;
  // Bind to the unique smallest heading section (or paragraph) containing the
  // currently accepted excerpt. Never guess from the graph node's title.
  const headings = document.headings;
  const matchingSections = [];
  for (const heading of headings) {
    const next = headings.find(item => item.start > heading.start && item.level <= heading.level);
    const section = document.body.slice(heading.end, next?.start ?? document.body.length).trim();
    if (normalizedText(section).includes(needle)) matchingSections.push(heading);
  }
  if (matchingSections.length) {
    const deepest = Math.max(...matchingSections.map(item => item.level));
    const specific = matchingSections.filter(item => item.level === deepest);
    return specific.length === 1 ? { anchor:specific[0].slug, sourceTitle:specific[0].title } : null;
  }
  const paragraphs = document.body.split(/\r?\n\s*\r?\n/).map(part => part.trim()).filter(Boolean);
  const matches = paragraphs.map((text, paragraphIndex) => ({text,paragraphIndex})).filter(item => normalizedText(item.text).includes(needle));
  return matches.length === 1 ? { paragraphIndex:matches[0].paragraphIndex, sourceTitle:definition.sourceTitle } : null;
}
function bindingFile(dataDir, seriesId) {
  const directory = resolve(dataDir, 'knowledge-derived-bindings'), path = resolve(directory, `${seriesId}.json`);
  if (!isInside(resolve(dataDir), directory) || !isInside(directory, path)) fail('Concept binding path is invalid.');
  for (const part of [resolve(dataDir), directory, path]) if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail('Concept binding path cannot pass through symbolic links.');
  return { directory, path };
}
function loadBindings(dataDir, seriesId) {
  const { path } = bindingFile(dataDir, seriesId);
  if (!existsSync(path)) return { path, bindings:[] };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BINDINGS_BYTES) fail('Concept binding cache is not a bounded regular file.');
  let parsed; try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('Concept binding cache JSON is invalid.'); }
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.bindings) || parsed.bindings.length > MAX_NODES * 100) fail('Concept binding cache has an unsupported schema.');
  return { path, bindings:parsed.bindings.filter(item => item && typeof item.nodeId === 'string' && Number.isInteger(item.definitionIndex) && typeof item.path === 'string' && (item.wholeDocument === true || typeof item.anchor === 'string' || Number.isInteger(item.paragraphIndex))) };
}
function saveBindings(dataDir, seriesId, bindingState, bindings) {
  if (JSON.stringify(bindingState.bindings) === JSON.stringify(bindings)) return;
  const { directory, path } = bindingFile(dataDir, seriesId);
  mkdirSync(directory, { recursive:true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const encoded = JSON.stringify({schemaVersion:1,bindings});
  if (Buffer.byteLength(encoded,'utf8') > MAX_BINDINGS_BYTES) fail('Concept binding cache exceeded its byte limit.');
  writeFileSync(temp, encoded, {encoding:'utf8',flag:'wx'});
  try { renameSync(temp, path); } catch (error) { try { if (existsSync(temp)) unlinkSync(temp); } catch {} throw error; }
  bindingState.bindings = bindings;
}

function refreshSourceBackings(index, {root,dataDir,seriesId,safePath,records,recordsById}) {
  const bindingState = loadBindings(dataDir, seriesId), priorBindings = bindingState.bindings;
  const sourceCache = new Map(), sourceSnapshot = Object.create(null);
  let totalBytes = 0;
  const sourceRecordForPath = value => records.find(record => record.path === value) || records.find(record => record.id === basename(value, extname(value)));
  const readSource = relativePath => {
    if (sourceCache.has(relativePath)) return sourceCache.get(relativePath);
    let text = null, problem = '', missing = false;
    try {
      if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').some(part => !part || part === '.' || part === '..') || !['.md','.markdown','.txt'].includes(extname(relativePath).toLowerCase()) || relativePath.split('/').some(part => part.startsWith('.') || /^(?:config(?:uration)?|credentials?|secrets?|internal|служебное|node_modules)$/i.test(part))) throw Error('unsafe source path');
      const target = safePath(root, relativePath, false);
      if (!isInside(resolve(root), resolve(target))) throw Error('source unavailable');
      const sourceStat = lstatSync(target);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw Error('source unavailable');
      const stat = statSync(target);
      totalBytes += sourceCache.has(relativePath) ? 0 : stat.size;
      if (sourceCache.size >= MAX_SOURCE_FILES || totalBytes > MAX_SOURCE_BYTES) fail('Displayed concept sources exceeded their bounds.');
      text = readFileSync(target, 'utf8');
      sourceSnapshot[relativePath] = createHash('sha256').update(text).digest('hex');
    } catch (error) {
      if (error?.status === 409) throw error;
      if (error?.code === 'ENOENT' || error?.status === 404) missing = true;
      problem = String(error?.message || 'source unavailable');
    }
    const row = {text,problem,missing}; sourceCache.set(relativePath,row); return row;
  };
  // A failed read or half-written section is not evidence that its binding is
  // obsolete. Keep the last binding while its outline node still exists;
  // successful resolutions replace that slot, and removed nodes are pruned.
  // Live-only structured nodes can disappear from a scan during a partial
  // save, so retain their identity until the source path is confirmed missing.
  const bindingKey = binding => JSON.stringify([binding.nodeId,binding.definitionIndex]);
  const inputIds = new Set(index.nodes.map(node=>node.id));
  const updatedBindings = new Map(priorBindings.filter(binding=>inputIds.has(binding.nodeId) || binding.sourceId && !recordsById.has(binding.sourceId) && !readSource(binding.path).missing).map(binding=>[bindingKey(binding),binding]));
  const sourceStatus = (item, message='Источник больше недоступен или его прежний фрагмент нельзя однозначно восстановить.') => ({...item,text:'',...(item.status==='source-unavailable'?{}:{originalStatus:item.status}),status:'source-unavailable',sourceUnavailableReason:message,...(item.path?{path:undefined}:{})});
  const rebaseItem = (item,nodeId=null) => {
    if (typeof item.path !== 'string') return item;
    const record = sourceRecordForPath(item.path);
    if (record) return {...item,path:record.path};
    const binding = nodeId ? priorBindings.find(candidate=>candidate.nodeId===nodeId&&candidate.path===item.path&&candidate.sourceId&&recordsById.has(candidate.sourceId)) : null;
    return binding ? {...item,path:recordsById.get(binding.sourceId).path} : item;
  };
  const resolveDefinition = (node, item, definitionIndex, refAnchor='', {wholeDocument=false}={}) => {
    const originalPath = item.path;
    const oldRecord = originalPath ? sourceRecordForPath(originalPath) : null;
    let binding = priorBindings.find(candidate => candidate.nodeId === node.id && candidate.definitionIndex === definitionIndex && (candidate.path === originalPath || oldRecord && candidate.sourceId === `${oldRecord.kind}:${oldRecord.id}`));
    let current = rebaseItem(item,node.id);
    if (!binding && current.path===originalPath && originalPath && !readSource(originalPath).text) {
      binding = priorBindings.find(candidate=>candidate.nodeId===node.id&&candidate.definitionIndex===definitionIndex&&candidate.sourceId&&recordsById.has(candidate.sourceId));
    }
    if (binding?.sourceId && current.path===originalPath && !sourceCache.has(current.path)) {
      const record = recordsById.get(binding.sourceId);
      if (record) current = {...current,path:record.path};
    }
    const read = current.path ? readSource(current.path) : {text:null};
    if (!read.text) return sourceStatus({...current,path:undefined});
    const source = sourceDocument(read.text);
    binding ||= priorBindings.find(candidate => candidate.nodeId === node.id && candidate.definitionIndex === definitionIndex && candidate.path === current.path);
    const sourceRecord = sourceRecordForPath(current.path);
    if (binding?.sourceId && sourceRecord && binding.sourceId !== `${sourceRecord.kind}:${sourceRecord.id}`) binding = null;
    if (binding && sourceRecord && binding.sourceId === `${sourceRecord.kind}:${sourceRecord.id}`) binding = {...binding,path:current.path};
    if (wholeDocument) binding = null;
    if (!binding) {
      const derived = wholeDocument ? {wholeDocument:true,sourceTitle:source.title} : deriveBinding(current, source.body, refAnchor);
      if (!derived) return sourceStatus({...current,path:undefined}, 'Сохранённый фрагмент не удалось однозначно связать с текущим источником.');
      binding = {nodeId:node.id,definitionIndex,path:current.path,...derived,...(sourceRecord?{sourceId:`${sourceRecord.kind}:${sourceRecord.id}`}:{})};
    }
    const text = extractBoundText(source.body,binding);
    if (!text) return sourceStatus({...current,path:undefined}, 'Привязанный раздел источника не найден.');
    const currentHeadingTitle = binding.anchor ? source.headings.find(heading=>heading.slug===binding.anchor)?.title : null;
    binding = {...binding,path:current.path,...(currentHeadingTitle?{sourceTitle:currentHeadingTitle}:{})};
    updatedBindings.set(bindingKey(binding),binding);
    return {...current,text,...(binding.anchor?{anchor:binding.anchor}:{}),...(binding.sourceTitle?{sourceTitle:binding.sourceTitle}:{}),...(item.status==='source-unavailable'?{status:item.originalStatus||'unmarked'}:{}),...(item.status==='source-unavailable'?{originalStatus:undefined}:{})};
  };
  const nodes = index.nodes.map(raw => {
    const node = {...raw};
    const hadLocalSources = [...(node.sourceRefs||[]),...(node.definitions||[])].some(ref => typeof ref.path === 'string');
    node.sourceRefs = (node.sourceRefs || []).map(ref => {
      if (!ref.path) return ref;
      const current = rebaseItem(ref,node.id), source = readSource(current.path);
      if (!source.text) return null;
      const doc = sourceDocument(source.text), heading = current.anchor ? doc.headings.find(item => item.slug === headingSlug(current.anchor)) : null;
      return {...current,...(heading?{title:heading.title}:doc.title?{title:doc.title}:{})};
    }).filter(Boolean);
    if (Array.isArray(node.definitions)) {
      const structuredSource = node.sourceRefs.find(ref=>ref.path && ref.basis==='structured source record');
      const structuredRecord = structuredSource ? sourceRecordForPath(structuredSource.path) : null;
      node.definitions = node.definitions.map((item,index) => {
        if (!item.path) return item;
        const itemRecord = sourceRecordForPath(item.path);
        const wholeDocument = !!structuredRecord && !!itemRecord && itemRecord.kind===structuredRecord.kind && itemRecord.id===structuredRecord.id && !['historical','versioned-source'].includes(item.status);
        return resolveDefinition(node,item,index,node.sourceRefs.find(ref=>ref.path===item.path)?.anchor||'',{wholeDocument});
      });
      const primarySource = structuredSource || node.sourceRefs.find(ref=>ref.path);
      let primaryAvailable = false;
      if (node.definition && primarySource) {
        const refreshed = resolveDefinition(node,{text:node.definition,sourceTitle:primarySource.title||node.title,version:'source-backed',status:node.status,path:primarySource.path,anchor:primarySource.anchor},-1,primarySource.anchor||'',{wholeDocument:!!structuredSource});
        node.definition = refreshed.text;
        primaryAvailable = refreshed.status!=='source-unavailable' && !!refreshed.text;
        if (refreshed.status==='source-unavailable') node.status='source-unavailable';
      }
      if (hadLocalSources && node.definitions.length && !node.definitions.some(item => item.text) && !primaryAvailable) { node.definition=''; node.status='source-unavailable'; }
    } else if (node.definition && node.sourceRefs.some(ref => ref.path)) {
      const definitionSource = node.sourceRefs.find(ref=>ref.path && ref.basis==='structured source record') || node.sourceRefs.find(ref=>ref.path);
      const refreshed = resolveDefinition(node,{text:node.definition,sourceTitle:definitionSource.title||node.title,version:'source-backed',status:node.status,path:definitionSource.path,anchor:definitionSource.anchor},-1,definitionSource.anchor||'',{wholeDocument:definitionSource.basis==='structured source record'});
      node.definition = refreshed.text;
      if (refreshed.status==='source-unavailable') node.status='source-unavailable';
    }
    if (hadLocalSources && !node.sourceRefs.some(ref=>ref.path) && !node.definitions?.some(item=>item.path||item.url||item.text)) {
      node.definition=''; node.status='source-unavailable';
    }
    node.sourceRefs = node.sourceRefs.map(ref => ({...ref}));
    node._hadLocalSources = hadLocalSources;
    return node;
  });
  // A structured source can move while retaining its immutable ID. Rebind all
  // stale paths in authored definitions/refs, then remove only unsupported
  // source-backed nodes; preserve their children and stable related edges.
  const kept = nodes.filter(node => {
    if (node.kind === 'category' || !node._hadLocalSources) return true;
    const backed = node.sourceRefs.length || node.definitions?.some(item => item.path || item.url || item.text) || node.sourceRefs.some(item => item.url);
    return !!backed;
  });
  const keptIds = new Set(kept.map(node=>node.id));
  const nodesById = new Map(nodes.map(node=>[node.id,node]));
  for (const node of kept) {
    let ancestorId = node.parentId, steps = 0;
    const visited = new Set([node.id]);
    while (ancestorId !== null && !keptIds.has(ancestorId) && steps++ < MAX_NODES) {
      if (visited.has(ancestorId)) break;
      visited.add(ancestorId);
      const ancestor = nodesById.get(ancestorId);
      if (!ancestor) break;
      ancestorId = ancestor.parentId;
    }
    if (ancestorId !== node.parentId && ancestorId !== null && keptIds.has(ancestorId)) node.parentId = ancestorId;
  }
  for (const node of kept) delete node._hadLocalSources;
  const edges = (index.edges||[]).filter(edge => keptIds.has(edge.source)&&keptIds.has(edge.target));
  const redirects = Object.fromEntries(Object.entries(index.redirects||{}).filter(([,target])=>keptIds.has(target)));
  saveBindings(dataDir,seriesId,bindingState,[...updatedBindings.values()]);
  return {...index,nodes:kept,edges,redirects,sourceSnapshot};
}

function reconcileLiveSources(index, root, { dataDir, seriesId, safePath } = {}) {
  const nodes = index.nodes.map(node => ({ ...node }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const byPath = new Map();
  for (const node of nodes) for (const ref of node.sourceRefs || []) if (ref.path) byPath.set(ref.path, node);
  const scanned = liveSourceRecords(root).filter(record => !record.archived), chosen = new Map();
  for (const record of scanned) {
    const key = `${record.kind}:${record.id}`, prior = chosen.get(key);
    if (!prior) chosen.set(key, record);
    else if (prior.path !== record.path) fail(`Multiple active sources claim ${record.id}.`);
  }
  const records = [...chosen.values()];
  const recordByEntityId = new Map(records.filter(record => record.kind === 'entity').map(record => [record.id, record]));
  const recordsById = new Map(records.map(record => [`${record.kind}:${record.id}`,record]));
  const stableBindings = loadBindings(dataDir,seriesId).bindings;
  const sourceRecordForPath = value => {
    const exact = records.find(record => record.path === value);
    if (exact) return exact;
    const key = basename(value, extname(value));
    return records.find(record => record.id === key);
  };
  const boundNodeForRecord = record => {
    const binding = stableBindings.find(item=>item.sourceId===`${record.kind}:${record.id}`);
    return binding ? byId.get(binding.nodeId) : null;
  };
  const hasEditorialTitle = node => !!(node.titleBasis || node.originalTitle || node.aliases?.length || /^Прямая поправка автора\b/.test(node.placementBasis || ''));
  for (const record of records) {
    const sourceId = record.kind === 'entity' ? `entity:${record.id}` : `plotline:${record.id}`;
    const priorNodeId = stableBindings.find(binding=>binding.sourceId===`${record.kind}:${record.id}`)?.nodeId;
    let node = byId.get(sourceId) || (priorNodeId?byId.get(priorNodeId):null) || boundNodeForRecord(record) || byPath.get(record.path) || nodes.find(item => item.sourceRefs?.some(ref => ref.path && sourceRecordForPath(ref.path)?.kind === record.kind && sourceRecordForPath(ref.path)?.id === record.id));
    const identityParent = record.fields.identity_parent;
    const identityPath = identityParent ? recordByEntityId.get(identityParent)?.path : null;
    const identityNode = identityPath ? byPath.get(identityPath) || boundNodeForRecord({kind:'entity',id:identityParent}) || nodes.find(item=>item.sourceRefs?.some(ref=>ref.path&&basename(ref.path,extname(ref.path))===identityParent)) : null;
    const parentId = record.kind === 'book-plot-line' ? 'category:plot' : identityParent ? (identityNode?.id || `entity:${identityParent}`) : 'category:entities';
    if (!node) {
      node = { id: sourceId, title: record.title, parentId, kind: 'concept', type: record.kind === 'book-plot-line' ? 'plot' : 'character', status: record.fields.status || 'source-backed', definition: record.body, sourceRefs: [], sourceMetadata: record.fields, ...(record.fields.bookId || record.fields.book_id ? { bookId: record.fields.bookId || record.fields.book_id } : {}) };
      nodes.push(node); byId.set(sourceId, node);
    } else {
      if (!hasEditorialTitle(node)) node.title = record.title;
      node.definition = record.body;
      node.sourceMetadata = record.fields;
      node.status = record.fields.status || node.status;
      node.kind = node.kind || 'concept';
      if (record.kind === 'book-plot-line') { node.type = 'plot'; node.parentId = node.parentId || parentId; }
    }
    const refs = (node.sourceRefs || []).filter(ref => ref.path !== record.path && !(ref.path && (sourceRecordForPath(ref.path)?.kind === record.kind && sourceRecordForPath(ref.path)?.id === record.id || stableBindings.some(binding=>binding.nodeId===node.id&&binding.path===ref.path&&binding.sourceId===`${record.kind}:${record.id}`))));
    refs.push({ path: record.path, title: record.title, version: `Live source · ${record.fields.updated || 'date unspecified'}`, basis: 'structured source record' });
    node.sourceRefs = refs;
  }
  for (const record of records.filter(item => item.kind === 'entity' && item.fields.identity_parent)) {
    const childId = record.id.startsWith('entity:') ? record.id : `entity:${record.id}`;
    const child = byId.get(childId) || byPath.get(record.path);
    const parentPath = recordByEntityId.get(record.fields.identity_parent)?.path;
    const identityId=record.fields.identity_parent;
    const parent = parentPath ? byPath.get(parentPath) || boundNodeForRecord({kind:'entity',id:identityId}) || nodes.find(item=>item.sourceRefs?.some(ref=>ref.path&&basename(ref.path,extname(ref.path))===identityId)) : null;
    if (!child || !parent || child.id === parent.id) continue;
    const sharedId = `${parent.id}:shared`;
    const periodProfileIds = new Set(records.filter(item => item.kind === 'entity' && item.fields.identity_parent === record.fields.identity_parent).map(item => byPath.get(item.path)?.id || `entity:${item.id}`));
    let shared = byId.get(sharedId);
    if (!shared) {
      shared = { id: sharedId, title: 'Общие сведения', parentId: parent.id, kind: 'category', type: 'category', status: 'navigation', definition: '', sourceRefs: [] };
      nodes.push(shared); byId.set(sharedId, shared);
    }
    for (const prior of nodes) {
      if (periodProfileIds.has(prior.id) || prior.id === shared.id || prior.parentId !== parent.id || prior.kind === 'category') continue;
      prior.parentId = shared.id;
    }
  }
  const reconciled = refreshSourceBackings({...index,nodes},{root,dataDir,seriesId,safePath,records,recordsById});
  return reconciled;
}

export function normalizeConceptGraph(index, { root, safePath, selection, maxNodes = MAX_NODES } = {}) {
  if (!index || index.schemaVersion !== 1 || !Array.isArray(index.nodes)) fail('Concept outline has an unsupported schema.');
  if (index.nodes.length > maxNodes) fail('Concept outline exceeds the node limit.');
  const byId = new Map();
  for (const raw of index.nodes) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || byId.has(raw.id) || typeof raw.title !== 'string' || !raw.title.trim() || !['category','concept'].includes(raw.kind) || typeof raw.definition !== 'string' || !Array.isArray(raw.sourceRefs)) fail('Concept outline contains an invalid or duplicate node.');
    const validateRef = (ref, titleKey='title') => {
      if (!ref || typeof ref !== 'object' || typeof ref.title !== 'string' || typeof ref.version !== 'string' || typeof ref.basis !== 'string') fail('Concept source reference is incomplete.');
      if (ref.path !== undefined) validateRelative(root, ref.path, safePath);
      if (ref.url !== undefined) validateGoogleDoc(ref.url);
      if (ref.path === undefined && ref.url === undefined) fail('Concept source reference has no permitted target.');
      return { ...(ref.path !== undefined ? {path:ref.path} : {}), ...(ref.anchor !== undefined ? {anchor:String(ref.anchor)} : {}), ...(ref.url !== undefined ? {url:ref.url} : {}), [titleKey]:ref[titleKey] ?? ref.title, version:ref.version, basis:ref.basis, ...(ref.status !== undefined ? {status:String(ref.status)} : {}) };
    };
    if (raw.definitions !== undefined && (!Array.isArray(raw.definitions) || raw.definitions.length > 100)) fail('Concept definitions must be a bounded array.');
    if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.length > 100 || raw.aliases.some(alias => typeof alias?.title !== 'string' || alias.title.length > 500))) fail('Concept aliases are invalid.');
    const sourceMetadata = raw.sourceMetadata && typeof raw.sourceMetadata === 'object' && !Array.isArray(raw.sourceMetadata) ? Object.fromEntries(Object.entries(raw.sourceMetadata).filter(([key,value])=>SOURCE_METADATA_FIELDS.has(key)&&typeof value==='string'&&value.length<=1000)) : undefined;
    const node = { ...(raw.aliases ? {aliases:raw.aliases.map(alias=>({title:alias.title,...(alias.searchOnly===true?{searchOnly:true}:{})}))} : {}), id: raw.id, title: raw.title, ...(typeof raw.originalTitle === 'string' ? {originalTitle:raw.originalTitle} : {}), parentId: raw.parentId ?? null, kind: raw.kind, type: raw.type ?? raw.kind, status: raw.status ?? 'unmarked', summary: typeof raw.summary === 'string' ? raw.summary : undefined, ...(sourceMetadata ? {sourceMetadata} : {}), ...(raw.bookId !== undefined ? {bookId:raw.bookId} : {}), definition: raw.definition, ...(raw.definitions ? {definitions:raw.definitions.map(item => { if(typeof item?.text!=='string'||typeof item.version!=='string'||typeof item.sourceTitle!=='string')fail('Concept definition entry is incomplete.');return {text:item.text,sourceTitle:item.sourceTitle,version:item.version,status:String(item.status??'unmarked'),...(item.status==='source-unavailable'?{sourceUnavailableReason:String(item.sourceUnavailableReason||'Source unavailable')} : {}),...(item.path!==undefined?{path:validateRelative(root,item.path,safePath)}:{}),...(item.url!==undefined?{url:validateGoogleDoc(item.url)}:{}),...(item.anchor!==undefined?{anchor:String(item.anchor)}:{})};})} : {}), sourceRefs: raw.sourceRefs.map(ref => validateRef(ref)) };
    if (node.parentId !== null && typeof node.parentId !== 'string') fail('Concept parent id is invalid.');
    byId.set(node.id, node);
  }
  if (!byId.has('knowledge:root') || byId.get('knowledge:root').parentId !== null || [...byId.values()].filter(node => node.parentId === null).length !== 1) fail('Concept outline must have one knowledge:root tree.');
  for (const node of byId.values()) if (node.parentId !== null && !byId.has(node.parentId)) fail(`Missing parent for concept ${node.id}.`);
  const states = new Map();
  const visit = id => { const state=states.get(id); if(state===1) fail('Concept hierarchy contains a cycle.'); if(state===2)return; states.set(id,1); const p=byId.get(id).parentId; if(p!==null)visit(p); states.set(id,2); };
  for (const id of byId.keys()) visit(id);
  const related=[];
  if (index.edges !== undefined && !Array.isArray(index.edges)) fail('Concept edges must be an array.');
  for (const edge of index.edges ?? []) {
    if (!edge || edge.kind !== 'related' || !byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) fail('Concept related edge is invalid.');
    if (related.length < MAX_RELATED) related.push({source:edge.source,target:edge.target,kind:'related',...(typeof edge.basis==='string'?{basis:edge.basis}:{})});
  }
  const redirects = {};
  if (index.redirects !== undefined && (!index.redirects || typeof index.redirects !== 'object' || Array.isArray(index.redirects) || Object.keys(index.redirects).length > MAX_NODES)) fail('Concept redirects are invalid.');
  for (const [oldId,targetId] of Object.entries(index.redirects || {})) {
    if (!oldId || oldId.length > 200 || byId.has(oldId) || typeof targetId !== 'string' || !byId.has(targetId)) fail('Concept redirect target is invalid.');
    Object.defineProperty(redirects,oldId,{value:targetId,enumerable:true});
  }
  const logicalBookId = selection?.logicalBookId;
  const visibility = new Map();
  const visible = node => {
    if (visibility.has(node.id)) return visibility.get(node.id);
    const ownMismatch = logicalBookId && node.bookId && (node.type === 'plot' || node.parentId === 'category:plot') && String(node.bookId) !== String(logicalBookId);
    const result = !ownMismatch && (node.parentId === null || visible(byId.get(node.parentId)));
    visibility.set(node.id, result); return result;
  };
  const nodes = [...byId.values()].filter(visible).map(node => ({...node, ...(node.parentId===null?{}:{breadcrumb:undefined})}));
  const nodeIds = new Set(nodes.map(node=>node.id));
  const contains = nodes.filter(node=>node.parentId!==null && nodeIds.has(node.parentId)).map(node=>({source:node.parentId,target:node.id,kind:'contains'}));
  const edges = [...contains,...related.filter(edge=>nodeIds.has(edge.source)&&nodeIds.has(edge.target))];
  const cap = Math.min(maxNodes, MAX_NODES), bounded=nodes.slice(0,cap), boundedIds=new Set(bounded.map(n=>n.id));
  const boundedEdges=edges.filter(e=>boundedIds.has(e.source)&&boundedIds.has(e.target));
  const breadcrumbs = new Map();
  for(const node of bounded){const chain=[];let cur=node;while(cur){chain.unshift(cur.title);cur=cur.parentId?byId.get(cur.parentId):null;}node.breadcrumb=chain;}
  return {mode:'concepts',redirects:Object.fromEntries(Object.entries(redirects).filter(([,target])=>boundedIds.has(target))),rootId:byId.has('knowledge:root')?'knowledge:root':null,nodes:bounded,edges:boundedEdges,scope:'active',selection:selection?{authorId:selection.authorId,seriesId:selection.seriesId,bookId:selection.bookId}:null,truncated:nodes.length>bounded.length,totalNodes:nodes.length,diagnostics:{status:'ready'}};
}

export function loadConceptGraph({ dataDir, seriesId, root, safePath, selection, scope='active' } = {}) {
  if (scope === 'unassigned') return {mode:'concepts',rootId:null,nodes:[],edges:[],scope:'unassigned',selection:null,truncated:false,totalNodes:0,revision:'unassigned-empty',diagnostics:{status:'unassigned',notice:'Private series concepts are not inherited by unassigned sources.'}};
  if (typeof seriesId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(seriesId)) fail('Active series id is invalid.');
  const indexDir=resolve(dataDir,'knowledge-outlines'), indexPath=resolve(indexDir,`${seriesId}.json`);
  if (!isInside(resolve(dataDir),indexDir) || !isInside(indexDir,indexPath)) fail('Concept outline path is invalid.');
  for (const part of [resolve(dataDir),indexDir,indexPath]) if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail('Concept outline path cannot pass through symbolic links.');
  let parsed;
  if (!existsSync(indexPath)) parsed = {schemaVersion:1,nodes:categories,edges:[]};
  else {
    const st=lstatSync(indexPath);
    if(st.isSymbolicLink()||st.isDirectory()||!st.isFile()||statSync(indexPath).size>MAX_BYTES) fail('Concept outline is not a bounded regular file.');
    try { parsed=JSON.parse(readFileSync(indexPath,'utf8')); } catch { fail('Concept outline JSON is invalid.'); }
  }
  const reconciled = reconcileLiveSources(parsed, root, {dataDir,seriesId,safePath});
  const graph = normalizeConceptGraph(reconciled,{root,safePath,selection});
  const snapshot = createHash('sha256').update(JSON.stringify({nodes:reconciled.nodes,edges:reconciled.edges||[],redirects:reconciled.redirects||{},selection:selection||null,sourceSnapshot:reconciled.sourceSnapshot||{}})).digest('hex');
  return {...graph,revision:snapshot,diagnostics:{...graph.diagnostics,status:existsSync(indexPath)?'ready':'outline-missing',sourceRevision:snapshot}};
}
