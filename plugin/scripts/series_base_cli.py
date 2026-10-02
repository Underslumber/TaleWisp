"""Local-project fallback for the same importer when MCP is not connected."""
import argparse
import json
import sys
from pathlib import Path
import talewisp_mcp as server

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', type=Path, help='Explicit active vault; otherwise use project configuration')
    args = parser.parse_args()
    if args.vault is not None:
        root = args.vault.resolve()
        if not root.is_dir():
            parser.error('Vault directory does not exist')
        server.STATE.root = root
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise server.TaleWispError('Expected a JSON object on stdin')
        result = server.build_series_base(request)
    except (server.TaleWispError, ValueError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
