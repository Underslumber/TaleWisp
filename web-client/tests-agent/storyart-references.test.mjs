import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createStoryArtReferences, runReferenceBridge } from '../storyart-references.mjs';

const digest = 'a'.repeat(64);
const item = { pool: 'POSE_ATLAS', id: 'pose-front', role: 'STAGING_ONLY', sha256: digest };
const target = { requestId: 'generation-request', kind: 'generation', styleId: 'STYLE', prompt: 'Герой у двери', options: { bodyLibrary: 'on' } };
const ctx = { scope: 'author/series/book', workspaceRevision: 'w1' };
function fixture(hooks = {}) {
  const settings = new Map(); let revision = 'r1', receipt = '', calls = [];
  const record = { ...item, title: 'Стойка', categories: ['POSE_ACTION'], tags: ['STANDING'], subject_label: 'MALE', subject_label_status: 'CONFIRMED', relative_path: 'pose.png', group_id: 'group1', provenance: { source_id: item.id } };
  const bridge = async request => {
    if (request.operation === 'select') {
      await hooks.beforeSelect?.();
      if (request.revision !== revision) throw Object.assign(new Error('stale catalogue'), {status:409});
      for (const i of request.items) assert.equal(i.role, 'STAGING_ONLY');
      return { selected: request.items.map(i => ({ record: { ...record, ...i }, candidate: { approval_status: 'NOT_APPROVED' } })) };
    }
    return { revision, pools: { POSE_ATLAS: { root: 'BODY_REFERENCE_LIBRARY/POSE_ATLAS', roles: ['STAGING_ONLY'] } }, categories: { POSE_ACTION: { label_ru: 'Поза и действие' } }, records: [record, {...record,id:'unknown',subject_label:'UNKNOWN',relative_path:undefined}] };
  };
  const service = createStoryArtReferences({ projectPath: '/storyart', store: { getSetting:k=>settings.get(k),setSetting:(k,v)=>settings.set(k,v) }, currentRevision:()=>ctx.workspaceRevision, bridge, partner: { execute:async input=>{calls.push(input);return {ok:true,hostReceipt:receipt};} }, safeFile:async()=>({sha256:digest,bytes:Buffer.from('image')}),imageType:()=>({mimeType:'image/png'}) });
  return { service, calls, revise:()=>{revision='r2';}, respond:(selection,round=0)=>{receipt=`REFERENCE_SELECTION_BEGIN\n${JSON.stringify({round,selections:selection,alternatives:[],reason:'Поза подходит'})}\nREFERENCE_SELECTION_END`;} };
}
test('current categories, pagination, honest preview state and filters',async()=>{
  const {service}=fixture();const c=await service.catalog({limit:'1'});
  assert.equal(c.total,2);assert.equal(c.records.length,1);assert.equal(c.categories[0].count,2);
  assert.match(c.records[0].previewUrl,/sha256=/);assert.equal(c.records[0].generationEligible,false);
  assert.equal((await service.catalog({offset:'1'})).records[0].previewUrl,'');
  await assert.rejects(service.catalog({limit:'1000'}),{status:400});
  await assert.rejects(service.catalog({pool:'NATURAL'}),{status:400});
});
test('manual selection is scoped, confirmation and exact target required',async()=>{
  const {service}=fixture();let p=await service.create({requestId:randomUUID(),mode:'manual',target,workspaceRevision:'w1'},ctx);
  await assert.rejects(service.get(p.id,{...ctx,scope:'elsewhere'}),{status:404});
  await service.update(p.id,{items:[item],workspaceRevision:'w1'},ctx);
  await assert.rejects(service.forGeneration(p.id,target,ctx),{status:409});
  await service.update(p.id,{items:[item],confirm:true,workspaceRevision:'w1'},ctx);
  assert.equal((await service.forGeneration(p.id,target,ctx)).authorConfirmed,true);
  await assert.rejects(service.forGeneration(p.id,{...target,prompt:'Другой сюжет'},ctx),{status:409});
});
test('stale catalogue invalidates confirmed selection and preview',async()=>{
  const f=fixture();const p=await f.service.create({requestId:randomUUID(),mode:'manual',target,workspaceRevision:'w1'},ctx);
  await f.service.update(p.id,{items:[item],confirm:true,workspaceRevision:'w1'},ctx);f.revise();
  await assert.rejects(f.service.forGeneration(p.id,target,ctx),/stale/);
  await assert.rejects(f.service.image({pool:item.pool,id:item.id,revision:'r1',sha256:digest}),{status:409});
});
test('agent choice waits for confirmation; auto choice may continue',async()=>{
  for(const mode of ['confirm','auto']) {
    const f=fixture();const p=await f.service.create({requestId:randomUUID(),mode,target,workspaceRevision:'w1'},ctx);
    assert.equal(p.status,'selecting');assert.match(f.calls[0].brief,/не генерировать/);
    f.respond([item]);const ready=await f.service.get(p.id,ctx);
    assert.equal(ready.status,mode==='auto'?'ready':'awaiting_confirmation');
  }
});
test('regeneration cannot consume old response or silently replace pinned selection',async()=>{
  const f=fixture();const p=await f.service.create({requestId:randomUUID(),mode:'confirm',target,workspaceRevision:'w1'},ctx);
  f.respond([item]);await f.service.get(p.id,ctx);
  await f.service.regenerate(p.id,{workspaceRevision:'w1',message:'Другие ракурсы',pinned:[`${item.pool}:${item.id}`]},ctx);
  assert.equal((await f.service.get(p.id,ctx)).status,'selecting');
  f.respond([{...item,id:'different'}],1);
  const result=await f.service.get(p.id,ctx);assert.equal(result.status,'review_required');assert.match(result.error,/закреплённый/);
});
test('one creation ID never dispatches twice, including changed payload and scope',async()=>{
  const f=fixture(),input={requestId:randomUUID(),mode:'auto',target,workspaceRevision:'w1'};
  const [a,b]=await Promise.all([f.service.create(input,ctx),f.service.create(input,ctx)]);
  assert.equal(a.id,b.id);assert.equal(f.calls.filter(c=>c.operation==='create').length,1);
  await assert.rejects(f.service.create({...input,mode:'manual'},ctx),{status:409});
  await assert.rejects(f.service.create(input,{...ctx,scope:'other'}),{status:409});
});
test('generation reserves the confirmed snapshot; concurrent update cannot revoke it mid-dispatch',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),blocked=new Promise(r=>release=r);let hold=false;
  const f=fixture({beforeSelect:async()=>{if(hold){enter();await blocked;}}});
  const p=await f.service.create({requestId:randomUUID(),mode:'manual',target,workspaceRevision:'w1'},ctx);
  await f.service.update(p.id,{items:[item],confirm:true,workspaceRevision:'w1'},ctx);
  hold=true;const generation=f.service.forGeneration(p.id,target,ctx);await entered;
  const update=f.service.update(p.id,{items:[item],confirm:false,workspaceRevision:'w1'},ctx);
  release();await generation;await assert.rejects(update,{status:409});
  assert.equal((await f.service.get(p.id,ctx)).status,'in_use');
  await assert.rejects(f.service.forGeneration(p.id,{...target,requestId:'other-job'},ctx),{status:409});
});
test('bridge preserves UTF-8 split across process output chunks',async()=>{
  const spawnProcess=()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    child.stdin.on('finish',()=>{
      const b=Buffer.from(JSON.stringify({label:'Кисти и пальцы'}));const split=b.indexOf(Buffer.from('К'))+1;
      child.stdout.write(b.subarray(0,split));child.stdout.end(b.subarray(split));child.stderr.end();
      setImmediate(()=>child.emit('close',0));
    });return child;
  };
  assert.equal((await runReferenceBridge('/storyart',{}, {spawnProcess})).label,'Кисти и пальцы');
});


test('empty agent selection preserves its explanation and never becomes a user validation error',async()=>{
  const f=fixture();const p=await f.service.create({requestId:randomUUID(),mode:'confirm',target,workspaceRevision:'w1'},ctx);
  f.respond([]);const result=await f.service.get(p.id,ctx);
  assert.equal(result.status,'review_required');assert.equal(result.reason,'Поза подходит');assert.equal(result.error,'');assert.deepEqual(result.selections,[]);
  await assert.rejects(f.service.forGeneration(p.id,target,ctx),{status:409});
});


test('empty regeneration cannot clear a pinned reference',async()=>{
  const f=fixture();const p=await f.service.create({requestId:randomUUID(),mode:'confirm',target,workspaceRevision:'w1'},ctx);
  f.respond([item]);await f.service.get(p.id,ctx);
  await f.service.regenerate(p.id,{workspaceRevision:'w1',message:'Другие ракурсы',pinned:[`${item.pool}:${item.id}`]},ctx);
  f.respond([],1);const result=await f.service.get(p.id,ctx);
  assert.equal(result.status,'review_required');assert.match(result.error,/закреплённый/);assert.equal(result.selections[0].id,item.id);
});


test('grouped pose search returns complete real views even when only one view ID matched',async()=>{
  const f=fixture();const result=await f.service.catalog({grouped:'1',q:'pose-front',limit:'24'});
  assert.equal(result.total,1);assert.equal(result.records[0].id,'pose-front');assert.equal(result.records[0].views.length,2);
  assert.equal(result.records[0].views.find(x=>x.id==='unknown').previewUrl,'','unknown classification does not acquire a preview');
  assert.equal((await f.service.catalog({grouped:'1',subject:'MALE'})).records[0].views.length,1,'subject filter also applies to sibling views');
  assert.equal((await f.service.catalog({grouped:'1',offset:'1'})).records.length,0);
  assert.equal((await f.service.catalog({})).total,2,'legacy image paging remains compatible');
});

test('only POSE_ATLAS groups are collapsed; sketch sheets and individual crops stay independent',async()=>{
  const rows=[{pool:'POSE_ATLAS',id:'a-front',group_id:'g',angle:'front'},{pool:'POSE_ATLAS',id:'a-side',group_id:'g',angle:'side'},{pool:'PINTEREST_SKETCH',id:'sheet',group_id:'g'},{pool:'PINTEREST_SKETCH',id:'crop',group_id:'g',parent_id:'sheet'}].map(r=>({...r,sha256:digest,categories:[],tags:[],provenance:{}}));
  const service=createStoryArtReferences({bridge:async()=>({revision:'r',pools:{POSE_ATLAS:{roles:[]},PINTEREST_SKETCH:{roles:[]}},categories:{},records:rows})});
  const result=await service.catalog({grouped:'1'});assert.equal(result.total,3);assert.deepEqual(result.records.map(x=>x.id),['a-front','sheet','crop']);assert.equal('views' in result.records[1],false);
});
