$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "Codex Stock Monitoring Dashboard"
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Root\run-monitoring.ps1`""
$Trigger = New-ScheduledTaskTrigger -Daily -At 18:15
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Updates the local stock monitoring dashboard once per day." -Force
Write-Host "Scheduled task installed: $TaskName"
