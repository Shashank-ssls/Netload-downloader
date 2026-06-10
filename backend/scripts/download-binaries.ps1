$backendRoot = Join-Path $PSScriptRoot ".."
$ytdlpDir = Join-Path $backendRoot "yt-dlp"
$ffmpegDir = Join-Path $backendRoot "ffmpeg"

if (-not (Test-Path $ytdlpDir)) { New-Item -ItemType Directory -Path $ytdlpDir }
if (-not (Test-Path $ffmpegDir)) { New-Item -ItemType Directory -Path $ffmpegDir }

Write-Host "Downloading yt-dlp.exe..."
$ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
Invoke-WebRequest -Uri $ytdlpUrl -OutFile (Join-Path $ytdlpDir "yt-dlp.exe")

Write-Host "Downloading FFmpeg..."
$ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$ffmpegZip = Join-Path $ffmpegDir "ffmpeg.zip"
Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip

Write-Host "Extracting FFmpeg..."
Expand-Archive -Path $ffmpegZip -DestinationPath $ffmpegDir -Force
$extractedDir = Get-ChildItem -Path $ffmpegDir -Directory | Select-Object -First 1
Move-Item -Path (Join-Path $extractedDir.FullName "bin\ffmpeg.exe") -Destination (Join-Path $ffmpegDir "ffmpeg.exe") -Force
Move-Item -Path (Join-Path $extractedDir.FullName "bin\ffprobe.exe") -Destination (Join-Path $ffmpegDir "ffprobe.exe") -Force

Remove-Item -Path $ffmpegZip -Force
Remove-Item -Path $extractedDir.FullName -Recurse -Force

Write-Host "Binaries downloaded and placed successfully."
