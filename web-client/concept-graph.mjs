import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 1000;
const MAX_RELATED = 5000;
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
    const node = { ...(raw.aliases ? {aliases:raw.aliases.map(alias=>({title:alias.title,...(alias.searchOnly===true?{searchOnly:true}:{})}))} : {}), id: raw.id, title: raw.title, ...(typeof raw.originalTitle === 'string' ? {originalTitle:raw.originalTitle} : {}), parentId: raw.parentId ?? null, kind: raw.kind, type: raw.type ?? raw.kind, status: raw.status ?? 'unmarked', summary: typeof raw.summary === 'string' ? raw.summary : undefined, ...(raw.bookId !== undefined ? {bookId:raw.bookId} : {}), definition: raw.definition, ...(raw.definitions ? {definitions:raw.definitions.map(item => { if(typeof item?.text!=='string'||typeof item.version!=='string'||typeof item.sourceTitle!=='string')fail('Concept definition entry is incomplete.');return {text:item.text,sourceTitle:item.sourceTitle,version:item.version,status:String(item.status??'unmarked'),...(item.path!==undefined?{path:validateRelative(root,item.path,safePath)}:{}),...(item.url!==undefined?{url:validateGoogleDoc(item.url)}:{}),...(item.anchor!==undefined?{anchor:String(item.anchor)}:{})};})} : {}), sourceRefs: raw.sourceRefs.map(ref => validateRef(ref)) };
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
  if (scope === 'unassigned') return {mode:'concepts',rootId:null,nodes:[],edges:[],scope:'unassigned',selection:null,truncated:false,totalNodes:0,diagnostics:{status:'unassigned',notice:'Private series concepts are not inherited by unassigned sources.'}};
  if (typeof seriesId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(seriesId)) fail('Active series id is invalid.');
  const indexDir=resolve(dataDir,'knowledge-outlines'), indexPath=resolve(indexDir,`${seriesId}.json`);
  if (!isInside(resolve(dataDir),indexDir) || !isInside(indexDir,indexPath)) fail('Concept outline path is invalid.');
  for (const part of [resolve(dataDir),indexDir,indexPath]) if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail('Concept outline path cannot pass through symbolic links.');
  if (!existsSync(indexPath)) return {...normalizeConceptGraph({schemaVersion:1,nodes:categories,edges:[]},{root,safePath,selection}),diagnostics:{status:'outline-missing'}};
  const st=lstatSync(indexPath);
  if(st.isSymbolicLink()||st.isDirectory()||!st.isFile()||statSync(indexPath).size>MAX_BYTES) fail('Concept outline is not a bounded regular file.');
  let parsed; try { parsed=JSON.parse(readFileSync(indexPath,'utf8')); } catch { fail('Concept outline JSON is invalid.'); }
  return normalizeConceptGraph(parsed,{root,safePath,selection});
}
