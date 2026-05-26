$ErrorActionPreference = 'Stop'

$native = Join-Path (Split-Path -Parent $PSScriptRoot) 'native'
$built = Join-Path $native 'benchmark.exe'
$live = Join-Path $native 'live.exe'

if (-not (Test-Path -LiteralPath $built)) {
    throw "Native benchmark executable not built: $built"
}

Copy-Item -LiteralPath $built -Destination $live -Force
