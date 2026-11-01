#Requires -RunAsAdministrator

param(
  [string]$AppRoot = "C:\apps\planextract-pro"
)

$ErrorActionPreference = "Stop"

if ($AppRoot -match "[&()]") {
  throw "Install to a path without & or parentheses, e.g. C:\apps\planextract-pro"
}

Set-Location $AppRoot

if (-not (Test-Path ".env")) {
  Copy-Item ".env.production.example" ".env"
  Write-Host "Created .env from .env.production.example — fill in secrets before starting services."
}

if (-not (Test-Path "admin\.env")) {
  Copy-Item "admin\.env.production.example" "admin\.env"
  Write-Host "Created admin\.env from admin\.env.production.example — fill in secrets before starting services."
}

npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in the product app" }

npx prisma generate
npx prisma db push
if (Test-Path "prisma\backfill-email-verified.mjs") {
  node prisma\backfill-email-verified.mjs
}

npm run build
if ($LASTEXITCODE -ne 0) { throw "Product build failed" }

Set-Location (Join-Path $AppRoot "admin")
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed in the admin app" }

npm run build
if ($LASTEXITCODE -ne 0) { throw "Admin build failed" }

Write-Host "Build finished. Edit .env files if you have not already, then run install-services.ps1 as Administrator."
