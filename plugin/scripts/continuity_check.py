"""Read-only, listed-record continuity audit; never a universal prose gate."""
from pathlib import Path, PureWindowsPath
from collections import Counter
import hashlib
import json
import math

MAX_BYTES = 2 * 1024 * 1024
MAX_RECORDS = 5000
KINDS = {'death', 'revival', 'appearance', 'mention', 'promise_setup',
         'promise_payoff', 'learn', 'reveal', 'knowledge_use', 'reader_use'}
COLLECTIONS = ('scenes', 'entities', 'facts', 'assertions')


class ContinuityError(ValueError):
    pass


def safe_path(root, value):
    if not isinstance(value, str) or not value.strip():
        raise ContinuityError('A nonempty vault-relative path is required')
    portable = value.replace('\\', '/')
    p = Path(portable)
    if p.is_absolute() or PureWindowsPath(value).drive or '..' in p.parts:
        raise ContinuityError('Path must stay inside the active vault')
    try:
        resolved = (root / p).resolve()
    except (OSError, ValueError, RuntimeError) as exc:
        raise ContinuityError('Cannot resolve vault path safely') from exc
    if not resolved.is_relative_to(root):
        raise ContinuityError('Resolved path escapes the active vault')
    return resolved


def read_bounded(path):
    with path.open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ContinuityError('File exceeds 2 MiB limit')
    return data


def order(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


class Contract:
    def __init__(self, root, path):
        self.root = Path(root).resolve()
        self.findings = []
        self.hashes = {}
        self.sources = {}
        self.source_bytes = 0
        self.coverage = {'scope': 'listed_records_only', 'collections': {}, 'skipped': []}
        try:
            p = safe_path(self.root, path)
            raw = read_bounded(p)
            self.contract_sha256 = hashlib.sha256(raw).hexdigest()
            data = json.loads(raw.decode('utf-8-sig'))
        except (OSError, UnicodeError, ValueError, RecursionError) as exc:
            raise ContinuityError(f'Cannot read continuity contract: {exc}') from exc
        self.records = {k: {} for k in COLLECTIONS}
        if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1:
            self.issue('INCOMPLETE', 'contract_version', 'contract', 'Expected an object with version 1')
            data = {}
        total = 0
        for name in COLLECTIONS:
            rows = data.get(name)
            if not isinstance(rows, list):
                self.issue('INCOMPLETE', 'missing_collection', name, 'Required collection must be a list')
                rows = []
            total += len(rows)
            if total > MAX_RECORDS:
                raise ContinuityError('Contract exceeds 5000 total records')
            ids = Counter(r.get('id') for r in rows if isinstance(r, dict) and isinstance(r.get('id'), str))
            self.coverage['collections'][name] = {'listed': len(rows), 'trusted': 0}
            for i, row in enumerate(rows):
                address = f'{name}[{i}]'
                if not isinstance(row, dict):
                    self.issue('INCOMPLETE', 'invalid_record', address, 'Record must be an object')
                    continue
                rid = row.get('id')
                if not isinstance(rid, str) or not rid.strip() or ids[rid] != 1:
                    self.issue('INCOMPLETE', 'invalid_id', address, 'ID must be a unique nonempty string within collection')
                    continue
                address = f'{name}:{rid}'
                status = row.get('status')
                if status in ('draft', 'proposal'):
                    self.coverage['skipped'].append({'record': address, 'reason': status})
                    self.issue('INCOMPLETE', 'unconfirmed', address, 'Draft/proposal excluded from trusted checks')
                    continue
                if status != 'confirmed':
                    self.issue('INCOMPLETE', 'invalid_status', address, 'Expected confirmed, draft or proposal')
                    continue
                if not self.evidence(row.get('evidence'), address):
                    continue
                if name == 'scenes' and not all(order(row.get(k)) for k in ('story_order', 'narrative_order')):
                    self.issue('INCOMPLETE', 'unknown_order', address, 'Both finite numeric story_order and narrative_order are required; booleans forbidden', row)
                    continue
                if name == 'facts' and (not isinstance(row.get('text'), str) or not row['text'].strip() or row.get('truth') not in ('true', 'false', 'unknown')):
                    self.issue('INCOMPLETE', 'invalid_fact', address, 'Fact needs nonempty text and truth true/false/unknown', row)
                    continue
                if name == 'assertions' and (not isinstance(row.get('kind'), str) or row['kind'] not in KINDS):
                    self.issue('INCOMPLETE', 'invalid_kind', address, 'Unknown assertion kind', row)
                    continue
                self.records[name][rid] = row
        if not any(self.coverage['collections'][k]['listed'] for k in COLLECTIONS):
            self.issue('INCOMPLETE', 'empty_contract', 'contract', 'No listed records to audit')
        # References depend on fully validated, current sources; malformed rows are never trusted.
        assertions = self.records['assertions']
        for rid, a in list(assertions.items()):
            needed = [('scene_id', 'scenes')]
            if a['kind'] in {'death', 'revival', 'appearance', 'mention', 'learn', 'knowledge_use'}:
                needed.append(('entity_id', 'entities'))
            if a['kind'] in {'learn', 'reveal', 'knowledge_use', 'reader_use'}:
                needed.append(('fact_id', 'facts'))
            valid = True
            for field, target in needed:
                ref = a.get(field)
                if not isinstance(ref, str) or ref not in self.records[target]:
                    self.issue('INCOMPLETE', 'missing_reference', f'assertions:{rid}', f'{field} must reference a trusted {target} record', a)
                    valid = False
            if a['kind'].startswith('promise_') and (not isinstance(a.get('promise_id'), str) or not a['promise_id'].strip()):
                self.issue('INCOMPLETE', 'missing_reference', f'assertions:{rid}', 'promise_id must be a nonempty explicit string', a)
                valid = False
            if not valid:
                del assertions[rid]
        for name in COLLECTIONS:
            self.coverage['collections'][name]['trusted'] = len(self.records[name])

    def issue(self, severity, code, record, message, row=None):
        item = {'severity': severity, 'code': code, 'record': record, 'message': message}
        if row and isinstance(row.get('evidence'), dict):
            item['evidence'] = row['evidence']
        self.findings.append(item)

    def evidence(self, ev, address):
        if not isinstance(ev, dict) or not isinstance(ev.get('sha256'), str) or len(ev['sha256']) != 64 or any(c not in '0123456789abcdef' for c in ev['sha256']) or not isinstance(ev.get('quote'), str) or not ev['quote']:
            self.issue('INCOMPLETE', 'missing_evidence', address, 'Evidence requires path, raw-byte SHA256 and nonempty exact quote')
            return False
        try:
            path = safe_path(self.root, ev.get('path'))
            if path not in self.sources:
                if self.source_bytes + path.stat().st_size > 16 * MAX_BYTES:
                    raise ContinuityError('Evidence exceeds 32 MiB total read budget')
                raw = read_bounded(path)
                self.source_bytes += len(raw)
                if self.source_bytes > 16 * MAX_BYTES:
                    raise ContinuityError('Evidence exceeds 32 MiB total read budget')
                self.sources[path] = (hashlib.sha256(raw).hexdigest(), raw.decode('utf-8-sig'))
            digest, source = self.sources[path]
            self.hashes[ev['path']] = digest
            if digest != ev['sha256']:
                self.issue('INCOMPLETE', 'stale_evidence', address, 'Source hash changed; refresh evidence before checking', {'evidence': ev})
                return False
            if ev['quote'] not in source:
                self.issue('INCOMPLETE', 'missing_quote', address, 'Exact quote is absent from current UTF-8 source', {'evidence': ev})
                return False
        except (OSError, UnicodeError, ContinuityError) as exc:
            self.issue('INCOMPLETE', 'unreadable_evidence', address, str(exc), {'evidence': ev})
            return False
        return True

    def time(self, assertion, axis):
        return self.records['scenes'][assertion['scene_id']][axis]

    def related(self, kind, field, value):
        return [a for a in self.records['assertions'].values() if a['kind'] == kind and a.get(field) == value]

    def prerequisites(self, a, candidates, axis, code):
        before = [b for b in candidates if self.time(b, axis) < self.time(a, axis)]
        if before:
            return
        if any(self.time(b, axis) == self.time(a, axis) for b in candidates):
            self.issue('INCOMPLETE', 'ambiguous_order', 'assertions:' + a['id'], 'Same-scene/tied order cannot establish prior ' + code, a)
        elif candidates:
            self.issue('FAIL', code, 'assertions:' + a['id'], 'Use/payoff precedes every recorded prerequisite on ' + axis, a)
        else:
            self.issue('INCOMPLETE', 'missing_prerequisite', 'assertions:' + a['id'], 'No trusted recorded prerequisite for ' + code, a)

    def audit(self):
        for a in self.records['assertions'].values():
            kind = a['kind']
            if kind == 'appearance':
                transitions = [b for b in self.records['assertions'].values() if b['kind'] in ('death', 'revival') and b['entity_id'] == a['entity_id'] and self.time(b, 'story_order') <= self.time(a, 'story_order')]
                if transitions:
                    last_time = max(self.time(b, 'story_order') for b in transitions)
                    last = [b for b in transitions if self.time(b, 'story_order') == last_time]
                    if last_time == self.time(a, 'story_order') or len(last) > 1:
                        self.issue('INCOMPLETE', 'ambiguous_life_state', 'assertions:' + a['id'], 'Tied transition/appearance order cannot establish life state', a)
                    elif last[0]['kind'] == 'death':
                        self.issue('FAIL', 'appearance_after_death', 'assertions:' + a['id'], 'Live appearance follows recorded death without recorded revival', a)
            elif kind == 'promise_payoff':
                self.prerequisites(a, self.related('promise_setup', 'promise_id', a['promise_id']), 'narrative_order', 'payoff_before_setup')
            elif kind == 'knowledge_use':
                learned = [b for b in self.related('learn', 'fact_id', a['fact_id']) if b['entity_id'] == a['entity_id']]
                self.prerequisites(a, learned, 'story_order', 'knowledge_before_learning')
            elif kind == 'reader_use':
                self.prerequisites(a, self.related('reveal', 'fact_id', a['fact_id']), 'narrative_order', 'reader_use_before_reveal')
        return self.result()

    def result(self):
        severities = {f['severity'] for f in self.findings}
        return {'status': 'FAIL' if 'FAIL' in severities else 'INCOMPLETE' if 'INCOMPLETE' in severities else 'PASS_LISTED_RECORDS',
                'coverage': self.coverage, 'findings': self.findings,
                'contract_sha256': self.contract_sha256, 'source_hashes': self.hashes}

    def knowledge(self, scene_id, entity_id):
        if not isinstance(scene_id, str) or scene_id not in self.records['scenes'] or not isinstance(entity_id, str) or entity_id not in self.records['entities']:
            raise ContinuityError('scene_id and entity_id must reference trusted records')
        scene = self.records['scenes'][scene_id]
        self.audit()
        known, reader = {}, {}
        for a in self.records['assertions'].values():
            if a['kind'] == 'learn' and a['entity_id'] == entity_id and self.time(a, 'story_order') < scene['story_order']:
                known.setdefault(a['fact_id'], []).append(a['evidence'])
            elif a['kind'] == 'learn' and a['entity_id'] == entity_id and a['scene_id'] != scene_id and self.time(a, 'story_order') == scene['story_order']:
                self.issue('INCOMPLETE', 'ambiguous_knowledge_boundary', 'assertions:' + a['id'], 'Learning in a different scene tied on story_order cannot establish start-of-scene access')
            if a['kind'] == 'reveal' and self.time(a, 'narrative_order') < scene['narrative_order']:
                reader.setdefault(a['fact_id'], []).append(a['evidence'])
            elif a['kind'] == 'reveal' and a['scene_id'] != scene_id and self.time(a, 'narrative_order') == scene['narrative_order']:
                self.issue('INCOMPLETE', 'ambiguous_reader_boundary', 'assertions:' + a['id'], 'Reveal in a different scene tied on narrative_order cannot establish start-of-scene access')
        def project(items):
            def reference(ev):
                return {k: ev[k] for k in ('path', 'sha256')}
            return [dict(id=fid, text=self.records['facts'][fid]['text'], truth=self.records['facts'][fid]['truth'],
                         evidence=reference(self.records['facts'][fid]['evidence']),
                         access_evidence=[reference(ev) for ev in items[fid]]) for fid in sorted(items)]
        result = self.result()
        # Diagnostics must not leak untrusted or future-only source quotes to the writer.
        result['findings'] = [{k: v for k, v in finding.items() if k != 'evidence'} for finding in self.findings]
        result.update({'scene_id': scene_id, 'entity_id': entity_id, 'boundary': 'start_of_scene',
                       'known_to_character': project(known), 'reader_known': project(reader),
                       'character_only_do_not_reveal': project({k: v for k, v in known.items() if k not in reader}),
                       'omitted': [{'fact_id': k, 'reason': 'no_trusted_prior_access'} for k in sorted(self.records['facts']) if k not in known and k not in reader]})
        return result


def dispatch(root, action, args):
    if not isinstance(args, dict):
        raise ContinuityError('Arguments must be an object')
    contract = Contract(root, args.get('contract_path'))
    if action == 'check':
        return contract.audit()
    if action == 'knowledge':
        return contract.knowledge(args.get('scene_id'), args.get('entity_id'))
    raise ContinuityError('Unknown continuity action')
