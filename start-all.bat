@echo off
setlocal
title StarPoint CN launcher
cd /d "%~dp0"

rem ---- 1) server window (safe ownership checks + freshness-aware build) ----
start "" "%~dp0start-cn.bat"

rem ---- 2) resolve .env endpoint and wait for the server (max ~30s) ----
set "CN_BASE_URL="
for /f "usebackq delims=" %%u in (`node --env-file=.env -p "(()=>{const h=process.env.CN_LISTEN_HOST?process.env.CN_LISTEN_HOST:'127.0.0.1';const p=process.env.CN_LISTEN_PORT?process.env.CN_LISTEN_PORT:'8001';const d=['0.0.0.0','::'].includes(h)?'127.0.0.1':h;const u=d.includes(':')?'['+d+']':d;return 'http://'+u+':'+p})()"`) do set "CN_BASE_URL=%%u"
if not defined CN_BASE_URL (
    echo [ERROR] could not resolve CN_LISTEN_HOST/CN_LISTEN_PORT from .env
    exit /b 1
)
echo [WAIT] server on %CN_BASE_URL% ...
powershell -NoProfile -Command "$ok=$false; foreach($i in 1..30){ try{ Invoke-RestMethod '%CN_BASE_URL%/api/admin-auth/session' -TimeoutSec 2 | Out-Null; $ok=$true; break } catch { Start-Sleep 1 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 echo [WARN] server not confirmed in 30s, opening pages anyway

rem ---- 3) mod GUI window (port 18803; 8765 is taken by an IME on this PC) ----
rem      wf_gui opens its own browser page automatically
start "WF Mod GUI :18803" cmd /k "set WF_GUI_PORT=18803&& python mod-tools\wf_gui.py"

rem ---- 4) admin panel ----
start "" "%CN_BASE_URL%/admin"

exit /b 0
