$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) 'rp-fixed-image-app-patch-test'

function Get-NormalizedHash([string]$Path) {
    $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8).Replace("`r`n", "`n")
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $TempRoot 'assets\js') -Force | Out-Null

$projectApp = Join-Path $ProjectRoot 'assets\js\app.js'
$tempApp = Join-Path $TempRoot 'assets\js\app.js'
Copy-Item -LiteralPath $projectApp -Destination $tempApp -Force

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') restore $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT restore failed' }
if ((Get-NormalizedHash $tempApp) -ne '34A0E0C493227D46580506CE0B3A464D90F8234220E51E761DECCC4C4B5CB1A7') {
    throw 'BAT restore output does not match RP-Hub 1.7.6'
}

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') apply $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT apply failed' }
if ((Get-NormalizedHash $tempApp) -ne (Get-NormalizedHash $projectApp)) {
    throw 'BAT apply output differs from project app.js'
}
if (-not (Test-Path -LiteralPath "$tempApp.rp-fixed-image.bak")) {
    throw 'BAT apply did not create a backup'
}

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') restore $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT backup restore failed' }
if ((Get-NormalizedHash $tempApp) -ne '34A0E0C493227D46580506CE0B3A464D90F8234220E51E761DECCC4C4B5CB1A7') {
    throw 'BAT backup restore output does not match RP-Hub 1.7.6'
}

Write-Host 'app.js BAT patch smoke test passed'
