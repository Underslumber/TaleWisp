"""Synthetic Russian contracts: acceptance at audit, projection and stdio layers."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('continuity_under_test', ROOT / 'plugin/scripts/continuity_check.py')
cc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cc)


class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.vault = ROOT / '.agent/continuity-fixtures' / uuid.uuid4().hex
        self.vault.mkdir(parents=True)
        raw = 'Герой жив. Герой умер. Герой воскрес. Герой обещал. Герой узнал тайну. Читатель знает. Ошибочная вера. Будущий секрет.'.encode('utf-8')
        (self.vault / 'source.md').write_bytes(raw)
        self.ev = {'path': 'source.md', 'sha256': hashlib.sha256(raw).hexdigest(), 'quote': 'Герой жив.'}
        self.data = {'version': 1, 'scenes': [], 'entities': [self.row('hero')], 'facts': [self.row('secret', text='Будущий секрет.', truth='true'), self.row('belief', text='Ошибочная вера.', truth='false')], 'assertions': []}
        for sid, story, narrative in [('past', 1, 5), ('death', 2, 1), ('mid', 3, 3), ('revive', 4, 2), ('end', 5, 4)]:
            self.data['scenes'].append(self.row(sid, story_order=story, narrative_order=narrative))

    def tearDown(self):
        shutil.rmtree(self.vault)

    def row(self, rid, **kwargs):
        return dict(id=rid, status='confirmed', evidence=copy.deepcopy(self.ev), **kwargs)

    def add(self, rid, kind, scene, **kwargs):
        self.data['assertions'].append(self.row(rid, kind=kind, scene_id=scene, **kwargs))

    def write(self):
        (self.vault / 'contract.json').write_text(json.dumps(self.data, ensure_ascii=False), encoding='utf-8')

    def call(self, action='check', **kwargs):
        self.write()
        return cc.dispatch(self.vault, action, dict(contract_path='contract.json', **kwargs))

    def codes(self, result):
        return {r['code'] for r in result['findings']}

    def test_death_revival_flashback_mentions_and_byte_preservation(self):
        self.add('d', 'death', 'death', entity_id='hero')
        self.add('r', 'revival', 'revive', entity_id='hero')
        self.add('flashback', 'appearance', 'past', entity_id='hero')
        self.add('mention', 'mention', 'mid', entity_id='hero')
        self.add('living', 'appearance', 'end', entity_id='hero')
        self.write()
        before = {p.name: p.read_bytes() for p in self.vault.iterdir()}
        self.assertEqual(cc.dispatch(self.vault, 'check', {'contract_path':'contract.json'})['status'], 'PASS_LISTED_RECORDS')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.vault.iterdir()})
        self.add('bad', 'appearance', 'mid', entity_id='hero')
        result = self.call()
        self.assertEqual(result['status'], 'FAIL')
        self.assertIn('appearance_after_death', self.codes(result))
        self.add('tie', 'appearance', 'death', entity_id='hero')
        self.assertIn('ambiguous_life_state', self.codes(self.call()))

    def test_promises_use_narrative_order_not_world_order(self):
        self.add('setup', 'promise_setup', 'revive', promise_id='p')
        self.add('payoff', 'promise_payoff', 'mid', promise_id='p')
        self.assertEqual(self.call()['status'], 'PASS_LISTED_RECORDS')
        self.data['assertions'][0]['scene_id'] = 'past'
        self.assertIn('payoff_before_setup', self.codes(self.call()))

    def test_knowledge_reader_separation_false_belief_and_start_boundary(self):
        self.add('learn', 'learn', 'past', entity_id='hero', fact_id='belief')
        self.add('reveal', 'reveal', 'death', fact_id='secret')
        self.add('boundary', 'learn', 'mid', entity_id='hero', fact_id='secret')
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual([f['id'] for f in result['known_to_character']], ['belief'])
        self.assertEqual(result['known_to_character'][0]['truth'], 'false')
        self.assertEqual([f['id'] for f in result['reader_known']], ['secret'])
        self.assertEqual([f['id'] for f in result['character_only_do_not_reveal']], ['belief'])
        self.add('early', 'knowledge_use', 'death', entity_id='hero', fact_id='secret')
        self.add('readerbad', 'reader_use', 'death', fact_id='belief')
        self.add('revealbelief', 'reveal', 'past', fact_id='belief')
        self.add('same', 'knowledge_use', 'mid', entity_id='hero', fact_id='secret')
        codes = self.codes(self.call())
        self.assertTrue({'knowledge_before_learning', 'reader_use_before_reveal', 'ambiguous_order'} <= codes)

    def test_future_unknown_and_bad_record_never_writer_ready(self):
        self.add('future', 'learn', 'end', entity_id='hero', fact_id='secret')
        self.data['assertions'][0]['scene_id'] = None
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertEqual(result['known_to_character'], [])
        self.assertNotIn('Будущий секрет.', json.dumps(result, ensure_ascii=False))
        self.assertEqual(len(result['omitted']), 2)

    def test_distinct_scene_tied_learning_is_incomplete_and_withheld(self):
        self.data['scenes'][0]['story_order'] = 3
        self.add('learn', 'learn', 'past', entity_id='hero', fact_id='secret')
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertIn('ambiguous_knowledge_boundary', self.codes(result))
        self.assertEqual(result['known_to_character'], [])
        self.assertNotIn('Будущий секрет.', json.dumps(result, ensure_ascii=False))

    def test_distinct_scene_tied_reveal_is_incomplete_and_withheld(self):
        self.data['scenes'][0]['narrative_order'] = 3
        self.add('reveal', 'reveal', 'past', fact_id='secret')
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertIn('ambiguous_reader_boundary', self.codes(result))
        self.assertEqual(result['reader_known'], [])
        self.assertNotIn('Будущий секрет.', json.dumps(result, ensure_ascii=False))

    def test_target_scene_learning_and_reveal_are_determinate_start_exclusions(self):
        self.add('learn', 'learn', 'mid', entity_id='hero', fact_id='secret')
        self.add('reveal', 'reveal', 'mid', fact_id='secret')
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual(result['status'], 'PASS_LISTED_RECORDS')
        self.assertEqual(result['findings'], [])
        self.assertEqual(result['known_to_character'], [])
        self.assertEqual(result['reader_known'], [])
        self.assertNotIn('Будущий секрет.', json.dumps(result, ensure_ascii=False))

    def test_known_evidence_quotes_cannot_leak_unrelated_future_secret(self):
        self.data['facts'][1]['evidence']['quote'] = 'Ошибочная вера. Будущий секрет.'
        self.add('learn', 'learn', 'past', entity_id='hero', fact_id='belief')
        self.data['assertions'][0]['evidence']['quote'] = 'Ошибочная вера. Будущий секрет.'
        self.add('early', 'knowledge_use', 'past', entity_id='hero', fact_id='secret')
        self.add('later', 'learn', 'end', entity_id='hero', fact_id='secret')
        result = self.call('knowledge', scene_id='mid', entity_id='hero')
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['known_to_character'][0]['text'], 'Ошибочная вера.')
        self.assertNotIn('Будущий секрет.', json.dumps(result, ensure_ascii=False))
        self.assertNotIn('quote', result['known_to_character'][0]['evidence'])

    def test_stale_missing_quote_reference_order_duplicate_and_malformed(self):
        mutations = [
            lambda d: d['facts'][0]['evidence'].update(sha256='0'*64),
            lambda d: d['facts'][0]['evidence'].update(quote='Отсутствует'),
            lambda d: d['scenes'][0].update(story_order=None),
            lambda d: d['scenes'][0].update(narrative_order=True),
            lambda d: d['scenes'][0].update(story_order=10**400),
            lambda d: d['scenes'].append(copy.deepcopy(d['scenes'][0])),
            lambda d: d['facts'][0].update(status=[]),
            lambda d: d['facts'][0].update(truth={}),
            lambda d: d['assertions'].append(self.row('invalid', kind=[], scene_id='mid')),
            lambda d: d['assertions'].append(self.row('ref', kind='learn', scene_id='mid', entity_id='hero', fact_id=None)),
            lambda d: d['assertions'].append('bad'),
            lambda d: d.pop('assertions'),
            lambda d: d['facts'][0].pop('evidence'),
            lambda d: d['facts'][0].update(status='proposal'),
        ]
        original = copy.deepcopy(self.data)
        for change in mutations:
            with self.subTest(change=change):
                self.data = copy.deepcopy(original)
                change(self.data)
                result = self.call()
                self.assertEqual(result['status'], 'INCOMPLETE')
                self.assertTrue(result['findings'])
        self.data = {k:[] for k in cc.COLLECTIONS}
        self.data['version'] = 1
        self.assertEqual(self.call()['status'], 'INCOMPLETE')

    def test_path_escape_and_source_escape(self):
        self.write()
        for path in ('../contract.json', str(self.vault / 'contract.json'), 'C:\\elsewhere\\contract.json'):
            with self.assertRaises(cc.ContinuityError):
                cc.dispatch(self.vault, 'check', {'contract_path':path})
        self.data['facts'][0]['evidence']['path'] = '../source.md'
        self.assertIn('unreadable_evidence', self.codes(self.call()))
        try:
            (self.vault / 'outside-link').symlink_to(self.vault.parent, target_is_directory=True)
        except OSError:
            return  # Windows may require link privileges; containment remains directly tested above.
        with self.assertRaises(cc.ContinuityError):
            cc.safe_path(self.vault.resolve(), 'outside-link/file.md')

    def test_public_stdio_real_call_and_error(self):
        self.write()
        messages = [
            {'jsonrpc':'2.0','id':1,'method':'tools/list'},
            {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'talewisp_continuity_check','arguments':{'contract_path':'contract.json'}}},
            {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'talewisp_knowledge_at_scene','arguments':{'contract_path':'contract.json','scene_id':'mid','entity_id':'hero'}}},
            {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'talewisp_continuity_check','arguments':{'contract_path':'../outside.json'}}},
        ]
        run = subprocess.run([sys.executable, str(ROOT / 'plugin/scripts/talewisp_mcp.py')], input=''.join(json.dumps(m)+'\n' for m in messages), encoding='utf-8', capture_output=True, timeout=20, env=dict(os.environ, TALEWISP_VAULT=str(self.vault), PYTHONDONTWRITEBYTECODE='1'))
        self.assertEqual(run.returncode, 0, run.stderr)
        replies = [json.loads(line) for line in run.stdout.splitlines()]
        names = {t['name'] for t in replies[0]['result']['tools']}
        self.assertTrue({'talewisp_continuity_check','talewisp_knowledge_at_scene'} <= names)
        self.assertEqual(replies[1]['result']['structuredContent']['status'], 'PASS_LISTED_RECORDS')
        self.assertEqual(replies[2]['result']['structuredContent']['boundary'], 'start_of_scene')
        self.assertTrue(replies[3]['result']['isError'])


if __name__ == '__main__':
    unittest.main()
