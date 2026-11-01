# Deploying PlanExtract Pro on Bluehost

Production hosts:

- Product app: https://planextractpro.com
- Admin app: https://admin.planextractpro.com

The two apps are separate Node processes. They do not share sessions. The
admin app talks to the product app over HTTPS using `ADMIN_SERVICE_TOKEN`.

## DNS

In the Bluehost zone for `planextractpro.com`:

| Type | Name  | Points to                          |
|------|-------|------------------------------------|
| A    | @     | this server's public IPv4          |
| A    | www   | same IPv4                          |
| A    | admin | same IPv4                          |

Then wait for SSL (AutoSSL or Let's Encrypt) on both hostnames.

## What Bluehost plan you need

These apps use native Node addons (`better-sqlite3`, `sharp`, `@napi-rs/canvas`).
They will not run from a PHP document root on basic shared hosting.

Use one of:

1. **VPS / Cloud / Dedicated** — Apache reverse proxy (configs in this folder)
2. **cPanel "Setup Node.js App"** — two Node applications, Node 20 LTS

## 1. Product app (`planextractpro.com`)

On the server, in the app directory:

```bash
cp .env.production.example .env
# fill secrets in .env
npm ci
npx prisma generate
npx prisma db push
node prisma/backfill-email-verified.mjs
npm run build
PORT=3000 npm start
```

Keep `npm start` running with systemd, PM2, or cPanel's Node.js app manager.

## 2. Admin app (`admin.planextractpro.com`)

```bash
cd admin
cp .env.production.example .env
# fill secrets — ADMIN_SERVICE_TOKEN must match the product app
npm ci
npm run build
PORT=3100 npm start
```

Generate the admin password hash on any machine:

```bash
node admin/scripts/hash-password.mjs "your-admin-password"
```

In a `.env` file, escape every `$` in that hash as `\$`. cPanel's environment
UI usually does not need escaping.

## 3. Apache (VPS)

Enable `proxy`, `proxy_http`, `headers`, and `ssl`. Copy:

- `planextractpro.com.conf` → `/etc/apache2/sites-available/`
- `admin.planextractpro.com.conf` → `/etc/apache2/sites-available/`

Update the SSL certificate paths to the ones AutoSSL generated, then:

```bash
a2ensite planextractpro.com admin.planextractpro.com
systemctl reload apache2
```

## 4. cPanel Node.js App (if no VPS)

Create two applications:

| Field            | Product                         | Admin                              |
|------------------|---------------------------------|------------------------------------|
| Node.js version  | 20 LTS                          | 20 LTS                             |
| Application root | `/home/.../planextract-pro`     | `/home/.../planextract-pro/admin`  |
| Application URL  | planextractpro.com              | admin.planextractpro.com           |
| Startup file     | `node_modules/next/dist/bin/next` | `node_modules/next/dist/bin/next` |
| Environment      | contents of `.env`              | contents of `admin/.env`           |

Add application args `start` (Passenger will set `PORT`).

## Secrets checklist

Generate once and paste into both apps as noted:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # NEXTAUTH_SECRET (different per app)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # ENCRYPTION_KEY and ADMIN_SERVICE_TOKEN
```

`ADMIN_SERVICE_TOKEN` must be identical on both apps and at least 32 characters.

## After go-live

- Sign in at https://planextractpro.com/login
- Sign in at https://admin.planextractpro.com/login
- Approve a test signup and confirm the verification email links to https://planextractpro.com/verify-email?token=...
- Back up `prisma/prod.db` on a schedule — SQLite is a single file
