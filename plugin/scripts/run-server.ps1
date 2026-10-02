$ErrorActionPreference = 'Stop'

$server = Join-Path $PSScriptRoot 'talewisp_mcp.py'
$candidates = @()

if ($env:TALEWISP_PYTHON) {
    $candidates += $env:TALEWISP_PYTHON
}

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    $candidates += $python.Source
}

$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
    $candidates += $launcher.Source
}

$bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$candidates += $bundled

$executable = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $executable) {
    throw 'TaleWisp requires Python 3. Set TALEWISP_PYTHON to python.exe.'
}

& $executable -u $server
exit $LASTEXITCODE
