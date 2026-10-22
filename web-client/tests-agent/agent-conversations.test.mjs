import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../agent.mjs';
import { openStore } from '../store.mjs';

function fixture(scope='workspace:A') {
  const settings=new Map(), messages=new Map();
  const store={messageScopeKey:scope,getSetting:key=>settings.get(key)??null,setSetting:(key,value)=>settings.set(key,String(value)),setMessageScope(key){this.messageScopeKey=key;},addMessage(role,text,scopeKey=this.messageScopeKey){const rows=messages.get(scopeKey)||[];const message={id:`${rows.length+1}`,role,text,createdAt:new Date().toISOString()};rows.push(message);messages.set(scopeKey,rows);return message;},moveMessageScope(from,to){const rows=messages.get(from)||[];messages.set(to,[...(messages.get(to)||[]),...rows]);messages.delete(from);return rows.length;},listMessages(limit=100,scopeKey=this.messageScopeKey){return (messages.get(scopeKey)||[]).slice(-limit);}};
  return new AgentService({dataDir:`${process.cwd()}/.tmp-agent-conversation-test`,store});
}

test('conversation tabs keep message history isolated and archive can be restored', () => {
  const agent=fixture();
  const first=agent.listConversations().activeConversationId;
  agent.store.addMessage('user','first chat');
  const second=agent.createConversation().activeConversationId;
  assert.notEqual(first,second);
  assert.deepEqual(agent.status().messages,[]);
  agent.store.addMessage('user','second chat');
  agent.activateConversation(first);
  assert.deepEqual(agent.status().messages.map(message=>message.text),['first chat']);
  agent.archiveConversation(first);
  assert.equal(agent.listConversations().conversations.find(item=>item.id===first).archived,true);
  const restored=agent.restoreConversation(first);
  assert.equal(restored.activeConversationId,second);
  assert.ok(Array.isArray(restored.messages));
  assert.equal(agent.listConversations().conversations.find(item=>item.id===first).archived,false);
});

test('startup moves every legacy message row into its conversation without changing IDs or timestamps', t => {
  const root=mkdtempSync(join(tmpdir(),'talewisp-conversation-migration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=openStore(join(root,'data'));
  store.setMessageScope('workspace:A');
  for(let i=0;i<150;i++)store.addMessage(i%2?'assistant':'user',`legacy ${i}`);
  const before=store.exportData().messages;
  const agent=new AgentService({dataDir:root,store});
  const after=store.exportData().messages;
  assert.equal(after.length,150);
  assert.deepEqual(after.map(({id,createdAt})=>({id,createdAt})),before.map(({id,createdAt})=>({id,createdAt})));
  assert.ok(after.every(message=>message.scopeKey===store.messageScopeKey));
  assert.deepEqual(agent.status().messages.map(message=>message.text),before.slice(-100).map(message=>message.text));
  store.close();
});

test('thread bindings reject a different revision, vault, or selected book', () => {
  const agent=fixture();
  agent.runtimeContractVersion='contract-1';
  const selection={authorId:'author',seriesId:'series',bookId:'book'};
  const dynamicToolsVersion='no-google-queue;runtime-contract:contract-1;host-workflow:none;roleplay:enabled';
  const binding={threadId:'thread-1',...selection,vaultPath:'vault:A',revision:'rev-1',dynamicToolsVersion,runtimeContractVersion:'contract-1'};
  assert.equal(agent._threadBindingMatches(binding,{vaultPath:'vault:A',selection,revision:'rev-1'},'thread-1'),true);
  for(const changed of [
    {vaultPath:'vault:B',selection,revision:'rev-1'},
    {vaultPath:'vault:A',selection,revision:'rev-2'},
    {vaultPath:'vault:A',selection:{...selection,bookId:'other'},revision:'rev-1'},
  ])assert.equal(agent._threadBindingMatches(binding,changed,'thread-1'),false);
  assert.equal(agent._threadBindingMatches({...binding,threadId:'other-thread'},{vaultPath:'vault:A',selection,revision:'rev-1'},'thread-1'),false);
});

test('generated host-workflow bindings resume for the exact selection even without a vault path', async () => {
  const agent=fixture();
  agent.pluginService=null;
  agent.workspaceSelection={authorId:'author',seriesId:'series',bookId:'book'};
  agent.vaultPath=null;
  agent.workspaceRevision='rev-1';
  agent.runtimeContractVersion='contract-1';
  agent.refreshNativeConsultationStatus=async()=>{};
  agent._getRuntimeContract=async()=>({version:'contract-1',instructions:'',ROOT_WORKFLOW_INSTRUCTIONS:'',resources:[]});
  agent._registerNativeSkills=async()=>{};
  agent._ensureDelegationManager=()=>{};
  const calls=[];let threadCount=0;
  agent.runner={async request(method){calls.push(method);return method==='thread/start'?{thread:{id:`logical-book-thread-${++threadCount}`}}:{};}};
  assert.equal(await agent._ensureThread('model-1'), 'logical-book-thread-1');
  assert.equal(JSON.parse(agent.store.getSetting('agent.threadBinding')).vaultPath,null);
  assert.equal(await agent._ensureThread('model-1'), 'logical-book-thread-1');
  const first=agent.activeConversationId;
  const second=agent.createConversation().activeConversationId;
  assert.equal(await agent._ensureThread('model-1'), 'logical-book-thread-2');
  agent.activateConversation(first);
  assert.equal(await agent._ensureThread('model-1'), 'logical-book-thread-1');
  assert.notEqual(first,second);
  assert.deepEqual(calls,['thread/start','thread/resume','thread/start','thread/resume']);
});

test('conversation registry is isolated by the selected workspace', () => {
  const agent=fixture();
  const first=agent.listConversations().activeConversationId;
  agent._switchConversationScope('workspace:B');
  const second=agent.listConversations().activeConversationId;
  assert.notEqual(first,second);
  assert.equal(agent.listConversations().conversations.length,1);
  agent._switchConversationScope('workspace:A');
  assert.equal(agent.listConversations().activeConversationId,first);
});

test('conversation selection and archive state survive service reconstruction', () => {
  const agent=fixture();
  const active=agent.createConversation().activeConversationId;
  const archived=agent.listConversations().conversations.find(item=>item.id!==active).id;
  agent.archiveConversation(archived);
  agent.store.setMessageScope('workspace:A');
  const restarted=new AgentService({dataDir:`${process.cwd()}/.tmp-agent-conversation-test`,store:agent.store});
  assert.equal(restarted.listConversations().activeConversationId,active);
  assert.equal(restarted.listConversations().conversations.find(item=>item.id===archived).archived,true);
});
