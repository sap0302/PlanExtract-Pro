#Requires -RunAsAdministrator

param(
  [string]$NssmExe = "C:\apps\nssm\nssm.exe"
)

$ErrorActionPreference = "Stop"

foreach ($name in @("PlanExtractCaddy", "PlanExtractAdmin", "PlanExtractPro")) {
  if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
    & $NssmExe stop $name
    & $NssmExe remove $name confirm
  }
}

Write-Host "Removed PlanExtract Windows services."
