#!/usr/bin/env python3
"""Build a deterministic marketplace archive from the managed public plugin only."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile
ROOT = Path(__file__).resolve().parents[1]
ALLOWED_PATHS = frozenset('''
.codex-plugin/plugin.json
.mcp.json
INSTALL.md
scripts/build_distribution.py
scripts/fiction_gate.py
scripts/google_workspace.py
scripts/model_selection.py
scripts/run-server.ps1
scripts/series_base_cli.py
scripts/series_import.py
scripts/storyart_links.py
scripts/talewisp_mcp.py
skills/build-series-base/agents/openai.yaml
skills/build-series-base/references/analysis-schema.md
skills/build-series-base/references/process.md
skills/build-series-base/SKILL.md
skills/google-writing-workspace/references/acceptance.md
skills/google-writing-workspace/references/capabilities.md
skills/google-writing-workspace/references/context.md
skills/google-writing-workspace/SKILL.md
skills/write-fiction/agents/openai.yaml
skills/write-fiction/references/agent-routing.md
skills/write-fiction/references/compact-generation-record.json
skills/write-fiction/references/model-selection.md
skills/write-fiction/references/onboarding.md
skills/write-fiction/references/production-input.md
skills/write-fiction/references/style-calibration.md
skills/write-fiction/references/style-contract.md
skills/write-fiction/references/style-evaluation.md
skills/write-fiction/references/vault-schema.md
skills/write-fiction/SKILL.md
skills/write-fiction/templates/series-lexicon.md
skills/write-fiction/templates/style-profile.md
skills/coordinate-talewisp-storyart/agents/openai.yaml
skills/coordinate-talewisp-storyart/references/persistent-links.md
skills/coordinate-talewisp-storyart/SKILL.md
'''.split())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def public_content(name, data):
    text = data.decode('utf-8')
    if re.search(r'[A-Z]:[\\/]Projects[\\/]|[A-Z]:[\\/]Users[\\/]|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|TW_SA_\d', text, re.I):
        raise ValueError('Private path or request identity in ' + name)
    if re.search(r'\[[^\]]*\]\([^)]*-production\.md\)', text):
        raise ValueError('Private production reference in ' + name)


def build(root=ROOT, output=None):
    root = Path(root).resolve()
    plugin = root / 'plugin'
    if plugin.is_symlink() or (hasattr(plugin, 'is_junction') and plugin.is_junction()):
        raise ValueError('Public plugin root link is forbidden')
    if any(p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()) for p in plugin.rglob('*')):
        raise ValueError('Public plugin links are forbidden')
    actual = {p.relative_to(plugin).as_posix() for p in plugin.rglob('*') if p.is_file() and p.name != '.public-export.json' and '__pycache__' not in p.parts and p.suffix != '.pyc'}
    if actual != ALLOWED_PATHS:
        raise ValueError('Public source allowlist differs: ' + repr(sorted(actual ^ ALLOWED_PATHS)))
    files = {}
    for name in sorted(ALLOWED_PATHS):
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe plugin manifest path')
        p = plugin / relative
        files['plugin/' + name] = p.read_bytes()
    marketplace_path = '.agents/plugins/marketplace.json'
    files[marketplace_path] = (root / marketplace_path).read_bytes()
    marketplace = json.loads(files[marketplace_path])
    if not any(p.get('source') in ('./plugin', {'source': 'local', 'path': './plugin'}) for p in marketplace.get('plugins', [])):
        raise ValueError('Marketplace must refer to ./plugin')
    for name in ('docs/INSTALL.md', 'docs/AI-INSTALL.md'):
        files[name] = (root / name).read_bytes()
    for name, data in files.items():
        public_content(name, data)
    required = ['plugin/.codex-plugin/plugin.json', 'plugin/.mcp.json', 'plugin/scripts/talewisp_mcp.py', 'plugin/scripts/run-server.ps1', 'plugin/scripts/series_base_cli.py', 'plugin/skills/build-series-base/SKILL.md']
    for name in required:
        if name not in files:
            raise ValueError('Missing release entrypoint: ' + name)
    manifest = json.loads(files['plugin/.codex-plugin/plugin.json'])
    if 'SERVER_VERSION = "' + manifest['version'] + '"' not in files['plugin/scripts/talewisp_mcp.py'].decode('utf-8'):
        raise ValueError('MCP and plugin versions differ')
    hashes = {name: digest(data) for name, data in sorted(files.items())}
    files['manifest.json'] = (json.dumps({'format': 'Codex local marketplace', 'version': manifest['version'], 'files': hashes, 'required_entrypoints': required}, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    checksums = {name: digest(data) for name, data in sorted(files.items())}
    files['SHA256SUMS'] = ''.join(f'{value}  {name}\n' for name, value in checksums.items()).encode('utf-8')
    output = Path(output or root / 'dist' / ('talewisp-' + manifest['version'] + '.zip')).resolve()
    if output.is_relative_to(plugin) or output.is_relative_to(root / 'plugins'):
        raise ValueError('Release output overlaps plugin source')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(output) as archive:
        if set(archive.namelist()) != set(files) or any(archive.read(name) != data for name, data in files.items()):
            raise ValueError('Archive verification failed')
    return {'path': str(output), 'sha256': digest(output.read_bytes()), 'files': len(files), 'version': manifest['version']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output')
    args = parser.parse_args()
    print(json.dumps(build(output=args.output), ensure_ascii=False))
