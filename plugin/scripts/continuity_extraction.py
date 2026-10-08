"""Bounded source packets and reviewed continuity proposals; no model client."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('extraction_continuity_rules', Path(__file__).with_name('continuity_check.py'))
rules = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rules)
MAX_SOURCE_BYTES = 256 * 1024
MAX_PACKET_BYTES = 512 * 1024
MAX_SOURCES = 16
MARKER = 'continuity-extraction-v1'
PREFIX = 'continuity-extraction-'


class ExtractionError(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def path(root, value):
    try:
        p = rules.safe_path(Path(root).resolve(), value)
        if p.is_relative_to(Path(root).resolve() / '.talewisp'):
            raise ExtractionError('Extraction paths cannot target internal .talewisp state')
        return p
    except (ValueError, TypeError) as exc:
        raise ExtractionError(str(exc)) from exc


def prepare(root, source_paths):
    if not isinstance(source_paths, list) or not 1 <= len(source_paths) <= MAX_SOURCES:
        raise ExtractionError('Supply 1..16 explicit source paths; split larger requests')
    sources, seen, total = [], set(), 0
    for value in source_paths:
        p = path(root, value)
        if p.suffix.lower() not in ('.md', '.txt') or p in seen:
            raise ExtractionError('Sources must be distinct vault-relative MD/TXT files')
        seen.add(p)
        try:
            with p.open('rb') as stream:
                raw = stream.read(MAX_SOURCE_BYTES + 1)
            total += len(raw)
            if len(raw) > MAX_SOURCE_BYTES or total > MAX_PACKET_BYTES:
                raise ExtractionError('Complete source packet exceeds byte bounds; split explicitly, never truncate')
            text = raw.decode('utf-8-sig')
        except (OSError, UnicodeError) as exc:
            raise ExtractionError('Cannot read complete UTF-8 source: ' + str(exc)) from exc
        sources.append({'path': p.relative_to(Path(root).resolve()).as_posix(),
                        'sha256': hashlib.sha256(raw).hexdigest(), 'text': text})
    packet = {'version': 1, 'sources': sources}
    return dict(packet, source_packet_sha256=digest(packet), complete=True,
                bounds={'source_bytes': MAX_SOURCE_BYTES, 'total_source_bytes': MAX_PACKET_BYTES, 'sources': MAX_SOURCES},
                instructions='Extract only these complete sources. No external lore; no guessed chronology or filename/array order. Separate character learn from reader reveal. Every record must have a full claim and exact evidence. Unknown order stays null and proposal/draft. An independent host agent must judge every full record including order and references.',
                output_schema={'version': 1, 'source_packet_sha256': '<packet digest>', 'extractor_id': '<declared host agent ID>',
                               'coverage': {'scope': 'supplied_sources_only', 'complete': True, 'omissions': []},
                               'scenes': [], 'entities': [], 'facts': [], 'assertions': []},
                review_schema={'type': 'independent_semantic_review', 'reviewer_id': '<different host agent ID>',
                               'source_packet_sha256': '<packet digest>', 'candidate_sha256': '<digest(candidate)>',
                               'records': [{'record': '<collection:id>', 'record_sha256': '<digest(entire record)>',
                                            'verdict': 'supported|contradicted|unknown', 'reason': '<full claim and chronology support explanation>'}]})


def target_snapshot(root, target_path):
    p = path(root, target_path)
    if p.suffix.lower() != '.json':
        raise ExtractionError('Extraction target must be a standalone continuity .json contract, never manuscript prose')
    if not p.exists():
        return None
    raise ExtractionError('Extraction requires a new standalone target; existing canon cannot be replaced')


def evaluate(root, packet_hash, source_paths, candidate, review):
    packet = prepare(root, source_paths)
    if packet['source_packet_sha256'] != packet_hash:
        raise ExtractionError('Source packet changed; prepare and extract again')
    if not isinstance(candidate, dict) or type(candidate.get('version')) is not int or candidate['version'] != 1 or candidate.get('source_packet_sha256') != packet_hash or not nonempty(candidate.get('extractor_id')):
        raise ExtractionError('Invalid source-bound candidate envelope')
    coverage = candidate.get('coverage')
    if not isinstance(coverage, dict) or coverage.get('scope') != 'supplied_sources_only' or type(coverage.get('complete')) is not bool or not isinstance(coverage.get('omissions'), list) or any(not nonempty(x) for x in coverage['omissions']) or (coverage['complete'] and coverage['omissions']):
        raise ExtractionError('Coverage must explicitly describe supplied source omissions')
    if not isinstance(review, dict) or review.get('type') != 'independent_semantic_review' or not nonempty(review.get('reviewer_id')) or review['reviewer_id'] == candidate['extractor_id'] or review.get('source_packet_sha256') != packet_hash or review.get('candidate_sha256') != digest(candidate):
        raise ExtractionError('Independent review must bind the exact candidate, sources and different declared agent ID')
    sources = {s['path']: s for s in packet['sources']}
    rows = {}
    for collection in rules.COLLECTIONS:
        items = candidate.get(collection)
        if not isinstance(items, list):
            raise ExtractionError('All four record collections are required')
        for row in items:
            if not isinstance(row, dict) or not nonempty(row.get('id')) or not nonempty(row.get('claim')) or row.get('status') not in ('proposal', 'draft'):
                raise ExtractionError('Candidate records require id, full claim and proposal/draft status')
            address = collection + ':' + row['id']
            if address in rows or len(rows) >= rules.MAX_RECORDS:
                raise ExtractionError('Duplicate ID or record limit exceeded')
            ev = row.get('evidence')
            if not isinstance(ev, dict) or ev.get('path') not in sources or ev.get('sha256') != sources[ev['path']]['sha256'] or not nonempty(ev.get('quote')) or ev['quote'] not in sources[ev['path']]['text']:
                raise ExtractionError('Literal evidence must match the current complete supplied source')
            if collection == 'scenes' and any(row.get(k) is not None and not rules.order(row[k]) for k in ('story_order', 'narrative_order')):
                raise ExtractionError('Scene orders must be finite numbers or explicitly unknown/null')
            if collection == 'facts' and (not nonempty(row.get('text')) or row.get('truth') not in ('true', 'false', 'unknown')):
                raise ExtractionError('Malformed fact')
            if collection == 'assertions' and row.get('kind') not in rules.KINDS:
                raise ExtractionError('Malformed assertion kind')
            rows[address] = (collection, row)
    verdicts = {}
    if not isinstance(review.get('records'), list):
        raise ExtractionError('Review records must be exhaustive')
    for entry in review['records']:
        if not isinstance(entry, dict) or entry.get('record') not in rows or entry['record'] in verdicts or entry.get('record_sha256') != digest(rows[entry['record']][1]) or entry.get('verdict') not in ('supported', 'contradicted', 'unknown') or not nonempty(entry.get('reason')):
            raise ExtractionError('Duplicate, extra, stale or invalid semantic review entry')
        verdicts[entry['record']] = entry
    if set(verdicts) != set(rows):
        raise ExtractionError('Review omitted candidate records')
    approved = {a for a, v in verdicts.items() if v['verdict'] == 'supported'}
    dependencies = {}
    for address, (collection, row) in rows.items():
        if collection == 'scenes' and address in approved and not all(rules.order(row.get(k)) for k in ('story_order', 'narrative_order')):
            raise ExtractionError('Supported scene cannot have unknown chronology')
        if collection != 'assertions':
            continue
        needed = [('scene_id', 'scenes')]
        if row['kind'] in {'death', 'revival', 'appearance', 'mention', 'learn', 'knowledge_use'}:
            needed.append(('entity_id', 'entities'))
        if row['kind'] in {'learn', 'reveal', 'knowledge_use', 'reader_use'}:
            needed.append(('fact_id', 'facts'))
        dependencies[address] = []
        for field, category in needed:
            if not nonempty(row.get(field)) or category + ':' + row[field] not in rows:
                raise ExtractionError('Malformed/missing reference: ' + address + ' ' + field)
            dependencies[address].append(category + ':' + row[field])
        if row['kind'].startswith('promise_') and not nonempty(row.get('promise_id')):
            raise ExtractionError('Promise requires an explicit promise_id')
    blocked = {a for a in approved if any(d not in approved for d in dependencies.get(a, []))}
    approved -= blocked
    contract = {'version': 1, **{k: [] for k in rules.COLLECTIONS}, 'coverage': copy.deepcopy(coverage)}
    for address, (collection, row) in rows.items():
        final = copy.deepcopy(row)
        final['status'] = 'confirmed' if address in approved else row['status']
        final['semantic_review'] = copy.deepcopy(verdicts[address])
        if address in blocked:
            final['promotion_blocker'] = 'unconfirmed_dependency'
        contract[collection].append(final)
    contract['coverage']['unconfirmed_records'] = sorted(set(rows) - approved)
    contract['coverage']['scope'] = 'supplied_sources_only'
    contract['extraction_receipt'] = {'source_packet_sha256': packet_hash, 'candidate_sha256': digest(candidate), 'review_sha256': digest(review)}
    return contract


def replacement_text(contract):
    text = json.dumps(contract, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    if len(text.encode('utf-8')) > rules.MAX_BYTES:
        raise ExtractionError('Serialized continuity contract exceeds 2 MiB UTF-8 byte limit; split the supplied scope explicitly')
    return text


def stage(root, args, save_proposal):
    target = args.get('target_path')
    snapshot = target_snapshot(root, target)
    candidate, review = args.get('candidate'), args.get('review')
    contract = evaluate(root, args.get('source_packet_sha256'), args.get('source_paths'), candidate, review)
    metadata = {'type': MARKER, 'source_paths': args['source_paths'], 'source_packet_sha256': args['source_packet_sha256'],
                'candidate': candidate, 'review': review, 'target_path': target, 'target_sha256': snapshot,
                'replacement_sha256': digest(contract)}
    replacement = replacement_text(contract)
    result = save_proposal({'title': PREFIX + str(args.get('title') or 'continuity'), 'proposal_type': 'canon',
                            'source_path': target if snapshot else None, 'replacement_text': replacement,
                            'summary': 'PENDING: intended post-approval statuses only. No canon file has been written. Independent model verdicts are not deterministic semantic proof.',
                            'continuity_extraction': metadata})
    result.update({'accepted': False, 'coverage': contract['coverage'], 'intended_after_author_approval': True})
    return result


def pending_preview(proposal):
    metadata = proposal['continuity_extraction']
    marker = '<!-- ' + MARKER + ':' + digest(metadata) + ' -->'
    source_rel = proposal.get('source_path') or ''
    return (marker + '\n---\ntype: talewisp-proposal\nstatus: pending\n'
            + 'proposal_type: ' + proposal['proposal_type'] + '\n'
            + 'source_path: ' + json.dumps(source_rel, ensure_ascii=False) + '\n---\n\n'
            + '# ' + proposal['title'] + '\n\n' + proposal['summary']
            + '\n\n## Proposed text\n\n' + proposal['replacement_text'] + '\n')


def validate_pending(root, proposal, preview, target_arg):
    metadata = proposal.get('continuity_extraction')
    required = {'type', 'source_paths', 'source_packet_sha256', 'candidate', 'review', 'target_path', 'target_sha256', 'replacement_sha256'}
    if (not isinstance(metadata, dict) or not required.issubset(metadata)
            or metadata.get('type') != MARKER or metadata.get('target_sha256') is not None
            or proposal.get('proposal_type') != 'canon' or proposal.get('status') != 'pending'
            or not str(proposal.get('title', '')).startswith(PREFIX)):
        raise ExtractionError('Extraction proposal metadata missing or invalid')
    if pending_preview(proposal) != preview:
        raise ExtractionError('Extraction receipt or exact author-visible preview changed')
    target = metadata.get('target_path')
    if proposal.get('source_path') != (target if metadata.get('target_sha256') else None) or (target_arg and target_arg != target):
        raise ExtractionError('Extraction target changed')
    if target_snapshot(root, target) != metadata.get('target_sha256'):
        raise ExtractionError('Continuity target changed since staging')
    contract = evaluate(root, metadata.get('source_packet_sha256'), metadata.get('source_paths'), metadata.get('candidate'), metadata.get('review'))
    replacement_text(contract)
    pending_text = proposal.get('replacement_text', '')
    if not isinstance(pending_text, str) or len(pending_text.encode('utf-8')) > rules.MAX_BYTES:
        raise ExtractionError('Pending continuity contract exceeds 2 MiB UTF-8 byte limit; split the supplied scope explicitly')
    try:
        replacement = json.loads(pending_text)
    except (TypeError, ValueError) as exc:
        raise ExtractionError('Invalid extraction replacement JSON') from exc
    if digest(contract) != metadata.get('replacement_sha256') or replacement != contract:
        raise ExtractionError('Pending extraction replacement changed')
    return target
