"""Deterministic acceptance of model-shaped receipts, not semantic model quality."""
from pathlib import Path
import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('extraction_server_tests', ROOT / 'plugin/scripts/talewisp_mcp.py')
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)
ex = server.extraction_module()


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / '.agent/extraction-fixtures'
        fixtures.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=fixtures)
        self.root = Path(self.temp.name)
        self.oldroot = server.STATE.root
        server.STATE.root = self.root
        self.text = 'Сцена 1, первое событие рассказа и мира. Лев узнал: ключ под камнем.\nСцена 2, второе событие рассказа и мира. Лев достал ключ.'
        (self.root / 'source.md').write_bytes(self.text.encode('utf-8'))
        self.packet = ex.prepare(self.root, ['source.md'])
        ev = {k: self.packet['sources'][0][k] for k in ('path', 'sha256')}
        ev['quote'] = self.text
        def row(rid, claim, **kw):
            return dict(id=rid, claim=claim, evidence=copy.deepcopy(ev), status='proposal', **kw)
        self.candidate = dict(version=1, source_packet_sha256=self.packet['source_packet_sha256'], extractor_id='extractor',
                              coverage=dict(scope='supplied_sources_only', complete=True, omissions=[]),
                              scenes=[row('s1', 'Первое событие', story_order=1, narrative_order=1), row('s2', 'Второе событие', story_order=2, narrative_order=2)],
                              entities=[row('hero', 'Лев')], facts=[row('key', 'Ключ под камнем', text='Ключ под камнем', truth='true')],
                              assertions=[row('learn', 'Лев узнал в первой сцене', kind='learn', scene_id='s1', entity_id='hero', fact_id='key'),
                                          row('reveal', 'Читатель узнаёт в первой сцене', kind='reveal', scene_id='s1', fact_id='key'),
                                          row('use', 'Лев использует знание во второй сцене', kind='knowledge_use', scene_id='s2', entity_id='hero', fact_id='key')])
        self.review = self.make_review()

    def tearDown(self):
        server.STATE.root = self.oldroot
        self.temp.cleanup()

    def make_review(self):
        return dict(type='independent_semantic_review', reviewer_id='reviewer', source_packet_sha256=self.packet['source_packet_sha256'],
                    candidate_sha256=ex.digest(self.candidate), records=[dict(record=k+':'+r['id'], record_sha256=ex.digest(r), verdict='supported', reason='Полная запись подтверждена источником, включая порядок.') for k in ex.rules.COLLECTIONS for r in self.candidate[k]])

    def args(self):
        return dict(source_paths=['source.md'], source_packet_sha256=self.packet['source_packet_sha256'], candidate=self.candidate, review=self.review, target_path='continuity.json')

    def stage(self):
        return server.extraction_action('stage', self.args())

    def apply(self, proposal, **kw):
        return server.apply_proposal(dict(proposal_path=proposal['proposal'], confirmed=True, **kw))

    def test_complete_packet_and_deterministic_hashes(self):
        self.assertEqual(self.packet['sources'][0]['text'], self.text)
        self.assertEqual(self.packet, ex.prepare(self.root, ['source.md']))
        self.assertTrue(self.packet['complete'])
        self.assertEqual(ex.digest({'b':2,'a':1}), ex.digest({'a':1,'b':2}))

    def test_bounds_paths_and_encoding(self):
        for values in [[], ['../outside.md'], ['source.md','source.md'], [str(self.root/'source.md')], ['continuity.json']]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                ex.prepare(self.root, values)
        (self.root/'bad.txt').write_bytes(b'\xff')
        with self.assertRaises(ValueError): ex.prepare(self.root,['bad.txt'])
        (self.root/'big.md').write_bytes(b'a'*(ex.MAX_SOURCE_BYTES+1))
        with self.assertRaises(ValueError): ex.prepare(self.root,['big.md'])
        for n in range(3): (self.root/f'{n}.md').write_bytes(b'a'*ex.MAX_SOURCE_BYTES)
        with self.assertRaises(ValueError): ex.prepare(self.root,['0.md','1.md','2.md'])

    def test_russian_end_to_end_pending_then_author_apply_and_knowledge(self):
        staged=self.stage()
        self.assertFalse(staged['accepted'])
        self.assertFalse((self.root/'continuity.json').exists())
        preview=(self.root/staged['preview']).read_text(encoding='utf-8')
        self.assertIn('PENDING',preview)
        self.apply(staged)
        self.assertEqual(server.continuity_action('check',dict(contract_path='continuity.json'))['status'],'PASS_LISTED_RECORDS')
        result=server.continuity_action('knowledge',dict(contract_path='continuity.json',scene_id='s2',entity_id='hero'))
        self.assertEqual([x['id'] for x in result['known_to_character']],['key'])

    def test_source_drift_before_stage(self):
        (self.root/'source.md').write_text(self.text+' ',encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.stage()

    def test_source_drift_before_apply_writes_nothing(self):
        staged=self.stage()
        (self.root/'source.md').write_text(self.text+' ',encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.apply(staged)
        self.assertFalse((self.root/'continuity.json').exists())

    def test_true_quote_wrong_conclusion_review_rejects_promotion(self):
        self.candidate['facts'][0]['claim']='Лев не знает о ключе'
        self.review=self.make_review()
        next(x for x in self.review['records'] if x['record']=='facts:key')['verdict']='contradicted'
        staged=self.stage()
        self.apply(staged)
        data=json.loads((self.root/'continuity.json').read_text(encoding='utf-8'))
        self.assertEqual(data['facts'][0]['status'],'proposal')
        self.assertEqual(data['assertions'][0]['promotion_blocker'],'unconfirmed_dependency')
        self.assertEqual(server.continuity_action('check',dict(contract_path='continuity.json'))['status'],'INCOMPLETE')

    def test_unknown_order_retained_incomplete(self):
        self.candidate['scenes'][0]['story_order']=None
        self.review=self.make_review()
        self.review['records'][0]['verdict']='unknown'
        staged=self.stage(); self.apply(staged)
        self.assertEqual(server.continuity_action('check',dict(contract_path='continuity.json'))['status'],'INCOMPLETE')
        self.assertIsNone(json.loads((self.root/'continuity.json').read_text(encoding='utf-8'))['scenes'][0]['story_order'])

    def test_review_duplicate_omitted_extra_stale_self_and_type(self):
        original=copy.deepcopy(self.review)
        mutations=[lambda r:r['records'].append(r['records'][0]), lambda r:r['records'].pop(), lambda r:r['records'][0].update(record='facts:missing'), lambda r:r['records'][0].update(record_sha256='0'*64), lambda r:r.update(candidate_sha256='0'*64), lambda r:r.update(reviewer_id='extractor'), lambda r:r.update(type='self_review')]
        for mutate in mutations:
            self.review=copy.deepcopy(original); mutate(self.review)
            with self.subTest(mutate=mutate), self.assertRaises(server.TaleWispError): self.stage()

    def test_malformed_record_even_with_supported_verdict(self):
        original=copy.deepcopy(self.candidate)
        mutations=[lambda c:c['scenes'][0].update(story_order=True),lambda c:c['scenes'][0].update(story_order=None),lambda c:c['assertions'][0].update(kind='invented'),lambda c:c['assertions'][0].update(entity_id='absent'),lambda c:c['entities'].append(copy.deepcopy(c['entities'][0])),lambda c:c['facts'][0].update(truth='maybe'),lambda c:c['entities'][0].update(status='confirmed'),lambda c:c['entities'][0].update(claim=''),lambda c:c['entities'][0]['evidence'].update(quote='absent')]
        for mutate in mutations:
            self.candidate=copy.deepcopy(original); mutate(self.candidate); self.review=self.make_review()
            with self.subTest(mutate=mutate), self.assertRaises(server.TaleWispError): self.stage()

    def test_pending_tampering_and_marker_removal(self):
        staged=self.stage(); p=self.root/staged['proposal']; original=p.read_bytes()
        for mutate in [lambda d:d['continuity_extraction']['candidate']['entities'][0].update(claim='changed'), lambda d:d.pop('continuity_extraction'),lambda d:d.update(replacement_text='{}'),lambda d:d['continuity_extraction'].pop('review'),lambda d:d['continuity_extraction'].pop('target_sha256'),lambda d:d['continuity_extraction'].update(target_path='other.json')]:
            data=json.loads(original); mutate(data); p.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            with self.assertRaises(server.TaleWispError): self.apply(staged)
            self.assertFalse((self.root/'continuity.json').exists())
        p.write_bytes(original)
        preview=self.root/staged['preview']
        preview.write_text(preview.read_text(encoding='utf-8').replace('Первое событие','Подменённое событие'),encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.apply(staged)

    def test_target_type_and_snapshot(self):
        args=self.args(); args['target_path']='source.md'
        with self.assertRaises(server.TaleWispError): server.extraction_action('stage',args)
        (self.root/'continuity.json').write_text('{"ordinary":"json"}',encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.stage()
        (self.root/'continuity.json').write_text(json.dumps(dict(version=1,scenes=[],entities=[],facts=[],assertions=[])),encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.stage()
        (self.root/'continuity.json').unlink()
        staged=self.stage(); (self.root/'continuity.json').write_text('{}',encoding='utf-8')
        with self.assertRaises(server.TaleWispError): self.apply(staged)

    def test_unauthorized_apply_writes_nothing(self):
        staged=self.stage()
        with self.assertRaises(server.TaleWispError): server.apply_proposal(dict(proposal_path=staged['proposal']))
        self.assertFalse((self.root/'continuity.json').exists())

    def test_generic_proposals_unchanged(self):
        staged=server.save_proposal(dict(title='ordinary',replacement_text='Проза'))
        self.apply(staged,target_path='new.md')
        self.assertEqual((self.root/'new.md').read_text(encoding='utf-8'),'Проза')

    def test_quote_expanded_supported_contract_size_rejected_before_save(self):
        template=copy.deepcopy(self.candidate['entities'][0])
        self.candidate['entities']=[dict(template,id='hero' if i==0 else 'hero'+str(i)) for i in range(4900)]
        self.review=self.make_review()
        with self.assertRaisesRegex(server.TaleWispError,'2 MiB.*split'):
            self.stage()
        self.assertFalse((self.root/'.talewisp/proposals/pending').exists())
        self.assertFalse((self.root/'continuity.json').exists())

    def test_serialized_utf8_exact_boundary_and_apply_receipt_size_gate(self):
        contract=ex.evaluate(self.root,self.packet['source_packet_sha256'],['source.md'],self.candidate,self.review)
        current=len(ex.replacement_text(contract).encode('utf-8'))
        contract['entities'][0]['claim']+='a'*(ex.rules.MAX_BYTES-current)
        self.assertEqual(len(ex.replacement_text(contract).encode('utf-8')),ex.rules.MAX_BYTES)
        contract['entities'][0]['claim']+='а'
        with self.assertRaisesRegex(ex.ExtractionError,'2 MiB.*split'): ex.replacement_text(contract)
        staged=self.stage()
        p=self.root/staged['proposal']; data=json.loads(p.read_text(encoding='utf-8'))
        data['replacement_text']+=' '*(ex.rules.MAX_BYTES+1)
        p.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
        (self.root/staged['preview']).write_text(ex.pending_preview(data),encoding='utf-8')
        with self.assertRaisesRegex(server.TaleWispError,'2 MiB.*split'): self.apply(staged)
        self.assertFalse((self.root/'continuity.json').exists())

    def test_real_stdio_prepare_and_tools(self):
        env=dict(os.environ,TALEWISP_VAULT=str(self.root))
        requests=[dict(jsonrpc='2.0',id=1,method='tools/list'),dict(jsonrpc='2.0',id=2,method='tools/call',params=dict(name='talewisp_prepare_continuity_extraction',arguments=dict(source_paths=['source.md']))),dict(jsonrpc='2.0',id=3,method='tools/call',params=dict(name='talewisp_stage_continuity_extraction',arguments=self.args()))]
        result=subprocess.run([sys.executable,str(ROOT/'plugin/scripts/talewisp_mcp.py')],input=''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in requests).encode('utf-8'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,check=True)
        rows=[json.loads(x) for x in result.stdout.decode('utf-8').splitlines()]
        self.assertIn('talewisp_stage_continuity_extraction',{x['name'] for x in rows[0]['result']['tools']})
        self.assertEqual(rows[1]['result']['structuredContent']['sources'][0]['text'],self.text)
        self.assertFalse(rows[2]['result']['isError'])


if __name__=='__main__': unittest.main()
