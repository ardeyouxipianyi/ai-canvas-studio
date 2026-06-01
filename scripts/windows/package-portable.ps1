param(
    [string]$OutputDir = "dist\chatgpt2api-windows-portable",
    [string]$RuntimeDir = "runtime",
    [switch]$SkipWebBuild,
    [switch]$SkipPythonPackages
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$outputPath = Join-Path $repoRoot $OutputDir
$runtimePath = Join-Path $repoRoot $RuntimeDir
$appPath = Join-Path $outputPath "app"

function Copy-Directory($Source, $Destination) {
    if (Test-Path $Destination) {
        Remove-Item $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item (Join-Path $Source "*") $Destination -Recurse -Force
}

Write-Host "[portable] Output: $outputPath"

if (Test-Path $outputPath) {
    Remove-Item $outputPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appPath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $outputPath "runtime") | Out-Null

if (-not $SkipWebBuild) {
    Write-Host "[portable] Building web_dist..."
    Push-Location (Join-Path $repoRoot "web")
    try {
        if (Test-Path (Join-Path $runtimePath "node\npm.cmd")) {
            & (Join-Path $runtimePath "node\npm.cmd") install --no-package-lock
            & (Join-Path $runtimePath "node\npm.cmd") run build
        } else {
            npm install --no-package-lock
            npm run build
        }
    } finally {
        Pop-Location
    }
    if (Test-Path (Join-Path $repoRoot "web\out")) {
        Copy-Directory (Join-Path $repoRoot "web\out") (Join-Path $repoRoot "web_dist")
    }
}

Write-Host "[portable] Copying application files..."
$items = @(
    "api",
    "services",
    "utils",
    "scripts",
    "main.py",
    "VERSION",
    "pyproject.toml",
    "uv.lock",
    "README.md",
    "LICENSE"
)

foreach ($item in $items) {
    $source = Join-Path $repoRoot $item
    if (Test-Path $source) {
        Copy-Item $source (Join-Path $appPath $item) -Recurse -Force
    }
}

$portableConfigJson = @'
{
  "auth-key": "chatgpt2api",
  "refresh_account_interval_minute": 60,
  "image_retention_days": 15,
  "image_poll_timeout_secs": 120,
  "auto_remove_rate_limited_accounts": false,
  "auto_remove_invalid_accounts": true,
  "log_levels": [
    "debug",
    "error",
    "info",
    "warning"
  ],
  "proxy": "",
  "base_url": "",
  "sensitive_words": [],
  "global_system_prompt": "",
  "ai_review": {
    "enabled": false,
    "base_url": "",
    "api_key": "",
    "model": "",
    "prompt": ""
  },
  "backup": {
    "enabled": false,
    "provider": "cloudflare_r2",
    "account_id": "",
    "access_key_id": "",
    "secret_access_key": "",
    "bucket": "",
    "prefix": "backups",
    "interval_minutes": 1440,
    "rotation_keep": 10,
    "encrypt": false,
    "passphrase": "",
    "include": {
      "config": true,
      "register": false,
      "cpa": true,
      "sub2api": true,
      "logs": true,
      "image_tasks": true,
      "image_conversations": true,
      "image_canvas": true,
      "accounts_snapshot": true,
      "auth_keys_snapshot": true,
      "images": false
    }
  },
  "image_account_concurrency": 3,
  "account_refresh_concurrency": 10,
  "image_account_recheck_interval_secs": 300
}
'@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $appPath "config.example.json"), $portableConfigJson + [Environment]::NewLine, $utf8NoBom)

if (Test-Path (Join-Path $repoRoot "web_dist")) {
    Copy-Directory (Join-Path $repoRoot "web_dist") (Join-Path $appPath "web_dist")
} else {
    Write-Warning "web_dist not found. Run web build before packaging."
}

if (Test-Path (Join-Path $runtimePath "python")) {
    Write-Host "[portable] Copying runtime/python..."
    Copy-Directory (Join-Path $runtimePath "python") (Join-Path $outputPath "runtime\python")
    $pthFiles = Get-ChildItem (Join-Path $outputPath "runtime\python") -Filter "python*._pth" -ErrorAction SilentlyContinue
    foreach ($pth in $pthFiles) {
        $existing = Get-Content $pth.FullName -ErrorAction SilentlyContinue
        $next = @()
        foreach ($line in $existing) {
            if ($line -and $line.Trim() -notin @("..\..\app", "..\..\app\python_packages", "import site")) {
                $next += $line
            }
        }
        $next += "..\..\app"
        $next += "..\..\app\python_packages"
        $next += "import site"
        Set-Content -Path $pth.FullName -Value $next -Encoding ascii
    }
} else {
    Write-Warning "runtime/python not found. The package will not be fully portable."
}

if (Test-Path (Join-Path $runtimePath "node")) {
    Write-Host "[portable] Copying runtime/node..."
    Copy-Directory (Join-Path $runtimePath "node") (Join-Path $outputPath "runtime\node")
} else {
    Write-Warning "runtime/node not found. Runtime Node is optional after web_dist is built."
}

Copy-Item (Join-Path $PSScriptRoot "portable\start.bat") (Join-Path $outputPath "start.bat") -Force
Copy-Item (Join-Path $PSScriptRoot "portable\stop.bat") (Join-Path $outputPath "stop.bat") -Force

if (-not $SkipPythonPackages) {
    Write-Host "[portable] Installing Python packages into app/python_packages..."
    $packageDir = Join-Path $appPath "python_packages"
    New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
    $requirements = @(
        "curl-cffi>=0.15.0",
        "fastapi>=0.136.0",
        "pillow>=12.2.0",
        "pybase64>=1.4.3",
        "python-multipart>=0.0.26",
        "tiktoken>=0.12.0",
        "uvicorn>=0.44.0",
        "sqlalchemy>=2.0.0",
        "psycopg2-binary>=2.9.0",
        "gitpython>=3.1.0"
    )

    $pythonCandidates = @(
        (Join-Path $outputPath "runtime\python\python.exe"),
        "py",
        "python"
    )

    $installed = $false
    foreach ($python in $pythonCandidates) {
        try {
            if ($python -eq "py") {
                & py -3.13 -m pip install --upgrade --target $packageDir $requirements
            } else {
                & $python -m pip install --upgrade --target $packageDir $requirements
            }
            if ($LASTEXITCODE -eq 0) {
                $installed = $true
                break
            }
        } catch {
            continue
        }
    }

    if (-not $installed) {
        Write-Warning "Failed to install Python packages. Make sure Python 3.13 with pip is available when building the portable package."
    }
}

$dataDir = Join-Path $appPath "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "[portable] Done."
Write-Host "[portable] Package folder: $outputPath"
Write-Host "[portable] Zip this folder for users. They can run start.bat after extracting it."
