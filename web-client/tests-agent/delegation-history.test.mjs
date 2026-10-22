import test from 'node:test';
import assert from 'node:assert/strict';
import { readDelegationHistory,recordDelegationEvent,recoverDelegationHistory,mergeDelegationHistory } from '../delegation-history.mjs';
const fixture=()=>{const data=new Map();return {messageScopeKey:'book-A',getSetting:k=>data.get(k),setSetting:(k,v)=>data.set(k,v)};};
test('actual delegation receipts persist without exposing another book',()=>{
  const store=fixture();recordDelegationEvent(store,{type:'delegation',id:'one',role:'style_editor',phase:'starting',model:'gpt-6-luna'});
  recordDelegationEvent(store,{type:'delegation',id:'one',role:'style_editor',phase:'started',threadId:'child',startedAt:'2026-10-15'});
  const importReviewBinding={jobId:'job-A',sessionId:'session',candidateSha256:'candidate',requiredManifest:[{path:'corpus.json',sha256:'source',bytes:4}],excludedManifest:[{path:'cover.png',sha256:'image',bytes:8,reason:'binary-image-not-readable-as-text'}]};
  const importReviewReadAudit={calls:1,attempts:1,chars:4,reads:[{path:'corpus.json',sha256:'source',startChar:0,endChar:4,totalChars:4,eof:true,charCount:4,complete:true}]};
  recordDelegationEvent(store,{type:'delegation',id:'one',role:'continuity_reviewer',phase:'completed',result:'Finished review',completedAt:'2026-10-16',importReviewBinding,importReviewReadAudit});
  const [row]=readDelegationHistory(store);assert.equal(row.threadId,'child');assert.equal(row.result,'Finished review');assert.equal(row.startedAt,'2026-10-15');assert.equal(row.model,'gpt-6-luna');assert.deepEqual(row.importReviewBinding,importReviewBinding);assert.deepEqual(row.importReviewReadAudit,importReviewReadAudit);
  store.messageScopeKey='book-B';assert.deepEqual(readDelegationHistory(store),[]);
});
test('restart never promotes an unconfirmed run to success',()=>{
  const store=fixture();recordDelegationEvent(store,{type:'delegation',id:'one',phase:'started'});
  recordDelegationEvent(store,{type:'delegation',id:'two',phase:'completed',result:'Actual completed output'});
  const rows=recoverDelegationHistory(store);assert.equal(rows[0].status,'interrupted');assert.equal(rows[1].status,'completed');
  assert.equal(mergeDelegationHistory(rows,{active:[{id:'three',status:'running'}],recent:[]}).length,3);
});
test('invalid persisted history fails closed and is not replaced by an empty list',()=>{
  const store=fixture();store.getSetting=()=>'{broken';assert.throws(()=>recordDelegationEvent(store,{type:'delegation',id:'one',phase:'started'}),/not overwritten/);
});
