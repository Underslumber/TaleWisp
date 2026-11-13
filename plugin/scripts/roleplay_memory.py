"""Branch-local episodic recall and explicitly reviewed subjective reflection.

No model, filesystem, canon writes, automatic forgetting, or goal changes.
The caller supplies an already role-filtered view; ranking never grants access.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re


class MemoryError(ValueError):
    pass


CONTRACT = (
    'Recall is selected from your accessible history, not new world facts. '
    'An utterance proves what its speaker said, not that the claim is true. '
    'Reflections are your subjective beliefs, possibly mistaken. '
    'Current focus is an attention cue, not a replacement for your established goal. '
    'Entry memories describe past experience, not current physical conditions. '
    'The full ordered accessible history remains authoritative; low recall rank never means forgotten knowledge.'
)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def empty_store():
    return {'version': 1, 'reflections': []}


def validate_store(store, actors):
    if (not isinstance(store, dict) or set(store) != {'version', 'reflections'}
            or store['version'] != 1 or not isinstance(store['reflections'], list)):
        raise MemoryError('Invalid branch memory store')
    ids = set()
    for row in store['reflections']:
        if (not isinstance(row, dict) or row.get('actor_id') not in actors
                or actors[row['actor_id']]['role'] == 'leader'
                or row.get('kind') != 'belief' or row.get('id') in ids
                or not isinstance(row.get('text'), str) or not row['text'].strip()
                or not isinstance(row.get('basis'), list) or not row['basis']):
            raise MemoryError('Invalid owned reflection')
        ids.add(row['id'])


def _strings(value, path='entry'):
    """Preserve individual entry fields; never reclassify an entry as objective truth."""
    if isinstance(value, str) and value.strip():
        yield path, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from _strings(item, f'{path}:{i}')
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(item, f'{path}:{key}')


def accessible_records(actor_id, own_entry, safe_events, reflections, *, revision):
    records = [dict(id=ref, actor_id=actor_id, kind='entry_memory', text=text,
                    sequence=0, revision=0, importance=5, emotional_intensity=0)
               for ref, text in _strings(own_entry)]
    for event in safe_events:
        if event.get('revision', 0) > revision:
            continue
        # A character's own inner events are never made public by a bad audience.
        if event.get('kind') == 'inner' and event.get('actor_id') != actor_id:
            continue
        if actor_id not in event.get('audience', []) and event.get('actor_id') != actor_id:
            continue
        kind = event.get('kind')
        text = (event.get('decision', {}).get('motive', '') + '\n'
                + event.get('decision', {}).get('emotion', '') if kind == 'inner'
                else event.get('content') or event.get('action') or event.get('resolution') or event.get('text', ''))
        if not text.strip():
            continue
        records.append(dict(id=f"event:{event['sequence']}", actor_id=actor_id,
                            kind='belief' if kind == 'inner' else ('hearsay' if kind in {'communication', 'speech'} else 'observation'),
                            text=text, sequence=event['sequence'], revision=event.get('revision', 0),
                            speaker=event.get('actor_id'), importance=5, emotional_intensity=0,
                            **({'status': event['status']} if 'status' in event else {})))
    for row in reflections:
        if row['actor_id'] == actor_id and row['revision'] <= revision:
            records.append(copy.deepcopy(row))
    return records


def recall(records, *, context='', sequence=0, top_k=5):
    if type(top_k) is not int or not 1 <= top_k <= 20:
        raise MemoryError('top_k must be an integer from 1 to 20')
    terms = set(re.findall(r'[^\W_]{3,}', context.casefold(), flags=re.UNICODE))
    def score(row):
        words = set(re.findall(r'[^\W_]{3,}', row['text'].casefold(), flags=re.UNICODE))
        relevant = len(terms & words) / max(1, len(terms))
        recent = 1 / (1 + .05 * max(0, sequence - row['sequence']))
        return 3 * relevant + 2 * recent + 2 * row['importance'] / 10 + row['emotional_intensity'] / 10
    ranked = sorted(records, key=lambda r: (-score(r), -r['sequence'], r['id']))
    # Pure read. Retrieving again cannot strengthen a memory or alter branch revision.
    return [{**copy.deepcopy(row), 'recall_score': round(score(row), 6)} for row in ranked[:top_k]]


def projection(state, actor_id, own_entry, safe_events, *, context='', top_k=5):
    store = state.get('logical_memory', empty_store())
    records = accessible_records(actor_id, own_entry, safe_events, store['reflections'], revision=state['revision'])
    own = [r for r in store['reflections'] if r['actor_id'] == actor_id and r['revision'] <= state['revision']]
    focus = next((r['focus'] for r in reversed(own) if r.get('focus')), None)
    return {'scope': 'branch_local_subjective', 'contract': CONTRACT,
            'current_focus': focus, 'available_count': len(records),
            'recalled': recall(records, context=context, sequence=len(state['transcript']), top_k=top_k)}


def prepare_reflection(state, actor_id, own_entry, safe_events, *, text, basis,
                       importance=5, emotional_intensity=0, focus=None):
    if actor_id not in state['actors'] or state['actors'][actor_id]['role'] == 'leader':
        raise MemoryError('Reflection requires a character owner')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise MemoryError('Reflection needs bounded nonempty subjective text')
    for value in (importance, emotional_intensity):
        if type(value) is not int or not 0 <= value <= 10:
            raise MemoryError('Memory salience must be an integer from 0 to 10')
    if focus is not None and (not isinstance(focus, str) or not focus.strip() or len(focus) > 1000):
        raise MemoryError('Focus must be a bounded attention cue')
    records = accessible_records(actor_id, own_entry, safe_events,
        state.get('logical_memory', empty_store())['reflections'], revision=state['revision'])
    available = {r['id']: r for r in records}
    if not isinstance(basis, list) or not basis or len(basis) > 20:
        raise MemoryError('Reflection requires accessible exact evidence')
    selected = []
    for item in basis:
        if (not isinstance(item, dict) or set(item) != {'ref', 'quote'}
                or item['ref'] not in available or item['quote'] != available[item['ref']]['text']):
            raise MemoryError('Reflection basis must match accessible owner evidence exactly')
        selected.append(copy.deepcopy(item))
    payload = dict(actor_id=actor_id, kind='belief', text=text.strip(), basis=selected,
                   importance=importance, emotional_intensity=emotional_intensity, focus=focus)
    binding = dict(session_id=state['session_id'], source_fingerprint=state['source_fingerprint'],
                   revision=state['revision'], transcript_sha256=state['transcript_sha256'],
                   memory_sha256=fingerprint(state.get('logical_memory', empty_store())),
                   proposal_sha256=fingerprint(payload))
    return {'payload': payload, 'binding': binding,
            'review_required': 'Host must verify subjective inference and focus from quoted owner evidence. Shape and hashes do not prove meaning. No canon or goal change.'}


def accept_reflection(state, proposal, review, own_entry, safe_events):
    if not isinstance(proposal, dict) or set(proposal) != {'payload', 'binding', 'review_required'}:
        raise MemoryError('Invalid reflection proposal')
    data = proposal['payload']
    expected = prepare_reflection(state, data['actor_id'], own_entry, safe_events,
        text=data['text'], basis=data['basis'], importance=data['importance'],
        emotional_intensity=data['emotional_intensity'], focus=data['focus'])
    if proposal != expected:
        raise MemoryError('Reflection proposal is stale or changed')
    if (not isinstance(review, dict) or set(review) != {'accepted', 'binding', 'note'}
            or review.get('accepted') is not True or review.get('binding') != expected['binding']
            or not isinstance(review.get('note'), str) or not review['note'].strip()):
        raise MemoryError('Reflection requires an explicit bound host semantic review')
    store = copy.deepcopy(state.get('logical_memory', empty_store()))
    row = dict(data, id=f"reflection:{len(store['reflections']) + 1}",
               sequence=len(state['transcript']), revision=state['revision'] + 1)
    store['reflections'].append(row)
    return store
