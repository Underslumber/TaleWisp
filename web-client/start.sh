#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo 'Node.js 24 or newer is required.' >&2; exit 1; }
major=$(node --version | sed 's/^v//' | cut -d. -f1)
[ "$major" -ge 24 ] || { echo "Node.js 24 or newer is required; found $(node --version)." >&2; exit 1; }
if [ -z "${CODEX_BIN:-}" ]; then
  command -v codex >/dev/null 2>&1 || { echo 'Codex CLI was not found. Install Codex CLI or set CODEX_BIN to its executable.' >&2; exit 1; }
  CODEX_BIN=$(command -v codex)
  export CODEX_BIN
fi
exec node server.mjs
