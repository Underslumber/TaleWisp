"""Read-only completion inspection; observing a stop is not a repair attempt."""
from __future__ import annotations
import json
from typing import Any
from .core import Controller, WardenError


def inspect_completion(controller: Controller, tid: str, executor_token: str,
                       expected_version: int) -> dict[str, Any]:
    con = controller.con
    if con.in_transaction:
        raise WardenError('completion inspection requires an independent read transaction')
    con.execute('BEGIN')
    try:
        controller._auth(tid, 'executor', executor_token)
        task = controller._task(tid)
        if task['version'] != expected_version:
            raise WardenError('version conflict; reload before inspection')
        state = task['state']
        gaps = []
        req = json.loads(task['requirements'])
        for criterion in req['criteria']:
            if not criterion['mandatory']:
                continue
            ev = con.execute('SELECT * FROM evidence WHERE task_id=? AND criterion=?', (tid, criterion['id'])).fetchone()
            rv = con.execute('SELECT * FROM review WHERE task_id=? AND criterion=?', (tid, criterion['id'])).fetchone()
            valid = bool(ev and rv and ev['version'] == task['version'] and rv['version'] == task['version']
                         and rv['verdict'] == 'ACCEPT' and ev['fingerprint'] == rv['fingerprint'])
            if valid and rv['reviewer'].startswith('gemini:'):
                valid = controller._semantic_audit_current(tid, task['version'])
            if valid:
                try:
                    _, fingerprint = controller._scoped_artifact(tid, ev['relpath'])
                    valid = fingerprint == ev['fingerprint']
                except (OSError, WardenError):
                    valid = False
            if not valid:
                gaps.append(criterion['id'])
        if state in {'PAUSED', 'CANCELLED'}:
            decision, reason = state, 'explicit owner stop remains authoritative'
        elif not gaps and state == 'ACCEPTED':
            state, decision, reason = 'ACCEPTED', 'ACCEPT', 'all mandatory criteria have current reviewed evidence'
        elif not gaps:
            decision = state if state in {'BLOCKED', 'INVESTIGATION'} else 'CONTINUE'
            reason = 'current reviewed evidence is ready; authoritative controller acceptance is still required'
        else:
            state = 'ACTIVE' if state == 'ACCEPTED' else state
            decision = state if state in {'BLOCKED', 'INVESTIGATION'} else 'CONTINUE'
            reason = 'missing current reviewed evidence: ' + ', '.join(gaps)
        return {'task': tid, 'state': state, 'decision': decision, 'reason': reason,
                'version': task['version'], 'attempts': task['attempts'], 'gaps': gaps}
    finally:
        con.rollback()
