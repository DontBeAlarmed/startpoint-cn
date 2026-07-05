@echo off
rem 与 wf_gui.py 同目录直接运行:独立仓库(startpoint-cn-mod-tools)或 startpoint-cn/mod-tools/ 内均可双击
rem 独立部署请先配置(取消注释并改成你的路径),或改 profiles.json:
rem set WF_TARGET_STORE=D:\path\WorldFlipper\dummy\download\production\upload
rem set WF_CDNDATA=D:\path\startpoint-cn\assets\cdndata
rem set WF_CDN_DIR=D:\path\startpoint-cn\.cdn\cn
cd /d "%~dp0"
py -3 -V >nul 2>nul && (py -3 wf_gui.py & goto :done)
python -V >nul 2>nul && (python wf_gui.py & goto :done)
echo Python not found. Install Python 3.10+ from python.org and check "Add to PATH".
:done
pause
