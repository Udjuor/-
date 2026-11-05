# Registers the update and launch tasks. Called by the installer.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$log = Join-Path $root 'register.log'
trap {
  "$(Get-Date -Format s) $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)" | Set-Content -LiteralPath $log
  exit 1
}

$run = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run').Kerdiis
$exe = $run.Trim('"')

# Starts the program for the signed-in user after an update. No time limit:
# the default would stop the program after three days.
$launchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'KerdiisLaunch' -Force `
  -Action (New-ScheduledTaskAction -Execute $exe) `
  -Principal (New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited) `
  -Settings $launchSettings | Out-Null

# Left alone when present: an update runs inside this task.
if (-not (Get-ScheduledTask -TaskName 'KerdiisUpdate' -ErrorAction SilentlyContinue)) {
  $script = Join-Path $root 'update.ps1'
  $boot = New-ScheduledTaskTrigger -AtStartup
  $boot.Delay = 'PT2M'
  $night = New-ScheduledTaskTrigger -Daily -At 3:00am -RandomDelay (New-TimeSpan -Hours 1)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName 'KerdiisUpdate' `
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
$task = $service.GetFolder('\').GetTask('KerdiisUpdate')
$sddl = $task.GetSecurityDescriptor(0xF)
if ($sddl -notmatch '\(A;;[^;]*;;;BU\)') {
  $sddl = [regex]::Replace($sddl, '^(.*?D:[^(]*(?:\([^)]*\))*)', '$1(A;;GRGX;;;BU)')
  $task.SetSecurityDescriptor($sddl, 0)
}

# An update from an old version runs inside the old task: its last step starts the
# old launch task, so that one must point at the new program until the next check.
$oldUpdate = Get-ScheduledTask -TaskName 'StudentCalendarUpdate' -ErrorAction SilentlyContinue
if ($oldUpdate -and $oldUpdate.State -eq 'Running') {
  if (Get-ScheduledTask -TaskName 'StudentCalendarLaunch' -ErrorAction SilentlyContinue) {
    Set-ScheduledTask -TaskName 'StudentCalendarLaunch' -Action (New-ScheduledTaskAction -Execute $exe) | Out-Null
  }
} else {
  foreach ($name in 'StudentCalendarUpdate', 'StudentCalendarLaunch') {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath (Join-Path (Split-Path $root) 'StudentCalendarUpdate') -Recurse -Force -ErrorAction SilentlyContinue
}

# Shortcuts of old names can live in personal folders the installer does not manage.
# They are found by target, so no old name has to be listed here.
try {
  $shell = New-Object -ComObject WScript.Shell
  $oldTarget = '\\StudentCalendar\.exe$'
  $folders = @(Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  $pinned = @()
  foreach ($user in Get-ChildItem (Split-Path $env:PUBLIC) -Directory -Force -ErrorAction SilentlyContinue) {
    $folders += Join-Path $user.FullName 'Desktop'
    $folders += Join-Path $user.FullName 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs'
    $pinned += Join-Path $user.FullName 'AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
    foreach ($cloud in Get-ChildItem $user.FullName -Directory -Filter 'OneDrive*' -ErrorAction SilentlyContinue) {
      $folders += (Get-ChildItem $cloud.FullName -Directory -ErrorAction SilentlyContinue).FullName
    }
  }
  foreach ($folder in $folders) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -Depth 1 -ErrorAction SilentlyContinue) {
      if ($shell.CreateShortcut($file.FullName).TargetPath -match $oldTarget) { Remove-Item -LiteralPath $file.FullName -Force }
    }
  }
  # A taskbar pin stays in place and starts the new program.
  foreach ($folder in $pinned) {
    foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -ErrorAction SilentlyContinue) {
      $link = $shell.CreateShortcut($file.FullName)
      if ($link.TargetPath -match $oldTarget) {
        $link.TargetPath = $exe
        $link.Save()
      }
    }
  }
} catch {
  "$(Get-Date -Format s) shortcuts: $($_.Exception.Message)" | Add-Content -LiteralPath $log
}

"$(Get-Date -Format s) ok" | Add-Content -LiteralPath $log
