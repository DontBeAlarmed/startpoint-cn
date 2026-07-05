@echo off
cd /d "%~dp0.."
set "PY=py -3"
%PY% -V >nul 2>nul || set "PY=python"
%PY% mod-tools\wf_harvest_paths.py --out mod-tools\HarvestedPaths.csv
pause
