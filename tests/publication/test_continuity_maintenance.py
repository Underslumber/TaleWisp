"""Permanent synthetic maintenance acceptance cases; no private story text."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('maintenance_under_test', ROOT / 'plugin/scripts/continuity_maintenance.py')
cm = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cm)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.vault = ROOT / '.agent/maintenance-fixtures' / uuid.uuid4().hex
        self.vault.mkdir(parents=True)
        self.source('scene.md', 'Синтетическая сцена.')
        self.source('fact.md', 'Герой знает синтетический факт.')
        self.data = {'version': 1, 'coverage': {'scope': 'supplied_sources_only', 'complete': True, 'omissions': []},
                     'scenes': [self.row('past', story_order=1, narrative_order=4),
                                self.row('now', story_order=2, narrative_order=2),
                                self.row('reveal', story_order=3, narrative_order=3)],
                     'entities': [self.row('hero')],
                     'facts': [self.row('secret', source='fact.md', text='Синтетический факт.', truth='true')],
                     'assertions': [self.row('learn', kind='learn', scene_id='past', entity_id='hero', fact_id='secret'),
                                    self.row('use', kind='knowledge_use', scene_id='now', entity_id='hero', fact_id='secret'),
                                    self.row('reveal', kind='reveal', scene_id='reveal', fact_id='secret')]}
        self.write()

    def tearDown(self):
        shutil.rmtree(self.vault)

    def source(self, path, text):
        raw = text.encode('utf-8')
        (self.vault / path).write_bytes(raw)
        return {'path': path, 'sha256': hashlib.sha256(raw).hexdigest(), 'quote': text}

    def row(self, rid, source='scene.md', **kw):
        raw = (self.vault / source).read_bytes()
        return dict(id=rid, status='confirmed', evidence={'path': source, 'sha256': hashlib.sha256(raw).hexdigest(), 'quote': raw.decode('utf-8')}, **kw)

    def write(self, path='B05.json', data=None):
        (self.vault / path).write_text(json.dumps(self.data if data is None else data, ensure_ascii=False), encoding='utf-8')

    def call(self, action='impact', **kw):
        return cm.dispatch(self.vault, action, dict(contract_paths=['B05.json'], **kw))

    def test_hero_knows_before_reader_and_no_changes_means_empty_impact(self):
        result = self.call()
        self.assertTrue(result['read_only'])
        self.assertEqual(result['impact'], [])
        self.assertEqual(result['contracts'][0]['audit']['status'], 'PASS_LISTED_RECORDS')
        projection = cm.rules.dispatch(self.vault, 'knowledge', {'contract_path': 'B05.json', 'scene_id': 'now', 'entity_id': 'hero'})
        self.assertEqual([f['id'] for f in projection['character_only_do_not_reveal']], ['secret'])
        self.assertEqual(projection['reader_known'], [])
        self.assertEqual(self.call('gaps')['gap_queue'], [])

    def test_hash_change_direct_fact_downstream_assertions_and_read_only(self):
        (self.vault / 'fact.md').write_text('Изменённый синтетический факт.', encoding='utf-8')
        before = {p.name: p.read_bytes() for p in self.vault.iterdir()}
        result = self.call()
        impacts = {i['record']: i for i in result['impact']}
        self.assertEqual(impacts['facts:secret']['reason'], 'direct_source_dependency')
        self.assertEqual(impacts['assertions:use']['reason'], 'downstream_assertion_check')
        self.assertEqual(impacts['assertions:use']['trace'][0]['source_path'], 'fact.md')
        self.assertEqual(impacts['facts:secret']['evidence_check']['state'], 'stale_evidence')
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.vault.iterdir()})
        self.assertEqual(result, self.call())

    def test_changed_learn_transitively_reaches_use_without_text_guess(self):
        self.data['assertions'][0]['evidence'] = self.source('learning.md', 'Подтверждение обучения.')
        self.write()
        result = self.call(changed_source_paths=['learning.md'])
        impacts = {i['record']: i for i in result['impact']}
        self.assertEqual(set(impacts), {'assertions:learn', 'assertions:use'})
        self.assertEqual(impacts['assertions:use']['trace'][-1]['link'], 'recorded_prerequisite_check:learn')
        self.assertEqual(impacts['assertions:learn']['evidence_check']['state'], 'current')

    def test_life_and_promise_prerequisite_checks(self):
        self.data['assertions'] = [self.row('death', kind='death', scene_id='past', entity_id='hero'),
                                   self.row('appearance', kind='appearance', scene_id='now', entity_id='hero'),
                                   self.row('setup', kind='promise_setup', scene_id='past', promise_id='promise'),
                                   self.row('payoff', kind='promise_payoff', scene_id='now', promise_id='promise')]
        for index, filename in [(0, 'death.md'), (2, 'setup.md')]:
            self.data['assertions'][index]['evidence'] = self.source(filename, 'Явная синтетическая предпосылка.')
        self.write()
        impacts = self.call(changed_source_paths=['death.md', 'setup.md'])['impact']
        self.assertEqual({i['record'] for i in impacts}, {'assertions:death', 'assertions:appearance', 'assertions:setup', 'assertions:payoff'})
        gaps = self.call('gaps')['gap_queue']
        self.assertTrue(any(g['finding']['code'] == 'appearance_after_death' and g['priority'] == 1 for g in gaps))

    def test_b05_b08_are_separate_even_with_identical_ids(self):
        second = copy.deepcopy(self.data)
        ev = self.source('B08.md', 'Другой синтетический источник.')
        for collection in cm.rules.COLLECTIONS:
            for row in second[collection]:
                row['evidence'] = copy.deepcopy(ev)
        self.write('B08.json', second)
        result = cm.dispatch(self.vault, 'impact', {'contract_paths': ['B05.json', 'B08.json'], 'changed_source_paths': ['fact.md']})
        self.assertEqual({i['contract_path'] for i in result['impact']}, {'B05.json'})
        self.assertEqual(result['contract_paths'], ['B05.json', 'B08.json'])

    def test_planned_scenes_stay_proposals_and_raw_evidence_is_checked(self):
        planned = self.row('planned', story_order=None, narrative_order=None)
        planned['status'] = 'proposal'
        planned['evidence'] = self.source('plan.md', 'Предложение будущей сцены.')
        planned['semantic_review'] = {'verdict': 'unknown', 'reason': 'Порядок не установлен.'}
        self.data['scenes'].append(planned)
        self.data['coverage'] = {'scope': 'supplied_sources_only', 'complete': False, 'omissions': ['Синтетическое приложение не разобрано.']}
        self.write()
        (self.vault / 'plan.md').write_text('Изменённый план.', encoding='utf-8')
        before = (self.vault / 'B05.json').read_bytes()
        impact = self.call()['impact']
        self.assertEqual([i['status'] for i in impact], ['proposal'])
        gaps = self.call('gaps')['gap_queue']
        codes = {g['finding']['code'] for g in gaps}
        self.assertTrue({'unconfirmed', 'stale_evidence', 'semantic_review_unknown', 'coverage_omission', 'unknown_order'} <= codes)
        self.assertTrue(all(g['repair_action'] for g in gaps))
        self.assertEqual(before, (self.vault / 'B05.json').read_bytes())

    def test_malformed_missing_unreadable_evidence_and_reference_blockers(self):
        self.data['facts'][0].pop('evidence')
        self.data['assertions'][0]['status'] = 'proposal'
        self.data['assertions'][0]['fact_id'] = 'absent'
        self.data['assertions'][0]['evidence']['path'] = 'missing.md'
        self.data['scenes'].append('malformed')
        self.write()
        gaps = self.call('gaps')['gap_queue']
        self.assertTrue({'missing_evidence', 'unreadable_evidence', 'invalid_record', 'missing_reference'} <= {g['finding']['code'] for g in gaps})
        proposal = [g for g in gaps if g['record'] == 'assertions:learn']
        self.assertTrue(any(b['record'] == 'facts:absent' for g in proposal for b in g['blockers']))
        self.assertTrue(any(d['state'] == 'unreadable_evidence' for d in self.call()['diagnostics']))

    def test_package_links_are_explicit_and_separate_from_record_links(self):
        ev = self.source('packet.md', 'Источник пакета без связи с записью.')
        self.data['extraction_receipt'] = {'source_paths': ['packet.md'], 'source_packet_sha256': '0' * 64}
        self.write()
        impact = self.call(changed_source_paths=['packet.md'])['impact']
        self.assertEqual(len(impact), 1)
        self.assertEqual(impact[0]['record'], 'extraction_receipt')
        self.assertEqual(impact[0]['dependency_scope'], 'extraction_package_only')
        self.data['extraction_receipt'].pop('source_paths')
        self.write()
        result = self.call()
        self.assertEqual(result['impact'], [])
        self.assertIn('packet_source_paths_unknown', {d['code'] for d in result['diagnostics']})

    def test_packet_mismatch_has_actionable_gap_with_exact_hashes_and_paths(self):
        ev = self.source('packet.md', 'Синтетический отдельный пакет.')
        self.data['extraction_receipt'] = {'source_paths': ['packet.md'], 'source_packet_sha256': '0' * 64}
        self.write()
        before = {p.name: p.read_bytes() for p in self.vault.iterdir()}
        result = self.call('gaps')
        task = next(g for g in result['gap_queue'] if g['finding']['code'] == 'stale_packet')
        expected_actual = cm.sha(json.dumps({'version': 1, 'sources': [{'path': ev['path'], 'sha256': ev['sha256'], 'text': ev['quote']}]},
                                           ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'))
        self.assertEqual(task['source_paths'], ['packet.md'])
        self.assertEqual(task['finding']['expected_packet_sha256'], '0' * 64)
        self.assertEqual(task['finding']['actual_packet_sha256'], expected_actual)
        self.assertEqual(task['priority'], 2)
        self.assertIn('independent review', task['repair_action'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.vault.iterdir()})
        self.data['extraction_receipt']['source_packet_sha256'] = expected_actual
        self.write()
        self.assertEqual(self.call('gaps')['gap_queue'], [])

    def test_packet_unknown_hash_and_unreadable_source_are_honest_tasks(self):
        self.data['extraction_receipt'] = {'source_paths': ['missing-packet.md'], 'source_packet_sha256': ['malformed']}
        self.write()
        gaps = self.call('gaps')['gap_queue']
        packet = [g for g in gaps if g['record'] == 'extraction_receipt']
        self.assertEqual({g['finding']['code'] for g in packet}, {'packet_hash_unknown', 'unreadable_packet_source'})
        self.assertTrue(all(g['finding']['actual_packet_sha256'] is None for g in packet))
        self.assertTrue(all(g['source_paths'] == ['missing-packet.md'] and g['repair_action'] for g in packet))
        self.source('missing-packet.md', 'Восстановленный синтетический источник.')
        result = self.call('gaps')
        unknown = next(g for g in result['gap_queue'] if g['finding']['code'] == 'packet_hash_unknown')
        self.assertIsNotNone(unknown['finding']['actual_packet_sha256'])
        self.assertEqual(unknown['finding']['expected_packet_sha256'], ['malformed'])

    def test_blockers_use_effective_audit_trust_for_confirmed_stale_scene(self):
        self.data['scenes'][0]['evidence'] = self.source('past.md', 'Синтетическая прошлая сцена.')
        self.write()
        (self.vault / 'past.md').write_text('Изменённая прошлая сцена.', encoding='utf-8')
        gaps = self.call('gaps')['gap_queue']
        task = next(g for g in gaps if g['record'] == 'assertions:learn' and g['finding']['code'] == 'missing_reference')
        blocker = next(b for b in task['blockers'] if b['record'] == 'scenes:past')
        self.assertEqual(blocker['raw_status'], 'confirmed')
        self.assertEqual(blocker['state'], 'untrusted_dependency')
        self.assertEqual(blocker['source_path'], 'past.md')
        self.assertIn('stale_evidence', blocker['validation_codes'])
        self.assertEqual(self.data['scenes'][0]['status'], 'confirmed')

    def test_blockers_explain_unknown_order_invalid_fact_and_invalid_reference(self):
        self.data['scenes'][0]['story_order'] = None
        self.data['facts'][0]['truth'] = 'unsupported-shape'
        self.data['assertions'][1]['entity_id'] = None
        self.write()
        gaps = self.call('gaps')['gap_queue']
        learn = next(g for g in gaps if g['record'] == 'assertions:learn' and g['finding']['code'] == 'missing_reference')
        codes = {b['record']: b['validation_codes'] for b in learn['blockers']}
        self.assertIn('unknown_order', codes['scenes:past'])
        self.assertIn('invalid_fact', codes['facts:secret'])
        use = next(g for g in gaps if g['record'] == 'assertions:use' and g['finding']['code'] == 'missing_reference')
        self.assertTrue(any(b['field'] == 'entity_id' and b['state'] == 'invalid_reference' and b['reference_value'] is None for b in use['blockers']))

    def test_strict_safe_paths_inputs_and_json(self):
        for args in ({'contract_paths': []}, {'contract_paths': ['B05.json'] * 33},
                     {'contract_paths': ['../B05.json']}, {'contract_paths': ['B05.json', './B05.json']},
                     {'contract_paths': ['B05.json'], 'changed_source_paths': 'scene.md'},
                     {'contract_paths': ['B05.json'], 'changed_source_paths': ['scene.md:stream']},
                     {'contract_paths': ['B05.json'], 'extra': True}):
            with self.subTest(args=args), self.assertRaises(cm.ContinuityError):
                cm.dispatch(self.vault, 'impact', args)
        self.data['facts'][0]['status'] = 'proposal'
        self.data['facts'][0]['evidence']['path'] = '../outside.md'
        self.write()
        with self.assertRaises(cm.ContinuityError):
            self.call()
        for raw in ('[]', '{"version":1,"scenes":[NaN]}', '{'):
            (self.vault / 'B05.json').write_text(raw, encoding='utf-8')
            with self.assertRaises(cm.ContinuityError):
                self.call()

    def test_read_budget_failure_is_not_downgraded_to_a_gap(self):
        previous = cm.MAX_TOTAL_BYTES
        try:
            cm.MAX_TOTAL_BYTES = 20
            with self.assertRaises(cm.ContinuityError):
                self.call('gaps')
        finally:
            cm.MAX_TOTAL_BYTES = previous


if __name__ == '__main__':
    unittest.main()
