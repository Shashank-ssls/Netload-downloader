$baseUrl = "http://localhost:4000/api"

Write-Host "`n--- NetLoad Downloader (BEST QUALITY AUTO) ---" -ForegroundColor Cyan

# 1. Get URL
$url = Read-Host "`nEnter the URL to download"
if (-not $url) { Write-Error "URL is required"; exit }

# 2. Analyze
Write-Host "`nAnalyzing URL... Please wait..." -ForegroundColor Yellow
try {
    $info = Invoke-RestMethod -Method Post -Uri "$baseUrl/analyze" -ContentType "application/json" -Body (@{url=$url} | ConvertTo-Json)
} catch {
    Write-Error "Analysis failed: $_"
    exit
}

Write-Host "`nTitle: $($info.title)" -ForegroundColor Green
Write-Host "Quality: AUTO (Selecting Best Available)" -ForegroundColor Yellow

# 3. Trigger Download (No format passed = server uses Provider's "best" strategy)
Write-Host "`nStarting Download..." -ForegroundColor Yellow
$body = @{ url = $url }

try {
    $task = Invoke-RestMethod -Method Post -Uri "$baseUrl/download" -ContentType "application/json" -Body ($body | ConvertTo-Json)
    $taskId = $task.taskId
    Write-Host "Task Created! ID: $taskId" -ForegroundColor Green
} catch {
    Write-Error "Download request failed: $_"
    exit
}

# 4. Monitor Progress
Write-Host "`nMonitoring Progress (Ctrl+C to stop monitoring, download will continue in background):" -ForegroundColor Cyan
while ($true) {
    $status = Invoke-RestMethod -Uri "$baseUrl/tasks/$taskId"
    
    $prog = $status.progress
    $speed = $status.speed
    $eta = $status.eta
    $state = $status.status

    Write-Progress -Activity "Downloading: $($info.title)" -Status "Status: $state | Speed: $speed | ETA: $eta" -PercentComplete $prog
    
    if ($state -eq "completed") {
        Write-Host "`n`nDownload COMPLETED successfully!" -ForegroundColor Green
        break
    }
    if ($state -eq "failed") {
        Write-Host "`n`nDownload FAILED: $($status.error)" -ForegroundColor Red
        break
    }
    
    Start-Sleep -Seconds 1
}
