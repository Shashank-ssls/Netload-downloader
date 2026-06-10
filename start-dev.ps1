$venvPath = Join-Path $PSScriptRoot "venv"
$backendPath = Join-Path $PSScriptRoot "backend"

Write-Host "Activating Venv..."
& (Join-Path $venvPath "Scripts\Activate.ps1")

Write-Host "Starting NetLoad Downloader Backend..."
cd $backendPath
npm run dev
