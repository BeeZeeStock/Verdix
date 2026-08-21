# Commercial-semantics regression corpus

Step 1 of the Rulebook initiative: freeze the normalized commercial-rule
semantics Verdix already handles correctly, so a future Rulebook
schema/resolver can be checked against this same corpus rather than
silently drifting from today's approved behavior.

**Step 1 (baseline):** every test called real, already-shipped, already-
exported pure functions from `lib/` — no route handlers, no database, no AI
calls, and no production code was modified to make the tests pass. Three
real engine gaps were found and reported rather than silently patched (see
`git log` for the Step 1 commit).

**Step 1.5 (this pass):** closed all three gaps as deliberate, reviewed
production-model changes — `lib/types.ts`, `lib/credit-ledger.ts`,
`lib/commercial-rule-status.ts`, `confirm-rule/route.ts`,
`lib/rule-interpretation.ts` (prompts + `validateProposalState`), and the
review UI in `configure/[id]/page.tsx` were all updated; see that commit's
message for the full change list, call-site audit, and backwards-
compatibility strategy. This corpus was updated in lockstep so the
previously-documented workarounds became native, passing tests — see
"Gaps closed in Step 1.5" below. Same-period application execution
(`CreditApplicationRule.availability`) was deliberately NOT touched — still
a documented capability limitation, addressed only when the Rulebook
vocabulary is designed.

## Why field names don't match the Step 1 prompt's examples

The Step 1 request illustrated assertions like `rule.calculation_method`,
`rule.minimum.type`, `rule.application.timing` — an aspirational,
Rulebook-shaped API. Building that shape now would itself be "adding a
Rulebook," which Step 1 explicitly defers. Every test in this corpus
instead asserts against **today's real field names** (`tier_calculation
.method`, `minimum_commitment.mode`, `application_rule.availability`, …) as
defined in `lib/types.ts`. When the Rulebook resolver is built, its output
gets mapped to this same corpus's fixtures/expectations — the corpus
doesn't need to change shape to do that; only a thin adapter would.

## Layers

Most cases exercise more than one layer against the same fixture:

- **A — Normalized rule.** Did Verdix represent the contract semantics
  correctly? Asserted as fixed field values on a fixture (frozen,
  hand-verified against real extracted/confirmed data where noted), not a
  live AI call.
- **B — Readiness/provenance.** Given that normalized rule, does Verdix
  correctly identify which fields are resolved vs. block on review? Calls
  the real predicates (`isProvenanceResolved`, `isServiceCreditUnresolved`,
  `isMinimumCommitmentModeUnresolved`, `isDiscountUnresolved`,
  `computeCommercialRuleWorkload`, `buildCreditApplicationRule`).
- **C — Calculation.** Given a fully resolved rule, does the deterministic
  billing engine produce the expected amount? Calls the real calculation
  functions (`computeMetricOverage`, `computeTransactionalOverage`,
  `resolveWindowMinimum`, `computeMinimumCommitmentSchedule`,
  `evaluateCreditEarn`, `filterEligibleComponents`,
  `computeRequestedCreditApplication`).

## Structure

```
tests/commercial-semantics/
  all-units/          volume/all-units vs. graduated tier pricing
  minimum-floor/       floor vs. additive; no row-duplication multiply
  credits/             basis vs. scope, timing/survival independence,
                        future-amounts-payable, explicit carry-forward,
                        caps, three-way provenanced cash redeemability,
                        + the full generic Service Credit example fixture
                        (service-credit-example.test.ts) — now natively
                        represented, no comparator workaround
  discounts/            light — discount readiness + tier_method mapping
  partial-periods/      billing-period anchor ambiguity, calendar vs.
                        contract_start proration
  recurrence/           one-time vs. recurring, consecutive-window streaks,
                        complete-unit ("per complete hour") semantics —
                        natively enforced via quantity_treatment
  provenance/           the canonical 4-state readiness matrix
```

Conceptually, each case documents:

```ts
{
  name,                    // the `it(...)` description
  normalizedInput,         // the fixture / function arguments
  expectedSemantics,       // Layer A assertions
  expectedUnresolvedFields,// Layer B assertions
  expectedCalculation,     // Layer C assertions, where applicable
}
```

not literally as a data object — as plain `describe`/`it` blocks per this
codebase's existing test convention (`lib/*.test.ts`), so the corpus stays
a normal, fast, deterministic vitest suite rather than a second bespoke
runner.

## Gaps closed in Step 1.5

All three gaps Step 1 surfaced are now closed as native engine behavior —
each corpus case that used to document a workaround now exercises the real
fix directly:

1. **Comparator vocabulary** — `CreditEarnRule.trigger_comparator` now
   supports `'gt' | 'gte' | 'lt' | 'lte' | 'eq'` (was `'gt' | 'gte'` only),
   evaluated deterministically inside `evaluateCreditEarn`.
   `credits/service-credit-example.test.ts`'s availability trigger is now
   `trigger_metric_key: 'platform_availability', trigger_comparator: 'lt',
   trigger_quantity: 99.5` — natively representing "availability < 99.5%",
   no logical-complement inversion. `lib/credit-ledger.test.ts` has the
   full lt/lte/gt/gte/eq exact-boundary matrix.
2. **Complete-unit rounding** — `CreditEarnRule.quantity_treatment`
   (`'exact' | 'complete_units'`, optional, defaults to `'exact'`) is now
   applied INSIDE `evaluateCreditEarn` itself, for both the threshold
   comparison and the per-unit amount — never left to the caller.
   `recurrence/recurrence.test.ts`'s complete-hour case no longer pre-floors
   with `Math.floor()`; the engine does it. Generic across units (hours,
   days, ...) — never hardcoded to "hours".
3. **Cash-redeemability provenance, and the readiness/semantics split it
   required** — `ServiceCreditInterpretation.cash_redeemable` is now
   `boolean | 'unclear'` with a companion `cash_redeemable_provenance?:
   FieldProvenance`, reusing the exact same provenance discipline as
   `CreditApplicationRule.eligibility_provenance`/`survival_provenance` —
   no bespoke cash-only mechanism. Explicit false → `contract_derived`;
   explicit true → `contract_derived`; silence → `'unclear'` with no
   provenance — never a silent default, and never backfilled as
   `contract_derived` for historical records.

   Critically, **this fact is semantic metadata, not a universal readiness
   blocker.** `lib/commercial-rule-status.ts`'s `isServiceCreditUnresolved`
   takes an `ServiceCreditExecutionContext` (`'invoice_credit' |
   'cash_settlement'`, defaulting to `'invoice_credit'` — today's only real
   execution path) and asks, via `requiredServiceCreditFields(context)`,
   whether cash treatment is actually load-bearing for *that* execution —
   not merely whether Verdix happens to know the answer. Applying a credit
   against a future invoice never needs to know whether cash payout would
   be allowed, so an unresolved/missing `cash_redeemable_provenance` does
   NOT block the default context, does not reopen already-configured
   billing rules, and is shown in the review/confirmed-rule UI as
   informational metadata ("Not specified in contract" / "Cash settlement:
   Not specified in contract") rather than a red "Decision required" card.
   A hypothetical `'cash_settlement'` execution context — which does not
   exist as a real code path today — DOES require it, and unresolved cash
   treatment blocks there; see `credits/credits.test.ts`'s "cash
   redeemability" block for the full matrix (unclear/explicit-false/
   explicit-true/verdix_recommends all non-blocking for `invoice_credit`;
   unresolved blocks under `cash_settlement`; a fully-resolved
   `cash_redeemable: true` still can't actually execute cash payout today —
   a capability gap, not a semantics gap, tested separately from provenance
   resolution). `lib/commercial-rule-status.test.ts` has the matching
   `isServiceCreditUnresolved`/`requiredServiceCreditFields` matrix.

## Current execution capability limitations

Distinct from the gaps above — these are not incorrect semantics, they are
things the engine cannot yet EXECUTE even when the contract is perfectly
clear about them. The commercial-semantics invariant remains: **application
timing must follow the source; Verdix must never infer same-period or
future-period timing when the contract is silent on it.** If a future
contract explicitly specifies same-invoice application, the correct
response is an execution/readiness limitation surfaced to the reviewer —
never silently reinterpreting the contract as future-period to fit what the
engine can currently do.

- **`CreditApplicationRule.availability`** (`lib/types.ts`) is typed as the
  single literal `'next_period'` — there is no same-period ("apply against
  the current invoice") execution path at all today, regardless of what any
  given contract's source text says. `credits/credits.test.ts`'s "current
  execution capability" block asserts this narrow structural fact only —
  it does not claim next-period is the semantically correct reading of any
  particular contract, and does not claim the engine ever actually consults
  source text to decide timing (it doesn't; the value is fixed).
