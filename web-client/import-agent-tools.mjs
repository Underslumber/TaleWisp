const tool=(name,description,properties,required)=>({name,description,type:'function',inputSchema:{type:'object',properties,required,additionalProperties:false}});
const jobId={type:'string',minLength:36,maxLength:36};
export const IMPORT_AGENT_TOOLS=Object.freeze([
  tool('talewisp_import_status','Read the actual state and exact source/candidate inventory of the active isolated import job. This does not publish or alter author data.',{jobId},['jobId']),
  tool('talewisp_import_run','Run the authoritative native importer prepare/status/finalize/check/accept step in the isolated job only. Accept requires actual machine checks and a separately verified independent review. This never publishes to the knowledge catalog.',{jobId,action:{type:'string',enum:['prepare','status','finalize','check','accept']}},['jobId','action']),
  tool('talewisp_import_read','Read one exact allowlisted source or candidate from this job. For large text use explicit startChar/maxChars; read every required part before claiming full coverage. The response reports source hash, range and completeness.',{jobId,path:{type:'string',minLength:1,maxLength:1000},startChar:{type:'integer',minimum:0},maxChars:{type:'integer',minimum:1,maximum:64000}},['jobId','path']),
  tool('talewisp_import_analysis','Save the complete source-grounded nine-layer analysis JSON in this isolated job. No author file or profile is changed. Follow the full build-series-base analysis schema.',{jobId,analysis:{type:'object'}},['jobId','analysis']),
  tool('talewisp_import_review','Save an independent review of the current candidate, backed by the actual completed reviewer receipt. Parent-authored PASS, reused receipt from another job, and stale candidate hashes are rejected.',{jobId,review:{type:'object'}},['jobId','review'])
]);
const names=new Set(IMPORT_AGENT_TOOLS.map(item=>item.name));
export function createImportAgentTools({service,getActiveJobId}) {
  return async function callImportTool(name,args){
    if(!names.has(name))throw new Error('Import tool is not permitted.');
    const expected=IMPORT_AGENT_TOOLS.find(item=>item.name===name).inputSchema;
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(expected.properties,key))||expected.required.some(key=>!Object.hasOwn(args,key)))throw new Error('Import tool arguments do not match the allowed schema.');
    if(typeof args.jobId!=='string'||args.jobId!==getActiveJobId())throw new Error('Import tool is outside the active job.');
    if(name==='talewisp_import_status')return {job:await service.status(args.jobId),inventory:await service.inventory(args.jobId)};
    if(name==='talewisp_import_run')return service.run({jobId:args.jobId,action:args.action});
    if(name==='talewisp_import_read')return service.read(args.jobId,args.path,{startChar:args.startChar,maxChars:args.maxChars});
    if(name==='talewisp_import_analysis')return service.saveAnalysis(args.jobId,args.analysis);
    return service.saveReview(args.jobId,args.review);
  };
}

export function verifyImportReviewReceipt({history,jobId,sessionId,candidateSha256,review}){
  if(!review||typeof review.receiptId!=='string')return false;
  const receipt=history.find(row=>row.id===review.receiptId);
  if(!receipt||receipt.status!=='completed'||receipt.role!=='continuity_reviewer'||!receipt.threadId||typeof receipt.result!=='string')return false;
  let observed;try{observed=JSON.parse(receipt.result.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{return false;}
  if(observed?.status!=='PASS'||observed.review_type!=='independent'||observed.session_id!==sessionId||observed.candidate_sha256!==candidateSha256||observed.jobId!==jobId)return false;
  const binding=receipt.importReviewBinding;
  const audit=receipt.importReviewReadAudit;
  if(!binding||binding.jobId!==jobId||binding.sessionId!==sessionId||binding.candidateSha256!==candidateSha256||!Array.isArray(binding.requiredManifest)||!binding.requiredManifest.length||!Array.isArray(binding.excludedManifest))return false;
  if(!audit||!Number.isSafeInteger(audit.calls)||audit.calls<1||audit.calls>64||audit.attempts!==audit.calls||!Number.isSafeInteger(audit.chars)||audit.chars<0||audit.chars>2_000_000||!Array.isArray(audit.reads)||audit.reads.length!==audit.calls)return false;
  const required=new Map();
  for(const file of binding.requiredManifest){
    if(!file||typeof file.path!=='string'||!file.path||typeof file.sha256!=='string'||!Number.isSafeInteger(file.bytes)||file.bytes<0||required.has(file.path))return false;
    required.set(file.path,{sha256:file.sha256,bytes:file.bytes});
  }
  for(const file of binding.excludedManifest)if(!file||typeof file.path!=='string'||!file.path||typeof file.sha256!=='string'||!Number.isSafeInteger(file.bytes)||file.bytes<0||typeof file.reason!=='string'||!file.reason||required.has(file.path))return false;
  const readsByPath=new Map();let readChars=0;
  for(const read of audit.reads){
    const file=required.get(read?.path);
    if(!file||read.sha256!==file.sha256||!Number.isSafeInteger(read.startChar)||read.startChar<0||!Number.isSafeInteger(read.endChar)||read.endChar<read.startChar||!Number.isSafeInteger(read.totalChars)||read.totalChars<0||read.totalChars>file.bytes||!Number.isSafeInteger(read.charCount)||read.charCount<0||read.endChar-read.startChar!==read.charCount||read.endChar>read.totalChars||typeof read.eof!=='boolean'||typeof read.complete!=='boolean'||read.eof!==(read.endChar===read.totalChars)||read.complete!==(read.startChar===0&&read.eof))return false;
    readChars+=read.charCount;
    if(readChars>2_000_000)return false;
    const pathReads=readsByPath.get(read.path)??[];pathReads.push(read);readsByPath.set(read.path,pathReads);
  }
  if(readChars!==audit.chars)return false;
  for(const [path,file] of required){
    const reads=(readsByPath.get(path)??[]).slice().sort((a,b)=>a.startChar-b.startChar||a.endChar-b.endChar);
    if(!reads.length)return false;
    const totalChars=reads[0].totalChars;
    let cursor=0,sawEof=false;
    for(const read of reads){
      if(read.totalChars!==totalChars||read.startChar>cursor)return false;
      if(read.endChar>cursor)cursor=read.endChar;
      if(read.eof)sawEof=true;
    }
    if(cursor!==totalChars||!sawEof)return false;
  }
  // Store exactly the review the independent child returned; the parent may only
  // attach the host-issued receipt ID, never rewrite coverage or findings.
  const {receiptId,...submitted}=review;
  const stable=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]))):value;
  return JSON.stringify(stable(observed))===JSON.stringify(stable(submitted));
}
