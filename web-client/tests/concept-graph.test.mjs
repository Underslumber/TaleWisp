import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConceptGraph, normalizeConceptGraph } from '../concept-graph.mjs';
import { createWorkspaceService } from '../workspace.mjs';

const withSeries = fn => {
  const base=mkdtempSync(join(tmpdir(),'talewisp-concepts-')), root=join(base,'series'),dataDir=join(base,'data');
  mkdirSync(join(root,'World'),{recursive:true}); mkdirSync(join(dataDir,'knowledge-outlines'),{recursive:true});
  writeFileSync(join(root,'World','Rules.md'),'# Rules\n\n## Magic\nОсновное пояснение\n\n## 2019\nВерсия определения 2019','utf8');
  const safePath=(r,p)=>{const target=resolve(r,...p.split('/'));if(!(target===resolve(r)||target.startsWith(resolve(r)+sep)))throw Error('outside');return target;};
  try{return fn({base,root,dataDir,safePath});}finally{rmSync(base,{recursive:true,force:true});}
};
const ref={path:'World/Rules.md',anchor:'Magic',title:'Rules',version:'2026',basis:'explicit source heading'};
const fixture=()=>({schemaVersion:1,nodes:[
  {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
  {id:'category:world',title:'Мир',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]},
  {id:'term:magic',title:'Магия',parentId:'category:world',kind:'concept',type:'rule',status:'confirmed',definition:'Основное пояснение',definitions:[{text:'Версия определения 2019',sourceTitle:'Магия',version:'2019',status:'historical',path:'World/Rules.md',anchor:'2019'}],sourceRefs:[ref]},
  {id:'plot:b1',title:'Сюжет 1',parentId:'knowledge:root',kind:'concept',type:'plot',bookId:'b1',definition:'',sourceRefs:[]},
  {id:'plot:b2',title:'Сюжет 2',parentId:'knowledge:root',kind:'concept',type:'plot',bookId:'b2',definition:'',sourceRefs:[]},
  {id:'plot:b2:scene',title:'Сцена сюжета 2',parentId:'plot:b2',kind:'concept',type:'scene',definition:'',sourceRefs:[]},
  {id:'term:global',title:'Сущность',parentId:'category:world',kind:'concept',type:'entity',bookId:'b2',definition:'Общая',sourceRefs:[]}
],edges:[{source:'term:magic',target:'term:global',kind:'related',basis:'reference'}]});

test('loads term hierarchy, default and versioned definitions, related edges, and scopes plot nodes',()=>withSeries(({root,dataDir,safePath})=>{
  writeFileSync(join(dataDir,'knowledge-outlines','series-1.json'),JSON.stringify(fixture()));
  const graph=loadConceptGraph({dataDir,seriesId:'series-1',root,safePath,selection:{authorId:'a',seriesId:'series-1',bookId:'book-one',logicalBookId:'b1'}});
  assert.equal(graph.mode,'concepts'); assert.equal(graph.nodes.find(n=>n.id==='term:magic').definition,'Основное пояснение');
  assert.equal(graph.nodes.find(n=>n.id==='term:magic').definitions[0].version,'2019');
  assert.ok(graph.nodes.some(n=>n.id==='plot:b1')); assert.ok(!graph.nodes.some(n=>n.id==='plot:b2')); assert.ok(!graph.nodes.some(n=>n.id==='plot:b2:scene'));
  assert.ok(graph.nodes.some(n=>n.id==='term:global'));
  assert.deepEqual(graph.edges.filter(e=>e.kind==='related').map(e=>e.source),['term:magic']);
  assert.ok(graph.edges.some(e=>e.kind==='contains'&&e.source==='category:world'&&e.target==='term:magic'));
}));

test('rejects duplicate ids, missing parents, and cycles',()=>withSeries(({root,safePath})=>{
  const base=fixture();
  assert.throws(()=>normalizeConceptGraph({...base,nodes:[...base.nodes,base.nodes[0]]},{root,safePath}),/duplicate/);
  assert.throws(()=>normalizeConceptGraph({...base,nodes:base.nodes.map(n=>n.id==='term:magic'?{...n,parentId:'missing'}:n)},{root,safePath}),/Missing parent/);
  assert.throws(()=>normalizeConceptGraph({...base,nodes:base.nodes.map(n=>n.id==='category:world'?{...n,parentId:'term:magic'}:n)},{root,safePath}),/cycle/);
  assert.throws(()=>normalizeConceptGraph({...base,nodes:base.nodes.filter(n=>n.id!=='knowledge:root')},{root,safePath}),/knowledge:root tree/);
  assert.throws(()=>normalizeConceptGraph({...base,nodes:[...base.nodes,{id:'other-root',title:'Другой корень',parentId:null,kind:'category',definition:'',sourceRefs:[]}]},{root,safePath}),/knowledge:root tree/);
}));

test('preserves search aliases and resolves only bounded redirects to visible concepts',()=>withSeries(({root,safePath})=>{
  const index=fixture(); index.nodes.find(n=>n.id==='term:magic').aliases=[{title:'Старое имя'}]; index.redirects={'old:magic':'term:magic'};
  const graph=normalizeConceptGraph(index,{root,safePath});
  assert.equal(graph.redirects['old:magic'],'term:magic');
  assert.deepEqual(graph.nodes.find(n=>n.id==='term:magic').aliases,[{title:'Старое имя'}]);
  assert.throws(()=>normalizeConceptGraph({...index,redirects:{'old:magic':'missing'}},{root,safePath}),/redirect/);
  assert.throws(()=>normalizeConceptGraph({...index,redirects:{'term:magic':'term:magic'}},{root,safePath}),/redirect/);
  index.nodes.find(n=>n.id==='term:magic').aliases=[{title:'Старое имя',searchOnly:true}];
  assert.equal(normalizeConceptGraph(index,{root,safePath}).nodes.find(n=>n.id==='term:magic').aliases[0].searchOnly,true);
}));

test('rejects unsafe local references and non-Google external URLs',()=>withSeries(({root,safePath})=>{
  assert.throws(()=>normalizeConceptGraph({...fixture(),nodes:fixture().nodes.map(n=>n.id==='term:magic'?{...n,sourceRefs:[{...ref,path:'../outside.md'}]}:n)},{root,safePath}),/safe relative/);
  assert.throws(()=>normalizeConceptGraph({...fixture(),nodes:fixture().nodes.map(n=>n.id==='term:magic'?{...n,sourceRefs:[{title:'x',version:'1',basis:'x',url:'https://docs.google.com.evil/document/d/id'}]}:n)},{root,safePath}),/Google Docs/);
}));

test('enforces outline bounds, fixed series path, missing outline status, and unassigned isolation',()=>withSeries(({root,dataDir,safePath})=>{
  assert.throws(()=>loadConceptGraph({dataDir,seriesId:'../escape',root,safePath}),/series id/);
  assert.equal(loadConceptGraph({dataDir,seriesId:'series-1',root,safePath}).diagnostics.status,'outline-missing');
  assert.equal(loadConceptGraph({dataDir,scope:'unassigned'}).nodes.length,0);
  assert.equal(loadConceptGraph({dataDir,scope:'unassigned'}).revision,'unassigned-empty');
  assert.throws(()=>normalizeConceptGraph({...fixture(),nodes:Array.from({length:1001},(_,i)=>({id:`n${i}`,title:'n',parentId:null,kind:'concept',definition:'',sourceRefs:[]}))},{root,safePath}),/node limit/);
}));

test('refreshes displayed local definitions and revisions from source content, then drops an unsupported missing source cleanly',()=>withSeries(({root,dataDir,safePath})=>{
  const outline=join(dataDir,'knowledge-outlines','series-1.json');
  const source=join(root,'World','Rules.md');
  writeFileSync(source,'# Rules\n\n## Topic\nOriginal statement.');
  const index={schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'category:world',title:'Мир',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'term:backed',title:'Термин',parentId:'category:world',kind:'concept',type:'rule',status:'confirmed',definition:'Legacy copy',definitions:[{text:'Original statement.',sourceTitle:'Topic',version:'v1',status:'current',path:'World/Rules.md',anchor:'Topic'}],sourceRefs:[{...ref,anchor:'Topic'}]},
    {id:'term:child',title:'Дочерний узел',parentId:'term:backed',kind:'concept',type:'note',definition:'',sourceRefs:[]}
  ],edges:[{source:'term:backed',target:'term:child',kind:'related',basis:'test'}]};
  writeFileSync(outline,JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  const first=load();
  assert.equal(first.nodes.find(node=>node.id==='term:backed').definitions[0].text,'Original statement.');
  writeFileSync(source,'# Rules\n\n## Topic\nUpdated statement.');
  const changed=load();
  assert.notEqual(changed.revision,first.revision);
  assert.equal(changed.nodes.find(node=>node.id==='term:backed').definitions[0].text,'Updated statement.');
  rmSync(source);
  const missing=load();
  assert.doesNotThrow(()=>load());
  assert.ok(!missing.nodes.some(node=>node.id==='term:backed'));
  assert.equal(missing.nodes.find(node=>node.id==='term:child').parentId,'category:world');
  assert.ok(!missing.edges.some(edge=>edge.source==='term:backed'||edge.target==='term:backed'));
}));

test('extracts identical complete heading sections from CRLF and LF sources',()=>withSeries(({root,dataDir,safePath})=>{
  const source=join(root,'World','Rules.md');
  const index={schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'category:world',title:'Мир',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'term:topic',title:'Тема',parentId:'category:world',kind:'concept',type:'rule',status:'confirmed',definition:'Initial excerpt.',definitions:[{text:'Initial excerpt.',sourceTitle:'Topic',version:'current',status:'current',path:'World/Rules.md',anchor:'Topic'}],sourceRefs:[{path:'World/Rules.md',title:'Topic',version:'current',basis:'test',anchor:'Topic'}]}
  ],edges:[]};
  writeFileSync(join(dataDir,'knowledge-outlines','series-1.json'),JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  const crlfBody='# Rules\r\n\r\n## Topic\r\nThe first line.\r\nThe second line ends exactly.\r\n\r\n## Following\r\nThis belongs elsewhere.';
  writeFileSync(source,crlfBody);
  const crlf=load();
  const crlfNode=crlf.nodes.find(node=>node.id==='term:topic');
  assert.equal(crlfNode.definition.replace(/\r\n/g,'\n'),'The first line.\nThe second line ends exactly.');
  assert.equal(crlfNode.definitions[0].text.replace(/\r\n/g,'\n'),'The first line.\nThe second line ends exactly.');
  writeFileSync(source,crlfBody.replace(/\r\n/g,'\n'));
  const lf=load();
  const lfNode=lf.nodes.find(node=>node.id==='term:topic');
  assert.equal(lfNode.definition,'The first line.\nThe second line ends exactly.');
  assert.equal(lfNode.definitions[0].text,lfNode.definition);
}));

for (const interruption of ['empty','unreadable','missing']) test(`retains paragraph ordinals through a transient ${interruption} source poll`,()=>withSeries(({root,dataDir,safePath})=>{
  const source=join(root,'World','Rules.md'), outline=join(dataDir,'knowledge-outlines','series-1.json');
  const bindingPath=join(dataDir,'knowledge-derived-bindings','series-1.json');
  writeFileSync(source,'Unrelated first paragraph.\n\nOriginal excerpt.');
  const index={schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'term:paragraph',title:'Paragraph',parentId:'knowledge:root',kind:'concept',type:'rule',definition:'Original excerpt.',definitions:[{text:'Original excerpt.',sourceTitle:'Paragraph',version:'current',status:'current',path:'World/Rules.md'}],sourceRefs:[{path:'World/Rules.md',title:'Paragraph',version:'current',basis:'test'}]}
  ],edges:[]};
  writeFileSync(outline,JSON.stringify(index));
  let unreadable=false;
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath:(r,p)=>{if(unreadable&&p==='World/Rules.md')throw Error('EBUSY: transient sharing violation');return safePath(r,p);}});
  assert.equal(load().nodes.find(node=>node.id==='term:paragraph').definitions[0].text,'Original excerpt.');
  const before=JSON.parse(readFileSync(bindingPath,'utf8')).bindings;
  assert.deepEqual(before.map(binding=>[binding.definitionIndex,binding.paragraphIndex]).sort(),[[-1,1],[0,1]]);
  if(interruption==='missing')rmSync(source);else if(interruption==='empty')writeFileSync(source,'');else unreadable=true;
  load();
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,before);
  unreadable=false;
  writeFileSync(source,'Unrelated first paragraph.\n\nEdited excerpt without the old wording.');
  const restored=load().nodes.find(node=>node.id==='term:paragraph');
  assert.equal(restored.definition,'Edited excerpt without the old wording.');
  assert.equal(restored.definitions[0].text,restored.definition);
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,before);
  writeFileSync(outline,JSON.stringify({...index,nodes:index.nodes.slice(0,1)}));
  load();
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,[]);
}));

test('retains an existing anchor binding while its section is temporarily missing',()=>withSeries(({root,dataDir,safePath})=>{
  const source=join(root,'World','Rules.md'), outline=join(dataDir,'knowledge-outlines','series-1.json');
  const index=fixture();writeFileSync(outline,JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  load();
  const bindingPath=join(dataDir,'knowledge-derived-bindings','series-1.json');
  const before=JSON.parse(readFileSync(bindingPath,'utf8')).bindings;
  writeFileSync(source,'# Rules\n\nHalf-written content without the bound headings.');
  const interrupted=load().nodes.find(node=>node.id==='term:magic');
  assert.equal(interrupted.definitions[0].status,'source-unavailable');
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,before);
  writeFileSync(source,'# Rules\n\n## Magic\nUpdated explanation.\n\n## 2019\nEdited historic statement.');
  const restored=load().nodes.find(node=>node.id==='term:magic');
  assert.equal(restored.definition,'Updated explanation.');
  assert.equal(restored.definitions[0].text,'Edited historic statement.');
}));

for (const partial of ['', '---\nrecord_kind: entity\nid: E0200\n']) test(`retains a live-only structured binding during a ${partial?'half-written':'empty'} source scan`,()=>withSeries(({root,dataDir,safePath})=>{
  const entities=join(root,'Entities');mkdirSync(entities);
  const source=join(entities,'identity.md'),outline=join(dataDir,'knowledge-outlines','series-1.json');
  const body=text=>`---\nrecord_kind: entity\nid: E0200\ntitle: Identity\n---\n# Identity\n${text}`;
  writeFileSync(source,body('Original body.'));
  writeFileSync(outline,JSON.stringify({schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'category:entities',title:'Сущности',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]}
  ],edges:[]}));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  assert.match(load().nodes.find(node=>node.id==='entity:E0200').definition,/Original body/);
  const bindingPath=join(dataDir,'knowledge-derived-bindings','series-1.json');
  const before=JSON.parse(readFileSync(bindingPath,'utf8')).bindings;
  assert.equal(before[0].sourceId,'entity:E0200');
  writeFileSync(source,partial);
  assert.ok(!load().nodes.some(node=>node.id==='entity:E0200'));
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,before);
  writeFileSync(source,body('Edited body.'));
  assert.match(load().nodes.find(node=>node.id==='entity:E0200').definition,/Edited body/);
  rmSync(source);
  assert.ok(!load().nodes.some(node=>node.id==='entity:E0200'));
  assert.deepEqual(JSON.parse(readFileSync(bindingPath,'utf8')).bindings,[]);
}));

test('reparents a retained grandchild to the nearest retained ancestor when backed parent and child disappear together',()=>withSeries(({root,dataDir,safePath})=>{
  mkdirSync(join(root,'World','Sources'),{recursive:true});
  writeFileSync(join(root,'World','Sources','parent.md'),'# Parent\nParent source.');
  writeFileSync(join(root,'World','Sources','child.md'),'# Child\nChild source.');
  const index={schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'category:world',title:'Мир',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'concept:parent',title:'Parent',parentId:'category:world',kind:'concept',type:'rule',status:'confirmed',definition:'Parent source.',sourceRefs:[{path:'World/Sources/parent.md',title:'Parent',version:'current',basis:'test'}]},
    {id:'concept:child',title:'Child',parentId:'concept:parent',kind:'concept',type:'rule',status:'confirmed',definition:'Child source.',sourceRefs:[{path:'World/Sources/child.md',title:'Child',version:'current',basis:'test'}]},
    {id:'concept:grandchild',title:'Grandchild',parentId:'concept:child',kind:'concept',type:'note',definition:'Retained.',sourceRefs:[]}
  ],edges:[{source:'concept:parent',target:'concept:child',kind:'related',basis:'parent-child'},{source:'concept:child',target:'concept:grandchild',kind:'related',basis:'child-grandchild'}]};
  writeFileSync(join(dataDir,'knowledge-outlines','series-1.json'),JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  assert.ok(load().nodes.some(node=>node.id==='concept:grandchild'));
  rmSync(join(root,'World','Sources','parent.md'));rmSync(join(root,'World','Sources','child.md'));
  const graph=load();
  assert.ok(!graph.nodes.some(node=>node.id==='concept:parent'||node.id==='concept:child'));
  assert.equal(graph.nodes.find(node=>node.id==='concept:grandchild').parentId,'category:world');
  assert.ok(!graph.edges.some(edge=>edge.source==='concept:parent'||edge.target==='concept:parent'||edge.source==='concept:child'||edge.target==='concept:child'));
}));

test('keeps an indexed typed node id across source rename and removes it safely after deletion',()=>withSeries(({root,dataDir,safePath})=>{
  const entities=join(root,'03 Сущности');mkdirSync(entities,{recursive:true});
  const oldPath=join(entities,'E0104.md');
  writeFileSync(oldPath,'---\ntype: note\nrecord_kind: entity\nid: E0104\ntitle: Identity\n---\n# Identity\nOriginal identity statement.');
  const index={schemaVersion:1,nodes:[
    {id:'knowledge:root',title:'Знания',parentId:null,kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'category:world',title:'Мир',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]},
    {id:'concept:identity',title:'Identity',parentId:'category:world',kind:'concept',type:'character',status:'confirmed',definition:'Cached identity text',sourceRefs:[{path:'03 Сущности/E0104.md',title:'Identity',version:'2026',basis:'typed source',anchor:'Identity'}]},
    {id:'concept:child',title:'Child',parentId:'concept:identity',kind:'concept',type:'note',definition:'',sourceRefs:[]}
  ],edges:[{source:'concept:identity',target:'concept:child',kind:'related',basis:'reference'}]};
  writeFileSync(join(dataDir,'knowledge-outlines','series-1.json'),JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  const first=load();
  assert.equal(first.nodes.find(node=>node.id==='concept:identity').definition,'# Identity\nOriginal identity statement.');
  const renamed=join(entities,'E0104-renamed.md');
  writeFileSync(renamed,'---\ntype: note\nrecord_kind: entity\nid: E0104\ntitle: Identity\n---\n# Identity\nRevised identity statement.');
  rmSync(oldPath);
  const moved=load();
  const identity=moved.nodes.find(node=>node.id==='concept:identity');
  assert.ok(identity);
  assert.equal(identity.sourceRefs[0].path,'03 Сущности/E0104-renamed.md');
  assert.equal(identity.definition,'# Identity\nRevised identity statement.');
  rmSync(renamed);
  const missing=load();
  assert.ok(!missing.nodes.some(node=>node.id==='concept:identity'));
  assert.equal(missing.nodes.find(node=>node.id==='concept:child').parentId,'category:world');
  assert.ok(!missing.edges.some(edge=>edge.source==='concept:identity'||edge.target==='concept:identity'));
}));

test('projects live entity profiles and typed plot lines and refreshes same-instance edits, adds, renames, and deletes',()=>withSeries(({root,dataDir,safePath})=>{
  const series=join(root,'01 Произведения','Рождение бури','03 Сюжетные линии');
  mkdirSync(join(root,'03 Сущности'),{recursive:true});mkdirSync(series,{recursive:true});
  writeFileSync(join(root,'03 Сущности','E0104.md'),'---\ntype: note\nrecord_kind: entity\nid: E0104\ntitle: Деспар и Пелун\n---\n# Деспар и Пелун\nОбщая личность.');
  writeFileSync(join(root,'03 Сущности','E0007.md'),'---\ntype: note\nrecord_kind: entity\nid: E0007\ntitle: Source title\n---\n# Source title\nFresh source definition.');
  writeFileSync(join(root,'03 Сущности','E0135.md'),'---\ntype: note\nrecord_kind: entity\nid: E0135\ntitle: Деспар — профиль прошлого\nidentity_parent: E0104\n---\n# Деспар — профиль прошлого\nСтарый профиль.');
  writeFileSync(join(root,'03 Сущности','E0136.md'),'---\ntype: note\nrecord_kind: entity\nid: E0136\ntitle: Пелун — профиль настоящего\nidentity_parent: E0104\n---\n# Пелун — профиль настоящего\nТекущий профиль.');
  const line=join(series,'past.md');
  writeFileSync(line,'---\ntype: note\nrecord_kind: book-plot-line\nline_id: PL-PAST\nidentity: E0104\ncharacter_period: E0135\n---\n# Деспар — прошлое\nСтарая линия.');
  const archived=join(root,'01 Книги','Old book','03 Сюжетные линии','past.md');mkdirSync(join(root,'01 Книги','Old book','03 Сюжетные линии'),{recursive:true});
  writeFileSync(archived,'---\ntype: note\nrecord_kind: book-plot-line\nline_id: PL-PAST\nidentity: E0104\ncharacter_period: E0135\nnarrative_status: archive-version\n---\n# Старая архивная линия\nНеактуальный дубль.');
  const index=fixture();index.nodes.push({id:'concept:identity',title:'Old identity title',parentId:'category:world',kind:'concept',type:'character',definition:'stale',sourceRefs:[{path:'03 Сущности/E0104.md',title:'Old',version:'old',basis:'structured'}]});index.nodes.push({id:'term:shared',title:'Shared notes',parentId:'concept:identity',kind:'concept',type:'world',definition:'Keep stable',sourceRefs:[{path:'World/Rules.md',title:'Rules',version:'2026',basis:'explicit'}]});index.nodes.push({id:'term:curated',title:'Author chosen name',originalTitle:'Source old name',placementBasis:'Прямая поправка автора: явное название.',parentId:'category:world',kind:'concept',type:'world',definition:'stale copy',sourceRefs:[{path:'03 Сущности/E0007.md',title:'Source title',version:'old',basis:'structured'}]});index.nodes.push({id:'category:plot',title:'Сюжет',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]});
  writeFileSync(join(dataDir,'knowledge-outlines','series-1.json'),JSON.stringify(index));
  const load=()=>loadConceptGraph({dataDir,seriesId:'series-1',root,safePath});
  let graph=load();
  assert.equal(graph.nodes.find(n=>n.id==='entity:E0135').parentId,'concept:identity');
  assert.equal(graph.nodes.find(n=>n.id==='entity:E0136').parentId,'concept:identity');
  assert.equal(graph.nodes.find(n=>n.id==='concept:identity').title,'Деспар и Пелун');
  assert.equal(graph.nodes.find(n=>n.id==='term:curated').title,'Author chosen name');
  assert.match(graph.nodes.find(n=>n.id==='term:curated').definition,/Fresh source definition/);
  assert.equal(graph.nodes.find(n=>n.id==='term:shared').parentId,'concept:identity:shared');
  assert.equal(graph.nodes.find(n=>n.id==='concept:identity:shared').title,'Общие сведения');
  assert.equal(graph.nodes.find(n=>n.id==='plotline:PL-PAST').parentId,'category:plot');
  assert.match(graph.nodes.find(n=>n.id==='entity:E0135').definition,/Старый профиль/);
  const firstRevision=graph.revision;
  writeFileSync(join(root,'03 Сущности','E0135.md'),'---\ntype: note\nrecord_kind: entity\nid: E0135\ntitle: Деспар — профиль истории\nidentity_parent: E0104\n---\n# Деспар — профиль истории\nНовая версия определения.');
  const renamedLine=join(series,'past-renamed.md');rmSync(line);writeFileSync(renamedLine,'---\ntype: note\nrecord_kind: book-plot-line\nline_id: PL-PAST\nidentity: E0104\ncharacter_period: E0135\n---\n# Линия прошлого\nОбновлённая линия.');
  graph=load();
  assert.notEqual(graph.revision,firstRevision);
  assert.equal(graph.nodes.find(n=>n.id==='entity:E0135').title,'Деспар — профиль истории');
  assert.match(graph.nodes.find(n=>n.id==='entity:E0135').definition,/Новая версия определения/);
  assert.equal(graph.nodes.find(n=>n.id==='plotline:PL-PAST').title,'Линия прошлого');
  assert.equal(graph.nodes.find(n=>n.id==='plotline:PL-PAST').sourceRefs[0].path,'01 Произведения/Рождение бури/03 Сюжетные линии/past-renamed.md');
  rmSync(join(root,'03 Сущности','E0135.md'));rmSync(renamedLine);
  graph=load(); assert.ok(!graph.nodes.some(n=>n.id==='entity:E0135')); assert.ok(!graph.nodes.some(n=>n.id==='plotline:PL-PAST'));
}));

test('workspace graph loads only the selected series outline and uses the active selection',()=>{
  const base=mkdtempSync(join(tmpdir(),'talewisp-concept-workspace-')),vault=join(base,'vault'),series=join(vault,'00 Автор','Author','Series'),dataDir=join(base,'data');
  mkdirSync(join(series,'World'),{recursive:true});writeFileSync(join(series,'00 Паспорт серии.md'),'# Series');writeFileSync(join(series,'World','Rules.md'),'# Rules\n\n## Magic\nОсновное пояснение\n\n## 2019\nВерсия определения 2019');
  const values=new Map(),store={getSetting:key=>values.get(key)??null,setSetting:(key,value)=>values.set(key,value),listWorkspaceProposals:()=>[]};
  try{
    const service=createWorkspaceService({catalogVaultPath:vault,initialVaultPath:null,store,dataDir});
    const catalog=service.catalog(),author=catalog.authors[0],seriesRow=author.series[0],book=seriesRow.books[0];
    service.select({authorId:author.id,seriesId:seriesRow.id,bookId:book?.id??null});
    mkdirSync(join(dataDir,'knowledge-outlines'),{recursive:true});
    const serviceIndex=fixture();serviceIndex.nodes.push({id:'category:entities',title:'Сущности',parentId:'category:world',kind:'category',type:'category',definition:'',sourceRefs:[]},{id:'category:plot',title:'Сюжет',parentId:'knowledge:root',kind:'category',type:'category',definition:'',sourceRefs:[]});
    const outlinePath=join(dataDir,'knowledge-outlines',`${seriesRow.id}.json`);
    writeFileSync(outlinePath,JSON.stringify(serviceIndex));
    const graph=service.graph();
    assert.deepEqual(graph.selection,{authorId:author.id,seriesId:seriesRow.id,bookId:book?.id??null});
    assert.equal(graph.nodes.find(n=>n.id==='term:magic').definition,'Основное пояснение');
    const entities=join(series,'03 Сущности'), plots=join(series,'01 Произведения','Work','03 Сюжетные линии');mkdirSync(entities,{recursive:true});mkdirSync(plots,{recursive:true});
    const identityBody='# Общая идентичность\nПервая часть.\n\n## Подробности\nВторая часть.';
    const profileBody='# Профиль прошлого\nНачальное описание.\n\n## Подробности\nНачальная деталь профиля.';
    const plotBody='# Прошлая линия\nНачальная линия.\n\n## Подробности\nНачальная деталь линии.';
    writeFileSync(join(entities,'E0104.md'),`---\ntype: note\nrecord_kind: entity\nid: E0104\ntitle: Общая идентичность\n---\n${identityBody}`);
    writeFileSync(join(entities,'E0135.md'),`---\ntype: note\nrecord_kind: entity\nid: E0135\ntitle: Профиль прошлого\nidentity_parent: E0104\n---\n${profileBody}`);
    const plotPath=join(plots,'past.md');
    writeFileSync(plotPath,`---\ntype: note\nrecord_kind: book-plot-line\nline_id: PL-PAST\nidentity: E0104\ncharacter_period: E0135\n---\n${plotBody}`);
    serviceIndex.nodes.push({id:'concept:identity',title:'Старая подпись',parentId:'category:entities',kind:'concept',type:'character',status:'confirmed',definition:'УСТАРЕВШИЙ КЭШ',definitions:[{text:'УСТАРЕВШИЙ КЭШ',sourceTitle:'Identity',version:'current',status:'source-bound',path:'03 Сущности/E0104.md'}],sourceRefs:[{path:'03 Сущности/E0104.md',title:'Identity',version:'cached',basis:'explicit structured source'}]});
    writeFileSync(outlinePath,JSON.stringify(serviceIndex));
    const sameServiceFirst=service.graph();
    assert.ok(sameServiceFirst.nodes.some(n=>n.id==='entity:E0135'));
    assert.ok(sameServiceFirst.nodes.some(n=>n.id==='plotline:PL-PAST'));
    assert.equal(sameServiceFirst.nodes.find(n=>n.id==='concept:identity').definition,identityBody);
    assert.equal(sameServiceFirst.nodes.find(n=>n.id==='concept:identity').definitions[0].text,identityBody);
    assert.equal(sameServiceFirst.nodes.find(n=>n.id==='entity:E0135').definition,profileBody);
    assert.equal(sameServiceFirst.nodes.find(n=>n.id==='plotline:PL-PAST').definition,plotBody);
    const updatedProfileBody='# Профиль после правки\nОбновлённое описание.\n\n## Подробности\nОбновлённая деталь профиля.';
    const updatedPlotBody='# Линия прошлого\nОбновлённая линия.\n\n## Подробности\nОбновлённая деталь линии.';
    writeFileSync(join(entities,'E0135.md'),`---\ntype: note\nrecord_kind: entity\nid: E0135\ntitle: Профиль после правки\nidentity_parent: E0104\n---\n${updatedProfileBody}`);
    writeFileSync(join(entities,'E0136.md'),'---\ntype: note\nrecord_kind: entity\nid: E0136\ntitle: Профиль настоящего\nidentity_parent: E0104\n---\n# Профиль настоящего\nВторая карточка.');
    const renamedPlotPath=join(plots,'past-renamed.md');rmSync(plotPath);writeFileSync(renamedPlotPath,`---\ntype: note\nrecord_kind: book-plot-line\nline_id: PL-PAST\nidentity: E0104\ncharacter_period: E0135\n---\n${updatedPlotBody}`);
    const sameServiceNext=service.graph();
    assert.notEqual(sameServiceNext.revision,sameServiceFirst.revision);
    assert.equal(sameServiceNext.nodes.find(n=>n.id==='entity:E0135').title,'Профиль после правки');
    assert.equal(sameServiceNext.nodes.find(n=>n.id==='entity:E0135').definition,updatedProfileBody);
    assert.ok(sameServiceNext.nodes.some(n=>n.id==='entity:E0136'));
    assert.equal(sameServiceNext.nodes.find(n=>n.id==='entity:E0135').parentId,'concept:identity');
    assert.equal(sameServiceNext.nodes.find(n=>n.id==='plotline:PL-PAST').definition,updatedPlotBody);
    assert.equal(sameServiceNext.nodes.find(n=>n.id==='plotline:PL-PAST').sourceRefs[0].path,'01 Произведения/Work/03 Сюжетные линии/past-renamed.md');
  }finally{rmSync(base,{recursive:true,force:true});}
});
