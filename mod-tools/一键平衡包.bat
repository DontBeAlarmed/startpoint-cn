@echo off
rem WF balance suite one-click runner (ASCII only, GBK/UTF-8 safe)
title WF Balance Suite
cd /d "%~dp0.."

echo ============================================
echo  WF Balance Suite - dry-run preview first
echo ============================================
python mod-tools\wf_balance_suite.py
echo.
echo ============================================
echo  [Y] apply + publish + export share pack
echo  [A] apply only (no publish)
echo  [other] quit, change nothing
set /p GO=Your choice:
if /i "%GO%"=="Y" goto full
if /i "%GO%"=="A" goto applyonly
echo Cancelled. Nothing changed.
goto end

:full
python mod-tools\wf_balance_suite.py --apply --publish --export-pack
goto end

:applyonly
python mod-tools\wf_balance_suite.py --apply

:end
pause
