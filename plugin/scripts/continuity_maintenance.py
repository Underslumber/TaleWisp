"""Bounded, read-only maintenance of explicitly listed continuity contracts."""
import hashlib
import importlib.util
import json
from collections import Counter, defaultdict, deque
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('maintenance_rules', Path(__file__).with_name('continuity_check.py'))
rules = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rules)
ContinuityError = rules.ContinuityError
MAX_CONTRACTS = 32
MAX_SOURCES = 256
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_TOTAL_RECORDS = 10000
MAX_EDGES = 100000


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class Reads:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.cache = {}
        self.total = 0

    def path(self, value):
        p = rules.safe_path(self.root, value)
        # Windows alternate streams are not independent vault files.
        if ':' in value.replace('\\', '/'):
            raise ContinuityError('Alternate streams are not allowed')
        return p, p.relative_to(self.root).as_posix()

    def read(self, value):
        p, rel = self.path(value)
        if rel not in self.cache:
            if len(self.cache) >= MAX_SOURCES:
                raise ContinuityError('Maintenance exceeds 256 distinct files')
            try:
                size = p.stat().st_size
                if size > rules.MAX_BYTES or self.total + size > MAX_TOTAL_BYTES:
                    raise ContinuityError('Maintenance file or 64 MiB total read bound exceeded')
                raw = rules.read_bounded(p)
                self.total += len(raw)
                if self.total > MAX_TOTAL_BYTES:
                    raise ContinuityError('Maintenance exceeds 64 MiB total read bound')
                value = {'sha256': sha(raw), 'raw': raw}
                try:
                    value['text'] = raw.decode('utf-8-sig')
                except UnicodeError as exc:
                    value['error'] = str(exc)
            except OSError as exc:
                value = {'sha256': None, 'error': str(exc)}
            self.cache[rel] = value
        return rel, self.cache[rel]


def inspect_evidence(reads, ev):
    if not isinstance(ev, dict):
        return {'state': 'missing_evidence', 'source_path': None, 'actual_sha256': None}
    rel = None
    source = None
    if ev.get('path') is not None:
        rel, source = reads.read(ev['path'])
    expected = ev.get('sha256')
    valid = (isinstance(expected, str) and len(expected) == 64
             and all(c in '0123456789abcdef' for c in expected)
             and isinstance(ev.get('quote'), str) and bool(ev['quote']))
    state = 'missing_evidence'
    if source and 'error' in source:
        state = 'unreadable_evidence'
    elif valid and source:
        state = ('stale_evidence' if expected != source['sha256'] else
                 'missing_quote' if ev['quote'] not in source['text'] else 'current')
    return {'state': state, 'source_path': rel,
            'expected_sha256': expected, 'actual_sha256': source['sha256'] if source else None,
            **({'error': source['error']} if source and 'error' in source else {})}


class CachedContract(rules.Contract):
    def __init__(self, reads, path):
        self.reads = reads
        # Contract itself reads once more. Reserve this fixed bounded read too.
        _, snapshot = reads.read(path)
        reads.total += len(snapshot.get('raw', b''))
        if reads.total > MAX_TOTAL_BYTES:
            raise ContinuityError('Maintenance exceeds 64 MiB total read bound')
        super().__init__(reads.root, path)
        if self.contract_sha256 != snapshot.get('sha256'):
            raise ContinuityError('Contract changed during maintenance read; retry')

    def evidence(self, ev, address):
        info = inspect_evidence(self.reads, ev)
        if info['source_path'] and info['actual_sha256']:
            self.hashes[info['source_path']] = info['actual_sha256']
        if info['state'] != 'current':
            self.issue('INCOMPLETE', info['state'], address,
                       info.get('error', 'Evidence requires current raw-byte hash and exact quote'),
                       {'evidence': ev})
            return False
        return True


def explicit_paths(reads, values, maximum, minimum, label):
    if not isinstance(values, list) or not minimum <= len(values) <= maximum:
        raise ContinuityError(f'{label} requires {minimum}..{maximum} explicit paths')
    paths = [reads.path(v)[1] for v in values]
    if len(set(paths)) != len(paths):
        raise ContinuityError(f'{label} paths must be distinct')
    return paths


def load_contract(reads, path):
    _, snapshot = reads.read(path)
    if 'error' in snapshot:
        raise ContinuityError('Cannot read continuity contract: ' + snapshot['error'])
    try:
        data = json.loads(snapshot['text'], parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON constant')))
    except (ValueError, RecursionError) as exc:
        raise ContinuityError('Malformed continuity JSON: ' + str(exc)) from exc
    if not isinstance(data, dict) or type(data.get('version')) is not int or data['version'] != 1:
        raise ContinuityError('Continuity contract must be an object with version 1')
    rows = {}
    count = 0
    for collection in rules.COLLECTIONS:
        items = data.get(collection, [])
        if not isinstance(items, list):
            continue  # The unchanged audit produces the missing-collection finding.
        count += len(items)
        if count > rules.MAX_RECORDS:
            raise ContinuityError('Contract exceeds 5000 records')
        ids = Counter(r.get('id') for r in items if isinstance(r, dict) and isinstance(r.get('id'), str))
        for index, row in enumerate(items):
            rid = row.get('id') if isinstance(row, dict) else None
            address = (f'{collection}:{rid}' if isinstance(rid, str) and rid.strip() and ids[rid] == 1
                       else f'{collection}[{index}]')
            info = inspect_evidence(reads, row.get('evidence') if isinstance(row, dict) else None)
            rows[address] = {'record': address, 'collection': collection, 'index': index,
                             'record_id': rid, 'status': row.get('status') if isinstance(row, dict) else None,
                             'evidence': row.get('evidence') if isinstance(row, dict) else None,
                             'evidence_check': info, 'row': row}
    contract = CachedContract(reads, path)
    audit = contract.audit()
    trusted = {f'{collection}:{rid}' for collection, records in contract.records.items() for rid in records}
    for address, item in rows.items():
        item['trusted'] = address in trusted
        item['validation_failures'] = [finding for finding in audit['findings']
                                       if finding.get('record') == address]
    return data, rows, audit, count


def graph(rows):
    reverse = defaultdict(list)
    edges = 0

    def link(source, target, reason):
        nonlocal edges
        edges += 1
        if edges > MAX_EDGES:
            raise ContinuityError('Dependency graph exceeds 100000 links; split contract scope')
        reverse[source].append((target, reason))

    groups = defaultdict(list)
    for address, item in rows.items():
        row = item['row']
        if item['collection'] != 'assertions' or not isinstance(row, dict):
            continue
        for field, collection in [('scene_id', 'scenes'), ('entity_id', 'entities'), ('fact_id', 'facts')]:
            ref = row.get(field)
            if isinstance(ref, str) and f'{collection}:{ref}' in rows:
                link(f'{collection}:{ref}', address, field)
        kind = row.get('kind')
        if isinstance(kind, str):
            for field in ('entity_id', 'fact_id', 'promise_id'):
                if isinstance(row.get(field), str):
                    groups[(kind, field, row[field])].append(address)
    # Candidate prerequisite checks, not an inference that a prerequisite happened.
    for address, item in rows.items():
        row = item['row']
        if item['collection'] != 'assertions' or not isinstance(row, dict):
            continue
        kind = row.get('kind')
        requirements = {'knowledge_use': [('learn', 'fact_id')],
                        'reader_use': [('reveal', 'fact_id')],
                        'promise_payoff': [('promise_setup', 'promise_id')],
                        'appearance': [('death', 'entity_id'), ('revival', 'entity_id')]}.get(kind if isinstance(kind, str) else '', [])
        for prerequisite, field in requirements:
            ref = row.get(field)
            if not isinstance(ref, str):
                continue
            for source in groups.get((prerequisite, field, ref), []):
                if kind == 'knowledge_use' and rows[source]['row'].get('entity_id') != row.get('entity_id'):
                    continue
                link(source, address, 'recorded_prerequisite_check:' + prerequisite)
    return reverse


def packet_dependencies(reads, data):
    receipt = data.get('extraction_receipt')
    if receipt is None:
        return [], []
    if not isinstance(receipt, dict):
        return [], [{'code': 'invalid_extraction_receipt', 'record': 'extraction_receipt'}]
    paths = receipt.get('source_paths')
    if paths is None:
        return [], [{'code': 'packet_source_paths_unknown', 'record': 'extraction_receipt',
                     'message': 'Receipt digest has no source paths; package dependencies cannot be reconstructed from prose or record evidence.'}]
    paths = explicit_paths(reads, paths, 16, 1, 'extraction_receipt.source_paths')
    result, sources = [], []
    for path in paths:
        _, source = reads.read(path)
        result.append({'source_path': path, 'actual_sha256': source['sha256'],
                       'dependency_scope': 'extraction_package_only',
                       **({'error': source['error']} if 'error' in source else {})})
        if 'error' not in source:
            sources.append({'path': path, 'sha256': source['sha256'], 'text': source['text']})
    diagnostics = []
    expected = receipt.get('source_packet_sha256')
    valid_expected = (isinstance(expected, str) and len(expected) == 64
                      and all(c in '0123456789abcdef' for c in expected))
    actual = None
    if len(sources) == len(paths):
        raw = json.dumps({'version': 1, 'sources': sources}, ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode('utf-8')
        actual = sha(raw)
        for item in result:
            item.update(actual_packet_sha256=actual, expected_packet_sha256=expected,
                        packet_state='current' if actual == expected else 'stale_or_unknown_packet')
    if not valid_expected:
        diagnostics.append({'code': 'packet_hash_unknown', 'record': 'extraction_receipt',
                            'message': 'Expected extraction packet hash is missing or malformed; current package identity cannot establish original provenance.'})
    elif actual is not None and actual != expected:
        diagnostics.append({'code': 'stale_packet', 'record': 'extraction_receipt',
                            'message': 'Current explicit extraction packet differs from the recorded package digest.'})
    if len(sources) != len(paths):
        diagnostics.append({'code': 'unreadable_packet_source', 'record': 'extraction_receipt',
                            'message': 'At least one explicit packet source is unreadable; current package digest is unavailable.',
                            'source_errors': [{'source_path': item['source_path'], 'error': item['error']}
                                              for item in result if 'error' in item]})
    for diagnostic in diagnostics:
        diagnostic.update(source_paths=paths, expected_packet_sha256=expected, actual_packet_sha256=actual)
    return result, diagnostics


def dependency_blockers(item, rows):
    """Explain excluded references using the audit's validated trust boundary."""
    row = item.get('row')
    if item.get('collection') != 'assertions' or not isinstance(row, dict):
        return []
    kind = row.get('kind')
    fields = [('scene_id', 'scenes')]
    if kind in ('death', 'revival', 'appearance', 'mention', 'learn', 'knowledge_use') or 'entity_id' in row:
        fields.append(('entity_id', 'entities'))
    if kind in ('learn', 'reveal', 'knowledge_use', 'reader_use') or 'fact_id' in row:
        fields.append(('fact_id', 'facts'))
    blockers = []
    for field, category in fields:
        ref = row.get(field)
        if not isinstance(ref, str) or not ref.strip():
            blockers.append({'field': field, 'record': None, 'state': 'invalid_reference',
                             'reference_value': ref, 'validation_codes': ['missing_reference']})
            continue
        address = category + ':' + ref
        target = rows.get(address)
        if target and target['trusted']:
            continue
        if target is None:
            matches = [r for r in rows.values() if r['collection'] == category and r['record_id'] == ref]
            blockers.append({'field': field, 'record': address,
                             'state': 'invalid_id' if matches else 'missing',
                             'matching_rows': [r['record'] for r in matches],
                             'validation_codes': ['invalid_id' if matches else 'missing_reference']})
        else:
            codes = sorted({f['code'] for f in target['validation_failures']})
            if target['evidence_check']['state'] != 'current':
                codes = sorted(set(codes) | {target['evidence_check']['state']})
            blockers.append({'field': field, 'record': address, 'state': 'untrusted_dependency',
                             'raw_status': target['status'], 'source_path': target['evidence_check']['source_path'],
                             'validation_codes': codes, 'validation_findings': target['validation_failures']})
    return blockers


REPAIRS = {
    'stale_evidence': 'Re-read the changed source and independently review the full claim; refresh hash and exact quote only after support is verified.',
    'unreadable_evidence': 'Restore or explicitly correct the listed source path and UTF-8 source, then revalidate evidence.',
    'missing_evidence': 'Attach a real source path, its raw-byte SHA256, and an exact supporting quote; leave unsupported claims unconfirmed.',
    'missing_quote': 'Locate an exact supporting fragment in the current source and review the claim; do not invent a replacement quote.',
    'unknown_order': 'Ask the author or inspect explicit chronology evidence for both orders; retain unknown order and proposal status until established.',
    'unconfirmed': 'Review the entire proposal claim, chronology and dependencies with the author; retain proposal/draft until approved.',
    'missing_reference': 'Repair the explicit ID reference or establish its supported dependency record before auditing again.',
    'missing_prerequisite': 'Locate and record a source-supported prerequisite, or ask the author to resolve the gap; do not assume an omitted event.',
    'coverage_omission': 'Inspect the declared omitted source scope and extract/review supported records; retain the omission until resolved.',
    'coverage_unknown': 'Declare the exact covered sources and remaining omissions; this report cannot certify unlisted canon.',
    'semantic_review_unknown': 'Resolve the recorded independent review uncertainty against source evidence and author direction; keep the record unconfirmed.',
    'packet_source_paths_unknown': 'Supply the original explicit extraction packet paths in a reviewed receipt; a packet digest alone cannot locate sources.',
    'stale_packet': 'Re-read the explicit packet sources and review extraction against the changed package; refresh the receipt only after independent review and author approval.',
    'packet_hash_unknown': 'Locate the original extraction receipt and validate its raw package digest; retain unknown provenance if the original binding cannot be established.',
    'unreadable_packet_source': 'Restore or explicitly correct the listed packet source paths and UTF-8 files, then recompute and compare the complete package digest.',
}


def dispatch(root, action, args):
    if action not in ('impact', 'gaps') or not isinstance(args, dict):
        raise ContinuityError('Expected impact/gaps action and object arguments')
    allowed = {'contract_paths', 'changed_source_paths'} if action == 'impact' else {'contract_paths'}
    if set(args) - allowed:
        raise ContinuityError('Unknown maintenance arguments')
    reads = Reads(root)
    paths = explicit_paths(reads, args.get('contract_paths'), MAX_CONTRACTS, 1, 'contract_paths')
    changed = explicit_paths(reads, args.get('changed_source_paths', []), 64, 0, 'changed_source_paths') if action == 'impact' else []
    for path in changed:
        reads.read(path)
    result = {'action': action, 'read_only': True, 'scope': 'listed_contracts_and_explicit_dependencies_only',
              'contract_paths': paths, 'changed_source_paths': changed, 'contracts': [],
              'impact': [], 'gap_queue': [], 'diagnostics': []}
    total = 0
    for path in paths:
        data, rows, audit, count = load_contract(reads, path)
        total += count
        if total > MAX_TOTAL_RECORDS:
            raise ContinuityError('Maintenance exceeds 10000 listed records')
        packet, diagnostics = packet_dependencies(reads, data)
        result['contracts'].append({'contract_path': path, 'contract_sha256': audit['contract_sha256'],
                                    'audit': audit, 'declared_coverage': data.get('coverage'),
                                    'packet_dependencies': packet})
        for diagnostic in diagnostics:
            result['diagnostics'].append(dict(contract_path=path, **diagnostic))
        if action == 'impact':
            reverse = graph(rows)
            affected = {}
            queue = deque()
            for address, item in sorted(rows.items()):
                info = item['evidence_check']
                requested = info['source_path'] in changed
                stale = info['state'] in ('stale_evidence', 'unreadable_evidence', 'missing_quote')
                if requested or (not changed and stale):
                    trace = [{'source_path': info['source_path'], 'record': address, 'link': 'record_evidence'}]
                    affected[address] = (trace, 'direct_source_dependency')
                    queue.append(address)
                if info['state'] != 'current':
                    result['diagnostics'].append({'contract_path': path, 'record': address, **info})
            while queue:
                source = queue.popleft()
                for target, reason in sorted(reverse.get(source, [])):
                    if target not in affected:
                        affected[target] = (affected[source][0] + [{'record': target, 'depends_on': source, 'link': reason}], 'downstream_assertion_check')
                        queue.append(target)
            for address, (trace, reason) in sorted(affected.items()):
                item = rows[address]
                result['impact'].append({k: item[k] for k in ('record', 'record_id', 'status', 'evidence', 'evidence_check')} |
                                        {'contract_path': path, 'reason': reason, 'trace': trace,
                                         'required_action': 'Refresh/review direct evidence and rerun dependent checks; no status promotion is implied.'})
            for item in packet:
                if item['source_path'] in changed or (not changed and (item.get('error') or item.get('packet_state') != 'current')):
                    result['impact'].append(dict(item, contract_path=path, record='extraction_receipt',
                                                 reason='extraction_package_dependency',
                                                 required_action='Revalidate the package; this does not assert that every record cites this source.'))
        else:
            findings = list(audit['findings']) + diagnostics
            for address, item in sorted(rows.items()):
                info = item['evidence_check']
                if info['state'] != 'current' and not any(f.get('record') == address and f.get('code') == info['state'] for f in findings):
                    findings.append({'severity': 'INCOMPLETE', 'code': info['state'], 'record': address, 'message': 'Raw record evidence requires repair.'})
                row = item['row']
                if (item['collection'] == 'scenes' and isinstance(row, dict)
                        and not all(rules.order(row.get(k)) for k in ('story_order', 'narrative_order'))
                        and not any(f.get('record') == address and f.get('code') == 'unknown_order' for f in findings)):
                    findings.append({'severity': 'INCOMPLETE', 'code': 'unknown_order', 'record': address,
                                     'message': 'Raw scene has no established finite story/narrative order; no order is inferred.'})
                review = row.get('semantic_review') if isinstance(row, dict) else None
                if isinstance(review, dict) and review.get('verdict') in ('unknown', 'contradicted'):
                    findings.append({'severity': 'INCOMPLETE', 'code': 'semantic_review_unknown', 'record': address, 'message': review.get('reason'), 'review_verdict': review['verdict']})
            coverage = data.get('coverage')
            if not isinstance(coverage, dict) or type(coverage.get('complete')) is not bool:
                findings.append({'severity': 'INCOMPLETE', 'code': 'coverage_unknown', 'record': 'coverage'})
            else:
                omissions = coverage.get('omissions')
                if not isinstance(omissions, list):
                    findings.append({'severity': 'INCOMPLETE', 'code': 'coverage_unknown', 'record': 'coverage'})
                else:
                    for index, omission in enumerate(omissions):
                        findings.append({'severity': 'INCOMPLETE', 'code': 'coverage_omission', 'record': f'coverage.omissions[{index}]', 'omission': omission})
                    if not coverage['complete'] and not omissions:
                        findings.append({'severity': 'INCOMPLETE', 'code': 'coverage_unknown', 'record': 'coverage', 'message': 'Incomplete coverage has no declared omissions.'})
            for finding in findings:
                item = rows.get(finding.get('record'), {})
                info = item.get('evidence_check', {})
                code = finding['code']
                blockers = dependency_blockers(item, rows)
                result['gap_queue'].append({'contract_path': path, 'record': finding.get('record'),
                                           'record_id': item.get('record_id'), 'source_path': info.get('source_path'),
                                           'source_paths': finding.get('source_paths', []),
                                           'priority': 1 if finding.get('severity') == 'FAIL' else 2 if code in ('stale_evidence', 'unreadable_evidence', 'missing_evidence', 'missing_quote', 'stale_packet', 'packet_hash_unknown', 'unreadable_packet_source') else 3,
                                           'finding': finding, 'blockers': blockers,
                                           'repair_action': REPAIRS.get(code, 'Inspect the listed claim and explicit source evidence with the author; correct the stated conflict before rerunning the audit. No dates or canon changes are inferred.')})
    result['gap_queue'].sort(key=lambda x: (x['priority'], x['contract_path'], x['record'] or '', x['finding']['code']))
    result['source_hashes'] = {p: v['sha256'] for p, v in sorted(reads.cache.items()) if p not in paths}
    result['bounds'] = {'contracts': MAX_CONTRACTS, 'distinct_files': MAX_SOURCES,
                        'total_bytes': MAX_TOTAL_BYTES, 'records': MAX_TOTAL_RECORDS,
                        'dependency_links_per_contract': MAX_EDGES}
    return result
