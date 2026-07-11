@echo off
setlocal
title StarPoint CN launcher
cd /d "%~dp0"

rem ---- 1) server window (reuses start-cn.bat: port cleanup + build-if-needed) ----
start "" "%~dp0start-cn.bat"

rem ---- 2) wait for server on 8001 (max ~30s) ----
echo [WAIT] server on 8001 ...
powershell -NoProfile -Command "$ok=$false; foreach($i in 1..30){ try{ Invoke-RestMethod 'http://192.168.0.130:8001/api/server/currentTime' -TimeoutSec 2 | Out-Null; $ok=$true; break } catch { Start-Sleep 1 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 echo [WARN] server not confirmed in 30s, opening pages anyway

rem ---- 3) mod GUI window (port 18803; 8765 is taken by an IME on this PC) ----
rem      wf_gui opens its own browser page automatically
start "WF Mod GUI :18803" cmd /k "set WF_GUI_PORT=18803&& python mod-tools\wf_gui.py"

rem ---- 4) admin panel ----
start "" http://192.168.0.130:8001/admin

exit /b 0
