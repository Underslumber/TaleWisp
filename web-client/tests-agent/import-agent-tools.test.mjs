import test from 'node:test';
import assert from 'node:assert/strict';
import {IMPORT_AGENT_TOOLS,createImportAgentTools,verifyImportReviewReceipt} from '../import-agent-tools.mjs';

test('import tools cannot publish or read another job and reject extra fields',async()=>{
  let reads=0;const call=createImportAgentTools({service:{read:async()=>{reads++;return {complete:true};}},getActiveJobId:()=> 'job-A'});
  await assert.rejects(call('talewisp_import_read',{jobId:'job-B',path:'source.md'}),/active job/);
  await assert.rejects(call('talewisp_import_read',{jobId:'job-A',path:'source.md',confirmed:true}),/schema/);
  await assert.rejects(call('talewisp_import_publish',{jobId:'job-A'}),/not permitted/);assert.equal(reads,0);
  assert.equal(IMPORT_AGENT_TOOLS.some(tool=>tool.name.includes('publish')),false);
  assert.deepEqual(await call('talewisp_import_read',{jobId:'job-A',path:'source.md'}),{complete:true});assert.equal(reads,1);
});
test('independent review requires a completed host receipt bound to this job and exact candidate',()=>{
  const observed={jobId:'job-A',status:'PASS',review_type:'independent',session_id:'native-session',candidate_sha256:'hash',findings:[],coverage:'All source and nine layer candidate inspected.'};
  const binding={jobId:'job-A',sessionId:'native-session',candidateSha256:'hash',requiredManifest:[{path:'corpus/chapter.json',sha256:'source-hash',bytes:10}],excludedManifest:[]};
  const audit={calls:2,attempts:2,chars:10,reads:[{path:'corpus/chapter.json',sha256:'source-hash',startChar:0,endChar:4,totalChars:10,eof:false,charCount:4,complete:false},{path:'corpus/chapter.json',sha256:'source-hash',startChar:4,endChar:10,totalChars:10,eof:true,charCount:6,complete:false}]};
  const history=[{id:'receipt',role:'continuity_reviewer',status:'completed',threadId:'child',result:JSON.stringify(observed),importReviewBinding:binding,importReviewReadAudit:audit}];
  const input={history,jobId:'job-A',sessionId:'native-session',candidateSha256:'hash',review:{...observed,receiptId:'receipt'}};
  assert.equal(verifyImportReviewReceipt(input),true);
  const overlapAudit={calls:3,attempts:3,chars:19,reads:[{path:'corpus/chapter.json',sha256:'source-hash',startChar:0,endChar:7,totalChars:10,eof:false,charCount:7,complete:false},{path:'corpus/chapter.json',sha256:'source-hash',startChar:4,endChar:10,totalChars:10,eof:true,charCount:6,complete:false},{path:'corpus/chapter.json',sha256:'source-hash',startChar:4,endChar:10,totalChars:10,eof:true,charCount:6,complete:false}]};
  assert.equal(verifyImportReviewReceipt({...input,history:[{...history[0],importReviewReadAudit:overlapAudit}]}),true,'overlapping and repeated reads are accepted when their union covers the pinned file');
  const invalidAudits=[
    {...audit,calls:0,attempts:0,reads:[]},
    {...audit,calls:1,attempts:1,reads:[{...audit.reads[0],endChar:5,totalChars:10,eof:false,charCount:5,complete:false}],chars:5},
    {...audit,calls:1,attempts:1,reads:[{...audit.reads[1],startChar:5,endChar:10,charCount:5}]},
    {...audit,calls:2,attempts:2,reads:[{...audit.reads[0],sha256:'wrong-hash'},audit.reads[1]]},
    {...audit,calls:2,attempts:2,reads:[{...audit.reads[0],path:'other-job/source.md'},audit.reads[1]]}
  ];
  const forgedBinding={...binding,jobId:'job-B'};
  for(const delta of [{jobId:'job-B'},{candidateSha256:'changed'},{history:[{...history[0],status:'running'}]},{review:{...input.review,coverage:'Parent-invented coverage'}},{history:[{...history[0],importReviewReadAudit:undefined}]},{history:[{...history[0],importReviewBinding:forgedBinding}]},...invalidAudits.map(importReviewReadAudit=>({history:[{...history[0],importReviewReadAudit}]}))])assert.equal(verifyImportReviewReceipt({...input,...delta}),false);
  assert.equal(verifyImportReviewReceipt({...input,review:{...observed,status:'FAIL',receiptId:'receipt'}}),false,'FAIL is never promoted to PASS');
});
