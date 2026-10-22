import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentService } from '../agent.mjs';
import { createDelegationManager, DELEGATE_MODEL, DELEGATE_EFFORT } from '../delegation.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function assertInterruptParams(params, threadId, turnId) {
  if (!params?.turnId) throw new Error('Invalid request: missing field `turnId`');
  assert.deepEqual(params,{threadId,turnId});
}
function fixture(overrides={}) {
  let thread=0;
  const calls=[];let runner;
  runner={async request(method,params){calls.push({method,params});if(method==='thread/start')return{thread:{id:`child-${++thread}`},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};if(method==='turn/start')return{turn:{id:`turn-${params.threadId}`}};if(method==='turn/interrupt'){assertInterruptParams(params,params.threadId,params.turnId);return{};}return{};}};
  const manager=createDelegationManager({runner,contractProvider:async()=>({version:'contract-v1',instructions:'',ROOT_WORKFLOW_INSTRUCTIONS:'',roles:{},resources:[],readResource:()=>''}),resolveModel:async()=>({scope:'once',model:DELEGATE_MODEL,effort:DELEGATE_EFFORT}),getModelCatalog:()=>[{id:DELEGATE_MODEL,supportedReasoningEfforts:[{reasoningEffort:DELEGATE_EFFORT}]}],getWorkspaceRevision:()=> 'revision-1',getParentBinding:()=>({threadId:'parent',turnId:'parent-turn',cwd:'D:/project'}),authorizeRole:()=>true,...overrides});
  return{runner,manager,calls};
}
const request=(parentCallId='call-1')=>({role:'style_editor',task:'Write this.',input:'Bounded input.',maxOutputChars:1000,parentThreadId:'parent',parentTurnId:'parent-turn',parentCallId,contractVersion:'contract-v1',workspaceRevision:'revision-1'});

test('an empty or rejected interrupt response retains the slot until matching completion',async()=>{
  for(const reject of [false,true]) {
    const f=fixture();
    // Keep the exact runner identity used by the manager while controlling its interrupt result.
    f.runner.request=async(method,params)=>{f.calls.push({method,params});if(method==='turn/interrupt'){assertInterruptParams(params,'child-1','turn-child-1');if(reject)throw new Error('interrupt unavailable');return{};}if(method==='thread/start')return{thread:{id:'child-1'},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};if(method==='turn/start')return{turn:{id:'turn-child-1'}};return{};};
    const pending=f.manager.delegate(request());await tick();await tick();
    await f.manager.cancelAll('user stop');
    const active=f.manager.status().active;assert.equal(active.length,1);assert.equal(active[0].status,'cancel_requested');assert.equal(active[0].cancelRequested,true);
    if(reject)assert.match(active[0].interruptError,/interrupt unavailable/);
    const receiptBefore=f.manager.status().recent.length;assert.equal(receiptBefore,0);
    f.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{status:'completed'}}});
    assert.equal(f.manager.status().active.length,1,'a completion without a matching turn ID cannot release capacity');
    f.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{id:'foreign-turn',status:'completed'}}});
    assert.equal(f.manager.status().active.length,1,'foreign completion IDs must not release capacity');
    f.manager.routeNotification({method:'item/agentMessage/delta',params:{threadId:'child-1',delta:'late prose'}});
    f.manager.routeNotification({method:'turn/completed',params:{threadId:'child-1',turn:{id:'turn-child-1',status:'completed'}}});
    const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(result.receipt.result,'');assert.equal(f.manager.status().active.length,0);
  }
});

test('cancellation during thread startup never sends a child turn',async()=>{
  const gate=deferred(),started=deferred();const f=fixture();
  f.runner.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start'){started.resolve();return gate.promise;}return{};};
  const pending=f.manager.delegate(request());await started.promise;await f.manager.cancelAll('cancel before child thread exists');
  gate.resolve({thread:{id:'child-prestart'},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}});
  const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(f.calls.some(call=>call.method==='turn/start'),false);assert.equal(f.manager.status().active.length,0);
});

test('cancellation during MCP verification never sends a child turn',async()=>{
  const gate=deferred(),checking=deferred();const f=fixture();
  f.runner.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start')return{thread:{id:'child-mcp'},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}};if(method==='mcpServerStatus/list'){checking.resolve();return gate.promise;}return{};};
  const pending=f.manager.delegate(request());await checking.promise;await f.manager.cancelAll('cancel during MCP inventory');gate.resolve({data:[],nextCursor:null});
  const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(f.calls.some(call=>call.method==='turn/start'),false);assert.equal(f.manager.status().active.length,0);
});

test('cancellation during turn/start waits for the returned matching completion and discards prose',async()=>{
  const gate=deferred(),starting=deferred();const f=fixture();
  f.runner.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start')return{thread:{id:'child-turnstart'},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};if(method==='turn/start'){starting.resolve();return gate.promise;}if(method==='turn/interrupt'){assertInterruptParams(params,'child-turnstart','turn-child-turnstart');return{};}return{};};
  const pending=f.manager.delegate(request());await starting.promise;await f.manager.cancelAll('cancel while turn/start is pending');
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false,'do not interrupt before turn/start resolves');
  gate.resolve({turn:{id:'turn-child-turnstart'}});await tick();
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),true);
  assert.equal(f.manager.status().active.length,1);
  f.manager.routeNotification({method:'item/agentMessage/delta',params:{threadId:'child-turnstart',delta:'must be discarded'}});
  f.manager.routeNotification({method:'turn/completed',params:{threadId:'child-turnstart',turn:{id:'turn-child-turnstart',status:'completed'}}});
  const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(result.receipt.result,'');
});

test('unknown turn ID skips interrupt and retains capacity until runner exit fallback',async()=>{
  let manager;let stopCalls=0;const f=fixture({childDeadlineMs:100,cancelGraceMs:15,stopRunner:async()=>{stopCalls++;manager.runnerExited(new Error('confirmed exit'));return true;}});manager=f.manager;
  f.runner.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start')return{thread:{id:'child-unknown-turn'},model:DELEGATE_MODEL,reasoningEffort:DELEGATE_EFFORT,approvalPolicy:'never',sandbox:{type:'readOnly'}};if(method==='mcpServerStatus/list')return{data:[],nextCursor:null};if(method==='turn/start')return{turn:{}};if(method==='turn/interrupt')throw new Error('Invalid request: missing field `turnId`');return{};};
  const pending=manager.delegate(request());
  const result=await pending;
  assert.equal(result.receipt.status,'cancelled');assert.equal(stopCalls,1);assert.equal(manager.status().active.length,0);
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false,'an unknown turn ID must not interrupt');
});

test('deadline interrupts, waits a bounded grace, and stops the exact runner before release',async()=>{
  let manager;let stopCalls=0;const f=fixture({childDeadlineMs:100,cancelGraceMs:15,stopRunner:async()=>{stopCalls++;manager.runnerExited(new Error('confirmed exit'));return true;}});manager=f.manager;
  const pending=manager.delegate(request());await new Promise(resolve=>setTimeout(resolve,150));
  const result=await pending;assert.equal(result.receipt.status,'cancelled');assert.equal(stopCalls,1);assert.equal(manager.status().active.length,0);
  assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),true);
});

test('a completed parent turn can still stop its surviving child runner',async t=>{
  const root=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const dir=await root.mkdtemp(path.join(os.tmpdir(),'talewisp-child-stop-'));t.after(()=>root.rm(dir,{recursive:true,force:true}));
  const settings=new Map();const store={getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,value),addMessage(){},listMessages(){return[];},setMessageScope(){}};
  let remaining=1;const runner=new EventEmitter();runner.closed=false;runner.stop=async()=>{runner.exited=true;remaining=0;return true;};
  const agent=new AgentService({dataDir:path.join(dir,'data'),store});agent.runner=runner;agent.inTurn=false;agent.delegationManager={status:()=>({active:remaining?[{status:'cancel_requested'}]:[],recent:[]}),cancelAll:async()=>{},shutdown:async()=>{}};
  const result=await agent.stop();assert.equal(result.stopped,true);assert.equal(result.running,false);assert.equal(result.childDelegationsRemaining,0);
});

test('an old runner exit terminalizes only the manager bound to that runner',async t=>{
  const root=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const dir=await root.mkdtemp(path.join(os.tmpdir(),'talewisp-old-runner-'));t.after(()=>root.rm(dir,{recursive:true,force:true}));
  const settings=new Map();const store={getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,value),addMessage(){},listMessages(){return[];},setMessageScope(){}};
  const agent=new AgentService({dataDir:path.join(dir,'data'),store});let oldExit=0,newExit=0;
  const oldRunner=new EventEmitter();oldRunner.closed=false;const newRunner=new EventEmitter();newRunner.closed=false;
  const oldManager={runnerExited(){oldExit++;}};const newManager={runnerExited(){newExit++;}};
  agent.runner=oldRunner;agent.delegationManagersByRunner.set(oldRunner,oldManager);agent._attach(oldRunner);
  agent.runner=newRunner;agent.delegationManagersByRunner.set(newRunner,newManager);agent.delegationManager=newManager;agent.inTurn=true;agent._attach(newRunner);
  oldRunner.emit('exit',new Error('old process exit'));
  assert.equal(oldExit,1);assert.equal(newExit,0);assert.equal(agent.inTurn,true);assert.equal(agent.runner,newRunner);
});
