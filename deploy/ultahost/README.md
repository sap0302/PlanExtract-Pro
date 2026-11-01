# Ultahost Windows VPS — planextractpro.com

Production hosts:

- Product: https://planextractpro.com  (Node on 127.0.0.1:3000)
- Admin: https://admin.planextractpro.com  (Node on 127.0.0.1:3100)

Caddy terminates HTTPS and proxies both names. NSSM keeps Node and Caddy
running after reboot and after you log off RDP.

Do not copy the repo into a folder whose path contains `&` or `()`.
Use `C:\apps\planextract-pro`.

## 1. Server prerequisites

Install, then reboot if the VC++ installer asks:

- Node.js 20 LTS (https://nodejs.org)
- Git for Windows
- [VC++ Redistributable x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
  (`better-sqlite3`, `sharp`, and canvas need it)

Create the layout:

```
C:\apps\planextract-pro
C:\apps\caddy
C:\apps\nssm
C:\apps\backups
```

Download:

- Caddy Windows amd64 → `C:\apps\caddy\caddy.exe`
- NSSM 2.24 win64 `nssm.exe` → `C:\apps\nssm\nssm.exe`

In Windows Firewall (and the Ultahost panel) allow inbound **TCP 80** and **443**.
Do not expose 3000 or 3100 to the internet.

## 2. DNS

Wherever `planextractpro.com` is hosted:

| Type | Name  | Value              |
|------|-------|--------------------|
| A    | @     | VPS public IPv4    |
| A    | www   | same IPv4          |
| A    | admin | same IPv4          |

Caddy will request Let's Encrypt certificates once these records resolve here.

## 3. Copy the app and fill secrets

```powershell
git clone <your-repo-url> C:\apps\planextract-pro
cd C:\apps\planextract-pro
```

Copy `.env.production.example` → `.env` and
`admin\.env.production.example` → `admin\.env`.

Generate secrets on the VPS:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node admin\scripts\hash-password.mjs "your-admin-password"
```

Rules:

- Product and admin each get their own `NEXTAUTH_SECRET`
- `ADMIN_SERVICE_TOKEN` is identical in both `.env` files (32+ hex chars)
- In `admin\.env`, escape every `$` in `ADMIN_PASSWORD_HASH` as `\$`

## 4. Build

From an elevated PowerShell prompt:

```powershell
cd C:\apps\planextract-pro
powershell -ExecutionPolicy Bypass -File deploy\ultahost\first-deploy.ps1
```

That runs `npm ci`, Prisma generate/push, the email-verified backfill, and
both production builds.

## 5. Install Windows services

```powershell
powershell -ExecutionPolicy Bypass -File deploy\ultahost\install-services.ps1
```

This registers:

| Service            | What it runs                                      |
|--------------------|---------------------------------------------------|
| PlanExtractPro     | `node scripts\start-production.mjs` (PORT=3000)   |
| PlanExtractAdmin   | `node admin\scripts\start.mjs` (PORT=3100)        |
| PlanExtractCaddy   | `caddy run` with `deploy\ultahost\Caddyfile`      |

Logs land next to each app as `service-stdout.log` / `service-stderr.log`.

Useful later:

```powershell
nssm restart PlanExtractPro
nssm restart PlanExtractAdmin
nssm restart PlanExtractCaddy
```

To remove them: `deploy\ultahost\uninstall-services.ps1`.

## 6. Database backup

`prisma\prod.db` is the whole product database, including stored PDFs.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\ultahost\backup-db.ps1
```

Schedule it daily (keeps the last 14 copies):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\ultahost\schedule-backup.ps1
```

## 7. After go-live

- https://planextractpro.com/login
- https://admin.planextractpro.com/login
- Approve a test signup and confirm the verification link uses
  `https://planextractpro.com/verify-email?token=...`

Do not run `npm run dev` on this server. Caddy only proxies; it does not
serve the Next.js app as static files.
