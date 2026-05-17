$action = New-ScheduledTaskAction -Execute 'C:\Users\drmwe\Claude\claudeclaw-os\start-claudeclaw.cmd'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User 'weyers\drmwe'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 5 -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'weyers\drmwe' -LogonType Interactive
Register-ScheduledTask -TaskName 'ClaudeClaw' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName 'ClaudeClaw' | Select-Object TaskName, State
