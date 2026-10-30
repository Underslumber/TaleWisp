import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferencePickerState, createReferencePickerController, referenceTargetKey, referenceObjectLabel } from '../public/storyart-reference-picker.js';

const record = { pool:'POSE_ATLAS',id:'pose1',title:'Спокойная стойка',sha256:'a'.repeat(64),role:'STAGING_ONLY',previewUrl:'/api/storyart/reference-image?id=pose1' };
const body = () => ({kind:'generation',title:'Сцена',styleId:'STYLE',prompt:'Герой стоит у двери',referenceIds:[],uploadIds:[],options:{bodyLibrary:'on'}});
function fixture(mode='confirm',groupedRecord=null) {
  const state=createReferencePickerState(mode);state.enabled=true;
  let target=body(),visible=true,failCreate=false,failRegenerate=false,slowRead=null,plan=null;const calls=[],timers=[];
  let catalogue={revision:'r1',categories:[],pools:[{id:'POSE_ATLAS',roles:['STAGING_ONLY']}],records:[groupedRecord || record],total:1};state.catalogue=structuredClone(catalogue);
  const response = () => ({plan:structuredClone(plan)});
  const request=async(url,options={})=>{
    calls.push({url,...options});
    if(url.startsWith('/api/storyart/references?'))return catalogue;
    if(url==='/api/storyart/references/plans'){
      plan={id:options.body.requestId,status:options.body.mode==='manual'?'draft':'selecting',mode:options.body.mode,revision:catalogue.revision,selections:[],alternatives:[]};
      if(failCreate)throw Error('connection lost');
      return response();
    }
    if(options.method==='POST'&&url.endsWith('/regenerate')){plan={...plan,status:'selecting'};if(failRegenerate)throw Error('lost regenerate acknowledgement');return response();}
    if(options.method==='POST'){plan={...plan,status:options.body.confirm?'ready':'awaiting_confirmation',selections:[...options.body.items]};return response();}
    plan={...plan,status:plan.mode==='auto'?'ready':'awaiting_confirmation',selections:[record],alternatives:[]};const result=response();if(slowRead){const slow=slowRead;slowRead=null;await slow.promise;}return result;
  };
  const controller=createReferencePickerController({state,request,getTarget:()=>({body:target}),revision:()=> 'w1',isVisible:()=>visible,repaint:()=>{},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{}});
  return {state,controller,calls,timers,setTarget:x=>{target=x;},hide:()=>{visible=false;},failCreate:()=>{failCreate=true;},failRegenerate:()=>{failRegenerate=true;},setRevision:revision=>{catalogue={...catalogue,revision};},deferRead:()=>{let release;const promise=new Promise(resolve=>{release=resolve;});slowRead={promise};return release;}};
}
test('manual choice survives creating the plan and needs explicit confirmation',async()=>{
  const f=fixture('manual');f.controller.choose(record);
  await assert.rejects(f.controller.ensure(body()),/Подтвердите/);
  await f.controller.confirm();assert.equal(f.state.plan.status,'ready');assert.equal(f.state.items[0].id,'pose1');
  assert.equal(await f.controller.ensure(body()),f.state.plan.id);
  assert.equal(f.calls.filter(c=>c.url==='/api/storyart/references/plans').length,1);
});
test('agent proposal is distinct from author confirmation',async()=>{
  const f=fixture();await f.controller.start();assert.equal(f.state.plan.status,'selecting');
  await f.controller.refresh();assert.equal(f.state.plan.status,'awaiting_confirmation');
  await assert.rejects(f.controller.ensure(body()),/Подтвердите/);
  await f.controller.confirm();assert.equal(f.state.plan.status,'ready');
});
test('an explicit manual pick before auto selection is preserved as a manual set',async()=>{
  const f=fixture('auto');f.controller.choose(record);assert.equal(f.state.mode,'manual');
  await f.controller.confirm();assert.equal(f.calls[0].body.mode,'manual');
  assert.equal(await f.controller.ensure(body()),f.state.plan.id);assert.equal(f.state.items[0].id,record.id);
});
test('changing the target blocks reuse of a previously confirmed set',async()=>{
  const f=fixture('manual');f.controller.choose(record);await f.controller.confirm();
  const next={...body(),prompt:'Другая сцена'};f.setTarget(next);
  assert.equal(f.controller.stale(),true);await assert.rejects(f.controller.ensure(next),/изменилось/);
  await f.controller.rebindManual();assert.equal(f.controller.stale(),false);assert.equal(f.state.items[0].id,'pose1');
  await f.controller.confirm();assert.equal(f.state.plan.status,'ready');
});
test('replacement changes only one source and keeps other choices',async()=>{
  const f=fixture('manual');const other={...record,id:'pose2'};f.controller.choose(record);f.controller.choose(other);
  f.controller.replace(record);f.controller.choose({...record,id:'pose3'});
  assert.deepEqual(f.state.items.map(x=>x.id),['pose2','pose3']);
  f.controller.replace(other);f.controller.choose({...record,id:'pose3'});
  assert.deepEqual(f.state.items.map(x=>x.id),['pose2','pose3']);assert.match(f.state.error,/уже в наборе/);
});
test('catalogue revision changes expose a rebind path in both manual and agent modes',async()=>{
  for(const mode of ['manual','confirm']){
    const f=fixture(mode);if(mode==='manual'){f.controller.choose(record);await f.controller.confirm();}else{await f.controller.start();await f.controller.refresh();await f.controller.confirm();}
    f.setRevision('r2');await f.controller.loadLibrary();assert.equal(f.controller.stale(),true);
    if(mode==='manual')await f.controller.rebindManual();else await f.controller.start();
    assert.equal(f.state.plan.revision,'r2');assert.equal(f.controller.stale(),false);
  }
});
test('reselection persists replacements and sends pins in the same plan',async()=>{
  const f=fixture();await f.controller.start();await f.controller.refresh();f.controller.pin(record);f.state.feedback='Другой ракурс';
  const id=f.state.plan.id;await f.controller.regenerate();
  const sent=f.calls.find(c=>c.url.endsWith('/regenerate'));assert.ok(sent.url.includes(id));assert.deepEqual(sent.body.pinned,['POSE_ATLAS:pose1']);
  assert.equal(f.calls.filter(c=>c.url==='/api/storyart/references/plans').length,1);
});
test('lost acknowledgement retains the exact creation attempt instead of creating a duplicate',async()=>{
  const f=fixture();f.failCreate();await f.controller.start();const first=f.calls.find(c=>c.url==='/api/storyart/references/plans');
  assert.equal(f.state.plan.status,'unknown');await f.controller.start();assert.equal(f.calls.length,1);
  await f.controller.retry();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].body,first.body);
});
test('lost reselection acknowledgement blocks mode changes and another agent message',async()=>{
  const f=fixture();await f.controller.start();await f.controller.refresh();f.state.feedback='Другой ракурс';f.failRegenerate();
  await f.controller.regenerate();assert.equal(f.state.plan.status,'unknown');
  f.controller.mode('manual');assert.equal(f.state.mode,'confirm');await f.controller.regenerate();
  assert.equal(f.calls.filter(c=>c.url.endsWith('/regenerate')).length,1);
});
test('a late previous-round read cannot overwrite a new reselection round',async()=>{
  const f=fixture();await f.controller.start();const release=f.deferRead();f.timers.shift()();await Promise.resolve();
  await f.controller.refresh();assert.equal(f.state.plan.status,'awaiting_confirmation');f.state.feedback='Другой ракурс';
  await f.controller.regenerate();assert.equal(f.state.plan.status,'selecting');release();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal(f.state.plan.status,'selecting');
});
test('late agent response cannot trigger auto generation after leaving the form',async()=>{
  const f=fixture('auto');const pending=f.controller.ensure(body());await Promise.resolve();await Promise.resolve();
  f.hide();f.timers.shift()?.();
  await assert.rejects(pending,/приостановлен|подтверждён/);
  assert.equal(f.calls.some(c=>c.url==='/api/storyart/jobs'),false);
});
test('target identity includes files/character/options but not the display title',()=>{
  assert.equal(referenceTargetKey(body()),referenceTargetKey({...body(),title:'Другое название'}));
  assert.notEqual(referenceTargetKey(body()),referenceTargetKey({...body(),uploadIds:['new-file']}));
  assert.notEqual(referenceTargetKey(body()),referenceTargetKey({...body(),characterId:'other'}));
});
test('object labels distinguish views, group scenes and sheet fragments without inventing counts',()=>{
  assert.equal(referenceObjectLabel({pool:'POSE_ATLAS',groupId:'group'}),'Ракурс одной позы');
  assert.equal(referenceObjectLabel({pool:'PINTEREST_SKETCH',kind:'GROUP_SCENE',parentId:'sheet'}),'Групповая композиция');
  assert.equal(referenceObjectLabel({pool:'PINTEREST_SKETCH',parent_id:'sheet'}),'Фрагмент исходного листа');
  assert.equal(referenceObjectLabel({pool:'DRAWING_GUIDES'}),'Учебный пример');
  assert.equal(referenceObjectLabel({pool:'COSTUME_DB_01',categories:['ACCESSORIES']}),'Референс одежды');
});


test('pose angle changes only the local preview until selected, without launching an agent',async()=>{
  const side={...record,id:'pose-side',sha256:'b'.repeat(64),group_id:'pose-g',angle:'side'};
  const front={...record,group_id:'pose-g',angle:'front'};const f=fixture('manual',{...front,views:[front,side]});
  await f.controller.loadLibrary();const before=f.calls.filter(x=>x.method==='POST').length;
  f.controller.angle(front,side);assert.equal(f.state.items.length,0);assert.equal(f.state.view.get('POSE_ATLAS:pose-g'),'POSE_ATLAS:pose-side');
  assert.equal(f.calls.filter(x=>x.method==='POST').length,before);
});

test('changing a selected pose angle keeps role, pins and replacement binding but requires confirmation',async()=>{
  const side={...record,id:'pose-side',sha256:'b'.repeat(64),group_id:'pose-g',angle:'side'};
  const front={...record,group_id:'pose-g',angle:'front'};const f=fixture('manual',{...front,views:[front,side]});
  await f.controller.loadLibrary();f.controller.choose(front);await f.controller.confirm();f.controller.pin(f.state.items[0]);f.controller.replace(f.state.items[0]);
  const before=f.calls.filter(x=>x.method==='POST').length;f.controller.angle(front,side);
  assert.equal(f.state.items[0].id,'pose-side');assert.equal(f.state.items[0].sha256,side.sha256);assert.equal(f.state.items[0].role,front.role);
  assert.deepEqual(f.state.pinned,['POSE_ATLAS:pose-side']);assert.equal(f.state.replaceKey,'POSE_ATLAS:pose-side');assert.equal(f.state.plan.status,'awaiting_confirmation');
  assert.equal(f.calls.filter(x=>x.method==='POST').length,before);await assert.rejects(f.controller.ensure(body()),/Подтвердите/);
});

test('angle selection rejects a different group and keeps an already-selected second view visible',async()=>{
  const side={...record,id:'pose-side',sha256:'b'.repeat(64),group_id:'pose-g',angle:'side'};
  const front={...record,group_id:'pose-g',angle:'front'};const f=fixture('manual',{...front,views:[front,side]});
  await f.controller.loadLibrary();f.controller.choose(front);f.controller.choose(side);const before=[...f.state.items];
  f.controller.angle(front,side);assert.match(f.state.error,/уже/);assert.deepEqual(f.state.items,before);
  f.controller.angle(front,{...side,id:'foreign',pool:'PINTEREST_SKETCH',group_id:'other'});assert.deepEqual(f.state.items,before);
});
