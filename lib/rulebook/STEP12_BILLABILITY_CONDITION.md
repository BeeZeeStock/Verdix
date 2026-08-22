# Step 12 — BillabilityCondition: the smallest reusable billability-trigger primitive

Introduces a normalized answer to "what does the agreement say must happen
before this fee becomes billable?" — closing the specific gap Step 11C's
live acceptance pass found: `"payable upon signing"` nondeterministically
collapsed into either `due_date: null` or `due_date: <effective_date>`,
because Verdix had no representation for a contractual *event* distinct
from a calendar date. Not a milestone-scheduling subsystem, not a
project-management integration — a single closed type
(`lib/types.ts`'s `BillabilityCondition`) plus the pure functions that
operate on it (`lib/billability-condition.ts`).

## Domain model

```ts
type BillabilityEventType =
  | 'contract_signature' | 'delivery' | 'customer_acceptance'
  | 'final_acceptance' | 'change_order_signature'

type BillabilityCondition =
  | { kind: 'immediate' }
  | { kind: 'fixed_date'; date: string }
  | { kind: 'event'; event_type: BillabilityEventType }
```

`billability_provenance` (unchanged from Step 11) continues to be the
single provenance field for this decision — Step 12 does not add
per-condition provenance. `condition = customer_acceptance` +
`provenance = reviewer_policy` means "a reviewer confirmed that customer
acceptance is the contractual billability condition," never "customer
acceptance has occurred."

## Two distinct readiness questions (item 5)

1. **Semantic readiness** — is `billability_condition` represented and is
   `billability_provenance` resolved? Answered by
   `isOneTimeFeeUnresolved`/`isOneTimeFeeBillabilityUnresolved`
   (`lib/commercial-rule-status.ts`), unchanged mechanism from Step 11.
2. **Execution readiness** — can Verdix act on the condition right now?
   Answered by `getBillabilityExecutionCapability`
   (`lib/billability-condition.ts`). `immediate`/`fixed_date` are always
   executable; `event` never is yet — represented as a NEW
   `RequiredOperationalEventMissingBlocker` in `executionBlockers`,
   deliberately distinct from `UnsupportedCommercialSemanticsBlocker`
   (the contractual meaning IS understood; only real-world evidence is
   missing).

A resolved `event` condition therefore still blocks Approve — via the
operational-evidence blocker, not via an unresolved reviewer decision, and
never via `unsupported_semantics` (which stays reserved for conditions the
closed 5-event ontology genuinely cannot represent at all — deemed
acceptance, retention splits; still out of scope, per items 12–13).

## The lifecycle discriminator — never `manual_trigger` (final amendment)

Three rounds of correction landed on the current rule, kept here so the
reasoning isn't lost to git history alone:

1. **First draft** (wrong): `if (fee.manual_trigger) return fee` as the
   normalizer's first check. A fee where the model emitted BOTH
   `manual_trigger: true` AND a real `billability_condition` skipped the
   closed-union parser entirely — the enforcement boundary was never even
   reached.
2. **Second draft** (still wrong): removed the `manual_trigger` check, but
   used `rawCondition === undefined` alone to mean "legacy" — conflating a
   genuinely historical *persisted* record (never re-run through
   `normalizeBillabilityCondition` at all) with a *fresh* extraction where
   the model simply omitted the key. The latter has, by construction, been
   evaluated by the Step-12 pipeline just now; "the model didn't answer" is
   never itself evidence of anything, least of all intentional
   manual/discretionary billing.
3. **Final rule**: `normalizeBillabilityCondition` (`lib/contract-extractor.ts`)
   runs on every fresh extraction result and, for anything without a valid
   parsed condition, canonicalizes `billability_condition` to `null`
   (evaluated, unresolved) — *except* one narrow, structural, non-`manual_trigger`
   exemption: `isExistingVariableRateFeeShape` (same file) — `metric_name`
   populated, a positive `rate_per_unit`, and no positive fixed `amount`.
   This is the pre-existing, unrelated variable/per-unit professional-services
   pricing mechanism, which Step 12's ontology was never meant to normalize
   in the first place — not "manual billing, therefore exempt." The
   exemption only applies when the raw key is genuinely absent
   (`rawCondition === undefined`); an explicit `null` or a malformed answer
   on an otherwise variable-rate-shaped fee still canonicalizes to `null`,
   since the model *attempted* to engage the fee under Step-12 semantics.

`billability_condition === undefined` is therefore reserved exclusively
for (a) a genuinely historical record that has never passed through
`normalizeBillabilityCondition`, and (b) the narrow shape exemption — a
persistence/shape distinction, never a "the model didn't answer"
distinction. Re-extracting a historical fee runs it through the same fresh
pipeline as any other extraction; the legacy exemption does not follow the
`fee_label` across a real re-extraction.

## Future operational-evidence matrix (item 26)

No event-ingestion system is built in Step 12. This is what a future
evidence-ingestion layer would need per event type — informational only.

| event_type | Future evidence needed | Likely source system(s) | Minimum evidence shape |
|---|---|---|---|
| `contract_signature` | Confirmation the agreement was actually executed | E-signature platform (DocuSign, Adobe Sign, PandaDoc), or manual ops attestation | `{ signed_at: timestamp, agreement_identifier: string }` |
| `delivery` | Confirmation the deliverable/service was delivered | Project-management tool (Jira, Asana, Linear), shipping/logistics system, or manual ops attestation | `{ delivered_at: timestamp, deliverable_identifier: string }` |
| `customer_acceptance` | Explicit customer sign-off | Customer acceptance portal, e-signature platform, CRM (Salesforce) opportunity/task state, or a support/ticketing system's "accepted" status | `{ acceptance_status: 'accepted' \| 'rejected', accepted_at: timestamp, deliverable_identifier: string }` |
| `final_acceptance` | Same as `customer_acceptance`, but for the specific milestone the contract designates as FINAL (distinguishing it from an earlier interim acceptance already evidenced separately) | Same as `customer_acceptance`, plus a way to distinguish "final" from "interim" milestones on the same fee sequence | `{ acceptance_status: 'accepted' \| 'rejected', accepted_at: timestamp, milestone_sequence_position: 'interim' \| 'final' }` |
| `change_order_signature` | Confirmation a specific Change Order document was executed | E-signature platform, contract-management system | `{ signed_at: timestamp, change_order_identifier: string }` |

Common shape across all five: a status/timestamp pair plus an identifier
tying the evidence back to the specific fee/deliverable — never raw
customer communications or free text, consistent with this codebase's
existing "no raw source text in structured metadata" discipline
(`UnsupportedCommercialSemanticsBlocker`/`RequiredOperationalEventMissingBlocker`'s
own `reason` fields).

## `milestone.delivery_ne_acceptance` — status after Step 12 (item 21)

Stays `status: 'validated'` — **not promoted**. The semantic-model gap that
previously blocked promotion (`lib/rulebook/rule-candidates.ts`'s original
rationale: "no normalized acceptance-event field exists") is now closed —
`delivery` and `customer_acceptance` are distinct, structurally separate
`BillabilityEventType` values, and the live Sonnet verification below
confirms the model assigns them correctly, including the Case F
counterexample (an explicit "delivery constitutes acceptance" clause
normalizes to `event_type: 'delivery'`, not a generic collapsed value).

The candidate is now **technically activatable** in a future step: it
would need a new `ruleClass: 'anti_inference'` `evaluate()` function
(`lib/rulebook/rules.ts`) operating on a new `CommercialSemanticContext`
domain slice for `billability_condition` (none exists yet — today's 9
active rules have no such slice), plus wiring into
`lib/rulebook/context.ts` and the shadow/activation resolvers. That
integration work is deliberately not done in Step 12 — the modeling
primitive and the Rulebook integration are separate pieces of work, and
Step 12's scope is only the former.

## Live Sonnet verification (item 25)

Six controlled live Bedrock/Sonnet runs (Cases A–F) plus three independent
repeats of Case A to test determinism specifically — see the Step 12
report for full captured output. Summary:

- **A** ("payable upon signing") → `event/contract_signature`, `due_date:
  null`, 3/3 identical across independent repeats — the Step 11C
  nondeterminism is closed.
- **B** ("becomes billable upon customer acceptance") → `event/customer_acceptance`.
- **C** ("becomes billable upon delivery") → `event/delivery`.
- **D** ("becomes billable on 15 October 2026") → `fixed_date`, `date:
  "2026-10-15"`, `due_date` consistently mirrored.
- **E** ("payable immediately") → `immediate`.
- **F** (explicit "delivery shall constitute acceptance" counterexample) →
  `event/delivery` — the contract's own stated equivalence, not a generic
  collapsed rule.

## Scope boundaries (unchanged, per the step spec)

No milestone scheduling, no project-management integration, no
retention/deemed-acceptance ontology, no Global Rulebook rule activated, no
Organization Rulebook expansion, no event-ingestion system. `manual_trigger`
remains an execution PROJECTION (`projectBillabilityConditionToExecutionFields`),
never the canonical contractual meaning.
