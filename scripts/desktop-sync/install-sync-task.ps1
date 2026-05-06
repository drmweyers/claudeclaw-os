# install-sync-task.ps1 — Creates the Windows Task Scheduler job
# RUN THIS ONCE as Administrator on the DESKTOP computer.
#
# Creates: "SecondBrainSync" task
#   - Runs sync-second-brain.ps1 every 30 minutes
#   - Starts automatically at logon
#   - Runs whether user is logged in or not (optional)
#   - No popup window

$taskName   = "SecondBrainSync"
$scriptPath = "$PSScriptRoot\sync-second-brain.ps1"

# Verify the script exists
if (-not (Test-Path $scriptPath)) {
    Write-Host "ERROR: $scriptPath not found." -ForegroundColor Red
    Write-Host "Copy the desktop-sync folder to the desktop first." -ForegroundColor Yellow
    exit 1
}

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing '$taskName' task..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Action: run PowerShell hidden (no window)
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

# Triggers:
#   1. Every 30 minutes, repeating indefinitely
#   2. At logon (catch up after sleep/reboot)
$trigger30min = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Days 9999)

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

# Register
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger30min, $triggerLogon `
    -Settings $settings `
    -Description "Pulls D:\second-brain from GitHub every 30 min. Keeps Hal, Hermes, and ClaudeClaw in sync." `
    -RunLevel Limited

Write-Host ""
Write-Host "Task '$taskName' created successfully." -ForegroundColor Green
Write-Host ""
Write-Host "  Script:    $scriptPath"
Write-Host "  Schedule:  Every 30 minutes + at logon"
Write-Host "  Log:       D:\second-brain-sync.log"
Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ScheduledTask -TaskName $taskName"
Write-Host "  Start-ScheduledTask -TaskName $taskName   (run manually now)"
Write-Host "  Get-Content D:\second-brain-sync.log -Tail 5   (check log)"
Write-Host ""
