import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const between=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const showCard=between('  async function showKnowledgeCard(card, buttonNode) {','  async function resolveAgentReference(');
function fixture() {
  const calls=[],pending=[],selected=[];
  const state={view:'knowledge',knowledgeScope:'active',knowledgeSelectedPath:null,knowledgeSelectedConceptId:null,sources:new Set()};
  const reader={isConnected:true,replaceChildren(){}};
  const ctx={state,special:{},knowledgeCardRequest:0,knowledgeMap:{select:path=>selected.push(path)},
    $:key=>key==='.knowledge-reader'?reader:null,$$:()=>[],showToolPanel:async()=>{},rememberNavigation(){},node:()=>({}),
    api:url=>{calls.push(url);return new Promise(resolve=>pending.push(resolve));}};
  runInNewContext(showCard,ctx);
  return {ctx,state,calls,pending,selected};
}
// Mirrors the delayed graph restore in knowledge(): an ordinary path left in state is reopened without attachmentId.
const lateGraphRestore=f=>{ if(f.state.knowledgeSelectedPath) f.ctx.showKnowledgeCard({path:f.state.knowledgeSelectedPath},null); };
test('pending companion attachment never becomes an ordinary knowledge path for late graph restore',async()=>{
  const f=fixture();
  const opening=f.ctx.showKnowledgeCard({scope:'active',attachmentId:'att-1',path:'companions/old-series/doc.md',title:'Doc'},null);
  await Promise.resolve();
  assert.deepEqual(f.calls,['/api/project/attachments/att-1/source']);
  assert.equal(f.state.knowledgeSelectedPath,null);
  assert.deepEqual(f.selected,[]);
  lateGraphRestore(f);
  assert.ok(!f.calls.some(url=>url.startsWith('/api/knowledge/card')));
  f.ctx.knowledgeCardRequest++; f.pending[0]({title:'Doc',path:'companions/old-series/doc.md',body:'',readOnly:true}); await opening;
  assert.equal(f.state.sources.size,0);
});
test('ordinary knowledge cards keep their own relative path',async()=>{
  const f=fixture();
  const opening=f.ctx.showKnowledgeCard({path:'cards/hero.md'},null);
  await Promise.resolve();
  assert.equal(f.state.knowledgeSelectedPath,'cards/hero.md');
  assert.deepEqual(f.selected,['cards/hero.md']);
  assert.deepEqual(f.calls,['/api/knowledge/card?path=cards%2Fhero.md']);
  f.ctx.knowledgeCardRequest++; f.pending[0]({path:'cards/hero.md',body:''}); await opening;
});
