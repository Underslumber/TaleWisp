import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { openStore } from '../store.mjs';
import { scopeKey } from '../workspace-scope.mjs';
import { PluginService } from '../plugin-service.mjs';

const WEB_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

class FixtureAgent extends EventEmitter {
  status(){return {available:true,authenticated:true,account:{type:'chatgpt',planType:'plus'},limits:null,error:null,running:false,models:[{id:'fixture',displayName:'Fixture'}],messages:[],threadId:'fixture-thread'};}
  async connect(){return this.status();}
  async login(options){this.lastLogin=options;return {authUrl:'https://chatgpt.com/fixture-login'};}
  async message(input){this.lastMessage=input;this.emit('event',{type:'message',role:'assistant',text:'A real fixture response.'});return {accepted:true};}
  async stop(){return {stopped:true};}
  shutdown(){}
}

const fakeGoogle={
  status:async()=>({configured:false,authenticated:false,reason:'Fixture',requiresClientConfiguration:true}),
  configure:async()=>({configured:true,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/callback'}),
  beginLogin:async()=>({authUrl:'https://example.invalid/login'}),callback:async()=>({ok:true}),
  disconnect:async()=>({disconnected:true}),readDocument:async id=>({documentId:id,title:'Fixture',revisionId:'rev',tabs:[],comments:[],raw:{}}),
  suggest:async()=>({status:'suggested'}),comment:async()=>({status:'commented'}),
};
const fakeGoogleAgent={...fakeGoogle,configure:async()=>({configured:true,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/agent/callback'})};

async function fixture(t,overrides={}) {
  const root=mkdtempSync(join(tmpdir(),'talewisp-web-test-'));
  const vault=join(root,'vault');mkdirSync(vault);writeFileSync(join(vault,'source.md'),'Keller watches the rain at the window.\n');
  const {realAgent=false,prepare,...appOverrides}=overrides;
  const dataDir=overrides.dataDir??join(root,'data');
  const prepared=await prepare?.({root,vault,dataDir})??{};
  const host=overrides.host??'127.0.0.1',port=overrides.port??8787;
  const app=await createApplication({...prepared,...appOverrides,dataDir,host,port,vaultPath:Object.hasOwn(overrides,'vaultPath')?overrides.vaultPath:vault,...(realAgent?{}:{agent:overrides.agent??new FixtureAgent()}),googleService:overrides.googleService??fakeGoogle,googleAgentService:overrides.googleAgentService??fakeGoogleAgent});
  const origin=overrides.origin??`http://${host.includes(':')?`[${host}]`:host}:${port}`;
  let cookie='';
  const raw=async(path,options={})=>{
    const headers={...(options.body?{'content-type':'application/json'}:{}),origin,...(options.headers??{})};
    if(cookie)headers.cookie=cookie;
    const chunks=options.body?[Buffer.from(JSON.stringify(options.body))]:[];
    const req=Readable.from(chunks);req.method=options.method??'GET';req.url=path;req.headers={...headers,host:options.host??headers.host??`${host.includes(':')?`[${host}]`:host}:${port}`};req.socket={remoteAddress:options.remoteAddress??'127.0.0.1'};
    const done=new Promise(resolve=>{
      const res={statusCode:200,headers:{},body:'',destroyed:false,writeHead(status,headers={}){this.statusCode=status;this.headers=headers;return this;},write(chunk){this.body+=String(chunk);return true;},end(chunk=''){this.body+=String(chunk);resolve(this);}};
      app.server.emit('request',req,res);
    });
    const response=await done;const setCookie=response.headers['set-cookie'];if(setCookie)cookie=setCookie.split(';')[0];
    const data=response.body?JSON.parse(response.body):{};
    return {response:{status:response.statusCode,headers:{get:name=>response.headers[name]}},data};
  };
  const api=async(method,path,body)=>raw(path,{method,body});
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  return {root,vault,origin,app,raw,api};
}

test('local session requires same origin and protects the editing APIs',async t=>{
  const f=await fixture(t);
  const bad=await f.raw('/api/session',{method:'POST',body:{local:true},headers:{origin:'https://attacker.invalid'}});
  assert.equal(bad.response.status,403);
  const login=await f.api('POST','/api/session',{local:true});assert.equal(login.response.status,200);assert.equal(login.data.authenticated,true);
  const bootstrap=await f.raw('/api/bootstrap');assert.equal(bootstrap.data.authenticated,true);
  const create=await f.api('POST','/api/documents',{title:'Draft',text:'First pass.'});assert.equal(create.response.status,201);
  const id=create.data.document.id;
  const save=await f.api('PUT',`/api/documents/${id}`,{title:'Draft',text:'Second pass.',version:1});assert.equal(save.response.status,200);assert.equal(save.data.document.version,2);
  const conflict=await f.api('PUT',`/api/documents/${id}`,{title:'Lost update',text:'Stale',version:1});assert.equal(conflict.response.status,409);
  const history=await f.raw(`/api/documents/${id}/history`);assert.deepEqual(history.data.versions.map(v=>v.version),[2,1]);
  const restore=await f.api('POST',`/api/documents/${id}/restore`,{historyId:history.data.versions[1].id,version:2});assert.equal(restore.response.status,200);assert.equal(restore.data.document.text,'First pass.');assert.equal(restore.data.document.version,3);
  const note=await f.api('POST','/api/notes',{title:'Idea',text:'Keep the rain detail.',documentId:id});assert.equal(note.response.status,201);
  const notes=await f.raw('/api/notes?scope=all');assert.equal(notes.data.notes[0].documentId,id);
});

test('native Google editor CSP allows only Google Docs frames and preserves other boundaries',async t=>{
  const f=await fixture(t);
  const {response}=await f.raw('/',{method:'HEAD'});
  assert.equal(response.status,200);
  const csp=response.headers.get('content-security-policy');
  assert.match(csp,/frame-src https:\/\/docs\.google\.com;/);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.match(csp,/connect-src 'self'/);
  assert.match(csp,/script-src 'self'/);
  assert.doesNotMatch(csp,/frame-src[^;]*\*/);
});

test('Host allowlist rejects DNS rebinding and accepts only fixed loopback aliases',async t=>{
  const f=await fixture(t);
  assert.equal((await f.raw('/api/bootstrap',{host:'evil.example:8787'})).response.status,400);
  assert.equal((await f.raw('/api/bootstrap',{host:'localhost:8787'})).data.local,true);
  assert.equal((await f.raw('/api/bootstrap',{host:'[::1]:8787'})).data.local,true);
  const badOrigin=await f.raw('/api/session',{method:'POST',host:'localhost:8787',body:{local:true},headers:{origin:'http://evil.example:8787'}});
  assert.equal(badOrigin.response.status,403);
});

test('proxy or configured public origin disables local login even on a loopback proxy socket',async t=>{
  await assert.rejects(()=>createApplication({dataDir:join(tmpdir(),`tw-public-origin-${Date.now()}`),host:'127.0.0.1',port:8787,origin:'https://writer.example.test',agent:new FixtureAgent(),googleService:fakeGoogle}),/public origin requires TALEWISP_WEB_TOKEN/);
  const f=await fixture(t,{webToken:'shared-site-token'});
  const bootstrap=await f.raw('/api/bootstrap');assert.equal(bootstrap.data.local,false);
  const local=await f.raw('/api/session',{method:'POST',body:{local:true},headers:{'x-forwarded-for':'203.0.113.20'}});
  assert.equal(local.response.status,401);
  const token=await f.raw('/api/session',{method:'POST',body:{token:'shared-site-token'}});
  assert.equal(token.response.status,200);
});

test('Google callback uses the pinned HTTPS origin instead of the request Host',async t=>{
  let callbackUrl=null;
  const google={...fakeGoogle,callback:async url=>{callbackUrl=url;return {ok:true};}};
  const f=await fixture(t,{webToken:'proxy-token',origin:'https://writer.example.test',googleService:google});
  const callback=await f.raw('/api/google/callback?code=abc&state=state-1',{host:'writer.example.test'});
  assert.equal(callback.response.status,200);
  assert.equal(callbackUrl,'https://writer.example.test/api/google/callback?code=abc&state=state-1');
  assert.equal((await f.raw('/api/google/callback?code=abc',{host:'attacker.example.test'})).response.status,400);
});

test('Google agent callback has its own known-host callback channel',async t=>{
  let callbackUrl=null;
  const googleAgent={...fakeGoogleAgent,callback:async url=>{callbackUrl=url;return {ok:true};}};
  const f=await fixture(t,{webToken:'proxy-token',origin:'https://writer.example.test',googleAgentService:googleAgent});
  const callback=await f.raw('/api/google/agent/callback?code=abc&state=state-2',{host:'writer.example.test'});
  assert.equal(callback.response.status,200);
  assert.equal(callbackUrl,'https://writer.example.test/api/google/agent/callback?code=abc&state=state-2');
  assert.equal((await f.raw('/api/google/agent/callback?code=abc',{host:'attacker.example.test'})).response.status,400);
});

test('Google agent controls use their own service and preserve same-origin authentication guards',async t=>{
  const calls=[];
  const googleAgent={...fakeGoogleAgent,status:async()=>({configured:false,authenticated:false,reason:'missing_google_oauth_configuration',requiresClientConfiguration:true,redirectUri:'http://127.0.0.1:8787/api/google/agent/callback'}),configure:async body=>{calls.push(['configure',body]);return {configured:true,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/agent/callback'};},beginLogin:async()=>{calls.push(['login']);return {authUrl:'https://agent.example/login'};},disconnect:async()=>{calls.push(['disconnect']);return {disconnected:true};}};
  const f=await fixture(t,{googleAgentService:googleAgent});
  assert.equal((await f.raw('/api/google/agent/status')).response.status,401);
  await f.api('POST','/api/session',{local:true});
  const badOrigin=await f.raw('/api/google/agent/configure',{method:'POST',body:{clientId:'agent-id',clientSecret:'agent-secret'},headers:{origin:'https://attacker.invalid'}});
  assert.equal(badOrigin.response.status,403);
  const configured=await f.api('POST','/api/google/agent/configure',{clientId:'agent-id',clientSecret:'agent-secret'});
  assert.equal(configured.response.status,200);
  assert.deepEqual(calls[0],['configure',{clientId:'agent-id',clientSecret:'agent-secret'}]);
  assert.deepEqual((await f.api('POST','/api/google/agent/login',{})).data,{authUrl:'https://agent.example/login'});
  assert.deepEqual((await f.api('POST','/api/google/agent/disconnect',{})).data,{disconnected:true});
  assert.equal((await f.raw('/api/status')).data.googleAgent.redirectUri,'http://127.0.0.1:8787/api/google/agent/callback');
});

test('Google agent status returns current safe Sheets and reply capability flags only',async t=>{
  let scopes=new Set(['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive.file']);
  const googleAgent={
    ...fakeGoogleAgent,
    status:async()=>({configured:true,authenticated:true,reason:null,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/agent/callback'}),
    capabilities:async()=>({configured:true,authenticated:true,scopes:[...scopes],canReadSheets:[...scopes].some(scope=>scope.endsWith('/spreadsheets')||scope.endsWith('/spreadsheets.readonly')||scope.endsWith('/drive.file')||scope.endsWith('/drive.readonly')||scope.endsWith('/drive')),canWriteSheets:[...scopes].some(scope=>scope.endsWith('/spreadsheets')||scope.endsWith('/drive.file')||scope.endsWith('/drive')),canReply:[...scopes].some(scope=>scope.endsWith('/drive.file')||scope.endsWith('/drive')),accessToken:'must-not-be-returned',clientSecret:'must-not-be-returned'})
  };
  const f=await fixture(t,{googleAgentService:googleAgent});
  await f.api('POST','/api/session',{local:true});
  const granted=(await f.api('GET','/api/google/agent/status')).data;
  assert.equal(granted.canReadSheets,true);
  assert.equal(granted.canWriteSheets,true);
  assert.equal(granted.canReply,true);
  assert.equal(Object.hasOwn(granted,'scopes'),false);
  assert.equal(Object.hasOwn(granted,'accessToken'),false);
  assert.equal(Object.hasOwn(granted,'clientSecret'),false);

  scopes=new Set(['https://www.googleapis.com/auth/documents']);
  const absent=(await f.api('GET','/api/google/agent/status')).data;
  assert.equal(absent.canReadSheets,false);
  assert.equal(absent.canWriteSheets,false);
  assert.equal(absent.canReply,false);
});

test('plugin Google tools are connected only to the agent OAuth service',async t=>{
  let connected=null;
  const pluginService={setGoogleService(service){connected=service;}};
  const f=await fixture(t,{pluginService,googleService:fakeGoogle,googleAgentService:fakeGoogleAgent});
  assert.equal(connected,f.app.googleAgent);
  assert.notEqual(connected,f.app.google);
});

test('Google Docs picker route uses the human service and passes bounded search paging',async t=>{
  const calls=[];
  const human={...fakeGoogle,listDocuments:async options=>{calls.push(['human',options]);return {files:[{id:'human-doc',title:'Human document'}],nextPageToken:'next-human'};}};
  const agentGoogle={...fakeGoogleAgent,listDocuments:async options=>{calls.push(['agent',options]);return {files:[{id:'agent-doc',title:'Agent document'}],nextPageToken:''};}};
  const f=await fixture(t,{googleService:human,googleAgentService:agentGoogle});
  await f.api('POST','/api/session',{local:true});
  const page=await f.raw('/api/google/documents?q=chapter&pageToken=next&pageSize=10');
  assert.equal(page.response.status,200);
  assert.deepEqual(page.data,{files:[{id:'human-doc',title:'Human document'}],nextPageToken:'next-human'});
  assert.deepEqual(calls,[['human',{query:'chapter',pageToken:'next',pageSize:10}]]);
});

test('agent Google list tool is read-only and uses only the connected agent service',async t=>{
  const calls=[];
  const agentGoogle={status:async()=>({configured:true,authenticated:true}),listDocuments:async args=>{calls.push(args);return {files:[{id:'agent-doc',title:'Agent document'}],nextPageToken:''};}};
  const stdout=new PassThrough(),stderr=new PassThrough();
  const proc=new EventEmitter(); proc.stdout=stdout; proc.stderr=stderr; proc.stdin={write(line){const request=JSON.parse(line);if(request.id)setImmediate(()=>stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='tools/list'?{tools:[]}: {}})+'\n'));return true;}}; proc.kill=()=>{};
  const service=new PluginService({workspaceService:{root:async()=>'/series',revision:async()=>'rev'},dataDir:'/tmp/talewisp-plugin-test',talewispMcpPath:'/fixture',spawnImpl:()=>proc,googleService:agentGoogle});
  t.after(()=>service.client?.close());
  const tools=await service.tools(),list=tools.find(tool=>tool.name==='talewisp_web_google_list');
  assert.equal(list.annotations.readOnlyHint,true);
  assert.equal(list.inputSchema.properties.pageSize.maximum,30);
  assert.deepEqual(await service.call('talewisp_web_google_list',{query:'draft',pageSize:8},'rev'),{files:[{id:'agent-doc',title:'Agent document'}],nextPageToken:''});
  assert.deepEqual(calls,[{query:'draft',pageSize:8}]);
});

test('Google login route returns the authorization URL as a flat string field',async t=>{
  const f=await fixture(t);
  await f.api('POST','/api/session',{local:true});
  const login=await f.api('POST','/api/google/login',{});
  assert.equal(login.response.status,200);
  assert.deepEqual(login.data,{authUrl:'https://example.invalid/login'});
  assert.equal(typeof login.data.authUrl,'string');
});

test('agent login defaults to browser and forwards only a validated login method',async t=>{
  const f=await fixture(t);
  await f.api('POST','/api/session',{local:true});
  const defaultLogin=await f.api('POST','/api/agent/login',{});
  assert.equal(defaultLogin.response.status,200);
  assert.deepEqual(f.app.agent.lastLogin,{method:'browser'});
  const deviceLogin=await f.api('POST','/api/agent/login',{method:'device',apiKey:'discarded'});
  assert.equal(deviceLogin.response.status,400);
  assert.deepEqual(f.app.agent.lastLogin,{method:'browser'});
  const invalid=await f.api('POST','/api/agent/login',{method:'arbitrary',extra:'discarded'});
  assert.equal(invalid.response.status,400);
  assert.deepEqual(f.app.agent.lastLogin,{method:'browser'});
  const device=await f.api('POST','/api/agent/login',{method:'device'});
  assert.equal(device.response.status,200);
  assert.deepEqual(f.app.agent.lastLogin,{method:'device'});
});

test('Google OAuth configuration route is authenticated, same-origin, and never returns submitted secrets',async t=>{
  let configured=false;
  const google={...fakeGoogle,status:async()=>({configured,authenticated:false,reason:configured?'not_connected':'missing_google_oauth_configuration',requiresClientConfiguration:!configured}),configure:async()=>{configured=true;return {configured:true,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/callback'};}};
  const f=await fixture(t,{googleService:google});
  const body={clientId:'123456789012-example.apps.googleusercontent.com',clientSecret:'GOCSPX-secret-value'};
  const unauthenticated=await f.api('POST','/api/google/configure',body);
  assert.equal(unauthenticated.response.status,401);
  await f.api('POST','/api/session',{local:true});
  const crossOrigin=await f.raw('/api/google/configure',{method:'POST',body,headers:{origin:'https://attacker.invalid'}});
  assert.equal(crossOrigin.response.status,403);
  const configuredResponse=await f.api('POST','/api/google/configure',body);
  assert.equal(configuredResponse.response.status,200);
  assert.deepEqual(configuredResponse.data,{configured:true,requiresClientConfiguration:false,redirectUri:'http://127.0.0.1:8787/api/google/callback'});
  assert.doesNotMatch(JSON.stringify(configuredResponse.data),/GOCSPX-secret-value|123456789012-example/);
  const status=await f.raw('/api/google/status');
  assert.equal(status.data.redirectUri,'http://127.0.0.1:8787/api/google/callback');
  assert.equal(status.data.requiresClientConfiguration,false);
  assert.equal(status.data.configured,true);
});

test('knowledge status follows the persisted vault root and search reports its file cap',async t=>{
  const f=await fixture(t,{vaultPath:undefined,prepare:({root,dataDir})=>{
    const series=join(root,'series');
    mkdirSync(join(series,'04 Анализ'),{recursive:true});
    writeFileSync(join(series,'00 Паспорт серии.md'),'Series passport.');
    writeFileSync(join(series,'04 Анализ','Лексический словарь.md'),'Preferred and avoided words.');
    for(let index=0;index<301;index++)writeFileSync(join(series,`source-${String(index).padStart(3,'0')}.md`),'rarefind token');
    const store=openStore(dataDir);store.setSetting('knowledge.vaultPath',series);return {store};
  }});
  await f.api('POST','/api/session',{local:true});
  const status=await f.raw('/api/knowledge/status');
  assert.deepEqual(status.data,{configured:true,name:'series',starterSources:[{path:'00 Паспорт серии.md',title:'00 Паспорт серии'},{path:'04 Анализ/Лексический словарь.md',title:'Лексический словарь'}]});
  const search=await f.raw('/api/knowledge?q=rarefind');
  assert.equal(search.data.configured,true);
  assert.equal(search.data.truncated,true);
  assert.ok(search.data.files.every(file=>file.path.startsWith('source-')));
});

test('a depth-limited knowledge branch does not hide later root sources',async t=>{
  const f=await fixture(t,{vaultPath:undefined,prepare:({root,dataDir})=>{
    const series=join(root,'series');
    mkdirSync(join(series,'a','b','c','d','e','f','g','h'),{recursive:true});
    writeFileSync(join(series,'z.md'),'depthprobe token');
    const store=openStore(dataDir);store.setSetting('knowledge.vaultPath',series);return {store};
  }});
  await f.api('POST','/api/session',{local:true});
  const result=await f.raw('/api/knowledge?q=depthprobe');
  assert.equal(result.data.truncated,true);
  assert.deepEqual(result.data.files.map(file=>file.path),['z.md']);
});

test('Google reconciliation is authenticated, same-origin, and derives its owner from the server',async t=>{
  const calls=[];
  const google={...fakeGoogle,reconcileOperation:async payload=>{calls.push(payload);return {state:'author_reviewed',operationId:payload.operationId};}};
  const f=await fixture(t,{googleService:google});
  const body={documentId:'drive_doc-1',operationId:'op_123',authorReviewed:true,ownerId:'attacker-controlled'};
  const noOrigin=await f.raw('/api/google/reconcile',{method:'POST',body,headers:{origin:undefined}});
  assert.equal(noOrigin.response.status,403);
  const unauthenticated=await f.api('POST','/api/google/reconcile',body);
  assert.equal(unauthenticated.response.status,401);
  assert.deepEqual(calls,[]);
  await f.api('POST','/api/session',{local:true});
  const notReviewed=await f.api('POST','/api/google/reconcile',{...body,authorReviewed:1});
  assert.equal(notReviewed.response.status,400);
  const invalidId=await f.api('POST','/api/google/reconcile',{...body,operationId:'../other'});
  assert.equal(invalidId.response.status,400);
  assert.deepEqual(calls,[]);
  const accepted=await f.api('POST','/api/google/reconcile',body);
  assert.equal(accepted.response.status,200);
  assert.deepEqual(accepted.data.operation,{state:'author_reviewed',operationId:'op_123'});
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0],{documentId:'drive_doc-1',operationId:'op_123',authorReviewed:true,ownerId:f.app.store.getSetting('google.ownerId')});
  assert.notEqual(calls[0].ownerId,body.ownerId);
});

test('Google reconciliation returns 503 when the service cannot reconcile',async t=>{
  const f=await fixture(t);await f.api('POST','/api/session',{local:true});
  const unavailable=await f.api('POST','/api/google/reconcile',{documentId:'drive_doc-1',operationId:'op_123',authorReviewed:true});
  assert.equal(unavailable.response.status,503);
});

test('knowledge access is bounded, source-addressed, read-only, and rejects traversal',async t=>{
  const f=await fixture(t);await f.api('POST','/api/session',{local:true});
  const before=readFileSync(join(f.vault,'source.md'),'utf8');
  const search=await f.raw('/api/knowledge?q=Keller+rain');assert.equal(search.data.configured,true);assert.equal(search.data.files[0].path,'source.md');
  const source=await f.raw('/api/knowledge/file?path=source.md');assert.equal(source.data.text,before);assert.match(source.data.revision,/^[0-9a-f]{64}$/);
  const traversal=await f.raw('/api/knowledge/file?path=..%2Fdata%2Ftalewisp-web.sqlite');assert.equal(traversal.response.status,400);
  assert.equal(readFileSync(join(f.vault,'source.md'),'utf8'),before);
});

test('agent route returns genuine fixture events and export omits runtime secrets',async t=>{
  const f=await fixture(t,{prepare:({root})=>{const catalog=join(root,'catalog');const put=(rel,text)=>{const path=join(catalog,rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text,'utf8');};put('00 Автор/Writer/Автор.md','---\ntype: author\ntitle: Writer\n---');put('00 Автор/Writer/Series/00 Паспорт/Series.md','---\ntype: passport\ntitle: Series\n---');put('00 Автор/Writer/Series/01 Книги/Book/Book.md','---\ntype: book\ntitle: Book\nbook_id: B08\n---');put('00 Автор/Writer/Series/01 Книги/Other/Other.md','---\ntype: book\ntitle: Other\nbook_id: B09\n---');return {catalogVaultPath:catalog};}});await f.api('POST','/api/session',{local:true});
  const unbound=(await f.api('POST','/api/documents',{title:'Scene',text:'A draft.'})).data.document;
  const catalog=f.app.workspaceService.catalog(),ids={authorId:catalog.authors[0].id,seriesId:catalog.authors[0].series[0].id,bookId:catalog.authors[0].series[0].books[0].id};
  assert.equal((await f.api('POST','/api/workspace/select',ids)).response.status,200);
  const blocked=await f.api('POST','/api/agent/message',{text:'Continue this scene',documentId:unbound.id,documentVersion:unbound.version});assert.equal(blocked.response.status,409);assert.equal(f.app.store.getDocument(unbound.id).bookId,null);
  const document=(await f.api('POST',`/api/documents/${unbound.id}/bind`,{version:unbound.version})).data.document;
  const sent=await f.api('POST','/api/agent/message',{text:'Continue this scene',documentId:document.id,documentVersion:document.version,selectedText:'A draft.',knowledgePaths:['source.md'],model:'fixture'});
  assert.equal(sent.response.status,202);assert.deepEqual(f.app.agent.lastMessage.knowledgePaths,['source.md']);
  assert.deepEqual(f.app.agent.lastMessage.documentSnapshot,{id:document.id,title:'Scene',version:document.version,text:'A draft.'});
  const other=catalog.authors[0].series[0].books.find(item=>item.name==='Other');await f.api('POST','/api/workspace/select',{...ids,bookId:other.id});const foreign=(await f.api('POST','/api/documents',{title:'Other book',text:'Other scope'})).data.document;await f.api('POST','/api/workspace/select',ids);
  const foreignUse=await f.api('POST','/api/agent/message',{text:'Continue',documentId:foreign.id,documentVersion:foreign.version});assert.equal(foreignUse.response.status,409);assert.equal(f.app.store.getDocument(foreign.id).bookId,other.id);
  const status=await f.raw('/api/agent/status');assert.equal(status.data.authenticated,true);
  const exportData=await f.api('POST','/api/export',{});assert.equal(exportData.data.documents.length,2);assert.equal(JSON.stringify(exportData.data).includes('fixture-login'),false);
  const apiKey=await f.raw('/api/agent/login',{method:'POST',body:{apiKey:'sk-test'},headers:{origin:f.origin}});assert.notEqual(apiKey.response.status,200);
});

test('single process lock is held for one data directory and released on close',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>createApplication({dataDir:f.app.dataDir,host:'127.0.0.1',port:0,vaultPath:f.vault,agent:new FixtureAgent(),googleService:fakeGoogle}),/already using this data directory/);
});

test('runtime config disables general tools and allowlists only read-only TaleWisp operations',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-agent-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const { AgentService }=await import('../agent.mjs');
  const { openStore }=await import('../store.mjs');
  const store=openStore(join(root,'data'));
  const agent=new AgentService({dataDir:join(root,'data'),store,vaultPath:join(root,'vault'),talewispMcpPath:join(root,'talewisp_mcp.py')});
  agent._writeRuntimeConfig();
  const config=readFileSync(join(root,'data','codex-home','config.toml'),'utf8');
  assert.match(config,/shell_tool = false/);assert.match(config,/apps = false/);assert.match(config,/multi_agent = false/);
  assert.match(config,/sandbox_mode = "read-only"/);assert.match(config,/enabled_tools = \["talewisp_project_status", "talewisp_onboarding_status", "talewisp_list_files", "talewisp_read_file", "talewisp_search", "talewisp_scene_context"\]/);
  assert.doesNotMatch(config,/talewisp_apply_proposal|talewisp_save_proposal|talewisp_select_vault/);
  store.close();
});

test('effective runtime config fails closed before catalog or chat when shell is enabled',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-agent-config-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const { AgentService }=await import('../agent.mjs');
  const calls=[];
  const store={getSetting:()=>null,listMessages:()=>[],addMessage(){}};
  const runner={
    closed:false,effectiveConfig:null,
    on(){return this;},off(){return this;},
    async initialize(){this.effectiveConfig={config:{sandbox_mode:'read-only',approval_policy:'never',features:{shell_tool:true,apps:false,multi_agent:false},agents:{enabled:false},mcp_servers:{talewisp:{enabled:true,required:true,enabled_tools:['talewisp_project_status','talewisp_onboarding_status','talewisp_list_files','talewisp_read_file','talewisp_search','talewisp_scene_context']}}}};},
    async request(method){calls.push(method);return method==='account/read'?{account:{type:'chatgpt'}}:{};},
    async stop(){this.closed=true;},
  };
  const agent=new AgentService({dataDir:join(root,'data'),store,vaultPath:join(root,'vault'),talewispMcpPath:join(root,'talewisp_mcp.py'),runnerFactory:()=>runner});
  const status=await agent.connect();
  assert.equal(status.available,false);
  assert.match(status.error,/effective config does not meet/);
  assert.deepEqual(calls,[]);
  await assert.rejects(()=>agent.message({text:'Write a scene.'}),/effective config does not meet/);
  assert.equal(calls.includes('turn/start'),false);
});

test('final-only AgentMessageThreadItem text is preserved',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-agent-message-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const { AgentService }=await import('../agent.mjs');
  const messages=[];
  const store={getSetting:()=>null,listMessages:()=>[],addMessage:(role,text)=>messages.push({role,text})};
  const agent=new AgentService({dataDir:join(root,'data'),store});
  const events=[];agent.on('event',event=>events.push(event));
  agent._notification({method:'item/completed',params:{item:{type:'agentMessage',id:'msg-1',text:'Final response without deltas.'}}});
  assert.deepEqual(messages,[{role:'assistant',text:'Final response without deltas.'}]);
  assert.equal(events.at(-1).text,'Final response without deltas.');
});

async function turnHarness(root,{turnStartError=null,interruptError=null}={}) {
  const { AgentService }=await import('../agent.mjs');
  const state={settings:{'agent.threadId':''},messages:[]};
  const store={getSetting:key=>state.settings[key]??null,setSetting:(key,value)=>{state.settings[key]=value;},listMessages:()=>state.messages,addMessage:(role,text)=>state.messages.push({role,text})};
  const calls=[],requests=[];let confirmExit=false;let stopCalls=0;
  const runner=new EventEmitter();runner.closed=false;runner.exited=false;
  runner.initialize=async()=>{runner.effectiveConfig={config:{sandbox_mode:'read-only',approval_policy:'never',features:{shell_tool:false,apps:false,multi_agent:false},agents:{enabled:false},mcp_servers:{talewisp:{enabled:true,required:true,enabled_tools:['talewisp_project_status','talewisp_onboarding_status','talewisp_list_files','talewisp_read_file','talewisp_search','talewisp_scene_context']}}}};};
  runner.request=async(method,params={})=>{calls.push(method);requests.push({method,params});if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='model/list')return {data:[]};if(method==='thread/start')return {thread:{id:'thread-test'}};if(method==='turn/start'&&turnStartError)throw turnStartError;if(method==='turn/interrupt'&&interruptError)throw interruptError;return {};};
  runner.stop=async()=>{stopCalls++;runner.closed=true;if(!confirmExit)return false;runner.exited=true;runner.emit('exit',new Error('app-server exited'));return true;};
  const selection={authorId:'author',authorName:'Fixture Author',seriesId:'series',seriesName:'Fixture Series',bookId:'book',bookName:'Fixture Book'};
  const workspaceService={root:()=>join(root,'vault'),selection:()=>selection,revision:()=> 'fixture-revision',catalog:()=>({authors:[{id:'author',name:'Fixture Author',series:[{id:'series',name:'Fixture Series',books:[{id:'book',name:'Fixture Book'}]}]}]}),overview:()=>({style:{available:false,excluded:[]},manuscripts:[],progress:{},capabilities:[]})};
  const agent=new AgentService({dataDir:join(root,'data'),store,talewispMcpPath:join(root,'talewisp_mcp.py'),runnerFactory:()=>runner,workspaceService});
  await agent.setWorkspace({vaultPath:join(root,'vault'),selection,revision:'fixture-revision'});
  return {agent,runner,state,calls,requests,confirmExit:()=>{confirmExit=true;},stopCalls:()=>stopCalls};
}

test('interrupt failure keeps the turn lock until app-server exit is confirmed',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-stop-uncertain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const h=await turnHarness(root,{interruptError:new Error('interrupt timed out')});
  await h.agent.message({text:'Continue'});
  const firstStop=await h.agent.stop();assert.deepEqual(firstStop,{stopped:false,running:true,childDelegationsRemaining:0});
  await assert.rejects(()=>h.agent.message({text:'A second turn'}),/Wait for the current response/);
  assert.equal(h.calls.filter(call=>call==='turn/start').length,1);
  h.confirmExit();const secondStop=await h.agent.stop();assert.deepEqual(secondStop,{stopped:true,running:false,childDelegationsRemaining:0});
  assert.equal(h.agent.inTurn,false);assert.equal(h.agent.threadId,null);assert.equal(h.state.settings['agent.threadId'],'');
});

test('turn/start timeout remains locked until uncertain app-server is confirmed exited',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-start-uncertain-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const h=await turnHarness(root,{turnStartError:new Error('App-server turn/start timed out')});
  await assert.rejects(()=>h.agent.message({text:'Start this turn'}),/turn\/start timed out/);
  assert.equal(h.agent.inTurn,true);assert.equal(h.agent.threadId,null);assert.equal(h.state.settings['agent.threadId'],'');
  await assert.rejects(()=>h.agent.message({text:'Retry this turn'}),/Wait for the current response/);
  assert.equal(h.calls.filter(call=>call==='turn/start').length,1);
  h.confirmExit();const stopped=await h.agent.stop();assert.deepEqual(stopped,{stopped:true,running:false,childDelegationsRemaining:0});
});

test('only a real turn/completed notification releases a successful turn lock',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-turn-complete-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const h=await turnHarness(root);
  await h.agent.message({text:'First turn'});
  await assert.rejects(()=>h.agent.message({text:'Too early'}),/Wait for the current response/);
  h.agent._notification({method:'turn/completed',params:{turn:{status:'completed'}}});
  assert.equal(h.agent.inTurn,false);
  await h.agent.message({text:'Next turn'});
  assert.equal(h.calls.filter(call=>call==='turn/start').length,2);
});

test('document-bound message rejects missing or stale version before any agent call',async t=>{
  const f=await fixture(t);await f.api('POST','/api/session',{local:true});
  const created=(await f.api('POST','/api/documents',{title:'Scene',text:'Version one.'})).data.document;
  const missing=await f.api('POST','/api/agent/message',{text:'Continue',documentId:created.id});
  assert.equal(missing.response.status,400);assert.equal(f.app.agent.lastMessage,undefined);
  const updated=await f.api('PUT',`/api/documents/${created.id}`,{title:'Scene',text:'Version two.',version:created.version});
  assert.equal(updated.response.status,200);
  const stale=await f.api('POST','/api/agent/message',{text:'Continue',documentId:created.id,documentVersion:created.version});
  assert.equal(stale.response.status,409);assert.equal(f.app.agent.lastMessage,undefined);
});

test('agent stages the supplied document snapshot without re-reading by ID',async t=>{
  const root=mkdtempSync(join(tmpdir(),'talewisp-document-snapshot-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const h=await turnHarness(root);
  await assert.rejects(()=>h.agent.message({text:'Missing revision',documentId:'doc-1'}),error=>error.status===400);
  await assert.rejects(()=>h.agent.message({text:'Stale snapshot',documentId:'doc-1',documentVersion:8,documentSnapshot:{id:'doc-1',title:'Captured draft',version:7,text:'Frozen snapshot text.'}}),error=>error.status===409);
  assert.deepEqual(h.calls,[]);
  await h.agent.message({text:'Continue',documentId:'doc-1',documentVersion:7,documentSnapshot:{id:'doc-1',title:'Captured draft',version:7,text:'Frozen snapshot text.'}});
  const start=h.requests.find(request=>request.method==='turn/start');
  assert.match(start.params.input[0].text,/Captured draft; version 7/);
  assert.match(start.params.input[0].text,/Frozen snapshot text\./);
});

test('default MCP server resolves to the tracked public plugin source',async t=>{
  const f=await fixture(t,{realAgent:true});
  const expected=resolve(WEB_ROOT,'..','plugin','scripts','talewisp_mcp.py');
  assert.equal(f.app.agent.talewispMcpPath,expected);
  assert.equal(existsSync(expected),true);
});

test('workspace catalog, scoped drafts, explicit binding, and reviewed proposals use app-owned state',async t=>{
  const f=await fixture(t,{prepare:({root,vault})=>{
    const catalog=join(root,'catalog');
    const put=(rel,text)=>{const target=join(catalog,rel);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text,'utf8');};
    put('00 Автор/Writer/Автор.md','---\ntype: author\ntitle: Writer\n---\n# Writer');
    put('00 Автор/Writer/Series/00 Паспорт/Серия.md','---\ntype: passport\ntitle: Series\n---\n# Series');
     put('00 Автор/Writer/Series/01 Книги/Book/Book.md','---\ntype: book\ntitle: Book\nbook_id: B08\n---\n# Book');
     put('00 Автор/Writer/Series/00 Источники/B08/B08-C001.md','---\ntype: note\nrecord_kind: source-chapter\nbook_id: B08\n---\n# t.0/Tab 1\n## B08-C001-P0001\nActual manuscript words here.');
    return {catalogVaultPath:catalog,pluginService:{tools:async()=>[{name:'fixture_read'}],call:async(name,args)=>({name,args}),applyAction:async row=>({applied:row.tool})}};
  }});
  await f.api('POST','/api/session',{local:true});
  const unbound=(await f.api('POST','/api/documents',{title:'Old draft',text:'Preserve my binding.'})).data.document;
  const catalog=(await f.raw('/api/workspace/catalog')).data;
  assert.equal(catalog.authors[0].name,'Writer');
  const ids={authorId:catalog.authors[0].id,seriesId:catalog.authors[0].series[0].id,bookId:catalog.authors[0].series[0].books[0].id};
  assert.equal((await f.raw('/api/documents')).data.documents.length,0);
  const selected=await f.api('POST','/api/workspace/select',ids);assert.equal(selected.response.status,200);
  assert.equal(f.app.store.messageScopeKey,scopeKey(ids));
  const draft=(await f.api('POST','/api/documents',{title:'New draft',text:'Bound text.'})).data.document;
  assert.equal(draft.seriesId,ids.seriesId);
  assert.equal((await f.raw('/api/documents')).data.documents.length,1);
  const all=(await f.raw('/api/documents?scope=all')).data.documents;
  assert.equal(all.length,2);
  const bind=await f.api('POST',`/api/documents/${unbound.id}/bind`,{version:1});assert.equal(bind.response.status,200);assert.equal(bind.data.document.bookId,ids.bookId);
  const proposal=await f.api('POST','/api/proposals',{path:null,text:'Exact author-approved draft content.',title:'Draft'});
  assert.equal(proposal.response.status,201);
  assert.equal((await f.api('POST',`/api/proposals/${proposal.data.proposal.id}/apply`,{})).response.status,400);
  const beforeApplyCount=f.app.store.listDocuments({scope:'all'}).length;
  for(const state of ['inTurn','pendingMessage']) {
    f.app.agent[state]=true;
    assert.equal((await f.api('POST',`/api/proposals/${proposal.data.proposal.id}/apply`,{confirmed:true})).response.status,409);
    assert.equal(f.app.workspaceService.proposal(proposal.data.proposal.id).state,'pending');
    assert.equal(f.app.store.listDocuments({scope:'all'}).length,beforeApplyCount,'busy apply must refuse before creating or changing documents');
    f.app.agent[state]=false;
  }
  const applied=await f.api('POST',`/api/proposals/${proposal.data.proposal.id}/apply`,{confirmed:true});
  assert.equal(applied.response.status,200);assert.equal(f.app.store.getDocument(applied.data.proposal.documentId).text,'Exact author-approved draft content.');
  const status=await f.raw('/api/workspace/overview');assert.equal(status.data.manuscripts[0].type,'source-chapter');
  const noBearer=await f.api('POST','/api/internal/agent-tool',{name:'fixture_read',arguments:{},workspaceRevision:f.app.workspaceService.revision()});
  assert.equal(noBearer.response.status,401);
});


test('StoryArt HTTP routes require a session, use the selected scope and never accept arbitrary thread IDs',async t=>{
  const calls=[];const storyArtService={list:context=>{calls.push(['list',context]);return {requests:[{requestId:'test-request-1',threadId:'owned-thread',status:'created',artifacts:[{label:'candidate.png'}]}]};},execute:async(input,context)=>{calls.push(['execute',input,context]);return input.requestId==='test-request-1'?{ok:true,hostReceipt:'actual fixture receipt'}:{ok:false,error:'No owned request'};},artifact:async()=>({ok:false,error:'No reported artifact'}),close(){}};
  const f=await fixture(t,{storyArtService});
  assert.equal((await f.raw('/api/storyart/requests')).response.status,401);assert.equal(calls.length,0);
  await f.api('POST','/api/session',{local:true});
  const listed=await f.api('GET','/api/storyart/requests');assert.equal(listed.data.requests[0].artifacts[0].url,'/api/storyart/artifact?requestId=test-request-1&index=0');assert.equal(calls[0][1].scope,scopeKey(f.app.workspaceService.selection()));
  assert.equal((await f.api('POST','/api/storyart/operation',{operation:'create',brief:'not allowed here'})).response.status,400);
  assert.equal((await f.api('POST','/api/storyart/operation',{operation:'read',requestId:'test-request-1',threadId:'unrelated'})).response.status,400);
  assert.equal((await f.api('POST','/api/storyart/operation',{operation:'read',requestId:'test-request-1'})).response.status,200);
  assert.equal((await f.api('POST','/api/storyart/operation',{operation:'send',requestId:'unowned',message:'delta'})).response.status,409);
  assert.equal((await f.api('GET','/api/storyart/artifact?requestId=test-request-1&index=0')).response.status,404);
  assert.equal((await f.api('GET','/api/storyart/artifact?requestId=test-request-1&index=-1')).response.status,400);
});

test('knowledge graph route requires session and serves only the existing workspace scope', async t=>{
  const f=await fixture(t);
  assert.equal((await f.raw('/api/knowledge/graph')).response.status,401);
  await f.api('POST','/api/session',{local:true});
  const empty=await f.raw('/api/knowledge/graph');
  assert.equal(empty.response.status,200);assert.deepEqual(empty.data.nodes,[]);
  const legacy=await f.raw('/api/knowledge/graph?scope=unassigned');
  assert.equal(legacy.response.status,200);assert.equal(legacy.data.scope,'unassigned');
  assert.equal(legacy.data.mode,'concepts');assert.deepEqual(legacy.data.nodes,[]);assert.equal(legacy.data.diagnostics.status,'unassigned');
  const invalid=await f.raw('/api/knowledge/graph?scope=../../outside');
  assert.equal(invalid.data.scope,'active');assert.deepEqual(invalid.data.nodes,[]);
});
