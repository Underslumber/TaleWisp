import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConsultationArguments} from '../native-consultation-tool.mjs';
test('native consultation tool has no filesystem or provider configuration input',()=>{
  const args={reason:'An explicit bounded review request.',mode:'review',task:'Check a contradiction.',requirements:'Preserve facts.',input:'Synthetic evidence.'};
  assert.equal(nativeConsultationArguments(args).mode,'review');
  for(const extra of [{files:['secret.md']},{apiKey:'not-allowed'},{model:'substitute'},{workspace:'C:/'}])assert.throws(()=>nativeConsultationArguments({...args,...extra}),/bounded packet/);
  assert.throws(()=>nativeConsultationArguments({...args,reason:''}),/explicit request/);
});
