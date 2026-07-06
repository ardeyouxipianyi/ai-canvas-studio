@echo off
setlocal
cd /d "%~dp0web"

where npm >nul 2>nul
if not %errorlevel%==0 (
  echo npm not found. Please install Node.js first. > "%~dp0frontend.err.log"
  exit /b 1
)

npm run dev > "%~dp0frontend.log" 2> "%~dp0frontend.err.log"
