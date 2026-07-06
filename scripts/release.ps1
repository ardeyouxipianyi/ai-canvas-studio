param(
    [Parameter(Mandatory=$true)]
    [string]$Version,
    [string]$ReleaseName = "",
    [string]$RuntimeDir = "runtime",
    [string]$ReleaseRepo = "",
    [switch]$SkipTests,
    [switch]$AllowTestFailures,
    [switch]$SkipPackage,
    [switch]$NoCommit,
    [switch]$NoPush,
    [switch]$NoGitHubRelease,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$tag = "v$Version"
if (-not $ReleaseName) { $ReleaseName = $tag }
if ($DryRun) {
    $NoCommit = $true
    $NoPush = $true
    $NoGitHubRelease = $true
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$Command,
        [Parameter(Mandatory=$true)]
        [string]$FailureMessage
    )
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command 2>&1 | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) { throw $FailureMessage }
}

function Get-GitHubRepository {
    if ($ReleaseRepo) { return $ReleaseRepo }
    $remoteUrl = (git config --get remote.origin.url)
    if (-not $remoteUrl) { throw "Cannot determine GitHub repository. Pass -ReleaseRepo owner/name." }
    if ($remoteUrl -match 'github\.com[:/](?<repo>[^/]+/[^/.]+)(\.git)?$') {
        return $Matches.repo
    }
    throw "Cannot parse GitHub repository from remote.origin.url. Pass -ReleaseRepo owner/name."
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Release $tag" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Validate
Write-Host "[1/9] Validating..." -ForegroundColor Yellow
$currentVersion = (Get-Content VERSION -Raw).Trim()
Write-Host "  Current VERSION: $currentVersion -> $Version"
if ((git status --porcelain --untracked-files=no) -and -not $NoCommit) {
    throw "Working tree has tracked changes. Commit or stash them first, or run with -NoCommit."
}
if ($DryRun) {
    Write-Host "  [DRY RUN] Would update VERSION." -ForegroundColor DarkGray
} else {
    Set-Content -Path VERSION -Value $Version -NoNewline
}
$readmeText = Get-Content README.md -Raw
$changelogText = Get-Content CHANGELOG.md -Raw
if ($readmeText -notmatch [regex]::Escape($tag)) {
    throw "README.md does not mention $tag. Update release notes before publishing."
}
if ($changelogText -notmatch "(?m)^##\s+$([regex]::Escape($tag))\b") {
    throw "CHANGELOG.md is missing a $tag section."
}

# Step 2: TypeScript check
Write-Host ""
Write-Host "[2/9] TypeScript check..." -ForegroundColor Yellow
Push-Location web
try {
    Invoke-LoggedCommand { & cmd /c "node_modules\.bin\tsc.cmd --noEmit" } "TypeScript check failed."
    Write-Host "  PASSED"
} finally { Pop-Location }

# Step 3: Frontend build
Write-Host ""
Write-Host "[3/9] Frontend build..." -ForegroundColor Yellow
Push-Location web
try {
    Invoke-LoggedCommand { & cmd /c npm run build } "Frontend build failed."
    Write-Host "  PASSED"
} finally { Pop-Location }

# Step 4: Backend syntax check
Write-Host ""
Write-Host "[4/9] Backend syntax check..." -ForegroundColor Yellow
Invoke-LoggedCommand { & uv run python -m compileall services api test -q } "Backend check failed."
Write-Host "  PASSED"

# Step 5: Tests
if (-not $SkipTests) {
    Write-Host ""
    Write-Host "[5/9] Running tests..." -ForegroundColor Yellow
    & uv run python -m unittest discover -s test -t . 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        if ($AllowTestFailures) {
            Write-Warning "Test failures detected. Continuing because -AllowTestFailures was set."
        } else {
            throw "Tests failed. Use -AllowTestFailures only after confirming failures are environment-related."
        }
    }
    else { Write-Host "  PASSED" }
} else {
    Write-Host "[5/9] Tests skipped." -ForegroundColor DarkGray
}

# Step 6: Package
$zipPath = $null
$sha256 = $null
if (-not $SkipPackage) {
    Write-Host ""
    Write-Host "[6/9] Packaging Windows portable..." -ForegroundColor Yellow
    $runtimePath = Join-Path $repoRoot $RuntimeDir
    $missingPython = -not (Test-Path (Join-Path $runtimePath "python"))
    $missingNode = -not (Test-Path (Join-Path $runtimePath "node"))
    if ($missingPython -or $missingNode) {
        Write-Host "  Downloading runtimes..."
        Invoke-LoggedCommand { & powershell -ExecutionPolicy Bypass -File scripts\windows\download-runtimes.ps1 -RuntimeDir $RuntimeDir } "Runtime download failed."
    }
    $distName = "ai-canvas-studio-windows-portable-$tag"
    $distDir = "dist\$distName"
    Invoke-LoggedCommand { & powershell -ExecutionPolicy Bypass -File scripts\windows\package-portable.ps1 -OutputDir $distDir -RuntimeDir $RuntimeDir -SkipWebBuild } "Packaging failed."

    Push-Location "$distDir\app"
    try {
        Invoke-LoggedCommand { & "..\runtime\python\python.exe" -c "import main; print('ok')" } "Import check failed."
    } finally { Pop-Location }

    $zipPath = "dist\$distName.zip"
    if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path "$distDir\*" -DestinationPath $zipPath -Force
    $hash = Get-FileHash $zipPath -Algorithm SHA256
    $sha256 = $hash.Hash
    $sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "  $zipPath ($sizeMB MB)"
    Write-Host "  SHA256: $sha256"
} else {
    Write-Host "[6/9] Packaging skipped." -ForegroundColor DarkGray
}

# Step 7: Commit
Write-Host ""
Write-Host "[7/9] Committing..." -ForegroundColor Yellow
if ($NoCommit) {
    Write-Host "  Skipped." -ForegroundColor DarkGray
} else {
    git add VERSION README.md CHANGELOG.md scripts/release.ps1
    Invoke-LoggedCommand { git commit -m "release $tag" } "Commit failed."
    Write-Host "  Committed."
}

# Step 8: Tag and push
Write-Host ""
Write-Host "[8/9] Tagging and pushing..." -ForegroundColor Yellow
if ($NoPush) {
    Write-Host "  Skipped." -ForegroundColor DarkGray
} else {
    Invoke-LoggedCommand { git tag -a $tag -m $tag } "Tag failed. Delete or rename the existing tag before releasing."
    Invoke-LoggedCommand { git push origin HEAD:main } "Push failed."
    Invoke-LoggedCommand { git push origin $tag } "Tag push failed."
    Write-Host "  Pushed."
}

# Step 9: GitHub Release
Write-Host ""
Write-Host "[9/9] GitHub Release..." -ForegroundColor Yellow
if ($NoGitHubRelease) {
    Write-Host "  Skipped." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Done! $tag" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    if ($sha256) { Write-Host "  SHA256: $sha256" }
    exit 0
}
$credLines = "protocol=https`nhost=github.com`n`n" | git credential fill
$password = ($credLines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1) -replace '^password=', ''
if (-not $password) {
    Write-Warning "No GitHub credential. Create release manually."
} elseif ($DryRun) {
    Write-Host "  [DRY RUN] Would create release $tag" -ForegroundColor DarkGray
} else {
    $repo = Get-GitHubRepository
    $headers = @{
        Authorization = "Bearer $password"
        Accept = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent' = 'ai-canvas-studio-release'
    }
    $releaseBody = "Release $tag"
    if ($sha256) { $releaseBody += "`n`nWindows portable SHA256: ``$sha256``" }

    try {
        $existing = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers
        foreach ($asset in $existing.assets) {
            Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$repo/releases/assets/$($asset.id)" -Headers $headers | Out-Null
        }
        Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$repo/releases/$($existing.id)" -Headers $headers | Out-Null
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
    }

    $body = @{
        tag_name = $tag
        target_commitish = 'main'
        name = $ReleaseName
        body = $releaseBody
        draft = $false
        prerelease = $false
    } | ConvertTo-Json -Depth 5

    $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
    Write-Host "  Release: $($release.html_url)"

    if ($zipPath -and (Test-Path $zipPath)) {
        $leaf = Split-Path $zipPath -Leaf
        $uploadUri = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$leaf"
        Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -ContentType 'application/zip' -InFile (Resolve-Path $zipPath).Path | Out-Null
        Write-Host "  Asset: $leaf"
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Done! $tag" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "  https://github.com/ardeyouxipianyi/ai-canvas-studio/releases/tag/$tag"
if ($sha256) { Write-Host "  SHA256: $sha256" }
Write-Host ""
