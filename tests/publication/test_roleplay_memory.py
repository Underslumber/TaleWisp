"""Protect actual role boundaries, stale proposals and subjective memory semantics."""
import copy
import json
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import test_roleplay_context as fixtures
ctx = fixtures.ctx


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.fx = fixtures.ContextTests()
        self.fx.setUp()
        self.addCleanup(self.fx.tearDown)
        self.s = self.fx.grounded_fixture()

    def proposal(self, state=None, actor='hero', **kwargs):
        state = self.s if state is None else state
        own, events = ctx._logical_memory_view(state, actor)
        records = ctx._memory_api().accessible_records(actor, own, events,
            state['logical_memory']['reflections'], revision=state['revision'])
        return ctx.prepare_logical_reflection(state, actor, text='Мне стоит проверить услышанное.',
            basis=[{'ref': records[0]['id'], 'quote': records[0]['text']}], **kwargs)

    def accept(self, p):
        return ctx.accept_logical_reflection(self.s, p, review={'accepted': True, 'binding': p['binding'],
            'note': 'Fixture host verifies this as a subjective inference, not a world fact.'})

    def test_real_packet_filters_owners_before_ranking_and_is_read_only(self):
        before = copy.deepcopy(self.s)
        packet = ctx.build_logical_actor_input(self.s)
        recall = json.dumps(packet['episodic_memory'], ensure_ascii=False)
        self.assertIn('hero-only memory', recall)
        for secret in ('Bast secret', 'Marcus secret', 'leader-only note', 'AUTHOR_PROBLEM_NOT_NPC_KNOWLEDGE'):
            self.assertNotIn(secret, json.dumps(packet, ensure_ascii=False))
        self.assertEqual(self.s, before)
        self.assertEqual(ctx.build_logical_actor_input(self.s), packet)

    def test_reflection_keeps_goals_and_world_unchanged_and_invalidates_candidate(self):
        candidate = self.fx.logical_candidate(self.s, [{'kind':'inner','motive':'Вернуться к занятиям','emotion':'Спокойствие'}])
        before = copy.deepcopy(self.s)
        p = self.proposal(focus='Проверить, что именно я услышал')
        self.accept(p)
        after = ctx.build_logical_actor_input(self.s)
        self.assertEqual(self.s['bundle'], before['bundle'])
        self.assertEqual(self.s['logical_motivation_frames'], before['logical_motivation_frames'])
        self.assertEqual(self.s['transcript'], before['transcript'])
        self.assertEqual(after['episodic_memory']['current_focus'], 'Проверить, что именно я услышал')
        self.assertEqual(self.s['logical_memory']['reflections'][0]['kind'], 'belief')
        with self.assertRaises(ctx.ContextError):
            ctx.logical_continuation_binding(self.s, candidate)

    def test_other_npc_private_or_unknown_basis_rejected_atomically(self):
        before = copy.deepcopy(self.s)
        for ref in ('event:999', 'reflection:99', 'entry:npc_memories:Bast:private_memory:0'):
            with self.assertRaisesRegex(ctx.ContextError, 'accessible'):
                ctx.prepare_logical_reflection(self.s, 'hero', text='Я знаю чужой секрет.',
                    basis=[{'ref':ref,'quote':'Bast secret'}])
        self.assertEqual(before, self.s)

    def test_stale_changed_cross_branch_or_unreviewed_proposal_rejected(self):
        p = self.proposal()
        for key, value in [('text','Это теперь объективная истина'), ('actor_id','bast')]:
            altered = copy.deepcopy(p); altered['payload'][key] = value
            before = copy.deepcopy(self.s)
            with self.assertRaises(ctx.ContextError): self.accept(altered)
            self.assertEqual(before, self.s)
        other = copy.deepcopy(self.s); other['session_id'] = 'another_branch'
        with self.assertRaises(ctx.ContextError):
            ctx.accept_logical_reflection(other, p, review={'accepted':True,'binding':p['binding'],'note':'host'})
        with self.assertRaises(ctx.ContextError): ctx.accept_logical_reflection(self.s,p,review={})
        self.accept(p)
        with self.assertRaises(ctx.ContextError): self.accept(p)

    def test_npc_does_not_receive_hero_reflection(self):
        self.accept(self.proposal(focus='HERO_FOCUS_CANARY'))
        # Host selects the next actor through the existing route API.
        ctx.review_and_route_logical_scene(self.s,
            review={'binding':ctx.logical_scene_control_binding(self.s,assessment=None,next_actor='bast'), 'assessment':None},
            next_actor='bast')
        npc = json.dumps(ctx.build_logical_actor_input(self.s), ensure_ascii=False)
        self.assertNotIn('HERO_FOCUS_CANARY', npc)
        self.assertNotIn('Мне стоит проверить услышанное.', npc)
        self.assertIn('Bast secret', npc)

    def test_private_inner_future_event_and_hearsay_remain_distinct(self):
        records = ctx._memory_api().accessible_records('hero', {}, [
            {'sequence':1,'revision':1,'kind':'inner','actor_id':'bast','audience':['hero'],
             'decision':{'motive':'SECRET','emotion':'SECRET'}},
            {'sequence':2,'revision':99,'kind':'communication','actor_id':'bast','audience':['hero'],'content':'FUTURE'},
            {'sequence':3,'revision':1,'kind':'communication','actor_id':'bast','audience':['hero'],'content':'Дверь безопасна.'}], [], revision=1)
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['kind'],'hearsay')

    def test_low_rank_does_not_delete_archive_or_change_access_count(self):
        records = [{'id':str(i),'text':f'Запись {i}', 'sequence':i, 'importance':5,'emotional_intensity':0} for i in range(30)]
        before = copy.deepcopy(records)
        selected = ctx._memory_api().recall(records, top_k=5, sequence=30)
        self.assertEqual(len(selected),5)
        self.assertEqual(records,before)
        self.assertEqual(len(records),30)

    def test_store_tampering_is_detected_before_packet(self):
        self.accept(self.proposal())
        self.s['logical_memory']['reflections'][0]['actor_id']='bast'
        with self.assertRaisesRegex(ctx.ContextError,'memory changed'):
            ctx.build_logical_actor_input(self.s)


if __name__ == '__main__':
    unittest.main()
