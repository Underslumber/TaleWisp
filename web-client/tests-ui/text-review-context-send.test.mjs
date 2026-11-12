import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
import {buildAgentMessagePayload} from '../public/agent-workflows.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  async function sendMessage('),source.indexOf('  function agentShortcut('));
const rich=source.slice(source.indexOf('  const activeRich='),source.indexOf('\n',source.indexOf('  const activeRich=')));
async function send(kind,record,pending=false){
 const sent=[],notices=[],input={value:'Обычное сообщение'},context={
 state:{googleNativeOpen:false,current:{kind,id:record.id},catalog:{active:{authorId:'a',seriesId:'s',bookId:'b'}},selectedText:'secret selection',sources:new Set()},
 chapters:{active:()=>false},draft:()=>record,localRich:{get:()=>({text:record.text,identity:kind+':'+record.id,selection:{start:0,end:4}})},
 textReview:{hasPending:()=>pending,stage:()=>{throw Error('unexpected review');},sent(){},failed(){}},saveQueue:{flush:async()=>{}},
 $:id=>id==='#chat-input'?input:id==='#review-request'?{checked:false}:{value:''},buildAgentMessagePayload,notify:m=>notices.push(m),api:async(path,{body})=>sent.push(body),loadAgent:async()=>{}
 };
 await runInNewContext(rich+'\n'+handler+'\nsendMessage({preventDefault(){}})',context);return {sent,notices};
}
test('foreign scoped note does not block ordinary chat or leak its selection; explicit review requires workspace switch',async()=>{
 const note={id:'n',text:'private text',version:1,authorId:'other',seriesId:'s',bookId:'b'};
 const ordinary=await send('note',note);assert.equal(ordinary.sent.length,1);assert.equal(ordinary.sent[0].noteId,undefined);assert.equal(ordinary.sent[0].textReview,undefined);assert.equal(ordinary.sent[0].selectedText,undefined);
 const explicit=await send('note',note,true);assert.equal(explicit.sent.length,0);assert.match(explicit.notices[0],/Переключите/);
});
test('readonly knowledge source never produces an unsupported text-review identity',async()=>{
 const result=await send('source',{id:'source',text:'source text',readonly:true});assert.equal(result.sent.length,1);assert.equal(result.sent[0].textReview,undefined);
});
