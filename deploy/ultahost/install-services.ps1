#Requires -RunAsAdministrator

param(
  [string]$AppRoot = "C:\apps\planextract-pro",
  [string]$CaddyDir = "C:\apps\caddy",
  [string]$NssmExe = "C:\apps\nssm\nssm.exe",
  [string]$CaddyExe = "C:\apps\caddy\caddy.exe",
  [string]$NodeExe = ""
)

$ErrorActionPreference = "Stop"

if (-not $NodeExe) {
  $NodeExe = (Get-Command node -ErrorAction Stop).Source
}

$services = @(
  @{
    Name = "PlanExtractPro"
    Dir  = $AppRoot
    Args = "`"$AppRoot\scripts\start-production.mjs`""
    Env  = "PORT=3000"
  },
  @{
    Name = "PlanExtractAdmin"
    Dir  = (Join-Path $AppRoot "admin")
    Args = "`"$AppRoot\admin\scripts\start.mjs`""
    Env  = "PORT=3100"
  }
)

foreach ($svc in $services) {
  if (Get-Service -Name $svc.Name -ErrorAction SilentlyContinue) {
    & $NssmExe stop $svc.Name
    & $NssmExe remove $svc.Name confirm
  }

  & $NssmExe install $svc.Name $NodeExe
  & $NssmExe set $svc.Name AppParameters $svc.Args
  & $NssmExe set $svc.Name AppDirectory $svc.Dir
  & $NssmExe set $svc.Name AppEnvironmentExtra $svc.Env
  & $NssmExe set $svc.Name AppStdout (Join-Path $svc.Dir "service-stdout.log")
  & $NssmExe set $svc.Name AppStderr (Join-Path $svc.Dir "service-stderr.log")
  & $NssmExe set $svc.Name AppRotateFiles 1
  & $NssmExe set $svc.Name AppRotateBytes 10485760
  & $NssmExe set $svc.Name Start SERVICE_AUTO_START
  & $NssmExe start $svc.Name
}

if (-not (Test-Path $CaddyExe)) {
  throw "Caddy not found at $CaddyExe. Download caddy_windows_amd64.exe and save it there."
}

$caddyFile = Join-Path $PSScriptRoot "Caddyfile"
Copy-Item $caddyFile (Join-Path $CaddyDir "Caddyfile") -Force

if (Get-Service -Name PlanExtractCaddy -ErrorAction SilentlyContinue) {
  & $NssmExe stop PlanExtractCaddy
  & $NssmExe remove PlanExtractCaddy confirm
}

& $NssmExe install PlanExtractCaddy $CaddyExe
& $NssmExe set PlanExtractCaddy AppParameters "run --config `"$CaddyDir\Caddyfile`""
& $NssmExe set PlanExtractCaddy AppDirectory $CaddyDir
& $NssmExe set PlanExtractCaddy AppStdout (Join-Path $CaddyDir "caddy-stdout.log")
& $NssmExe set PlanExtractCaddy AppStderr (Join-Path $CaddyDir "caddy-stderr.log")
& $NssmExe set PlanExtractCaddy Start SERVICE_AUTO_START
& $NssmExe start PlanExtractCaddy

Get-Service PlanExtractPro, PlanExtractAdmin, PlanExtractCaddy | Format-Table Name, Status
