# PlanExtract Pro

AI-powered construction plan PDF extraction for PlanSwift-style quantity takeoffs.

## Tech Stack

- **Framework**: Next.js 16.1.6 (App Router, Turbopack)
- **Database**: SQLite via Prisma 6.19 (`prisma/dev.db`)
- **Auth**: NextAuth 5 beta (JWT + credentials)
- **AI Providers**: Anthropic (Claude Sonnet 4), OpenAI (GPT-5.2), Google (Gemini 2.5 Pro)
- **UI**: shadcn/ui + Radix + Tailwind 4 + TanStack Table
- **PDF**: pdf-lib (manipulation), pdf-parse (text extraction), jsPDF (export)

## Architecture

```
src/
  app/                      # Routes only — pages stay thin and import from features
  features/                 # Domain modules (UI + hooks + domain helpers)
    measure/                # Takeoff canvas, scale, measurements
    extraction/             # Upload, re-extract, finalize, delete, audit
    inventory/              # Item tables and reference diff
    auth/                   # Login, signup request, email verification UI
    settings/               # User API keys
    reference-examples/
    export/
  components/
    ui/                     # shadcn primitives (shared)
    layout/                 # Dashboard chrome
  lib/                      # Cross-cutting infrastructure
    providers/              # AI provider abstraction
    email/                  # SMTP transport
    prompts.ts              # Extraction rules — source of truth
    auth.ts, prisma.ts, encryption.ts, pdf-utils.ts, ...
  providers/                # React context (session)
  types/
```

Feature modules expose a public `index.ts`. Pages import from `@/features/<domain>`,
not from nested component files. Shared UI stays in `src/components/ui`.

```

## Admin App (`admin/`)

Administration lives in a **separate Next.js app** under `admin/`, deployed to its own
subdomain (`admin.planextractpro.com` in production). It has no database access — it
reaches product data only through `/api/internal/admin/*` on the main app,
authenticated with a shared `ADMIN_SERVICE_TOKEN` plus an `x-admin-actor` header
that records who acted.

- Admin sign-in is independent of product sign-in: credentials come from
  `ADMIN_EMAIL` / `ADMIN_PASSWORD_HASH`, so a product session is never valid there.
- The service token never reaches a browser. UI interactions go through server
  actions in `admin/src/app/actions.ts`, which call `admin/src/lib/api.ts`
  (guarded by a `server-only` import).
- `admin/` is excluded from the main app's `tsconfig.json` and ESLint config, and
  has its own `package.json`, lockfile, and build. See `admin/.env.example`.

## Access Flow

1. Visitor submits `/register` → a `SignupRequest` row (public, rate-limited).
2. Admin approves in the admin app → `User` created with `emailVerifiedAt: null`,
   and a single-use link is emailed from `info@steppenstoneco.com`.
3. Applicant follows `/verify-email?token=...` → `emailVerifiedAt` set.

Until then the dashboard layout bounces them to `/verify-email`, where they can
request a new link (`POST /api/verify-email/resend`, 3/hour). Only the SHA-256 of
each token is stored, links expire after 7 days, and issuing a new one
invalidates the old. Admin-created users skip verification.

## Key Patterns

- **Provider abstraction**: All 3 AI providers implement `AIProvider` interface with `extractFromPDF()` and `verifyExtraction()`
- **Two-pass extraction**: Optional verification pass corrects quantities, adds missed items, checks connectivity
- **Chunked extraction**: PDFs >20MB base64 split into chunks, processed sequentially, then aggregated + deduplicated
- **Deduplication**: `aggregateItems()` merges same-name rows on same sheet, then `deduplicateItems()` merges cross-chunk by dedupeKey
- **OpenAI strict mode**: All properties must be in `required`, optional fields use nullable type unions `["string", "null"]`
- **JSON field storage**: Arrays stored as JSON strings in SQLite, parsed with helpers in `json-fields.ts`

## Database

Uses `npx prisma db push` (NOT migrate) due to SQLite drift issues. Schema in `prisma/schema.prisma`.

Key models: User, Extraction, Item, ReferenceExample, SignupRequest, EmailVerificationToken.

Adding a column with a non-null meaning for existing rows needs a backfill —
see `prisma/backfill-email-verified.mjs`, which marked pre-existing accounts
verified so the new gate couldn't lock them out.

## Commands

```bash
npm run dev          # Dev server on :3000
npm run build        # Production build
npx tsc --noEmit     # Type check
npx prisma db push   # Push schema changes
npx prisma studio    # DB browser
```

## Production

- Product: https://planextractpro.com
- Admin: https://admin.planextractpro.com
- Env templates: `.env.production.example`, `admin/.env.production.example`
- Ultahost Windows VPS (Caddy + NSSM): `deploy/ultahost/`
- Bluehost / Linux Apache (unused if on Ultahost): `deploy/bluehost/`

## Environment Variables

```
DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, ENCRYPTION_KEY
ANTHROPIC_API_KEY, CLAUDE_MODEL  # Server-level defaults

ADMIN_SERVICE_TOKEN  # Shared secret for /api/internal/* — must match the admin app

# SMTP — optional. Without SMTP_HOST, or with SMTP_USER set but no SMTP_PASSWORD,
# verification emails are skipped and the admin UI says so; approved applicants
# then need a resend to activate.
SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true for port 465)
SMTP_USER, SMTP_PASSWORD
EMAIL_FROM  # Defaults to "PlanExtract Pro <info@steppenstoneco.com>"
APP_URL  # Public base URL used in email links, falls back to NEXTAUTH_URL
INTERNAL_APP_URL  # Optional loopback for server-side self-fetch (re-extract)
```

Users configure their own API keys via Settings UI (encrypted at rest).

## Domain

This app serves **water utility construction companies**. It reads civil engineering plan PDFs and extracts items into three measurement types:
- **Linear** (FT): Pipe runs by size/material
- **Count** (EA): Fittings, valves, hydrants, structures
- **Area** (SQ FT): Concrete, rip rap, grading

Four utility systems: Water (W), Storm Drain (SD), Wastewater (WW), Other/Demo.

All extraction rules and naming conventions live in `src/lib/prompts.ts`.
