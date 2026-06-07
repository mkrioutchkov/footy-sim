$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$native = Join-Path $root 'native'
$thirdParty = Join-Path $root 'third_party'
$outDir = Join-Path $root 'build'
$vsDevCmd = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat'

if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "Visual Studio environment script not found: $vsDevCmd"
}

if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

# ── Collect all header files for dependency tracking ──
$headerFiles = @(Get-ChildItem -LiteralPath $native -File | Where-Object { $_.Extension -eq '.h' })
if (Test-Path -LiteralPath $thirdParty) {
    $headerFiles += @(Get-ChildItem -LiteralPath $thirdParty -Recurse -File | Where-Object { $_.Extension -in '.h', '.hpp' })
}
$newestHeader  = if ($headerFiles.Count -gt 0) { ($headerFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc } else { [DateTime]::MinValue }
$sourceFiles   = @(Get-ChildItem -LiteralPath $native -File | Where-Object { $_.Extension -eq '.cpp' })

$exe = Join-Path $outDir 'live.exe'
$outDirFwd = $outDir -replace '\\', '/'
$anyCompiled = $false

Push-Location $native
try {
    foreach ($src in $sourceFiles) {
        $objFile = Join-Path $outDir "$($src.BaseName).obj"
        $srcTime = $src.LastWriteTimeUtc

        $needCompile = $false
        if (-not (Test-Path -LiteralPath $objFile)) {
            $needCompile = $true
        } else {
            $objTime = (Get-Item -LiteralPath $objFile).LastWriteTimeUtc
            if ($objTime -lt $srcTime) { $needCompile = $true }
            elseif ($objTime -lt $newestHeader) { $needCompile = $true }
            elseif ($objTime -lt (Get-Item -LiteralPath $PSCommandPath).LastWriteTimeUtc) { $needCompile = $true }
        }

        if ($needCompile) {
            Write-Host "Compiling $($src.Name) ..."
            $cmd = "call `"$vsDevCmd`" -arch=x64 >nul && cl /nologo /std:c++20 /EHsc /O2 /c $($src.Name) /I`"../third_party`" /Fo`"$outDirFwd/`""
            cmd.exe /d /c $cmd
            if ($LASTEXITCODE -ne 0) {
                throw "Compilation of $($src.Name) failed with exit code $LASTEXITCODE"
            }
            $anyCompiled = $true
        }
    }

    # ── Link step ──
    $needLink = $false
    if (-not (Test-Path -LiteralPath $exe)) {
        $needLink = $true
    } elseif ($anyCompiled) {
        $needLink = $true
    } else {
        # Check if any .obj is newer than the exe (shouldn't happen normally)
        $exeTime = (Get-Item -LiteralPath $exe).LastWriteTimeUtc
        foreach ($src in $sourceFiles) {
            $objFile = Join-Path $outDir "$($src.BaseName).obj"
            if (Test-Path -LiteralPath $objFile) {
                if ((Get-Item -LiteralPath $objFile).LastWriteTimeUtc -gt $exeTime) {
                    $needLink = $true
                    break
                }
            }
        }
    }

    if ($needLink) {
        $objList = ($sourceFiles | ForEach-Object { "`"$outDirFwd/$($_.BaseName).obj`"" }) -join ' '
        Write-Host "Linking ..."
        $cmd = "call `"$vsDevCmd`" -arch=x64 >nul && cl /nologo /std:c++20 /EHsc /O2 $objList /I`"../third_party`" /Fe`"$outDirFwd/live.exe`" /link"
        cmd.exe /d /c $cmd
        if ($LASTEXITCODE -ne 0) {
            throw "Link failed with exit code $LASTEXITCODE"
        }
    } else {
        Write-Host "Native build up to date: $exe"
    }
} finally {
    Pop-Location
}
