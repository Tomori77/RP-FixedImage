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

$sourceApp = Join-Path $ProjectRoot 'assets\js\app.js'
$tempApp = Join-Path $TempRoot 'assets\js\app.js'
Copy-Item -LiteralPath $sourceApp -Destination $tempApp -Force
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$updatedText = [IO.File]::ReadAllText($tempApp, [Text.Encoding]::UTF8) + "`n// Simulated RP update outside the patch points.`n"
[IO.File]::WriteAllText($tempApp, $updatedText, $utf8NoBom)
$originalHash = Get-NormalizedHash $tempApp

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') apply $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT apply failed' }
$patchedText = [IO.File]::ReadAllText($tempApp, [Text.Encoding]::UTF8)
if (-not $patchedText.Contains('const IMAGE_GEN_BASE_URL = window.location.origin;')) {
    throw 'BAT apply did not enable the same-origin proxy'
}
if ($patchedText -notmatch "&character_name=' \+ encodeURIComponent\(currentCharacter\.value\?\.name \|\| '[^']+'\) \+ '&model=") {
    throw 'BAT apply did not add the character name to image requests'
}
if (-not $patchedText.Contains('// Simulated RP update outside the patch points.')) {
    throw 'BAT apply discarded unrelated RP updates'
}
if (-not (Test-Path -LiteralPath "$tempApp.rp-fixed-image.bak")) {
    throw 'BAT apply did not create a backup'
}

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') apply $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT repeated apply failed' }

& (Join-Path $ProjectRoot 'rp-fixed-image-app.bat') restore $TempRoot
if ($LASTEXITCODE -ne 0) { throw 'BAT backup restore failed' }
if ((Get-NormalizedHash $tempApp) -ne $originalHash) {
    throw 'BAT restore did not reproduce the updated source app.js'
}

Write-Host 'app.js BAT patch smoke test passed'
