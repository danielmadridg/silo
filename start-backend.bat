@echo off
echo Starting Silo backend...
cd /d "%~dp0backend"
call .venv\Scripts\activate.bat
uvicorn main:app --host 127.0.0.1 --port 8942 --workers 1 --log-level info
