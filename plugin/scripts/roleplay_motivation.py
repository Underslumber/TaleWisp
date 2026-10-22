"""Source-bound host review of motivation, not an automatic psychology judge."""
from __future__ import annotations
import copy


class MotivationError(ValueError):
    pass


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def validate_frames(frames, actors):
    if not isinstance(actors, dict) or any(not isinstance(x, dict) or x.get('role') not in {'hero', 'npc', 'leader'} for x in actors.values()):
        raise MotivationError('motivation frames need declared role actors')
    expected = {key for key, actor in actors.items() if actor['role'] != 'leader'}
    if not isinstance(frames, dict) or set(frames) != expected:
        raise MotivationError('motivation frames must cover exactly hero and NPC actors')
    for frame in frames.values():
        if not isinstance(frame, dict) or set(frame) != {'current_goal', 'strivings', 'grounds'}:
            raise MotivationError('motivation frame requires current_goal, strivings, grounds')
        if not _text(frame['current_goal']) or not isinstance(frame['strivings'], list) or not frame['strivings'] or not all(_text(x) for x in frame['strivings']):
            raise MotivationError('motivation needs an actual goal and persistent strivings')
        grounds = frame['grounds']
        if not isinstance(grounds, list) or not grounds:
            raise MotivationError('motivation requires source/scene grounds')
        seen = set()
        for item in grounds:
            if (not isinstance(item, dict) or set(item) != {'id', 'text', 'provenance'} or
                    not all(_text(v) for v in item.values()) or item['id'] in seen or ':' in item['id']):
                raise MotivationError('motivation ground requires unique id, literal text, provenance')
            seen.add(item['id'])


def current_goal(state, actor_id):
    for row in reversed(state.get('logical_motivation_history', [])):
        if row['actor_id'] == actor_id:
            return row['assessment']['next_goal']
    return state['logical_motivation_frames'][actor_id]['current_goal']


def evidence(state, actor_id):
    frame = state['logical_motivation_frames'][actor_id]
    result = {'current_goal': current_goal(state, actor_id)}
    result.update({'ground:'+x['id']: x['text'] for x in frame['grounds']})
    for event in state['transcript']:
        if actor_id in event.get('audience', []) or event.get('actor_id') == actor_id:
            if event['kind'] == 'inner':
                text = event['decision']['motive']+'\n'+event['decision']['emotion']
            else:
                # Exact public content, not private thoughts from the other actor.
                text = '\n'.join(str(event[k]) for k in ('action', 'resolution', 'content', 'manner', 'intensity') if k in event)
            result['event:'+str(event['sequence'])] = text
    return result


ACTOR_INSTRUCTION = (
    'Motivation means a striving or a reason for action, grounded in your character and accessible situation. '
    'Keep your current goal active between turns. A new invitation is something to evaluate, not a reason to agree. '
    'Choose your response by weighing that invitation against your own strivings, relationship and present cost. '
    'If changing or delaying the goal, make the actual cause of that choice clear in your private motive; '
    'do not invent prior fatigue, desire for a break, obligation, trust or reward just to justify a convenient action. '
    'New feelings may develop from what happens through your character; do not replace a causal transition with an emotion label. '
    'An established habit of kindness, loyalty, curiosity or an impulsive flaw can also be a basis; no material reward or perfect rationality is required. '
    'A continued motive need not be re-declared after every gesture. Refusal, bargaining, continuing your task and helping are all available when grounded. '
    'An NPC chooses whom to approach for its own reason in this situation; a generic benefit of having any helper is not the whole reason for selecting this person. '
    'The host audit is not dialogue or character knowledge; do not speak its identifiers aloud.'
)


def actor_context(state, actor_id):
    frame = copy.deepcopy(state['logical_motivation_frames'][actor_id])
    frame['current_goal'] = current_goal(state, actor_id)
    frame['instruction'] = ACTOR_INSTRUCTION
    return frame


def review_input(state, actor_id, candidate):
    return {
        'actor_id': actor_id,
        'current_goal': current_goal(state, actor_id),
        'strivings': copy.deepcopy(state['logical_motivation_frames'][actor_id]['strivings']),
        'available_evidence': evidence(state, actor_id),
        'candidate_turn': copy.deepcopy(candidate['turn']),
        'semantic_checks': [
            'Explain why this actor chooses this action now; a restatement of the action is not its reason.',
            'For an approach/request: why this recipient, given relationship, role, circumstances and alternatives?',
            'For agreement/refusal: does the basis explain its priority relative to the current goal and cost?',
            'For a goal change/delay: identify the perceived trigger and why it changes this actor\'s priorities.',
            'Do not infer fatigue, duty, trust or reward from absence of data. Do not repair the actor\'s motive in the audit.',
            'New emotion must follow accessible conditions through character, not be its own unsupported proof.',
        ],
        'scope': 'Host-only semantic review. Exact references prove availability, not psychological validity. Reject a gap; never invent its missing cause.',
    }


def validate_review(state, actor_id, candidate, assessment):
    if not isinstance(assessment, dict) or set(assessment) != {'goal_relation', 'next_goal', 'transition_reason', 'trigger_refs', 'decision_basis'}:
        raise MotivationError('motivation review requires goal relation, next goal, transition reason, triggers and decision basis')
    relation = assessment['goal_relation']
    if relation not in {'continue', 'means', 'change'} or not _text(assessment['next_goal']) or not _text(assessment['transition_reason']):
        raise MotivationError('motivation review needs an explicit meaningful transition assessment')
    refs = evidence(state, actor_id)
    triggers = assessment['trigger_refs']
    if not isinstance(triggers, list) or any(not isinstance(x, str) or x not in refs for x in triggers) or len(set(triggers)) != len(triggers):
        raise MotivationError('motivation trigger must reference accessible prior evidence')
    if relation == 'continue' and assessment['next_goal'] != current_goal(state, actor_id):
        raise MotivationError('a changed goal cannot be labelled continue')
    if relation in {'means', 'change'} and (not triggers or set(triggers) == {'current_goal'}):
        raise MotivationError('a changed or instrumental goal needs a grounded trigger beyond its prior goal')
    groups = assessment['decision_basis']
    if not isinstance(groups, list):
        raise MotivationError('decision basis must be a list')
    covered = []
    quoted = set()
    for group in groups:
        if not isinstance(group, dict) or set(group) != {'items', 'grounds', 'reason'} or not _text(group['reason']):
            raise MotivationError('each decision group needs items, quoted grounds and a causal reason')
        items = group['items']
        if not isinstance(items, list) or not items or any(type(x) is not int for x in items):
            raise MotivationError('decision group must cover actual turn item indices')
        covered.extend(items)
        grounds = group['grounds']
        if not isinstance(grounds, list) or not grounds:
            raise MotivationError('each decision group needs accessible quoted grounds')
        for ground in grounds:
            if (not isinstance(ground, dict) or set(ground) != {'ref', 'quote'} or
                    not isinstance(ground['ref'], str) or ground['ref'] not in refs or
                    not _text(ground['quote']) or ground['quote'] not in refs[ground['ref']]):
                raise MotivationError('motivation quote must match accessible prior evidence; a new candidate motive is not its own proof')
            quoted.add(ground['ref'])
    if sorted(covered) != list(range(len(candidate['turn']))):
        raise MotivationError('motivation review must cover every decision exactly once')
    if not set(triggers) <= quoted:
        raise MotivationError('motivation triggers must also have literal quoted grounds')
    return copy.deepcopy(assessment)
