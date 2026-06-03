@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "PYTHONUTF8=1"

python server.py --host 0.0.0.0 --port 8000
