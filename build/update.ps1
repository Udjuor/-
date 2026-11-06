# Silent self-update of Kerdiis. Runs as SYSTEM from a scheduled task.
# Keep this file ASCII: Windows PowerShell 5.1 misreads UTF-8 without a BOM.
param(
  [string]$LatestUrl = 'https://github.com/Udjuor/-/releases/latest/download/latest.yml',
  [string]$AssetBase = 'https://github.com/Udjuor/-/releases/download'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
$statusFile = Join-Path $root 'status.json'
$installer = $null
$script:currentVersion = ''
$script:latestVersion = ''

function Save-Status([string]$Result, [string]$Detail = '') {
  @{
    checkedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    current   = $script:currentVersion
    latest    = $script:latestVersion
    result    = $Result
    detail    = $Detail
  } | ConvertTo-Json | Set-Content -LiteralPath $statusFile -Encoding UTF8
}

try {
  # Tasks of the old name stay until the update that ran inside them has finished.
  # Touched only when present: on a current install this check changes nothing.
  foreach ($name in 'StudentCalendarUpdate', 'StudentCalendarLaunch') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  $oldDir = Join-Path $env:ProgramFiles 'StudentCalendarUpdate'
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue }

  $run = (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run').Kerdiis
  $exe = $run.Trim('"')
  $script:currentVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion

  $response = Invoke-WebRequest -Uri $LatestUrl -UseBasicParsing -TimeoutSec 60
  $yml = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { $response.Content }
  $version = [regex]::Match($yml, '(?m)^version:\s*(\S+)').Groups[1].Value
  $file = [regex]::Match($yml, '(?m)^path:\s*(\S+)').Groups[1].Value
  $hash = [regex]::Match($yml, '(?m)^sha512:\s*(\S+)').Groups[1].Value
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Bad version: $version" }
  if ($file -notmatch '^[\w.\-]+\.exe$') { throw "Bad file name: $file" }
  if (-not $hash) { throw 'No checksum' }
  $script:latestVersion = $version

  if ([version]$version -le [version]$script:currentVersion) {
    Save-Status 'up-to-date'
    exit 0
  }

  $installer = Join-Path $root $file
  Invoke-WebRequest -Uri "$AssetBase/v$version/$file" -OutFile $installer -UseBasicParsing -TimeoutSec 900

  $sha = [Security.Cryptography.SHA512]::Create()
  $stream = [IO.File]::OpenRead($installer)
  try { $actual = [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose() }
  if ($actual -ne $hash) { throw 'Checksum mismatch' }

  Get-Process -Name Kerdiis -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $process = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode)" }

  Save-Status 'installed'
  # SYSTEM has no desktop: this task starts the program in the signed-in session.
  Start-ScheduledTask -TaskName 'KerdiisLaunch' -ErrorAction SilentlyContinue
} catch {
  Save-Status 'failed' $_.Exception.Message
  exit 1
} finally {
  if ($installer -and (Test-Path -LiteralPath $installer)) { Remove-Item -LiteralPath $installer -Force }
}
