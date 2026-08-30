$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Invoke-NodeStep {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [string[]]$Arguments = @()
  )

  & node $Script @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node step failed: $Script $($Arguments -join ' ')"
  }
}

Invoke-NodeStep ".\scripts\update-monitoring.js"
Invoke-NodeStep ".\scripts\generate-deep-dive.js" @("DECISIONS")
Invoke-NodeStep ".\scripts\valuation-scenarios.js"
Invoke-NodeStep ".\scripts\generate-sector-radar.js"
Invoke-NodeStep ".\scripts\update-elite-flow.js"

Write-Host ""
Write-Host "Dashboard: $Root\monitoring-dashboard.html"
Write-Host "Daily report: $Root\daily-report.md"
Write-Host "Deep dives: $Root\research\deep-dives"
Write-Host "Sector radar: $Root\research\sector-radar-report.md"
Write-Host "Elite flow: $Root\elite-flow-report.md"
