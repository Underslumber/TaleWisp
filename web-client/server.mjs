import { createServer } from 'node:http';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { openStore } from './store.mjs';
import { createAgentService } from './agent.mjs';
import { createWorkspaceService } from './workspace.mjs';
import { scopeKey } from './workspace-scope.mjs';
import { createImportService } from './import-service.mjs';
import { verifyImportReviewReceipt } from './import-agent-tools.mjs';
import { readDelegationHistory } from './delegation-history.mjs';
import { createNativeConsultationService } from './native-consultation.mjs';
import { createStoryArtService } from './storyart-service.mjs';
import { createStoryArtProject } from './storyart-project.mjs';
import { createPasswordAuth } from './auth.mjs';
import { chapterErrorResponse } from './google-chapters.mjs';
import { createManuscriptFiles } from './manuscript-file.mjs';
import { buildManuscriptContext } from './manuscript-context.mjs';

const HERE= fileURLToPath(new URL('.',import.meta.url));
const MAX_BODY=2_100_000;
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const loopback=address=>address==='::1'||address==='127.0.0.1'||address==='::ffff:127.0.0.1'||address?.startsWith('127.');
const normalizeClientAddress=address=>{const mapped=typeof address==='string'?address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i):null;return mapped&&isIP(mapped[1])===4?mapped[1]:address;};
const loopbackHostname=value=>{const name=String(value??'').toLowerCase().replace(/^\[|\]$/g,'');return name==='localhost'||name==='::1'||name==='::ffff:127.0.0.1'||name.startsWith('127.');};
const json=(res,status,data,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(data));};
const fail=(status,message)=>Object.assign(new Error(message),{status});
function normalizeHost(value) {
  if(typeof value!=='string'||!value||value.length>255)throw fail(400,'Invalid Host header.');
  let parsed;try{parsed=new URL(`http://${value}`);}catch{throw fail(400,'Invalid Host header.');}
  if(!parsed.hostname||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw fail(400,'Invalid Host header.');
  return parsed.host.toLowerCase();
}
const hostPort=(name,port)=>`${String(name).includes(':')&&!String(name).startsWith('[')?`[${name}]`:name}:${port}`.toLowerCase();

function equalSecret(a,b) { if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb); }
function sessionCookie(token,secure,maxAge) { return `tw_session=${token}; Path=/; HttpOnly; SameSite=Strict${Number.isInteger(maxAge)?`; Max-Age=${maxAge}`:''}${secure?'; Secure':''}`; }
function clearSessionCookie(secure) { return `tw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`; }
function parseCookies(value='') { return Object.fromEntries(value.split(';').map(s=>s.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return i<0?[part,'']:[part.slice(0,i),part.slice(i+1)];})); }

function createKnowledge(vaultPath) {
  const configured=!!vaultPath;
  const root=()=>{if(!configured)return null;try{return realpathSync(resolve(vaultPath));}catch{return null;}};
  const inside=(base,path)=>path===base||path.startsWith(base+sep);
  const starterPaths=['00 Паспорт серии.md','04 Анализ/Паспорт серии.md','04 Анализ/Мир — действующее устройство.md','04 Анализ/Магия — действующая система.md','04 Анализ/Лексический словарь.md'];
  const status=()=>{
    const base=root();if(!base)return {configured:false,name:null,starterSources:[]};
    const starterSources=starterPaths.flatMap(path=>{
      const candidate=resolve(base,path);if(!inside(base,candidate))return [];
      try{if(lstatSync(candidate).isSymbolicLink())return [];const actual=realpathSync(candidate);if(!inside(base,actual)||!statSync(actual).isFile())return [];return [{path:relative(base,actual).split(sep).join('/'),title:basename(actual,extname(actual))}];}catch{return [];}
    });
    return {configured:true,name:basename(base),starterSources};
  };
  const safeFile=(relativePath)=>{
    if(typeof relativePath!=='string'||!relativePath||relativePath.length>500||relativePath.includes('\0'))throw fail(400,'Invalid source path.');
    const base=root();if(!base)throw fail(503,'Knowledge vault is not available.');
    const candidate=resolve(base,relativePath);
    if(!inside(base,candidate))throw fail(400,'Source path is outside the configured vault.');
    let cursor=base;
    for(const segment of relative(base,candidate).split(sep).filter(Boolean)) { cursor=join(cursor,segment);const st=lstatSync(cursor);if(st.isSymbolicLink())throw fail(400,'Symbolic links are not opened.'); }
    const actual=realpathSync(candidate);if(!inside(base,actual)||!statSync(actual).isFile())throw fail(400,'Source file is outside the configured vault.');
    if(!['.md','.markdown','.txt'].includes(extname(actual).toLowerCase()))throw fail(400,'Only Markdown and text sources are supported.');
    if(statSync(actual).size>1_000_000)throw fail(413,'Source file is larger than 1 MB.');
    const text=readFileSync(actual,'utf8');return {path:relative(base,actual).split(sep).join('/'),title:basename(actual,extname(actual)),text,revision:createHash('sha256').update(text,'utf8').digest('hex')};
  };
  const search=q=>{
    const base=root();if(!base)return {files:[],configured:false,truncated:false};
    if(typeof q!=='string'||q.length>200)throw fail(400,'Search text must be at most 200 characters.');
    const terms=q.toLocaleLowerCase().split(/\s+/).filter(term=>term.length>1).slice(0,8);
    const found=[];let seen=0,total=0,truncated=false;
    const walk=(dir,depth)=>{
      if(depth>7||seen>=300||total>=12_000_000){truncated=true;return;}
      let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
      for(const entry of entries) {
        if(seen>=300||total>=12_000_000){truncated=true;return;}
        if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
        const file=join(dir,entry.name);
        if(entry.isDirectory()){walk(file,depth+1);continue;}
        if(!entry.isFile()||!['.md','.markdown','.txt'].includes(extname(entry.name).toLowerCase()))continue;
        if(seen>=300||total>=12_000_000){truncated=true;return;}
        seen++;let st;try{st=statSync(file);}catch{continue;}if(st.size>1_000_000||total+st.size>12_000_000){if(total+st.size>12_000_000)truncated=true;continue;}total+=st.size;
        let text;try{text=readFileSync(file,'utf8');}catch{continue;}
        const lower=text.toLocaleLowerCase();const score=terms.reduce((n,term)=>n+(lower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))?.length??0),0);
        if(terms.length&&score){const at=Math.max(0,lower.indexOf(terms[0])-180);found.push({path:relative(base,file).split(sep).join('/'),title:basename(file,extname(file)),excerpt:text.slice(at,at+700).trim(),score});}
      }
    };
    walk(base,0);found.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));return {files:found.slice(0,30).map(({score,...f})=>f),configured:true,truncated};
  };
  return {search,status,read:path=>{const {text,...meta}=safeFile(path);return {...meta,text};},context:path=>safeFile(path),configured:()=>!!root()};
}

function acquireLock(dataDir) {
  const lockFile=join(dataDir,'server.lock'), token=randomBytes(16).toString('hex');
  try { const fd=openSync(lockFile,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));closeSync(fd); }
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    let pid;try{pid=JSON.parse(readFileSync(lockFile,'utf8')).pid;}catch{}
    if(Number.isInteger(pid)) { try { process.kill(pid,0); throw fail(409,'Another TaleWisp Web server is already using this data directory.'); } catch(e) { if(e.status)throw e;if(e.code==='EPERM')throw fail(409,'Another TaleWisp Web server is already using this data directory.'); } }
    try{unlinkSync(lockFile);}catch{}
    const fd=openSync(lockFile,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));closeSync(fd);
  }
  return ()=>{try{const data=JSON.parse(readFileSync(lockFile,'utf8'));if(data.token===token)unlinkSync(lockFile);}catch{}};
}

export async function createApplication(options={}) {
  const dataDir=resolve(options.dataDir??process.env.TALEWISP_WEB_DATA??join(HERE,'.data'));
  const host=options.host??process.env.HOST??'127.0.0.1';
  const port=Number(options.port??process.env.PORT??8787);
  const webToken=options.webToken??process.env.TALEWISP_WEB_TOKEN??'';
  const authFile=options.authFile??process.env.TALEWISP_AUTH_FILE??'';
  const allowLocalAccess=options.allowLocalAccess===true;
  const trustedProxySecret=options.trustedProxySecret??process.env.TALEWISP_TRUSTED_PROXY_SECRET??'';
  if(typeof trustedProxySecret!=='string')throw new Error('trustedProxySecret must be a nonempty string when configured.');
  const configuredOrigin=options.origin??process.env.TALEWISP_WEB_ORIGIN??'';
  let configuredOriginUrl=null;try{if(configuredOrigin)configuredOriginUrl=new URL(configuredOrigin);}catch{throw new Error('TALEWISP_WEB_ORIGIN must be a valid absolute origin.');}
  if(configuredOriginUrl&&(!['http:','https:'].includes(configuredOriginUrl.protocol)||configuredOriginUrl.username||configuredOriginUrl.password||configuredOriginUrl.pathname!=='/'||configuredOriginUrl.search||configuredOriginUrl.hash))throw new Error('TALEWISP_WEB_ORIGIN must contain only an HTTP or HTTPS origin.');
  const publicConfiguredOrigin=!!configuredOriginUrl&&!loopbackHostname(configuredOriginUrl.hostname);
  const passwordAuth=authFile?createPasswordAuth({authFile,dataDir}):null;
  const tokenRequired=passwordAuth?false:!!webToken||publicConfiguredOrigin;
  const talewispMcpPath=resolve(options.talewispMcpPath??process.env.TALEWISP_MCP_PATH??resolve(HERE,'..','plugin','scripts','talewisp_mcp.py'));
  const pythonExecutable=options.pythonExecutable??process.env.TALEWISP_PYTHON??(process.platform==='win32'?'python':'python3');
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT must be between 0 and 65535.');
  if((!loopbackHostname(host)||publicConfiguredOrigin)&&!webToken&&!passwordAuth)throw new Error('A non-loopback HOST or public origin requires TALEWISP_WEB_TOKEN or TALEWISP_AUTH_FILE and an HTTPS reverse proxy.');
  if(publicConfiguredOrigin&&configuredOriginUrl.protocol!=='https:')throw new Error('A public TALEWISP_WEB_ORIGIN must use HTTPS.');
  if(!options.agent&&!existsSync(talewispMcpPath))throw new Error(`TaleWisp MCP server was not found at ${talewispMcpPath}; set TALEWISP_MCP_PATH to its installed path.`);
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const releaseLock=options.lock===false?()=>{}:acquireLock(dataDir);
  const store=options.store??openStore(dataDir);
  const manuscriptFiles=createManuscriptFiles(dataDir);
  const storyArtService=options.storyArtService??(options.agent?null:createStoryArtService({store}));
  const catalogVaultPath=options.catalogVaultPath??process.env.TALEWISP_CATALOG_VAULT??(options.vaultPath?resolve(options.vaultPath):resolve(HERE,'..','vault'));
  const importService=options.importService??createImportService({dataDir,pythonExecutable,projectRoot:resolve(HERE,'..'),catalogRoot:catalogVaultPath,
    reviewReceiptVerifier:input=>verifyImportReviewReceipt({...input,history:readDelegationHistory(store,`import:${input.jobId}`)})});
  const nativeConsultationService=options.nativeConsultationService??createNativeConsultationService({dataDir,pythonExecutable,...(options.nativeConsultationAdapterPath?{adapterPath:options.nativeConsultationAdapterPath}:{})});
  const vaultPath=resolve(options.vaultPath??process.env.TALEWISP_VAULT??store.getSetting('knowledge.vaultPath')??resolve(HERE,'..','vault'));
  let knowledge=createKnowledge(vaultPath);
  const agentToken=randomBytes(32).toString('base64url');
  let internalToolUrl=`http://127.0.0.1:${port}/api/internal/agent-tool`;
  let agent=null;
  const workspaceService=createWorkspaceService({catalogVaultPath:options.catalogVaultPath??process.env.TALEWISP_CATALOG_VAULT??(options.vaultPath?resolve(options.vaultPath):resolve(HERE,'..','vault')),initialVaultPath:vaultPath,store,dataDir,isAgentRunning:()=>!!agent?.inTurn,isAgentBusy:()=>!!(agent?.inTurn||agent?.pendingMessage),onSelect:async workspace=>{if(typeof agent?.setWorkspace==='function')await agent.setWorkspace(workspace);else store.setMessageScope(scopeKey(workspace.selection));knowledge=createKnowledge(workspace.vaultPath??null);},onDetach:()=>{knowledge=createKnowledge(null);}});
  if(workspaceService.selection())store.setMessageScope(scopeKey(workspaceService.selection()));
  const storyArtProject=options.storyArtProject??createStoryArtProject({projectPath:options.storyArtProjectPath??storyArtService?.projectPath??'D:\\Projects\\StoryArt',dataDir,store,partner:storyArtService,currentRevision:()=>workspaceService.revision()});
  let pluginService=options.pluginService??null;
  if(!pluginService&&existsSync(join(HERE,'plugin-service.mjs'))){const pluginModule=await import('./plugin-service.mjs');pluginService=await pluginModule.createPluginService({workspaceService,dataDir,pythonExecutable,talewispMcpPath});}
  if(pluginService?.tools)workspaceService.setToolsProvider(()=>pluginService.tools());
  // A selected book without a vault knowledge base must not fall back to the startup vault.
  agent=options.agent??createAgentService({dataDir,store,vaultPath:workspaceService.selection()?workspaceService.root():vaultPath,talewispMcpPath,pythonExecutable,sourceReader:path=>knowledge.context(path),workspaceService,pluginService,importService,nativeConsultationService,storyArtService,internalToolUrl,internalToolToken:agentToken});
  if(workspaceService.selection()) { const selection=workspaceService.selection();knowledge=createKnowledge(workspaceService.root());await agent.setWorkspace?.({vaultPath:workspaceService.root(),selection,revision:workspaceService.revision()}); }
  if(pluginService?.applyAction)workspaceService.setActionApplier(proposal=>pluginService.applyAction(proposal));
  let googleOwnerId=store.getSetting('google.ownerId');
  if(typeof googleOwnerId!=='string'||!googleOwnerId){googleOwnerId=randomBytes(32).toString('hex');store.setSetting('google.ownerId',googleOwnerId);}
  let google=options.googleService??null;
  if(!google)try{const mod=await import('./google.mjs');google=mod.createGoogleService({dataDir,origin:()=>trustedBaseOrigin(),ownerId:googleOwnerId});}catch(error){google={status:()=>({configured:false,authenticated:false,reason:'Google connection is not configured.',redirectUri:`${configuredOrigin||`http://${host}:${port}`}/api/google/callback`,requiresClientConfiguration:true}),configure:async()=>{throw fail(503,'Google OAuth setup is unavailable.');},beginLogin:async()=>{throw new Error('Google connection is not configured.');},callback:async()=>{throw new Error('Google connection is not configured.');},disconnect:async()=>({disconnected:true}),readDocument:async()=>{throw new Error('Google connection is not configured.');},suggest:async()=>{throw new Error('Google connection is not configured.');},comment:async()=>{throw new Error('Google connection is not configured.');},reconcileOperation:async()=>{throw fail(503,'Google reconciliation is unavailable.');},loadError:error.message};}
  let googleAgent=options.googleAgentService??null;
  if(!googleAgent)try{const mod=await import('./google.mjs');googleAgent=mod.createGoogleService({dataDir,origin:()=>trustedBaseOrigin(),ownerId:googleOwnerId,credentialNamespace:'agent',callbackPath:'/api/google/agent/callback'});}catch(error){googleAgent={status:()=>({configured:false,authenticated:false,reason:'Google agent connection is not configured.',redirectUri:`${configuredOrigin||`http://${host}:${port}`}/api/google/agent/callback`,requiresClientConfiguration:true}),configure:async()=>{throw fail(503,'Google agent OAuth setup is unavailable.');},beginLogin:async()=>{throw new Error('Google agent connection is not configured.');},callback:async()=>{throw new Error('Google agent connection is not configured.');},disconnect:async()=>({disconnected:true}),readDocument:async()=>{throw new Error('Google agent connection is not configured.');},suggest:async()=>{throw new Error('Google agent connection is not configured.');},comment:async()=>{throw new Error('Google agent connection is not configured.');},reconcileOperation:async()=>{throw fail(503,'Google agent reconciliation is unavailable.');},loadError:error.message};}
  pluginService?.setGoogleService?.(googleAgent);
  const sessions=new Map();const clients=new Set();let closing=false;let closePromise=null;
  const expireSessions=()=>{const t=Date.now();for(const [key,exp] of sessions)if(exp<t)sessions.delete(key);};
  const agentEvent=event=>{for(const res of clients)if(!res.destroyed)res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);};
  agent.on?.('event',agentEvent);
  const expectedOrigin=url=>configuredOriginUrl?configuredOriginUrl.origin:url.origin;
  const isTrustedLocal=req=>loopback(req.socket.remoteAddress);
  const clientAddress=req=>{
    const peer=req.socket.remoteAddress, forwarded=req.headers['x-talewisp-client-ip'];
    if(trustedProxySecret&&isTrustedLocal(req)&&typeof forwarded==='string'&&isIP(forwarded)!==0&&equalSecret(req.headers['x-talewisp-proxy-secret'],trustedProxySecret))return normalizeClientAddress(forwarded);
    return normalizeClientAddress(peer);
  };
  const localAccessHost=req=>{
    if(!allowLocalAccess||!loopbackHostname(host))return false;
    try{return normalizeHost(req.headers.host)===hostPort('127.0.0.1',server.listening?server.address().port:port);}catch{return false;}
  };
  const localAccessRequest=(req,url)=>localAccessHost(req)&&isTrustedLocal(req)&&url.protocol==='http:';
  const allowedHosts=()=>{
    const actualPort=server.listening?server.address().port:port;
    const accepted=new Set([hostPort(host,actualPort)]);
    accepted.add(hostPort('127.0.0.1',actualPort));
    if(loopbackHostname(host))for(const localName of ['127.0.0.1','localhost','::1'])accepted.add(hostPort(localName,actualPort));
    if(configuredOriginUrl)accepted.add(configuredOriginUrl.host.toLowerCase());
    return accepted;
  };
  const trustedBaseOrigin=()=>configuredOriginUrl?.origin??`http://${hostPort(host,server.listening?server.address().port:port)}`;
  const checkOrigin=(req,url)=>{
    const value=req.headers.origin;if(!value)throw fail(403,'A same-origin request is required.');
    let origin;try{origin=new URL(value);}catch{throw fail(403,'Invalid request origin.');}
    if(localAccessHost(req)) {
      const expected=`http://${hostPort('127.0.0.1',server.listening?server.address().port:port)}`;
      if(!isTrustedLocal(req)||url.protocol!=='http:'||origin.origin!==expected||origin.host!==normalizeHost(req.headers.host))throw fail(403,'Cross-origin request blocked.');
      return;
    }
    if(origin.origin!==expectedOrigin(url))throw fail(403,'Cross-origin request blocked.');
    if(!configuredOriginUrl && origin.host!==normalizeHost(req.headers.host))throw fail(403,'Cross-origin request blocked.');
  };
  const checkAuth=(req,url,body)=>{
    if(passwordAuth) { const token=parseCookies(req.headers.cookie).tw_session; if(passwordAuth.valid(token))return true; throw fail(401,'Sign in to the TaleWisp workspace.'); }
    expireSessions(); const cookie=parseCookies(req.headers.cookie).tw_session;
    if(cookie&&sessions.has(cookie))return true;
    if(webToken&&body&&equalSecret(body.token,webToken)){const token=randomBytes(32).toString('base64url');sessions.set(token,Date.now()+43_200_000);return token;}
    if(body?.local===true&&!tokenRequired&&isTrustedLocal(req)){checkOrigin(req,url);const token=randomBytes(32).toString('base64url');sessions.set(token,Date.now()+43_200_000);return token;}
    throw fail(401,'Sign in to the local TaleWisp client.');
  };
  const bodyOf=async (req,maxBytes=MAX_BODY)=>{
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw fail(413,'Request body is too large.');chunks.push(chunk);}
    if(!size)return {};try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw fail(400,'Request body must be a JSON object.');}
  };
  // Main manuscript: an app-metadata binding from a stable book ID to one of its live Google attachments.
  const manuscriptKey=bookId=>`manuscript.binding.${bookId}`;
  const activeBookId=()=>workspaceService.selection()?.bookId??null;
  const manuscriptCandidates=bookId=>(workspaceService.project.view().attachments??[]).filter(item=>item.bookId===bookId&&typeof item.googleDocumentId==='string'&&item.googleDocumentId&&!item.archivedAt).map(item=>({attachmentId:item.id,name:item.name,kind:item.kind,googleDocumentId:item.googleDocumentId}));
  const readManuscriptBinding=bookId=>{let value=null;try{value=JSON.parse(store.getSetting(manuscriptKey(bookId))||'null');}catch{value=null;}return value&&typeof value.attachmentId==='string'&&typeof value.documentId==='string'?value:null;};
  const requireActiveBook=bookId=>{
    if(typeof bookId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(bookId))throw Object.assign(fail(400,'Нужна открытая книга.'),{code:'book_required'});
    if(activeBookId()!==bookId)throw Object.assign(fail(409,'Открыта другая книга. Выберите книгу заново.'),{code:'book_changed'});
    return bookId;
  };
  const requireManuscript=bookId=>{
    requireActiveBook(bookId);
    const binding=readManuscriptBinding(bookId);
    if(!binding)throw Object.assign(fail(409,'Основная рукопись для этой книги ещё не выбрана.'),{code:'manuscript_not_selected'});
    const candidate=manuscriptCandidates(bookId).find(item=>item.attachmentId===binding.attachmentId);
    if(!candidate||candidate.googleDocumentId!==binding.documentId)throw Object.assign(fail(409,'Выбранный основной файл больше не связан с книгой. Выберите основную рукопись заново.'),{code:'manuscript_binding_stale'});
    return {binding,candidate};
  };
  const chapterSnapshotOf=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'Контекст главы передан в неверном формате.');
    const {binding,candidate}=requireManuscript(value.bookId);
    if(value.documentId!==binding.documentId)throw Object.assign(fail(409,'Глава относится к другой рукописи. Обновите оглавление.'),{code:'manuscript_changed'});
    for(const key of ['sectionId','revisionId','tabTitle'])if(typeof value[key]!=='string'||value[key].length>400)throw fail(400,'Контекст главы передан в неверном формате.');
    if(typeof value.title!=='string'||value.title.length>400||typeof value.text!=='string'||value.text.length>200_000||typeof value.edited!=='boolean')throw fail(400,'Глава слишком большая или передана в неверном формате.');
    return {bookId:value.bookId,documentId:binding.documentId,documentName:candidate.name,sectionId:value.sectionId,revisionId:value.revisionId,tabTitle:value.tabTitle,title:value.title,text:value.text,edited:value.edited};
  };
  const server=createServer(async(req,res)=>{
    let requestHost,url;
    try {
      requestHost=normalizeHost(req.headers.host);
      if(!allowedHosts().has(requestHost))throw fail(400,'Unrecognized Host header.');
      if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))throw fail(400,'Invalid request target.');
      url=new URL(req.url,`http://${requestHost}`);
    } catch(error) { return json(res,Number.isInteger(error.status)?error.status:400,{error:error.message}); }
    try {
      if(closing)throw fail(503,'TaleWisp Web is shutting down.');
      if(!url.pathname.startsWith('/api/')) { await staticFile(req,res,url.pathname); return; }
      if(req.method==='GET'&&url.pathname==='/api/bootstrap') {const cookie=parseCookies(req.headers.cookie).tw_session;const authenticated=passwordAuth?passwordAuth.valid(cookie):!!sessions.get(cookie);return json(res,200,{local:!passwordAuth&&isTrustedLocal(req)&&!tokenRequired,authenticated,authMode:passwordAuth?'password':webToken?'token':'local',...(passwordAuth?{username:passwordAuth.username}:{})});}
      if(req.method==='POST'&&url.pathname==='/api/session') {
        const body=await bodyOf(req);checkOrigin(req,url);
        if(passwordAuth) {
          if(Object.keys(body).some(key=>!['username','password','remember'].includes(key))||typeof body.username!=='string'||typeof body.password!=='string'||typeof body.remember!=='boolean')throw fail(400,'A username, password, and remember choice are required.');
          passwordAuth.authenticate(body.username,body.password,clientAddress(req));
          const session=passwordAuth.issue(body.remember),secure=!localAccessRequest(req,url)&&(configuredOriginUrl?.protocol==='https:'||url.protocol==='https:');
          return json(res,200,{authenticated:true},{'set-cookie':sessionCookie(session.token,secure,session.remembered?Math.floor(passwordAuth.rememberMs/1000):undefined)});
        }
        const token=checkAuth(req,url,body);if(token===true)throw fail(401,'Session already authenticated.');return json(res,200,{authenticated:true},{'set-cookie':sessionCookie(token,url.protocol==='https:',43_200)});
      }
      if(req.method==='POST'&&url.pathname==='/api/logout') {
        checkOrigin(req,url);const token=parseCookies(req.headers.cookie).tw_session;
        if(passwordAuth)passwordAuth.revoke(token);else sessions.delete(token);
        const secure=!localAccessRequest(req,url)&&(passwordAuth?configuredOriginUrl?.protocol==='https:'||url.protocol==='https:':url.protocol==='https:');
        return json(res,200,{loggedOut:true},{'set-cookie':clearSessionCookie(secure)});
      }
      if(req.method==='GET'&&url.pathname==='/api/google/callback') {const result=await google.callback(new URL(url.pathname+url.search,trustedBaseOrigin()).href);return json(res,200,result??{ok:true});}
      if(req.method==='GET'&&url.pathname==='/api/google/agent/callback') {const result=await googleAgent.callback(new URL(url.pathname+url.search,trustedBaseOrigin()).href);return json(res,200,result??{ok:true});}
      let body={};if(!['GET','HEAD'].includes(req.method)) {checkOrigin(req,url);body=await bodyOf(req,url.pathname==='/api/storyart/uploads'?28_000_000:url.pathname==='/api/manuscript/working/save'?40_000_000:/^\/api\/imports\/[a-f0-9-]{36}\/sources$/.test(url.pathname)?7_500_000:MAX_BODY);if(closing)throw fail(503,'TaleWisp Web is shutting down.');}
      if(req.method==='POST'&&url.pathname==='/api/internal/agent-tool') {
        if(!isTrustedLocal(req)||!equalSecret(req.headers.authorization?.replace(/^Bearer\s+/i,''),agentToken))throw fail(401,'Private agent bridge authentication failed.');
        const bridgeOrigin=req.headers.origin;if(typeof bridgeOrigin!=='string'||bridgeOrigin!==new URL(internalToolUrl).origin)throw fail(403,'Private agent bridge origin is invalid.');
        if(!pluginService)throw fail(503,'TaleWisp plugin service is unavailable.');
        if(body.workspaceRevision!==workspaceService.revision())throw fail(409,'Workspace changed before the tool call.');
        if(body.name==='__list_tools')return json(res,200,{tools:await pluginService.tools()});
        if(typeof body.name!=='string'||!body.name||!body.arguments||typeof body.arguments!=='object')throw fail(400,'A valid TaleWisp tool call is required.');
        return json(res,200,await pluginService.call(body.name,body.arguments,body.workspaceRevision));
      }
      const publicPost=req.method==='POST'&&url.pathname==='/api/session';
      if(!publicPost)checkAuth(req,url,body);
      if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{app:{name:'TaleWisp Web',version:'0.1.0',local:isTrustedLocal(req)},agent:agent.status(),google:await google.status(),googleAgent:await googleAgent.status(),version:'0.1.0'});
      if(req.method==='GET'&&url.pathname==='/api/workspace/catalog')return json(res,200,workspaceService.catalog());
      if(req.method==='POST'&&url.pathname==='/api/workspace/select')return json(res,200,await workspaceService.select(body));
      if(req.method==='GET'&&url.pathname==='/api/workspace/overview')return json(res,200,await workspaceService.overview());
      if(req.method==='GET'&&url.pathname==='/api/project')return json(res,200,workspaceService.project.view());
      if(req.method==='GET'&&url.pathname==='/api/project/sources')return json(res,200,workspaceService.project.sources(url.searchParams.get('bookId')??''));
      if(req.method==='POST'&&url.pathname==='/api/project/authors')return json(res,201,await workspaceService.project.createAuthor(body));
      if(req.method==='POST'&&url.pathname==='/api/project/series')return json(res,201,await workspaceService.project.createSeries(body));
      if(req.method==='POST'&&url.pathname==='/api/project/books')return json(res,201,await workspaceService.project.createBook(body));
      if(req.method==='POST'&&url.pathname==='/api/project/attachments')return json(res,201,await workspaceService.project.attach(body));
      const attachmentSourceRoute=req.method==='GET'&&url.pathname.match(/^\/api\/project\/attachments\/([A-Za-z0-9_-]{1,80})\/source$/);
      if(attachmentSourceRoute)return json(res,200,workspaceService.project.attachmentSource(attachmentSourceRoute[1]));
      const projectRoute=url.pathname.match(/^\/api\/project\/(authors|series|books|attachments)\/([A-Za-z0-9_-]{1,80})(?:\/(archive|restore))?$/);
      if(projectRoute&&req.method==='POST'){
        const [,kind,id,action]=projectRoute,project=workspaceService.project;
        if(action&&kind!=='attachments')throw fail(404,'Not found.');
        if(action==='archive')return json(res,200,await project.archiveAttachment(id,body));
        if(action==='restore')return json(res,200,await project.restoreAttachment(id,body));
        const update={authors:project.updateAuthor,series:project.updateSeries,books:project.updateBook,attachments:project.updateAttachment}[kind];
        return json(res,200,await update(id,body));
      }
      if(req.method==='GET'&&url.pathname==='/api/imports')return json(res,200,await importService.list());
      if(req.method==='POST'&&url.pathname==='/api/imports')return json(res,201,await importService.create({authorPseudonym:body.authorPseudonym,seriesName:body.seriesName}));
      const importRoute=url.pathname.match(/^\/api\/imports\/([a-f0-9-]{36})(?:\/(sources|publish))?$/i);
      if(importRoute){
        const jobId=importRoute[1];
        if(req.method==='GET'&&!importRoute[2])return json(res,200,await importService.status(jobId));
        if(req.method==='POST'&&importRoute[2]==='sources')return json(res,201,await importService.upload({jobId,name:body.name,contentBase64:body.contentBase64,sourceKind:body.sourceKind}));
        if(req.method==='POST'&&importRoute[2]==='publish'){
          if(body.confirmed!==true)throw fail(400,'Сначала подтвердите показанный состав новой базы.');
          if(agent.inTurn||agent.pendingMessage)throw fail(409,'Дождитесь завершения работы агента перед подключением новой базы.');
          const job=await importService.status(jobId);
          const published=await importService.publish({jobId,confirmed:body.confirmed});
          const imported=workspaceService.locateVaultSeries(job.authorPseudonym,job.seriesName);
          const selection=imported?await workspaceService.select(imported):null;
          return json(res,200,{...published,catalog:workspaceService.catalog(),selection});
        }
      }
      if(req.method==='GET'&&url.pathname==='/api/documents'){
        const all=store.listDocuments(),documents=url.searchParams.get('scope')==='all'?all:all.filter(workspaceService.scopeFilter);
        return json(res,200,{documents});
      }
      if(req.method==='POST'&&url.pathname==='/api/documents')return json(res,201,{document:store.createDocument({...body,...(workspaceService.selection()??{})})});
      let match=url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)$/i);
      if(match&&req.method==='GET'){const document=store.getDocument(match[1]);if(!document)throw fail(404,'Draft not found.');return json(res,200,{document});}
      if(match&&req.method==='PUT'){const result=store.updateDocument(match[1],body);if(!result)throw fail(404,'Draft not found.');if(result.conflict)throw fail(409,'Draft changed in another session. Reload it before saving.');return json(res,200,{document:result.document});}
      match=url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)\/bind$/i);
      if(match&&req.method==='POST'){const current=store.getDocument(match[1]),selected=workspaceService.selection();if(!current)throw fail(404,'Draft not found.');if(!selected)throw fail(409,'Select an author, series and book first.');const result=store.bindDocument(match[1],{...selected,version:body.version});if(result.conflict)throw fail(409,'Draft changed in another session. Reload it before binding.');return json(res,200,{document:result.document});}
      match=url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)\/history$/i);
      if(match&&req.method==='GET')return json(res,200,{versions:store.documentHistory(match[1])});
      match=url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)\/restore$/i);
      if(match&&req.method==='POST'){const result=store.restoreDocument(match[1],body.historyId,body.version);if(!result)throw fail(404,'Draft not found.');if(result.conflict)throw fail(409,'Draft changed in another session. Reload it before restoring.');if(result.missing)throw fail(404,'History version not found.');return json(res,200,{document:result.document});}
      if(req.method==='GET'&&url.pathname==='/api/notes'){const all=store.listNotes(),notes=url.searchParams.get('scope')==='all'?all:all.filter(workspaceService.scopeFilter);return json(res,200,{notes});}
      if(req.method==='POST'&&url.pathname==='/api/notes')return json(res,201,{note:store.createNote({...body,...(workspaceService.selection()??{})})});
      match=url.pathname.match(/^\/api\/notes\/([a-f0-9-]+)$/i);
      if(match&&req.method==='PUT'){const result=store.updateNote(match[1],body);if(!result)throw fail(404,'Note not found.');if(result.conflict)throw fail(409,'Note changed in another session. Reload it before saving.');return json(res,200,{note:result.note});}
      if(req.method==='GET'&&url.pathname==='/api/knowledge')return json(res,200,knowledge.search(url.searchParams.get('q')??''));
      if(req.method==='GET'&&url.pathname==='/api/knowledge/status')return json(res,200,knowledge.status());
      if(req.method==='GET'&&url.pathname==='/api/knowledge/file'){const file=knowledge.read(url.searchParams.get('path')??'');return json(res,200,file);}
      if(req.method==='GET'&&url.pathname==='/api/knowledge/cards')return json(res,200,workspaceService.cards({type:url.searchParams.get('type')??'',q:url.searchParams.get('q')??'',scope:url.searchParams.get('scope')??''}));
      if(req.method==='GET'&&url.pathname==='/api/knowledge/graph')return json(res,200,workspaceService.graph({scope:url.searchParams.get('scope')??'active'}));
      if(req.method==='GET'&&url.pathname==='/api/knowledge/card')return json(res,200,workspaceService.card(url.searchParams.get('path')??'',url.searchParams.get('scope')??''));
      if(req.method==='GET'&&url.pathname==='/api/proposals')return json(res,200,{proposals:workspaceService.listProposals()});
      if(req.method==='POST'&&url.pathname==='/api/proposals')return json(res,201,{proposal:workspaceService.prepareProposal(body)});
      match=url.pathname.match(/^\/api\/proposals\/([a-f0-9-]+)$/i);
      if(match&&req.method==='GET'){const item=workspaceService.proposal(match[1]);if(!item)throw fail(404,'Proposal not found.');return json(res,200,{proposal:item});}
      match=url.pathname.match(/^\/api\/proposals\/([a-f0-9-]+)\/(apply|reject)$/i);
      if(match&&req.method==='POST'){
        if(match[2]==='apply'){if(agent.inTurn||agent.pendingMessage)throw fail(409,'Дождитесь завершения работы агента перед применением правки.');if(body.confirmed!==true)throw fail(400,'Explicit confirmation of this saved proposal is required.');const item=workspaceService.proposal(match[1]);if(!item)throw fail(404,'Proposal not found.');const result=item.tool?await workspaceService.applyAction(match[1]):workspaceService.applyProposal(match[1]);if(result.state==='applied')await agent.setWorkspace?.({vaultPath:workspaceService.root(),selection:workspaceService.selection(),revision:workspaceService.revision()});return json(res,200,{proposal:result});}
        return json(res,200,{proposal:workspaceService.rejectProposal(match[1])});
      }
      if(req.method==='GET'&&url.pathname==='/api/agent/status'){await agent.refreshNativeConsultationStatus?.();return json(res,200,agent.status());}
      if(req.method==='POST'&&url.pathname==='/api/agent/conversations/create')return json(res,200,agent.createConversation());
      if(req.method==='POST'&&url.pathname==='/api/agent/conversations/activate')return json(res,200,agent.activateConversation(body.id));
      match=url.pathname.match(/^\/api\/agent\/conversations\/([a-f0-9-]+)\/(archive|restore)$/i);
      if(match&&req.method==='POST')return json(res,200,match[2]==='archive'?agent.archiveConversation(match[1]):agent.restoreConversation(match[1]));
      const detachedAgent=()=>{const context=workspaceService.agentContext?.();if(context?.status==='detached')throw Object.assign(fail(409,'Агент не подключён к открытой книге: '+context.error+' Выберите книгу заново.'),{code:'workspace_detached'});};
      if(req.method==='GET'&&url.pathname==='/api/workspace/delegations')return json(res,200,workspaceService.delegationHistory());
      if(req.method==='POST'&&url.pathname==='/api/agent/connect'){detachedAgent();return json(res,200,await agent.connect());}
      if(req.method==='POST'&&url.pathname==='/api/agent/login'){
        if(Object.hasOwn(body,'apiKey')||body.type==='apiKey')throw fail(400,'API-key authentication is disabled. Use ChatGPT sign-in.');
        const method=body.method??'browser';
        if(!['browser','device'].includes(method))throw fail(400,'Login method must be browser or device.');
        return json(res,200,await agent.login({method}));
      }
      if(req.method==='POST'&&url.pathname==='/api/agent/message'){
        if(body.importJobId===undefined)detachedAgent();
        if(body.importJobId!==undefined){
          if(body.mode!=='series_base'||typeof body.importJobId!=='string')throw fail(400,'Импорт требует режима создания базы и действительного задания.');
          const job=await importService.status(body.importJobId);
          body={...body,importJobContext:{jobId:job.jobId,authorPseudonym:job.authorPseudonym,seriesName:job.seriesName,status:job.status}};
        }
        if(body.manuscriptContext!==undefined)throw fail(400,'Контекст рукописи формирует сервер.');
        if(body.manuscriptChapter!==undefined||body.manuscriptChapters!==undefined){
          if(body.importJobId!==undefined||(body.documentId!==undefined&&body.documentId!==null))throw fail(400,'Глава рукописи передаётся агенту отдельно от черновика и импорта.');
          if(body.manuscriptChapter!==undefined&&body.manuscriptChapters!==undefined)throw fail(400,'Передайте один список глав.');
          const {manuscriptChapter,manuscriptChapters,...rest}=body;
          const snapshots=manuscriptChapters??[manuscriptChapter];
          if(!Array.isArray(snapshots)||snapshots.length<1||snapshots.length>40)throw fail(400,'Выберите от одной до 40 глав.');
          const chapters=snapshots.map(chapterSnapshotOf);
          if(typeof rest.text!=='string'||!rest.text.trim())throw fail(400,'Напишите сообщение агенту.');
          const selected=typeof rest.selectedText==='string'&&rest.selectedText?rest.selectedText:'';
          body={...rest,manuscriptContext:buildManuscriptContext(chapters,selected)};
        }
        if(body.documentId!==undefined&&body.documentId!==null) {
          if(typeof body.documentId!=='string'||!body.documentId)throw fail(400,'A valid documentId is required.');
          if(!Number.isSafeInteger(body.documentVersion)||body.documentVersion<1)throw fail(400,'A documentVersion is required for a document-bound message.');
          const snapshot=store.getDocument(body.documentId);
          if(!snapshot)throw fail(404,'Draft not found.');
          if(snapshot.version!==body.documentVersion)throw fail(409,'Draft changed before the message was staged. Reload it before retrying.');
          const selected=workspaceService.selection();
          if(!selected)throw fail(409,'Select the draft workspace or bind this unassigned draft before using it with the agent.');
          if(snapshot.authorId!==selected.authorId||snapshot.seriesId!==selected.seriesId||snapshot.bookId!==selected.bookId)throw fail(409,'This draft belongs to another author, series or book. Switch to that workspace or explicitly bind the draft before using it with the agent.');
          body={...body,documentSnapshot:{id:snapshot.id,title:snapshot.title,version:snapshot.version,text:snapshot.text}};
        }
        return json(res,202,await agent.message(body));
      }
      if(req.method==='POST'&&url.pathname==='/api/agent/stop')return json(res,200,await agent.stop());
      if(req.method==='GET'&&url.pathname==='/api/events'){
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});res.write(': connected\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
      }
      if(url.pathname.startsWith('/api/storyart/')) {
        const context={scope:scopeKey(workspaceService.selection()),workspaceRevision:workspaceService.revision()};
        const selection=workspaceService.selection();
        const clientScope=selection?[selection.authorId||'',selection.seriesId||'',selection.bookId||''].join('/'):'';
        const scopedRoute=/^\/api\/storyart\/(?:project$|styles\/|jobs(?:\/|$)|references(?:\/|$))/.test(url.pathname)||(url.pathname==='/api/storyart/uploads'&&req.method==='POST');
        if(scopedRoute&&req.headers['x-storyart-scope']!==clientScope)throw Object.assign(fail(409,'Рабочая область изменилась. Выберите актуальную книгу.'),{code:'scope_changed'});
        const studioJson=(status,result)=>json(res,status,{...result,clientScope});
        const sendImage=artifact=>{res.writeHead(200,{'content-type':artifact.mimeType,'content-length':artifact.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(artifact.bytes);};
        if(req.method==='GET'&&url.pathname==='/api/storyart/references')return studioJson(200,{...await storyArtProject.referenceLibrary.catalog(Object.fromEntries(url.searchParams)),workspaceRevision:context.workspaceRevision});
        if(req.method==='GET'&&url.pathname==='/api/storyart/reference-image')return sendImage(await storyArtProject.referenceLibrary.image(Object.fromEntries(url.searchParams)));
        if(req.method==='POST'&&url.pathname==='/api/storyart/references/plans')return studioJson(201,{plan:await storyArtProject.referenceLibrary.create(body,context),workspaceRevision:context.workspaceRevision});
        const referencePlanMatch=url.pathname.match(/^\/api\/storyart\/references\/plans\/([a-f0-9-]{36})(\/regenerate)?$/);
        if(req.method==='GET'&&referencePlanMatch&&!referencePlanMatch[2])return studioJson(200,{plan:await storyArtProject.referenceLibrary.get(referencePlanMatch[1],context),workspaceRevision:context.workspaceRevision});
        if(req.method==='POST'&&referencePlanMatch)return studioJson(200,{plan:await storyArtProject.referenceLibrary[referencePlanMatch[2]?'regenerate':'update'](referencePlanMatch[1],body,context),workspaceRevision:context.workspaceRevision});
        if(req.method==='GET'&&url.pathname==='/api/storyart/project')return studioJson(200,await storyArtProject.catalog(context));
        const styleMatch=url.pathname.match(/^\/api\/storyart\/styles\/([A-Za-z0-9_-]{1,100})$/);
        if(req.method==='GET'&&styleMatch)return studioJson(200,{...await storyArtProject.style(styleMatch[1]),workspaceRevision:context.workspaceRevision});
        const characterMatch=url.pathname.match(/^\/api\/storyart\/styles\/([A-Za-z0-9_-]{1,100})\/characters\/([A-Za-z0-9_-]{1,100})$/);
        if(req.method==='GET'&&characterMatch)return studioJson(200,{...await storyArtProject.character(characterMatch[1],characterMatch[2]),workspaceRevision:context.workspaceRevision});
        if(req.method==='GET'&&url.pathname==='/api/storyart/character-image')return sendImage(await storyArtProject.characterImage(url.searchParams.get('styleId'),url.searchParams.get('characterId'),url.searchParams.get('assetId')));
        if(req.method==='GET'&&url.pathname==='/api/storyart/library-image')return sendImage(await storyArtProject.libraryImage(url.searchParams.get('styleId'),url.searchParams.get('referenceId'),url.searchParams.get('sha256')||''));
        if(req.method==='POST'&&url.pathname==='/api/storyart/uploads')return studioJson(201,await storyArtProject.upload(body,context));
        const uploadMatch=url.pathname.match(/^\/api\/storyart\/uploads\/([a-f0-9-]{36})$/);
        if(req.method==='GET'&&uploadMatch)return sendImage(await storyArtProject.uploadImage(uploadMatch[1],context));
        if(req.method==='GET'&&url.pathname==='/api/storyart/jobs')return studioJson(200,storyArtProject.jobs(context));
        if(req.method==='POST'&&url.pathname==='/api/storyart/jobs')return studioJson(202,await storyArtProject.createJob(body,context));
        const jobMatch=url.pathname.match(/^\/api\/storyart\/jobs\/([\w.-]{8,100})(\/action)?$/);
        if(req.method==='GET'&&jobMatch&&!jobMatch[2])return studioJson(200,await storyArtProject.job(jobMatch[1],context));
        if(req.method==='POST'&&jobMatch?.[2])return studioJson(200,await storyArtProject.action(jobMatch[1],body,context));
      }
      if(req.method==='GET'&&url.pathname==='/api/storyart/requests') {
        if(!storyArtService)return json(res,200,{requests:[]});
        return json(res,200,{requests:storyArtService.list({scope:scopeKey(workspaceService.selection())}).requests.map(item=>({...item,artifacts:(item.artifacts??[]).map((artifact,index)=>({index,label:artifact.label,sha256:artifact.sha256,url:`/api/storyart/artifact?requestId=${encodeURIComponent(item.requestId)}&index=${index}`}))}))});
      }
      if(req.method==='POST'&&url.pathname==='/api/storyart/operation') {
        if(!storyArtService)throw fail(503,'StoryArt desktop host is unavailable.');
        if(!['send','read','wait'].includes(body.operation)||Object.keys(body).some(key=>!['operation','requestId','message'].includes(key)))throw fail(400,'Use an existing owned StoryArt request.');
        const result=await storyArtService.execute(body,{mode:'storyart',scope:scopeKey(workspaceService.selection()),workspaceRevision:workspaceService.revision()});if(result.ok!==true)throw fail(409,result.error??'StoryArt operation was not confirmed.');return json(res,200,result);
      }
      if(req.method==='GET'&&url.pathname==='/api/storyart/artifact') {
        if(!storyArtService)throw fail(503,'StoryArt desktop host is unavailable.');
        const raw=url.searchParams.get('index')??'0';if(!/^\d{1,2}$/.test(raw))throw fail(400,'Invalid artifact index.');
        const artifact=await storyArtService.artifact({requestId:url.searchParams.get('requestId'),index:Number(raw)},{scope:scopeKey(workspaceService.selection())});
        if(artifact.ok!==true)throw fail(404,artifact.error??'StoryArt artifact is unavailable.');
        const expectedArtifactHash=url.searchParams.get('sha256');
        if(expectedArtifactHash&&expectedArtifactHash!==artifact.sha256)throw Object.assign(fail(409,'Кандидат изменился после просмотра.'),{code:'artifact_changed'});
        res.writeHead(200,{'content-type':artifact.mimeType,'content-length':artifact.bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(artifact.bytes);
      }
      if(req.method==='GET'&&url.pathname==='/api/google/status'){const status=await google.status();return json(res,200,{...status,redirectUri:status.redirectUri??`${trustedBaseOrigin()}/api/google/callback`,requiresClientConfiguration:status.requiresClientConfiguration??!status.configured});}
      if(req.method==='GET'&&url.pathname==='/api/google/agent/status'){const status=await googleAgent.status();let capabilities=null;try{capabilities=await googleAgent.capabilities?.()??null;}catch{}return json(res,200,{...status,canReadSheets:capabilities?.canReadSheets===true,canWriteSheets:capabilities?.canWriteSheets===true,canReply:capabilities?.canReply===true,redirectUri:status.redirectUri??`${trustedBaseOrigin()}/api/google/agent/callback`,requiresClientConfiguration:status.requiresClientConfiguration??!status.configured});}
      if(req.method==='POST'&&url.pathname==='/api/google/configure'){
        if(typeof google.configure!=='function')throw fail(503,'Google OAuth setup is unavailable.');
        const result=await google.configure({clientId:body.clientId,clientSecret:body.clientSecret});
        return json(res,200,result);
      }
      if(req.method==='POST'&&url.pathname==='/api/google/login')return json(res,200,await google.beginLogin());
      if(req.method==='POST'&&url.pathname==='/api/google/disconnect')return json(res,200,await google.disconnect());
       if(req.method==='GET'&&url.pathname==='/api/google/documents'){
         if(typeof google.listDocuments!=='function')throw fail(503,'Google Docs listing is unavailable.');
         const rawPageSize=url.searchParams.get('pageSize');
         const pageSize=rawPageSize===null?20:/^\d+$/.test(rawPageSize)?Number(rawPageSize):NaN;
         return json(res,200,await google.listDocuments({query:url.searchParams.get('q')??'',pageToken:url.searchParams.get('pageToken')??'',pageSize}));
       }
      if(req.method==='POST'&&url.pathname==='/api/google/agent/configure'){
        if(typeof googleAgent.configure!=='function')throw fail(503,'Google agent OAuth setup is unavailable.');
        return json(res,200,await googleAgent.configure({clientId:body.clientId,clientSecret:body.clientSecret}));
      }
      if(req.method==='POST'&&url.pathname==='/api/google/agent/login'){
        if(body.includeSheets!==undefined&&typeof body.includeSheets!=='boolean')throw fail(400,'includeSheets must be a boolean.');
        if(body.includeDriveFile!==undefined&&typeof body.includeDriveFile!=='boolean')throw fail(400,'includeDriveFile must be a boolean.');
        return json(res,200,await googleAgent.beginLogin({includeSheets:body.includeSheets===true,includeDriveFile:body.includeDriveFile===true}));
      }
      if(req.method==='POST'&&url.pathname==='/api/google/agent/disconnect')return json(res,200,await googleAgent.disconnect());
      if(req.method==='POST'&&url.pathname==='/api/google/read')return json(res,200,{document:await google.readDocument(body.documentId)});
      if(req.method==='POST'&&url.pathname==='/api/google/reconcile'){
        if(typeof body.documentId!=='string'||! /^[A-Za-z0-9_-]{1,256}$/.test(body.documentId))throw fail(400,'A valid documentId is required.');
        if(typeof body.operationId!=='string'||! /^[A-Za-z0-9_-]{1,256}$/.test(body.operationId))throw fail(400,'A valid operationId is required.');
        if(body.authorReviewed!==true)throw fail(400,'Explicit author review is required.');
        if(typeof google.reconcileOperation!=='function')throw fail(503,'Google reconciliation is unavailable.');
        const operation=await google.reconcileOperation({documentId:body.documentId,operationId:body.operationId,authorReviewed:true,ownerId:googleOwnerId});
        return json(res,200,{operation});
      }
      if(req.method==='POST'&&url.pathname==='/api/google/suggest')return json(res,200,await google.suggest(body));
      if(req.method==='POST'&&url.pathname==='/api/google/comment')return json(res,200,await google.comment(body));
      if(req.method==='GET'&&url.pathname==='/api/manuscript'){
        const bookId=activeBookId();
        if(!bookId)return json(res,200,{bookId:null,binding:null,staleBinding:false,candidates:[]});
        const candidates=manuscriptCandidates(bookId),binding=readManuscriptBinding(bookId),current=binding&&candidates.find(item=>item.attachmentId===binding.attachmentId&&item.googleDocumentId===binding.documentId);
        return json(res,200,{bookId,binding:current?{...binding,name:current.name}:null,staleBinding:!!binding&&!current,candidates,workingCopySupported:true});
      }
      if(req.method==='POST'&&url.pathname==='/api/manuscript/bind'){
        const bookId=requireActiveBook(body.bookId);
        if(body.attachmentId===null){store.setSetting(manuscriptKey(bookId),'null');return json(res,200,{bookId,binding:null});}
        const candidate=typeof body.attachmentId==='string'?manuscriptCandidates(bookId).find(item=>item.attachmentId===body.attachmentId):null;
        if(!candidate)throw Object.assign(fail(404,'Этот Google-файл не связан с текущей книгой.'),{code:'attachment_not_found'});
        const binding={attachmentId:candidate.attachmentId,documentId:candidate.googleDocumentId,boundAt:new Date().toISOString()};
        store.setSetting(manuscriptKey(bookId),JSON.stringify(binding));
        return json(res,200,{bookId,binding:{...binding,name:candidate.name}});
      }
      if(req.method==='POST'&&['/api/manuscript/working/read','/api/manuscript/working/import','/api/manuscript/working/save'].includes(url.pathname)){
        const {binding}=requireManuscript(body.bookId);
        if(body.documentId!==binding.documentId)throw Object.assign(fail(409,'Основная рукопись сменилась.'),{code:'manuscript_changed'});
        let copy;
        if(url.pathname.endsWith('/read'))copy=manuscriptFiles.read(body.bookId,binding.documentId);
        else if(url.pathname.endsWith('/save'))copy=manuscriptFiles.save(body.bookId,binding.documentId,body.version,body.chapters,body.retired);
        else {
          if(typeof google.readWorkingManuscript!=='function')throw fail(503,'Полный импорт рукописи сейчас недоступен.');
          const snapshot=await google.readWorkingManuscript(binding.documentId);
          // Import reads may outlive a book or primary-manuscript switch.
          const current=requireManuscript(body.bookId);
          if(current.binding.documentId!==binding.documentId)throw Object.assign(fail(409,'Основная рукопись сменилась.'),{code:'manuscript_changed'});
          copy=manuscriptFiles.importDocument(body.bookId,binding.documentId,body.version,snapshot);
        }
        return json(res,200,{bookId:body.bookId,documentId:binding.documentId,copy:url.pathname.endsWith('/save')?{version:copy.version,updatedAt:copy.updatedAt}:manuscriptFiles.view(copy)});
      }
      if(req.method==='POST'&&url.pathname.startsWith('/api/manuscript/')){
        const action=url.pathname.slice('/api/manuscript/'.length);
        if(!['read','sections','stage','apply'].includes(action))throw fail(404,'Route not found.');
        if(typeof google.readManuscript!=='function')throw Object.assign(fail(503,'Чтение рукописи Google сейчас недоступно.'),{expose:true,code:'google_unavailable'});
        const {binding,candidate}=requireManuscript(body.bookId);
        if(action!=='read'&&action!=='sections'&&body.documentId!==binding.documentId)throw Object.assign(fail(409,'Основная рукопись книги сменилась. Обновите оглавление.'),{code:'manuscript_changed'});
        if(action==='apply'){
          if(body.confirmed!==true)throw Object.assign(fail(400,'Запись в Google требует отдельного подтверждения после проверки изменений.'),{code:'confirmation_required'});
          if(agent.inTurn||agent.pendingMessage)throw Object.assign(fail(409,'Дождитесь завершения работы агента перед записью в Google.'),{code:'agent_busy'});
        }
        try {
          const result=action==='read'?{manuscript:await google.readManuscript(binding.documentId)}
            :action==='sections'?await google.readSections(binding.documentId,body.sectionIds)
            :action==='stage'?await google.stageChapterChanges(binding.documentId,{edits:body.edits,newChapters:body.newChapters})
            :{result:await google.applyChapterChanges(binding.documentId,{revisionId:body.revisionId,planHash:body.planHash,operationId:body.operationId,edits:body.edits,newChapters:body.newChapters})};
          return json(res,200,{bookId:body.bookId,binding:{...binding,name:candidate.name},...result});
        } catch(error) {
          const mapped=chapterErrorResponse(error,action==='apply'?'write':'read');
          throw Object.assign(fail(mapped.status,mapped.message),{code:mapped.code,expose:true,...(mapped.sectionId?{sectionId:mapped.sectionId}:{}),...(typeof error.operationId==='string'?{operationId:error.operationId}:{})});
        }
      }
      if(req.method==='POST'&&url.pathname==='/api/export')return json(res,200,store.exportData());
      throw fail(404,'Route not found.');
    } catch(error) {
      if(res.headersSent){res.end();return;}
      const status=Number.isInteger(error.status)?error.status:500;
      if(status>=500)console.error('TaleWisp Web request failed:',error.message);
      const expose=status<500||error.expose===true;
      json(res,status,{error:expose?error.message:'Internal server error.',...(expose&&typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?{code:error.code}:{}),...(expose&&typeof error.sectionId==='string'?{sectionId:error.sectionId}:{}),...(expose&&typeof error.operationId==='string'?{operationId:error.operationId}:{})});
    }
  });
  server.on('listening',()=>{if(port===0){internalToolUrl=`http://127.0.0.1:${server.address().port}/api/internal/agent-tool`;if(agent&&'internalToolUrl'in agent)agent.internalToolUrl=internalToolUrl;}});
  const close=()=>{
    if(closePromise)return closePromise;
    closing=true;
    for(const client of clients)client.end();clients.clear();agent.off?.('event',agentEvent);
    const serverClosed=new Promise(resolveClose=>{if(server.listening)server.close(resolveClose);else resolveClose();});
    closePromise=(async()=>{try{await agent.shutdown?.();await storyArtService?.close?.();await nativeConsultationService.waitForIdle?.();await serverClosed;}finally{passwordAuth?.close();store.close?.();releaseLock();}})();
    return closePromise;
  };
  return {server,store,agent,google,googleAgent,knowledge,workspaceService,pluginService,importService,nativeConsultationService,storyArtService,dataDir,host,port,close};
  async function staticFile(req,res,pathName){
    const decoded=decodeURIComponent(pathName);const target=decoded==='/'?'index.html':decoded.replace(/^\/+/, '');
    if(target.includes('..')||target.includes('\\')||target.includes('\0'))throw fail(404,'File not found.');
    const root=resolve(HERE,'public'),file=resolve(root,target);if(file!==root&&!file.startsWith(root+sep))throw fail(404,'File not found.');
    if(!existsSync(file)||!lstatSync(file).isFile())throw fail(404,'File not found.');
    const status=200;res.writeHead(status,{'content-type':MIME[extname(file).toLowerCase()]??'application/octet-stream','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; connect-src 'self'; frame-src https://docs.google.com; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    if(req.method==='HEAD')return res.end();createReadStream(file).pipe(res);
  }
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(HERE,'server.mjs')) {
  let app;
  try {app=await createApplication();app.server.listen(app.port,app.host,()=>console.log(`TaleWisp Web listening on http://${app.host}:${app.server.address().port}`));}
  catch(error){console.error(`TaleWisp Web could not start: ${error.message}`);process.exitCode=1;}
  const shutdown=()=>app?.close().finally(()=>process.exit(0));process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
