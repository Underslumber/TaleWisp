const normalized = value => String(value || '').normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
// Inflections are display navigation aliases, not new concepts or world assertions.
const inflections = {
  'мана':['маны','ману','маной','мане'], 'домен':['домена','домену','доменом','домене'],
  'магия':['магии','магию','магией'], 'аура':['ауры','ауру','аурой','ауре'],
  'глиф':['глифа','глифу','глифом','глифе','глифы','глифов'],
  'аркана':['арканы','аркану','арканой','аркане'],
  'заклинание':['заклинания','заклинанию','заклинанием','заклинании','заклинаний','заклинаниями']
};
export function resolveConceptReference(reference, nodes, sourcePath = '') {
  const target = String(reference.target || '').split('#')[0];
  const label = normalized(reference.label || target.split('/').at(-1)?.replace(/\.md$/i,''));
  const named = nodes.filter(node => [node.title,node.originalTitle,...(node.aliases || []).filter(alias=>!alias.searchOnly).map(alias=>alias.title)].filter(Boolean).some(name=>normalized(name)===label));
  if (named.length) return named.map(node=>node.id);
  if (!target || /^(?:[a-z]+:|\/|\\)/i.test(target)) return [];
  const resolve = path => {
    const parts=[];
    for (const part of path.split('/')) { if (!part || part==='.') continue; if (part==='..') { if (!parts.length) return null; parts.pop(); } else parts.push(part); }
    return parts.join('/');
  };
  const paths = new Set([resolve(target),resolve(sourcePath.split('/').slice(0,-1).join('/')+'/'+target)].filter(Boolean));
  const bound = nodes.filter(node=>(node.sourceRefs || []).some(ref=>paths.has(ref.path) && (!reference.anchor || ref.anchor===reference.anchor)));
  return bound.length===1 ? [bound[0].id] : [];
}
export function createConceptMatcher(nodes = []) {
  const names = new Map(), generic = new Set(['типы','общее','введение','заключение','обсуждение','цены','основа']);
  for (const node of nodes) {
    if (node.kind === 'category' && !node.definition?.trim() && !(node.definitions || []).some(d=>d.text?.trim())) continue;
    const title = normalized(node.title).replace(/^\d+[.)]\s*/, '');
    if (title.length < 3 || generic.has(title)) continue;
    for (const name of [title, ...[node.originalTitle, ...(node.aliases || []).filter(alias=>!alias.searchOnly).map(alias=>alias.title)].filter(Boolean).map(normalized).filter(value=>value.length>=3&&!generic.has(value)), ...(inflections[title] || [])]) {
      if (!names.has(name)) names.set(name, new Set());
      names.get(name).add(node.id);
    }
  }
  const unique = [...names].map(([name, ids]) => ({name,ids:[...ids],id:ids.size===1?[...ids][0]:null})).sort((a,b)=>b.name.length-a.name.length);
  return (input, excludeId) => {
    const source = String(input || '');
    // Do not alter offsets when whitespace normalization would change them.
    const comparable = source.toLocaleLowerCase('ru').replace(/ё/g,'е');
    if (comparable.length !== source.length) return [];
    const matches = [];
    for (const item of unique) {
      if (item.ids.length === 1 && item.id === excludeId) continue;
      let start = comparable.indexOf(item.name);
      while (start !== -1) {
        const end = start + item.name.length;
        if (!/[\p{L}\p{N}_]/u.test(comparable[start-1] || '') && !/[\p{L}\p{N}_]/u.test(comparable[end] || '') && !matches.some(m=>start<m.end&&end>m.start)) matches.push({start,end,id:item.id,ids:item.ids.filter(id=>id!==excludeId),text:source.slice(start,end)});
        start = comparable.indexOf(item.name, end);
      }
    }
    return matches.sort((a,b)=>a.start-b.start);
  };
}
export function withConceptMentions(graph) {
  const match = createConceptMatcher(graph.nodes), edges = (graph.edges || []).map(e => ({...e,label:e.label || (e.basis?.startsWith('[Отношение] ') ? e.basis.split('\n')[0].slice(12) : 'Связь по источнику')})), seen = new Set(edges.map(e=>`${e.source}\0${e.target}\0${e.kind}`));
  for (const node of graph.nodes || []) {
    for (const definition of node.definitions?.length ? node.definitions : [{text:node.definition}]) {
      for (const mention of match(definition.text, node.id)) {
        if (!mention.id) continue;
        const key = `${node.id}\0${mention.id}\0related`;
        if (seen.has(key)) continue;
        seen.add(key); edges.push({source:node.id,target:mention.id,kind:'related',label:'Упоминается в пояснении',basis:definition.sourceTitle || node.title,version:definition.version || '',evidence:mention.text});
      }
    }
  }
  return {...graph,edges};
}
