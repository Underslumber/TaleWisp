import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { createPasswordAuth, createPasswordRecord } from '../auth.mjs';

class Agent extends EventEmitter { status(){return {available:true,authenticated:true,running:false,models:[],messages:[]};} shutdown(){} }
const google={status:async()=>({configured:false,authenticated:false}),disconnect:async()=>({disconnected:true})};
const setup=async(t, prior={})=>{
  const root=mkdtempSync(join(tmpdir(),'tw-password-auth-')), dataDir=prior.dataDir??join(root,'data'), authFile=join(root,'credentials.json');
  mkdirSync(dataDir,{recursive:true}); const record=createPasswordRecord('writer','correct horse battery staple'); writeFileSync(authFile,JSON.stringify(record),{mode:0o600});
  const app=await createApplication({dataDir,authFile,origin:'https://writer.example.test:8787',host:'127.0.0.1',port:8787,lock:false,agent:new Agent(),googleService:google,googleAgentService:google,...prior});
  const origin='https://writer.example.test:8787', host='writer.example.test:8787';
  const client=(initialCookie='')=>{let cookie=initialCookie;return {get cookie(){return cookie;},async request(path,method='GET',body,originOverride=origin,requestOptions={}){
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=path;req.headers={host,origin:originOverride,...(body===undefined?{}:{'content-type':'application/json'}),...(requestOptions.headers??{}),...(cookie?{cookie}:{})};req.socket={remoteAddress:requestOptions.remoteAddress??'127.0.0.1'};
    const response=await new Promise(resolve=>{const res={statusCode:200,headers:{},body:'',writeHead(status,headers={}){this.statusCode=status;this.headers=headers;},end(value=''){this.body+=String(value);resolve(this);}};app.server.emit('request',req,res);});
    if(response.headers['set-cookie'])cookie=response.headers['set-cookie'].split(';')[0];
    return {status:response.statusCode,headers:response.headers,data:response.body?JSON.parse(response.body):{}};
  }};};
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}); return {root,dataDir,authFile,app,client};
};

test('password session persists across server restart, uses HTTPS 90-day cookie and revokes one device',async t=>{
  const f=await setup(t), first=f.client(), second=f.client();
  const badOrigin=await first.request('/api/session','POST',{username:'writer',password:'correct horse battery staple',remember:true},'https://attacker.invalid'); assert.equal(badOrigin.status,403);
  const invalid=await first.request('/api/session','POST',{username:'writer',password:'wrong',remember:true}); assert.equal(invalid.status,401); assert.match(invalid.data.error,/Invalid username or password/);
  const login=await first.request('/api/session','POST',{username:'writer',password:'correct horse battery staple',remember:true});
  assert.equal(login.status,200); assert.match(login.headers['set-cookie'],/HttpOnly/); assert.match(login.headers['set-cookie'],/SameSite=Strict/); assert.match(login.headers['set-cookie'],/Secure/); assert.match(login.headers['set-cookie'],/Max-Age=7776000/);
  const other=await second.request('/api/session','POST',{username:'writer',password:'correct horse battery staple',remember:false}); assert.equal(other.status,200); assert.doesNotMatch(other.headers['set-cookie'],/Max-Age=/);
  assert.equal((await first.request('/api/status')).status,200); assert.equal((await second.request('/api/status')).status,200);
  await f.app.close();
  const restarted=await setup(t,{dataDir:f.dataDir,authFile:f.authFile});
  // The first client cookie remains valid in the restarted SQLite session store.
  const resumedFirst=restarted.client(first.cookie), resumedSecond=restarted.client(second.cookie);
  assert.equal((await resumedFirst.request('/api/status')).status,200);
  assert.equal((await resumedSecond.request('/api/status')).status,200);
  const logout=await resumedFirst.request('/api/logout','POST',{}); assert.equal(logout.status,200); assert.match(logout.headers['set-cookie'],/Max-Age=0/);
  assert.equal((await resumedFirst.request('/api/status')).status,401); assert.equal((await resumedSecond.request('/api/status')).status,200);
  await restarted.app.close();
});

test('trusted loopback proxy supplies isolated client addresses; spoofed values fall back to peer address',async t=>{
  const trustedSecret='test-only-proxy-secret', f=await setup(t,{trustedProxySecret:trustedSecret}), client=f.client();
  const loginBody={username:'writer',password:'wrong',remember:false};
  const trusted=(ip,secret=trustedSecret)=>({'x-talewisp-client-ip':ip,'x-talewisp-proxy-secret':secret});
  for(let attempt=0;attempt<10;attempt++)assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:trusted('::ffff:203.0.113.41')})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:trusted('203.0.113.41')})).status,429);

  // These attacker-controlled headers cannot select the already-blocked address.
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:{'x-talewisp-client-ip':'203.0.113.41'}})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:trusted('203.0.113.41','wrong-secret')})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:trusted('not-an-ip')})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:trusted('203.0.113.41, 203.0.113.42')})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{headers:{'x-talewisp-client-ip':['203.0.113.41'],'x-talewisp-proxy-secret':trustedSecret}})).status,401);
  assert.equal((await client.request('/api/session','POST',loginBody,undefined,{remoteAddress:'192.0.2.90',headers:trusted('203.0.113.41')})).status,401);

  const anotherIp=await client.request('/api/session','POST',{username:'writer',password:'correct horse battery staple',remember:false},undefined,{headers:trusted('203.0.113.42')});
  assert.equal(anotherIp.status,200);
});

test('password mode rejects token and local-session bypasses and expires nonremembered sessions',async t=>{
  let now=1_000_000; const root=mkdtempSync(join(tmpdir(),'tw-password-expiry-')), dataDir=join(root,'data'), authFile=join(root,'credentials.json');
  writeFileSync(authFile,JSON.stringify(createPasswordRecord('writer','secret')),{mode:0o600});
  const auth=createPasswordAuth({authFile,dataDir,now:()=>now});
  const short=auth.issue(false), long=auth.issue(true); assert.equal(auth.valid(short.token),true); assert.equal(auth.valid(long.token),true);
  now+=12*60*60*1000+1; assert.equal(auth.valid(short.token),false); assert.equal(auth.valid(long.token),true);
  for(let n=0;n<10;n++)assert.throws(()=>auth.authenticate('writer','wrong','192.0.2.10'),error=>error.status===401);
  assert.throws(()=>auth.authenticate('writer','secret','192.0.2.10'),error=>error.status===429);
  now+=15*60*1000+1; assert.equal(auth.authenticate('writer','secret','192.0.2.10'),true);
  now+=90*24*60*60*1000+1; assert.equal(auth.valid(long.token),false); auth.close(); rmSync(root,{recursive:true,force:true});
  const f=await setup(t), client=f.client();
  assert.equal((await client.request('/api/session','POST',{token:'legacy-token'})).status,400);
  assert.equal((await client.request('/api/session','POST',{local:true})).status,400);
  const bootstrap=await client.request('/api/bootstrap'); assert.equal(bootstrap.data.local,false); assert.equal(bootstrap.data.authMode,'password'); assert.equal(bootstrap.data.username,'writer'); assert.doesNotMatch(JSON.stringify(bootstrap.data),/correct horse|secret|[a-f0-9]{128}/);
});

test('oversized password is rejected even when it begins with the dummy-hash credential',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tw-password-length-')), dataDir=join(root,'data'), authFile=join(root,'credentials.json');
  writeFileSync(authFile,JSON.stringify(createPasswordRecord('writer','invalid-password')),{mode:0o600});
  const auth=createPasswordAuth({authFile,dataDir});
  assert.throws(()=>auth.authenticate('writer','invalid-password'.padEnd(1025,'x'),'192.0.2.55'),error=>error.status===401);
  assert.equal(auth.authenticate('writer','invalid-password','192.0.2.55'),true);
  auth.close(); rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

