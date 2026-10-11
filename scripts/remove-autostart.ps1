$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "Codex Telegram Bridge" -Confirm:$false
Write-Host "Startup task removed."
