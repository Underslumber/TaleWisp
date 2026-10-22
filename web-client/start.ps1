$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { $nodePath = $node.Source }
else {
  $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (-not (Test-Path -LiteralPath $bundled)) { throw 'Node.js 24 or newer was not found. Install it or use the bundled Codex runtime.' }
  $nodePath = $bundled
}
$nodeVersion = & $nodePath --version
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "Node.js 24 or newer is required; found $nodeVersion." }
if (-not $env:CODEX_BIN) {
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if (-not $codex) { throw 'Codex CLI was not found. Install the supported Codex CLI or set CODEX_BIN to its executable.' }
  $env:CODEX_BIN = $codex.Source
}
& $nodePath server.mjs
