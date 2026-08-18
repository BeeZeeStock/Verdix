# Verdix Security & Privacy Audit — 2026-08-19

Scope: verify that the implementation genuinely supports the Privacy Policy, Terms, and public Security section — then fix gaps. No compliance/certification claims added. No destructive/migratory infra changes made without flagging them first.

Method: direct code review of the AI/PII pipeline, auth, and route layer, plus three parallel research passes covering (1) Supabase RLS/grants/storage, (2) all 76 API routes for auth/tenant-scoping, (3) retention/deletion/logging/headers/dependencies/secrets.

---

## 1. Findings & vulnerabilities (severity-ordered)

### CRITICAL — near-total RLS bypass across ~22 tables
Every RLS policy in `supabase/migrations/*.sql` was written as `for all using (true) with check (true)` **with no `to <role>` clause**. In Postgres, a policy without `to` applies to `PUBLIC` — anon *and* authenticated, not just `service_role`, despite most being named `"service role bypass"`. The app's anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) is shipped to every browser by design, so this meant direct, unauthenticated read/write access via the Supabase Data API to: `jobs`, `contract_terms`, `line_items`, `leakage_findings`, `partner_invoices`, `partner_findings`, `extraction_corrections`, `design_partner_applications`, `pii_entities`, `job_pii_occurrences`, `user_consents`, `verdix_plans`, `org_subscriptions` (including Stripe IDs and `ingest_api_key`), `sync_events`, `verdix_settings`, `billing_meters`, `contract_meter_mappings`, `org_billing_config`, `usage_ledger`, `commercial_rule_interpretations`, and my own newly-added `demo_leads` — bypassing `requireOrg()` entirely, for every org.

### CRITICAL — `organizations` and `org_memberships` had RLS fully *disabled*
`20260704000002_org_rls.sql` explicitly turned RLS off for the two tables `requireOrg()` itself trusts to decide org membership, with a comment that access is "controlled at the app layer." Combined with Supabase's default anon/authenticated grants (not visible in these migration files — verify against the live project), this is a full auth-bypass chain: anyone could `INSERT` an `org_memberships` row making themselves `owner` of any `org_id`, then use the app's own UI/API — which trusts this table — to reach that org's data.

### CRITICAL — two routes authenticate but never verify job ownership
- `POST /api/jobs/[id]/confirm-rule` — writes `contract_terms`/`commercial_rule_interpretations`/`contract_meter_mappings` scoped only by `job_id` from the URL. An admin of Org A could overwrite Org B's live commercial terms and billing configuration by calling it against Org B's job id.
- `POST /api/jobs/[id]/meter-mappings` — same shape; on confirmation it writes into `org_billing_config`, the table the live billing cron reads.

### CRITICAL — nine routes had no authentication at all
`PATCH /api/jobs/[id]/line-items`, `PATCH /api/jobs/[id]/terms` (rewrites customer PII/pricing), `GET /api/jobs/[id]/actual-overage` (financial data leak), `POST /api/jobs/[id]/fix-finding`, `POST /api/upload` (could overwrite another org's contract file), `POST /api/usage/record` (billing-usage manipulation for any org), `POST /api/corrections` (could poison AI extraction quality for every customer), `GET`/`PATCH /api/admin/design-partners` (leaked applicant PII, unauthenticated status changes), and `POST /api/admin/claim-jobs` (any logged-in customer, not just staff, could claim unowned jobs across every org).

### CRITICAL — SECURITY DEFINER functions with no tenant check
`increment_usage_counter`, `deduct_usage_counter`, `record_usage`, `sum_usage_for_period` all take a caller-supplied `org_id_param` with no internal membership check, and Postgres grants `EXECUTE` to `PUBLIC` by default — reachable via `/rest/v1/rpc/<fn>` with just the anon key, enabling cross-org usage-counter manipulation (billing fraud) or disclosure.

### HIGH — AI processing bypassed the EU-pinned Bedrock path
Four routes (`execute`, `detect-pii`, `audit`, `partner-recon`) each hand-rolled their own `new Anthropic()` call for PDF→text extraction — the *first* AI call in the pipeline, on the **raw, unmasked document**, since masking can't happen until there's text to mask. This call went to Anthropic's direct API (not Bedrock, not EU-pinned), regardless of `USE_BEDROCK`, for every single contract processed. The main commercial-terms extraction call was already correctly routed through the Bedrock/EU path — only this earlier step wasn't.

### HIGH — PII masking is a paid add-on, not a baseline guarantee
`execute/route.ts` and `detect-pii/route.ts` both gate masking behind `pii_addon_enabled === true || plan_id === 'trial'`. The Privacy Policy and Security page state masking as unconditional ("Before any text is sent for AI analysis, PII... is masked"). **This is a product/policy decision, not something I changed** — see §6.

### HIGH — PII leaked into server logs
`execute/route.ts` logged the full masking token↔real-value map, masked-text excerpts, and restored customer/vendor names via `console.log` on every run — defeating masking for anyone with Vercel log access, independent of whether masking was even enabled. Fixed (removed).

### HIGH — Remembill webhook was fail-open
`if (process.env.REMEMBILL_WEBHOOK_SECRET && secret !== ...)` meant an **unset** secret env var caused the check to be skipped entirely, accepting any request with zero verification. `REMEMBILL_WEBHOOK_SECRET` is not present in `.env.local` at all — verify whether it's set in Vercel production.

### HIGH — zero security headers
No CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, or clickjacking protection anywhere (`next.config.ts` was an empty config, no `middleware.ts` exists).

### HIGH — dependency vulnerabilities
`npm audit`: 5 (3 high, 2 critical) in `next@16.2.9`, plus 2 critical in `@auth/core`/`next-auth` (email-normalization homoglyph bypass, malformed-header DoS, OAuth state/nonce/PKCE cookies not bound to their provider).

### MEDIUM — retention/deletion policy entirely unimplemented
Nothing in the codebase enforced the Privacy Policy's "90 days after job completion" (contract documents) or "30 days after termination" (account data) claims. Worse: **no code path ever called the Storage `.remove()` API at all** — even the existing manual job-delete route removed database rows but left the actual uploaded PDF in the bucket permanently.

### MEDIUM — `/api/debug` was unauthenticated
Disclosed whether `AUTH_SECRET`/`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set and `AUTH_SECRET`'s character length to any caller, in production.

### LOW / informational
- No email verification on self-service signup (`email_confirm: true` set unconditionally) — anyone can sign up claiming an email they don't own.
- Self-service org auto-creation defaults to **enabled** when the `verdix_settings` feature-flag row hasn't been seeded — confirm current production value.
- No rate limiting on `/api/signup`.
- No idempotency/replay-id tracking on any webhook (Stripe/Remembill/billing) — low practical risk since all three only ever apply idempotent status writes.
- `org_integrations` had a dead policy comparing `current_user` (a Postgres role name) to an email — could never match; accidentally safe, not deliberately so.
- `planned_invoices` had RLS enabled with zero policies — accidentally correct default-deny, not deliberately designed.
- No secrets found in git history; `.gitignore` correctly excludes all `.env*` variants.
- Storage bucket `verdix-files` was already correctly private, with its one policy correctly scoped `to service_role` — the one area that was right by default.

---

## 2. Changes made this session

**Migrations** (not yet applied — no DB connection available to me; you'll need to run these):
- `supabase/migrations/20260819000003_rls_lockdown.sql` — re-enables/fixes RLS + explicit `to service_role` policies + `revoke all from anon, authenticated` on all ~22 tables above; re-enables RLS on `organizations`/`org_memberships`; replaces the dead `org_integrations` policy; `revoke execute ... from public` on the four SECURITY DEFINER functions.
- `supabase/migrations/20260819000002_demo_leads.sql` — fixed at the source (this table's migration hadn't been applied yet either).
- `supabase/migrations/20260819000004_deletion_log.sql` — new `deletion_log` audit table (object id, org, reason, scheduled/actual timestamps — never document content) + `jobs.document_deleted_at`.

**Code**:
- `lib/ai-client.ts` — new `extractDocumentText()`, routes PDF extraction through the same `USE_BEDROCK`-aware client as the main extraction call.
- `app/api/jobs/[id]/{execute,detect-pii,audit,partner-recon}/route.ts` — use the shared helper instead of a local direct-Anthropic client; removed the PII-leaking `console.log` calls in `execute/route.ts`.
- `app/api/jobs/[id]/meter-mappings/route.ts` — its (low-PII-risk) AI call now uses the bounded `newAnthropicClient()` wrapper instead of a raw unbounded client; **still not Bedrock-routed** — flagged, not fixed (see §5).
- `app/api/remembill/webhook/route.ts` — fails closed; constant-time secret comparison.
- `next.config.ts` — CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- `app/api/jobs/[id]/{confirm-rule,meter-mappings,line-items,terms,actual-overage,fix-finding}/route.ts`, `app/api/upload/route.ts`, `app/api/corrections/route.ts` — added `requireOrg()` + job-ownership verification.
- `app/api/usage/record/route.ts` — added the same `ingest_api_key` Bearer-token auth as its sibling `/api/v1/usage`, resolving org from the key instead of trusting the client-supplied `job_id`.
- `app/api/admin/{design-partners,claim-jobs}/route.ts` — added `requireAdmin()`.
- `app/api/debug/route.ts` — added `requireAdmin()`.
- `lib/storage.ts` — new `removeStorageObject()`.
- `lib/deletion-log.ts` — new, writes to `deletion_log`.
- `app/api/jobs/[id]/route.ts` (DELETE) — now actually removes the Storage object(s) and logs it.
- `app/api/admin/document-retention-cron/route.ts` — new daily cron enforcing the 90-day document-retention window; registered in `vercel.json`. Flags its own policy ambiguity in a code comment (see §6).
- `lib/rls-isolation.test.ts` — new, opt-in integration test (`RUN_RLS_INTEGRATION_TESTS=true`) proving the anon key can't read/write customer tables. Skipped by default; will fail red until the RLS migration is applied, green after.
- `package.json` — `next` 16.2.9→16.3.1, `next-auth` picked up 5.0.0-beta.32 (`@auth/core` 0.41.3) via `npm audit fix`. **0 vulnerabilities**, verified via full `tsc`/`lint`/`vitest` (148 passed)/`build`.

**Not changed** (deliberately — see §6 for why): PII-masking paywall gating, Vercel compute region, self-service-signup default, email verification on signup, webhook replay/idempotency tracking.

---

## 3. Claims verified

| Claim | Evidence |
|---|---|
| AI processing pinned to an EU AWS region | `AWS_REGION=eu-west-1`, `AWS_BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6` (an EU cross-region inference profile), and — after this session's fix — *all* AI calls in the contract pipeline now route through it, not just the main extraction call. |
| PII detection itself is local, not AI-based | `lib/pii-detector.ts` imports only `compromise` (local NLP); no network/AI client. |
| Storage bucket is private with correct access scoping | `verdix-files` bucket created `public: false`; its one RLS policy is correctly `to service_role`. |
| Stripe/billing webhooks verify signatures | `stripe.webhooks.constructEvent(...)` with a real secret, confirmed in both `stripe/webhook` and `billing/webhook`. |
| No secrets committed to git | `git log` across all branches for `.env*`/`.pem`/`.key` file additions returns nothing. |
| No `NEXT_PUBLIC_`-prefixed secret | Every secret-shaped env var (`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `AWS_SECRET_ACCESS_KEY`, etc.) correctly lacks the prefix; only the two Supabase values designed to be public (URL, anon key) carry it. |
| Retention/deletion is now implemented | New cron + `deletion_log` + `removeStorageObject()`, wired into both manual and scheduled deletion paths (code-verified; not yet run against production). |
| Tenant isolation at both DB and app layers | RLS lockdown migration (written, not yet applied) + all 11 route-level gaps fixed and typechecked/linted/tested. |

## 4. Claims that cannot currently be verified (need dashboard/account access I don't have)

- **Supabase project region** — no region indicator appears anywhere in code/env (the project URL is just a random ref). Check Project Settings → General in the Supabase dashboard.
- **Whether Bedrock's `eu.*` cross-region inference profile is confined to EU regions specifically**, and its prompt/output retention and invocation-logging configuration — check the AWS Bedrock console for this account.
- **"Your data is never used to train AI models"** — this is a claim about AWS's/Anthropic's own service terms, not something Verdix's code enforces or can prove; verify against the actual AWS Bedrock service agreement for this account.
- **Exact encryption protocols (AES-256, TLS 1.3) across every hop** — genuinely infra/provider-level, not verifiable from application code. Recommend the provider-neutral wording below.
- **"Access to production systems is restricted to named individuals on a need-to-know basis"** — requires a review of who actually has access in Vercel/Supabase/AWS, which I can't see.
- **`REMEMBILL_WEBHOOK_SECRET` and `CRON_SECRET` actual production values** — absent from local `.env.local`; the webhook fix now fails closed either way, but confirm these are actually set in Vercel so the integrations keep working.
- **Backups/PITR** — Supabase plan tier and backup configuration are dashboard-only; not visible from code.
- **MFA on Vercel/Supabase/AWS accounts** — dashboard-only.

## 5. Vercel compute region — flagged, not changed

Every deployment this session (`npx vercel inspect ... --wait`) showed lambdas running in `[iad1]` (US East, Virginia) — `vercel.json` has no `regions` override, so the app runs on Vercel's default region. This means Next.js API routes (including ones that briefly hold contract text in memory before calling Bedrock) execute in the US, even though the database and AI inference are EU-pinned. Whether this matters depends on how strictly "does not leave [the EEA]" is meant — I did not move this myself since changing a Vercel project's function region is an infrastructure change I was told to report rather than apply. If EU-only compute is required, that's a Vercel project-settings change to make deliberately, not a code fix.

## 6. Decisions requiring your call (not fixed, by design)

1. **PII masking behind a paid add-on** — either make it a baseline guarantee (product/pricing decision) or correct the Privacy Policy/Security copy to disclose it's plan-dependent. I did neither unilaterally.
2. **Retention-policy ambiguity** — "90 days after job completion" doesn't say what happens to a job that never completed (stuck/failed). The new cron applies the 90-day window uniformly from `jobs.updated_at` regardless of status, flagged in its own code comment — narrow it if the intended policy is different.
3. **`meter-mappings`'s AI call** — still uses direct Anthropic (Haiku) rather than Bedrock, because Bedrock routing in this codebase is pinned to a single Sonnet-family model; forcing it through Bedrock would silently swap models. Low risk (no contract PII in this call, only metric/meter names), but not EU-pinned. Needs either an EU Bedrock Haiku profile or an explicit decision that this exception is acceptable.
4. **Self-service signup defaults to enabled** when unseeded, and new signups get no email verification. If Verdix is meant to be invitation-only, confirm the `verdix_settings` row is actually set to disabled in production, and consider adding real email verification.

---

## 7. Verification matrix (§20)

| Public claim | Implementation evidence | Verified? | Fix made | Safe website wording |
|---|---|---|---|---|
| EU-based infrastructure | AI: EU-pinned (confirmed). Supabase region: unconfirmed. Vercel compute: **US** (`iad1`, confirmed from deploy logs). | **Partially** — mixed | None (infra decision, flagged §5) | Narrow to "AI processing and data storage are EU-hosted" rather than a blanket infrastructure claim, until compute region is addressed or the claim is scoped to match reality. |
| PII masked before AI processing | Pipeline now routes all AI calls through masking-aware, Bedrock-pinned path — **but only when the paid add-on/trial is active**. | **No** as a universal claim; yes conditionally | Routing bug fixed; paywall gating not (product decision, §6) | Either make masking universal, or state "available on paid plans / trial" explicitly. |
| No training on customer contracts | Provider-level (AWS Bedrock/Anthropic) commitment, not app-enforced | **Cannot verify from code** | — | Keep only if independently confirmed against the actual AWS Bedrock agreement for this account. |
| Encryption at rest | Standard for Supabase/AWS, not independently provable per-hop from code | **Cannot verify exact claim** | — | "Customer data is encrypted at rest." |
| Encryption in transit | Same | **Cannot verify exact protocol version** | — | "Customer data is encrypted in transit." |
| Retention/deletion (90-day docs, 30-day post-termination) | Was entirely unimplemented; now a cron + Storage removal + audit log exist | **Was false; now implemented** (code-verified, not yet run in prod) | Yes — new cron, `removeStorageObject`, `deletion_log` | Keep the claim once the migration is applied and the cron has run at least once successfully. |
| Tenant isolation | Was severely broken at both DB (RLS) and app (route auth) layers; both fixed this session | **Was false; now fixed** (migration not yet applied) | Yes — extensive, see §2 | Keep the claim once the RLS migration is applied in production. |
| Restricted production access | Organizational, not code-visible | **Cannot verify from code** | — | Keep only if independently confirmed who has dashboard access. |
| Clause-linked auditability | Real product feature — `commercial_rule_interpretations` stores source clause, reviewer, timestamps; its RLS was decorative until this fix | **Yes**, feature-level; DB-level enforcement now genuine too | RLS fix makes the audit trail itself properly isolated | Keep as-is. |

---

## 8. Remaining manual actions

1. **Apply the three new migrations** to production Supabase, in order: `20260819000002_demo_leads.sql` (if not already applied), `20260819000003_rls_lockdown.sql`, `20260819000004_deletion_log.sql`.
2. **Confirm `REMEMBILL_WEBHOOK_SECRET` is set** in Vercel production env vars — the webhook now rejects all requests without it (previously it silently accepted everything).
3. **Confirm `CRON_SECRET` is set** in Vercel production env vars, and register the new cron's schedule takes effect (already added to `vercel.json`, deploys automatically on next push).
4. **Check the Supabase project's region** in the dashboard (Project Settings → General) and reconcile with the "EU-based infrastructure" claim.
5. **Check the Bedrock console** for this AWS account: exact regions covered by the `eu.*` inference profile, invocation logging, and prompt/output retention configuration.
6. **Confirm AWS/Anthropic's actual data-training policy** for this account before keeping the "never used to train AI models" claim.
7. **Decide on PII-masking gating** (§6.1) and update either the product or the policy copy accordingly.
8. **Check `verdix_settings.self_service_signup_enabled`'s current production value** and decide if email verification should be added to signup.
9. **Confirm who has production access** to Vercel/Supabase/AWS, and that those accounts have MFA enabled.
10. **Confirm Supabase backup/PITR configuration** for the current plan tier, and whether a restore has ever been tested.
11. **Run the RLS isolation test against production** after applying the migration: `RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/rls-isolation.test.ts` — expect it to go from red (pre-migration) to green (post-migration).
12. **Decide on the Vercel compute region** (§5) if "EU-hosted" is meant to cover application compute, not just data storage and AI inference.
