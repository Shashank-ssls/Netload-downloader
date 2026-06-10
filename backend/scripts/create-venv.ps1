$pythonExe = "F:\Apps\Python\python.exe"
$venvPath = Join-Path $PSScriptRoot "..\..\venv"

Write-Host "Creating Virtual Environment in: $venvPath"
& $pythonExe -m venv $venvPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "Venv created successfully."
    & (Join-Path $venvPath "Scripts\python.exe") -m pip install --upgrade pip
    & (Join-Path $venvPath "Scripts\python.exe") -m pip install yt-dlp
} else {
    Write-Error "Failed to create Venv."
}
