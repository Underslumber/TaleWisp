const TERMINAL = new Set(['completed','failed','cancelled','incomplete','interrupted']);
const key = scope => 'agent.delegations.' + String(scope ?? 'unassigned');
const scopeOf = store => store.messageScopeKey ?? 'unassigned';

export function readDelegationHistory(store,scope=scopeOf(store)) {
  const raw=store.getSetting(key(scope));if(!raw)return [];
  try { const rows=JSON.parse(raw);return Array.isArray(rows)?rows.filter(row=>row&&typeof row.id==='string').slice(-20):[]; }
  catch { throw new Error('Saved delegation history is invalid; its contents were not overwritten.'); }
}

export function recordDelegationEvent(store,event) {
  if(event?.type!=='delegation'||typeof event.id!=='string'||!event.id)return;
  const rows=readDelegationHistory(store),index=rows.findIndex(row=>row.id===event.id);
  const previous=index<0?{}:rows[index];
  const status=event.phase==='started'?'running':event.phase;
  const row={...previous,id:event.id,role:event.role??previous.role,model:event.model??previous.model,effort:event.effort??previous.effort,status,
    threadId:event.threadId??previous.threadId??null,
    startedAt:event.startedAt??previous.startedAt??null,
    completedAt:event.completedAt??previous.completedAt??null,
    ...(event.importReviewBinding!==undefined?{importReviewBinding:event.importReviewBinding}:previous.importReviewBinding!==undefined?{importReviewBinding:previous.importReviewBinding}:{}),
    ...(event.importReviewReadAudit!==undefined?{importReviewReadAudit:event.importReviewReadAudit}:previous.importReviewReadAudit!==undefined?{importReviewReadAudit:previous.importReviewReadAudit}:{}),
    ...(event.result!==undefined?{result:event.result}:{}),...(event.error!==undefined?{error:event.error}:{})};
  if(index<0)rows.push(row);else rows[index]=row;
  store.setSetting(key(scopeOf(store)),JSON.stringify(rows.slice(-20)));
}

export function recoverDelegationHistory(store) {
  const rows=readDelegationHistory(store);let changed=false;
  for(const row of rows)if(!TERMINAL.has(row.status)){
    row.status='interrupted';row.error='Сервер перезапущен; завершение этого запуска не подтверждено.';changed=true;
  }
  if(changed)store.setSetting(key(scopeOf(store)),JSON.stringify(rows));
  return rows;
}

export function mergeDelegationHistory(saved,live) {
  const rows=new Map(saved.map(row=>[row.id,row]));
  for(const row of [...(live?.recent??[]),...(live?.active??[])])rows.set(row.id,row);
  return [...rows.values()].slice(-20);
}
