"""Project-scoped candidate I/O for the universal knowledge compiler.

Never installs a candidate into a vault or overwrites an existing file.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys


class KnowledgeRuntimeError(ValueError):
    pass


def _engine():
    name = 'talewisp_knowledge_structure'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('knowledge_structure.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def _inside(root: Path, value: str, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise KnowledgeRuntimeError(label + ' must be a nonempty path')
    raw = Path(value)
    raw = raw if raw.is_absolute() else root / raw
    resolved = raw.resolve()
    if not resolved.is_relative_to(root):
        raise KnowledgeRuntimeError(label + ' escapes the startup project')
    # Reject in-root links too: an alias must not redirect writes into canon.
    cursor = raw.absolute()
    while cursor != root and cursor != cursor.parent:
        if cursor.is_symlink() or (hasattr(cursor, 'is_junction') and cursor.is_junction()):
            raise KnowledgeRuntimeError(label + ' contains a filesystem link')
        cursor = cursor.parent
    return resolved


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise KnowledgeRuntimeError('Cannot read JSON: ' + str(path)) from exc


def dispatch(project_root: Path, args: dict) -> dict:
    root = Path(project_root).resolve()
    if not root.is_dir() or not isinstance(args, dict):
        raise KnowledgeRuntimeError('An existing startup project and request object are required')
    action = args.get('action')
    fields = {
        'build': {'action', 'spec', 'spec_path', 'source_root', 'output_path'},
        'check': {'action', 'spec', 'spec_path', 'source_root'},
        'query': {'action', 'index_path', 'query', 'context', 'limit'},
    }
    if not isinstance(action, str) or action not in fields or set(args) - fields[action]:
        raise KnowledgeRuntimeError('Unknown action or unsupported request fields')
    engine = _engine()
    try:
        if action == 'query':
            index_path = _inside(root, args.get('index_path'), 'index_path')
            index = _json(index_path)
            query = args.get('query', '')
            if not isinstance(query, str):
                raise KnowledgeRuntimeError('query must be a string')
            context = args.get('context', {})
            if not isinstance(context, dict):
                raise KnowledgeRuntimeError('context must be an object')
            limit = args.get('limit', 10)
            if type(limit) is not int or not 1 <= limit <= 100:
                raise KnowledgeRuntimeError('limit must be an integer from 1 to 100')
            return {'action': 'query', 'projection': engine.query_structure(index, query, context, limit)}
        if ('spec' in args) == ('spec_path' in args):
            raise KnowledgeRuntimeError('Supply exactly one of spec or spec_path')
        spec = args['spec'] if 'spec' in args else _json(_inside(root, args['spec_path'], 'spec_path'))
        source_root = _inside(root, args.get('source_root', '.'), 'source_root')
        if not source_root.is_dir():
            raise KnowledgeRuntimeError('source_root is not a directory')
        index = engine.compile_structure(spec, source_root)
        body = (json.dumps(index, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
        digest = hashlib.sha256(body).hexdigest()
        result = {'action': action, 'status': 'checked', 'candidate_sha256': digest,
                  'counts': {key: len(index.get(key, [])) for key in ('nodes', 'views', 'relations', 'events')}}
        if action == 'check':
            return result
        staging = _inside(root, '.talewisp/knowledge-candidates', 'candidate directory')
        output = _inside(root, args.get('output_path', str(staging / (digest + '.json'))), 'output_path')
        if not output.is_relative_to(staging) or output == staging:
            raise KnowledgeRuntimeError('Output must be a new file under .talewisp/knowledge-candidates')
        # Resolve existing ancestors before mkdir and recheck after creation.
        output.parent.mkdir(parents=True, exist_ok=True)
        _inside(root, str(output), 'output_path')
        created = False
        try:
            with output.open('xb') as stream:
                created = True
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            if output.read_bytes() != body:
                raise KnowledgeRuntimeError('Existing candidate differs; refusing overwrite')
            result['reused'] = True
        except OSError:
            if created:
                output.unlink(missing_ok=True)
            raise
        result.update(status='candidate', candidate_path=output.relative_to(root).as_posix())
        return result
    except (engine.KnowledgeStructureError, OSError, TypeError) as exc:
        raise KnowledgeRuntimeError(str(exc)) from exc
