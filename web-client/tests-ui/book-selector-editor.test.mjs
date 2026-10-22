import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildWorkspaceSelectionRequest } from '../public/workspace-adapters.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const catalogFunctions = app.slice(app.indexOf('  function activeCatalogItems() {'), app.indexOf('  function renderCatalogSelectors() {'));
const selectHandler = app.slice(app.indexOf('  async function selectWorkspace() {'), app.indexOf('  async function loadOverview() {'));
// Books are their own entities; Google Docs are companion attachments of a book.
const catalog = () => ({ active: { authorId:'author', seriesId:'series', bookId:'new-book' }, authors:[{ id:'author', series:[{ id:'series', books:[
  { id:'old-book', name:'Old book', attachments:[{ id:'att-old', name:'Old companion', kind:'google-doc', googleDocumentId:'old-google' }] },
  { id:'new-book', name:'Selected book', attachments:[{ id:'att-new', name:'Selected companion', kind:'google-doc', googleDocumentId:'selected-google' }] },
  { id:'plain-book', name:'Book without Docs', attachments:[] }
] }] }] });

function selectionContext(events, state, bookId) {
  return {
    state, buildWorkspaceSelectionRequest, knowledgeWorkspaceChanging:false, knowledgeViewRevision:0, knowledgeCardRequest:0, knowledgeMap:null,
    $: selector => ({value: {'#author-select':'author','#series-select':'series','#book-select':bookId}[selector]}),
    document:{getElementById:()=>null}, stash:()=>{},
    saveQueue:{flush:async key=>events.push('flush:'+key)},
    api:async(path,options)=>{ assert.equal(path,'/api/workspace/select'); assert.equal(options.body.bookId,bookId);events.push('select:'+bookId);const next=catalog();next.active.bookId=bookId;return next; },
    openController:{invalidate:()=>{}}, hideGoogleNativeEditor:()=>{events.push('hide-google');state.googleNativeOpen=false;},
    renderCurrent:()=>{}, renderContextSources:()=>{}, renderCatalogSelectors:()=>{}, rememberNavigation:()=>{}, notify:()=>{},
    showGoogleNativeEditor:doc=>{throw Error('Selecting a book must never open Google Docs: '+doc.documentId);},
    loadLists:async()=>events.push('lists'),loadOverview:async()=>events.push('overview'),loadAgent:async()=>events.push('agent'),
    closeWorkspace:()=>{},restorePortal:()=>{},switchView:view=>events.push('view:'+view),showPrimaryView:()=>{throw Error('No separate Google picker');}
  };
}

test('selecting a book flushes drafts, confirms on the server and opens the book workspace, never its Google Docs', async () => {
  const events = [], state = { catalog:catalog(), drafts:new Map([['document:local',{dirty:false}]]), current:{kind:'document',id:'local'}, sources:new Set(['previous']), googleNativeOpen:true, googleDoc:{documentId:'old-google'}, selectedText:'old', view:'documents' };
  state.catalog.active.bookId='old-book';
  const select = runInNewContext(catalogFunctions + '\n' + selectHandler + '\nselectWorkspace', selectionContext(events, state, 'new-book'));
  await select();
  assert.deepEqual(events.slice(0,4),['flush:document:local','select:new-book','hide-google','view:documents']);
  assert.ok(!events.some(event => event.startsWith('open:')));
  assert.equal(state.current,null);
  assert.equal(state.selectedText,'');
  assert.equal(state.sources.size,0,'agent sources of the previous book are dropped');
  assert.equal(state.googleNativeOpen,false);
  assert.equal(state.googleDoc,null);
  assert.equal(state.workspaceSelectionError,'');
});

test('a book without any Google Docs is selectable and opens its own workspace', async () => {
  const events = [], state = { catalog:catalog(), drafts:new Map(), current:null, sources:new Set(), googleNativeOpen:false, googleDoc:null, selectedText:'', view:'overview' };
  const select = runInNewContext(catalogFunctions + '\n' + selectHandler + '\nselectWorkspace', selectionContext(events, state, 'plain-book'));
  await select();
  assert.deepEqual(events.slice(0,3),['select:plain-book','hide-google','view:documents']);
  assert.equal(state.catalog.active.bookId,'plain-book');
});

test('a dirty draft blocks the switch before the server is asked', async () => {
  const events = [], state = { catalog:catalog(), drafts:new Map([['document:local',{dirty:true}]]), current:null, sources:new Set(['kept']), googleNativeOpen:false, googleDoc:null, selectedText:'', view:'documents' };
  const select = runInNewContext(catalogFunctions + '\n' + selectHandler + '\nselectWorkspace', selectionContext(events, state, 'new-book'));
  await select();
  assert.ok(!events.includes('select:new-book'));
  assert.match(state.workspaceSelectionError,/сохраните/i);
  assert.equal(state.sources.size,1);
});

test('only a Google Doc still attached to the open book can be reopened, never a fabricated one', () => {
  const opened = [];
  const state = {catalog:catalog()};
  const restore = runInNewContext(catalogFunctions + '\nrestoreOpenedCompanionDocument', {state,showGoogleNativeEditor:doc=>{opened.push(doc);return true;}});
  assert.equal(restore('old-google'),false,'a companion of another book is not opened');
  assert.equal(restore(''),false);
  assert.equal(restore(null),false);
  assert.equal(restore('selected-google'),true);
  assert.deepEqual(opened.map(doc=>[doc.documentId,doc.title]),[['selected-google','Selected companion']]);
});

test('main navigation does not add a separate Google Docs section', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const navigation=html.slice(html.indexOf('<nav class="primary-nav">'),html.indexOf('</nav>'));
  assert.doesNotMatch(navigation,/data-view="google"/);
});
