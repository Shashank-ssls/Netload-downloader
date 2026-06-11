# Builds the portable, self-contained netload bundle:
#
#   release\netload-portable\
#     netload.exe        thin launcher (double-click) → runtime\node.exe app\standalone.js
#     runtime\node.exe   bundled Node runtime (ABI-matched to the copied node_modules)
#     app\               compiled app (dist) + production node_modules
#     bin\               yt-dlp.exe, ffmpeg.exe, ffprobe.exe
#     chromium\          Playwright Chromium browser
#     downloads\         finished files land here
#     data\              db / cookies / profiles / logs (created on first run)
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Robo($src, $dst) {
  robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($src -> $dst), code $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

Write-Host '[1/8] Building (tsc)...'
npm run build | Out-Null

$bundle = Join-Path $root 'release\netload-portable'
if (Test-Path $bundle) { Remove-Item -Recurse -Force $bundle }
New-Item -ItemType Directory -Force -Path $bundle,"$bundle\app","$bundle\runtime","$bundle\bin","$bundle\chromium","$bundle\downloads" | Out-Null

Write-Host '[2/8] Copying Node runtime...'
$node = (Get-Command node).Source
Copy-Item $node "$bundle\runtime\node.exe"

Write-Host '[3/8] Copying app (dist)...'
Robo "$root\dist" "$bundle\app"

Write-Host '[4/8] Copying production node_modules (ABI-matched; this is slow)...'
Robo "$root\node_modules" "$bundle\app\node_modules"

Write-Host '[5/8] Copying binaries (yt-dlp, ffmpeg, ffprobe)...'
Copy-Item "$root\yt-dlp\yt-dlp.exe" "$bundle\bin\yt-dlp.exe"
Copy-Item "$root\ffmpeg\ffmpeg.exe" "$bundle\bin\ffmpeg.exe"
Copy-Item "$root\ffmpeg\ffprobe.exe" "$bundle\bin\ffprobe.exe"

Write-Host '[6/8] Copying Chromium (~680MB, slow)...'
Robo "$root\playwright-browsers" "$bundle\chromium"

Write-Host '[7/8] Compiling launcher -> netload.exe...'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
& $csc /nologo /target:exe /platform:x64 /out:"$bundle\netload.exe" "$root\scripts\launcher.cs"
if ($LASTEXITCODE -ne 0) { throw 'launcher compile failed' }

Write-Host '[8/8] Writing README...'
@'
netload — portable video downloader

HOW TO USE
  1. Double-click  netload.exe
  2. Paste a video link at the  link>  prompt and press Enter.
  3. The file is saved into the  downloads\  folder next to this exe.
  Type  q  (or press Enter on a blank line) to quit.

ONE-OFF / SCRIPTED
  netload.exe "https://site/video"           download one link and exit
  netload.exe "https://site/video" --audio   audio-only (mp3)

NOTES
  • Everything stays inside this folder (downloads, cookies, logins, logs in data\).
  • Move/copy the whole folder anywhere — it is fully self-contained.
  • Some login-gated sites need a one-time sign-in; see data\logs if a download
    only returns a short preview.
'@ | Set-Content -Encoding UTF8 "$bundle\README.txt"

$sizeGB = [math]::Round((Get-ChildItem $bundle -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "Done: $bundle  ($sizeGB GB)"
Write-Host 'Zip it for sharing:  Compress-Archive release\netload-portable\* netload-portable.zip'
