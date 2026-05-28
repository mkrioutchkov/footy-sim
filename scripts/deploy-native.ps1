$ErrorActionPreference = 'Stop'

$build = Join-Path (Split-Path -Parent $PSScriptRoot) 'build'
$built = Join-Path $build 'benchmark.exe'
$live = Join-Path $build 'live.exe'

if (-not (Test-Path -LiteralPath $built)) {
    throw "Native benchmark executable not built: $built"
}

Copy-Item -LiteralPath $built -Destination $live -Force
