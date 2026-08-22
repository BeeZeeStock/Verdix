# Step 13 — OperationalEventEvidence: trusted evidence that a billability event occurred

Answers a structurally different question from Step 12's `BillabilityCondition`:
Step 12 established *what* the contract requires ("customer acceptance");
Step 13 establishes *whether that real-world event actually happened*. The
two stay independently auditable facts on purpose — see
`lib/operational-event-evidence.ts`'s module header.

## 1. Existing operational-state audit

Checked whether any existing persistence could safely represent "this
operational fact occurred":

| Table | What it actually represents | Fit for operational-event evidence? |
|---|---|---|
| `commercial_rule_interpretations` | Reviewer **interpretation** decisions (what the contract means) — its own header comment says so explicitly | No — different ontology (item 1 explicitly warns against this) |
| `contract_terms` (JSONB) | Extracted/reviewed commercial terms | No — mixing operational facts into commercial terms JSONB would make revocation/audit/uniqueness enforcement all application-level only |
| `sync_events` | Verdix's own SaaS billing sync accounting | No — unrelated domain (Verdix's own subscription usage, not a customer contract's fee) |
| `usage_ledger` | Verdix's own SaaS metering | No — same as above |
| `contract_meter_mappings` / usage-pull evidence | Usage-based metric mapping for overage billing | No — a different kind of "evidence" (metered quantities, not discrete occurrence facts) |

None fit. A new, minimal, dedicated table (`operational_event_evidence`,
`supabase/migrations/20260824000001_operational_event_evidence.sql`) was
introduced — the smallest structure that gives item 14 (no conflicting
active evidence) and item 12 (append-only/immutable) real database-level
guarantees, not just application-level discipline.

## 2. Subject identity decision (item 4)

No stable identifier existed for `OneTimeFee` before Step 13 — only
`fee_label`, already documented in Step 11 as collision-prone. Rather than
key the new evidence registry to that display string (compounding a known
risk), Step 13 adds `OneTimeFee.fee_id` (`lib/types.ts`), a UUID assigned
once, only for fees that genuinely enter the Step-12 lifecycle
(`lib/contract-extractor.ts`'s `normalizeBillabilityCondition`). This is
option **B** from the step's own item 4 (introduce a stable internal
component ID), not option A (embedding evidence inside the fee) — a real
table with a DB-level uniqueness constraint needed a real foreign key to
constrain against.

**Final amendment — resolved.** `fee_id` (and the fee's full reviewed
state) is now preserved across re-extraction via
`lib/rule-id-stability.ts`'s `preserveOneTimeFeeIdentity`, reusing the
EXACT same exact-description-text-match technique already established and
audited for `discount_rule_id`/`credit_rule_id` (`preserveStableRuleIds`,
same file) — never `fee_label`, never fuzzy matching. Wired into both
`execute/route.ts` and `audit/route.ts`, immediately after extraction,
mirroring the existing discount/credit call sites exactly.

**The chosen invariant**: a fee whose description matches a prior fee's
description EXACTLY inherits `fee_id` + its full reviewed state
(`amount_provenance`, `billability_provenance`, `billability_condition`,
`requires_confirmation`, `unresolved_kind`, `confirmation_reason`). A fee
whose description does not match exactly is treated as a new item: fresh
`fee_id`, fully-reset reviewed state. This is never silent — the old
`fee_id`'s evidence rows remain permanently, immutably queryable in
`operational_event_evidence` (nothing is deleted), simply no longer linked
to the current fee object, and the new fee cannot accept any new evidence
until a reviewer re-confirms its interpretation from scratch (the existing
`commercial_interpretation_unresolved` gate already requires this
regardless of re-extraction).

**Live-observed limitation, honestly reported**: a real back-to-back
re-extraction of the identical contract text produced two descriptions
differing by a single comma ("...implementation fee, billable..." vs
"...implementation fee billable...") — the exact-match failed, and the fee
was correctly (safely) treated as new rather than incorrectly matched.
This is not a Step 13 regression — it is the same fragility
`preserveStableRuleIds` has always had for discounts/credits, now also
observed for one-time fees. The system's SAFETY property (never silently
misattribute evidence to the wrong fee; always auditable) holds regardless
of this preservation-rate limitation. Per the final amendment's explicit
instruction not to invent heuristic/fuzzy matching, this was not "fixed" —
doing so would mean drifting from the same precedent this mechanism
deliberately, consistently follows.

## 3. Evidence provenance is not FieldProvenance (item 3)

`OperationalEventEvidenceSource` (`'reviewer_attestation' | 'trusted_system_event'`)
shares no member with `FieldProvenance`. `billability_provenance` answers
"why do we believe this is the contractual rule"; evidence `source`
answers "why do we believe the event occurred" — two independent
authorities, two independent audit facts, confirmed by adversarial test
(`lib/commercial-rule-status.test.ts`'s "evidence satisfaction never
mutates billability_condition/billability_provenance").

## 4. Future integration matrix (item 25 — not implemented, informational only)

| Event type | Likely future system | External event shape | Evidence fields Verdix needs |
|---|---|---|---|
| `contract_signature` | E-signature platform (DocuSign, Adobe Sign, PandaDoc) | Envelope/agreement completed webhook | `agreement_identifier` (external doc/envelope id) + `signed_at` |
| `delivery` | ERP / project-management system (Jira, Asana, Linear, an internal delivery tracker) | Deliverable/ticket marked complete | `deliverable_identifier` (ticket/component id) + `delivered_at` |
| `customer_acceptance` | CRM (Salesforce), a dedicated acceptance portal, or a support/ticketing system's "accepted" status | Opportunity/task state change, or an explicit customer acceptance action | `component_identifier` + `accepted_at` + `acceptance_status` |
| `final_acceptance` | Same as `customer_acceptance`, with an explicit interim-vs-final distinction | Same, plus a milestone-sequence marker | Same as `customer_acceptance` + `milestone_sequence_position` |
| `change_order_signature` | E-signature or contract-management system | Change Order document executed | `change_order_identifier` + `signed_at` |

Every row maps onto the SAME `OperationalEventEvidence` shape
(`lib/operational-event-evidence.ts`) via `source: 'trusted_system_event'`
— no `BillabilityCondition`/`BillabilityEventType` change needed to accept
these later. No writer for `trusted_system_event` exists yet; Step 13 ships
only the `reviewer_attestation` path.

## 5. Billing-writer adaptation (item 11)

`lib/billing-writer.ts`'s `configureStripe`/`configureRememhill` previously
partitioned one-time fees purely by the persisted `manual_trigger` flag.
Both now call the shared `isOneTimeFeeHeldForExecution`
(`lib/operational-event-evidence.ts`), which — for an event-conditioned fee
— computes the hold/execute decision FRESH from `billability_condition` +
real evidence every time, never trusting a persisted `manual_trigger`
value for that shape. `billability_condition`/`billability_provenance`/
`due_date` are never mutated when evidence is recorded (item 10) — this is
a pure execution projection, computed at the moment billing needs the
answer, not a rewrite of stored commercial semantics (item 11's explicit
instruction). Once evidence is satisfied, the fee's `due_date` stays `null`
(unchanged), which the connectors' existing `isDue = !feeDueDate || ...`
check already treats as immediately due — no new "bill now" representation
was invented.

## 6. The revoke-vs-billing race (final amendment, items 5-6)

**Audited boundary, before this amendment**: `execute_status` jumped
directly from a pre-approval value straight to `'COMPLETED'`, written only
*after* `configureBilling` (the real external Stripe/Remembill call)
already succeeded. No state marked "billing is currently underway." A
revoke request landing after the workload gate passed but before
`'COMPLETED'` was written would see the job's pre-approval status, correctly
flip evidence to `'revoked'`, and report success — while the external
invoice was created moments later regardless. This is the exact race item 5
describes; it was real, not hypothetical.

**Fix — the smallest deterministic guard, not a workflow engine**: a new
transitional `execute_status: 'APPROVING'`, claimed via a single
conditional `UPDATE ... WHERE execute_status <> 'APPROVING'`, written
*before* `configureBilling` is called (right after the readiness gate
passes). Two effects: (1) `revoke/route.ts` now also rejects
(`code: 'billing_in_progress'`, 409) whenever `execute_status = 'APPROVING'`,
not just `'COMPLETED'`; (2) as a direct, free consequence, two concurrent
Approve requests for the same job can no longer both reach
`configureBilling` — the second's conditional UPDATE affects zero rows and
the route returns 409 immediately. Live-verified: two truly concurrent
conditional-claim UPDATEs against the same job resolve to exactly one
success, deterministically (Postgres serializes the two statements).

**Item 6 — fresh re-check at the authoritative boundary**: immediately
before calling `configureBilling` (not reusing the evidence snapshot the
earlier readiness gate computed, which may by then be seconds stale),
`approve/route.ts` now re-queries `operational_event_evidence` and
re-runs `computeCommercialRuleWorkload` one more time. If anything changed
(most realistically, evidence revoked in the interim), the whole approval
aborts before any external call. (Original text said this aborted into
`execute_status: 'FAILED'` — corrected by Part C below: since no external
attempt has happened yet at this point, it now atomically restores the
job's real pre-claim state instead, never the ambiguous FAILED state.)
This narrows the remaining TOCTOU window to essentially the gap between
that final DB read and the external HTTP call itself — eliminating it
completely would need the external call to happen inside the same
transaction as the evidence read, which Stripe/Remembill's HTTP APIs
don't support; per the amendment's own "do not build a distributed
workflow engine" instruction, this residual, much-narrower window is the
accepted, explicitly-reported residual risk.

## 7. Part B — the APPROVING lifecycle itself (second final amendment)

**Superseded by Part C (section 9 below) on several specific points —
kept here as the historical record of what Part B actually decided, not
edited in place.** In particular: Part B's claim allowlist (4 states,
including `COMPLETED` and `FAILED`) is replaced by Part C's 2-state
allowlist; Part B's pre-effect failure handling (`execute_status:
'FAILED'`) is replaced by Part C's atomic restore-to-`claimedFrom`; Part
B's stuck-APPROVING recovery mechanism (`PATCH /api/jobs/[id]` with
`{execute_status:'FAILED'}`, admin-only, from `APPROVING` only) is
**unchanged and still correct** — it addresses a different scenario
(process crash while claiming) than Part C's `authorize-billing-retry`
(a completed, non-ambiguous-outcome FAILED attempt awaiting verified
retry), and the two now form a single recovery chain (see section 9).

The first amendment introduced `execute_status: 'APPROVING'` as a claim
mechanism but left its predicate, failure semantics, and recovery path
under-specified. Part B audits and closes each of those.

**Item 6 — the claim predicate, narrowed to an explicit allowlist.**
`.neq('execute_status', 'APPROVING')` (the original amendment's claim
condition) is broader than the real lifecycle — it would claim from
transient pipeline states (`PENDING`, `EXTRACTING`, `DETECTING_PII`,
`PENDING_PII_REVIEW`) that were never a legitimate Approve entry point.
The predicate is now `.in('execute_status', ['PENDING_HUMAN_REVIEW',
'READY_TO_APPROVE', 'COMPLETED', 'FAILED'])` — not an invented list: it is
the exact array `app/(dashboard)/configure/[id]/page.tsx` already uses in
two independent places (the poll-stop condition, and `isProcessing`) to
mean "this job is in a stable, actionable, non-processing state."
`PENDING_HUMAN_REVIEW` is included because the client's own promotion-to-
`READY_TO_APPROVE` PATCH is a separate, non-atomic call the Approve button
does not wait on. `COMPLETED` is included because a legitimate re-push of
an already-configured contract is real, existing behavior
(`wasAlreadyCompleted`). `FAILED` is included because it is this app's
only retry entry point — and is now also the landing state for the manual
recovery path below, so it must remain re-approvable.

**Item 7 — pre-effect failure never leaves a job stuck.** Audited: the
only thing in `approve/route.ts`'s `try` block before `configureBilling`
is the fresh evidence re-check, which returns its own explicit 400 (after
writing `execute_status: 'FAILED'`) directly — it never throws. So a
pre-effect failure was already correctly landing in `FAILED`, a state this
app's own code already treats as legitimately re-approvable (same array as
above). No code change was needed for this item beyond confirming it.

**Item 8 — the external-call boundary, audited for real idempotency, not
assumed.** Everything that reaches the generic `catch` block happens AT OR
AFTER `configureBilling()` — confirmed by the same trace as item 7.
Audited `lib/billing-writer.ts` directly: Stripe's `invoices.create` /
`invoiceItems.create` / `finalizeInvoice` carry **no idempotency key at
all** (only customer creation has a soft, name-based dedup search).
Remembill's invoice creation *does* send an `Idempotency-Key` header, but
it's built from `pushStamp = Date.now().toString(36)`, generated fresh on
every call to `configureRememhill` — so it does **not** protect a retry
from a second Approve request (a new `pushStamp` is a new key, which
Remembill won't recognize as a duplicate of the failed attempt); its row-
creation endpoint (`POST /invoices/:id/rows`) has no idempotency key at
any layer. Neither platform's write path is provably safe to blindly
retry. Per the amendment's "use the smallest existing failure/manual-
reconciliation state rather than pretending execution definitely failed,"
this stays `execute_status: 'FAILED'` — no new state invented — but the
error message is now explicit that billing may have partially executed
and must be verified against the platform before retrying, rather than
inviting an immediate reflexive retry.

**Item 9 — stuck-APPROVING recovery: explicit and manual, never
automatic.** A process crash between claiming `APPROVING` and reaching any
terminal state has no code path that runs to save it — confirmed no
automatic sweep/cron exists, and per item 8's idempotency finding, an
automatic timeout-retry would be actively unsafe (could create a duplicate
invoice). `app/api/jobs/[id]/route.ts`'s `PATCH` handler gains a second,
narrow, admin-gated transition: `{ execute_status: 'FAILED' }` is now
accepted, valid *only* when the job's current status is `APPROVING`,
requiring `requireOrg('admin')` (the same bar as Approve/Revoke — this is
billing-execution-adjacent, unlike the existing, lower-bar
`READY_TO_APPROVE` promotion). The final `UPDATE` re-asserts
`.eq('execute_status', 'APPROVING')` atomically, so a legitimate
completion racing a manual recovery attempt can never be overwritten (see
the concurrency proof below). This is deliberately a *reset*, not a
retry — the reviewer is expected to have checked Stripe/Remembill first;
the error message left on the job says so explicitly.

**Item 10 — concurrent Approve, verified at the database level.** Real
concurrent conditional-claim UPDATEs (two simultaneous `UPDATE jobs SET
execute_status='APPROVING' WHERE ... AND execute_status IN (allowlist)`
against the same row, issued via `Promise.all` against the live Supabase
project) resolved to exactly one winner, deterministically, across
repeated runs — Postgres serializes the two statements. The losing
request's 409 response now also carries `code: 'billing_in_progress'`,
matching revoke's existing convention, so a caller never has to
string-match the error message.

**Item 11 — revoke's behavior around this boundary is unchanged and still
correct**: `COMPLETED` → `billing_already_executed` (409); `APPROVING` →
`billing_in_progress` (409); anything else → proceeds normally, including
a job an admin has just manually recovered to `FAILED`.

**A newly-discovered, out-of-scope, pre-existing bug — reported, not
fixed.** While setting up real end-to-end HTTP verification for items 9
and 10, live testing of the `PATCH`/Approve routes intermittently failed
with `403 Access by invitation only` even for memberships proven to exist.
Root-caused (not assumed) via a series of debug routes: `lib/auth.ts`'s
Credentials `authorize()` callback calls `supabaseServer.auth.
signInWithPassword(...)` on the **shared, module-singleton, service-role
client** (`lib/supabase.ts`'s exported `supabaseServer`) rather than a
disposable client. Supabase-js attaches whatever session currently exists
on a client instance as the `Authorization` header for **all** subsequent
requests from that instance, regardless of `persistSession: false` — so
the moment *any* Credentials-provider login succeeds anywhere in the
process (a real user, or, in this investigation, a test script), every
later `supabaseServer.from(...)` call in that same Node process silently
downgrades from `service_role` to that user's `authenticated` role,
which has no grants on tables locked down to service-role-only
(`org_memberships`, `jobs`, `operational_event_evidence`, etc.) —
confirmed directly: `permission denied for table jobs`/`organizations`/
`org_memberships`, `hint: GRANT SELECT ... TO authenticated`. Restarting
the dev process clears it (a fresh singleton has no session yet) until the
next Credentials login. This is a real, severe, **pre-existing**
architectural issue completely unrelated to Step 13's evidence/subject/
race work — the fix (verify the password via a disposable client, or a
raw call to Supabase's Auth REST API, never the shared service-role
singleton) is out of scope for this amendment ("do not add integrations")
and deserves its own reviewed change. Live HTTP verification for items 9
and 10 was therefore completed via direct, concurrent service-role
database calls against the real Supabase project (bypassing the poisoned
Next.js process entirely) rather than through NextAuth session cookies —
this proves the exact same SQL-level atomicity the routes rely on, and the
routes' auth/ownership wiring itself is unchanged in structure from the
pattern already proven live via HTTP in earlier Step 13 rounds (before
this shared-singleton issue was understood).

## 8. `preserveOneTimeFeeIdentity` revised — reviewed-state preservation
was too broad (final amendment, Part B, item 12)

The first version of this function preserved `fee_id` AND every reviewed
field (`amount_provenance`, `billability_provenance`,
`billability_condition`, `requires_confirmation`, `unresolved_kind`,
`confirmation_reason`) together, unconditionally, whenever the
description matched exactly. This was too broad: a description match only
proves "same clause" — it does not prove the newly extracted `amount` or
`billability_condition` are still what a reviewer actually confirmed.
`lib/commercial-rule-status.ts`'s `isOneTimeFeeAmountUnresolved`/
`isOneTimeFeeBillabilityUnresolved` already treat these as two fully
independent axes; preservation now matches that split:

- `fee_id` always carries forward on a description match — this is
  contractual-clause identity, not a claim that its reviewed state still
  holds.
- The **amount axis** (`amount_provenance`, `requires_confirmation`,
  `unresolved_kind`, `confirmation_reason`) carries forward only when the
  newly extracted `amount` is numerically identical to what was reviewed.
- The **billability axis** (`billability_provenance`,
  `billability_condition`) carries forward only when the newly extracted
  condition is structurally identical (deep-equal) to what was reviewed.

**Changed-amount result**: fee_id preserved, amount axis resets (fresh
`amount_provenance`/`requires_confirmation` from the new extraction) —
the new number re-enters review; the billability axis is untouched if its
own condition didn't change.

**Changed-condition result**: fee_id preserved, billability axis resets —
the new condition re-enters review; the amount axis is untouched if the
amount didn't change. Evidence behavior falls out for free: since `fee_id`
still carries forward but the condition's `event_type` differs,
`resolveOperationalEventEvidence`'s own `subjectId` + `eventType` match
naturally stops matching the old evidence against the new condition — no
special-casing was added for this.

**Unchanged (both axes match) result**: full preservation, exactly as the
original invariant — the common case.

Five new tests in `lib/rule-id-stability.test.ts` cover the changed-amount,
changed-condition, and both-unchanged cases directly; the original "full
state forward" test's fixture was corrected to represent a genuine
identical re-extraction (previously it used `null` placeholders for the
fresh item's billability fields, which the revised, condition-aware logic
now correctly treats as a real difference rather than "not yet filled in").

## 9. Part C — the execution-state correction (third final amendment)

Part B's review exposed that `COMPLETED` and `FAILED` were both still
allowed to claim `APPROVING`, which is incompatible with a confirmed fact:
neither Stripe's nor Remembill's invoice-write calls are safely
repeatable (Part B, item 8's audit). Part C removes both.

**Item 1 — `COMPLETED` can never re-enter `APPROVING`, absolute.** This
removes a real, previously-existing capability: repushing an
already-`COMPLETED` job to sync edited terms (`RevenueModelTab`'s
`onRepush={handleApprove}`). Given the confirmed non-idempotency, that
capability could create a real duplicate invoice, so it is gone, not
preserved under a new guard. `approve/route.ts` returns `409 { code:
'billing_already_executed' }` and never claims `APPROVING` — live-verified:
a `COMPLETED` job hit with a normal Approve, and hit with two truly
concurrent Approves, produces zero `APPROVING` transitions in every case.

**Item 2 — `FAILED` no longer directly retries.** A `FAILED` job's prior
external outcome may be genuinely uncertain (see item 4 below), so a
normal Approve against it must not silently attempt billing again.
`approve/route.ts` returns `409 { code:
'billing_retry_requires_verification' }`. Live-verified: single and
concurrent-pair Approve attempts against a `FAILED` job both produce this
response, zero `APPROVING` transitions.

**Item 3 — pre-effect validation failure no longer lands in the ambiguous
`FAILED` state.** The claim is now made via two sequential, individually
atomic conditional `UPDATE`s (`PENDING_HUMAN_REVIEW` tried first, then
`READY_TO_APPROVE`) rather than one `.in()` — this is what lets the route
know, precisely, which real state a successful claim came from
(`claimedFrom`). If the fresh evidence re-check (item 6, section 6 above)
finds a blocker — the only failure that can happen before
`configureBilling` is ever called — the job is atomically restored to
`claimedFrom`, never `'FAILED'`. Two concurrent Approve requests still
resolve to exactly one winner overall, since each individual conditional
`UPDATE` remains a single atomic statement regardless of which candidate
value it targets. Live-verified two ways: (a) a direct replication of the
exact claim-then-restore operation pair, for both source states; (b) a
genuine timing race — evidence revoked via a raw update fired ~15ms into
a real Approve request — which landed exactly as required: `400`, no
`FAILED`, job restored to its real pre-claim `READY_TO_APPROVE`.

**Item 4 — external-attempt uncertainty still lands in `FAILED`, with the
explicit warning.** Unchanged from Part B (section 6 above): once
`configureBilling` has actually been called, a failure is genuinely
ambiguous (may have partially executed), so `FAILED` with the
"verify before retrying" message is correct and unchanged. Live-verified
via a deterministic, side-effect-free trigger — Remembill's own
currency-mismatch guard throws inside `configureBilling` with zero real
network calls — proving the claim succeeds first, then the catch block's
exact message and state.

**Item 5 — explicit admin recovery action, not a generic status
mutation.** New route: `POST /api/jobs/[id]/authorize-billing-retry`.
Deliberately its own endpoint, not an extra case in `PATCH
/api/jobs/[id]`'s generic `execute_status` field — a browser must never be
able to move a job from `FAILED` to `READY_TO_APPROVE` by submitting a
plain status value; the action's name states the real precondition and
risk. Requires `requireOrg('admin')`, current status `FAILED` exactly,
atomically re-asserted on the write (`.eq('execute_status', 'FAILED')`).
No body is accepted — there is nothing to submit; the admin is expected to
have verified the billing platform out of band before calling it. Audit
trail reuses existing infrastructure rather than adding a table or a raw
notes field: `jobs.error_message` is set to a fully system-generated
string embedding the admin's email (never user-typed text), and
`jobs.updated_at` is already trigger-maintained on every write
(`jobs_updated_at`, `supabase/migrations/20260626000000_verdix.sql`).
Live-verified: succeeds once from `FAILED`, correctly rejects a second
call once the job is no longer `FAILED`, and the very next Approve call
re-runs every check from scratch (re-hits the exact same deterministic
external-attempt failure in the test, proving nothing was cached from the
prior attempt).

**Item 6 — the final claim allowlist, justified from the Approve
lifecycle, not copied from a UI array.** `PENDING_HUMAN_REVIEW` and
`READY_TO_APPROVE` are the only two states in which a billing attempt has
legitimately never yet been made for the job's current configuration.
`COMPLETED` means one already succeeded (repush removed, item 1).
`FAILED` means one already happened with a possibly-uncertain outcome
(item 2). `APPROVING` means one is already in flight. Every earlier
pipeline state (`PENDING`/`EXTRACTING`/`DETECTING_PII`/
`PENDING_PII_REVIEW`) precedes `contract_terms` existing at all, so
Approve's own upstream `if (!terms)` check already fails closed for those
regardless of the claim predicate.

**Item 7 — concurrency, re-verified against the corrected predicate.**
Live-verified, all via real HTTP against the running dev server (not
simulated): `READY_TO_APPROVE` + two concurrent Approves → exactly one
non-409, the loser carries `billing_in_progress`; `COMPLETED` + two
concurrent Approves → zero winners, both `billing_already_executed`;
`FAILED` + two concurrent Approves → zero winners, both
`billing_retry_requires_verification`.

**Item 8 — revoke boundaries, unchanged and re-confirmed.**
`operational-events/revoke/route.ts` needed no code change: `COMPLETED` →
`billing_already_executed`, `APPROVING` → `billing_in_progress`, and
`FAILED` already fell through to "revocation allowed" (the "before
APPROVING" case), which remains correct — a `FAILED` job's evidence can
still be corrected before an admin authorizes a retry. Retry authorization
itself (item 5) touches nothing evidence-related; the next Approve call
re-fetches and re-evaluates `operational_event_evidence` entirely from
scratch, exactly like every other Approve call, so authorization never
implies stale evidence is still valid.

**Item 9 — tests.** All of the above were proven via real HTTP against the
running dev server (route handlers still cannot be imported into vitest —
established constraint) rather than committed as permanent vitest files
for the route-level behavior specifically; the throwaway verification
script was deleted after the run per this project's established pattern.
26/26 checks passed, including the live timing race for item 3.

**Separate prerequisite — the auth-client-isolation fix.** Discovered
while first setting up this round's live verification: `lib/auth.ts`'s
Credentials `authorize()` called `.auth.signInWithPassword()` on the
shared, module-singleton `supabaseServer` client, which silently attached
that end-user's session to it — downgrading every later query on that
same instance from `service_role` to `authenticated` for the rest of the
process. Fixed by using a fresh, disposable `createServerClient()` for the
one-off password check instead, and committed **separately**
(`eb61daea`, `fix: isolate Supabase auth from service-role client`) before
this round's Step 13 work, per instruction, with its own regression tests
(`lib/auth-client-isolation.test.ts`: a fast unit check that
`createServerClient()` never returns the shared singleton, plus a gated
live test proving two real, interleaved Credentials logins on the same
server process never interfere with each other or with
`operational_event_evidence`'s RLS lockdown). All of this round's live
Step 13 HTTP verification ran cleanly against the corrected auth path with
no contamination-related failures.
