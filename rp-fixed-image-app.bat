@echo off
setlocal
set "RP_PATCH_SCRIPT=%~dp0rp-fixed-image-app.ps1"
set "RP_PATCH_ACTION=%~1"
set "RP_PATCH_TARGET=%~2"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$code = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:RP_PATCH_SCRIPT; & ([ScriptBlock]::Create($code)) -Action $env:RP_PATCH_ACTION -Target $env:RP_PATCH_TARGET"
exit /b %errorlevel%
