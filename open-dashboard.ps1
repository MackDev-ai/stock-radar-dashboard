$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$Log = Join-Path $Root "monitoring-server.log"
$Err = Join-Path $Root "monitoring-server.err.log"
Start-Process -FilePath "node" -ArgumentList ".\serve-dashboard.js" -WorkingDirectory $Root -RedirectStandardOutput $Log -RedirectStandardError $Err -WindowStyle Hidden
Start-Sleep -Seconds 2
Write-Host "Dashboard: http://127.0.0.1:8765"
