import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scopeKey } from './workspace-scope.mjs';
import { createRuntimeContract } from './runtime-contract.mjs';
import { createDelegationManager, DELEGATE_ROLES, DELEGATION_TOOLS, IMPORT_REVIEW_READ_TOOL, supportsEffort } from './delegation.mjs';
import { resolveRuntimeModel } from './runtime-model-selection.mjs';
import { readDelegationHistory, recoverDelegationHistory, recordDelegationEvent, mergeDelegationHistory } from './delegation-history.mjs';
import { createRoleplayDispatcher, ROLEPLAY_DELEGATE_TOOL } from './roleplay-dispatch.mjs';
import { IMPORT_AGENT_TOOLS, createImportAgentTools } from './import-agent-tools.mjs';
import { NATIVE_CONSULTATION_TOOL, nativeConsultationArguments } from './native-consultation-tool.mjs';
import { CODE_REVIEW_TOOL, createCodeReviewService } from './code-review.mjs';
import { STORYART_TOOL } from './storyart-service.mjs';

const STARTUP_MS = 12_000;
const STOP_GRACE_MS = 3_000;
const safeAccount = account => account ? ({ type:account.type, email:account.email ?? null, planType:account.planType ?? null }) : null;
const LEGACY_READ_ONLY_TOOLS = ['talewisp_project_status','talewisp_onboarding_status','talewisp_list_files','talewisp_read_file','talewisp_search','talewisp_scene_context'];
const DYNAMIC_TOOL_VERSION = 'google-proposal-queue-v1';
const ROLEPLAY_READINESS_TOOL = 'talewisp_roleplay_readiness';
const GUARDED_TOOL_RESULT = Symbol('guardedToolResult');
const THREAD_BINDING_FIELDS = ['threadId','authorId','seriesId','bookId','vaultPath','revision','dynamicToolsVersion','runtimeContractVersion'];
const GOOGLE_QUEUE_TOOLS = [
  { name:'talewisp_web_google_suggest', description:'Queue a Google Docs suggestion as a pending author-review action. This only adds a proposal to the TaleWisp review queue; it does not write to Google. Supply the exact document revision, tab, range, quote, replacement, and unique operationId.', type:'function', inputSchema:{type:'object',properties:{documentId:{type:'string',minLength:1,maxLength:512},tabId:{type:'string'},revisionId:{type:'string',minLength:1},startIndex:{type:'integer',minimum:0},endIndex:{type:'integer',minimum:0},quote:{type:'string',minLength:1},replacement:{type:'string',minLength:1},operationId:{type:'string',minLength:8,maxLength:200}},required:['documentId','tabId','revisionId','startIndex','endIndex','quote','replacement','operationId'],additionalProperties:false} },
  { name:'talewisp_web_google_comment', description:'Queue a range-anchored Google Docs comment as a pending author-review action. This only adds a proposal to the TaleWisp review queue; it does not write to Google. Supply the exact document revision, tab, range, quote, comment text, and unique operationId.', type:'function', inputSchema:{type:'object',properties:{documentId:{type:'string',minLength:1,maxLength:512},tabId:{type:'string'},revisionId:{type:'string',minLength:1},startIndex:{type:'integer',minimum:0},endIndex:{type:'integer',minimum:0},quote:{type:'string',minLength:1},text:{type:'string',minLength:1},operationId:{type:'string',minLength:8,maxLength:200}},required:['documentId','tabId','revisionId','startIndex','endIndex','quote','text','operationId'],additionalProperties:false} }
];
const GOOGLE_QUEUE_TOOL_MAP = new Map([['talewisp_web_google_suggest','talewisp_web_google_suggest'],['talewisp_web_google_comment','talewisp_web_google_comment']]);
function validateGoogleQueueArguments(tool,args) {
  const fields=tool==='talewisp_web_google_suggest'
    ? ['documentId','tabId','revisionId','startIndex','endIndex','quote','replacement','operationId']
    : ['documentId','tabId','revisionId','startIndex','endIndex','quote','text','operationId'];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).sort().join(',')!==[...fields].sort().join(',')) throw new Error('Google queue arguments do not match the permitted fields.');
  if(typeof args.tabId!=='string') throw new Error('Google queue argument tabId must be a string.');
  for(const key of ['documentId','revisionId','quote','operationId',tool==='talewisp_web_google_suggest'?'replacement':'text']) {
    if(typeof args[key]!=='string'||!args[key].trim()) throw new Error(`Google queue argument ${key} must be a non-empty string.`);
  }
  if(args.documentId.length>512||args.operationId.length<8||args.operationId.length>200) throw new Error('Google queue identifiers are outside their permitted length.');
  if(!Number.isSafeInteger(args.startIndex)||args.startIndex<0||!Number.isSafeInteger(args.endIndex)||args.endIndex<0||args.endIndex<args.startIndex) throw new Error('Google queue range is invalid.');
}
const BRIDGE_PATH = fileURLToPath(new URL('./agent-bridge.mjs', import.meta.url));
const textOf = item => typeof item?.text === 'string' ? item.text : (item?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('');
const requestError = (status,message) => Object.assign(new Error(message),{status});

function assertSafeRuntimeConfig(result, expectedTools = LEGACY_READ_ONLY_TOOLS, profile = 'normal') {
  const config=result?.config;
  const server=config?.mcp_servers?.talewisp;
  const tools=server?.enabled_tools;
  const toolSet=Array.isArray(tools)?[...tools].sort():[];
  const allowed=[...expectedTools].sort();
  const sharedSafe=config?.sandbox_mode==='read-only'
    && config?.features?.shell_tool===false
    && config?.features?.apps===false
    && config?.features?.multi_agent===false
    && config?.agents?.enabled===false
    && config?.approval_policy==='never';
  const safe=sharedSafe&&(profile==='import-bootstrap'
    ? Object.keys(config?.mcp_servers??{}).length===0
    : profile==='normal'&&Object.keys(config?.mcp_servers??{}).length===1&&server?.enabled===true&&server?.required===true&&Array.isArray(tools)&&tools.length===allowed.length&&toolSet.every((tool,index)=>tool===allowed[index]));
  if(!safe) throw new Error('Codex app-server effective config does not meet the required read-only TaleWisp tool boundary.');
}

function childEnvironment(codexHome) {
  const allowed = ['PATH','Path','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','LANG','LC_ALL'];
  const env = Object.fromEntries(allowed.filter(key => process.env[key] != null).map(key => [key, process.env[key]]));
  env.CODEX_HOME = codexHome;
  env.HOME = codexHome;
  env.USERPROFILE = codexHome;
  env.TELEMETRY = '0';
  return env;
}

export class JsonlRunner extends EventEmitter {
  constructor({ codexHome, cwd, codexBinary = process.env.CODEX_BIN || 'codex', spawnImpl = spawn, dynamicToolHandler = null }) {
    super(); this.cwd = cwd; this.seq = 0; this.pending = new Map(); this.closed = false; this.stopping=false; this.exited=false;
    this.dynamicToolHandler=dynamicToolHandler;
    mkdirSync(codexHome, { recursive:true, mode:0o700 }); mkdirSync(cwd, { recursive:true, mode:0o700 });
    const policy = `You are the writing assistant inside the TaleWisp local client. The connected vault is private, author-controlled material. Treat the author's explicit instructions and corrections as binding. Preserve canon, knowledge boundaries, established scene intent, voice, event order, and relationships. Never apply or claim to apply changes to canon, manuscripts, profiles, or vault files from a tool call; mutations only prepare concrete app-owned proposals/actions and require explicit review and approval in the workspace UI. Do not request API keys or reveal credentials. Use the installed TaleWisp tool catalog through the private workspace bridge; the app enforces the selected series boundary. Cite source paths and distinguish confirmed facts from uncertainty. The active series is the canon scope: use relevant current-world records, applicable confirmed style rules, and lexical dictionary from that series; do not import records from older versions or other series. Do not automatically activate excluded or unselected author style material. Keep searches targeted and do not imply access to sources you did not read. When writing fiction, first read the selected series lexical dictionary and applicable editorial protocol; do not change canon terms to satisfy preferences. If Keller Kut is selected, retain motivated attention through the hero's prism, personal meaning, earned emotional change, knowledge boundaries, literal physical causes, and scene intent. Produce useful prose on the first pass, preserve the requested edit mode, and avoid hidden reviewer or rewrite loops. For revisions, make the smallest sufficient local change and preserve the event chain, motivations, emotional trajectory, and prepared payoff. Cite knowledge cards using [[path|title]] so the workspace can render safe links. Never fabricate a save, source, tool call, or runtime event.`;
    writeFileSync(join(cwd, 'AGENTS.md'), policy + '\n', { encoding:'utf8', mode:0o600 });
    this.proc = spawnImpl(codexBinary, ['app-server','--listen','stdio://'], { cwd, env:childEnvironment(codexHome), windowsHide:true, stdio:['pipe','pipe','pipe'], shell:false });
    this.exitPromise=new Promise(resolve=>this.proc.once('exit',(code,signal)=>resolve({code,signal})));
    this.proc.on('error', error => { this.emit('failure', new Error(`Codex app-server could not start: ${error.message}`)); this._rejectAll(error); });
    this.proc.on('exit', (code, signal) => { this.closed = true;this.exited=true; const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`); this._rejectAll(error); this.emit('exit', error); });
    const lines = createInterface({ input:this.proc.stdout, crlfDelay:Infinity });
    lines.on('line', line => this._line(line));
    this.proc.stderr.on('data', bytes => this.emit('diagnostic', bytes.toString('utf8').slice(0, 2000)));
  }
  _rejectAll(error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  _line(line) {
    if (Buffer.byteLength(line,'utf8') > 4_000_000) { this.emit('failure',new Error('Oversized app-server message')); this.stop(); return; }
    let message; try { message=JSON.parse(line); } catch { return; }
    if (message.id != null && this.pending.has(message.id)) {
      const pending=this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'App-server request failed'));
      else pending.resolve(message.result ?? {});
    } else if (message.id != null) {
      if(message.method==='item/tool/call'&&this.dynamicToolHandler) void this._handleDynamicToolRequest(message);
      else this._rejectServerRequest(message);
    } else if (message.method) this.emit('notification', message);
  }
  _rejectServerRequest(request,reason='Server-initiated requests are disabled in this client') {
    if(!this.closed&&!this.stopping&&this.proc.stdin?.writable)this.proc.stdin.write(`${JSON.stringify({id:request.id,error:{code:-32601,message:reason}})}\n`);
    this.emit('blockedRequest', { method:request.method });
  }
  async _handleDynamicToolRequest(message) {
    try {
      const result=await this.dynamicToolHandler(message.params);
      if(this.closed||this.stopping||!this.proc.stdin?.writable||result===undefined)return;
      if(result?.[GUARDED_TOOL_RESULT]) { if(!result.guard())return; }
      const value=result?.[GUARDED_TOOL_RESULT]?result.value:result;
      this.proc.stdin.write(`${JSON.stringify({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]}})}\n`);
    } catch(error) {
      if(!this.closed&&!this.stopping&&this.proc.stdin?.writable)this.proc.stdin.write(`${JSON.stringify({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:error?.message??'Dynamic tool request rejected.'}]}})}\n`);
      this.emit('blockedRequest',{method:message.method});
    }
  }
  notify(method, params={}) { if(this.closed||this.stopping||!this.proc.stdin?.writable)throw new Error('Agent runtime is stopped'); this.proc.stdin.write(`${JSON.stringify({method,params})}\n`); }
  request(method, params={}, timeoutMs=20_000) {
    if(this.closed)return Promise.reject(new Error('Agent runtime is stopped'));
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`App-server ${method} timed out`));},timeoutMs); timer.unref?.();
      this.pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
      try { this.proc.stdin.write(`${JSON.stringify({id,method,params})}\n`); } catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async initialize() {
    let handshakeTimer;
    const handshakeTimeout=new Promise((_,reject)=>{handshakeTimer=setTimeout(()=>reject(new Error('Codex app-server handshake timed out')),STARTUP_MS);handshakeTimer.unref?.();});
    try { await Promise.race([this.request('initialize',{clientInfo:{name:'talewisp_web',title:'TaleWisp Web',version:'0.1.0'},capabilities:{experimentalApi:true}}),handshakeTimeout]); }
    finally { clearTimeout(handshakeTimer); }
    this.notify('initialized',{});
    this.effectiveConfig=await this.request('config/read',{cwd:this.cwd,includeLayers:true});
  }
  async stop() {
    if(!this.stopping){this.stopping=true;this.closed=true;try{this.proc.kill();}catch{}this._rejectAll(new Error('Agent runtime stopped'));}
    if(this.exited)return true;
    let timer;
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),STOP_GRACE_MS);});
    const exited=this.exitPromise.then(()=>{clearTimeout(timer);return true;});
    return Promise.race([exited,timeout]);
  }
}

export class AgentService extends EventEmitter {
  constructor({ dataDir, store, vaultPath = null, talewispMcpPath = null, pythonExecutable = 'python', codexBinary = process.env.CODEX_BIN || 'codex', sourceReader = async () => { throw new Error('Read-only vault search is not configured.'); }, runnerFactory = options => new JsonlRunner(options), workspaceService = null, pluginService = null, importService = null, nativeConsultationService = null, storyArtService = null, internalToolUrl = null, internalToolToken = null, runtimeContractFactory = createRuntimeContract, runtimeModelResolver = resolveRuntimeModel }) {
    super(); this.dataDir=resolve(dataDir); this.store=store; this.sourceReader=sourceReader; this.runnerFactory=runnerFactory;
    this.codexHome=join(this.dataDir,'codex-home'); this.workDir=join(this.dataDir,'agent-work');
    this.vaultPath=vaultPath; this.talewispMcpPath=talewispMcpPath; this.pythonExecutable=pythonExecutable; this.codexBinary=codexBinary;
    this.workspaceService=workspaceService;this.pluginService=pluginService;this.importService=importService;this.importToolHandler=importService?createImportAgentTools({service:importService,getActiveJobId:()=>this.activeImportJobId}):null;this.storyArtService=storyArtService;this.storyArtStatus={available:false,requiresDesktop:true};this.codeReviewService=null;this.codeReviewRunner=null;this.nativeConsultationService=nativeConsultationService;this.nativeConsultationStatus={state:nativeConsultationService?'not_checked':'unavailable',adapterInstalled:false,availability:'unverified',authentication:'unverified'};this.nativeConsultationAttemptedTurns=new Set();this.nativeConsultationOperation=null;this.internalToolUrl=internalToolUrl;this.internalToolToken=internalToolToken;this.runtimeContractFactory=runtimeContractFactory;this.runtimeModelResolver=runtimeModelResolver;this.runtimeContract=null;this.runtimeContractPromise=null;this.runtimeContractVersion='';this._activeThreadContractVersion='';this.nativeSkillStatus={state:'not_checked',skills:[],errors:[]};this.hostCapabilities={};this.googleCapabilities=null;this.toolInventory=[];this.workspaceRevision=null;this.workspaceSelection=null;this.workspaceSelectionBookless=false;this.totalTaleWispTools=0;this.activeRuntimeProfile=null;this.activeThreadProfile='normal';this.activeImportJobId=null;this.normalMessageScopeKey=store.messageScopeKey??'unassigned';
    this.runner=null;this.delegationManager=null;this.delegationManagerRunner=null;this.delegationManagersByRunner=new WeakMap();this.runnerStopPromises=new WeakMap();this.roleplayDispatcher=null;this.recoveredDelegationScopes=new Set();this.ephemeralThreadBindings=new Map();this.activeRequestContext=null;this.activeToolCallIds=new Set(); this.running=false; this.account=null; this.limits=null; this.models=[]; this.error=null; this.loginPending=false; this.inTurn=false; this.pendingMessage=false; this.turnCompletion=null; this.resolveTurnCompletion=null; this.turnText=''; this.turnItems=new Map();
    this.threadId=store.getSetting('agent.threadId');
    this.conversationScope=this.store.messageScopeKey??'unassigned';
    this.conversationSettingKey=`agent.conversations.${createHash('sha256').update(this.conversationScope).digest('hex').slice(0,24)}`;
    this.conversations=this._readConversations();
    this.activeConversationId=this.store.getSetting(`${this.conversationSettingKey}.active`)||this.conversations.find(item=>!item.archived)?.id||null;
    const migrateLegacyScope=this.store.messageScopeKey??'unassigned';
    if(!this.conversations.length) {
      const legacyBinding=this._storedThreadBinding();
      this.activeConversationId=this._createConversation({threadId:legacyBinding?.threadId??null,dynamicToolsVersion:legacyBinding?.dynamicToolsVersion??null,binding:legacyBinding}).id;
    }
    this._activateConversationState();
    if(migrateLegacyScope!==this.store.messageScopeKey&&typeof this.store.moveMessageScope==='function')this.store.moveMessageScope(migrateLegacyScope,this.store.messageScopeKey);
    if(!this.workspaceSelection)this.threadId=store.getSetting('agent.threadId');
    this.dynamicToolsVersion=store.getSetting('agent.dynamicToolsVersion');
    this.activeTurnId=null;
  }
  _emit(type, values={}) { const event={type,...values}; if(type==='delegation')try{recordDelegationEvent(this.store,event);}catch(error){this.error=error?.message??'Delegation history could not be saved.';this.emit('event',{type:'error',message:this.error,source:'delegation-history'});} this.emit('event',event); return event; }
  _readConversations() { try { const value=JSON.parse(this.store.getSetting(this.conversationSettingKey)||'[]'); return Array.isArray(value)?value.filter(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.archived==='boolean'):[]; } catch { return []; } }
  _saveConversations() { if(typeof this.store.setSetting!=='function')return false;this.store.setSetting(this.conversationSettingKey,JSON.stringify(this.conversations)); this.store.setSetting(`${this.conversationSettingKey}.active`,this.activeConversationId||'');return true; }
  _activeConversation() { return this.conversations.find(item=>item.id===this.activeConversationId)||null; }
  _createConversation({threadId=null,dynamicToolsVersion=null,binding=null,title='Новый диалог'}={}) { const item={id:randomUUID(),threadId,dynamicToolsVersion,binding,title,archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}; this.conversations.unshift(item); this.activeConversationId=item.id; this._saveConversations(); return item; }
  _conversationBindingMatches(binding) { const item=this._activeConversation();if(!this.workspaceSelection)return !binding&&!!this.ephemeralThreadBindings.get(item?.id);if(!binding||!this.workspaceRevision)return false;return this._threadBindingMatches(binding,{vaultPath:this.vaultPath,selection:this.workspaceSelection,revision:this.workspaceRevision},item?.threadId); }
  _activateConversationState() { const item=this._activeConversation(); if(!item)return;this.store.messageScopeKey=`${this.conversationScope}:conversation:${item.id}`;const valid=this._conversationBindingMatches(item.binding);const ephemeral=!this.workspaceSelection?this.ephemeralThreadBindings.get(item.id):null;this.threadId=valid?(item.binding?.threadId??ephemeral?.threadId):null;this.dynamicToolsVersion=valid?(item.binding?.dynamicToolsVersion??ephemeral?.dynamicToolsVersion):null; }
  _switchConversationScope(scope,{legacyBinding=null}={}) { this.store.setMessageScope?.(scope);this.conversationScope=this.store.messageScopeKey??scope;this.conversationSettingKey=`agent.conversations.${createHash('sha256').update(this.conversationScope).digest('hex').slice(0,24)}`;this.conversations=this._readConversations();this.activeConversationId=this.store.getSetting(`${this.conversationSettingKey}.active`)||this.conversations.find(item=>!item.archived)?.id||null;const hadConversations=this.conversations.length>0;if(!hadConversations){const validLegacyBinding=this._threadBindingMatches(legacyBinding,{vaultPath:this.vaultPath,selection:this.workspaceSelection,revision:this.workspaceRevision},legacyBinding?.threadId)?legacyBinding:null;this.activeConversationId=this._createConversation({binding:validLegacyBinding,threadId:validLegacyBinding?.threadId,dynamicToolsVersion:validLegacyBinding?.dynamicToolsVersion}).id;}this._activateConversationState();if(!hadConversations&&typeof this.store.moveMessageScope==='function')this.store.moveMessageScope(scope,this.store.messageScopeKey); }
  listConversations() { return {activeConversationId:this.activeConversationId,conversations:this.conversations.map(({id,title,archived,createdAt,updatedAt})=>({id,title,archived,createdAt,updatedAt}))}; }
  activateConversation(id) { if(this.inTurn||this.pendingMessage)throw requestError(409,'Нельзя переключить диалог во время ответа агента.'); const item=this.conversations.find(value=>value.id===id&&!value.archived); if(!item)throw requestError(404,'Диалог не найден или находится в архиве.'); this.activeConversationId=id;this._activateConversationState();this._saveConversations();return this.status(); }
  createConversation() { if(this.inTurn||this.pendingMessage)throw requestError(409,'Дождитесь завершения ответа агента.'); const item=this._createConversation();this._activateConversationState();return this.status(); }
  archiveConversation(id) { if(this.inTurn||this.pendingMessage)throw requestError(409,'Дождитесь завершения ответа агента.');const item=this.conversations.find(value=>value.id===id);if(!item)throw requestError(404,'Диалог не найден.');item.archived=true;item.updatedAt=new Date().toISOString();if(item.id===this.activeConversationId){const next=this.conversations.find(value=>!value.archived);if(next)this.activeConversationId=next.id;else this._createConversation();}this._activateConversationState();this._saveConversations();return this.status(); }
  restoreConversation(id) { const item=this.conversations.find(value=>value.id===id);if(!item)throw requestError(404,'Диалог не найден.');item.archived=false;item.updatedAt=new Date().toISOString();this._saveConversations();return this.status(); }
  _beginTurnLock() { this.inTurn=true;if(!this.turnCompletion)this.turnCompletion=new Promise(resolve=>{this.resolveTurnCompletion=resolve;}); }
  _completeTurn() { void this.codeReviewService?.cancelAll?.('Parent turn completed.');void this.delegationManager?.cancelAll?.('Parent turn completed.');void this._cancelNativeConsultation('Parent turn completed.');this.inTurn=false;this.activeTurnId=null;this.activeRequestContext=null;this.activeToolCallIds.clear();const resolve=this.resolveTurnCompletion;this.resolveTurnCompletion=null;this.turnCompletion=null;resolve?.(); }
  async refreshNativeConsultationStatus() {
    if(!this.nativeConsultationService){this.nativeConsultationStatus={state:'unavailable',adapterInstalled:false,availability:'unavailable',authentication:'unverified'};return this.nativeConsultationStatus;}
    try { const result=await this.nativeConsultationService.status();const installed=result?.adapterInstalled===true;const running=result?.running===true;const busy=result?.busy===true;const cleanupPending=result?.cleanupPending===true;this.nativeConsultationStatus={state:installed?'adapter_installed':'unavailable',adapterInstalled:installed,availability:'unverified',authentication:'unverified',busy,running,cancelRequested:result?.cancelRequested===true,cleanupPending,stuck:result?.stuck===true,reason:installed?'Adapter presence is confirmed; saved authentication and provider readiness are not checked by status.':'Native adapter is not installed.'}; }
    catch { this.nativeConsultationStatus={state:'status_unavailable',adapterInstalled:false,availability:'unverified',authentication:'unverified'}; }
    return this.nativeConsultationStatus;
  }
  async _cancelNativeConsultation(reason) {
    const operation=this.nativeConsultationOperation;
    if(!operation||operation.cancelRequested||!this.nativeConsultationService?.stop)return operation?.stopResult??null;
    operation.cancelRequested=true;operation.cancelReason=reason;
    try { operation.stopResult=await this.nativeConsultationService.stop();operation.phase=operation.stopResult?.cleanupPending?'cleanup_pending':operation.stopResult?.cancelRequested?'cancel_requested':'stop_unconfirmed'; }
    catch { operation.phase='stop_unconfirmed';operation.stopResult={cancelRequested:false,cleanupPending:true}; }
    return operation.stopResult;
  }
  _nativeConsultationToolEnabled() { return !!this.nativeConsultationService&&this.nativeConsultationStatus.adapterInstalled===true; }
  _clearPersistedThreadBinding() {
    try {
      this.store.setSetting('agent.threadId','');
      this.store.setSetting('agent.threadBinding','');
    } catch (error) {
      this.threadId=null;
      throw error;
    }
  }
  _clearThreadBinding() {
    this.threadId=null;
    const conversation=this._activeConversation(); if(conversation){this.ephemeralThreadBindings.delete(conversation.id);conversation.threadId=null;conversation.dynamicToolsVersion=null;this._saveConversations();}
    try { this._clearPersistedThreadBinding(); } catch {}
  }
  _storedThreadBinding() {
    const raw=this.store.getSetting('agent.threadBinding');
    if(typeof raw!=='string'||!raw) return null;
    try {
      const binding=JSON.parse(raw);
      if(!binding||typeof binding!=='object'||Array.isArray(binding)) return null;
      if(Object.keys(binding).sort().join(',')!==[...THREAD_BINDING_FIELDS].sort().join(',')) return null;
      if(THREAD_BINDING_FIELDS.some(key=>key==='bookId'||key==='vaultPath'?binding[key]!==null&&(typeof binding[key]!=='string'||!binding[key]):typeof binding[key]!=='string'||(key!=='dynamicToolsVersion'&&!binding[key]))) return null;
      if(binding.bookId===null&&!this.workspaceSelectionBookless)return null;
      return binding;
    } catch { return null; }
  }
  _threadBindingMatches(binding,{vaultPath,selection,revision},expectedThreadId=this.threadId) {
    const dynamicPrefix=`${this.pluginService?DYNAMIC_TOOL_VERSION:'no-google-queue'};runtime-contract:${this.runtimeContractVersion};`;
    const dynamicSuffix=typeof binding?.dynamicToolsVersion==='string'&&binding.dynamicToolsVersion.startsWith(dynamicPrefix)?binding.dynamicToolsVersion.slice(dynamicPrefix.length):'';
    const dynamicEnabled=/^(?:host-workflow:(?:none|storyart|code_review);)?roleplay:(?:enabled|disabled)(?:;native-consult:enabled)?$/.test(dynamicSuffix);
    return !!binding
      && binding.threadId===expectedThreadId
      && binding.authorId===selection?.authorId
      && binding.seriesId===selection?.seriesId
      && binding.bookId===selection?.bookId
      && binding.vaultPath===vaultPath
      && binding.revision===revision
      && dynamicEnabled
      && binding.runtimeContractVersion===this.runtimeContractVersion;
  }
  _persistThreadBinding() {
    const selection=this.workspaceSelection??{};
    const binding={threadId:this.threadId,authorId:selection.authorId,seriesId:selection.seriesId,bookId:selection.bookId,vaultPath:this.vaultPath,revision:this.workspaceRevision,dynamicToolsVersion:this.dynamicToolsVersion,runtimeContractVersion:this.runtimeContractVersion};
    if(!this.workspaceSelection){const conversation=this._activeConversation();if(conversation){conversation.threadId=this.threadId;conversation.dynamicToolsVersion=this.dynamicToolsVersion;conversation.binding=null;this._saveConversations();this.ephemeralThreadBindings.set(conversation.id,{threadId:this.threadId,dynamicToolsVersion:this.dynamicToolsVersion});}this._clearPersistedThreadBinding();return false;}
    if(THREAD_BINDING_FIELDS.some(key=>key==='bookId'||key==='vaultPath'?binding[key]!==null&&(typeof binding[key]!=='string'||!binding[key]):typeof binding[key]!=='string'||(key!=='dynamicToolsVersion'&&!binding[key]))||binding.bookId===null&&!this.workspaceSelectionBookless) {
      this._clearPersistedThreadBinding();
      return false;
    }
    try {
      const conversation=this._activeConversation(); if(conversation){conversation.threadId=this.threadId;conversation.dynamicToolsVersion=this.dynamicToolsVersion;conversation.binding=binding;conversation.updatedAt=new Date().toISOString();this._saveConversations();}
      this.store.setSetting('agent.threadBinding',JSON.stringify(binding));
      this.store.setSetting('agent.threadId',this.threadId);
      this.store.setSetting('agent.dynamicToolsVersion',this.dynamicToolsVersion);
      return true;
    } catch(error) {
      this._clearPersistedThreadBinding();
      return false;
    }
  }
  async _abortUncertainTurn(error) {
    this.error=error?.message??'Turn state is uncertain; stopping the app-server.';
    this._clearThreadBinding();
    const runner=this.runner;
    let exited=runner?.exited===true;
    if(runner&&!exited)try{exited=await runner.stop()===true||runner.exited===true;}catch{}
    if(!this.inTurn) {
      if(exited&&this.runner===runner)this.runner=null;
      this._emit('status',this.status());
      return true;
    }
    if(exited) {
      if(this.runner===runner)this.runner=null;
      this._completeTurn();
      this._emit('status',this.status());
      return true;
    }
    this._beginTurnLock();
    this._emit('status',this.status());
    return false;
  }
  _scenarioStatus() {
    const definitions=this.runtimeContract?.scenarios??{};
    const resources=new Set((this.runtimeContract?.resources??[]).map(resource=>resource.id));
    const hasLunaHigh=this.models.some(model=>model.id==='gpt-6-luna'&&supportsEffort(model,'high'));
    const dispatch=this.hostCapabilities.subagentDispatch==='available'&&hasLunaHigh;
    const sources=this.hostCapabilities.taleWispTools==='available';
    const connected=this.account?.type==='chatgpt'&&!!this.runner&&!this.runner.closed;
    const prose=resources.has('project/plugins/talewisp/skills/write-fiction/SKILL.md');
    const available={
      ordinary_writing:dispatch&&prose,continuation:dispatch&&prose,revision:dispatch&&prose,
      canon_research:dispatch&&sources&&prose&&resources.has('project/plugins/talewisp/skills/write-fiction/references/agent-routing.md'),
      knowledge_audit:dispatch&&sources&&prose&&resources.has('project/plugins/talewisp/skills/write-fiction/references/continuity-contract.md')&&this.toolInventory.some(tool=>tool.name==='talewisp_knowledge_at_scene'),
      onboarding:connected&&resources.has('project/plugins/talewisp/skills/write-fiction/references/onboarding.md'),
      roleplay:dispatch&&this.hostCapabilities.roleplayReadiness==='available'&&resources.has('project/plugins/talewisp/skills/write-fiction/references/roleplay-mode.md')&&resources.has('project/plugins/talewisp/skills/write-fiction/references/roleplay-dramaturgy.md'),
      calibration:dispatch&&prose&&resources.has('project/plugins/talewisp/skills/write-fiction/references/style-calibration.md')&&resources.has('project/plugins/talewisp/skills/write-fiction/references/style-evaluation.md'),
      series_base:!!this.importService&&resources.has('project/plugins/talewisp/skills/build-series-base/SKILL.md'),
      google_workspace:this.hostCapabilities.googleNativeTools==='available'&&resources.has('project/plugins/talewisp/skills/google-writing-workspace/SKILL.md'),
      storyart:connected&&this.hostCapabilities.storyArtTransport==='available',code_review:this.activeThreadProfile!=='import'&&connected&&this.models.some(model=>model.id==='gpt-6.1-sol'&&supportsEffort(model,'medium'))
    };
    return Object.fromEntries(Object.entries(definitions).map(([id,definition])=>{
      const isAvailable=available[id]===true;
      const gates=isAvailable?[]:[...(Array.isArray(definition.requires)?definition.requires:[]),'host_prerequisites'];
      return [id,{...definition,id,available:isAvailable,availability:isAvailable?'available':'unavailable',gates}];
    }));
  }
  status() { let savedDelegations=[];let delegationHistoryError=null;try{savedDelegations=readDelegationHistory(this.store);}catch(error){delegationHistoryError=error?.message??'Delegation history is unavailable.';} return {available:!!this.runner&&!this.runner.closed,authenticated:this.account?.type==='chatgpt',loginPending:this.loginPending,account:safeAccount(this.account),limits:this.limits,error:this.error,running:this.inTurn,models:this.models,messages:this.store.listMessages(100),threadId:this.threadId,...this.listConversations(),contractVersion:this.runtimeContractVersion||null,scenarios:this._scenarioStatus(),skills:(this.runtimeContract?.resources??[]).filter(resource=>/\/SKILL\.md$/i.test(resource.origin??'')).map(({id,title,hash,sourceHash,origin})=>({id,title,hash,sourceHash,origin})),loadedResourceCount:this.runtimeContract?.resources?.length??0,nativeSkills:this.nativeSkillStatus,dependencies:this.runtimeContract?.dependencies??{},hostCapabilities:this.hostCapabilities,googleCapabilities:this.googleCapabilities,nativeConsultation:{...this.nativeConsultationStatus,operation:this.nativeConsultationOperation?{phase:this.nativeConsultationOperation.phase??'running',turnId:this.nativeConsultationOperation.turnId,cleanupPending:this.nativeConsultationOperation.stopResult?.cleanupPending===true}:null},delegations:mergeDelegationHistory(savedDelegations,this.delegationManager?.status()??{active:[],recent:[]}),delegationHistoryError,security:{isolatedCodexHome:true,shellTool:'configured-disabled',apps:'configured-disabled',multiAgent:'configured-disabled',totalTaleWispTools:this.totalTaleWispTools,writeMode:this.pluginService?'author-approved-proposals':'legacy-read-only-fixture',filesystemReadBoundary:'not-supported-by-installed-app-server-schema'}}; }
  async connect({profile='normal'}={}) {
    if(!['normal','import-bootstrap'].includes(profile))throw new Error('Agent runtime profile is not permitted.');
    if(profile==='import-bootstrap'&&(!this.importService||!this.activeImportJobId))throw new Error('The isolated import profile requires a validated active import job.');
    if(this.runner&&!this.runner.closed&&this.activeRuntimeProfile&&this.activeRuntimeProfile!==profile) {
      await this.delegationManager?.shutdown?.('Runtime profile changed.');
      const previous=this.runner;
      const stopped=await previous.stop?.();
      if(stopped===false&&previous.exited!==true)throw new Error('The previous runtime profile did not stop; the requested profile was not started.');
      this.runner=null;this.delegationManager=null;this.delegationManagerRunner=null;this.roleplayDispatcher=null;
    }
    if(!this.runner || this.runner.closed) {
      this.running=true; this.error=null; this._emit('status',{available:true,connecting:true});
      let runner;
      try { const enabledTools=await this._writeRuntimeConfig(profile); runner=this.runnerFactory({codexHome:this.codexHome,cwd:this.workDir,codexBinary:this.codexBinary,dynamicToolHandler:params=>this._handleDynamicToolCall(params)}); this.runner=runner; this._attach(runner); await runner.initialize(); assertSafeRuntimeConfig(runner.effectiveConfig,enabledTools,profile);this.activeRuntimeProfile=profile; }
      catch(error) { await runner?.stop?.(); this.runner=null; this.running=false; this.models=[]; this._invalidateRuntimeCapabilities(); this.error=error.message; this._emit('error',{message:this.error}); return this.status(); }
    }
    try {
      const auth=await this.runner.request('account/read',{refreshToken:true}); this.account=auth.account??null;
      if(this.account && this.account.type!=='chatgpt') throw new Error('Поддерживается только вход через подписку ChatGPT; API key и другие режимы отключены.');
      const [catalog,limits]=await Promise.all([
        this.runner.request('model/list',{limit:100,includeHidden:false}),
        this.runner.request('account/rateLimits/read',{}).catch(()=>({rateLimits:null,rateLimitsByLimitId:null}))
      ]);
      if(!Array.isArray(catalog.data))throw new Error('The signed-in account did not return a model catalog. Refresh the runtime status before starting a turn.');
      this.models=catalog.data.filter(model=>!model.hidden).map(model=>({id:model.id,displayName:model.displayName??model.id,supportedReasoningEfforts:Array.isArray(model.supportedReasoningEfforts)?model.supportedReasoningEfforts:[]}));
      this.limits=limits.rateLimitsByLimitId??limits.rateLimits??null; this.error=null; this.loginPending=false;
      try { await this._getRuntimeContract(); }
      catch(error) { this._invalidateRuntimeCapabilities(); this.error=error?.message??'Runtime capabilities could not be refreshed.'; }
    } catch(error) { this.models=[]; this._invalidateRuntimeCapabilities(); this.error=error.message; }
    this.running=false; this._emit('status',this.status()); return this.status();
  }
  async _writeRuntimeConfig(profile='normal') {
    mkdirSync(this.codexHome,{recursive:true,mode:0o700});
    const quote=value=>JSON.stringify(String(value).replaceAll('\\','/'));
    let tools;
    let pluginConfig;
    if(profile==='import-bootstrap') {
      if(!this.importService||!this.activeImportJobId)throw new Error('The isolated import runtime is not bound to a validated import job.');
      tools=[];this.toolInventory=[];this.totalTaleWispTools=0;pluginConfig='';
    } else if(profile!=='normal')throw new Error('Agent runtime profile is not permitted.');
    else if(!this.vaultPath)throw new Error('Select an author and series before connecting the agent.');
    else if(this.pluginService) {
      if(!this.workspaceService||!this.internalToolUrl||!this.internalToolToken)throw new Error('The private TaleWisp tool bridge is not configured.');
      const inventory=await this.pluginService.tools();
      const inventoryTools=inventory.map(tool=>tool.name);
      this.totalTaleWispTools=inventoryTools.length;
      if(!inventoryTools.length||inventoryTools.some(name=>typeof name!=='string'||!/^talewisp_[a-z0-9_]+$/.test(name)))throw new Error('The installed TaleWisp plugin returned an invalid tool inventory.');
      this.toolInventory=inventory;
      tools=inventoryTools.filter(name=>!GOOGLE_QUEUE_TOOL_MAP.has(name));
      this.workspaceRevision=await this.workspaceService.revision();
      pluginConfig=[
        '[mcp_servers.talewisp]',
        'enabled = true',
        'required = true',
        `command = ${quote(process.execPath)}`,
        `args = [${quote(BRIDGE_PATH)}]`,
        `enabled_tools = [${tools.map(quote).join(', ')}]`,
        '',
        '[mcp_servers.talewisp.env]',
        `TALEWISP_INTERNAL_TOOL_URL = ${quote(this.internalToolUrl)}`,
        `TALEWISP_INTERNAL_TOOL_TOKEN = ${quote(this.internalToolToken)}`,
        `TALEWISP_WORKSPACE_REVISION = ${quote(String(this.workspaceRevision))}`,
        ''
      ].join('\n');
    } else {
      if(!this.talewispMcpPath)throw new Error('TaleWisp read-only MCP path is not configured.');
      tools=LEGACY_READ_ONLY_TOOLS;
      pluginConfig=[
        '[mcp_servers.talewisp]',
        'enabled = true',
        'required = true',
        `command = ${quote(this.pythonExecutable)}`,
        `args = ["-u", ${quote(this.talewispMcpPath)}]`,
        `cwd = ${quote(this.workDir)}`,
        `enabled_tools = [${tools.map(quote).join(', ')}]`,
        '',
        '[mcp_servers.talewisp.env]',
        `TALEWISP_VAULT = ${quote(this.vaultPath)}`,
        'PYTHONDONTWRITEBYTECODE = "1"',
        ''
      ].join('\n');
    }
    const config=[
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'forced_login_method = "chatgpt"',
      '',
      '[features]',
      'shell_tool = false',
      'apps = false',
      'multi_agent = false',
      '',
      '[agents]',
      'enabled = false',
      '',
      pluginConfig,
    ].join('\n');
    writeFileSync(join(this.codexHome,'config.toml'),config,{encoding:'utf8',mode:0o600});
    return tools;
  }
  _attach(runner) {
    runner.on('notification',message=>this._notification(message));
    runner.on('failure',error=>{this.error=error.message;this._emit('error',{message:this.error});});
    runner.on('exit',error=>{if(this.codeReviewRunner===runner)this.codeReviewService?.runnerExited?.(error);this.delegationManagersByRunner.get(runner)?.runnerExited(error);if(this.runner!==runner)return;if(this.inTurn)this._clearThreadBinding();this._completeTurn();this._emit('status',{available:false,running:false,error:error.message});});
    runner.on('blockedRequest',info=>this._emit('approval',{status:'rejected',reason:'read-only runtime blocks all server requests',method:info.method}));
  }
  _notification({method,params={}}) {
    if(this.codeReviewService?.routeNotification({method,params}))return;
    if(this.delegationManager?.routeNotification({method,params}))return;
    const notificationThreadId=params.threadId??params.turn?.threadId??params.item?.threadId;
    if(notificationThreadId&&notificationThreadId!==this.threadId)return;
    if(method==='account/updated') { this.account=params.authMode==='chatgpt'?{type:'chatgpt',planType:params.planType??null}:null; this._emit('status',this.status()); }
    else if(method==='account/rateLimits/updated') { this.limits=params.rateLimitsByLimitId??params.rateLimits??this.limits; this._emit('status',this.status()); }
    else if(method==='account/login/completed') {
      if(params.success===false) { this.loginPending=false; this.error='Вход в ChatGPT не завершён. Попробуйте войти ещё раз.'; this._emit('status',this.status()); }
      else if(params.success===true) {
        this.loginPending=true; this.error=null; this._emit('status',this.status());
        this.refreshPromise=this._refreshAfterLogin();
      }
    }
    else if(method==='item/agentMessage/delta') {
      const delta=params.delta??''; this.turnText+=delta;
      this._emit('delta',{text:delta,itemId:params.itemId??null,conversationId:this.activeConversationId});
    } else if(method==='item/completed') {
      const item=params.item??{}; if(item.type==='agentMessage') {
        const text=textOf(item)||this.turnText; if(text) { this.store.addMessage('assistant',text); this._emit('message',{role:'assistant',text,conversationId:this.activeConversationId}); }
        this.turnText='';
      }
    } else if(method==='turn/completed') {
      const turn=params.turn??{};
      if(this.turnText) { this.store.addMessage('assistant',this.turnText); this._emit('message',{role:'assistant',text:this.turnText,conversationId:this.activeConversationId}); this.turnText=''; }
      this._completeTurn(); this.error=turn.status==='failed'?(turn.error?.message??'Agent turn failed'):null;
      this._emit('status',this.status());
    } else if(method==='turn/started') { this.activeTurnId=params.turn?.id??null;this._beginTurnLock(); this.turnText=''; this._emit('status',this.status()); }
    else if(method==='error') this._emit('error',{message:'Codex app-server reported an error'});
    else if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval') this._emit('approval',{status:'rejected',reason:'read-only runtime rejects approval requests'});
  }
  async _refreshAfterLogin() {
    try {
      const auth=await this.runner.request('account/read',{refreshToken:true}); this.account=auth.account??null;
      if(this.account?.type!=='chatgpt') throw new Error('Вход завершён, но аккаунт ChatGPT не подтвердился. Обновите статус и проверьте активный аккаунт.');
      const [catalog,limits]=await Promise.all([
        this.runner.request('model/list',{limit:100,includeHidden:false}),
        this.runner.request('account/rateLimits/read',{}).catch(()=>({rateLimits:null,rateLimitsByLimitId:null}))
      ]);
      if(!Array.isArray(catalog.data))throw new Error('The signed-in account did not return a model catalog. Refresh the runtime status before starting a turn.');
      this.models=catalog.data.filter(model=>!model.hidden).map(model=>({id:model.id,displayName:model.displayName??model.id,supportedReasoningEfforts:Array.isArray(model.supportedReasoningEfforts)?model.supportedReasoningEfforts:[]}));
      if(!this.models.length)throw new Error('ChatGPT sign-in completed, but no subscription models are available for this account.');
      this.limits=limits.rateLimitsByLimitId??limits.rateLimits??null; this.error=null;
      try { await this._getRuntimeContract(); }
      catch(error) { this._invalidateRuntimeCapabilities(); this.error=error?.message??'Runtime capabilities could not be refreshed.'; }
    } catch(error) { this.models=[]; this._invalidateRuntimeCapabilities(); this.error=error.message; }
    finally { this.loginPending=false; this._emit('status',this.status()); }
  }
  _invalidateRuntimeCapabilities() {
    this.runtimeContract=null;this.runtimeContractVersion='';this.googleCapabilities=null;
    this.hostCapabilities={subagentDispatch:'unavailable',taleWispTools:'unavailable',googleNativeTools:'unavailable',nativeConsultation:'unavailable',roleplayReadiness:'unavailable',storyArtTransport:'unavailable',geminiHandoff:'unavailable'};
  }
  async _loadRuntimeContract() {
    await this.refreshNativeConsultationStatus();
    const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
    let google=null;if(this.activeThreadProfile!=='import')try{google=await this.pluginService?.capabilities?.()??null;}catch(error){google={error:error?.message??'capability_probe_failed'};}
    if(this.activeThreadProfile!=='import'&&this.storyArtService)try{this.storyArtStatus=await this.storyArtService.probe();}catch{this.storyArtStatus={available:false,requiresDesktop:true};}
    const hostCapabilities={
      subagentDispatch:this.account?.type==='chatgpt'&&!!this.runner&&!this.runner.closed&&this.models.some(model=>model.id==='gpt-6-luna'&&supportsEffort(model,'high'))?'available':'unavailable',
      taleWispTools:this.activeThreadProfile==='import'?'unavailable':this.pluginService||this.talewispMcpPath&&this.vaultPath?'available':'unavailable',
      googleNativeTools:this.activeThreadProfile==='import'?'unavailable':google?.configured&&google?.authenticated?'available':'unavailable',
      nativeConsultation:this.nativeConsultationStatus.adapterInstalled?'not_checked':'unavailable',
      roleplayReadiness:this.activeThreadProfile!=='import'&&this.toolInventory.some(tool=>tool.name===ROLEPLAY_READINESS_TOOL)?'available':'unavailable',
      storyArtTransport:this.activeThreadProfile!=='import'&&this.storyArtStatus.available===true?'available':'unavailable',
      geminiHandoff:'not_checked'
    };
    const contract=await this.runtimeContractFactory({projectRoot,hostCapabilities});
    if(!contract||typeof contract.version!=='string'||!contract.version||typeof contract.instructions!=='string'||typeof contract.readResource!=='function'||!Array.isArray(contract.resources))throw new Error('The TaleWisp runtime instruction contract is incomplete.');
    this.googleCapabilities=google;this.hostCapabilities=hostCapabilities;this.runtimeContract=contract;this.runtimeContractVersion=contract.version;
    return contract;
  }
  async _registerNativeSkills() {
    const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
    const roots=['plugin/skills/write-fiction','plugin/skills/build-series-base','plugin/skills/google-writing-workspace','skills/coordinate-talewisp-storyart'].map(relative=>resolve(projectRoot,relative));
    try {
      await this.runner.request('skills/extraRoots/set',{extraRoots:roots});
      const listed=await this.runner.request('skills/list',{cwds:[this.workDir],forceReload:true});
      const entries=Array.isArray(listed?.data)?listed.data:[];
      const scoped=entries.find(entry=>entry.cwd===this.workDir)??entries[0];
      const skills=Array.isArray(scoped?.skills)?scoped.skills:[];
      const errors=Array.isArray(scoped?.errors)?scoped.errors:[];
      const expected=['write-fiction','build-series-base','google-writing-workspace','coordinate-talewisp-storyart'];
      const normalizedPath=value=>typeof value==='string'?value.replaceAll('\\','/').toLowerCase():'';
      const missing=expected.filter(name=>!skills.some(skill=>normalizedPath(skill?.path).endsWith(`/${name.toLowerCase()}/skill.md`)));
      this.nativeSkillStatus={state:missing.length?'partial':'available',skills:skills.map(({name,path})=>({name,path})),errors:[...errors,...missing.map(name=>({message:'Expected native skill was not listed.',path:name}))]};
    } catch(error) {
      this.nativeSkillStatus={state:'unavailable',skills:[],errors:[{message:error?.message??'Native skill registration failed.',path:''}]};
    }
  }
  _nativeSkillInputs(mode) {
    const selected={
      ordinary_writing:['write-fiction'],writing:['write-fiction'],revision:['write-fiction'],continuation:['write-fiction'],
      series_base:['build-series-base'],google_workspace:['google-writing-workspace'],storyart:['coordinate-talewisp-storyart'],roleplay:['write-fiction'],calibration:['write-fiction']
    }[mode]??[];
    return selected.flatMap(name=>{
      const skill=this.nativeSkillStatus.skills.find(entry=>typeof entry.path==='string'&&entry.path.replaceAll('\\','/').toLowerCase().endsWith(`/${name.toLowerCase()}/skill.md`));
      return skill?[{type:'skill',name:skill.name,path:skill.path}]:[];
    });
  }
  async _getRuntimeContract() {
    if(!this.runtimeContractPromise)this.runtimeContractPromise=this._loadRuntimeContract().finally(()=>{this.runtimeContractPromise=null;});
    return this.runtimeContractPromise;
  }
  _ensureDelegationManager() {
    if(this.delegationManager&&this.delegationManagerRunner===this.runner)return this.delegationManager;
    this.delegationManagerRunner=this.runner;
    const runner=this.runner;
    this.delegationManager=createDelegationManager({
      runner,
      runtimeProfile:this.activeRuntimeProfile??'normal',
      contractProvider:()=>this._getRuntimeContract(),
      resolveModel:()=>this.runtimeModelResolver({projectRoot:resolve(fileURLToPath(new URL('..',import.meta.url))),pythonExecutable:this.pythonExecutable}),
      getModelCatalog:()=>this.models,
      getNativeSkills:()=>this.nativeSkillStatus.skills,
      getWorkspaceRevision:()=>this.workspaceRevision,
      getParentBinding:()=>this.inTurn&&this.threadId&&this.activeTurnId?{threadId:this.threadId,turnId:this.activeTurnId,cwd:this.workDir}:null,
      authorizeRole:(role,details)=>this._authorizeDelegationRole(role,details),
      emit:payload=>this._emit('delegation',payload),
      stopRunner:reason=>this._stopDelegationRunner(runner,reason)
    });
    this.delegationManagersByRunner.set(runner,this.delegationManager);
    return this.delegationManager;
  }
  _stopDelegationRunner(runner,reason) {
    if(!runner||this.runner!==runner)return Promise.resolve(runner?.exited===true);
    const existing=this.runnerStopPromises.get(runner);if(existing)return existing;
    const stopping=Promise.resolve().then(()=>runner.stop?.(reason)).then(result=>result===true||runner.exited===true).catch(error=>{this.error=error?.message??'App-server shutdown failed.';this._emit('error',{message:this.error,source:'delegation-stop'});return false;}).finally(()=>{this.runnerStopPromises.delete(runner);});
    this.runnerStopPromises.set(runner,stopping);return stopping;
  }
  _ensureCodeReviewService() {
    if(this.codeReviewService&&this.codeReviewRunner===this.runner)return this.codeReviewService;
    this.codeReviewRunner=this.runner;
    this.codeReviewService=createCodeReviewService({runner:this.runner,getModelCatalog:()=>this.models,resolveModel:()=>resolveRuntimeModel({projectRoot:resolve(fileURLToPath(new URL('..',import.meta.url))),pythonExecutable:this.pythonExecutable,route:'sol_review'}),emit:payload=>this._emit('delegation',payload),store:this.store,cwd:this.workDir,getActiveContext:()=>this.inTurn?{mode:this.activeRequestContext?.mode,parentThreadId:this.threadId,parentTurnId:this.activeTurnId,workspaceRevision:this.workspaceRevision}:null});
    return this.codeReviewService;
  }
  _ensureRoleplayDispatcher() {
    if(this.roleplayDispatcher)return this.roleplayDispatcher;
    const required=['talewisp_roleplay_start','talewisp_roleplay_status','talewisp_roleplay_packet'];
    if(!this.pluginService||required.some(name=>!this.toolInventory.some(tool=>tool.name===name)))throw new Error('The native TaleWisp roleplay tool set is incomplete.');
    this.roleplayDispatcher=createRoleplayDispatcher({
      pluginService:this.pluginService,
      workspaceService:this.workspaceService,
      getActiveRequest:()=>this.activeRequestContext,
      getParentBinding:()=>this.inTurn&&this.threadId&&this.activeTurnId?{threadId:this.threadId,turnId:this.activeTurnId,cwd:this.workDir}:null,
      getContractVersion:()=>this.runtimeContractVersion,
      getVoiceInput:async({request})=>typeof request?.selectedText==='string'&&request.selectedText.trim()?{selectedVoiceExcerpt:request.selectedText,source:'author-selected-text'}:null,
      delegate:request=>this._ensureDelegationManager().delegate({...request,roleplayDispatch:true})
    });
    return this.roleplayDispatcher;
  }
  _authorizeDelegationRole(role,details={}) {
    const context=this.activeRequestContext;
    if(!context)return false;
    const mode=context.mode??'';
    if(mode==='series_base_import')return role==='continuity_reviewer'&&context.importJob?{maxCalls:1,scenario:'series_base_import'}:false;
    const text=context.text??'';
    const explicitlyRequestsReview=/\b(review|reviewer|continuity review)\b/i.test(text)||/реценз|проверь(?:те)? сцен|провед(?:и|ите) провер|независим(?:ую|ая) провер/i.test(text);
    const explicitlyForbidsReview=/без\s+(?:независимой\s+)?(?:реценз|провер)|не\s+(?:запускай|провод(?:и|ите)|нужен|нужна)\s+(?:никак(?:ой|ую)\s+)?(?:реценз|провер)|no\s+(?:review|reviewer)|do\s+not\s+review/i.test(text);
    if(role==='style_editor') {
      if(['ordinary_writing','continuation','revision','google_workspace'].includes(mode))return {maxCalls:1,scenario:mode};
      if(mode==='calibration')return {maxCalls:3,scenario:'calibration'};
      return false;
    }
    if(role==='lore_researcher')return ['canon_research','knowledge_audit','ordinary_writing','continuation','revision'].includes(mode)?{maxCalls:1,scenario:mode}:false;
    if(role==='vault_curator')return ['knowledge_audit','research','knowledge','onboarding'].includes(mode)?{maxCalls:1,scenario:mode}:false;
    if(role==='continuity_reviewer') {
      const reasonedRisk=details.hasWriter===true&&typeof details.task==='string'&&details.task.trim().length>0&&typeof details.input==='string'&&details.input.trim().length>0;
      return ['ordinary_writing','continuation','revision','google_workspace','knowledge_audit'].includes(mode)&&!explicitlyForbidsReview&&(explicitlyRequestsReview||mode==='knowledge_audit'||reasonedRisk)?{maxCalls:1,scenario:mode}:false;
    }
    if(role==='calibration_evaluator')return mode==='calibration'?{maxCalls:1,scenario:'calibration'}:false;
    if(role==='roleplay_leader'||role==='roleplay_hero'||role==='roleplay_formatter')return mode==='roleplay'&&details.roleplayDispatch===true?{maxCalls:role==='roleplay_formatter'?1:4,scenario:'roleplay'}:false;
    return false;
  }
  async login({method='browser'}={}) {
    if(!['browser','device'].includes(method))throw requestError(400,'Choose browser or device-code sign-in.');
    this.loginPending=true; this.error=null; this._emit('status',this.status());
    try {
      const status=await this.connect(); if(!this.runner)throw new Error(status.error||'Codex app-server is unavailable');
      this.loginPending=true; this.error=null; this._emit('status',this.status());
      const login=await this.runner.request('account/login/start',method==='device'?{type:'chatgptDeviceCode'}:{type:'chatgpt',useHostedLoginSuccessPage:true,appBrand:'chatgpt'});
      if(method==='device'&&(!login.loginId||!login.verificationUrl||!login.userCode))throw new Error('Device-code sign-in response is incomplete. The installed app-server may not support this flow.');
      if(method==='browser'&&login.authUrl) return {authUrl:login.authUrl,verificationUrl:null,userCode:null,loginId:null};
      if(method==='device') return {authUrl:null,verificationUrl:login.verificationUrl,userCode:login.userCode,loginId:login.loginId};
      throw new Error('Сервер входа не вернул ссылку. Обновите статус runtime и повторите попытку.');
    } catch(error) { this.loginPending=false; this.error=error.message; this._emit('status',this.status()); throw error; }
  }
  async _ensureThread(model, mode=null) {
    await this.refreshNativeConsultationStatus();
    const contract=await this._getRuntimeContract();
    await this._registerNativeSkills();
    const dynamicTools=[...(mode==='code_review'?[CODE_REVIEW_TOOL]:[]),...(mode==='storyart'&&this.storyArtStatus.available?[STORYART_TOOL]:[]),...(this.pluginService?GOOGLE_QUEUE_TOOLS:[]),...(mode==='roleplay'&&this.pluginService?[ROLEPLAY_DELEGATE_TOOL]:[]),...(this._nativeConsultationToolEnabled()?[NATIVE_CONSULTATION_TOOL]:[]),...DELEGATION_TOOLS];
    const dynamicVersion=`${this.pluginService?DYNAMIC_TOOL_VERSION:'no-google-queue'};runtime-contract:${contract.version};host-workflow:${mode==='code_review'||mode==='storyart'?mode:'none'};roleplay:${mode==='roleplay'?'enabled':'disabled'}${this._nativeConsultationToolEnabled()?';native-consult:enabled':''}`;
    const runtimeInstructions=[contract.instructions,contract.ROOT_WORKFLOW_INSTRUCTIONS,mode==='storyart'?'This host has a verified official Codex App MCP transport to the dedicated StoryArt project. Use talewisp_storyart_partner for the explicit current illustration request. create starts a new dedicated StoryArt chat; send/read/wait address only that owned requestId. Never generate an image in TaleWisp, invent partner responses or claim author approval. Read the coordination skill first. Host adds the verified desktop return address. Report real requestId and real output.':mode==='code_review'?'This host exposes talewisp_code_review for this explicit independent technical review. Supply complete literal before and after source files, not summaries or prose, and the task. The host computes a frozen diff and syntax checks, records SOL_GATE and starts one fresh native Codex review on Sol medium. It checks supplied source snippets (js/mjs/json); syntax checks do not establish project test coverage. Never call ordinary prose delegation for technical review, request a repair loop, or fabricate machine checks.':'',...(this._nativeConsultationToolEnabled()?['Native Gemini consultation is optional. Use it only for an explicit author request or a concrete consequential uncertainty. Send only a bounded task, requirements, and selected evidence packet; never send a whole vault or excluded private style material. One attempt per parent turn is enforced; failure is terminal for that turn.']:[]),`ALLOWLISTED OPERATIONAL RESOURCE MANIFEST:\n${contract.resources.map(resource=>`${resource.id} | ${resource.title} | source sha256=${resource.sourceHash} | content sha256=${resource.hash}`).join('\n')}`].filter(value=>typeof value==='string'&&value.trim()).join('\n\n');
    this._activeThreadContractVersion=contract.version;
    this._ensureDelegationManager();
    if(mode==='code_review')this._ensureCodeReviewService();
    if(mode==='roleplay')this._ensureRoleplayDispatcher();
    const conversation=this._activeConversation();
    const ephemeralBinding=!this.workspaceSelection?this.ephemeralThreadBindings.get(conversation?.id):null;
    const bindingMatches=!!this.threadId&&(this.workspaceSelection?!!conversation?.binding&&this._threadBindingMatches(conversation.binding,{vaultPath:this.vaultPath,selection:this.workspaceSelection,revision:this.workspaceRevision},this.threadId):ephemeralBinding?.threadId===this.threadId&&ephemeralBinding?.dynamicToolsVersion===dynamicVersion);
    if(this.threadId&&bindingMatches&&this.dynamicToolsVersion===dynamicVersion) {
      try { await this.runner.request('thread/resume',{threadId:this.threadId,excludeTurns:true}); return this.threadId; }
      catch { this._clearThreadBinding(); }
    } else if(this.threadId) {
      if(!this.workspaceSelection&&!ephemeralBinding){this.threadId=null;this._clearPersistedThreadBinding();}
      else this._clearThreadBinding();
    }
    const args={cwd:this.workDir,approvalPolicy:'never',sandbox:'read-only'}; if(model)args.model=model;
    args.dynamicTools=dynamicTools;
    args.developerInstructions=runtimeInstructions;
    const result=await this.runner.request('thread/start',args,30_000); this.threadId=result.thread?.id;
    if(!this.threadId)throw new Error('Codex did not return a conversation id');
    this.dynamicToolsVersion=dynamicVersion;
    this._persistThreadBinding();
    return this.threadId;
  }
  _importThreadSetting(jobId) { return `agent.importThreadBinding.${jobId}`; }
  async _importJobSnapshot(jobId) {
    if(!this.importService||typeof jobId!=='string')throw requestError(400,'An isolated import job context is required.');
    const status=await this.importService.status(jobId);
    if(status.jobId!==jobId)throw requestError(409,'The import service returned a different job.');
    const inventory=await this.importService.inventory(jobId);
    const sessionId=status.sessionId??status.session_id??null,candidateSha256=status.candidateSha256??status.candidate_sha256??null;
    const machineChecksPath=status.machine_checks_path??status.machineChecksPath??null;
    const jobVersion=createHash('sha256').update(JSON.stringify({jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status,sessionId,candidateSha256,machineChecksPath,files:inventory.files})).digest('hex');
    return {jobId,authorPseudonym:status.authorPseudonym,seriesName:status.seriesName,status:status.status,statusDetails:status,sessionId,candidateSha256,machineChecksPath,jobVersion,inventory};
  }
  async _verifyImportJob(jobId, context) {
    if(!this.importService||typeof jobId!=='string'||!context||typeof context!=='object'||Array.isArray(context))throw requestError(400,'An isolated import job context is required.');
    if(Object.keys(context).sort().join(',')!=='authorPseudonym,jobId,seriesName,status')throw requestError(400,'Import context has unsupported fields.');
    const current=await this._importJobSnapshot(jobId);
    if(context.jobId!==jobId||context.authorPseudonym!==current.authorPseudonym||context.seriesName!==current.seriesName||context.status!==current.status)throw requestError(409,'The trusted import job context is stale or inconsistent.');
    return current;
  }
  async _ensureImportThread(model, job) {
    await this.refreshNativeConsultationStatus();
    const contract=await this._getRuntimeContract();
    await this._registerNativeSkills();
    const bindingKey=this._importThreadSetting(job.jobId);
    const dynamicTools=[...IMPORT_AGENT_TOOLS,...(this._nativeConsultationToolEnabled()?[NATIVE_CONSULTATION_TOOL]:[]),...DELEGATION_TOOLS];
    const dynamicVersion=`series-base-import-v1:${job.jobVersion};runtime-contract:${contract.version};native-consult:${this._nativeConsultationToolEnabled()?'enabled':'disabled'}`;
    const runtimeInstructions=[contract.instructions,contract.ROOT_WORKFLOW_INSTRUCTIONS,...(this._nativeConsultationToolEnabled()?['Native Gemini consultation is optional and remains bounded to this import task. Use it only for an explicit author request or a concrete consequential uncertainty; never send a whole vault or unrelated private style material.']:[]),`ISOLATED SERIES BASE IMPORT. Active job ${job.jobId}; author ${job.authorPseudonym}; series ${job.seriesName}; status ${job.status}. Use only the exact import tools for this job and the allowlisted operational resources. Never access the normal workspace, manuscripts, Google, roleplay, or publish. Import tool writes are limited to this job's private staging vault. For an independent review, call continuity_reviewer with a concise task plus trusted file-path/hash manifest only; do not put source or analysis contents in the delegate input. The child gets a bounded reader for this job's pinned inventory and must read the required files itself.`, `ALLOWLISTED OPERATIONAL RESOURCE MANIFEST:\n${contract.resources.map(resource=>`${resource.id} | ${resource.title} | source sha256=${resource.sourceHash} | content sha256=${resource.hash}`).join('\n')}`].join('\n\n');
    this._activeThreadContractVersion=contract.version; this._ensureDelegationManager();
    const raw=this.store.getSetting(bindingKey);let binding=null;try{binding=JSON.parse(raw);}catch{}
    if(binding?.threadId&&binding.dynamicToolsVersion===dynamicVersion&&binding.runtimeContractVersion===contract.version){
      try{await this.runner.request('thread/resume',{threadId:binding.threadId,excludeTurns:true});this.threadId=binding.threadId;this.dynamicToolsVersion=dynamicVersion;return this.threadId;}catch{}
    }
    const args={cwd:this.workDir,approvalPolicy:'never',sandbox:'read-only',dynamicTools,developerInstructions:runtimeInstructions,...(model?{model}:{})};
    // The verified import-bootstrap runtime has no MCP servers. Adding a dotted
    // disabled server here would create a transport-less entry rejected by Codex.
    const started=await this.runner.request('thread/start',args,30_000);
    const threadId=started?.thread?.id;if(typeof threadId!=='string'||!threadId)throw new Error('Codex did not return an isolated import thread id.');
    let cursor=null;const seen=new Set();
    for(let page=0;page<32;page++) { const result=await this.runner.request('mcpServerStatus/list',{threadId,serverName:null,detail:'full',cursor,limit:100},20_000);if(!Array.isArray(result?.data))throw new Error('Import thread MCP inventory is unavailable.');if(result.data.some(server=>!server||typeof server.name!=='string'||!server.tools||Object.keys(server.tools).length))throw new Error('Import thread exposes MCP tools; refusing to use it.');if(!result.nextCursor)break;if(seen.has(result.nextCursor))throw new Error('Import thread MCP inventory pagination repeated.');seen.add(result.nextCursor);cursor=result.nextCursor;if(page===31)throw new Error('Import thread MCP inventory exceeded the safety limit.'); }
    this.threadId=threadId;this.dynamicToolsVersion=dynamicVersion;this.store.setSetting(bindingKey,JSON.stringify({threadId,dynamicToolsVersion:dynamicVersion,runtimeContractVersion:contract.version,jobVersion:job.jobVersion}));return threadId;
  }
  async _authorizeImportReviewer(job) {
    const current=await this._importJobSnapshot(job.jobId);
    if(current.authorPseudonym!==job.authorPseudonym||current.seriesName!==job.seriesName)throw new Error('Import author or series binding changed before review delegation.');
    const status=current.status;
    const checksPath=current.machineChecksPath;
    if(status!=='candidate_ready_for_review'||!current.candidateSha256||!current.sessionId||typeof checksPath!=='string')throw new Error('An independent import review requires a current candidate with a passing native machine check.');
    const checks=await this.importService.read(job.jobId,checksPath);
    let receipt;try{receipt=JSON.parse(checks.text);}catch{}
    if(receipt?.status!=='PASS'||receipt.session_id!==current.sessionId||receipt.candidate_sha256!==current.candidateSha256)throw new Error('The current import candidate does not have a matching PASS machine-check receipt.');
    const afterCheck=await this._importJobSnapshot(job.jobId);
    if(afterCheck.jobVersion!==current.jobVersion||afterCheck.authorPseudonym!==job.authorPseudonym||afterCheck.seriesName!==job.seriesName||afterCheck.status!=='candidate_ready_for_review')throw new Error('The import candidate changed while its machine checks were being verified.');
    return afterCheck;
  }
  _createImportReviewReader(binding) {
    const isImage=path=>/\.(?:png|jpe?g|webp|gif)$/i.test(path);
    const isSourceContainer=path=>/\.(?:docx|epub)$/i.test(path);
    const isPriorReview=path=>/(?:^|\/)independent-review\.json$/i.test(path);
    const inventoryFiles=binding?.inventory?.files??[];
    const files=inventoryFiles.filter(file=>!isImage(file.path)&&!isSourceContainer(file.path)&&!isPriorReview(file.path)).map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes}));
    const excludedFiles=inventoryFiles.filter(file=>isImage(file.path)||isSourceContainer(file.path)||isPriorReview(file.path)).map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes,reason:isImage(file.path)?'binary-image-not-readable-as-text':isSourceContainer(file.path)?'original-docx-or-epub-container-reviewed-through-normalized-corpus':'prior-review-is-not-evidence-for-current-review'}));
    if(!files.length)throw new Error('The authorized import review inventory has no readable text files.');
    const pinnedFiles=new Map(files.map(file=>[file.path,file]));
    const parent=this.activeRequestContext;
    if(!binding?.jobId||!binding?.jobVersion||!binding?.sessionId||!binding?.candidateSha256||!parent?.importJob||parent.importJob.jobId!==binding.jobId)throw new Error('Trusted import review binding is incomplete.');
    const assertCurrent=async()=>{
      if(this.activeRequestContext!==parent||this.activeThreadProfile!=='import'||this.activeImportJobId!==binding.jobId)throw new Error('Import review authorization is no longer active.');
      const current=await this._importJobSnapshot(binding.jobId);
      if(current.jobVersion!==binding.jobVersion||current.sessionId!==binding.sessionId||current.candidateSha256!==binding.candidateSha256||current.status!=='candidate_ready_for_review')throw new Error('The import job or candidate changed during independent review.');
      return current;
    };
    const reader=async({path,startChar,maxChars})=>{
      const pinned=pinnedFiles.get(path);
      if(!pinned||typeof pinned.sha256!=='string')throw new Error('Import review read path is not in the trusted pinned inventory.');
      if(maxChars>Math.min(64_000,Math.max(1,pinned.bytes)))throw new Error('Import review range exceeds the source-specific bounded character allowance.');
      await assertCurrent();
      const result=await this.importService.read(binding.jobId,path,{startChar,maxChars});
      await assertCurrent();
      const actualHash=result?.originalSha256??result?.sha256;
      if(actualHash!==pinned.sha256)throw new Error('Import review source hash differs from its authorization-time pinned inventory.');
      if((result.range?.start??null)!==startChar||typeof result.range?.end!=='number'||typeof result.eof!=='boolean'||typeof result.complete!=='boolean'||result.truncated===true)throw new Error('Import review source read was incomplete or outside its requested range.');
      return {path,sha256:pinned.sha256,range:result.range,eof:result.eof,totalChars:result.totalChars,complete:result.complete,text:result.text};
    };
    const manifest={jobId:binding.jobId,sessionId:binding.sessionId,candidateSha256:binding.candidateSha256,files,requiredFiles:files.map(file=>({...file})),excludedFiles};
    return {reader,manifest};
  }
  async _handleDynamicToolCall(params) {
    if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('Invalid dynamic tool request.');
    const keys=Object.keys(params);
    if(keys.some(key=>!['arguments','callId','namespace','threadId','tool','turnId'].includes(key))||!['arguments','callId','threadId','tool','turnId'].every(key=>Object.hasOwn(params,key)))throw new Error('Dynamic tool request has unsupported fields.');
    if(Object.hasOwn(params,'namespace')&&params.namespace!==null)throw new Error('Namespaced dynamic tools are not permitted.');
    if(typeof params.callId!=='string'||!params.callId||typeof params.turnId!=='string'||!params.turnId)throw new Error('Dynamic tool request identifiers are invalid.');
    if(params.threadId!==this.threadId) {
      if(params.tool==='talewisp_runtime_resource')return this.delegationManager?.handleResourceTool(params)??Promise.reject(new Error('Child runtime resource access is unavailable.'));
      if(params.tool===IMPORT_REVIEW_READ_TOOL.name)return this.delegationManager?.handleImportReviewRead(params)??Promise.reject(new Error('Import reviewer source access is unavailable.'));
      throw new Error('Child dynamic tool request is outside the active root; child threads may only read allowlisted operational resources.');
    }
    if(!this.inTurn||params.turnId!==this.activeTurnId)throw new Error('Dynamic tool request is outside the active TaleWisp turn.');
    if(this.activeToolCallIds.has(params.callId))throw new Error('Dynamic tool call id was already used in this turn.');
    this.activeToolCallIds.add(params.callId);
    const mappedTool=GOOGLE_QUEUE_TOOL_MAP.get(params.tool);
    if(!params.arguments||typeof params.arguments!=='object'||Array.isArray(params.arguments))throw new Error('Dynamic tool arguments must be an object.');
    if(params.tool==='talewisp_runtime_resource') {
      if(Object.keys(params.arguments).join(',')!=='id'||typeof params.arguments.id!=='string'||!params.arguments.id.trim()||params.arguments.id.length>160)throw new Error('Runtime resource arguments are invalid.');
      const contract=await this._getRuntimeContract();
      if(contract.version!==this.runtimeContractVersion||contract.version!==this._activeThreadContractVersion)throw new Error('Runtime contract changed during the active turn.');
      return {id:params.arguments.id,content:contract.readResource(params.arguments.id)};
    }
    if(params.tool===CODE_REVIEW_TOOL.name) {
      if(this.activeThreadProfile==='import'||this.activeRequestContext?.mode!=='code_review')throw new Error('Code review requires its explicit selected workflow.');
      return this._ensureCodeReviewService().execute(params.arguments,{mode:'code_review',parentThreadId:params.threadId,parentTurnId:params.turnId,parentCallId:params.callId,workspaceRevision:this.workspaceRevision});
    }
    if(params.tool===STORYART_TOOL.name) {
      if(this.activeThreadProfile==='import'||this.activeRequestContext?.mode!=='storyart'||!this.storyArtService)throw new Error('StoryArt requires its explicit selected workflow and connected desktop host.');
      return this.storyArtService.execute(params.arguments,{mode:'storyart',scope:scopeKey(this.workspaceSelection),parentThreadId:params.threadId,parentTurnId:params.turnId,parentCallId:params.callId,workspaceRevision:this.workspaceRevision});
    }
    if(params.tool===NATIVE_CONSULTATION_TOOL.name) {
      if(!this.nativeConsultationService||!this._nativeConsultationToolEnabled())throw new Error('Native consultation is unavailable because the installed adapter was not confirmed.');
      if(!this.dynamicToolsVersion?.includes('native-consult:enabled'))throw new Error('The active parent thread was not created with the native consultation tool. Start a fresh request.');
      const request=nativeConsultationArguments(params.arguments);
      const parent={threadId:params.threadId,turnId:params.turnId,workspaceRevision:this.workspaceRevision,requestContext:this.activeRequestContext,profile:this.activeThreadProfile};
      if(!this.inTurn||!parent.requestContext||params.turnId!==this.activeTurnId||params.threadId!==this.threadId)throw new Error('Native consultation is outside the active parent thread and turn.');
      if(this.nativeConsultationAttemptedTurns.has(parent.turnId))throw new Error('Only one native consultation attempt is permitted per parent turn, including failed attempts.');
      this.nativeConsultationAttemptedTurns.add(parent.turnId);
      if(this.nativeConsultationAttemptedTurns.size>512)this.nativeConsultationAttemptedTurns.delete(this.nativeConsultationAttemptedTurns.values().next().value);
      const operation={...parent,phase:'running',cancelRequested:false};
      this.nativeConsultationOperation=operation;
      const parentCurrent=()=>!operation.cancelRequested&&this.inTurn&&this.threadId===parent.threadId&&this.activeTurnId===parent.turnId&&this.workspaceRevision===parent.workspaceRevision&&this.activeRequestContext===parent.requestContext&&this.activeThreadProfile===parent.profile;
      const current=()=>this.nativeConsultationOperation===operation&&parentCurrent();
      try {
        const serviceState=await this.nativeConsultationService.status();
        if(serviceState?.busy===true||serviceState?.cleanupPending===true||serviceState?.running===true)throw new Error('A prior native consultation is still running or awaiting cleanup.');
        if(!current())return undefined;
        const result=await this.nativeConsultationService.analyze(request);
        if(!current())return undefined;
        return {[GUARDED_TOOL_RESULT]:true,value:result,guard:parentCurrent};
      } catch(error) {
        if(!current())return undefined;
        throw error;
      } finally {
        if(this.nativeConsultationOperation===operation)this.nativeConsultationOperation=null;
      }
    }
    if(params.tool===ROLEPLAY_READINESS_TOOL) {
      if(this.activeRequestContext?.mode!=='roleplay')throw new Error('Roleplay readiness is available only for an explicitly selected roleplay request.');
      if(Object.keys(params.arguments).join(',')!=='spec'||!params.arguments.spec||typeof params.arguments.spec!=='object'||Array.isArray(params.arguments.spec))throw new Error('Roleplay readiness arguments are invalid.');
      if(!this.toolInventory.some(tool=>tool.name===ROLEPLAY_READINESS_TOOL)||!this.pluginService)throw new Error('The read-only TaleWisp roleplay readiness tool is unavailable.');
      const nativeResult=await this.pluginService.call(ROLEPLAY_READINESS_TOOL,params.arguments,this.workspaceRevision);
      if(nativeResult?.isError)throw new Error('Native roleplay readiness failed.');
      const result=nativeResult?.structuredContent;
      if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Native roleplay readiness returned no structured result.');
      const receipt={threadId:params.threadId,turnId:params.turnId,workspaceRevision:this.workspaceRevision,contractVersion:this.runtimeContractVersion,offerable:result?.offerable===true,declarationComplete:result?.declaration_complete===true,sourceHashesMatch:result?.source_fragments_match_current_hashes===true,semanticReviewStatus:result?.semantic_review?.status??null};
      if(receipt.offerable&&receipt.declarationComplete&&receipt.sourceHashesMatch&&['source_reviewed','author_confirmed'].includes(receipt.semanticReviewStatus))this.activeRequestContext.roleplayReadinessReceipt=receipt;
      return {result,receipt};
    }
    if(this.activeThreadProfile==='import'&&IMPORT_AGENT_TOOLS.some(tool=>tool.name===params.tool)) {
      if(!this.importToolHandler||!this.activeRequestContext?.importJob)throw new Error('Import tools are unavailable outside the active isolated import request.');
      return this.importToolHandler(params.tool,params.arguments);
    }
    if(params.tool==='talewisp_delegate') {
      if(Object.keys(params.arguments).sort().join(',')!=='input,maxOutputChars,role,task'||!DELEGATE_ROLES.includes(params.arguments.role)||typeof params.arguments.task!=='string'||typeof params.arguments.input!=='string'||!Number.isSafeInteger(params.arguments.maxOutputChars))throw new Error('Delegation arguments are invalid.');
      if(['roleplay_leader','roleplay_hero','roleplay_formatter'].includes(params.arguments.role))throw new Error('Roleplay child roles may only be called through the native roleplay dispatcher.');
      const contract=await this._getRuntimeContract();
      if(contract.version!==this.runtimeContractVersion||contract.version!==this._activeThreadContractVersion)throw new Error('Runtime contract changed during the active turn.');
      const manager=this._ensureDelegationManager();
      let importReviewReader=null,importReviewManifest=null;
      if(this.activeThreadProfile==='import') {
        if(params.arguments.role!=='continuity_reviewer')throw new Error('Only the independent continuity reviewer role is available during Series Base import.');
        var importReviewBinding=await this._authorizeImportReviewer(this.activeRequestContext.importJob);
        ({reader:importReviewReader,manifest:importReviewManifest}=this._createImportReviewReader(importReviewBinding));
      }
      const delegation=await manager.delegate({...params.arguments,parentThreadId:params.threadId,parentTurnId:params.turnId,parentCallId:params.callId,contractVersion:this.runtimeContractVersion,workspaceRevision:this.workspaceRevision,...(importReviewReader?{importReviewReader,importReviewManifest}:{})});
      if(importReviewBinding&&delegation?.receipt?.status==='completed') {
        const afterReview=await this._importJobSnapshot(importReviewBinding.jobId);
        if(afterReview.jobVersion!==importReviewBinding.jobVersion||afterReview.status!=='candidate_ready_for_review')throw new Error('The import candidate changed during independent review; its result cannot be used.');
      }
      return delegation;
    }
    if(params.tool===ROLEPLAY_DELEGATE_TOOL.name) {
      if(this.activeRequestContext?.mode!=='roleplay')throw new Error('The native roleplay dispatcher is available only in an explicit roleplay request.');
      return this._ensureRoleplayDispatcher()(params.arguments,{parentCallId:params.callId});
    }
    if(!mappedTool||!this.pluginService)throw new Error('Dynamic tool is not permitted.');
    validateGoogleQueueArguments(params.tool,params.arguments);
    return this.pluginService.call(mappedTool,params.arguments,this.workspaceRevision);
  }
  async message({text,documentId,documentVersion,documentSnapshot,selectedText,manuscriptContext,knowledgePaths=[],model,mode=null,importJobId,importJobContext}) {
    mode=mode==null?'ordinary_writing':({writing:'ordinary_writing',write:'ordinary_writing',continue:'continuation',revise:'revision',research:'canon_research',knowledge:'knowledge_audit',series_import:'series_base'}[mode]??mode);
    if(typeof text!=='string'||!text.trim())throw new TypeError('Message cannot be empty');
    if(Buffer.byteLength(text,'utf8')>60_000)throw new RangeError('Message is too large');
    const importMode=importJobId!==undefined;
    if(importMode&&(mode!=='series_base'||documentId!==undefined||documentVersion!==undefined||documentSnapshot!==undefined||selectedText!==undefined||manuscriptContext!==undefined||!Array.isArray(knowledgePaths)||knowledgePaths.length||!importJobContext))throw requestError(400,'Isolated import rejects draft, selected-text, and knowledge-source context.');
    if(manuscriptContext!==undefined&&(typeof manuscriptContext!=='string'||!manuscriptContext.trim()||manuscriptContext.length>120_000))throw requestError(400,'Manuscript context is invalid or too large.');
    if(!importMode&&importJobContext!==undefined)throw requestError(400,'Import context is server-owned and cannot be supplied for a normal request.');
    let stagedDocument=null;
    if(documentId!==undefined&&documentId!==null) {
      if(typeof documentId!=='string'||!documentId)throw requestError(400,'A valid documentId is required.');
      if(!Number.isSafeInteger(documentVersion)||documentVersion<1)throw requestError(400,'A documentVersion is required for a document-bound message.');
      if(!documentSnapshot||documentSnapshot.id!==documentId||documentSnapshot.version!==documentVersion||typeof documentSnapshot.text!=='string')throw requestError(409,'The document snapshot is missing or stale. Reload it before retrying.');
      stagedDocument={id:documentId,title:documentSnapshot.title,version:documentVersion,text:documentSnapshot.text};
    }
    if(this.inTurn||this.pendingMessage)throw new Error('Wait for the current response or stop it before sending another message.');
    this.pendingMessage=true;let turnStartAttempted=false;
    try {
      let importJob=null;
      if(importMode){importJob=await this._verifyImportJob(importJobId,importJobContext);this.activeImportJobId=importJobId;this.activeThreadProfile='import';this.store.setMessageScope?.(`import:${importJobId}`);}
      else {const leavingImport=this.activeThreadProfile==='import';this.activeImportJobId=null;this.activeThreadProfile='normal';if(leavingImport)this._switchConversationScope(this.normalMessageScopeKey||this.conversationScope);}
      const state=await this.connect({profile:importMode?'import-bootstrap':'normal'}); if(!state.authenticated)throw new Error(state.error||'Sign in with ChatGPT before sending a message.');
      if(model && !this.models.some(item=>item.id===model))throw new Error('The requested model is not present in the account catalog.');
      if(importMode){
        const threadId=await this._ensureImportThread(model,importJob);
        const contract=await this._getRuntimeContract();
        const importSkill=this.nativeSkillStatus.skills.find(s=>s.path.replaceAll('\\','/').toLowerCase().endsWith('/build-series-base/skill.md'));
        if(!importSkill)throw new Error('The required build-series-base native skill is unavailable.');
        const prompt=`ISOLATED SERIES BASE IMPORT JOB\nJob: ${importJob.jobId}\nAuthor pseudonym: ${importJob.authorPseudonym}\nSeries: ${importJob.seriesName}\nStatus: ${importJob.status}\nJob version: ${importJob.jobVersion}\n\nUse only talewisp_import_* tools for this job. Read every source fully via bounded ranges as needed, then produce the complete nine-layer source-grounded analysis using the build-series-base workflow. Run the native prepare/status/finalize/check sequence as required. If a current candidate passes machine checks, request exactly one independent continuity review and save its exact PASS receipt; do not fabricate or rewrite a review. Never publish.\n\nAUTHOR REQUEST:\n${text.trim()}\n\nALLOWLISTED RESOURCES:\n${contract.resources.map(resource=>`${resource.id} | ${resource.title}`).join('\n')}`;
        this.turnText='';this.activeRequestContext={mode:'series_base_import',text:text.trim(),importJob};this._beginTurnLock();turnStartAttempted=true;
        const turnResult=await this.runner.request('turn/start',{threadId,input:[{type:'skill',name:importSkill.name,path:importSkill.path},{type:'text',text:prompt}],cwd:this.workDir,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},...(model?{model}:{})},30_000);
        this.activeTurnId=turnResult.turn?.id??this.activeTurnId;this.store.addMessage('user',text.trim());this._emit('message',{role:'user',text:text.trim()});this._emit('status',this.status());return {accepted:true};
      }
      const chunks=[`AUTHOR REQUEST:\n${text.trim()}`];
      if(manuscriptContext)chunks.push('\n\n'+manuscriptContext);
      if(stagedDocument)chunks.push(`\n\nCURRENT LOCAL DRAFT (${stagedDocument.title}; version ${stagedDocument.version}; author must explicitly apply any proposal):\n${stagedDocument.text}`);
      if(selectedText) { if(typeof selectedText!=='string'||selectedText.length>20_000)throw new RangeError('Selection is too large'); chunks.push(`\n\nSELECTED TEXT:\n${selectedText}`); }
      if(Array.isArray(knowledgePaths)&&knowledgePaths.length) {
        const source=await this.readSources(knowledgePaths.slice(0,8)); chunks.push('\n\nEXPLICITLY SELECTED READ-ONLY SOURCES:\n'+source.map(file=>`[${file.path}; sha256=${file.revision}]\n${file.text}`).join('\n\n'));
      }
      const workspaceContext=await this._workspacePromptContext(mode);
      const contract=await this._getRuntimeContract();
      const resourceManifest=contract.resources.map(resource=>`${resource.id} | ${resource.title} | source sha256=${resource.sourceHash} | content sha256=${resource.hash}`).join('\n');
      const prompt=`TaleWisp writing workspace context follows. Treat the contents as private source material. Only claim that a proposal was prepared when a tool receipt confirms it; claim that it was applied only after a verified UI result. Never invent saves. Cite knowledge cards using [[path|title]] so the workspace can render safe links. Runtime contract version: ${contract.version}. Allowlisted operational resources (read with talewisp_runtime_resource):\n${resourceManifest}\n\n${workspaceContext}\n\n${chunks.join('')}`;
      const threadId=await this._ensureThread(model,mode);
      this.turnText='';this.activeRequestContext={mode,text:text.trim(),selectedText:typeof selectedText==='string'?selectedText:null}; this._beginTurnLock();turnStartAttempted=true;
      const turnResult=await this.runner.request('turn/start',{threadId,input:[...this._nativeSkillInputs(mode),{type:'text',text:prompt}],cwd:this.workDir,approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false},...(model?{model}:{})},30_000);
      this.activeTurnId=turnResult.turn?.id??this.activeTurnId;
      this.store.addMessage('user',text.trim()); this._activeConversation().title=text.trim().slice(0,48);this._activeConversation().updatedAt=new Date().toISOString();this._saveConversations();this._emit('message',{role:'user',text:text.trim(),conversationId:this.activeConversationId}); this._emit('status',this.status());
      return {accepted:true};
    } catch(error) {
      if(turnStartAttempted&&this.inTurn)await this._abortUncertainTurn(error);
      else if(!turnStartAttempted)this._completeTurn();
      this.error=error.message; this._emit('error',{message:this.error}); throw error;
    }
    finally { this.pendingMessage=false; }
  }
  async readSources(paths) { return Promise.all(paths.map(path=>this.sourceReader(path))); }
  async _workspacePromptContext(mode) {
    if(!this.workspaceService)return `ACTIVE WORKSPACE: ${this.vaultPath ?? 'not selected'}\nREQUEST MODE: ${mode ?? 'general conversation'}\nUse only the selected series and sources explicitly read for this turn.`;
    const [catalog,selection,overview]=await Promise.all([this.workspaceService.catalog(),this.workspaceService.selection(),this.workspaceService.overview()]);
    const author=catalog.authors?.find(item=>item.id===selection?.authorId);
    const series=author?.series?.find(item=>item.id===selection?.seriesId);
    const book=series?.books?.find(item=>item.id===selection?.bookId);
    const style=overview?.style??{};
    return [
      `ACTIVE AUTHOR: ${author?.name ?? 'unknown'}`,
      `ACTIVE SERIES: ${series?.name ?? 'unknown'}`,
      `ACTIVE BOOK: ${book?.name ?? 'none selected'}`,
      `REQUEST MODE: ${typeof mode==='string'&&mode.trim()?mode.trim().slice(0,100):'general conversation'}`,
      `AUTHOR STYLE EXCLUDED: ${style.excluded===true?'true':'false'}`,
      `STYLE EXCLUSION REASON: ${typeof style.exclusionReason==='string'&&style.exclusionReason.trim()?style.exclusionReason.trim():'none supplied'}`,
      `APPROVED STYLE PATHS (excluded; do not activate): ${(Array.isArray(style.paths)?style.paths:[]).join(', ')||'none listed'}`,
      `LEXICAL DICTIONARY PATHS (separate from style): ${(Array.isArray(style.lexicalRules)?style.lexicalRules:[]).join(', ')||'none listed'}`,
      `CONFIRMED STYLE RULES: ${style.available===true&&style.excluded!==true?'available only when explicitly selected for this request':'not active; never auto-activate'}`,
      'Use the active series only. Never activate excluded or unselected author style material. Read relevant selected-series canon, editorial rules, glossary and lexical dictionary before producing or revising fiction. Apply only confirmed and applicable style rules; do not calibrate automatically. A file proposal remains pending until the author applies it through the workspace review panel.'
    ].join('\n');
  }
  async setWorkspace({vaultPath,selection,revision}={}) {
    if(this.inTurn||this.pendingMessage)throw new Error('Wait for the current response or stop it before changing workspaces.');
    const previous=this.workspaceSelection;
    const initialStartup=!previous;
    if(initialStartup)await this._getRuntimeContract();
    let sourceOnlySelection=false;
    if(selection?.bookId===null&&this.workspaceService?.catalog) {
      const catalog=await this.workspaceService.catalog();
      const author=catalog.authors?.find(item=>item.id===selection.authorId);
      const series=author?.series?.find(item=>item.id===selection.seriesId);
      if(!series||!Array.isArray(series.books)||series.books.length!==0)throw requestError(409,'A bookless agent workspace is valid only for a series whose current catalog contains no books.');
      sourceOnlySelection=true;
    }
    const same=previous&&selection&&previous.authorId===selection.authorId&&previous.seriesId===selection.seriesId&&previous.bookId===selection.bookId&&this.vaultPath===vaultPath;
    if(same&&this.workspaceRevision===revision)return {changed:false};
    await this.codeReviewService?.cancelAll?.('Workspace changed.');
    await this._cancelNativeConsultation('Workspace changed.');
    const runner=this.runner;
    if(runner) {
      await this.delegationManager?.shutdown?.('Workspace changed.');
      const stopped=await runner.stop?.();
      if(stopped===false&&runner.exited!==true)throw new Error('The old agent runtime did not stop; workspace was not changed.');
      if(runner.exited===true||runner.closed)this.runner=null;
      else if(runner.stop)throw new Error('The old agent runtime did not confirm shutdown; workspace was not changed.');
    }
    this.activeRuntimeProfile=null;this.activeThreadProfile='normal';this.activeImportJobId=null;
    await this.pluginService?.setWorkspace?.();
    this.ephemeralThreadBindings.clear();this.workspaceSelectionBookless=sourceOnlySelection;
    const storedBinding=initialStartup?this._storedThreadBinding():null;
    this.vaultPath=vaultPath??null;this.workspaceSelection=selection??null;this.workspaceSelectionBookless=sourceOnlySelection;this.workspaceRevision=revision??null;
    const storedBindingMatches=initialStartup&&this._threadBindingMatches(storedBinding,{vaultPath:this.vaultPath,selection:this.workspaceSelection,revision:this.workspaceRevision},this.threadId);
    if(storedBindingMatches) this.dynamicToolsVersion=storedBinding.dynamicToolsVersion;
    else {this.threadId=null;this.dynamicToolsVersion=null;this._clearPersistedThreadBinding();}
    this.activeTurnId=null;this.turnText='';this.turnItems.clear();this.error=null;
    this.normalMessageScopeKey=scopeKey(selection);this._switchConversationScope(this.normalMessageScopeKey,{legacyBinding:storedBindingMatches?storedBinding:null});
    const delegationScope=this.store.messageScopeKey??'unassigned';
    if(!this.recoveredDelegationScopes.has(delegationScope))try{recoverDelegationHistory(this.store);this.recoveredDelegationScopes.add(delegationScope);}catch(error){this.error=error?.message??'Delegation history could not be recovered.';}
    this._emit('status',this.status());
    return {changed:true};
  }
  async stop() {
    const manager=this.delegationManager;
    const activeChildren=()=>manager?.status().active.length??0;
    if(!this.inTurn&&!activeChildren()){this._emit('status',this.status());return {stopped:true,running:false};}
    const consultationStop=this.inTurn?await this._cancelNativeConsultation('Parent turn stopped.'):null;
    await this.codeReviewService?.cancelAll?.('Parent turn stopped.');
    await manager?.cancelAll?.('Parent turn stopped.');
    const runner=this.runner;
    let acknowledged=false;
    if(this.inTurn&&runner&&!runner.closed)try{await runner.request('turn/interrupt',{threadId:this.threadId},5_000);acknowledged=true;}catch{}
    if(acknowledged&&this.turnCompletion)await Promise.race([this.turnCompletion,new Promise(resolve=>setTimeout(resolve,STOP_GRACE_MS))]);
    if(!this.inTurn&&activeChildren())await new Promise(resolve=>setTimeout(resolve,STOP_GRACE_MS));
    if(!this.inTurn&&!activeChildren())return {stopped:true,running:false,...(consultationStop?{nativeConsultation:consultationStop}:{})};
    if(!this.inTurn&&activeChildren()) {
      const stopped=await this._stopDelegationRunner(runner,'Child delegation did not confirm cancellation.');
      return {stopped,running:false,childDelegationsRemaining:activeChildren()};
    }
    const stopped=await this._abortUncertainTurn(new Error('Turn cancellation was not confirmed; the app-server is being stopped.'));
    return {stopped,running:this.inTurn,childDelegationsRemaining:activeChildren(),...(consultationStop?{nativeConsultation:consultationStop}:{})};
  }
  async shutdown() { const runner=this.runner;await this.codeReviewService?.cancelAll?.('Agent runtime shut down.');await this._cancelNativeConsultation('Agent runtime shut down.');await this.delegationManager?.shutdown?.('Agent runtime shut down.');await runner?.stop?.();if(this.nativeConsultationService?.waitForIdle)await this.nativeConsultationService.waitForIdle();if(runner?.exited===true){if(this.inTurn)this._clearThreadBinding();this._completeTurn();this.runner=null;} }
}

export const createAgentService = options => new AgentService(options);
