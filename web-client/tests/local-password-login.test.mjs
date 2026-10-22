import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { createPasswordRecord } from '../auth.mjs';

class Agent extends EventEmitter { status(){return {available:true,authenticated:true,running:false,models:[],messages:[]};} shutdown(){} }
const google={status:async()=>({configured:false,authenticated:false}),disconnect:async()=>({disconnected:true})};

async function fixture(t,allowLocalAccess=true) {
  const root=mkdtempSync(join(tmpdir(),'tw-local-auth-')),dataDir=join(root,'data'),authFile=join(root,'credentials.json');
  mkdirSync(dataDir,{recursive:true});writeFileSync(authFile,JSON.stringify(createPasswordRecord('writer','local-password')),{mode:0o600});
  const app=await createApplication({dataDir,authFile,origin:'https://writer.example.test:8787',host:'127.0.0.1',port:8787,allowLocalAccess,lock:false,agent:new Agent(),googleService:google,googleAgentService:google});
  let cookie='';
  const request=async({path='/api/session',method='POST',body={username:'writer',password:'local-password',remember:true},host='127.0.0.1:8787',origin='http://127.0.0.1:8787',remoteAddress='127.0.0.1'}={})=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=path;req.headers={host,origin,...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})};req.socket={remoteAddress};
    const response=await new Promise(resolve=>{const res={statusCode:200,headers:{},body:'',writeHead(status,headers={}){this.statusCode=status;this.headers=headers;},end(value=''){this.body+=String(value);resolve(this);}};app.server.emit('request',req,res);});
    if(response.headers['set-cookie'])cookie=response.headers['set-cookie'].split(';')[0];
    return {status:response.statusCode,headers:response.headers,data:response.body?JSON.parse(response.body):{}};
  };
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {app,request};
}

test('opt-in exact loopback origin permits local password login while public origin stays secure',async t=>{
  const f=await fixture(t,true);
  const login=await f.request();assert.equal(login.status,200);assert.match(login.headers['set-cookie'],/Max-Age=7776000/);assert.match(login.headers['set-cookie'],/HttpOnly/);assert.doesNotMatch(login.headers['set-cookie'],/Secure/);
  assert.equal((await f.request({path:'/api/status',method:'GET',body:undefined})).status,200);
  assert.equal((await f.request({path:'/api/logout',method:'POST',body:{}})).status,200);
  const publicLogin=await f.request({body:{username:'writer',password:'local-password',remember:true},host:'writer.example.test:8787',origin:'https://writer.example.test:8787'});
  assert.equal(publicLogin.status,200);assert.match(publicLogin.headers['set-cookie'],/Secure/);
  const publicLogout=await f.request({path:'/api/logout',method:'POST',body:{},host:'writer.example.test:8787',origin:'https://writer.example.test:8787'});
  assert.equal(publicLogout.status,200);assert.match(publicLogout.headers['set-cookie'],/Max-Age=0/);assert.match(publicLogout.headers['set-cookie'],/Secure/);
});

test('local password login rejects wrong origins, nonloopback peers, and public host mixing',async t=>{
  const f=await fixture(t,true),body={username:'writer',password:'local-password',remember:true};
  assert.equal((await f.request({body,origin:'https://writer.example.test:8787'})).status,403);
  assert.equal((await f.request({body,remoteAddress:'192.0.2.5'})).status,403);
  assert.equal((await f.request({body,host:'writer.example.test:8787',origin:'http://127.0.0.1:8787'})).status,403);
});

test('local origin remains blocked unless explicitly enabled',async t=>{
  const f=await fixture(t,false);
  assert.equal((await f.request()).status,403);
});

