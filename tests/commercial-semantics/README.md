# Commercial-semantics regression corpus

Step 1 of the Rulebook initiative: freeze the normalized commercial-rule
semantics Verdix already handles correctly, so a future Rulebook
schema/resolver can be checked against this same corpus rather than
silently drifting from today's approved behavior.

**No production behavior changed to produce this corpus.** Every test here
calls real, already-shipped, already-exported pure functions from `lib/`
(no route handlers, no database, no AI calls). Nothing in `lib/` or `app/`
was modified to make these tests pass.

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
                        caps, explicit no-cash language, + the full generic
                        Service Credit example fixture
                        (service-credit-example.test.ts)
  discounts/            light — discount readiness + tier_method mapping
  partial-periods/      billing-period anchor ambiguity, calendar vs.
                        contract_start proration
  recurrence/           one-time vs. recurring, consecutive-window streaks,
                        complete-unit ("per complete hour") semantics
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

## Known gaps surfaced while writing this corpus

Reported per Step 1's instruction to surface rather than silently patch —
none of the three were patched; no calculation, extraction prompt,
readiness logic, or UI code was changed to write this corpus.

1. **`CreditEarnRule.trigger_comparator`** (`lib/types.ts`) supports only
   `'gt' | 'gte'`. An availability/SLA-style "below threshold" trigger has
   no native `<` comparator — `credits/service-credit-example.test.ts`
   models it as a logical complement (unavailability ≥ the complementary
   threshold), which requires a caller to compute that complement. No such
   caller exists in production yet for this credit shape.
2. **Complete-unit ("per complete hour") rounding** has no dedicated
   utility. `evaluateCreditEarn` takes `measuredTriggerQuantity` verbatim
   and does not floor it — `recurrence/recurrence.test.ts` documents the
   expected calling convention (caller floors before invoking) but this is
   not yet enforced or exercised by any real production call site.
3. **`ServiceCreditInterpretation.cash_redeemable`** (`lib/types.ts`) is a
   plain boolean with no companion provenance field — unlike
   `eligible_component_keys`/`carry_forward`, which carry
   `eligibility_provenance`/`survival_provenance`. Verified by reading the
   real code: `confirm-rule/route.ts`'s `buildServiceCreditInterpretation`
   (`typeof approved.cash_redeemable === 'boolean' ? approved.cash_redeemable
   : existing?.cash_redeemable ?? false`) and the extraction prompt
   (`lib/rule-interpretation.ts`'s `buildServiceCreditPrompt`: "cash_redeemable
   defaults to false unless ... explicitly says") both collapse "explicitly
   stated false" and "the contract never addressed this at all" into the
   identical value, with no way to distinguish them downstream. This corpus
   asserts only the explicit case (`credits/credits.test.ts`, "explicit
   no-cash language resolves cash_redeemable: false") and deliberately does
   **not** freeze "silence → false" as approved baseline semantics.

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
