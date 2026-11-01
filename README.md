# PlanExtract Pro

AI-assisted quantity takeoff for water utility construction plans.

Estimators at pipeline and site-utility contractors spend hours reading civil
plan sets (water, storm drain, sanitary sewer) and counting pipe, fittings,
valves, structures and concrete by hand in tools like PlanSwift. PlanExtract
Pro reads the plan PDF, extracts those items into a takeoff table, and gives
the estimator a measuring canvas to verify or add quantities the AI could not
read reliably.

It is in daily use by a small utility contractor and runs in production at
[planextractpro.com](https://planextractpro.com) (accounts are approved by an
administrator, so there is no open signup).

## What it does

- **PDF extraction** — upload a plan set, pick a provider (Anthropic Claude,
  OpenAI, or Google Gemini) and get a table of items in three measurement
  types: linear (FT), count (EA) and area (SQ FT), tagged by system
  (water, storm drain, wastewater, demo/other). Large PDFs are chunked,
  processed sequentially, then aggregated and de-duplicated. An optional second
  pass checks quantities and connectivity.
- **Manual measure** — a plan viewer with scale calibration, linear/area/count
  tools, right-click to finish, crosshair guides and per-page scale. Runs are
  grouped by item name with live totals and can be pushed into the takeoff
  table.
- **Learning from past takeoffs** — reference examples (previous PlanSwift
  exports) steer naming conventions and expected items for a project type.
- **Review and export** — edit items inline, diff against a reference,
  finalize, and export to PDF or spreadsheet.
- **Admin app** — a separate small Next.js app for approving access requests,
  managing users and resetting passwords. It has no database access and talks
  to the main app over a token-protected internal API.

## Built with

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Database | SQLite via Prisma 6 |
| Auth | NextAuth 5 (JWT, credentials), email verification |
| UI | Tailwind 4, shadcn/ui, Radix, TanStack Table |
| Canvas | react-konva for measurements, pdf.js for rendering |
| PDF | pdf-lib, pdf-parse, jsPDF |
| AI | Anthropic, OpenAI and Google provider adapters behind one interface |
| Email | Nodemailer over SMTP |

Repository layout:

```
src/app/        routes only; pages stay thin
src/features/   domain modules (measure, extraction, inventory, auth, settings, export, ...)
src/components/ shared UI (shadcn primitives, dashboard chrome)
src/lib/        providers, prompts, auth, prisma, pdf utilities
admin/          the admin app (own package.json and build)
deploy/         VPS deployment notes and scripts
prisma/         schema and backfill scripts
```

Extraction rules and naming conventions live in `src/lib/prompts.ts`.

## Running locally

Requirements: Node 20 or newer, npm.

```bash
npm ci
cp .env.example .env          # then fill in the secrets below
npx prisma generate
npx prisma db push
npm run dev                   # http://localhost:3000
```

`.env` needs at minimum:

```
DATABASE_URL="file:./prisma/dev.db"
NEXTAUTH_SECRET=   # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=    # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ADMIN_SERVICE_TOKEN=   # same hex generator; must match the admin app
```

AI provider keys are entered per user in **Settings** and stored encrypted.
SMTP settings are optional; without them, verification emails are skipped and
the admin UI says so.

Admin app:

```bash
cd admin
npm ci
cp .env.example .env          # ADMIN_EMAIL, ADMIN_PASSWORD_HASH, matching ADMIN_SERVICE_TOKEN
npm run dev                   # http://localhost:3100
```

Generate the admin password hash with `node scripts/hash-password.mjs "your-password"`.

Sample reference takeoffs for a fresh database:

```bash
node import-references.js you@example.com references.example.json
```

Other scripts: `npm run build`, `npm run typecheck`, `npm run lint`.

## Deployment

The production instance runs on a Linux VPS as two Node processes behind
Caddy (automatic HTTPS). Notes and service scripts are in `deploy/`. There is
also a Windows service variant using NSSM.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned work.

## License

MIT — see [LICENSE](LICENSE).

Written and owned by Serdar Piriyev. Steppe & Stone, a water-utility contractor I co-founded, runs it day to day under this license; the company does not own the code.
