@echo off
setlocal

cd /d "%~dp0"

set "ROOT=%~dp0"
set "APP_DIR=%ROOT%app"
set "DATA_DIR=%APP_DIR%\data"
set "PYTHON_EXE=%ROOT%runtime\python\python.exe"
set "LOG_DIR=%ROOT%logs"
set "LOG_FILE=%LOG_DIR%\server.log"
set "ERR_FILE=%LOG_DIR%\server.err.log"
set "PID_FILE=%LOG_DIR%\server.pid"

if not exist "%PYTHON_EXE%" (
  echo [ai-canvas-studio] Missing runtime\python\python.exe
  echo Please use the complete Windows portable package.
  pause
  exit /b 1
)

if not exist "%APP_DIR%\main.py" (
  echo [ai-canvas-studio] Missing app\main.py
  echo Please keep the extracted package structure unchanged.
  pause
  exit /b 1
)

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set "CHATGPT2API_HOST=0.0.0.0"
set "CHATGPT2API_PORT=3000"
set "PYTHONUTF8=1"
set "PYTHONPATH=%APP_DIR%;%APP_DIR%\python_packages"
set "PATH=%ROOT%runtime\python;%ROOT%runtime\python\Scripts;%ROOT%runtime\node;%PATH%"

set "PORT_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  set "PORT_PID=%%p"
)

if defined PORT_PID (
  echo [ai-canvas-studio] Port 3000 is already in use by PID %PORT_PID%.
  echo If AI Canvas Studio is already running, the browser will open now.
  echo If this is another program, run stop.bat or close that program first.
  start "" "http://localhost:3000"
  pause
  exit /b 0
)

echo [ai-canvas-studio] Starting...
echo [ai-canvas-studio] Web: http://localhost:3000
echo [ai-canvas-studio] Log: %LOG_FILE%
echo.

echo [%date% %time%] Starting ai-canvas-studio > "%LOG_FILE%"
echo [%date% %time%] Starting ai-canvas-studio > "%ERR_FILE%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath $env:PYTHON_EXE -ArgumentList 'main.py' -WorkingDirectory $env:APP_DIR -WindowStyle Minimized -PassThru -RedirectStandardOutput $env:LOG_FILE -RedirectStandardError $env:ERR_FILE; $p.Id | Set-Content -Encoding ascii $env:PID_FILE"

if errorlevel 1 (
  echo [ai-canvas-studio] Failed to start Python service.
  echo.
  type "%ERR_FILE%"
  pause
  exit /b 1
)

echo [ai-canvas-studio] Waiting for service...
for /l %%i in (1,1,30) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/' -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } } catch { exit 1 }"
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)

echo [ai-canvas-studio] Service did not become ready.
echo.
if exist "%ERR_FILE%" (
  echo [ai-canvas-studio] Error log:
  type "%ERR_FILE%"
)
if exist "%LOG_FILE%" (
  echo.
  echo [ai-canvas-studio] Server log:
  type "%LOG_FILE%"
)
echo.
echo Please keep this window open and send the logs above when asking for help.
pause
exit /b 1

:ready
start "" "http://localhost:3000"

echo [ai-canvas-studio] Started successfully.
echo [ai-canvas-studio] You can close this window. Use stop.bat to stop the service.
pause
