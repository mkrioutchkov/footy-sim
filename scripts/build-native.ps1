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

$exe = Join-Path $outDir 'live.exe'
$sourceFiles = @(
    Get-ChildItem -LiteralPath $native -File | Where-Object { $_.Extension -in '.cpp', '.h' }
    Get-Item -LiteralPath $PSCommandPath
)

if ((Test-Path -LiteralPath $exe) -and $sourceFiles.Count -gt 0) {
    $newestSource = ($sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
    $exeTime = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
    if ($exeTime -ge $newestSource) {
        Write-Host "Native build up to date: $exe"
        exit 0
    }
}

Push-Location $native
try {
    $outDirFwd = $outDir -replace '\\','/'
$compile = "call `"$vsDevCmd`" -arch=x64 >nul && cl /nologo /std:c++20 /EHsc /O2 main.cpp engine.cpp agent.cpp gk_ai.cpp role_ai.cpp stats.cpp /Fo`"$outDirFwd/`" /Fe`"$outDirFwd/live.exe`""
    cmd.exe /d /c $compile
    if ($LASTEXITCODE -ne 0) {
        throw "Native build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
