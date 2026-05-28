$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'native'
$outDir = Join-Path $root 'build'
$vsDevCmd = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat'

if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "Visual Studio environment script not found: $vsDevCmd"
}

if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

Push-Location $native
try {
    $outDirFwd = $outDir -replace '\\','/'
$compile = "call `"$vsDevCmd`" -arch=x64 >nul && cl /nologo /std:c++20 /EHsc /O2 main.cpp engine.cpp agent.cpp gk_ai.cpp role_ai.cpp stats.cpp /Fo`"$outDirFwd/`" /Fe`"$outDirFwd/benchmark.exe`""
    cmd.exe /d /c $compile
    if ($LASTEXITCODE -ne 0) {
        throw "Native build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
