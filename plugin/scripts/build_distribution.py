#!/usr/bin/env python3
"""Build and verify the normal Codex plugin directory; never install or publish."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil


def build(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if output == source or output.is_relative_to(source):
        raise ValueError('Output must be outside the plugin source')
    if output.exists():
        raise ValueError('Output already exists; choose a new staging directory')
    manifest = json.loads((source / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
    server = (source / 'scripts/talewisp_mcp.py').read_text(encoding='utf-8')
    if 'SERVER_VERSION = "' + manifest['version'] + '"' not in server:
        raise ValueError('Plugin and MCP server versions differ')
    required = ['.mcp.json', '.codex-plugin/plugin.json', 'scripts/run-server.ps1',
                'scripts/talewisp_mcp.py', 'scripts/model_selection.py',
                'scripts/google_workspace.py', 'skills/google-writing-workspace/SKILL.md',
                'skills/write-fiction/references/model-selection.md']
    for name in required:
        if not (source / name).is_file():
            raise ValueError('Missing entrypoint: ' + name)
    files = []
    for path in sorted(source.rglob('*')):
        if any(p in {'__pycache__', '.pytest_cache', 'node_modules', '.git'} for p in path.relative_to(source).parts):
            continue
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError('Distribution source must not contain links: ' + str(path))
        if path.is_file() and path.suffix not in {'.pyc', '.pyo'}:
            files.append(path)
    output.mkdir(parents=True)
    hashes = {}
    for path in files:
        relative = path.relative_to(source)
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
            raise ValueError('Copy verification failed: ' + str(relative))
        hashes[relative.as_posix()] = digest
    receipt = {'name': manifest['name'], 'version': manifest['version'],
               'format': 'Codex plugin directory', 'files': hashes,
               'required_entrypoints': required, 'installed': False, 'published': False}
    (output.parent / (output.name + '.manifest.json')).write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'path': str(output), 'version': manifest['version'], 'file_count': len(files),
            'receipt': str(output.parent / (output.name + '.manifest.json'))}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(build(Path(__file__).resolve().parents[1], args.output), ensure_ascii=False))
