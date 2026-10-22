import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../agent.mjs';
import { buildManuscriptContext } from '../manuscript-context.mjs';

test('real AgentService forwards a large ordered manuscript context into turn/start without treating it as a selected style excerpt', async t => {
  const root=mkdtempSync(join(tmpdir(),'tw-manuscript-agent-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const settings=new Map(), calls=[];
  const store={getSetting:k=>settings.get(k),setSetting:(k,v)=>settings.set(k,v),listMessages:()=>[],addMessage(){}};
  const agent=new AgentService({dataDir:root,store,vaultPath:null});
  agent.runner={closed:false,async request(method,params){
    calls.push({method,params});
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='model/list')return {data:[{id:'fixture-model'}]};
    if(method==='account/rateLimits/read')return {};
    if(method==='thread/start')return {thread:{id:'fixture-thread'}};
    if(method==='turn/start')return {turn:{id:'fixture-turn'}};
    throw new Error('Unexpected '+method);
  }};
  const chapters=['one','two'].map((sectionId,i)=>({bookId:'b',documentId:'d',documentName:'Книга',sectionId,title:'Глава '+i,revisionId:'r',tabTitle:'t',edited:false,text:sectionId+' '+String(i).repeat(25000)}));
  const context=buildManuscriptContext(chapters);
  await agent.message({text:'Compare both chapters',manuscriptContext:context});
  const prompt=calls.find(x=>x.method==='turn/start').params.input.find(x=>x.type==='text').text;
  assert.ok(prompt.includes(context));assert.ok(prompt.indexOf(chapters[0].text)<prompt.indexOf(chapters[1].text));
  assert.equal(agent.activeRequestContext.selectedText,null);
  assert.match(prompt,/AUTHOR REQUEST:\nCompare both chapters/);
  agent._notification({method:'turn/completed',params:{turn:{id:'fixture-turn',status:'completed'}}});
});
