# Registers the update and launch tasks. Called by the installer.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$log = Join-Path $root 'register.log'
trap {
  "$(Get-Date -Format s) $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" | Set-Content -LiteralPath $log
  exit 1
}

$run = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run').StudentCalendar
$exe = $run.Trim('"')

# Starts the program for the signed-in user after an update. No time limit:
# the default would stop the program after three days.
$launchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'StudentCalendarLaunch' -Force `
  -Action (New-ScheduledTaskAction -Execute $exe) `
  -Principal (New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited) `
  -Settings $launchSettings | Out-Null

# Left alone when present: an update runs inside this task.
if (-not (Get-ScheduledTask -TaskName 'StudentCalendarUpdate' -ErrorAction SilentlyContinue)) {
  $script = Join-Path $root 'update.ps1'
  $boot = New-ScheduledTaskTrigger -AtStartup
  $boot.Delay = 'PT2M'
  $night = New-ScheduledTaskTrigger -Daily -At 3:00am -RandomDelay (New-TimeSpan -Hours 1)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName 'StudentCalendarUpdate' `
    -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"") `
    -Trigger @($boot, $night) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
    -Settings $settings | Out-Null
}

# Lets ordinary users start the update check from the program. Read and execute
# only: they cannot change what the task runs. Repeated on every install because
# tasks registered by older versions do not have this permission.
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$task = $service.GetFolder('\').GetTask('StudentCalendarUpdate')
$sddl = $task.GetSecurityDescriptor(0xF)
if ($sddl -notmatch '\(A;;GRGX;;;BU\)') {
  $sddl = [regex]::Replace($sddl, '^(.*?D:[^(]*(?:\([^)]*\))*)', '$1(A;;GRGX;;;BU)')
  $task.SetSecurityDescriptor($sddl, 0)
}

"$(Get-Date -Format s) ok" | Set-Content -LiteralPath $log
