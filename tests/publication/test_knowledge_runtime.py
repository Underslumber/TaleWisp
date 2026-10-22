"""Real CLI/MCP candidate lifecycle in isolated projects, including installed copies."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = Path(os.environ.get('TALEWISP_TEST_PLUGIN_ROOT', ROOT / 'plugin'))
sys.path.insert(0, str(Path(__file__).parent))
from test_knowledge_structure import fixture

spec = importlib.util.spec_from_file_location('knowledge_runtime_test', PLUGIN / 'scripts/knowledge_runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class KnowledgeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.spec = fixture(self.root)
        self.canon = self.root / 'vault' / 'canon.md'
        self.canon.parent.mkdir()
        self.canon.write_text('Original author canon stays intact.\n', encoding='utf-8')
        self.protected = self.canon.read_bytes()

    def tearDown(self):
        self.assertEqual(self.canon.read_bytes(), self.protected)
        self.temp.cleanup()

    def request(self, action, **kwargs):
        return runtime.dispatch(self.root, {'action': action, **kwargs})

    def test_check_is_read_only_and_build_is_idempotent_separate_candidate(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        check = self.request('check', spec=self.spec)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        first = self.request('build', spec=self.spec)
        second = self.request('build', spec=self.spec)
        candidate = self.root / first['candidate_path']
        self.assertTrue(candidate.is_relative_to(self.root / '.talewisp/knowledge-candidates'))
        self.assertEqual(hashlib.sha256(candidate.read_bytes()).hexdigest(), check['candidate_sha256'])
        self.assertEqual(first['candidate_path'], second['candidate_path'])
        self.assertTrue(second['reused'])
        public = self.request('query', index_path=first['candidate_path'], query='the killer')
        self.assertEqual(public['projection']['results'], [])
        author = self.request('query', index_path=first['candidate_path'], query='the killer', context={'audience': 'author'})
        self.assertEqual(author['projection']['results'][0]['id'], 'person:hidden-heir')

    def test_refuses_canon_overwrite_existing_candidate_and_escape(self):
        with self.assertRaisesRegex(runtime.KnowledgeRuntimeError, 'knowledge-candidates'):
            self.request('build', spec=self.spec, output_path='vault/canon.md')
        directory = self.root / '.talewisp/knowledge-candidates'
        directory.mkdir(parents=True)
        target = directory / 'chosen.json'
        target.write_text('keep existing candidate', encoding='utf-8')
        with self.assertRaisesRegex(runtime.KnowledgeRuntimeError, 'overwrite'):
            self.request('build', spec=self.spec, output_path=str(target))
        self.assertEqual(target.read_text(encoding='utf-8'), 'keep existing candidate')
        with self.assertRaisesRegex(runtime.KnowledgeRuntimeError, 'escapes'):
            self.request('check', spec=self.spec, source_root=str(self.root.parent))
        with self.assertRaises(runtime.KnowledgeRuntimeError):
            self.request('check', spec=self.spec, spec_path='also.json')

    def test_rejects_invalid_requests_and_stale_sources_without_output(self):
        for args in ({'action': []}, {'action': 'unknown'}, {'action': 'build'}, {'action': 'check', 'spec': self.spec, 'output_path': 'x'}):
            with self.assertRaises(runtime.KnowledgeRuntimeError):
                runtime.dispatch(self.root, args)
        (self.root / 'snapshots/source.txt').write_text('changed source', encoding='utf-8')
        with self.assertRaisesRegex(runtime.KnowledgeRuntimeError, 'hash'):
            self.request('build', spec=self.spec)
        self.assertFalse((self.root / '.talewisp').exists())

    def test_cli_and_mcp_use_the_packaged_compiler(self):
        request = {'action': 'build', 'spec': self.spec}
        env = dict(os.environ, TALEWISP_PROJECT_ROOT=str(self.root), TALEWISP_VAULT=str(self.root / 'vault'),
                   PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        cli = subprocess.run([sys.executable, str(PLUGIN / 'scripts/knowledge_structure_cli.py'), '--project-root', str(self.root)],
                             input=json.dumps(request).encode('utf-8'), capture_output=True, env=env, timeout=20)
        self.assertEqual(cli.returncode, 0, cli.stderr.decode('utf-8'))
        built = json.loads(cli.stdout)
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'talewisp_knowledge_structure', 'arguments': {'action': 'check', 'spec': self.spec}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {'name': 'talewisp_knowledge_structure', 'arguments': {'action': 'query', 'index_path': built['candidate_path'], 'query': 'the killer'}}},
            {'jsonrpc': '2.0', 'id': 5, 'method': 'tools/call', 'params': {'name': 'talewisp_knowledge_structure', 'arguments': {'action': 'build', 'spec': self.spec, 'output_path': 'vault/canon.md'}}},
            {'jsonrpc': '2.0', 'id': 6, 'method': 'tools/call', 'params': {'name': 'talewisp_read_file', 'arguments': {'path': 'canon.md'}}},
        ]
        server = subprocess.run([sys.executable, str(PLUGIN / 'scripts/talewisp_mcp.py')],
            input=''.join(json.dumps(x) + '\n' for x in messages).encode('utf-8'), capture_output=True,
            env=env, cwd=self.root, timeout=20)
        self.assertEqual(server.returncode, 0, server.stderr.decode('utf-8'))
        replies = [json.loads(line) for line in server.stdout.splitlines()]
        self.assertIn('talewisp_knowledge_structure', {t['name'] for t in replies[1]['result']['tools']})
        self.assertFalse(replies[2]['result']['isError'])
        self.assertEqual(replies[2]['result']['structuredContent']['candidate_sha256'], built['candidate_sha256'])
        self.assertEqual(replies[3]['result']['structuredContent']['projection']['results'], [])
        self.assertTrue(replies[4]['result']['isError'])
        self.assertFalse(replies[5]['result']['isError'])
        self.assertIn('Original author canon stays intact.', json.dumps(replies[5]['result']['structuredContent']))

    def test_cli_decodes_utf8_independently_of_windows_locale(self):
        self.spec['nodes'][0]['title'] = 'Ячейка с русским названием'
        request = json.dumps({'action': 'build', 'spec': self.spec}, ensure_ascii=False)
        env = dict(os.environ, PYTHONIOENCODING='cp1251', PYTHONDONTWRITEBYTECODE='1')
        for prefix in ('', '\ufeff'):
            with self.subTest(bom=bool(prefix)):
                run = subprocess.run([sys.executable, str(PLUGIN / 'scripts/knowledge_structure_cli.py'),
                                      '--project-root', str(self.root)],
                    input=(prefix + request).encode('utf-8'), capture_output=True, env=env, timeout=20)
                self.assertEqual(run.returncode, 0, run.stderr.decode('cp1251', errors='replace'))
                result = json.loads(run.stdout)
                index = json.loads((self.root / result['candidate_path']).read_text(encoding='utf-8'))
                node = next(n for n in index['nodes'] if n['id'] == self.spec['nodes'][0]['id'])
                self.assertEqual(node['title'], 'Ячейка с русским названием')


if __name__ == '__main__':
    unittest.main()
