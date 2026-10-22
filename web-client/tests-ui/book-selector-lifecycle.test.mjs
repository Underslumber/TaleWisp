import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PRIMARY_VIEWS } from '../public/workspace-adapters.js';
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const between=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const palette=between('  function showToolPalette() {','  async function showToolPanel(');
const panel=between('  async function showToolPanel(tool) {','  async function refreshAfterImportPublish(');
const closeRegistration=between("    $('#workspace-dialog').addEventListener('close', () => {","    $$('.agent-actions");
const closeBody=closeRegistration.slice(closeRegistration.indexOf('() => {')+7,closeRegistration.lastIndexOf('});'));
const resizeRegistration=app.slice(app.lastIndexOf("  window.addEventListener('resize', () => {"),app.lastIndexOf('  bootstrap();'));
const resizeBody=resizeRegistration.slice(resizeRegistration.indexOf('() => {')+7,resizeRegistration.lastIndexOf('});'));
function fixture() {
  const calls=[],frame={id:'original-frame'};
  const state={view:'documents',googleNativeOpen:true,activeTool:'agent',sidebarOpen:false,frame};
  const element=()=>({open:false,classList:{add(){},remove(){},toggle(){}},replaceChildren(){},removeAttribute(){},addEventListener(){},cloneNode(){return element();}});
  const nodes=new Map();
  const ctx={state,PRIMARY_VIEWS,desktopInspector:true,ignoreWorkspaceClose:false,pendingWorkspaceCloseGeneration:null,returnFocus:null,portal:null,
    $:key=>{if(!nodes.has(key))nodes.set(key,element());return nodes.get(key);},$$:()=>[],
    panelLifecycle:{begin:()=>1,beginView(){},invalidate:()=>1,isCurrent:()=>true,rememberHome(){}},
    closeWorkspace:()=>calls.push('closeWorkspace'),restorePortal:()=>calls.push('restorePortal'),
    closeSpecial:()=>{calls.push('closeSpecial');state.googleNativeOpen=false;state.frame=null;},
    hasDesktopInspector:()=>true,currentKey:()=>'',draft:()=>null,loadHistory:async()=>{},selection(){},
    showPrimaryView:()=>{throw Error('Inspector must not navigate primary content');},toolPaletteClick(){}
  };
  runInNewContext(palette+'\n'+panel,ctx);
  return {ctx,calls,state,frame};
}
test('agent, context, history and tool palette preserve the same native book surface',async()=>{
  for(const tool of ['agent','context','history','tools']) {
    const f=fixture();
    if(tool==='tools')f.ctx.showToolPalette();else await f.ctx.showToolPanel(tool);
    assert.equal(f.state.googleNativeOpen,true,tool);
    assert.equal(f.state.frame,f.frame,tool);
    assert.ok(!f.calls.includes('closeSpecial'),tool);
  }
});
test('closing a mobile tool dialog preserves the currently open book',()=>{
  const f=fixture();runInNewContext('(function(){'+closeBody+'})()',f.ctx);
  assert.equal(f.state.googleNativeOpen,true);
  assert.equal(f.state.frame,f.frame);
  assert.deepEqual(f.calls,['restorePortal']);
});
test('crossing both responsive breakpoints preserves the native book, including tool-palette return',()=>{
  const f=fixture();f.ctx.hasDesktopInspector=()=>false;
  runInNewContext('(function(){'+resizeBody+'})()',f.ctx);
  assert.equal(f.state.frame,f.frame);
  assert.equal(f.state.googleNativeOpen,true);
  f.ctx.hasDesktopInspector=()=>true;f.state.activeTool='tools';
  runInNewContext('(function(){'+resizeBody+'})()',f.ctx);
  assert.equal(f.state.frame,f.frame);
  assert.equal(f.state.googleNativeOpen,true);
});
test('explicit content navigation can still close the native editor',()=>{
  const cleanup=between('  function hideGoogleNativeEditor() {','  function restorePortal() {');
  const f=fixture();let cleared=false;
  f.ctx.knowledgeViewRevision=0;f.ctx.knowledgeCardRequest=0;f.ctx.knowledgeMap=null;
  f.ctx.document={getElementById:()=>null};f.ctx.special=f.ctx.$('special');f.ctx.editor=f.ctx.$('editor');f.ctx.renderCurrent=()=>{};
  f.ctx.$('#google-native-host').replaceChildren=()=>{cleared=true;};
  runInNewContext(cleanup+'\ncloseSpecial()',f.ctx);
  assert.equal(f.state.googleNativeOpen,false);
  assert.equal(cleared,true);
});
