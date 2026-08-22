# Step 14 — Immutable billing execution attempts and provider-safe idempotency

Step 13 established the execution boundary (readiness → APPROVING →
external billing → COMPLETED) and the fact that `FAILED` may mean the
external outcome is uncertain, requiring explicit admin verification
before retry. That round's report named the root cause but didn't fix it:
Stripe's invoice-write calls carried no idempotency key at all, and
Remembill's `Idempotency-Key` was rebuilt fresh on every Approve attempt,
so neither platform's write path was provably safe to retry. Step 14 fixes
this directly: every provider side effect Verdix makes is now bound to a
durable, immutable execution identity with a stable, derived idempotency
key, so a retry — whether from a timeout, a crash, a duplicate HTTP
request, or an admin-authorized resume — reuses the same key instead of
generating a new one.

## 1. The real operation DAG (audited, not assumed)

### Stripe (`configureStripe`, before this step)

| # | Operation | Input | Object | Identifier source | Retry behavior before | Response persisted? | Ambiguous? |
|---|---|---|---|---|---|---|---|
| 1 | `customers.search` then `.create`/`.update` | name, email, address, metadata | Customer | `customer.id`, returned synchronously | **No idempotency key at all.** Soft dedup only (search by name). | Not until the whole function returns (`ConfigureResult.customerId`) | Yes — a lost response after `.create()` risks a duplicate customer if the name search doesn't find it |
| 2 | `invoices.create` (per due period/fee) | customer, `days_until_due`, metadata | Invoice (draft) | `inv.id` | **No idempotency key at all.** | Not until the whole `plannedRows` batch insert at the very end of the function | **Yes, severely** — a retry creates a second, unrelated invoice unconditionally |
| 3 | `invoiceItems.create` | customer, invoice, amount, currency | InvoiceItem | Return value **discarded**, not even captured | **No idempotency key at all.** | Never | Yes |
| 4 | `invoices.finalizeInvoice` | invoice id | transitions draft → open | same invoice id | **No idempotency key.** Wrapped in `.catch(err => { console.error(...); return inv })` — **every failure was silently swallowed and treated as success**, using the stale, unfinalized invoice object. | The (possibly-wrong) result fed the batch insert | **Worse than ambiguous** — a genuine failure was actively misreported as success |

Batch persistence (step 5, at the very end of the whole function) meant a
crash or throw partway through the period/fee loop lost all knowledge of
every Stripe object already created earlier in that same call — the exact
scenario Step 14's per-operation persistence (below) closes.

### Remembill (`configureRememhill`, before this step)

| # | Operation | Input | Object | Retry behavior before | Response persisted? | Ambiguous? |
|---|---|---|---|---|---|---|
| 1 | `POST /customers` | type, name, email, org_number | Customer | **No idempotency key at all**, and no dedup search (unlike Stripe) | Yes — immediately, to `jobs.billing_customer_id`, before any invoice call (the one place this file already did "persist right after success") | Yes, in the narrow window between the response and that persist write |
| 2 | `POST /invoices` (`pushInvoice`) | customer_id, dates, terms | Invoice (draft) | `Idempotency-Key` header **present**, but built from `pushStamp = Date.now().toString(36)` — **regenerated fresh on every call to `configureRememhill`**, so a genuine retry (a second Approve request) never reuses it | Not until the whole `plannedRows` batch insert at the end | Yes — the key exists but doesn't protect what it needs to |
| 3 | `POST /invoices/:id/rows` | name, quantity, price, vat | Row | **Confirmed no idempotency mechanism at this endpoint at all** (not even an unstable key) | Never | Yes, and structurally unfixable without a provider-side mechanism that doesn't exist |
| 4 | `POST /invoices/:id/email` | — | delivery | best-effort `.catch()` | Never | Not a financial side effect — out of scope for this step's tracking (a duplicate email is a UX annoyance, not a billing-correctness risk) |

No Remembill sandbox is available in this project (single `REMEMBILL_API_KEY`,
no test-mode indicator) — per the amendment's "do not create chargeable
real invoices," no live retry-behavior probe against Remembill's real API
was attempted. Its idempotency capability is therefore marked honestly
(section 8/25) rather than assumed.

## 2. Domain model

`lib/billing-execution-attempt.ts` — pure types, no I/O:
- `BillingExecutionAttempt` / `BillingExecutionAttemptStatus` (`created →
  executing → succeeded | failed_safe | outcome_uncertain | cancelled`).
- `BillingExecutionOperation` / `BillingExecutionOperationStatus`
  (`pending → started → succeeded | failed_safe | outcome_uncertain`).
- `BillingOperationRetryCapability` (`idempotent_retry | reconcilable |
  manual_verification_required`) — declared per operation, not assumed
  globally per provider (item 9).
- `BillingExecutionAdminAction` (`retry_authorized |
  operation_verified_succeeded | operation_verified_not_executed |
  attempt_abandoned`).
- `BillingPreconditionError` — a deterministic, pre-any-external-call
  validation failure (missing API key, unsupported currency, missing
  required field), thrown before an attempt even exists.
- `deriveIdempotencyKey(attemptId, provider, operationType, componentKey?)`
  — pure string concatenation, `verdix:<attempt-id>:<provider>:<type>[:<key>]`.
  Never `Date.now()`, never random, never an HTTP-request id.
- `classifyStripeFailure`/`classifyFetchOutcome` — the failure
  classification rules (section 6).

`lib/billing-execution-plan.ts` — the deterministic "what to send right
now" snapshot and its fingerprint (section 3).

`lib/billing-execution-store.ts` — the sole module that reads/writes the
three new tables (section 4).

## 3. Billing-plan fingerprint

Reuses the EXACT computation that already decides what a real push sends
(`computeBillingSchedule`'s due-period gate, `isOneTimeFeeHeldForExecution`'s
held/execute decision, the existing `alreadySent` dedupe) — never a second,
parallel billing representation that could silently disagree with what
`billing-writer.ts` actually executes.

```ts
BillingPlanSnapshot = {
  provider, currency,
  customerIdentityKey,   // sha256(name + org_number) — never a DB id
  lines: BillingPlanLineInstruction[]  // sorted by componentKey
}
BillingPlanLineInstruction = {
  kind, componentKey, amount, currency, quantity, unitPrice, dueDate,
  vatMode, vatRatePct,
}
```

`fingerprintBillingPlan` canonically serializes (sorted object keys, at
every depth) then `sha256`s. No `generated_at`, no random id, no request
timestamp — property insertion order provably cannot affect the
fingerprint (tested directly). Proven: same inputs → same fingerprint;
changed amount/currency/component/VAT/customer-identity → different
fingerprint (`lib/billing-execution-plan.test.ts`, 9 tests).

VAT is resolved from whichever source is genuinely available before any
provider call: `customer_vat_config` when a customer already exists, or
`jobs.pending_vat_mode`/`pending_vat_rate_pct` (the same source
`approve/route.ts`'s own readiness gate already reads) when it doesn't —
so VAT (item 3's explicit "tax" example) is always part of the fingerprint,
never deferred past the point a fingerprint must exist.

## 4. Persistence — three tables, `supabase/migrations/20260825000001-3`

`billing_execution_attempts`, `billing_execution_operations`,
`billing_execution_admin_actions` — all service-role-only RLS, matching
Step 13's pattern (section 9).

**Uniqueness**: at most one *active* (`created`/`executing`) attempt per
`(job_id, provider)` — a partial unique index, the strictly stronger
invariant item 11 allows ("or the smallest stronger invariant justified").
`unique(attempt_id, operation_key)` on operations (item 20).

**`getOrCreateAttempt`** (`lib/billing-execution-store.ts`) is the one
entry point deciding resume-vs-create:
1. An active (`created`/`executing`) attempt for this job+provider exists
   → reuse it if the fingerprint matches; otherwise throw
   `BillingPlanChangedWhileAttemptInFlightError` (should not be reachable
   in normal flow — see section 7's crash-recovery cleanup).
2. No active attempt, but the **most recent** one is `failed_safe` or
   `outcome_uncertain` **and its fingerprint still matches** the current
   plan → **reuse its id** (re-open it to `executing`). This is what makes
   idempotency keys survive a retry: they're derived from the attempt id,
   so reusing the row is what makes a retried operation reuse its key.
3. Otherwise → create `attempt_number + 1`, fresh keys, a genuinely new
   financial execution identity (item 22).

Two concurrent callers racing step 3 converge on one row — the loser's
insert hits the unique index and re-reads instead of erroring.

## 5. Immutability (item 19) — audited live, corrected twice

`billing_execution_attempts`/`billing_execution_operations`: a `BEFORE
UPDATE` trigger rejects any change to identity fields (`org_id`, `job_id`,
`provider`, `attempt_number`, `billing_plan_fingerprint`,
`billing_plan_snapshot` / `attempt_id`, `operation_key`, `operation_type`,
`idempotency_key`, `request_fingerprint`, `retry_capability`). `status` and
timestamps remain mutable (state, not identity). `external_object_id`/
`error_class` on operations are one-way: settable from `null`, never
changed once non-null. **Live-verified against `service_role` directly**
(not just RLS) — triggers fire at the executor level regardless of role.

`billing_execution_admin_actions` — two real bugs found and fixed via live
testing, not assumed correct from the migration text alone:

1. **First design was wrong**: "no UPDATE/DELETE RLS policy" was believed
   to make the table append-only. Live-tested directly: `service_role`
   **bypasses RLS entirely** in this project (Supabase's standard
   default) — the policy-only design gave zero actual protection.
   Fixed (`20260825000002`) with a real `BEFORE UPDATE OR DELETE` trigger.
2. **Second design was also wrong**: the unconditional DELETE-blocking
   trigger also blocked the *cascade* delete from the existing job-deletion
   feature (`jobs(id) on delete cascade)` → any job with billing execution
   history could no longer be deleted at all — a real regression to an
   existing capability. Fixed (`20260825000003`) by dropping only the
   DELETE trigger; UPDATE stays permanently blocked. Live-verified: a
   direct UPDATE is still rejected; a job with an attempt and an admin
   action deletes cleanly via cascade.

## 6. Failure classification (item 14)

Conservative, two-bucket, allowlist-based (never a denylist that defaults
to "safe" for anything unrecognized):

- **Stripe** (`classifyStripeFailure`): an explicit allowlist of Stripe SDK
  error *types* that represent a definitive, synchronous rejection
  (`StripeInvalidRequestError`, `StripeCardError`,
  `StripeAuthenticationError`, `StripePermissionError`,
  `StripeRateLimitError`, `StripeIdempotencyError`) → `failed_safe`.
  Everything else — including `StripeConnectionError` ("can't connect, OR
  no response within the timeout" — both genuinely ambiguous),
  `StripeAPIError` (Stripe's own 5xx — doesn't prove nothing committed),
  and any error type this code doesn't recognize at all (a future SDK
  error class) — defaults to `outcome_uncertain`. Confirmed via the actual
  SDK source (`this.type = type || this.constructor.name`) that `.type`
  reliably equals the class name.
- **Remembill/generic fetch** (`classifyFetchOutcome`): a definitive HTTP
  response (even an error one) → `failed_safe`; the request itself
  throwing (network error, timeout, abort — no response received) →
  `outcome_uncertain`.
- **`BillingPreconditionError`** (missing API key, unsupported currency,
  missing org number) is thrown **before any attempt exists at all** — not
  classified through either path; `approve/route.ts` treats it identically
  to the fresh-evidence-check pre-effect failure (restore `claimedFrom`,
  never the ambiguous `FAILED`).

## 7. Integration with APPROVING (item 12)

Actual sequence, as implemented:

```
readiness check (workload/evidence)
→ atomic APPROVING claim (Step 13's claimForApproval, unchanged)
→ fresh evidence/workload re-check (Step 13, unchanged)
   → blocker found: BillingPreconditionError-style restore to claimedFrom (no attempt touched)
→ configureBilling
   → build plan snapshot + fingerprint (no external call yet)
   → getOrCreateAttempt (create attempt #1, or resume a matching-fingerprint terminal one)
   → markAttemptExecuting
   → runTrackedOperation for resolve_customer, then each due line's
     create_invoice → create_invoice_item → finalize_invoice (Stripe) or
     create_invoice → create_invoice_row (Remembill) — persisted
     immediately after each success (item 10), never batched
   → all succeed: markAttemptStatus('succeeded'), job → COMPLETED
   → any operation throws: that operation's own failed_safe/
     outcome_uncertain already persisted; markAttemptStatus with the same
     classification; re-thrown to approve/route.ts's catch block, which
     sets the job to FAILED with the explicit ambiguity warning
```

The attempt is known and exists before the first external side effect —
proven directly (33/33 live HTTP checks, section 11), not merely asserted.

**Stuck-APPROVING crash recovery** (`jobs/[id]/route.ts`'s existing
Step-13 PATCH handler) now also calls `resolveStuckAttemptsForJob`, which
marks any attempt still `created`/`executing` for that job as
`outcome_uncertain` — honest (never guesses succeeded/failed_safe) and
frees the one-active-attempt uniqueness constraint for a future,
explicitly authorized retry.

## 8. Retry authorization, redesigned around the attempt (item 16)

`POST /api/jobs/[id]/authorize-billing-retry` (unchanged trigger: FAILED
only, admin-only) now **inspects the latest attempt's operations first**:

- No attempt exists (e.g. a `BillingPreconditionError` FAILED job) →
  trivially authorized, nothing to check.
- Every operation is `succeeded`, never-started, or `failed_safe`
  (confirmed safe to retry), or `outcome_uncertain` with
  `idempotent_retry` capability (the provider's own key guarantees
  convergence) → **case A**, authorized. The next Approve resumes the SAME
  attempt (section 4) — same operation rows, same idempotency keys —
  live-verified (`resolve_customer`'s operation id and idempotency key were
  byte-identical across the retry).
- Any operation is `outcome_uncertain` with a non-`idempotent_retry`
  capability → **case C**, blocked (400, `operation_requires_reconciliation`,
  names the exact operation) — no special-cased "case B" branch needed:
  reconciliation (below) is what moves an operation OUT of this state, and
  authorize-billing-retry just re-checks current reality.

`POST /api/jobs/[id]/reconcile-billing-operation` (new, item 16 case B) —
admin-only, narrow, ownership-chain-verified (operation → its owning
attempt → `job_id`/`org_id` compared against the URL and session, never
trusted from the request body):
- `outcome: 'succeeded'` (requires `externalObjectId`) → operation →
  `succeeded`, that id recorded — a future resume returns it without
  calling the provider again.
- `outcome: 'not_executed'` → operation → `failed_safe` (confirmed nothing
  was created — safe to retry).
- Only operates on an operation genuinely `outcome_uncertain` — rejects
  otherwise (can't "reconcile" something already resolved).

Both actions record an immutable `billing_execution_admin_actions` row
(item 24) — never `jobs.error_message` alone, which the very next Approve
attempt would overwrite.

## 9. RLS / tenancy (item 18)

All three tables: service-role-only, anon key denied on every operation
(SELECT/INSERT/UPDATE/DELETE) — `lib/billing-execution-attempts-rls.test.ts`,
17 tests, live. Application-level ownership (item 17/26 — cross-org/
cross-job operation ids) proven via real HTTP: a different org's admin,
and a different job in the *same* org, both get 404 attempting to
reconcile another job's operation; the target operation's status is
provably untouched afterward.

## 10. No browser-mutable server-owned state (item 17)

No route accepts `attempt status`, `operation status`, `external object
id`, `idempotency key`, `provider`, or `billing plan fingerprint` as
client input. `authorize-billing-retry` takes no body at all.
`reconcile-billing-operation` takes only `{operationId, outcome,
externalObjectId?}` — the operation's own identity fields, capability, and
idempotency key are never accepted from the request; ownership is
re-derived server-side on every call.

## 11. Live verification (item 26/27) — what was proven and how

**33/33 live HTTP checks**, real dev server, real Supabase project, real
Stripe TEST mode (never Remembill's real API — no confirmed sandbox; see
section 1):

- Approve creates exactly one attempt with real tracked operations before
  any job-level terminal state; a deterministically-rejected currency
  (`invoiceItems.create` with an invalid ISO code) proves the classify-
  and-persist path end to end, including a *real* `resolve_customer` and
  `create_invoice` succeeding first.
- `COMPLETED` + Approve → 409, **zero** attempts created.
- `FAILED` + Approve (no authorization) → 409, **zero** attempts created.
- Concurrent Approve → exactly one non-409 response, exactly one attempt
  row.
- `authorize-billing-retry` → next Approve resumes the **same** attempt
  row and the **same** operation row with an **unchanged** idempotency
  key.
- Changing the billing plan (amount) between a failed attempt and
  re-authorization → the next Approve creates a **second**, distinct
  `attempt_number` with a **different** fingerprint — never resumes the
  stale one (item 22).
- An `outcome_uncertain` + `manual_verification_required` operation
  (synthetic Remembill row-creation scenario — no real Remembill call
  needed to prove the *logic*) blocks `authorize-billing-retry` outright;
  reconciling it (`not_executed`) flips it to `failed_safe`, records both
  admin actions in order, and authorization then succeeds.
- Cross-org and cross-job reconciliation attempts → 404, target untouched.
- Reconciling an already-resolved operation → rejected; `succeeded`
  without `externalObjectId` → rejected.

**Stripe TEST-mode idempotency proof** (separate script, real
`STRIPE_SECRET_KEY_TEST`, `livemode: false` confirmed): the identical
`idempotencyKey`, sent twice, on `invoices.create`, `invoiceItems.create`,
and `finalizeInvoice` each returned the byte-identical object id both
times; a different key produced a genuinely different invoice (the test
itself is meaningful, not vacuously passing). This is the direct,
foundational proof that Step 14's `idempotent_retry` capability marking
for Stripe operations is earned, not assumed.

**Not live-tested**: Remembill's actual server-side idempotency-key
honoring. No sandbox is available in this project and the amendment
explicitly forbids creating chargeable real invoices to find out — see the
capability matrix (section 12) for why this is reported honestly as
unverified rather than assumed safe.

## 12. Provider capability matrix

| Provider | Operation | Native idempotency? | Stable key implemented? | External id persisted? | Safe automatic retry? | Reconciliation possible? | Residual risk |
|---|---|---|---|---|---|---|---|
| Stripe | resolve_customer (create/update) | Yes (SDK `idempotencyKey`) | Yes, attempt-derived | Yes, immediately on success | **Yes** — `idempotent_retry`, live-proven | N/A (auto-safe) | Retention window (Stripe documents ~24h key retention) — a retry far outside that window is not covered; not currently reachable given this app's own FAILED→authorize-retry flow is human-paced but not literally time-bounded, flagged here rather than silently assumed |
| Stripe | create_invoice | Yes | Yes | Yes | **Yes** — live-proven | N/A | Same retention caveat |
| Stripe | create_invoice_item | Yes | Yes | Yes (item id) | **Yes** — live-proven | N/A | Same retention caveat |
| Stripe | finalize_invoice | Yes | Yes | Yes (invoice id, unchanged) | **Yes** — live-proven | N/A | Same retention caveat. Also: the previous silent-failure-swallow bug (section 1) is fixed — a finalize failure now correctly propagates and classifies instead of being misreported as success |
| Remembill | resolve_customer (create) | **Unconfirmed** (no sandbox to verify header honoring) | Idempotency-Key sent, but capability marked `reconcilable` — Verdix's OWN `jobs.billing_customer_id` persisted-on-success is the real, working reconciliation mechanism, not the provider's key | Yes, immediately on success (pre-existing pattern, kept) | `reconcilable` — a retry checks Verdix's own DB first; an `outcome_uncertain` result does NOT auto-retry, requires admin reconciliation before resuming | Yes — via `POST /reconcile-billing-operation` | Genuinely unverified provider-side guarantee; mitigated by the local check, not assumed away |
| Remembill | create_invoice | **Unconfirmed** | Stable, attempt-derived key now sent (fixes the old `Date.now()`-based key that never survived a retry) — capability marked `manual_verification_required`, honestly, because the header's actual server-side effect is unverified | Yes, immediately on success | **No** — never auto-retried once `outcome_uncertain`; requires explicit admin reconciliation | Yes — via `POST /reconcile-billing-operation` | The stable key can only help if Remembill honors it; Verdix does not claim it does |
| Remembill | create_invoice_row | **Confirmed no idempotency mechanism exists at this endpoint at all** | N/A | Not applicable (no id captured/needed beyond the parent invoice) | **No** — `manual_verification_required` | Yes — via `POST /reconcile-billing-operation` | Structurally unfixable without a provider-side mechanism that doesn't exist; this is the honestly-reported residual gap the amendment's own item 25 example anticipates ("Remembill row creation → manual verification still required") |
| Remembill | send email | N/A | N/A | N/A | N/A — best-effort, untracked | N/A | Not a financial side effect (duplicate email is a UX annoyance) — deliberately out of this step's tracked-operation model |

## 13. Residual duplicate-billing risks that still remain

1. **Stripe idempotency-key retention window** — Stripe documents keys are
   retained for a bounded period (commonly ~24h); a resume attempted well
   outside that window is not provably safe by this mechanism alone. Not
   currently guarded against explicitly (would need an attempt-age check
   before trusting `idempotent_retry` for a very old attempt) — flagged as
   a known gap rather than silently assumed covered.
2. **Remembill's actual idempotency-key behavior is unverified** — the
   stable key is a strict improvement over the old, always-broken one, but
   Verdix does not claim provider-side safety it hasn't confirmed;
   `manual_verification_required` is the honest, load-bearing mitigation.
3. **Remembill row-creation has no idempotency mechanism at all** —
   structurally unfixable without a provider change; every
   `create_invoice_row` operation that reaches `outcome_uncertain`
   requires a human to check Remembill directly.
4. **The gap between the final fresh-evidence-check and the actual
   external call** (Step 13's already-accepted residual TOCTOU window) is
   unchanged by Step 14 — still the narrow, explicitly-accepted risk from
   that round, not eliminated (would need the provider call inside the
   same transaction as the DB read, which neither provider's HTTP API
   supports).

## 14. Commercial/domain unchanged (item 28) — confirmed, not assumed

Global Rulebook: still exactly 9 entries in `verdixCommercialRulebook`
(`lib/rulebook/rules.ts`, re-read and counted this round).
`PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST` still exactly
`['survival.carry_forward']`. No new `BillabilityEventType`, no new
`OperationalEventEvidenceSource`, no change to `FieldProvenance`, the
credit engine, or any billing calculation function
(`computeMonthlyBaseRate`/`computeEscalatorMultiplier`/
`computeDiscountMultiplier`/`computeBillingSchedule` are byte-for-byte
unchanged — only re-used, never modified).

## 15. Final amendment — the unresolved-attempt barrier and bounded provider idempotency

The original round's own report said "a changed billing plan → new attempt
→ never resumes the stale one" — true, but incomplete: it didn't check
whether the *old* attempt had actually reached a determinate outcome
first. A changed fingerprint alone was sufficient to let a brand-new
attempt proceed even while an earlier attempt still had a genuinely
unresolved (`outcome_uncertain`) operation — money that might already have
been sent under the old plan. Separately, Stripe operations were marked
`idempotent_retry` unconditionally, with no accounting for the fact that
Stripe's own idempotency-key retention is time-bounded (~24h,
documented) — a retry attempted well outside that window would blindly
replay a request the provider may no longer deduplicate.

**1-4. The barrier.** `getOrCreateAttempt` (`lib/billing-execution-store.ts`)
now scans **every** prior (non-active) attempt for the job+provider —
not just the latest — before creating a new `attempt_number` for a
changed fingerprint. Resolution is checked directly against each prior
attempt's own operations (`status = 'outcome_uncertain'`), never the
attempt's own possibly-stale cached status. Any unresolved operation
blocks creation with a new `UnresolvedPriorBillingAttemptError`, surfaced
by `approve/route.ts` as `409 { code: 'unresolved_prior_billing_attempt' }`
— restoring the job to its real prior state (nothing new was attempted in
that request; the ambiguity belongs entirely to the earlier attempt). The
check is deliberately **not** applied to resuming the *same*, latest,
fingerprint-matching attempt (item 16's existing case A/B path) — only to
creating a genuinely different one; the per-operation safety of resuming
an `outcome_uncertain` operation is still decided at the operation level.

**3. Reconciliation resolves the attempt, not just the job.**
`reconcile-billing-operation` now calls a new
`recomputeAttemptStatusIfFullyResolved` after flipping an operation's
status: once none of an attempt's operations remain `outcome_uncertain`,
the attempt itself becomes `succeeded` (if every operation succeeded) or
`failed_safe` (a resolved mix) — never rewriting or deleting the
historical operation rows themselves, only the attempt's own aggregate
status field. This is what lets the barrier's scan (which checks live
operation state, not this cached field) and human-facing reporting agree.

**5-9. Time-bounded Stripe idempotency.** `canSafelyRetryBillingOperation
(operation, asOf)` (`lib/billing-execution-attempt.ts`) is the pure,
`asOf`-parameterized decision — never ambient `Date.now()` inside it, so
it's fully deterministic and unit-tested at exact boundary instants (8
new tests, including "exactly at the window is still safe, one
millisecond past is not"). Only `idempotent_retry` operations can ever
return `true` for an `outcome_uncertain` operation, and only within
`STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS` (23 — a deliberate 1-hour buffer
under Stripe's own documented ~24h, not their exact figure, given clock
skew and that this is only checked at discrete retry moments).
`reconcilable`/`manual_verification_required` are time-*independent*: no
amount of elapsed time makes an unproven local check or an unconfirmed
provider guarantee safe to auto-replay.

The window is anchored to `started_at` — but the previous round's
`markOperationStarted` unconditionally overwrote it on every call,
including resumes, which would have silently reset the retention clock on
every retry (exactly what item 9 forbids). Fixed: `markOperationStarted`
now takes an explicit `isFirstAttempt` flag (`op.startedAt === null`,
read from the row *before* the call) and only writes `started_at` the
very first time an operation is attempted; `status` still updates
unconditionally, since that's state, not a timing anchor. No new column
was needed — `started_at` already existed and is written before the
provider call is transmitted, exactly matching item 9's own suggestion.

Both real retry-decision call sites — `runTrackedOperation`
(`billing-writer.ts`, the actual execution gate) and
`authorize-billing-retry`'s pre-check — now call the same
`canSafelyRetryBillingOperation`, so authorizing a retry and then having
the very next Approve immediately refuse it can no longer happen.

**10. The exact crash-after-provider-commit scenario, live-tested.** A
synthetic Stripe `idempotent_retry` operation with `started_at` set to
25 hours before `asOf`: `authorize-billing-retry` correctly refuses
(`400`, `operation_requires_reconciliation`, message explicitly naming the
retention-window reason), the job stays `FAILED`, and manual
reconciliation (`outcome: 'succeeded'` with the real, human-verified
Stripe object id) remains the only path forward — proven live, not
simulated.

**11-12. Stripe invoice-item attempt isolation — audited and proven, not
assumed.** The SDK's own doc comment for `InvoiceItemCreateParams.invoice`
confirms: *"For standalone invoices, the invoice item won't be
automatically added unless you pass `pending_invoice_item_behavior:
'include'` when creating the invoice"* — and `billing-writer.ts` always
passes `invoice: invoiceId` explicitly AND creates invoices with
`pending_invoice_items_behavior: 'exclude'`, a double-layered guarantee
(items are bound directly to their specific invoice; even a hypothetical
stray pending item would never be swept into a new one). Live-proven in
Stripe test mode: two invoices for the same customer, an item bound
explicitly to invoice A — invoice B's line items and `amount_due` are
both provably zero (5/5 checks). Operation ordering (item 12) was also
audited directly: every `invoiceId`/`customerId` a dependent operation
uses comes from the *same attempt's* persisted/cached
`external_object_id` (via `runTrackedOperation`'s own cache-on-succeeded
path) — grep-confirmed there is no `stripe.invoices.list`/`.search`
("discover the latest invoice") call anywhere in the file, for either
provider.

**13. COMPLETED repush UI** — unchanged from the original round (already
correct): `RevenueModelTab` shows "Billing completed" and no actionable
repush control when `isConfigured`, re-verified this round.

### Required adversarial tests (item 4) — 17/17 live

- Attempt A (fingerprint A), one operation succeeded + one
  `outcome_uncertain` (`manual_verification_required`) → commercial state
  changes to fingerprint B → Approve blocked, `409
  unresolved_prior_billing_attempt`, **zero** new attempts created, job
  restored (not FAILED).
- Reconcile the uncertain operation (`not_executed`) → attempt A's own
  status recomputes to `failed_safe` → Approve now proceeds → a genuinely
  new, distinct `attempt_number` with a different fingerprint is created.
- A `failed_safe` (no side effect) prior attempt + changed fingerprint →
  **not** blocked — the barrier doesn't unnecessarily stop a safe case.
- A Stripe `idempotent_retry` operation `outcome_uncertain` for 1 hour →
  `authorize-billing-retry` succeeds. The same operation aged to 25 hours
  → refused, explicit retention-window message, job stays FAILED; manual
  reconciliation still works and unblocks authorization afterward.

### Verification

`tsc`/`eslint` clean on every touched/new file. `vitest run` — **1150
passed** (8 new time-boundary tests), 89 skipped. RLS integration — **26/26**
(unchanged suites, re-run clean). `npm run build` clean. Rulebook
re-confirmed unchanged (9 rules, allowlist unchanged) — no commercial or
provider-set expansion.

## 16. Final financial-state correction — resolved outcome ≠ safe supersession

The barrier added in §15 gated on whether every operation had left
`outcome_uncertain` — but "resolved" and "safe to create a new attempt for"
are not the same question. Its own shortcut, `if (prior.status ===
'succeeded' || prior.status === 'cancelled') continue`, treated a fully
*successful* prior attempt as automatically safe to supersede — meaning a
changed commercial plan after a real, completed billing run could trigger
a second, duplicate external execution. Confirmed as a genuine, currently
reachable bug (not hypothetical) by re-reading `getOrCreateAttempt` before
making any change.

**The fix: a four-way classification, computed from live operation state,
never the attempt's own (potentially stale) cached status.**

```ts
export type PriorAttemptSupersessionEligibility =
  'safe_to_supersede' | 'executed' | 'partially_executed' | 'unresolved'

export function classifyPriorAttemptForSupersession(
  operationStatuses: BillingExecutionOperationStatus[],
): PriorAttemptSupersessionEligibility
```

- No operations, or every operation `failed_safe` → `safe_to_supersede`
  (nothing was ever created; the existing failed-safe-plan-changed path is
  preserved exactly).
- Any operation `outcome_uncertain`/`pending`/`started` → `unresolved`
  (unchanged from §15 — genuinely still in doubt).
- Every operation `succeeded` → `executed` — a real financial side effect
  is fully in place. `getOrCreateAttempt` now throws
  `PriorBillingAttemptExecutedError` instead of silently permitting a new
  attempt.
- A genuine mix (`succeeded` + `failed_safe`) → `partially_executed` — some
  real external objects exist, some don't; not automatically safe either
  direction. Throws the new `PriorBillingAttemptPartiallyExecutedError`.

`getOrCreateAttempt`'s barrier loop now calls this classifier per prior
attempt (skipping only `cancelled` ones) against a fresh read of that
attempt's operation statuses — so reconciliation (`recomputeAttemptStatusIfFullyResolved`,
§15) automatically produces the right classification with no further
change needed: reconciling the sole uncertain operation as `succeeded`
makes the classifier see `executed`; reconciling it as `not_executed`
(→ `failed_safe`) makes it see `safe_to_supersede`.

**Recovery, not just blocking, for the `executed` case.** A prior fully-
succeeded attempt isn't an error state — it's the job having actually
finished, possibly before the crash that lost the original HTTP response.
`recoverConfigureResultFromSucceededAttempt` (`billing-writer.ts`)
reconstructs a `ConfigureResult` purely from the attempt's own persisted
operations (the `resolve_customer` operation's `external_object_id` as
`customerId`, `create_invoice` operation count as `lineItemCount`, a
re-derived Stripe test/live dashboard URL from the org's own key prefix)
— it never calls the provider again. `approve/route.ts`'s
`PriorBillingAttemptExecutedError` handler uses this to mark the job
`COMPLETED` directly and return the same success shape a normal Approve
would, with **zero** new attempts created and **zero** provider calls
made. Deliberately, VAT promotion and `recordSync` are **not** re-run in
this recovery path — re-running either risks double-counting work the
original (crashed) request may already have completed; this is a narrow,
documented scope choice, not an oversight.

`partially_executed` stays a hard block: `409
prior_billing_attempt_partially_executed`, job restored to
`claimedFrom`, no new attempt. Per the user's explicit scope boundary, no
credit-note/reversal/rebill/amendment machinery was built to auto-resolve
this case — manual recovery is required, exactly as instructed.

### Required regressions (item 8) — 22/22 live

- `failed_safe` (no side effect) + changed plan → new attempt allowed
  (re-confirmed unaffected by the rewrite).
- `outcome_uncertain` + changed plan → blocked,
  `409 unresolved_prior_billing_attempt` (re-confirmed unaffected).
- Uncertain operation reconciled `not_executed` (sole operation, no other
  side effects) → attempt reclassifies `safe_to_supersede` → new attempt
  allowed.
- Uncertain operation reconciled `succeeded` (sole operation) → attempt
  reclassifies `executed` → new attempt blocked via
  `PriorBillingAttemptExecutedError` → Approve recovers the job to
  `COMPLETED` from the existing attempt instead.
- Prior attempt with every operation `succeeded`, job not yet `COMPLETED`
  (the literal crash-before-write scenario) → Approve recovers directly to
  `COMPLETED`, **zero** new attempts, **zero** provider calls.
- Same fully-succeeded-attempt case with the commercial plan/fingerprint
  changed too → identical recovery — proves a changed plan does not undo
  an invoice that already happened.
- Partial mix (one operation `succeeded` with a real `external_object_id`,
  the other reconciled `not_executed`) → `409
  prior_billing_attempt_partially_executed`, job restored, **zero** new
  attempts — not casually superseded.

### Verification

`tsc`/`eslint` clean on all five touched files. `vitest run` — **1159
passed** (9 new classification tests), 89 skipped — full suite, not just
the new tests. RLS integration — unaffected (no schema change this round;
re-run for discipline, still 26/26). `npm run build` clean. Rulebook
re-confirmed unchanged (9 rules, allowlist unchanged) — no commercial or
provider-set expansion. Nothing in this round touched a migration.

## 17. Final state-integrity correction — executed ≠ current-plan-matches-executed-plan

§16's `'executed'` classification threw `PriorBillingAttemptExecutedError`
(recover to COMPLETED) for **any** prior attempt whose every operation
succeeded, regardless of whether the *current* commercial plan was the
one actually billed. A crash-recovery and a genuine post-billing contract
edit look identical under that classification alone — both are "prior
attempt executed" — but they demand opposite responses: the first must
recover silently; the second must never be silently presented as billed.

**A real, non-trivial correctness problem surfaced while proving this
live, not merely in review.** The obvious fix — compare the prior
attempt's stored `billing_plan_fingerprint` directly against the
fingerprint the current request just computed — is wrong, and live
testing caught it immediately (first attempt: the ordinary same-plan
crash-recovery case itself failed, misclassified as a plan change).
`fingerprintBillingPlan` deliberately encodes "what's due **right now**"
(`buildBillingPlanSnapshot` excludes anything `planned_invoices` already
has marked `sent`/`paid` — see §3). Once an attempt succeeds, its own
sends are exactly what get marked `sent` — so a freshly recomputed
fingerprint immediately after a real success excludes precisely what that
attempt just sent, and will differ from the attempt's own stored
fingerprint *purely because of its own success*, with no commercial data
having changed at all. A literal comparison would have misfired on every
real successful multi-step execution.

**Fix — reconstruct the counterfactual, not a raw comparison.**
`planComponentKeysInSnapshot` (`billing-execution-plan.ts`) converts a
stored snapshot's lines back into the date-keyed `planComponentKey` form
`alreadySentKeys` uses. `getOrCreateAttempt` now takes a caller-supplied
`recomputeFingerprintExcludingPriorSnapshot(priorSnapshot)` callback
(billing-writer.ts supplies it, since only the caller has `terms`/
`lineItems`/`evidence`/`vat`/`now`/`computeBillingSchedule`/the live
`alreadySentKeys` in hand). For a prior attempt classified `'executed'`,
the barrier calls it: rebuild `alreadySentKeys` minus that specific
attempt's own already-sent lines (i.e. "as if this attempt hadn't sent
them yet"), rebuild the snapshot from **current** commercial data against
that reduced set, and fingerprint it. This isolates "did the underlying
commercial data change" from "did this attempt's own success shrink the
queue" — a case a later attempt sending a *different, newly-due* period
never triggers (only attempts classified `'executed'` are found first in
the barrier's most-recent-first scan; see §16).

This is sound only because the two are equivalent under the same
serialization guarantee the whole barrier already relies on: since
`getOrCreateAttempt`'s partial unique index allows at most one
active attempt per (job, provider), and the barrier throws on the first
non-`safe_to_supersede` prior attempt found scanning newest-first,
"current global `alreadySentKeys` minus this attempt's own lines" and
"`alreadySentKeys` as they stood immediately before this attempt started"
are the same set — no other attempt could have sent anything in between.

- Same reconstructed fingerprint as the prior attempt's stored one →
  `PriorBillingAttemptExecutedError` (unchanged from §16) — recover to
  COMPLETED from the existing attempt, zero provider calls.
- Different → new `PriorBillingAttemptExecutedPlanChangedError`
  (`executedAttemptId`, `executedFingerprint`, `currentFingerprint`).
  `approve/route.ts` restores `claimedFrom`, returns `409
  billing_already_executed_plan_changed` with the executed attempt's id.
  Attempt A's own row (fingerprint, snapshot, operations) is never
  touched — both truths (what was actually billed vs. what the job
  currently believes should be billed) stay intact and queryable. No
  correction/reconciliation workflow was built (explicitly out of scope,
  per the round's own instruction).
- `'partially_executed'` unaffected — still blocks unconditionally,
  regardless of fingerprint, exactly as §16 established.

### Required tests (item 7) — 28/28 live

- Real full execution (genuine Stripe test-mode success, not synthetic)
  → job reset to non-COMPLETED (simulated crash) with the **same**
  current plan → automatic recovery to COMPLETED, zero new attempts.
- Same successful attempt + changed current plan → `409
  billing_already_executed_plan_changed`, zero new attempts, zero new
  Stripe customers (proven via a live `stripe.customers.list` count
  before/after), job restored to its pre-claim state, attempt A's own
  fingerprint/customer id provably untouched.
- Plan changed back to the **original** fingerprint → automatic recovery
  again, same recovered customer id — proves no rebilling occurred and
  the comparison isn't a one-way flag.
- Partial execution + a changed fingerprint → still `409
  prior_billing_attempt_partially_executed` (unaffected by this round).
- `failed_safe`/no side effects + changed fingerprint → new attempt still
  allowed (unaffected by this round).
- A reconciled-to-succeeded operation on an attempt with a **realistic,
  non-empty** stored snapshot (matching real `buildBillingPlanSnapshot`
  output, not `{}`) → classification/reconstruction runs without error
  and produces the correct block/recover outcome — closes the specific
  risk that a malformed or unexpectedly-shaped snapshot could crash the
  new reconstruction path.

### Verification

`tsc`/`eslint` clean on all six touched/new files
(`billing-execution-attempt.ts` unchanged this round;
`billing-execution-plan.ts`, `billing-execution-store.ts`,
`billing-writer.ts`, `approve/route.ts` touched). `vitest run` — **1159
passed**, 89 skipped — unchanged count, since this round's fix required
live-only verification (the affected logic reads real `planned_invoices`
state, not a pure function). RLS integration — unaffected, **25/25**
(no schema change). `npm run build` clean. Rulebook re-confirmed
unchanged (9 rules, allowlist unchanged) — no commercial or provider-set
expansion. Nothing in this round touched a migration.
