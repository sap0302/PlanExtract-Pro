param(
  [string]$AppRoot = "C:\apps\planextract-pro",
  [string]$BackupDir = "C:\apps\backups"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$db = Join-Path $AppRoot "prisma\prod.db"
if (-not (Test-Path $db)) {
  throw "Database not found at $db"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $BackupDir "prod-$stamp.db"
Copy-Item $db $dest

Get-ChildItem $BackupDir -Filter "prod-*.db" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 14 |
  Remove-Item -Force

Write-Host "Backed up to $dest"
