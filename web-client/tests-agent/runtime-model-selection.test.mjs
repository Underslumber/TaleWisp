import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeModel } from '../runtime-model-selection.mjs';

test('runtime delegates resolve the authorized once scope without shell or project preference writes', async () => {
  let observed;
  const result=await resolveRuntimeModel({projectRoot:'D:/fixture',executeImpl:async (...args)=>{observed=args;return {stdout:JSON.stringify({ready:true,scope:'once',source:'builtin',selection:{model:'gpt-6-luna',effort:'high'}})};}});
  assert.equal(result.model,'gpt-6-luna');assert.equal(result.scope,'once');
  assert.deepEqual(observed[1].slice(-2),['--choice','once']);
  assert.equal(observed[2].shell,false);assert.equal(observed[2].windowsHide,true);
});
test('runtime model resolution fails closed on pending or substituted selection', async () => {
  for(const payload of [{ready:false},{ready:true,scope:'project',selection:{model:'gpt-6-luna',effort:'high'}},{ready:true,scope:'once',selection:{model:'gpt-6.1-sol',effort:'medium'}}]){
    await assert.rejects(resolveRuntimeModel({projectRoot:'D:/fixture',executeImpl:async()=>({stdout:JSON.stringify(payload)})}),/unresolved|differs/);
  }
});
test('runtime model resolution never consumes malformed output or retries an execution failure', async () => {
  await assert.rejects(resolveRuntimeModel({projectRoot:'D:/fixture',executeImpl:async()=>({stdout:'not json'})}),/invalid JSON/);
  let calls=0;await assert.rejects(resolveRuntimeModel({projectRoot:'D:/fixture',executeImpl:async()=>{calls++;throw Error('resolver unavailable');}}),/unavailable/);assert.equal(calls,1);
});


test('independent code review resolves Sol medium once without changing ordinary routing',async()=>{
  let args;const result=await resolveRuntimeModel({projectRoot:'D:/fixture',route:'sol_review',executeImpl:async(...value)=>{args=value;return {stdout:JSON.stringify({ready:true,scope:'once',selection:{model:'gpt-6.1-sol',effort:'medium'}})};}});
  assert.equal(result.model,'gpt-6.1-sol');assert.equal(result.effort,'medium');assert.equal(args[1][args[1].indexOf('--model')+1],'gpt-6.1-sol');assert.equal(args[1][args[1].indexOf('--effort')+1],'medium');
  await assert.rejects(resolveRuntimeModel({projectRoot:'D:/fixture',route:'sol_review',executeImpl:async()=>({stdout:JSON.stringify({ready:true,scope:'once',selection:{model:'gpt-6-luna',effort:'high'}})})}),/differs/);
  await assert.rejects(resolveRuntimeModel({projectRoot:'D:/fixture',route:'unknown'}),/Unsupported/);
});
