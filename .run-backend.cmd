@echo off
setlocal
cd /d "%~dp0"

if exist ".venv-run\Scripts\python.exe" (
  ".venv-run\Scripts\python.exe" main.py > backend.log 2> backend.err.log
  exit /b %errorlevel%
)

where uv >nul 2>nul
if %errorlevel%==0 (
  uv run --python 3.13 main.py > backend.log 2> backend.err.log
  exit /b %errorlevel%
)

python main.py > backend.log 2> backend.err.log
