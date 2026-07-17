param(
    [string]$Action,
    [string]$Target
)

$ErrorActionPreference = 'Stop'
$SourceLine = "const IMAGE_GEN_BASE_URL = 'https://nai.sta1n.cn';"
$PatchedLine = 'const IMAGE_GEN_BASE_URL = window.location.origin;'
$SourceCharacterFragment = "&token=' + imageGenToken + '&model="
$PatchedCharacterFragment = "&token=' + imageGenToken + '&character_name=' + encodeURIComponent(currentCharacter.value?.name || '未命名角色') + '&model="
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-NormalizedHash([string]$Text) {
    $normalized = $Text.Replace("`r`n", "`n")
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Replace-Once([string]$Text, [string]$Old, [string]$New) {
    $index = $Text.IndexOf($Old, [StringComparison]::Ordinal)
    if ($index -lt 0) { throw "Patch point not found: $Old" }
    if ($Text.IndexOf($Old, $index + $Old.Length, [StringComparison]::Ordinal) -ge 0) {
        throw "Patch point is not unique: $Old"
    }
    return $Text.Substring(0, $index) + $New + $Text.Substring($index + $Old.Length)
}

function Get-OccurrenceCount([string]$Text, [string]$Value) {
    $count = 0
    $offset = 0
    while (($index = $Text.IndexOf($Value, $offset, [StringComparison]::Ordinal)) -ge 0) {
        $count++
        $offset = $index + $Value.Length
    }
    return $count
}

function Get-PatchState([string]$Text) {
    $sourceBaseCount = Get-OccurrenceCount $Text $SourceLine
    $patchedBaseCount = Get-OccurrenceCount $Text $PatchedLine
    $sourceCharacterCount = Get-OccurrenceCount $Text $SourceCharacterFragment
    $patchedCharacterCount = Get-OccurrenceCount $Text $PatchedCharacterFragment

    if ($sourceBaseCount -eq 1 -and $sourceCharacterCount -eq 1 -and $patchedBaseCount -eq 0 -and $patchedCharacterCount -eq 0) {
        return 'original'
    }
    if ($patchedBaseCount -eq 1 -and $patchedCharacterCount -eq 1 -and $sourceBaseCount -eq 0 -and $sourceCharacterCount -eq 0) {
        return 'patched'
    }
    return 'unknown'
}

if ([string]::IsNullOrWhiteSpace($Action)) {
    $Action = Read-Host 'Action: apply, restore, or status'
}
$Action = $Action.Trim().ToLowerInvariant()
if ($Action -notin @('apply', 'restore', 'status')) {
    throw 'Usage: rp-fixed-image-app.bat apply|restore|status [path-to-app.js-or-project-root]'
}

if ([string]::IsNullOrWhiteSpace($Target)) {
    $scriptRoot = if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $PSScriptRoot
    } else {
        Split-Path -Parent $env:RP_PATCH_SCRIPT
    }
    $Target = Join-Path $scriptRoot 'assets\js\app.js'
}
$Target = [IO.Path]::GetFullPath($Target)
if (Test-Path -LiteralPath $Target -PathType Container) {
    $Target = Join-Path $Target 'assets\js\app.js'
}
if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
    throw "app.js not found: $Target"
}

$originalText = [IO.File]::ReadAllText($Target, [Text.Encoding]::UTF8)
$currentState = Get-PatchState $originalText
$backup = "$Target.rp-fixed-image.bak"

if ($Action -eq 'status') {
    if ($currentState -eq 'original') { Write-Host 'Status: compatible original app.js' -ForegroundColor Cyan; exit 0 }
    if ($currentState -eq 'patched') { Write-Host 'Status: same-origin role image cache enabled' -ForegroundColor Green; exit 0 }
    Write-Host "Status: incompatible or partially modified app.js ($(Get-NormalizedHash $originalText))" -ForegroundColor Yellow
    exit 2
}

if ($Action -eq 'apply') {
    if ($currentState -eq 'patched') { Write-Host 'Same-origin role image cache is already enabled.' -ForegroundColor Green; exit 0 }
    if ($currentState -ne 'original') { throw "Cannot find unique compatible patch points in app.js: $(Get-NormalizedHash $originalText)" }
    [IO.File]::WriteAllText($backup, $originalText, $Utf8NoBom)
    $result = Replace-Once $originalText $SourceLine $PatchedLine
    $result = Replace-Once $result $SourceCharacterFragment $PatchedCharacterFragment
    if ((Get-PatchState $result) -ne 'patched') { throw 'Patched output verification failed.' }
    [IO.File]::WriteAllText($Target, $result, $Utf8NoBom)
    Write-Host "Enabled same-origin role image cache: $Target" -ForegroundColor Green
    Write-Host "Backup: $backup"
    exit 0
}

if ($currentState -eq 'original') { Write-Host 'app.js is already restored.' -ForegroundColor Cyan; exit 0 }
if ($currentState -ne 'patched') { throw "Refusing to restore an incompatible app.js: $(Get-NormalizedHash $originalText)" }

$result = Replace-Once $originalText $PatchedLine $SourceLine
$result = Replace-Once $result $PatchedCharacterFragment $SourceCharacterFragment
if ((Get-PatchState $result) -ne 'original') { throw 'Restored output verification failed.' }

if (Test-Path -LiteralPath $backup) {
    $backupText = [IO.File]::ReadAllText($backup, [Text.Encoding]::UTF8)
    if ((Get-PatchState $backupText) -ne 'original') { throw "Backup patch-point verification failed: $backup" }
    if ((Get-NormalizedHash $backupText) -ne (Get-NormalizedHash $result)) { throw "Backup does not match the patched app.js: $backup" }
    [IO.File]::WriteAllText($Target, $backupText, $Utf8NoBom)
} else {
    [IO.File]::WriteAllText($Target, $result, $Utf8NoBom)
}
Write-Host "Restored app.js: $Target" -ForegroundColor Cyan
