@echo off
setlocal
cd /d "%~dp0"

start "ai-canvas-backend" /min cmd.exe /d /c call "%~dp0.run-backend.cmd"
start "ai-canvas-frontend" /min cmd.exe /d /c call "%~dp0.run-frontend.cmd"

echo backend: http://127.0.0.1:8000
echo web:     http://127.0.0.1:3000
echo logs:    backend.log, backend.err.log, frontend.log, frontend.err.log
echo.
echo Close the started cmd windows or stop node/python processes to stop dev servers.
