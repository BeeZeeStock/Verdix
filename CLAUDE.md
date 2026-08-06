# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server (Turbopack, localhost:3000)
npm run build    # production build (Turbopack)
npm run start    # serve production build
npm run lint     # run ESLint directly (NOT next lint — that was removed in v16)
```

No test runner is configured.

## Architecture

Next.js **16** App Router. This is a breaking-change release — read `node_modules/next/dist/docs/` before editing. Key differences from earlier versions:

**Turbopack is the default** for both `next dev` and `next build`. Custom `webpack` config in `next.config.ts` will break the build. Use `--webpack` flag to opt out, or migrate to Turbopack-compatible options.

**`params` and `searchParams` are Promises.** Page props are now async:
```tsx
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
}
```

**`next lint` is removed.** Run `eslint` directly (`npm run lint`). `next build` no longer runs linting. The `eslint` option in `next.config.ts` is also removed.

**Runtime config removed.** `serverRuntimeConfig` / `publicRuntimeConfig` and `next/config` are gone. Use `process.env` in Server Components directly, or `NEXT_PUBLIC_` prefix for client-accessible values.

**Caching model.** `fetch` requests are **not cached by default**. To opt into the new Cache Components model, set `cacheComponents: true` in `next.config.ts` and use the `'use cache'` directive. Without this, use `export const dynamic = 'force-static'` on Route Handlers to cache GET responses.

**Instant navigations.** If client-side navigations feel slow, `Suspense` alone is not enough — export `unstable_instant` from the route. See `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md`.

**AMP is removed.** All `next/amp` imports and `amp` config options are gone.

## Key conventions

- Path alias `@/*` resolves to the repo root (configured in `tsconfig.json`).
- All layouts and pages are Server Components by default. Add `'use client'` only when you need state, event handlers, lifecycle hooks, or browser APIs.
- API endpoints go in `app/api/**/route.ts` — cannot coexist with a `page.ts` in the same segment.
- Colocate non-routable files (components, lib) under `_` prefixed folders (e.g. `app/_components/`) or outside `app/` entirely to keep them out of the routing system.
- Tailwind v4 via `@tailwindcss/postcss` — configuration is CSS-first, not `tailwind.config.js`.

## Product domain

Verdix is a revenue-intelligence platform for B2B SaaS: it reads signed contracts, extracts commercial terms with Claude, and reconciles them against what was actually billed. There are two layers of "billing" in this codebase — don't conflate them:

- **Customer-facing modules** (the product): three independent pipelines, each backed by a row in the `jobs` table with `module ∈ {BILLING_VERIFICATION, AUTO_CONFIGURE, PARTNER_RECON}` and a `status`/`execute_status` pair. Route by module: `app/(dashboard)/verify` (billing verification), `app/(dashboard)/configure` (auto-configure), `app/(dashboard)/partner` (partner reconciliation). All job data is org-scoped — every API route calls `requireOrg()`/`getActiveOrg()` from `lib/org.ts` before touching `jobs`.
- **Verdix's own SaaS billing** (how Verdix charges *its* customers): `lib/billing-engine.ts` + `lib/billing.ts`, driven by `verdix_plans` (self-service) or `org_billing_config` (enterprise, sourced from a signed agreement job). Runs off crons defined in `vercel.json` (`/api/admin/billing-cron`, `/api/admin/invoice-scheduler`, `/api/admin/remembill-payment-sync`), pushes to Stripe via `lib/stripe-verdix.ts`.

Shared pipeline pieces:
- **Contract Intelligence Engine** — `lib/contract-extractor.ts` sends contract text to Claude (via `lib/ai-client.ts`, which transparently swaps to AWS Bedrock EU when `USE_BEDROCK=true`) and returns a `ContractTerms` object (`lib/types.ts`). `lib/learning-context.ts` injects prior human corrections into the extraction prompt so the model improves per-org over time.
- **Reconciliation engines** — `lib/reconciler.ts` diffs `ContractTerms` against a billing CSV export to produce `LeakageFinding[]` (BILLING_VERIFICATION). `lib/partner-reconciler.ts` does the equivalent for upstream partner invoices (PARTNER_RECON).
- **Billing connectors** — `lib/connectors/billing/types.ts` defines the `BillingConnector` interface (`configure()`, `recordUsage()`); implementations live in `lib/billing-writer.ts` (Stripe, Chargebee live; Remembill, Zuora, Maxio, Recurly planned/partial — see `app/api/jobs/[id]/remembill-*` and `app/api/remembill/webhook`).
- **HITL review** — humans approve/correct extracted terms before anything is pushed to a billing system (`app/api/jobs/[id]/approve`, `/execute`, `/fix-finding`, `/corrections`).

Auth/multi-tenancy: NextAuth (Google OAuth + credentials) in `lib/auth.ts`; every user belongs to an org via `org_memberships`. `lib/org.ts` auto-creates an org on first login, auto-activates pending invites, and supports domain-based auto-join (e.g. everyone `@acme.com` joins the same org). All DB access goes through `supabaseServer` (service-role client, `lib/supabase.ts`) — RLS is not the enforcement boundary, `requireOrg()` is.

Data residency: Supabase project and Bedrock calls are pinned to EU regions; keep new infra EU-resident unless told otherwise.

`REVLENS_UNIFIED_SPEC.md` is the original build spec for this product (product terminology, section numbers referenced in old commits). Treat it as historical/product context only — it targets Next.js 14 and predates several schema migrations; the code and `supabase/migrations/` are the source of truth for anything it conflicts with.
