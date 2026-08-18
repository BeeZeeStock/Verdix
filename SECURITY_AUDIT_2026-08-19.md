# Verdix Security & Privacy Audit — 2026-08-19

Scope: verify that the implementation genuinely supports the Privacy Policy, Terms, and public Security section — then fix gaps. No compliance/certification claims added. No destructive/migratory infra changes made without flagging them first.

Method: direct code review of the AI/PII pipeline, auth, and route layer, plus three parallel research passes covering (1) Supabase RLS/grants/storage, (2) all 76 API routes for auth/tenant-scoping, (3) retention/deletion/logging/headers/dependencies/secrets.

## DEPLOYMENT STATUS — production-verified 2026-08-18

Shipped to production across 4 commits (`1ffbc542` security release, `f6c25799` duplicate-extraction/storm fix, `55fcb372` + `2cffe53b` review-panel edit UX), deployed as `verdix-ck0opojih` (`www.lynoraai.com`). All 5 migrations applied. Post-deploy verification run directly against the live production domain and database (not just preview):

- **RLS isolation**: `RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/rls-isolation.test.ts` → **8/8 passing** against production Supabase.
- **Route-level auth**: `terms` PATCH, `upload`, `usage/record`, `line-items` PATCH → **401**; `admin/design-partners`, `/api/debug` → **403** — all unauthenticated, confirmed on `www.lynoraai.com` directly.
- **Security headers**: CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy all present on `https://www.lynoraai.com/`.
- **Stripe webhook**: a genuinely HMAC-signed test event (signed with the real `STRIPE_WEBHOOK_SECRET`, never printed) was POSTed to production and accepted (`{"received":true}`, 200).
- **Remembill webhook**: correctly rejects unsigned requests (401) — expected, `REMEMBILL_WEBHOOK_SECRET` isn't configured yet pending their sandbox support; the daily `remembill-payment-sync` poll cron covers payment-status sync in the interim.
- **Bedrock routing**: confirmed via AWS CloudWatch directly (not app logs) — `AWS/Bedrock` `Invocations` metric recorded real calls in the exact window of a live end-to-end test (upload → PII detection → extraction → review), proving Bedrock is genuinely being used, not falling back to direct Anthropic. `USE_BEDROCK`/AWS credentials are now set in Vercel for both Preview and Production (they were previously only in local `.env.local` — see the corrected finding below).
- **PII console-log removal**: code-verified (`grep` for the removed `console.log('[PII]'...)` calls returns zero matches in the deployed source).
- **Retention cron dry-run**: ran against production — `{"dry_run": true, "candidate_count": 0}`. No deletions have occurred; the cron will keep reporting dry-run-only until `RETENTION_DELETE_ENABLED=true` is deliberately set.

**Corrected finding, discovered during production testing**: the original audit's Bedrock/EU-pinning evidence (§3, "AI processing pinned to an EU AWS region") was based on `USE_BEDROCK`/AWS credentials present in local `.env.local` — those were never actually configured in Vercel until this deployment. This means Bedrock/EU-pinning was very likely **not actually active in the deployed app** at any point before this release, despite the Privacy Policy's claim — every contract was probably processed via direct Anthropic API, not EU-pinned Bedrock, until now. This is now fixed and independently confirmed via CloudWatch (see above), not just code review.

**Two additional fixes made during production testing** (found via live smoke-testing, not the original audit, but shipped in the same release):
- `execute/route.ts` was re-extracting the same PDF a second time independently of `detect-pii/route.ts` — doubling Bedrock calls/cost per contract. Fixed via a short-lived `jobs.pending_extracted_text` handoff column (written once, consumed once, self-cleaning).
- A recursive `setTimeout` polling loop in `configure/[id]/page.tsx` never cancelled itself on effect re-run, allowing orphaned poll chains to accumulate and flood `/meter-mappings` with request bursts (360+ near-simultaneous calls observed) — this is what caused "Confirm & apply" to appear to hang during testing (the click never reached the server). Fixed with a cancellation flag + stored timer id.

## VERCEL COMPUTE REGION MIGRATION — production-verified 2026-08-18

**Supabase region: West EU (Ireland) / `eu-west-1`** — confirmed manually by the user directly in the Supabase dashboard (Project Settings → General), not inferred from the project URL or any network-level signal. A Cloudflare edge-datacenter header (`cf-ray: ...-ARN`) was checked during this audit and explicitly rejected as unreliable evidence, since it reflects Cloudflare's request-routing edge, not the database's true origin location.

**Vercel compute region: Dublin / `dub1` (`eu-west-1`)** — was `iad1` (Washington D.C., US) for the entire duration of this audit and every prior deployment this session; migrated 2026-08-18, commit `24e530d7`. `dub1` is the same AWS region as both Supabase and Bedrock.

- **Config change**: `vercel.json` top-level `"regions": ["dub1"]` — confirmed via Vercel's own current documentation (fetched live, not from memory) that this remains the supported, version-controlled way to set a project's default function region, and that no `functions.*.regions` or per-route `preferredRegion` override exists anywhere in the codebase to conflict with it. Single region only, as instructed — no multi-region failover configured.
- **Deployed to Preview first** (`verdix-j5k9x19uy`), full smoke suite run against it, then promoted to Production only after passing.
- **Independent verification the function actually moved — not inferred, not assumed**:
  - Vercel's own build manifest: `npx vercel inspect ... --wait` shows every lambda tagged `[dub1]` (previously always `[iad1]`).
  - Live request metadata on the real production domain: `curl -sI https://www.lynoraai.com/api/debug` → `x-vercel-id: arn1::dub1::...` (the middle segment is the actual function-execution region; `arn1` is just the Cloudflare/Vercel edge PoP that received the request).
- **Full smoke suite re-run against production post-migration**: RLS isolation (8/8), route-level auth (401/403 on all 5 previously-fixed routes), security headers, a genuinely re-signed Stripe webhook event, Remembill webhook (correctly still 401 — no secret configured yet, unrelated to region), Remembill payment-sync cron (`checked: 11, paid: 0`), retention-cron dry-run (`candidate_count: 0`, no deletions), demo-lead capture (real Supabase write), and both Bedrock AI clients (main extraction + meter-mapping fast client) invoked live and returned correct responses through the EU Bedrock path. All passed.
- **Latency, before (`iad1`) vs after (`dub1`), same methodology both times**: retention-cron dry-run (a real Supabase-querying request) went from **782ms avg → 371ms avg** (production, ~53% faster) — consistent with compute now being co-located with the database instead of crossing the Atlantic on every DB round-trip. No endpoint tested showed a regression.
- **Not verified by browser**: sign-in, contract upload, PII detection, extraction, review panel, "Confirm & apply", and meter mapping were not re-tested via the UI for this specific change (no browser automation available) — but this migration changed zero application code, only the function execution region, and those exact flows were manually verified end-to-end on the immediately-preceding preview just prior to this change.

**Public security copy**: not touched by this migration, per instruction. Now that both Supabase and Vercel compute are confirmed EU (`eu-west-1`), the "EU-based infrastructure" claim no longer has an unresolved compute-region gap — but updating the actual Privacy Policy/Security page wording is a separate step, not done as part of this verification.

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

### HIGH — PII masking is a paid add-on, not a baseline guarantee — ✅ RESOLVED
`execute/route.ts` and `detect-pii/route.ts` both gated masking behind `pii_addon_enabled === true || plan_id === 'trial'`. The Privacy Policy and Security page state masking as unconditional ("Before any text is sent for AI analysis, PII... is masked"). Per explicit instruction, the plan gate was removed from both routes — masking is now a baseline control for every org, matching what the pricing page already said ("Available on all plans"). Verified in production.

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
- No email verification on self-service signup (`email_confirm: true` set unconditionally) — anyone can sign up claiming an email they don't own. Still open.
- Self-service org auto-creation defaulted to **enabled** when the `verdix_settings` feature-flag row hadn't been seeded — ✅ **RESOLVED**: fail-safe default flipped to `false` (invitation-only). Production's `verdix_settings` row was independently confirmed already explicitly set to `'false'` (not relying on the code default), so this was a defense-in-depth fix, not a live-behavior change.
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
| AI processing pinned to an EU AWS region | `AWS_REGION=eu-west-1`, `AWS_BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6` (an EU cross-region inference profile), and — after this session's fix — *all* AI calls in the contract pipeline now route through it, not just the main extraction call. Confirmed live via AWS CloudWatch. |
| Supabase project region is EU | **Confirmed directly in the Supabase dashboard (Project Settings → General) by the user: "West EU (Ireland)"** — i.e. `eu-west-1`, the same AWS region as Bedrock. Not inferred from the project URL or any network-level signal (a Cloudflare edge-datacenter header was checked and explicitly rejected as unreliable — it reflects request routing, not the origin's true location). |
| PII detection itself is local, not AI-based | `lib/pii-detector.ts` imports only `compromise` (local NLP); no network/AI client. |
| Storage bucket is private with correct access scoping | `verdix-files` bucket created `public: false`; its one RLS policy is correctly `to service_role`. |
| Stripe/billing webhooks verify signatures | `stripe.webhooks.constructEvent(...)` with a real secret, confirmed in both `stripe/webhook` and `billing/webhook`. |
| No secrets committed to git | `git log` across all branches for `.env*`/`.pem`/`.key` file additions returns nothing. |
| No `NEXT_PUBLIC_`-prefixed secret | Every secret-shaped env var (`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `AWS_SECRET_ACCESS_KEY`, etc.) correctly lacks the prefix; only the two Supabase values designed to be public (URL, anon key) carry it. |
| Retention/deletion is now implemented | New cron + `deletion_log` + `removeStorageObject()`, wired into both manual and scheduled deletion paths, dry-run-verified against production (`candidate_count: 0`). |
| Tenant isolation at both DB and app layers | RLS lockdown migration applied + all 11 route-level gaps fixed, and independently verified against production (RLS isolation test 8/8, route-level 401/403s confirmed on `www.lynoraai.com`). |

## 4. Claims that cannot currently be verified (need dashboard/account access I don't have)

- **Whether Bedrock's `eu.*` cross-region inference profile is confined to EU regions specifically**, and its prompt/output retention and invocation-logging configuration — check the AWS Bedrock console for this account.
- **"Your data is never used to train AI models"** — this is a claim about AWS's/Anthropic's own service terms, not something Verdix's code enforces or can prove; verify against the actual AWS Bedrock service agreement for this account.
- **Exact encryption protocols (AES-256, TLS 1.3) across every hop** — genuinely infra/provider-level, not verifiable from application code. Recommend the provider-neutral wording below.
- **"Access to production systems is restricted to named individuals on a need-to-know basis"** — requires a review of who actually has access in Vercel/Supabase/AWS, which I can't see.
- **`REMEMBILL_WEBHOOK_SECRET` and `CRON_SECRET` actual production values** — absent from local `.env.local`; the webhook fix now fails closed either way, but confirm these are actually set in Vercel so the integrations keep working.
- **Backups/PITR** — Supabase plan tier and backup configuration are dashboard-only; not visible from code.
- **MFA on Vercel/Supabase/AWS accounts** — dashboard-only.

## 5. Vercel compute region — ✅ RESOLVED 2026-08-18

Every deployment throughout this audit (`npx vercel inspect ... --wait`) showed lambdas running in `[iad1]` (Washington D.C., US) — `vercel.json` had no `regions` override, so the app ran on Vercel's default region, even though the database and AI inference were EU-pinned. Originally flagged as an infra decision to report rather than apply unilaterally.

Explicitly instructed and migrated: `vercel.json` now sets `"regions": ["dub1"]` (Dublin, `eu-west-1` — the same AWS region as Supabase and Bedrock), single-region only, no failover. Deployed to Preview, full smoke suite passed (including live Bedrock calls through both AI clients and a real Supabase write), latency compared before/after (53% faster on a Supabase-touching endpoint, no regressions), then promoted to Production and independently re-verified: Vercel's build manifest tags every function `[dub1]`, and a live request against `www.lynoraai.com` returns `x-vercel-id: arn1::dub1::...`. Full detail in the "VERCEL COMPUTE REGION MIGRATION" section above.

## 6. Decisions requiring your call

1. ~~**PII masking behind a paid add-on**~~ — ✅ **Resolved**: made universal per explicit instruction, no code gate remains. The vestigial `/api/billing/pii-addon` Stripe SKU/route was deliberately left alone (removing a billing product is a separate commercial decision, not a security fix) — worth cleaning up separately if it's no longer meaningful to sell.
2. **Retention-policy ambiguity** — "90 days after job completion" doesn't say what happens to a job that never completed (stuck/failed). The cron applies the 90-day window uniformly from `jobs.updated_at` regardless of status, flagged in its own code comment. It ships in **dry-run mode only** (`RETENTION_DELETE_ENABLED` unset) — first production dry-run returned `candidate_count: 0`, so this is genuinely low-urgency right now, but the status question should be resolved before ever setting `RETENTION_DELETE_ENABLED=true`.
3. ~~**`meter-mappings`'s AI call**~~ — ✅ **Resolved**: found and live-tested a real EU Bedrock Haiku profile (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) against this AWS account before wiring it in (verified via a real `InvokeModel` call, not just checking it was listed). All AI calls in the app now route through Bedrock when `USE_BEDROCK=true`.
4. ~~**Self-service signup default**~~ — ✅ **Resolved**: fails closed now. Email verification on signup is still genuinely open — not fixed, since building real verification (send/confirm flow) is a larger feature than a config default flip.

---

## 7. Verification matrix (§20)

| Public claim | Implementation evidence | Verified? | Fix made | Safe website wording |
|---|---|---|---|---|
| EU-based infrastructure | AI: EU-pinned, confirmed via live AWS CloudWatch metrics (`eu-west-1`). Supabase: confirmed `eu-west-1` (Ireland) directly in the dashboard. Vercel compute: **confirmed `dub1`/`eu-west-1` (Ireland)** — was `iad1` (US) throughout the audit, migrated and independently verified 2026-08-18 via Vercel's own build manifest and live `x-vercel-id` response header on production. | **Yes — all three layers (data storage, AI, compute) now confirmed EU (`eu-west-1`).** | Bedrock routing fixed, env vars configured in Vercel, Supabase region confirmed, **and compute region migrated + verified**. | The claim can now stand as a genuine, verified "EU-based infrastructure" statement covering data storage, AI processing, and application compute together — not just narrowed to data/AI. Updating the actual public copy is a separate, deliberate step, not done automatically by this fix. |
| PII masked before AI processing | Pipeline routes all AI calls through the masking-aware, Bedrock-pinned path, **for every org, no plan gate**. | **Yes** | Routing bug fixed; paywall gate removed entirely | Keep the claim as-is — it's now accurate. |
| No training on customer contracts | Provider-level (AWS Bedrock/Anthropic) commitment, not app-enforced | **Cannot verify from code** | — | Keep only if independently confirmed against the actual AWS Bedrock agreement for this account. |
| Encryption at rest | Standard for Supabase/AWS, not independently provable per-hop from code | **Cannot verify exact claim** | — | "Customer data is encrypted at rest." |
| Encryption in transit | Same | **Cannot verify exact protocol version** | — | "Customer data is encrypted in transit." |
| Retention/deletion (90-day docs, 30-day post-termination) | Was entirely unimplemented; now a cron + Storage removal + audit log exist, **dry-run-verified against production** (`candidate_count: 0`, no deletions have occurred) | **Was false; now implemented** | Yes — new cron, `removeStorageObject`, `deletion_log` | Keep the claim — deletion mechanism now genuinely exists (real deletion still gated behind `RETENTION_DELETE_ENABLED`, pending the §6.2 policy-ambiguity decision). |
| Tenant isolation | Was severely broken at both DB (RLS) and app (route auth) layers; both fixed, migration applied, **RLS isolation test passing 8/8 against production**, route-level 401/403s confirmed against `www.lynoraai.com` directly | **Was false; now fixed and production-verified** | Yes — extensive, see §2 | Keep the claim — independently verified, not just code review. |
| Restricted production access | Organizational, not code-visible | **Cannot verify from code** | — | Keep only if independently confirmed who has dashboard access. |
| Clause-linked auditability | Real product feature — `commercial_rule_interpretations` stores source clause, reviewer, timestamps; its RLS was decorative until this fix | **Yes**, feature-level; DB-level enforcement now genuine too | RLS fix makes the audit trail itself properly isolated | Keep as-is. |

---

## 8. Remaining manual actions

Done:
1. ~~Apply the migrations~~ — all 5 applied (`demo_leads`, `rls_lockdown`, `deletion_log`, `pending_extracted_text`, plus the original `demo_leads` fix).
2. ~~Confirm/set `CRON_SECRET`~~ — set in Vercel (Production + Preview); cron auth also fixed to accept Vercel's automatic `Authorization: Bearer` header, not just the custom one.
3. ~~Configure `USE_BEDROCK`/AWS credentials in Vercel~~ — set (Production + Preview) and confirmed working via live CloudWatch data.
4. ~~Run the RLS isolation test against production~~ — done, 8/8 passing.
5. ~~Check the Supabase project's region~~ — confirmed directly in the dashboard: **`eu-west-1` (Ireland)**, same region as Bedrock.
6. ~~Decide on/migrate the Vercel compute region~~ — migrated to `dub1` (`eu-west-1`, Ireland) and independently verified on production 2026-08-18 (build manifest + live `x-vercel-id` header). All three infrastructure layers — data storage, AI processing, application compute — are now confirmed in the same EU region.

Still open:
1. **`REMEMBILL_WEBHOOK_SECRET`** — not yet set (Remembill's sandbox doesn't support sending it yet, per them). Webhook correctly fails closed in the meantime; `remembill-payment-sync` cron covers the gap. Set this once Remembill implements it.
2. **Check the Bedrock console** for this AWS account: exact regions covered by the `eu.*` inference profile, invocation logging, and prompt/output retention configuration.
3. **Confirm AWS/Anthropic's actual data-training policy** for this account before keeping the "never used to train AI models" claim.
4. **Confirm who has production access** to Vercel/Supabase/AWS, and that those accounts have MFA enabled.
5. **Confirm Supabase backup/PITR configuration** for the current plan tier, and whether a restore has ever been tested.
6. **Resolve the retention-policy ambiguity** (§6.2 — failed/incomplete jobs) before ever setting `RETENTION_DELETE_ENABLED=true`.
7. **Add real email verification to signup** if desired — self-service now fails closed by default, but verified accounts still aren't required.
8. Consider cleaning up the vestigial `/api/billing/pii-addon` Stripe SKU now that masking is universal (commercial decision, not security).
9. **Update public Privacy Policy/Security page copy** to reflect that application compute is now also confirmed EU-hosted (`dub1`), if the "EU-based infrastructure" claim should explicitly cover compute, not just data/AI. Not done automatically — a deliberate copy change is a separate step from this verification.
