"""Version-bound prelaunch control. Not an OS sandbox or a global tool interceptor."""
from __future__ import annotations
import hashlib
import json
import re
from typing import Any, Callable
from .core import Controller, WardenError, _json

_CRITICAL_RISK_CATEGORIES = {
    'authorization', 'secrets', 'data_loss', 'migration', 'concurrency',
    'service_lifecycle', 'deploy',
}


def _validate_claude_gate(packet: str, tid: str) -> None:
    """Require the same explicit critical/final gate as ClaudeReviewer."""
    first_line = packet.splitlines()[0] if packet.splitlines() else ''
    prefix = 'CLAUDE_GATE:'
    if not first_line.startswith(prefix):
        raise WardenError('Claude review packet first line must be CLAUDE_GATE: followed by JSON')
    raw_gate = first_line[len(prefix):].strip()
    try:
        gate = json.loads(raw_gate)
    except json.JSONDecodeError as exc:
        raise WardenError('CLAUDE_GATE must contain valid JSON') from exc
    if not isinstance(gate, dict):
        raise WardenError('CLAUDE_GATE must be a JSON object')
    for field in ('task_id', 'scope', 'reason'):
        value = gate.get(field)
        if not isinstance(value, str) or not value.strip():
            raise WardenError(f'CLAUDE_GATE {field} must be a non-empty string')
    if gate['task_id'] != tid:
        raise WardenError('CLAUDE_GATE task_id does not match dispatched task')
    if gate.get('kind') == 'critical':
        risk_category = gate.get('risk_category')
        if not isinstance(risk_category, str) or risk_category not in _CRITICAL_RISK_CATEGORIES:
            raise WardenError('CLAUDE_GATE critical risk_category is not allowed')
        action = gate.get('impending_action')
        if not isinstance(action, str) or not action.strip():
            raise WardenError('CLAUDE_GATE critical impending_action must be a non-empty string')
    elif gate.get('kind') == 'final':
        if gate.get('completed') is not True:
            raise WardenError('CLAUDE_GATE final completed must be true')
        evidence = gate.get('evidence')
        if not isinstance(evidence, str) or not evidence.strip():
            raise WardenError('CLAUDE_GATE final evidence must be a non-empty string')
    else:
        raise WardenError("CLAUDE_GATE kind must be 'critical' or 'final'")

def digest(value: Any) -> str:
    return hashlib.sha256(_json(value).encode('utf-8')).hexdigest()

def validate_contract(contract: Any) -> None:
    if not isinstance(contract, dict) or set(contract) != {'context_id', 'roles'}:
        raise WardenError('dispatch requires context_id and roles')
    if not isinstance(contract['context_id'], str) or not contract['context_id'].strip():
        raise WardenError('dispatch context_id required')
    roles=contract['roles']
    if not isinstance(roles, dict) or not roles:
        raise WardenError('dispatch roles required')
    for role, spec in roles.items():
        if not isinstance(role,str) or not re.fullmatch(r'[a-z][a-z0-9_]{0,63}',role):
            raise WardenError('invalid dispatch role')
        if not isinstance(spec,dict) or set(spec)!={'provider','model','effort','purpose','input_kind','instruction'}:
            raise WardenError('dispatch role contract fields invalid')
        if any(not isinstance(v,str) or not v.strip() for v in spec.values()):
            raise WardenError('dispatch role strings required')
        if spec['provider'] not in {'codex','claude','openai'} or not re.fullmatch(r'[A-Za-z0-9_.-]+',spec['model']):
            raise WardenError('unsupported provider or unsafe model')
        if spec['effort'] not in {'none','low','medium','high','xhigh','max'}:
            raise WardenError('unsupported effort')
        if spec['input_kind'] not in {'leader','hero','npc','writer','writer_revision','production_writer','review','instrument'}:
            raise WardenError('unsupported input kind')
        if spec['provider']=='claude' and (spec['model']!='opus' or spec['input_kind']!='review' or spec['effort']!='none'):
            raise WardenError('Claude route is packet-only Opus review')

def _check(ctrl: Controller, tid: str, token: str, version: int, request: dict) -> dict:
    ctrl._auth(tid,'executor',token)
    row=ctrl._task(tid)
    if type(version) is not int or version!=row['version']:
        raise WardenError('stale requirements version')
    if row['state']!='ACTIVE':
        raise WardenError('dispatch requires ACTIVE task')
    req=json.loads(row['requirements'])
    if 'dispatch' not in req:raise WardenError('task has no dispatch contract')
    validate_contract(req['dispatch'])
    keys={'id','role','provider','model','effort','purpose','input_file','input_sha256','requirements_sha256'}
    if not isinstance(request,dict) or set(request)!=keys or any(not isinstance(x,str) for x in request.values()):
        raise WardenError('dispatch request fields invalid')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}',request['id']):raise WardenError('unsafe dispatch id')
    if request['requirements_sha256']!=digest(req):raise WardenError('literal requirements changed')
    spec=req['dispatch']['roles'].get(request['role'])
    if spec is None:raise WardenError('role not authorized by task')
    for key in ('provider','model','effort','purpose'):
        if request[key]!=spec[key]:raise WardenError('dispatch '+key+' does not match authorized role')
    path, fp=ctrl._scoped_artifact(tid,request['input_file'])
    raw=path.read_bytes()
    if len(raw)>1_000_000:raise WardenError('dispatch input exceeds limit')
    if hashlib.sha256(raw).hexdigest()!=fp or fp!=request['input_sha256']:
        raise WardenError('dispatch input changed')
    text=raw.decode('utf-8');kind=spec['input_kind']
    if kind=='review':
        comparison=text.replace('\r\n','\n').replace('\r','\n')
        goal=req['goal'].replace('\r\n','\n').replace('\r','\n')
        if len(text)>200000:
            raise WardenError('review packet exceeds 200000 characters')
        if spec['provider']=='claude':
            _validate_claude_gate(comparison, tid)
        if not all(x in comparison for x in ('REQUIREMENTS:','ACTUAL DIFF/SOURCE:','CHECKS:',goal)):
            raise WardenError('review packet missing literal task or sections')
    else:
        data=json.loads(text)
        if not isinstance(data,dict):raise WardenError('dispatch JSON input must be an object')
        if data.get('session_id')!=req['dispatch']['context_id']:
            raise WardenError('input belongs to another scene/task context')
        if kind in {'leader','hero','npc'}:
            b=data.get('packet_binding',{})
            if data.get('role')!=kind or b.get('actor_id')!=data.get('actor_id') or b.get('session_id')!=data['session_id'] or b.get('source_fingerprint')!=data.get('source_fingerprint') or b.get('based_on_revision')!=data.get('based_on_revision'):
                raise WardenError('actor input role/binding mismatch')
        elif kind=='writer' and data.get('schema')!='logical-v3-writer-input':
            raise WardenError('writer input schema mismatch')
        elif kind=='production_writer':
            if (data.get('schema') != 'production-fiction-input'
                    or data.get('mode') != 'production'
                    or data.get('source_resolution') != 'complete'
                    or not isinstance(data.get('request'), str) or not data['request'].strip()
                    or not isinstance(data.get('sources'), list) or not data['sources']):
                raise WardenError('production writer needs complete ordinary-production input and sources')
        elif kind=='writer_revision':
            nested=data.get('writer_input',{})
            if data.get('schema')!='logical-v3-writer-revision' or not isinstance(data.get('draft'),str) or not data['draft'].strip() or not isinstance(nested,dict) or nested.get('schema')!='logical-v3-writer-input' or nested.get('session_id')!=data['session_id']:
                raise WardenError('revision needs actual draft and same-scene frozen writer input')
        elif kind=='instrument' and data.get('schema')!='instrument-repair-input':
            raise WardenError('instrument route cannot receive a creative role packet')
    prompt='AUTHOR TASK (literal, authoritative):\n'+req['goal']+'\n\nROLE PURPOSE:\n'+spec['purpose']+'\n\n'+spec['instruction']+'\n\nCOMPLETE INPUT:\n'+text
    return {'task':tid,'version':version,'requirements_sha256':digest(req),'request':request,
            'request_sha256':digest(request),'input_sha256':fp,'spec':spec,'prompt':prompt}

def dispatch(ctrl: Controller, tid: str, token: str, version: int, request: dict,
             launcher: Callable[[dict],Any]) -> dict:
    """Validate and create the process atomically before releasing the task lock.

    launcher is trusted host code, never supplied by an executor's job JSON.
    The returned handle performs waiting/collection outside the SQLite lock.
    """
    request=json.loads(_json(request))
    ctrl.con.execute('CREATE TABLE IF NOT EXISTS dispatch_run(task_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, request_sha256 TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(task_id,id))')
    ctrl.con.commit()
    error=None;handle=None;binding=None
    with ctrl._write():
        try:
            binding=_check(ctrl,tid,token,version,request)
            if ctrl.con.execute('SELECT 1 FROM dispatch_run WHERE task_id=? AND id=?',(tid,request['id'])).fetchone():
                raise WardenError('dispatch id already consumed')
        except (WardenError,ValueError,OSError,UnicodeError) as exc:
            error=str(exc)
            ctrl._event(tid,'executor','dispatch_denied',{'version':version,'role':request.get('role') if isinstance(request,dict) else None,'reason':error})
        if error is None:
            safe={k:v for k,v in binding.items() if k not in {'prompt','spec'}}
            ctrl.con.execute('INSERT INTO dispatch_run VALUES(?,?,?,?,?,?)',(tid,request['id'],version,binding['request_sha256'],'STARTING',_json(safe)))
            ctrl._event(tid,'executor','dispatch_preflight',{'decision':'ALLOW',**safe})
            try:
                handle=launcher(binding)
                ctrl.con.execute('UPDATE dispatch_run SET state=? WHERE task_id=? AND id=?',('RUNNING',tid,request['id']))
                ctrl._event(tid,'executor','dispatch_started',{'id':request['id'],'model':request['model'],'pid':handle.pid})
            except Exception as exc:
                error='native launch failed: '+str(exc)
                ctrl.con.execute('UPDATE dispatch_run SET state=? WHERE task_id=? AND id=?',('FAILED',tid,request['id']))
                ctrl._event(tid,'executor','dispatch_failed',{'id':request['id'],'reason':error})
    if error is not None:raise WardenError(error)
    try:
        result=handle.result()
        with ctrl._write():
            row=ctrl._task(tid)
            if row['version']!=version or row['state']!='ACTIVE' or digest(json.loads(row['requirements']))!=binding['requirements_sha256']:
                raise WardenError('task changed while agent was running; result not accepted')
            receipt={k:v for k,v in binding.items() if k not in {'prompt','spec'}}
            receipt.update(result=result,state='COMPLETED')
            ctrl.con.execute('UPDATE dispatch_run SET state=?,receipt=? WHERE task_id=? AND id=?',('COMPLETED',_json(receipt),tid,request['id']))
            ctrl._event(tid,'executor','dispatch_completed',{'id':request['id'],'model':request['model']})
        return receipt
    except Exception as exc:
        with ctrl._write():
            ctrl.con.execute('UPDATE dispatch_run SET state=? WHERE task_id=? AND id=?',('FAILED',tid,request['id']))
            ctrl._event(tid,'executor','dispatch_failed',{'id':request['id'],'reason':str(exc)})
        raise
