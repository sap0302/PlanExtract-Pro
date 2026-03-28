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
src/lib/providers/     # AI provider abstraction layer
  types.ts             # AIProvider interface, ExtractedItem, VerificationResult
  index.ts             # createProvider() factory
  anthropic.ts         # Claude provider
  openai.ts            # GPT provider (strict JSON schema mode)
  gemini.ts            # Gemini provider (structured output + thinking)
  chunked.ts           # PDF chunking, aggregation, deduplication
  verification-utils.ts # Two-pass verification corrections
src/lib/prompts.ts     # All AI system/user prompts — THE source of truth for extraction rules
src/lib/encryption.ts  # AES-256-GCM for user API keys
src/lib/pdf-utils.ts   # PDF splitting, text extraction
```

## Key Patterns

- **Provider abstraction**: All 3 AI providers implement `AIProvider` interface with `extractFromPDF()` and `verifyExtraction()`
- **Two-pass extraction**: Optional verification pass corrects quantities, adds missed items, checks connectivity
- **Chunked extraction**: PDFs >20MB base64 split into chunks, processed sequentially, then aggregated + deduplicated
- **Deduplication**: `aggregateItems()` merges same-name rows on same sheet, then `deduplicateItems()` merges cross-chunk by dedupeKey
- **OpenAI strict mode**: All properties must be in `required`, optional fields use nullable type unions `["string", "null"]`
- **JSON field storage**: Arrays stored as JSON strings in SQLite, parsed with helpers in `json-fields.ts`

## Database

Uses `npx prisma db push` (NOT migrate) due to SQLite drift issues. Schema in `prisma/schema.prisma`.

Key models: User, Extraction, Item, ReferenceExample.

## Commands

```bash
npm run dev          # Dev server on :3000
npm run build        # Production build
npx tsc --noEmit     # Type check
npx prisma db push   # Push schema changes
npx prisma studio    # DB browser
```

## Environment Variables

```
DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL, ENCRYPTION_KEY
ANTHROPIC_API_KEY, CLAUDE_MODEL  # Server-level defaults
```

Users configure their own API keys via Settings UI (encrypted at rest).

## Domain

This app serves **water utility construction companies**. It reads civil engineering plan PDFs and extracts items into three measurement types:
- **Linear** (FT): Pipe runs by size/material
- **Count** (EA): Fittings, valves, hydrants, structures
- **Area** (SQ FT): Concrete, rip rap, grading

Four utility systems: Water (W), Storm Drain (SD), Wastewater (WW), Other/Demo.

All extraction rules and naming conventions live in `src/lib/prompts.ts`.
