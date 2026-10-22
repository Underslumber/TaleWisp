import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentService } from '../agent.mjs';
import { createImportService } from '../import-service.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'talewisp-agent-import-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const settings=new Map([['agent.threadId','normal-thread'],['agent.dynamicToolsVersion','normal-version']]);
  const scopes=[];
  const store={getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,value),setMessageScope:value=>scopes.push(value),addMessage(){},listMessages(){return[];}};
  const jobId='12345678-1234-1234-1234-123456789abc';
  const status={jobId,authorPseudonym:'Author',seriesName:'Series',status:'awaiting_sources'};
  const importService={status:async()=>status,inventory:async()=>({jobId,files:[{path:'Sources/book.fb2',sha256:'abc',bytes:12}]})};
  const agent=new AgentService({dataDir:join(root,'data'),store,vaultPath:join(root,'vault'),importService});
  return {agent,settings,scopes,jobId,status};
}

test('import bootstrap writes a shell, app, multiprocess and MCP disabled profile',async t=>{
  const {agent}=fixture(t);agent.activeImportJobId='12345678-1234-1234-1234-123456789abc';
  const tools=await agent._writeRuntimeConfig('import-bootstrap');
  const config=readFileSync(join(agent.dataDir,'codex-home','config.toml'),'utf8');
  assert.deepEqual(tools,[]);assert.doesNotMatch(config,/\[mcp_servers\./);assert.match(config,/sandbox_mode = "read-only"/);assert.match(config,/shell_tool = false/);assert.match(config,/apps = false/);assert.match(config,/multi_agent = false/);
});

test('import requests use a job-keyed fresh thread, import-only tools and no MCP inventory',async t=>{
  const {agent,settings,jobId,status}=fixture(t);agent.activeImportJobId=jobId;agent.activeThreadProfile='import';
  agent.runtimeContractFactory=async()=>({version:'contract',instructions:'contract',ROOT_WORKFLOW_INSTRUCTIONS:'workflow',resources:[],readResource(){}});
  agent._registerNativeSkills=async()=>{};agent.nativeSkillStatus={skills:[]};
  const calls=[];agent.runner={request:async(method,params)=>{calls.push({method,params});if(method==='thread/start')return{thread:{id:'import-thread'}};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};return{};}};
  const job=await agent._verifyImportJob(jobId,{jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status});
  const thread=await agent._ensureImportThread(null,job);
  assert.equal(thread,'import-thread');assert.equal(settings.get('agent.threadId'),'normal-thread');assert.ok(settings.has(`agent.importThreadBinding.${jobId}`));
  const start=calls.find(c=>c.method==='thread/start');assert.equal(start.params.config,undefined,'isolated runtime has no MCP servers; never recreate a transport-less disabled entry');assert.deepEqual(start.params.dynamicTools.map(tool=>tool.name),['talewisp_import_status','talewisp_import_run','talewisp_import_read','talewisp_import_analysis','talewisp_import_review','talewisp_runtime_resource','talewisp_delegate']);
  assert.equal(calls.find(c=>c.method==='mcpServerStatus/list').params.threadId,'import-thread');
});

test('import rejects caller-supplied context and document or selected-source leakage',async t=>{
  const {agent,jobId,status}=fixture(t);
  await assert.rejects(agent.message({text:'import',mode:'series_base',importJobId:jobId,importJobContext:{jobId,...status},documentId:'doc'}),/rejects draft/);
  await assert.rejects(agent.message({text:'normal',mode:'ordinary_writing',importJobContext:{jobId}}),/server-owned/);
  await assert.rejects(agent._verifyImportJob(jobId,{jobId,authorPseudonym:'attacker',seriesName:status.seriesName,status:status.status}),/stale or inconsistent/);
});

test('import reviewer is gated by a fresh candidate and matching native PASS receipt',async t=>{
  const {agent,jobId,status}=fixture(t);status.status='candidate_ready_for_review';status.session_id='session-1';status.candidate_sha256='candidate-1';status.machine_checks_path='.talewisp/imports/session-1/machine-checks.json';
  agent.importService.read=async(_job,path)=>({path,text:JSON.stringify({status:'PASS',session_id:'session-1',candidate_sha256:'candidate-1'})});
  const context={jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status};
  const job=await agent._verifyImportJob(jobId,context);
  await agent._authorizeImportReviewer(job);
  agent.importService.read=async()=>({text:JSON.stringify({status:'FAIL',session_id:'session-1',candidate_sha256:'candidate-1'})});
  await assert.rejects(agent._authorizeImportReviewer(job),/matching PASS machine-check receipt/);
});

test('the authorizer accepts the real PASS receipt produced by prepare, finalize, and check',async t=>{
  const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const root=mkdtempSync(join(projectRoot,'.agent','agent-import-native-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const service=createImportService({dataDir:join(root,'import-data'),projectRoot,pythonExecutable:process.env.PYTHON||'python'});
  const {jobId}=await service.create({authorPseudonym:'Author',seriesName:'Series'});
  await service.upload({jobId,name:'source.md',contentBase64:Buffer.from('A literal source fact.').toString('base64'),sourceKind:'notes'});
  const prepared=await service.run({jobId,action:'prepare'});
  const corpus=JSON.parse((await service.read(jobId,prepared.books[0].corpus_path)).text),block=corpus.chapters[0].blocks[0];
  const shared_layers=Object.fromEntries(['series_passport','world','rules','entities','glossary','style','chronology','knowledge','uncertainties'].map(key=>[key,{status:'unknown',summary:'Не установлено источником.',evidence:[]} ]));
  await service.saveAnalysis(jobId,{read_chapters:[{book_id:prepared.books[0].book_id,chapter_id:corpus.chapters[0].id,block_ids:[block.id],images_read:[],images_uncertain:[]}],image_transcripts:[],scenes:[],events:[],entities:[],rules:[],threads:[],knowledge:[],style:[],shared_layers});
  const finalized=await service.run({jobId,action:'finalize'}),checked=await service.run({jobId,action:'check'});
  assert.equal(finalized.status,'candidate_ready_for_review');assert.equal(checked.status,'PASS');
  const settings=new Map();const store={getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,value),addMessage(){},listMessages(){return[];}};
  const agent=new AgentService({dataDir:join(root,'agent-data'),store,vaultPath:join(root,'unused-vault'),importService:service});
  const status=await service.status(jobId);const job=await agent._verifyImportJob(jobId,{jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status});
  const binding=await agent._authorizeImportReviewer(job);assert.equal(binding.status,'candidate_ready_for_review');
  agent.activeThreadProfile='import';agent.activeImportJobId=jobId;agent.activeRequestContext={mode:'series_base_import',importJob:job};
  const {reader}=agent._createImportReviewReader(binding);const pinned=binding.inventory.files.find(file=>file.path==='Sources/source.md')??binding.inventory.files[0];
  const read=await reader({path:pinned.path,startChar:0,maxChars:Math.max(1,Math.min(64_000,pinned.bytes))});assert.equal(read.sha256,pinned.sha256);assert.equal(typeof read.text,'string');
});

test('review accepts a legitimate prepare-to-check status transition but rejects a candidate that changes during checks',async t=>{
  const {agent,jobId,status}=fixture(t);const context={jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status};
  const original=await agent._verifyImportJob(jobId,context);
  status.status='candidate_ready_for_review';status.session_id='session-current';status.candidate_sha256='candidate-current';status.machine_checks_path='.talewisp/imports/session-current/machine-checks.json';
  agent.importService.read=async()=>({text:JSON.stringify({status:'PASS',session_id:'session-current',candidate_sha256:'candidate-current'})});
  const fresh=await agent._authorizeImportReviewer(original);assert.equal(fresh.status,'candidate_ready_for_review');assert.notEqual(fresh.jobVersion,original.jobVersion);
  agent.importService.read=async()=>{const candidate=status.candidate_sha256;status.candidate_sha256='candidate-replaced';return{text:JSON.stringify({status:'PASS',session_id:'session-current',candidate_sha256:candidate})};};
  await assert.rejects(agent._authorizeImportReviewer(original),/changed while its machine checks/);
});

test('import reviewer reader is job-bound, hash-pinned, range-only, and rechecks job version around each read',async t=>{
  const {agent,jobId,status}=fixture(t);status.status='candidate_ready_for_review';status.session_id='session-1';status.candidate_sha256='candidate-1';status.machine_checks_path='.talewisp/imports/session-1/machine-checks.json';
  agent.importService.read=async(_job,path,range)=>path===status.machine_checks_path?{text:JSON.stringify({status:'PASS',session_id:'session-1',candidate_sha256:'candidate-1'})}:{path,originalSha256:'abc',sha256:'abc',text:'source',range:{start:range.startChar,end:range.startChar+6},eof:true,totalChars:6,complete:range.startChar===0,truncated:false};
  const job=await agent._verifyImportJob(jobId,{jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status});
  const binding=await agent._authorizeImportReviewer(job);agent.activeThreadProfile='import';agent.activeImportJobId=jobId;agent.activeRequestContext={mode:'series_base_import',importJob:job};
  const {reader,manifest}=agent._createImportReviewReader(binding);assert.equal(manifest.jobId,jobId);assert.equal(manifest.files[0].sha256,'abc');assert.equal(Object.hasOwn(manifest.files[0],'text'),false);assert.deepEqual(manifest.requiredFiles,manifest.files);
  const result=await reader({path:'Sources/book.fb2',startChar:0,maxChars:12});assert.equal(result.text,'source');assert.equal(result.sha256,'abc');
  await assert.rejects(reader({path:'C:/outside.md',startChar:0,maxChars:12}),/not in the trusted pinned inventory/);
  agent.importService.read=async(_job,path,range)=>({path,originalSha256:'substituted',text:'source',range:{start:range.startChar,end:range.startChar+6},eof:true,totalChars:6,complete:true,truncated:false});
  await assert.rejects(reader({path:'Sources/book.fb2',startChar:0,maxChars:12}),/differs from its authorization-time pinned inventory/);
  agent.importService.read=async(_job,path,range)=>{status.candidate_sha256='replacement';return{path,originalSha256:'abc',text:'source',range:{start:range.startChar,end:range.startChar+6},eof:true,totalChars:6,complete:true,truncated:false};};
  await assert.rejects(reader({path:'Sources/book.fb2',startChar:0,maxChars:12}),/changed during independent review/);
});

test('completed review result is withheld if the import candidate changes before the second fingerprint check',async t=>{
  const {agent,jobId,status}=fixture(t);status.status='candidate_ready_for_review';status.session_id='session-1';status.candidate_sha256='candidate-1';status.machine_checks_path='.talewisp/imports/session-1/machine-checks.json';
  agent.importService.read=async()=>({text:JSON.stringify({status:'PASS',session_id:'session-1',candidate_sha256:'candidate-1'})});
  const job=await agent._verifyImportJob(jobId,{jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status});
  agent.activeThreadProfile='import';agent.threadId='import-thread';agent.activeTurnId='turn-1';agent.inTurn=true;agent.runtimeContractVersion='contract-v1';agent._activeThreadContractVersion='contract-v1';agent.activeRequestContext={mode:'series_base_import',text:'Review candidate',importJob:job};
  agent._getRuntimeContract=async()=>({version:'contract-v1'});
  agent._ensureDelegationManager=()=>({delegate:async()=>{status.candidate_sha256='replacement';return{receipt:{status:'completed',result:'PASS'}};}});
  const call={threadId:'import-thread',turnId:'turn-1',callId:'review-call',tool:'talewisp_delegate',arguments:{role:'continuity_reviewer',task:'Review current candidate',input:'Bounded source packet',maxOutputChars:1000}};
  await assert.rejects(agent._handleDynamicToolCall(call),/changed during independent review/);
});

test('returning from an import request restores the normal thread and message scope',async t=>{
  const {agent,settings,scopes}=fixture(t);const profiles=[];agent.activeThreadProfile='import';agent.activeImportJobId='12345678-1234-1234-1234-123456789abc';agent.threadId='import-thread';agent.normalMessageScopeKey='author:a1:series:s1';
  agent.connect=async({profile})=>{profiles.push(profile);agent.account={type:'chatgpt'};agent.models=[];return{authenticated:true};};
  agent._ensureThread=async()=>{agent.threadId='normal-thread';return agent.threadId;};
  agent._workspacePromptContext=async()=>'';agent._getRuntimeContract=async()=>({version:'contract-v1',resources:[]});agent._nativeSkillInputs=()=>[];
  agent.runner={request:async()=>({turn:{id:'normal-turn'}})};
  await agent.message({text:'Continue the scene.',mode:'continuation'});
  assert.deepEqual(profiles,['normal']);assert.equal(agent.activeThreadProfile,'normal');assert.equal(agent.activeImportJobId,null);assert.equal(agent.threadId,'normal-thread');assert.equal(settings.get('agent.threadId'),'normal-thread');assert.equal(scopes.at(-1),'author:a1:series:s1');
  agent._completeTurn();
});
