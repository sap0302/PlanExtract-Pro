#Requires -RunAsAdministrator

param(
  [string]$AppRoot = "C:\apps\planextract-pro",
  [string]$BackupDir = "C:\apps\backups",
  [string]$TaskName = "PlanExtractDbBackup"
)

$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "backup-db.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -AppRoot `"$AppRoot`" -BackupDir `"$BackupDir`""
$trigger = New-ScheduledTaskTrigger -Daily -At 2:15am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force |
  Out-Null

Write-Host "Scheduled $TaskName daily at 2:15 AM."
