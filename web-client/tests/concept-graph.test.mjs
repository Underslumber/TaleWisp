import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConceptGraph, normalizeConceptGraph } from '../concept-graph.mjs';
import { createWorkspaceService } from '../workspace.mjs';

const withSeries = fn => {
  const base=mkdtempSync(join(tmpdir(),'talewisp-concepts-')), root=join(base,'series'),dataDir=join(base,'data');
  mkdirSync(join(root,'World'),{recursive:true}); mkdirSync(join(dataDir,'knowledge-outlines'),{recursive:true});
  writeFileSync(join(root,'World','Rules.md'),'# Rules','utf8');
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
  assert.throws(()=>normalizeConceptGraph({...fixture(),nodes:Array.from({length:1001},(_,i)=>({id:`n${i}`,title:'n',parentId:null,kind:'concept',definition:'',sourceRefs:[]}))},{root,safePath}),/node limit/);
}));

test('workspace graph loads only the selected series outline and uses the active selection',()=>{
  const base=mkdtempSync(join(tmpdir(),'talewisp-concept-workspace-')),vault=join(base,'vault'),series=join(vault,'00 Автор','Author','Series'),dataDir=join(base,'data');
  mkdirSync(join(series,'World'),{recursive:true});writeFileSync(join(series,'00 Паспорт серии.md'),'# Series');writeFileSync(join(series,'World','Rules.md'),'# Rules');
  const values=new Map(),store={getSetting:key=>values.get(key)??null,setSetting:(key,value)=>values.set(key,value),listWorkspaceProposals:()=>[]};
  try{
    const service=createWorkspaceService({catalogVaultPath:vault,initialVaultPath:null,store,dataDir});
    const catalog=service.catalog(),author=catalog.authors[0],seriesRow=author.series[0],book=seriesRow.books[0];
    service.select({authorId:author.id,seriesId:seriesRow.id,bookId:book?.id??null});
    mkdirSync(join(dataDir,'knowledge-outlines'),{recursive:true});
    writeFileSync(join(dataDir,'knowledge-outlines',`${seriesRow.id}.json`),JSON.stringify(fixture()));
    const graph=service.graph();
    assert.deepEqual(graph.selection,{authorId:author.id,seriesId:seriesRow.id,bookId:book?.id??null});
    assert.equal(graph.nodes.find(n=>n.id==='term:magic').definition,'Основное пояснение');
  }finally{rmSync(base,{recursive:true,force:true});}
});
