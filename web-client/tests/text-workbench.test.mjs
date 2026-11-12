import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../store.mjs';
import {createManuscriptFiles} from '../manuscript-file.mjs';
import {formatRange,styleAt,resolveReviewQuote,normalizeRich} from '../public/text-review-model.js';
import {loadedFromSection,mergeLoaded,mergeWorkingChapter,settleAfterWrite,adoptCreated,isDirty,isLocalDirty,buildWritePayload} from '../public/manuscript-model.js';
import {buildTextReviewContext} from '../text-review-context.mjs';
function setup(t,cleanup=true){const dir=mkdtempSync(join(tmpdir(),'tw-rich-'));if(cleanup)t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
test('old-client corruption remains readable and exportable, with raw recovery and overwrite blocked',t=>{
 const dir=setup(t,false),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const d=store.createDocument({title:'recover',text:'original',rich:formatRange('original',null,0,8,'bold',true)});
 const raw=new DatabaseSync(join(dir,'talewisp-web.sqlite'));raw.prepare('UPDATE documents SET text=? WHERE id=?').run('x',d.id);raw.close();
 assert.equal(store.listDocuments()[0].text,'x');assert.ok(store.getDocument(d.id).richRecovery.includes('bold'));
 assert.ok(store.exportData().documents[0].richRecovery);assert.throws(()=>store.updateDocument(d.id,{title:'recover',text:'new',rich:null,version:1}));assert.equal(store.getDocument(d.id).text,'x');
});
test('draft rich data persists atomically with text/version and history; legacy client preserves it',t=>{
 const dir=setup(t,false),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const rich=formatRange('А😀\nБ',null,1,3,'bold',true);
 const doc=store.createDocument({title:'Тест',text:'А😀\nБ',rich});assert.deepEqual(doc.rich,rich);
 const next=store.updateDocument(doc.id,{title:doc.title,text:'А😀\nБ!',version:1}).document;
 assert.equal(styleAt(next.rich,1).bold,true);assert.equal(next.version,2);
 assert.equal(store.updateDocument(doc.id,{title:'stale',text:'bad',version:1}).conflict,true);
 assert.throws(()=>store.updateDocument(doc.id,{title:'bad',text:'x',rich,version:2}));assert.equal(store.getDocument(doc.id).version,2);
 const cleared=store.updateDocument(doc.id,{title:doc.title,text:next.text,rich:{v:1,ranges:[]},version:2}).document;assert.deepEqual(cleared.rich.ranges,[]);
 const old=store.documentHistory(doc.id).find(x=>x.version===1);const restored=store.restoreDocument(doc.id,old.id,3).document;assert.equal(restored.text,doc.text);assert.deepEqual(restored.rich,rich);
});
test('notes preserve formatting across save and reject stale version',t=>{
 const dir=setup(t,false),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const rich=formatRange('note',null,0,4,'italic',true);
 const note=store.createNote({title:'note',text:'note',rich});assert.deepEqual(note.rich,rich);
 const next=store.updateNote(note.id,{title:'note',text:'note!',version:1}).note;assert.equal(styleAt(next.rich,1).italic,true);
 assert.equal(store.updateNote(note.id,{title:'note',text:'other',version:1}).conflict,true);
});
test('legacy save preserves unchanged formatting between separated edits and fails closed on excessive rewrite',t=>{
 const dir=setup(t,false),store=openStore(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const text='a middle z',rich=formatRange(text,null,2,8,'bold',true),doc=store.createDocument({title:'legacy',text,rich});
 const next=store.updateDocument(doc.id,{title:doc.title,text:'A middle Z',version:1}).document;
 assert.equal(styleAt(next.rich,2).bold,true);assert.equal(styleAt(next.rich,7).bold,true);
 const long='a'.repeat(3000),large=store.createDocument({title:'large',text:long,rich:formatRange(long,null,1,100,'italic',true)});
 assert.throws(()=>store.updateDocument(large.id,{title:'large',text:'b'.repeat(3000),version:1}));assert.equal(store.getDocument(large.id).text,long);
});
const section=body=>({sectionId:'s',title:'Глава',body,hash:body,hasHeading:true,tabId:'t'});
test('format-only chapter does not write Google; refresh, settlement, adoption and concurrent save keep local formatting',()=>{
 const rich=formatRange('abcdef',null,1,3,'underline',true),item={...loadedFromSection(section('abcdef'),'r'),rich};
 assert.equal(isDirty(item),false);assert.equal(isLocalDirty(item),true);assert.deepEqual(buildWritePayload([item]).edits,[]);
 assert.deepEqual(mergeLoaded(item,loadedFromSection(section('abcdef'),'r2')).rich,rich);
 assert.deepEqual(settleAfterWrite([item],new Map([['s',loadedFromSection(section('abcdef'),'r2')]]),{})[0].rich,rich);
 assert.deepEqual(adoptCreated(loadedFromSection(section('abcdef'),'r2'),item).rich,rich);
 const changed=mergeLoaded(item,loadedFromSection(section('XXabcdef'),'r3'));assert.equal(changed.richRecovery[0].text,'abcdef');assert.equal(styleAt(changed.rich,3).underline,true);
 const local={...item,rich:formatRange(item.body,rich,4,6,'bold',true)};assert.deepEqual(mergeWorkingChapter(local,item,item).rich,local.rich);
});
test('old chapter client cannot erase formatting and invalid bounds never commit',t=>{
 const files=createManuscriptFiles(setup(t));const copy=files.importDocument('b','d',0,{manuscript:{documentId:'d',revisionId:'r',sections:[section('abcdef')]}});
 const item={...copy.chapters[0],rich:formatRange('abcdef',null,1,3,'italic',true)};
 const saved=files.save('b','d',1,[item]);const legacy={...item};delete legacy.rich;
 const next=files.save('b','d',saved.version,[legacy]);assert.deepEqual(next.chapters[0].rich,item.rich);
 assert.throws(()=>files.save('b','d',next.version,[{...item,rich:{v:1,ranges:[{start:0,end:999,style:{bold:true}}]}}]));assert.equal(files.read('b','d').version,next.version);
});
test('server binds exact target, rejects mismatched identity and split unicode; repeated quotes need context',()=>{
 const text='Один. Второй. Один.',source={identity:'document:1',text,title:'T',version:4},request={id:'request-1',identity:source.identity,start:14,end:text.length};
 const context=buildTextReviewContext(request,source);assert.ok(context.includes(text));assert.ok(context.includes('"version":4'));assert.ok(context.includes('talewisp-review'));
 assert.throws(()=>buildTextReviewContext({...request,identity:'document:other'},source));assert.throws(()=>buildTextReviewContext({...request,start:-1},source));
 assert.throws(()=>normalizeRich('😀',{v:1,ranges:[{start:0,end:1,style:{bold:true}}]}));
 const target={...source,start:0,end:text.length};assert.throws(()=>resolveReviewQuote(target,{quote:'Один.'}));assert.deepEqual(resolveReviewQuote(target,{quote:'Один.',prefix:'Второй. '}),{start:14,end:19});
});
