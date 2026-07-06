$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$env:UV_HOME = Join-Path $root ".uv-home"
$env:UV_CACHE_DIR = Join-Path $root ".uv-cache"
$env:UV_PYTHON_INSTALL_DIR = Join-Path $root ".uv-python"

$python = Join-Path $root ".venv-run\Scripts\python.exe"
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (Test-Path $python) {
    Start-Process -FilePath $python -ArgumentList "main.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput "backend.log" -RedirectStandardError "backend.err.log"
} elseif ($uv) {
    Start-Process -FilePath $uv.Source -ArgumentList "run","--python","3.13","main.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput "backend.log" -RedirectStandardError "backend.err.log"
} else {
    Start-Process -FilePath "python.exe" -ArgumentList "main.py" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput "backend.log" -RedirectStandardError "backend.err.log"
}
Write-Host "backend: http://127.0.0.1:8000"

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { throw "npm.cmd not found. Please install Node.js first." }
Start-Process -FilePath $npm.Source -ArgumentList "run","dev" -WorkingDirectory (Join-Path $root "web") -WindowStyle Hidden -RedirectStandardOutput "frontend.log" -RedirectStandardError "frontend.err.log"
Write-Host "web:     http://127.0.0.1:3000"
Write-Host "logs:    backend.log, backend.err.log, frontend.log, frontend.err.log"
