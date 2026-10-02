"""Public-export boundary, native MCP smoke, and reproducible ZIP acceptance."""
from pathlib import Path
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import unittest
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_release
try:
    import export_public  # Optional local bridge; deliberately not published.
except ModuleNotFoundError:
    export_public = None


class PublicationTests(unittest.TestCase):
    def setUp(self):
        # Normal mkdir avoids the Windows sandbox ACL problem with mkdtemp.
        self.work = ROOT / '.agent/publication-20261002/worker' / uuid.uuid4().hex
        self.work.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.work)

    @unittest.skipUnless(export_public, 'local private-to-public bridge is not distributed')
    def test_export_is_reproducible_and_preserves_sources(self):
        source_files, excluded = export_public.inputs(ROOT)
        before = {str(p): export_public.digest(p.read_bytes()) for p, _ in source_files}
        before.update({str(p): export_public.digest(p.read_bytes()) for p in excluded})
        output = self.work / 'plugin'
        export_public.export(ROOT, output)
        first = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()}
        export_public.export(ROOT, output)
        self.assertEqual(first, {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob('*') if p.is_file()})
        self.assertEqual(before, {name: export_public.digest(Path(name).read_bytes()) for name in before})
        self.assertFalse(any(p.name.endswith('-production.md') for p in output.rglob('*')))
        self.assertTrue((output / 'skills/coordinate-talewisp-storyart/SKILL.md').is_file())
        (output / 'local.txt').write_text('Keep my edits', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            export_public.export(ROOT, output)
        self.assertEqual((output / 'local.txt').read_text(encoding='utf-8'), 'Keep my edits')

    @unittest.skipUnless(export_public, 'local private-to-public bridge is not distributed')
    def test_unmanaged_output_and_privacy_fail_closed(self):
        output = self.work / 'plugin'
        output.mkdir()
        with self.assertRaisesRegex(ValueError, 'unmanaged'):
            export_public.export(ROOT, output)
        for content in ('Private Example Author', '01900000-0000-7000-8000-000000000000', 'D:/Projects/private'):
            with self.assertRaises(ValueError):
                export_public.verify_public({'skill.md': content.encode()}, {'Private Example Author'})

    def test_copied_stdio_tools_and_pseudonym_gate(self):
        vault = self.work / 'vault'
        vault.mkdir()
        messages = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'talewisp_build_series_base', 'arguments': {'action': 'start', 'files': [str(vault / 'unread.fb2')]}}},
        ]
        config = json.loads((ROOT / 'plugin/.mcp.json').read_text(encoding='utf-8'))['mcpServers']['talewisp']
        command = [config['command']] + [arg.replace('${PLUGIN_ROOT}', str(ROOT / 'plugin')) for arg in config['args']]
        run = subprocess.run(command,
            input=''.join(json.dumps(m) + '\n' for m in messages), encoding='utf-8',
            capture_output=True, timeout=20, env=dict(os.environ, TALEWISP_VAULT=str(vault), TALEWISP_PYTHON=sys.executable, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1'))
        self.assertEqual(run.returncode, 0, run.stderr)
        replies = [json.loads(line) for line in run.stdout.splitlines()]
        self.assertEqual(replies[0]['result']['serverInfo']['version'], '0.6.2')
        names = {t['name'] for t in replies[1]['result']['tools']}
        self.assertTrue({'talewisp_build_series_base', 'talewisp_model_selection', 'talewisp_storyart_confirm_art'} <= names)
        self.assertFalse(replies[2]['result']['isError'])
        self.assertEqual(replies[2]['result']['structuredContent']['status'], 'needs_author')
        self.assertEqual(list(vault.iterdir()), [])

    @unittest.skipUnless((ROOT / '.agents/plugins/marketplace.json').is_file(), 'root marketplace not prepared yet')
    def test_release_reproducibility_layout_and_hashes(self):
        first, second = self.work / 'one.zip', self.work / 'two.zip'
        build_release.build(ROOT, first)
        build_release.build(ROOT, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            names = archive.namelist()
            self.assertIn('.agents/plugins/marketplace.json', names)
            self.assertIn('plugin/skills/build-series-base/SKILL.md', names)
            self.assertFalse(any(n.startswith(('vault/', 'plugins/', '.agent/', '.talewisp/')) or '..' in Path(n).parts for n in names))
            manifest = json.loads(archive.read('manifest.json'))
            for name, expected in manifest['files'].items():
                self.assertEqual(build_release.digest(archive.read(name)), expected)
            for line in archive.read('SHA256SUMS').decode().splitlines():
                expected, name = line.split('  ', 1)
                self.assertEqual(build_release.digest(archive.read(name)), expected)

    @unittest.skipUnless((ROOT / '.agents/plugins/marketplace.json').is_file(), 'root marketplace not prepared yet')
    def test_clean_clone_builder_needs_no_exporter_or_receipt(self):
        clone = self.work / 'clone'
        (clone / 'scripts').mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/build_release.py', clone / 'scripts/build_release.py')
        shutil.copytree(ROOT / 'plugin', clone / 'plugin', ignore=shutil.ignore_patterns('.public-export.json', '__pycache__', '*.pyc'))
        shutil.copytree(ROOT / '.agents/plugins', clone / '.agents/plugins')
        (clone / 'docs').mkdir()
        for name in ('INSTALL.md', 'AI-INSTALL.md'):
            shutil.copy2(ROOT / 'docs' / name, clone / 'docs' / name)
        (clone / 'tests/publication').mkdir(parents=True)
        shutil.copy2(Path(__file__), clone / 'tests/publication/test_publication.py')
        # A normal generic development edit is accepted; there is no stale receipt gate.
        with (clone / 'plugin/INSTALL.md').open('a', encoding='utf-8') as handle:
            handle.write('\nDevelopment documentation is editable in Git.\n')
        run = subprocess.run([sys.executable, str(clone / 'scripts/build_release.py')], capture_output=True, encoding='utf-8', timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue((clone / 'dist/talewisp-0.6.2.zip').is_file())
        (clone / 'plugin/private-note.md').write_text('Unreviewed addition', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'allowlist'):
            build_release.build(clone, self.work / 'must-not-build.zip')


if __name__ == '__main__':
    unittest.main()
