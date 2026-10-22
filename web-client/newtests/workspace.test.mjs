import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStore } from '../store.mjs';
import { createWorkspaceService } from '../workspace.mjs';
import { scopeKey } from '../workspace-scope.mjs';

function fixture(t, { isAgentRunning=()=>false } = {}) {
  const root=mkdtempSync(join(resolve('.'),'.workspace-test-'));
  let store;
  t.after(()=>{store?.close();rmSync(root,{recursive:true,force:true});});
  const catalog=join(root,'vault'), author=join(catalog,'00 Автор','Writer'), series=join(author,'Series Alpha'), book=join(series,'01 Книги','Book One');
  const put=(path,text)=>{mkdirSync(join(catalog,path.split('/').slice(0,-1).join('/')),{recursive:true});writeFileSync(join(catalog,path),text,'utf8');};
  put('00 Автор/Writer/Автор.md','---\ntype: author\ntitle: Writer\n---\n# Writer');
  put('00 Автор/Writer/Series Alpha/00 Паспорт/Паспорт серии.md','---\ntype: passport\ntitle: Series Alpha\n---\n# Series Alpha\nАвторский стиль исключён из работы по прямому указанию автора.');
  put('00 Автор/Writer/Series Alpha/01 Книги/Book One/Book One.md','---\ntype: book\ntitle: Book One\nbook_id: B08\n---\n# Book One');
  put('00 Автор/Writer/Series Alpha/00 Источники/B08/B08-C001.md','---\ntype: note\nrecord_kind: source-chapter\nbook_id: B08\nchapter_id: B08-C001\ntitle: First chapter\n---\n# t.0 / Tab 1\n## B08-C001-P0001\nA literal manuscript sentence.\n');
  put('00 Автор/Writer/Series Alpha/04 Анализ/B08-C001-analysis.md','---\ntype: note\nrecord_kind: scene-analysis\nbook_id: B08\ntitle: Scene analysis\n---\n# Analysis only\nThis must not enter source word counts.\n');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Лексический словарь.md','---\ntype: note\nstatus: confirmed\n---\n# Lexicon');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Style Feature.md','---\ntype: note\n---\n# Style Feature');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Source.md','---\ntype: note\n---\n# Links\n[[Shared]] and [unsafe](javascript:alert(1))');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Relative.md','---\ntype: note\n---\n# Relative\n[alias](../03 Сущности/Shared.md#details)');
  put('00 Автор/Writer/Series Alpha/06 Ссылки/Ambiguous.md','---\ntype: note\n---\n# Ambiguous\n[[Shared]]');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Plain note.txt','Plain text note without frontmatter.');
  put('00 Автор/Writer/Series Alpha/03 Сущности/Shared.md','---\ntype: character\n---\n# Shared');
  put('00 Автор/Writer/Series Alpha/04 Анализ/Shared.md','---\ntype: note\n---\n# Shared');
  put('Legacy.md','---\ntype: note\n---\n# Legacy card');
  const dataDir=join(root,'data');store=openStore(dataDir);
  const workspace=createWorkspaceService({catalogVaultPath:catalog,initialVaultPath:series,store,dataDir,isAgentRunning});
  return {root,catalog,series,book,store,workspace};
}

test('native corpus metadata binds a navigation without frontmatter and scopes book aliases',async t=>{
  const f=fixture(t);writeFileSync(join(f.book,'Book One.md'),'# Book One\n[[02 Сцены/Scene]]');
  writeFileSync(join(f.series,'00 Источники','B08 - корпус.json'),JSON.stringify({book_id:'B08',metadata:{title:'Book One'},chapters:[]}));
  writeFileSync(join(f.series,'04 Анализ','Other scene.md'),'---\nrecord_kind: scene-analysis\nbook: B09\n---\n# Other book scene');
  writeFileSync(join(f.series,'04 Анализ','Matching scene.md'),'---\nrecord_kind: scene-analysis\nbook: B08\n---\n# Matching scene');
  const fresh=createWorkspaceService({catalogVaultPath:f.catalog,initialVaultPath:f.series,store:f.store,dataDir:join(f.root,'data')});
  const overview=await fresh.overview();assert.equal(overview.sourceWords,4);assert.equal(overview.manuscripts.length,1);
  assert.ok(overview.sceneAnalyses.some(x=>x.title==='Matching scene'));assert.ok(!overview.sceneAnalyses.some(x=>x.title==='Other book scene'));
  assert.ok(!overview.notes.some(x=>x.title==='Other book scene'));
});

test('initial series fallback binds the first book before any explicit selection',async t=>{
  const f=fixture(t),second=join(f.series,'01 Книги','Book Two');mkdirSync(second,{recursive:true});
  writeFileSync(join(second,'Book Two.md'),'---\ntype: book\nbook_id: B09\n---\n# Book Two');
  const sources=join(f.series,'00 Источники','B09');mkdirSync(sources,{recursive:true});
  writeFileSync(join(sources,'B09-C001.md'),'---\nrecord_kind: source-chapter\nbook_id: B09\n---\nOther book words must stay outside.');
  const fresh=createWorkspaceService({catalogVaultPath:f.catalog,initialVaultPath:f.series,store:f.store,dataDir:join(f.root,'data')});
  const overview=await fresh.overview();assert.equal(overview.manuscripts.length,1);assert.equal(overview.sourceWords,4);
  assert.match(overview.manuscripts[0].path,/B08/);
});

test('catalog selection persists and source-bound workspace separates source prose and analysis',async t=>{
  const f=fixture(t), catalog=f.workspace.catalog();
  assert.equal(catalog.authors[0].name,'Writer');
  assert.equal(catalog.authors[0].series[0].books[0].name,'Book One');
  assert.equal(catalog.unassigned.cardCount,1);
  const ids={authorId:catalog.authors[0].id,seriesId:catalog.authors[0].series[0].id,bookId:catalog.authors[0].series[0].books[0].id};
  f.workspace.select(ids);
  const overview=await f.workspace.overview();
  assert.equal(overview.manuscripts.length,1);
  assert.equal(overview.manuscripts[0].type,'source-chapter');
  assert.equal(overview.manuscripts[0].words,4);
  assert.equal(overview.sourceWords,4);
  assert.equal(overview.sceneAnalyses.length,1);
  assert.equal(overview.notes.some(row=>row.path==='00 Источники/B08/B08-C001.md'),false);
  assert.deepEqual(overview.style.paths,[]);
  assert.equal(overview.style.available,false);
  assert.equal(overview.style.excluded,true);assert.equal(overview.style.exclusionReason,'Авторский стиль исключён из работы по прямому указанию автора.');
  assert.deepEqual(overview.style.lexicalRules,['04 Анализ/Лексический словарь.md']);
  assert.equal(overview.notes.some(row=>row.path==='04 Анализ/Plain note.txt'),true);
  assert.deepEqual(f.workspace.selection(),{authorId:ids.authorId,authorName:'Writer',seriesId:ids.seriesId,seriesName:'Series Alpha',bookId:ids.bookId,bookName:'Book One'});
});

test('confirmed style is available only without an explicit exclusion and draft status outranks canon status',async t=>{
  const f=fixture(t),passport=join(f.series,'00 Паспорт','Паспорт серии.md');
  writeFileSync(passport,'---\ntype: passport\n---\n# Series Alpha');
  const profile=join(f.series,'04 Анализ','Author voice.md');
  writeFileSync(profile,'---\ntype: style-profile\nprofile_kind: author-voice\nsetup_status: confirmed\n---\n# Test voice\nFixture rules.');
  let style=(await f.workspace.overview()).style;
  assert.equal(style.available,true);assert.equal(style.excluded,false);
  writeFileSync(profile,'---\ntype: style-profile\nsetup_status: draft\ncanon_status: confirmed\n---\n# Unconfirmed test voice');
  style=(await f.workspace.overview()).style;
  assert.equal(style.available,false);assert.equal(style.excluded,false);
  assert.ok(style.lexicalRules.includes('04 Анализ/Лексический словарь.md'));
});

test('full-scope cards resolve backlinks and ambiguous links while stripping unsafe markdown',t=>{
  const f=fixture(t), c=f.workspace.catalog(), ids={authorId:c.authors[0].id,seriesId:c.authors[0].series[0].id,bookId:c.authors[0].series[0].books[0].id};
  f.workspace.select(ids);
  const search=f.workspace.cards({q:'literal manuscript'});
  assert.equal(search.matchedCount,1);
  assert.equal(search.cards[0].type,'note');
  const source=f.workspace.card('04 Анализ/Source.md');
  assert.match(source.body,/\[\[Shared\]\]/);
  assert.doesNotMatch(source.body,/javascript:/i);
  assert.equal(source.links[0].status,'resolved');assert.equal(source.links[0].path,'04 Анализ/Shared.md');
  assert.equal(source.backlinks.length,0);
  const character=f.workspace.card('03 Сущности/Shared.md');
  assert.equal(character.backlinks.some(row=>row.path==='04 Анализ/Relative.md'),true);
  assert.equal(f.workspace.card('04 Анализ/Relative.md').links[0].label,'Shared');
  assert.equal(f.workspace.card('06 Ссылки/Ambiguous.md').links[0].status,'ambiguous');
  assert.equal(f.workspace.cards({scope:'unassigned'}).cards[0].path,'Legacy.md');
  assert.equal(f.workspace.cards({q:'Plain text'}).matchedCount,1);
  const chapter=f.workspace.cards({q:'literal manuscript'}).cards[0];assert.doesNotMatch(chapter.excerpt,/t\.0|B08-C001-P0001|00 Источники/);
});

test('app proposals preserve exact before and after, require fresh source and back up only on explicit apply',t=>{
  const f=fixture(t), authors=f.workspace.catalog().authors, ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};
  f.workspace.select(ids);
  const path='04 Анализ/Source.md', before=readFileSync(join(f.series,path),'utf8');
  const pending=f.workspace.prepareProposal({path,text:before+'\nProposed exact addition.\n',title:'Source update'});
  assert.throws(()=>f.workspace.prepareProposal({path:'config/credentials.json',text:'secret'}),/story text files/);
  assert.equal(readFileSync(join(f.series,path),'utf8'),before);
  assert.equal(f.workspace.proposal(pending.id).before,before);
  assert.match(f.workspace.proposal(pending.id).diff,/\+Proposed exact addition/);
  writeFileSync(join(f.series,path),before+'Changed outside the proposal.');
  assert.throws(()=>f.workspace.applyProposal(pending.id),/Workspace changed|Source changed/);
  const save=f.workspace.prepareProposal({path,text:'Replacement from a fresh proposal.',title:'Source update'});
  const saved=f.workspace.applyProposal(save.id);
  assert.equal(saved.state,'applied');assert.equal(saved.backupCreated,true);
  assert.equal(readFileSync(join(f.series,path),'utf8'),'Replacement from a fresh proposal.');
  const prose=f.workspace.prepareProposal({path:null,text:'Local draft text',title:'A draft'});
  const applied=f.workspace.applyProposal(prose.id);
  const document=f.store.getDocument(applied.documentId);
  assert.equal(document.text,'Local draft text');
  assert.equal(document.seriesId,ids.seriesId);
  assert.equal(existsSync(join(f.series,'A draft.md')),false);
});

test('queued tool action remains pending until an app callback and applies idempotently',async t=>{
  const f=fixture(t), authors=f.workspace.catalog().authors, ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};f.workspace.select(ids);
  let calls=0;f.workspace.setActionApplier(async row=>{calls++;return {tool:row.tool,ok:true};});
  const queued=f.workspace.queueAction({tool:'talewisp_save_proposal',arguments:{replacement_text:'Exact text'},summary:'Review exact text'});
  assert.equal(f.workspace.listProposals()[0].state,'pending');
  assert.deepEqual((await f.workspace.applyAction(queued.id)).result,{tool:'talewisp_save_proposal',ok:true});
  await f.workspace.applyAction(queued.id);
  assert.equal(calls,1);
});

test('overview consumes installed tools and treats only read-only annotations as reads',async t=>{
  const f=fixture(t), authors=f.workspace.catalog().authors,ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};f.workspace.select(ids);
  const inputSchema={type:'object',properties:{path:{type:'string'}}},annotations={readOnlyHint:true,destructiveHint:false},native=[{name:'talewisp_read_card',description:'Reads a card',inputSchema,annotations},{name:'talewisp_continuity_gaps',description:'Prioritized repair queue.',inputSchema,annotations:{readOnlyHint:true}},{name:'talewisp_google_plan_edit',description:'Plan edit.',inputSchema,annotations:{readOnlyHint:false}}];
  f.workspace.setToolsProvider(async()=>native);
  const {capabilities}=await f.workspace.overview();
  assert.equal(capabilities.length,3);assert.equal(capabilities[0].mode,'read');assert.match(capabilities[0].title,/^Прочитать карточку$/);assert.equal(capabilities[0].inputSchema,inputSchema);assert.equal(capabilities[0].annotations,annotations);assert.equal(capabilities[1].title,'Пробелы связности');assert.match(capabilities[1].description,/указанным контрактам/);assert.equal(capabilities[2].title,'Подготовить план правки');assert.equal(capabilities[2].mode,'proposal');assert.doesNotMatch(capabilities[2].description,/Plan edit/);
});

test('style availability requires confirmed author-profile evidence',async t=>{
  const f=fixture(t),authors=f.workspace.catalog().authors,ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};f.workspace.select(ids);
  writeFileSync(join(f.series,'00 Паспорт','Паспорт серии.md'),'# Паспорт серии');
  writeFileSync(join(f.series,'04 Анализ','AuthorProfile.md'),'---\nrecord_kind: author-profile\nstatus: confirmed\n---\n# Confirmed profile');
  const overview=await f.workspace.overview();assert.equal(overview.style.available,true);assert.ok(overview.style.paths.includes('04 Анализ/AuthorProfile.md'));
});

test('workspace proposal ownership follows immutable author series and book binding',t=>{
  const f=fixture(t), authors=f.workspace.catalog().authors, series=authors[0].series[0], first=series.books[0], ids={authorId:authors[0].id,seriesId:series.id,bookId:first.id};
  f.workspace.select(ids);const p=f.workspace.prepareProposal({path:null,text:'scoped draft'});
  const next=join(f.series,'01 Книги','Book Two');mkdirSync(next,{recursive:true});writeFileSync(join(next,'Book Two.md'),'---\ntype: book\ntitle: Book Two\nbook_id: B09\n---\n# Book Two');
  const second=f.workspace.catalog().authors[0].series[0].books.find(row=>row.name==='Book Two');f.workspace.select({...ids,bookId:second.id});
  assert.equal(f.workspace.listProposals().some(row=>row.id===p.id),false);assert.throws(()=>f.workspace.proposal(p.id),/not found|another workspace/);
});

test('plugin action errors are durable needs-review states and are not retried',async t=>{
  const f=fixture(t),authors=f.workspace.catalog().authors,ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};f.workspace.select(ids);
  let calls=0;f.workspace.setActionApplier(async()=>{calls++;return {isError:true,content:[{text:'remote failure'}]};});const row=f.workspace.queueAction({tool:'google_suggest',arguments:{}});
  await assert.rejects(f.workspace.applyAction(row.id),/remote failure/);assert.equal(f.workspace.proposal(row.id).state,'needs_review');await assert.rejects(f.workspace.applyAction(row.id),/no longer pending/);assert.equal(calls,1);
});

test('proposal application remains pending while an agent turn is active',t=>{
  let running=false;const f=fixture(t,{isAgentRunning:()=>running}),authors=f.workspace.catalog().authors,ids={authorId:authors[0].id,seriesId:authors[0].series[0].id,bookId:authors[0].series[0].books[0].id};f.workspace.select(ids);
  const row=f.workspace.prepareProposal({path:null,text:'ready'});running=true;assert.throws(()=>f.workspace.applyProposal(row.id),/active agent turn/);assert.equal(f.workspace.proposal(row.id).state,'pending');
});

test('message history keeps tuple scopes separate and migrates only matching legacy bindings across restart',t=>{
  const root=mkdtempSync(join(resolve('.'),'.workspace-scope-test-'));let store=openStore(root);t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});
  const a={authorId:'author-a',seriesId:'series-a',bookId:'book-a'},b={authorId:'author-a',seriesId:'series-a',bookId:'book-b'},keyA=scopeKey(a),keyB=scopeKey(b);
  const legacyA=JSON.stringify({...a,authorName:'Old display name',seriesName:'Old series',bookName:'Old book'}),legacyB=JSON.stringify({...b,authorName:'Writer',seriesName:'Series',bookName:'Book B'});
  assert.equal(keyA,'["author-a","series-a","book-a"]');
  store.setMessageScope(keyA);store.addMessage('user','A tuple history');store.addMessage('assistant','A legacy history',legacyA);store.addMessage('user','B legacy history',legacyB);
  store.setMessageScope(keyB);assert.deepEqual(store.listMessages().map(row=>row.text),['B legacy history']);store.addMessage('user','B new history');
  store.setMessageScope(keyA);assert.deepEqual(store.listMessages().map(row=>row.text),['A tuple history','A legacy history']);
  store.close();store=openStore(root);store.setMessageScope(keyB);assert.deepEqual(store.listMessages().map(row=>row.text),['B legacy history','B new history']);
  store.setMessageScope(keyA);assert.deepEqual(store.listMessages().map(row=>row.text),['A tuple history','A legacy history']);
});
