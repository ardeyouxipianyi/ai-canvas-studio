param(
    [string]$PythonVersion = "3.13.13",
    [string]$NodeVersion = "22.22.3",
    [string]$RuntimeDir = "runtime"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$runtimePath = Join-Path $repoRoot $RuntimeDir
$downloadPath = Join-Path $runtimePath "_downloads"
$pythonZip = Join-Path $downloadPath "python-$PythonVersion-embed-amd64.zip"
$nodeZip = Join-Path $downloadPath "node-v$NodeVersion-win-x64.zip"
$pythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

function Download-File($Url, $Path) {
    if (Test-Path $Path) {
        Write-Host "[runtime] Already downloaded: $Path"
        return
    }
    Write-Host "[runtime] Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Path
}

function Reset-Directory($Path) {
    if (Test-Path $Path) {
        Remove-Item $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

New-Item -ItemType Directory -Force -Path $downloadPath | Out-Null

Download-File $pythonUrl $pythonZip
Download-File $nodeUrl $nodeZip

$pythonTarget = Join-Path $runtimePath "python"
$nodeTarget = Join-Path $runtimePath "node"
$nodeExtract = Join-Path $runtimePath "node-extract"

Write-Host "[runtime] Extracting Python..."
Reset-Directory $pythonTarget
Expand-Archive -Path $pythonZip -DestinationPath $pythonTarget -Force

Write-Host "[runtime] Extracting Node..."
Reset-Directory $nodeExtract
Reset-Directory $nodeTarget
Expand-Archive -Path $nodeZip -DestinationPath $nodeExtract -Force
$nodeRoot = Get-ChildItem $nodeExtract -Directory | Select-Object -First 1
if (-not $nodeRoot) {
    throw "Node archive layout is unexpected."
}
Copy-Item (Join-Path $nodeRoot.FullName "*") $nodeTarget -Recurse -Force
Remove-Item $nodeExtract -Recurse -Force

Write-Host "[runtime] Done."
Write-Host "[runtime] Python: $pythonTarget"
Write-Host "[runtime] Node: $nodeTarget"
