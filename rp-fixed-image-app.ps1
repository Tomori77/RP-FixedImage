param(
    [string]$Action,
    [string]$Target
)

$ErrorActionPreference = 'Stop'
$SourceHash = '34a0e0c493227d46580506ce0b3a464d90f8234220e51e761deccc4c4b5cb1a7'
$PatchedHash = 'd75260bad2b505e36be6f9934fd1ca264130525c9ac8c59a110e0a3ba6672f9c'
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

function Replace-Once([string]$Text, [string]$Old, [string]$New, [string]$Label) {
    $index = $Text.IndexOf($Old, [StringComparison]::Ordinal)
    if ($index -lt 0) { throw "Patch point not found: $Label" }
    if ($Text.IndexOf($Old, $index + $Old.Length, [StringComparison]::Ordinal) -ge 0) {
        throw "Patch point is not unique: $Label"
    }
    return $Text.Substring(0, $index) + $New + $Text.Substring($index + $Old.Length)
}

function Convert-App([string]$InputText, [bool]$Apply) {
    $text = $InputText.Replace("`r`n", "`n")
    $pairs = New-Object System.Collections.Generic.List[object]

    $pairs.Add(@(
        "const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;",
        @"
void import('/rp-image/bridge.js').catch((error) => {
    console.warn('[RP-FixedImage] 图片桥接脚本加载失败:', error);
});

const { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;
"@.TrimEnd("`r", "`n"),
        'bridge loader'
    ))

    $pairs.Add(@(
        "        const IMAGE_GEN_BASE_URL = 'https://nai.sta1n.cn';",
        @"
        const FIXED_IMAGE_RENDER_PATH = '/rp-image/api/render';
        const FIXED_IMAGE_PROMPT_PLACEHOLDER = '__RP_IMAGE_PROMPT__';
        const IMAGE_GEN_NEGATIVE_PROMPT = '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}';
"@.TrimEnd("`r", "`n"),
        'image constants'
    ))

    $pairs.Add(@(
        @'
                const imageGenToken = settings.imageGenKey.trim();
                if (!imageGenToken) {
                    quotaValue.value = 0;
                    quotaAvailable.value = false;
                    return;
                }
                const baseUrl = IMAGE_GEN_BASE_URL;
                const response = await fetch(`${baseUrl}/api/api/getUser`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ toUserId: imageGenToken })
                });
                const data = await response.json();
                if (data.status === 'ok' && data.type === 'sta1n') {
                    const val = Number.parseInt(data.data?.value, 10);
'@.TrimEnd("`r", "`n"),
        @'
                const response = await fetch('/rp-image/api/settings/nai-key/test', {
                    method: 'POST',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const data = await response.json();
                if (response.ok && data.ok && data.test?.valid) {
                    const val = Number.parseInt(data.test.quota, 10);
'@.TrimEnd("`r", "`n"),
        'quota endpoint'
    ))

    $pairs.Add(@(
        @"
        let db = null;
        let legacyDb = null;
"@.TrimEnd("`r", "`n"),
        @"
        let db = null;
        let legacyDb = null;
        let fixedImagePersistencePaused = false;
"@.TrimEnd("`r", "`n"),
        'persistence state'
    ))

    $pairs.Add(@(
        @"
        const dbSetTo = (targetDb, key, value, options = {}) => {
            return new Promise((resolve, reject) => {
                if (!targetDb) return reject('DB not initialized');
"@.TrimEnd("`r", "`n"),
        @"
        const dbSetTo = (targetDb, key, value, options = {}) => {
            return new Promise((resolve, reject) => {
                if (fixedImagePersistencePaused) return resolve();
                if (!targetDb) return reject('DB not initialized');
"@.TrimEnd("`r", "`n"),
        'database write guard'
    ))

    $pairs.Add(@(
        @"
        const saveTokenUsageHistoryNow = () => {
            const snapshot = cloneForStorage(tokenUsageHistory.value);
"@.TrimEnd("`r", "`n"),
        @"
        const saveTokenUsageHistoryNow = () => {
            if (fixedImagePersistencePaused) return Promise.resolve();
            const snapshot = cloneForStorage(tokenUsageHistory.value);
"@.TrimEnd("`r", "`n"),
        'token usage guard'
    ))

    $pairs.Add(@(
        @"
            }
            const characterId = currentCharacter.value?.uuid;
            if (currentCharacterIndex.value < 0 || !characterId) return Promise.resolve(false);
"@.TrimEnd("`r", "`n"),
        @"
            }
            if (fixedImagePersistencePaused) return Promise.resolve(false);
            const characterId = currentCharacter.value?.uuid;
            if (currentCharacterIndex.value < 0 || !characterId) return Promise.resolve(false);
"@.TrimEnd("`r", "`n"),
        'chat save guard'
    ))

    $pairs.Add(@(
        @"
        const saveData = async (options = {}) => {
            const { saveMemories = true } = options;
"@.TrimEnd("`r", "`n"),
        @"
        const saveData = async (options = {}) => {
            if (fixedImagePersistencePaused) return;
            const { saveMemories = true } = options;
"@.TrimEnd("`r", "`n"),
        'main save guard'
    ))

    $pairs.Add(@(
        @"
        const saveConversationMutationNow = async ({ saveTemplateRuntime = false } = {}) => {
            try {
"@.TrimEnd("`r", "`n"),
        @"
        const saveConversationMutationNow = async ({ saveTemplateRuntime = false } = {}) => {
            if (fixedImagePersistencePaused) return;
            try {
"@.TrimEnd("`r", "`n"),
        'conversation save guard'
    ))

    $pairs.Add(@(
        @"
        const dbDeleteFrom = (targetDb, key) => {
            return new Promise((resolve, reject) => {
                if (!targetDb) return resolve();
"@.TrimEnd("`r", "`n"),
        @"
        const dbDeleteFrom = (targetDb, key) => {
            return new Promise((resolve, reject) => {
                if (fixedImagePersistencePaused) return resolve();
                if (!targetDb) return resolve();
"@.TrimEnd("`r", "`n"),
        'database delete guard'
    ))

    $pairs.Add(@(
        @"
            newReplacement = newReplacement.replace(/size=[^&]+/, 'size=' + settings.imageSize);
            regex.replacement = newReplacement;
"@.TrimEnd("`r", "`n"),
        @"
            const encodedImageSize = encodeURIComponent(settings.imageSize);
            newReplacement = newReplacement.replace(/size=[^&]+/, 'size=' + encodedImageSize);
            regex.replacement = newReplacement;
"@.TrimEnd("`r", "`n"),
        'encoded image size'
    ))

    $pairs.Add(@(
        "            if (oldSize !== settings.imageSize) {",
        "            if (oldSize !== encodedImageSize) {",
        'image size comparison'
    ))

    $pairs.Add(@(
        @"
        const currentCharacter = computed(() => {
            return currentCharacterIndex.value >= 0 ? characters.value[currentCharacterIndex.value] : null;
        });
"@.TrimEnd("`r", "`n"),
        @"
        const currentCharacter = computed(() => {
            return currentCharacterIndex.value >= 0 ? characters.value[currentCharacterIndex.value] : null;
        });
        const buildFixedImageUrl = ({ prompt, artist, size } = {}) => {
            const character = currentCharacter.value;
            if (!character?.uuid) return '';

            const url = new URL(FIXED_IMAGE_RENDER_PATH, window.location.origin);
            url.searchParams.set('character_name', character.name || '未命名角色');
            url.searchParams.set('character_uuid', character.uuid);
            url.searchParams.set('tag', prompt || FIXED_IMAGE_PROMPT_PLACEHOLDER);
            url.searchParams.set('model', 'nai-diffusion-4-5-full');
            url.searchParams.set('artist', artist || '');
            url.searchParams.set('size', size || settings.imageSize);
            url.searchParams.set('steps', '40');
            url.searchParams.set('scale', '6');
            url.searchParams.set('cfg', '0');
            url.searchParams.set('sampler', 'k_dpmpp_2m_sde');
            url.searchParams.set('negative', IMAGE_GEN_NEGATIVE_PROMPT);
            url.searchParams.set('nocache', '0');
            url.searchParams.set('noise_schedule', 'karras');
            return url.href;
        };
"@.TrimEnd("`r", "`n"),
        'image URL builder'
    ))

    $pairs.Add(@(
        "                    const re = new RegExp(regexPattern, flags);",
        @"
                    const re = new RegExp(regexPattern, flags);
                    const replaceText = (input) => {
                        if ((script.name || script.scriptName) !== 'NAI画图正则') {
                            return input.replace(re, replacement);
                        }
                        return input.replace(re, (match, prompt) => String(replacement).replace(
                            encodeURIComponent(FIXED_IMAGE_PROMPT_PLACEHOLDER),
                            encodeURIComponent(String(prompt || '').trim())
                        ));
                    };
"@.TrimEnd("`r", "`n"),
        'prompt encoder'
    ))

    $pairs.Add(@(
        "                            return part.replace(re, replacement);",
        "                            return replaceText(part);",
        'protected regex replacement'
    ))

    $pairs.Add(@(
        "                        result = result.replace(re, replacement);",
        "                        result = replaceText(result);",
        'direct regex replacement'
    ))

    $pairs.Add(@(
        @"
                const baseUrl = IMAGE_GEN_BASE_URL;

                await fetch(baseUrl, {
                    method: 'HEAD',
                    mode: 'no-cors',
                    signal: controller.signal
                });
"@.TrimEnd("`r", "`n"),
        @'
                const response = await fetch('/rp-image/api/settings/public', {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
'@.TrimEnd("`r", "`n"),
        'image service status'
    ))

    $pairs.Add(@(
        @"
        const enforceSpecialRules = () => {
            const imageGenToken = settings.imageGenKey.trim();
            const baseUrl = IMAGE_GEN_BASE_URL;

            // 1. NAI画图正则 (统一版本)
"@.TrimEnd("`r", "`n"),
        @"
        const enforceSpecialRules = () => {
            // 1. NAI画图正则 (统一版本)
"@.TrimEnd("`r", "`n"),
        'remove browser NAI key'
    ))

    $pairs.Add(@(
        @"
            const encodedTargetArtists = encodeURIComponent(targetArtists);
            const imageGenRegexContent = {
"@.TrimEnd("`r", "`n"),
        @"
            const imageSourceUrl = buildFixedImageUrl({
                prompt: FIXED_IMAGE_PROMPT_PLACEHOLDER,
                artist: targetArtists,
                size: settings.imageSize
            });
            const imageGenRegexContent = {
"@.TrimEnd("`r", "`n"),
        'worker image URL'
    ))

    $originalReplacement = @'
                replacement: '<div style="width: auto; height: auto; max-width: 100%; box-sizing: border-box; padding: 2px; border: 1px solid rgba(255,255,255,0.58); background: rgba(255,255,255,0.32); position: relative; border-radius: 12px; overflow: hidden; display: inline-flex; justify-content: center; align-items: center; box-shadow: 0 4px 14px rgba(148,163,184,0.06);"><img src="' + baseUrl + '/generate?tag=$1&token=' + imageGenToken + '&model=nai-diffusion-4-5-full&artist=' + encodedTargetArtists + '&size=' + settings.imageSize + '&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative={{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}&nocache=0&noise_schedule=karras"  alt="生成图片" style="max-width: 100%; height: auto; width: auto; display: block; object-fit: contain; border-radius: 9px; transition: transform 0.3s ease;"></div>',
'@.TrimEnd("`r", "`n")
    $fixedReplacement = @'
                replacement: '<div style="width: auto; height: auto; max-width: 100%; box-sizing: border-box; padding: 2px; border: 1px solid rgba(255,255,255,0.58); background: rgba(255,255,255,0.32); position: relative; border-radius: 12px; overflow: hidden; display: inline-flex; justify-content: center; align-items: center; box-shadow: 0 4px 14px rgba(148,163,184,0.06);"><img src="' + imageSourceUrl + '" alt="生成图片" style="max-width: 100%; height: auto; width: auto; display: block; object-fit: contain; border-radius: 9px; transition: transform 0.3s ease;"></div>',
'@.TrimEnd("`r", "`n")
    $pairs.Add(@($originalReplacement, $fixedReplacement, 'image replacement HTML'))

    $pairs.Add(@(
        @"
        watch(() => settings.imageGenKey, () => {
            enforceSpecialRules();
"@.TrimEnd("`r", "`n"),
        @"
        window.RPH_BACKUP_HOST = {
            flush: async () => {
                await saveData();
                await flushPendingChatHistorySave();
            },
            pause: async () => {
                fixedImagePersistencePaused = true;
            },
            resume: async () => {
                fixedImagePersistencePaused = false;
            },
            reload: async () => window.location.reload()
        };

        watch(() => settings.imageGenKey, (value) => {
            if (String(value || '').trim()) {
                settings.imageGenKey = '';
                showToast('NAI Key 请前往 /rp-image 管理台配置，RP-Hub 不再保存该密钥', 'info', 5000);
                return;
            }
            enforceSpecialRules();
"@.TrimEnd("`r", "`n"),
        'backup host and key redirect'
    ))

    foreach ($pair in $pairs) {
        $old = if ($Apply) { [string]$pair[0] } else { [string]$pair[1] }
        $new = if ($Apply) { [string]$pair[1] } else { [string]$pair[0] }
        $text = Replace-Once $text $old $new ([string]$pair[2])
    }
    return $text
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
$newline = if ($originalText.Contains("`r`n")) { "`r`n" } else { "`n" }
$currentHash = Get-NormalizedHash $originalText
$backup = "$Target.rp-fixed-image.bak"

if ($Action -eq 'status') {
    if ($currentHash -eq $SourceHash) { Write-Host 'Status: original RP-Hub 1.7.6 app.js' -ForegroundColor Cyan; exit 0 }
    if ($currentHash -eq $PatchedHash) { Write-Host 'Status: RP-FixedImage patch applied' -ForegroundColor Green; exit 0 }
    Write-Host "Status: unknown or partially modified app.js ($currentHash)" -ForegroundColor Yellow
    exit 2
}

if ($Action -eq 'apply') {
    if ($currentHash -eq $PatchedHash) { Write-Host 'RP-FixedImage patch is already applied.' -ForegroundColor Green; exit 0 }
    if ($currentHash -ne $SourceHash) { throw "Refusing to patch an unknown app.js version: $currentHash" }
    if (-not (Test-Path -LiteralPath $backup)) {
        [IO.File]::WriteAllText($backup, $originalText, $Utf8NoBom)
    } else {
        $backupHash = Get-NormalizedHash ([IO.File]::ReadAllText($backup, [Text.Encoding]::UTF8))
        if ($backupHash -ne $SourceHash) { throw "Existing backup is not RP-Hub 1.7.6: $backup" }
    }
    $result = Convert-App $originalText $true
    if ((Get-NormalizedHash $result) -ne $PatchedHash) { throw 'Patched output hash verification failed.' }
    [IO.File]::WriteAllText($Target, $result.Replace("`n", $newline), $Utf8NoBom)
    Write-Host "Applied RP-FixedImage patch: $Target" -ForegroundColor Green
    Write-Host "Backup: $backup"
    exit 0
}

if ($currentHash -eq $SourceHash) { Write-Host 'app.js is already restored.' -ForegroundColor Cyan; exit 0 }
if ($currentHash -ne $PatchedHash) { throw "Refusing to restore an unknown app.js version: $currentHash" }

if (Test-Path -LiteralPath $backup) {
    $backupText = [IO.File]::ReadAllText($backup, [Text.Encoding]::UTF8)
    if ((Get-NormalizedHash $backupText) -ne $SourceHash) { throw "Backup hash verification failed: $backup" }
    [IO.File]::WriteAllText($Target, $backupText, $Utf8NoBom)
} else {
    $result = Convert-App $originalText $false
    if ((Get-NormalizedHash $result) -ne $SourceHash) { throw 'Restored output hash verification failed.' }
    [IO.File]::WriteAllText($Target, $result.Replace("`n", $newline), $Utf8NoBom)
}
Write-Host "Restored RP-Hub 1.7.6 app.js: $Target" -ForegroundColor Cyan
