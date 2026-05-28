$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'native'
$vsDevCmd = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat'

if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "Visual Studio environment script not found: $vsDevCmd"
}

Push-Location $native
try {
    $compile = "call `"$vsDevCmd`" -arch=x64 >nul && cl /nologo /std:c++20 /EHsc /O2 main.cpp agent.cpp /Fe:benchmark.exe"
    cmd.exe /d /c $compile
    if ($LASTEXITCODE -ne 0) {
        throw "Native build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
