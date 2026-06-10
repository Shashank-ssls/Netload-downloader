$ytdlpPath = Join-Path $PSScriptRoot "..\yt-dlp\yt-dlp.exe"

Write-Host "Updating yt-dlp.exe..." -ForegroundColor Yellow
& $ytdlpPath -U

if ($LASTEXITCODE -eq 0) {
    Write-Host "yt-dlp updated successfully." -ForegroundColor Green
} else {
    Write-Error "Failed to update yt-dlp."
}
