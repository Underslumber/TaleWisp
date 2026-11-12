import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual reader and graph-load functions without booting the
// unrelated application panels or changing production code for test exports.
const app = readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const loadSource = app.slice(app.indexOf('    const load = async ({ preserve = false }'),app.indexOf("    scope.addEventListener('change'",app.indexOf('    const load = async ({ preserve = false }')));
const cardSource = app.slice(app.indexOf('  async function showKnowledgeCard('),app.indexOf('  async function resolveAgentReference('));
const deferred = () => { let resolve; const promise = new Promise(done=>{resolve=done;}); return {promise,resolve}; };
class Element {
  constructor(text='') { this.children=[]; this._text=text; this.isConnected=true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; this._text=''; }
  querySelectorAll() { return []; }
  get textContent() { return this._text+this.children.map(child=>child?.textContent??'').join(''); }
  set textContent(value) { this._text=value; }
  setAttribute() {}
  addEventListener() {}
}
function harness() {
  const reader=new Element(),cardResponses=[],graphResponse=deferred();
  const context={
    request:0,revision:1,knowledgeViewRevision:1,knowledgeCardRequest:0,knowledgeCardPending:0,knowledgeSelectedCard:null,
    knowledgeGraph:{mode:'concepts',revision:'before',nodes:[]},
    knowledgeMap:{snapshot:()=>({selected:'old'}),destroy(){},select(){return true;}},
    state:{view:'knowledge',knowledgeScope:'active',knowledgeSelectedPath:null,knowledgeSelectedConceptId:null,sources:new Set()},
    reader,mapHost:new Element(),special:new Element(),refresh:{disabled:false},
    clearFreshnessWarning(){},showFreshnessWarning(){},withConceptMentions:graph=>graph,
    createKnowledgeMap:()=>({snapshot:()=>({selected:'new'}),restore(){},destroy(){},select(){return true;}}),
    showConceptDefinition(){throw Error('Unexpected concept selection');},
    $:selector=>selector==='.knowledge-reader'?reader:null,$$:()=>[],
    node:(tag,style,text='')=>new Element(text),btn:text=>new Element(text),empty:title=>new Element(title),
    document:{createElement:()=>new Element()},rememberNavigation(){},renderContextSources(){},
    friendlyRecordType:()=>'',renderSafeMarkdown:(element,text)=>{element.textContent=text;},
    api:url=>{if(url.startsWith('/api/knowledge/graph'))return graphResponse.promise;const response=deferred();cardResponses.push({url,...response});return response.promise;},
  };
  vm.createContext(context);
  vm.runInContext(`${loadSource}\n${cardSource}\nthis.load=load;`,context);
  return {context,reader,cardResponses,graphResponse};
}

test('an unchanged preserve poll leaves the explicit card request able to render',async()=>{
  const {context,reader,cardResponses,graphResponse}=harness();
  const explicit=context.showKnowledgeCard({path:'World/Selected.md'},null);
  const poll=context.load({preserve:true});
  graphResponse.resolve({mode:'concepts',revision:'before',nodes:[]});
  assert.equal((await poll).unchanged,true);
  assert.equal(context.knowledgeCardRequest,1);
  cardResponses[0].resolve({path:'World/Selected.md',title:'Selected',body:'Explicit selected body.'});
  await explicit;
  assert.match(reader.textContent,/Explicit selected body\./);
  assert.equal(cardResponses.length,1);
});

test('a changed preserve poll refreshes the map without overriding a newer explicit card load',async()=>{
  const {context,reader,cardResponses,graphResponse}=harness();
  const poll=context.load({preserve:true});
  const explicit=context.showKnowledgeCard({path:'World/Newer.md'},null);
  graphResponse.resolve({mode:'concepts',revision:'after',nodes:[]});
  await poll;
  assert.equal(context.knowledgeGraph.revision,'after');
  assert.equal(context.state.knowledgeSelectedPath,'World/Newer.md');
  assert.equal(context.knowledgeCardRequest,1);
  assert.equal(cardResponses.length,1);
  cardResponses[0].resolve({path:'World/Newer.md',title:'Newer',body:'Newer explicit body.'});
  await explicit;
  assert.match(reader.textContent,/Newer explicit body\./);
});

test('a changed poll does not restart an earlier pending explicit anchored card',async()=>{
  const {context,reader,cardResponses,graphResponse}=harness();
  const explicit=context.showKnowledgeCard({path:'World/Selected.md',anchor:'Details'},null);
  const poll=context.load({preserve:true});
  graphResponse.resolve({mode:'concepts',revision:'after',nodes:[]});
  await poll;
  assert.equal(cardResponses.length,1);
  assert.equal(context.knowledgeSelectedCard.anchor,'Details');
  assert.equal(context.knowledgeCardPending,1);
  cardResponses[0].resolve({path:'World/Selected.md',title:'Selected',body:'Explicit anchored body.'});
  await explicit;
  assert.match(reader.textContent,/Explicit anchored body\./);
  assert.equal(context.knowledgeCardPending,0);
});

test('a changed poll retains the full reference when refreshing a completed anchored card',async()=>{
  const {context,cardResponses,graphResponse}=harness();
  const explicit=context.showKnowledgeCard({path:'World/Selected.md',anchor:'Details'},null);
  cardResponses[0].resolve({path:'World/Selected.md',title:'Selected',body:'Original body.'});
  await explicit;
  const poll=context.load({preserve:true});
  graphResponse.resolve({mode:'concepts',revision:'after',nodes:[]});
  await poll;
  assert.equal(cardResponses.length,2);
  assert.equal(context.knowledgeSelectedCard.anchor,'Details');
  cardResponses[1].resolve({path:'World/Selected.md',title:'Selected',body:'Updated body.'});
});
