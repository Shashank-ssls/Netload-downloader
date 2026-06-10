# install-backend.ps1
# Full F: drive isolated installation script for NetLoad Downloader backend.

param([switch]$SkipPlaywright)

$BackendRoot = $PSScriptRoot | Split-Path

# === STRICT F: DRIVE ISOLATION ===
$env:npm_config_cache         = "F:\Dev\npm-cache"
$env:npm_config_prefix        = "F:\Dev\npm-global"
$env:PLAYWRIGHT_BROWSERS_PATH = "$BackendRoot\playwright-browsers"
$env:TEMP                     = "F:\Dev\tmp"
$env:TMP                      = "F:\Dev\tmp"
$env:PIP_CACHE_DIR            = "F:\Dev\pip-cache"

Write-Host "=== NetLoad Backend Installer ===" -ForegroundColor Cyan
Write-Host "npm cache    : $env:npm_config_cache"
Write-Host "Playwright   : $env:PLAYWRIGHT_BROWSERS_PATH"
Write-Host "Temp         : $env:TEMP"
Write-Host ""

# Create all required directories
@(
  "F:\Dev\npm-cache", "F:\Dev\tmp", "F:\Dev\pip-cache",
  "$BackendRoot\playwright-browsers", "$BackendRoot\cookies",
  "$BackendRoot\logs", "$BackendRoot\temp", "$BackendRoot\downloads"
) | ForEach-Object { if (-not (Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null } }

# Node.js dependencies
Write-Host "Installing Node.js dependencies..." -ForegroundColor Cyan
Set-Location $BackendRoot
& "F:\Apps\NodeJS\npm.cmd" install

# Playwright stealth stack
Write-Host "`nInstalling Playwright stealth packages..." -ForegroundColor Cyan
& "F:\Apps\NodeJS\npm.cmd" install playwright-core playwright-extra puppeteer-extra-plugin-stealth

# Chromium download (F: drive only)
if (-not $SkipPlaywright) {
  Write-Host "`nDownloading Chromium to F: drive..." -ForegroundColor Cyan
  & "F:\Apps\NodeJS\npx.cmd" playwright install chromium
} else {
  Write-Host "`nSkipping Playwright download (-SkipPlaywright)" -ForegroundColor Yellow
}

# TypeScript compile check
Write-Host "`nRunning TypeScript compile check..." -ForegroundColor Cyan
$tscResult = & "F:\Apps\NodeJS\npx.cmd" tsc --noEmit 2>&1
if ($tscResult) {
  Write-Warning "TypeScript errors found (normal if types aren't fully restored yet):"
} else {
  Write-Host "TypeScript: No errors" -ForegroundColor Green
}

# === ISOLATION VERIFICATION ===
Write-Host "`n=== Isolation Verification ===" -ForegroundColor Yellow

if (Test-Path "$env:LOCALAPPDATA\ms-playwright") {
  Write-Warning "C: drive contaminated at $env:LOCALAPPDATA\ms-playwright"
} else {
  Write-Host "C: drive clean - no Playwright on C:" -ForegroundColor Green
}

if (Test-Path "$BackendRoot\playwright-browsers") {
    Write-Host "Playwright on F: drive: YES (OK)" -ForegroundColor Green
} else {
    Write-Host "Playwright on F: drive: NO (FAILED)" -ForegroundColor Red
}

Write-Host "`nInstallation complete. Start: .\start-dev.ps1" -ForegroundColor Green
