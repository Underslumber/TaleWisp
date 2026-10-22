import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService, JsonlRunner } from '../agent.mjs';
import { NATIVE_CONSULTATION_TOOL } from '../native-consultation-tool.mjs';
import { createRuntimeContract } from '../runtime-contract.mjs';
import { buildWorkflowViewModel, scenarioCanRun } from '../public/agent-workflows.js';

function fixture(t,{installed=true,analyze=async input=>({response:'consulted',receipt:{status:'SUCCESS',input}})}={}) {
  const root=mkdtempSync(join(tmpdir(),'talewisp-native-consult-agent-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const settings=new Map();const store={getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,value),addMessage(){},listMessages(){return[];},setMessageScope(){}};
  const calls=[];
  const service={status:async()=>({adapterInstalled:installed,running:false,cancelRequested:false,cleanupPending:false}),analyze:async args=>{calls.push(args);return analyze(args);},stop:async()=>({cancelRequested:true,cleanupPending:true})};
  const agent=new AgentService({dataDir:join(root,'data'),store,nativeConsultationService:service,runtimeContractFactory:async()=>({version:'native-v1',instructions:'contract',ROOT_WORKFLOW_INSTRUCTIONS:'workflow',resources:[],readResource(){}}),runtimeModelResolver:async()=>({scope:'once',model:'gpt-6-luna',effort:'high'})});
  agent._registerNativeSkills=async()=>{};
  return {agent,service,calls};
}
const args={reason:'The requirements conflict on required output.',mode:'analyze',task:'Identify the conflict.',requirements:'Must preserve both conditions.',input:'Requirement A and requirement B.'};
const call=(threadId='root',turnId='turn-1',callId='call-1')=>({threadId,turnId,callId,tool:NATIVE_CONSULTATION_TOOL.name,arguments:args});
function activate(agent,{threadId='root',turnId='turn-1',revision='r1'}={}) { agent.threadId=threadId;agent.activeTurnId=turnId;agent.workspaceRevision=revision;agent.dynamicToolsVersion='test;native-consult:enabled';agent.activeRequestContext={mode:'ordinary_writing',text:'Need a bounded consultation.'};agent.inTurn=true; }

test('adapter presence gates the dynamic tool but status never claims auth or provider readiness',async t=>{
  const installed=fixture(t,{installed:true});
  const state=await installed.agent.refreshNativeConsultationStatus();assert.equal(state.adapterInstalled,true);assert.equal(state.availability,'unverified');assert.equal(state.authentication,'unverified');
  installed.agent.runner={request:async(_method,params)=>({thread:{id:'root-thread'}})};installed.agent.activeRuntimeProfile='normal';
  await installed.agent._ensureThread(null,'ordinary_writing');
  assert.ok(installed.agent.runner);assert.equal(installed.agent.dynamicToolsVersion.includes('native-consult:enabled'),true);
  const importAgent=fixture(t,{installed:true});await importAgent.agent.refreshNativeConsultationStatus();importAgent.agent.activeThreadProfile='import';importAgent.agent.activeImportJobId='job-1';
  const importCalls=[];importAgent.agent.runner={request:async(method,params)=>{importCalls.push({method,params});return method==='thread/start'?{thread:{id:'import-thread'}}:{data:[],nextCursor:null};}};
  await importAgent.agent._ensureImportThread(null,{jobId:'job-1',authorPseudonym:'Author',seriesName:'Series',status:'awaiting_sources',jobVersion:'version-1'});
  assert.ok(importCalls.find(call=>call.method==='thread/start').params.dynamicTools.some(tool=>tool.name===NATIVE_CONSULTATION_TOOL.name));
  const missing=fixture(t,{installed:false});await missing.agent.refreshNativeConsultationStatus();missing.agent.runner={request:async()=>({thread:{id:'root-thread'}})};missing.agent.activeRuntimeProfile='normal';
  await missing.agent._ensureThread(null,'ordinary_writing');assert.equal(missing.agent.dynamicToolsVersion.includes('native-consult:'),false);
});

test('the production runtime contract and workflow view model expose truthful scenario availability',async t=>{
  const f=fixture(t,{installed:true});f.agent.runtimeContractFactory=createRuntimeContract;f.agent.account={type:'chatgpt'};f.agent.models=[{id:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
  f.agent.runner={closed:false,request:async(method)=>method==='thread/start'?{thread:{id:'contract-thread'}}:{}};f.agent.activeRuntimeProfile='normal';
  await f.agent._ensureThread(null,'ordinary_writing');
  assert.equal(f.agent.hostCapabilities.nativeConsultation,'not_checked');
  const status=f.agent.status();const view=buildWorkflowViewModel(status);const scenarios=new Map(view.scenarios.map(item=>[item.id,item]));
  assert.equal(scenarios.get('ordinary_writing')?.availability,'available');
  assert.equal(scenarios.get('continuation')?.availability,'available');
  assert.equal(scenarios.get('revision')?.availability,'available');
  assert.equal(scenarios.get('google_workspace')?.availability,'unavailable');
  assert.equal(scenarios.get('storyart')?.availability,'unavailable');
  assert.equal(scenarios.get('code_review')?.availability,'unavailable');
  assert.equal(scenarioCanRun(scenarios.get('ordinary_writing')),true);
  assert.equal(scenarioCanRun(scenarios.get('storyart')),false);
});

test('Google workspace prose uses one writer and only an explicitly requested or risk-based reviewer',async t=>{
  const {agent}=fixture(t);agent.activeRequestContext={mode:'google_workspace',text:'Write and review this Docs passage.'};
  assert.deepEqual(agent._authorizeDelegationRole('style_editor'),{maxCalls:1,scenario:'google_workspace'});
  assert.deepEqual(agent._authorizeDelegationRole('continuity_reviewer'),{maxCalls:1,scenario:'google_workspace'});
  agent.activeRequestContext={mode:'google_workspace',text:'Write this Docs passage.'};
  assert.equal(agent._authorizeDelegationRole('continuity_reviewer'),false);
  assert.deepEqual(agent._authorizeDelegationRole('continuity_reviewer',{hasWriter:true,task:'Check canon and knowledge',input:'Writer input'}),{maxCalls:1,scenario:'google_workspace'});
  agent.activeRequestContext={mode:'google_workspace',text:'Write this Docs passage. Do not review.'};
  assert.equal(agent._authorizeDelegationRole('continuity_reviewer',{hasWriter:true,task:'Check canon',input:'Writer input'}),false);
});

test('explicit calibration mode authorizes its comparison without keywords and words cannot unlock it elsewhere',async t=>{
  const {agent}=fixture(t);agent.activeRequestContext={mode:'calibration',text:'Сравни два варианта'};
  assert.deepEqual(agent._authorizeDelegationRole('style_editor'),{maxCalls:3,scenario:'calibration'});
  assert.deepEqual(agent._authorizeDelegationRole('calibration_evaluator'),{maxCalls:1,scenario:'calibration'});
  agent.activeRequestContext={mode:'ordinary_writing',text:'Проведи тренировку на сцене'};
  assert.equal(agent._authorizeDelegationRole('calibration_evaluator'),false);
});

test('consultation requires the exact active root turn and permits one attempt including failure',async t=>{
  const f=fixture(t,{analyze:async()=>{throw new Error('provider failure');}});activate(f.agent);await f.agent.refreshNativeConsultationStatus();
  await assert.rejects(f.agent._handleDynamicToolCall(call('child')),/Child dynamic tool request is outside the active root/);
  await assert.rejects(f.agent._handleDynamicToolCall(call('root','other')),/outside the active TaleWisp turn/);
  await assert.rejects(f.agent._handleDynamicToolCall(call()),/provider failure/);
  await assert.rejects(f.agent._handleDynamicToolCall(call('root','turn-1','call-2')),/Only one native consultation attempt/);
  assert.equal(f.calls.length,1);
});

test('stop invalidates an in-flight result and passes through the service cleanup state',async t=>{
  let resolveAnalysis;const f=fixture(t,{analyze:()=>new Promise(resolve=>{resolveAnalysis=resolve;})});activate(f.agent);await f.agent.refreshNativeConsultationStatus();
  const pending=f.agent._handleDynamicToolCall(call());await new Promise(resolve=>setImmediate(resolve));
  const stopped=await f.agent._cancelNativeConsultation('stop');assert.deepEqual(stopped,{cancelRequested:true,cleanupPending:true});
  f.agent.inTurn=false;f.agent.activeTurnId=null;resolveAnalysis({response:'late',receipt:{status:'SUCCESS'}});
  assert.equal(await pending,undefined);assert.equal(f.agent.nativeConsultationOperation,null);
});

test('stop omits an absent native consultation result instead of serializing undefined',async t=>{
  const f=fixture(t,{installed:false});f.agent.inTurn=true;f.agent.activeTurnId='turn-1';f.agent.runner={closed:false,request:async()=>{f.agent.inTurn=false;return {};}};
  assert.deepEqual(await f.agent.stop(),{stopped:true,running:false});
});

test('a parent workspace change suppresses a completed consultation result',async t=>{
  let resolveAnalysis;const f=fixture(t,{analyze:()=>new Promise(resolve=>{resolveAnalysis=resolve;})});activate(f.agent);await f.agent.refreshNativeConsultationStatus();
  const pending=f.agent._handleDynamicToolCall(call());await new Promise(resolve=>setImmediate(resolve));f.agent.workspaceRevision='r2';resolveAnalysis({response:'stale',receipt:{status:'SUCCESS'}});
  assert.equal(await pending,undefined);
});

test('closed JsonlRunner drops a late dynamic tool response after the handler resolves',async()=>{
  const writes=[];const runner=Object.create(JsonlRunner.prototype);runner.closed=true;runner.stopping=false;runner.proc={stdin:{writable:true,write:value=>writes.push(value)}};runner.dynamicToolHandler=async()=>({response:'late'});runner.emit=()=>{};
  await runner._handleDynamicToolRequest({id:8,method:'item/tool/call',params:{}});assert.deepEqual(writes,[]);
});


test('successful native consultation is actually delivered through JsonlRunner after operation cleanup', async t => {
  const f=fixture(t);activate(f.agent);await f.agent.refreshNativeConsultationStatus();
  const writes=[];const runner=Object.create(JsonlRunner.prototype);
  runner.closed=false;runner.stopping=false;runner.proc={stdin:{writable:true,write:value=>writes.push(JSON.parse(value))}};
  runner.emit=()=>{};runner.dynamicToolHandler=params=>f.agent._handleDynamicToolCall(params);
  await runner._handleDynamicToolRequest({id:91,method:'item/tool/call',params:call()});
  assert.equal(f.agent.nativeConsultationOperation,null);
  assert.equal(writes.length,1,'successful operation must answer the pending server tool call');
  assert.equal(writes[0].id,91);assert.equal(writes[0].result.success,true);
  assert.equal(JSON.parse(writes[0].result.contentItems[0].text).response,'consulted');
});


test('roleplay readiness uses the actual structured MCP response rather than its envelope', async t => {
  const f=fixture(t);activate(f.agent);f.agent.activeRequestContext.mode='roleplay';
  f.agent.toolInventory=[{name:'talewisp_roleplay_readiness'}];
  const ready={offerable:true,declaration_complete:true,source_fragments_match_current_hashes:true,semantic_review:{status:'source_reviewed'}};
  f.agent.pluginService={call:async()=>({structuredContent:ready,content:[{type:'text',text:JSON.stringify(ready)}]})};
  const result=await f.agent._handleDynamicToolCall({...call(),tool:'talewisp_roleplay_readiness',arguments:{spec:{}}});
  assert.equal(result.receipt.offerable,true);assert.equal(result.receipt.sourceHashesMatch,true);
  assert.equal(f.agent.activeRequestContext.roleplayReadinessReceipt,result.receipt);
  f.agent.pluginService.call=async()=>({isError:true,structuredContent:ready});
  await assert.rejects(f.agent._handleDynamicToolCall({...call('root','turn-1','bad-readiness'),tool:'talewisp_roleplay_readiness',arguments:{spec:{}}}),/readiness failed/);
});
