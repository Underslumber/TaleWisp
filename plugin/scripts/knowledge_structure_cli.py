"""Compile/check/query an isolated knowledge candidate; JSON request on stdin."""
import argparse
import json
from pathlib import Path
import sys

from knowledge_runtime import dispatch, KnowledgeRuntimeError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-root', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = dispatch(args.project_root, json.loads(sys.stdin.buffer.read().decode('utf-8-sig')))
    except (KnowledgeRuntimeError, ValueError) as exc:
        sys.stdout.buffer.write((json.dumps({'error': str(exc)}, ensure_ascii=False) + '\n').encode('utf-8'))
        return 1
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
