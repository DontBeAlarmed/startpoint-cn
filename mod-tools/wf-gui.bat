@echo off
cd /d "%~dp0.."
py -3 -V >nul 2>nul && (py -3 mod-tools\wf_gui.py & goto :done)
python -V >nul 2>nul && (python mod-tools\wf_gui.py & goto :done)
echo Python not found. Install Python 3.10+ from python.org and check "Add to PATH".
:done
pause
