@echo off
setlocal
title StarPoint CN Server :8001
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found in PATH
    pause
    exit /b 1
)

rem Port check: free 8001 if a previous server is still listening.
rem Only the LISTENING owner, de-duplicated, skipping system PIDs (<=4).
echo [PORT] checking 8001 ...
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    if %%p GTR 4 (
        echo [PORT] freeing 8001 held by PID %%p
        taskkill /f /pid %%p >nul 2>nul
    )
)

if not exist "out\cn-server.js" (
    echo [BUILD] first run, building...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] build failed
        pause
        exit /b 1
    )
)

echo ============================================
echo  StarPoint CN  -  http://192.168.0.130:8001
echo  Close this window to stop the server.
echo  Rebuild after code changes: npm run build
echo ============================================
node --env-file=.env "out\cn-server.js"

echo.
echo [EXIT] server stopped (see errors above if any)
pause
