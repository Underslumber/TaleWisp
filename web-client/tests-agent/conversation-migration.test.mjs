import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../store.mjs';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'tw-chat-migration-'));const store=openStore(join(dir,'state.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
test('legacy delegation history moves unchanged once with messages and never follows another active tab',t=>{
  const store=fixture(t), raw='[ {"id":"old","status":"completed","result":"preserved"} ]';
  store.addMessage('user','legacy','book');store.setSetting('agent.delegations.book',raw);
  assert.equal(store.moveMessageScope('book','book:conversation:first'),1);
  assert.equal(store.getSetting('agent.delegations.book:conversation:first'),raw);
  assert.equal(store.getSetting('agent.delegations.book'),null);
  assert.equal(store.moveMessageScope('book','book:conversation:second'),0);
  assert.equal(store.getSetting('agent.delegations.book:conversation:second'),null);
  assert.equal(store.listMessages(100,'book:conversation:first')[0].text,'legacy');
});
test('history merge retains unique legacy entries and current target values',t=>{
  const store=fixture(t);
  store.setSetting('agent.delegations.book',JSON.stringify([{id:'old'},{id:'same',status:'running'}]));
  store.setSetting('agent.delegations.tab',JSON.stringify([{id:'same',status:'completed'},{id:'new'}]));
  store.moveMessageScope('book','tab');
  assert.deepEqual(JSON.parse(store.getSetting('agent.delegations.tab')),[{id:'old'},{id:'same',status:'completed'},{id:'new'}]);
});
test('invalid conflicting history rolls back both messages and settings',t=>{
  const store=fixture(t);store.addMessage('user','keep','book');
  store.setSetting('agent.delegations.book','invalid');store.setSetting('agent.delegations.tab','[]');
  assert.throws(()=>store.moveMessageScope('book','tab'));
  assert.equal(store.listMessages(100,'book').length,1);assert.equal(store.listMessages(100,'tab').length,0);
  assert.equal(store.getSetting('agent.delegations.book'),'invalid');assert.equal(store.getSetting('agent.delegations.tab'),'[]');
});
