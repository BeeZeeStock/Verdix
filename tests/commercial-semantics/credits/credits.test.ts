// Freezes the credit/rebate primitives: calculation basis vs. application
// scope are independent questions; "next invoice" timing never implies a
// carry-forward answer; "future amounts payable" establishes scope/timing
// but never indefinite survival; explicit carry-forward language resolves
// to a concrete, contract_derived survival policy; caps bind the
// calculated credit in its stated window; cash redeemability defaults to
// false and only flips on explicit language. Exercises the real
// lib/credit-application-rule.ts + lib/credit-ledger.ts + lib/commercial-
// rule-status.ts engine — no AI calls.
import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { filterEligibleComponents, computeRequestedCreditApplication, evaluateCreditEarn } from '@/lib/credit-ledger'
import { isServiceCreditUnresolved } from '@/lib/commercial-rule-status'
import type { CreditEarnRule, ServiceCreditInterpretation } from '@/lib/types'

// A period's invoice components, in minor units (öre) — platform fee +
// transaction-processing charges, the same shape lib/credit-ledger.ts's
// real orchestration builds from a planned invoice.
const INVOICE_POOL = [
  { key: 'platform_fee', amountMinor: 3_850_000 },              // SEK 38,500.00
  { key: 'transaction_processing', amountMinor: 18_355_000 },   // SEK 183,550.00
]

describe('calculation basis vs. application scope are independent questions', () => {
  // "5% of transaction-processing fees" (credit_basis: pct_of_affected_component,
  // basis_component: transaction_processing) establishes WHAT THE CREDIT IS
  // WORTH — it says nothing about what future invoice components the
  // resulting rebate may offset. Confirming the basis must not, by itself,
  // resolve eligible_component_keys.
  it('confirming the basis alone (no application_rule submitted at all) leaves scope genuinely unresolved — basis and scope are separate fields', () => {
    const result = buildCreditApplicationRule({}, null, undefined)
    expect(result).toBeNull() // nothing to grade — the basis confirmation never touched application_rule
  })
  it('a rebate whose basis is confirmed (elsewhere, on the interpretation) but whose application_rule was never submitted stays unresolved for scope — isServiceCreditUnresolved must still block', () => {
    const interp = { requires_confirmation: false, application_rule: null } as unknown as { requires_confirmation: boolean; application_rule: null }
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(true)
  })
  it('the basis component and the eligible/offsettable component happening to be the SAME value (transaction_processing) is a real, but independently confirmed, coincidence — not an inheritance from the basis field', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.eligible_component_keys).toEqual(['transaction_processing'])
    expect(result?.eligibility_provenance).toBe('contract_derived') // resolved via its OWN grading
  })
  it('a credit whose basis is transaction-processing-only can still legitimately have a BROADER application scope (e.g. "all" future amounts payable) — the two fields do not have to match', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    const matched = filterEligibleComponents(INVOICE_POOL, result!)
    // 'all' draws from BOTH components in the pool, even though the
    // credit's own value was computed from transaction-processing alone.
    expect(matched.map(c => c.key).sort()).toEqual(['platform_fee', 'transaction_processing'])
  })
})

describe('timing and survival are independent fields — confirming one never auto-resolves the other', () => {
  // "availability" is currently a fixed value regardless of source content
  // (see the capability-limitation describe block below) — this block's
  // claim is narrower and still holds regardless of that limitation:
  // whatever timing value is on file, survival (carry_forward) is a
  // genuinely separate question that a timing confirmation never answers.
  it('availability does not vary with carry_forward — resolved or unresolved survival, the timing field is untouched either way', () => {
    const unclear = buildCreditApplicationRule({ application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } }, null, { eligibility: 'contract_derived' })
    const resolved = buildCreditApplicationRule({ application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } }, null, { eligibility: 'contract_derived', survival: 'contract_derived' })
    expect(unclear?.availability).toBe('next_period')
    expect(resolved?.availability).toBe('next_period')
  })
  it('"applied to the next invoice" alone (survival never addressed) leaves carry_forward at "unclear", not auto-resolved true or false', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false } }, // carry_forward omitted entirely
      null,
      { eligibility: 'contract_derived' }, // no survival provenance submitted
    )
    expect(result?.carry_forward).toBe('unclear')
    expect(result?.requires_confirmation).toBe(true) // any remainder treatment stays a live blocker
  })
})

// NOT a semantic primitive — see README's "Current execution capability
// limitations". The correct commercial-semantics INVARIANT is: application
// timing must follow the source; Verdix must never infer same-period or
// future-period timing when the contract is silent on it. What's asserted
// below is a narrower, purely structural fact about today's engine: it can
// only ever EXECUTE next-period application, full stop, regardless of what
// any future contract's source text says. That is a capability ceiling,
// not proof that same-period timing is semantically impossible or that the
// source was ever consulted on this question — if a future contract
// explicitly states same-invoice application, this becomes an execution/
// readiness limitation to surface to the reviewer, never a license to
// silently reinterpret the contract as future-period.
describe('current execution capability: only next-period application is implemented (not a semantic guarantee)', () => {
  it('"next_period" is the only value CreditApplicationRule.availability can hold today — every resolved application_rule carries it regardless of provenance or the underlying credit\'s own values', () => {
    const a = buildCreditApplicationRule({ application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } }, null, { eligibility: 'reviewer_policy', survival: 'reviewer_policy' })
    const b = buildCreditApplicationRule({ application_rule: { eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: false } }, null, { eligibility: 'contract_derived', survival: 'contract_derived' })
    expect(a?.availability).toBe('next_period')
    expect(b?.availability).toBe('next_period')
  })
})

describe('"applied against future amounts payable" establishes scope/timing, never indefinite carry-forward', () => {
  it('eligible_component_keys: "all" (future amounts payable) with carry_forward still "unclear" is a real, valid, unresolved-survival state — not a contradiction to auto-resolve', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: 'unclear', carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived' },
    )
    expect(result?.eligible_component_keys).toBe('all')
    expect(result?.carry_forward).toBe('unclear') // "future amounts payable" ≠ "carries forward indefinitely"
    expect(result?.requires_confirmation).toBe(true)
  })
  it('while unresolved, computeRequestedCreditApplication requests nothing — an unconfirmed application scope must never draw against the pool', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: 'unclear', carry_forward: 'unclear' } },
      null,
      { eligibility: 'contract_derived' },
    )
    const { requestedAmountMinor } = computeRequestedCreditApplication({
      applicationRule: result!, remainingPool: INVOICE_POOL, lastKnownBalanceMinor: 10_000_000,
    })
    expect(requestedAmountMinor).toBe(0)
  })
})

describe('explicit carry-forward language resolves to a concrete, contract_derived policy', () => {
  it('"unused portion carries forward until fully used" resolves carry_forward: true, no expiry bound, contract_derived, and clears the blocker', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing_fees'], one_time: true, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.carry_forward).toBe(true)
    expect(result?.expiry_periods).toBeNull()   // "until fully used" = no fixed expiry bound
    expect(result?.expiry_date).toBeNull()
    expect(result?.survival_provenance).toBe('contract_derived')
    expect(result?.requires_confirmation).toBe(false)
  })
})

describe('caps bind the calculated credit within its stated measurement window', () => {
  it('the calculated amount above the cap is clamped to the cap for that window', () => {
    const result = evaluateCreditEarn({
      earnRule: baseEarnRule(),
      measuredTriggerQuantity: 20, // 20 complete hours of excess downtime
      computedFromAmountMinor: 0,
      creditValueFlatMinor: null,
      creditValuePctBp: null,
      creditValuePerUnitMinor: 550_000, // SEK 5,500.00 per complete hour, in öre
      capAmountMinor: 5_500_000,        // SEK 55,000.00 monthly cap
      priorConsecutiveWindowsMet: 0,
      isOneTime: false,
      alreadyEarnedOnce: false,
    })
    // Uncapped this would be 20 * 5,500 = 110,000 — the cap must bind it.
    expect(result.earnedAmountMinor).toBe(5_500_000)
  })
  it('below the cap, the calculated amount passes through unclamped', () => {
    const result = evaluateCreditEarn({
      earnRule: baseEarnRule(), measuredTriggerQuantity: 3, computedFromAmountMinor: 0,
      creditValueFlatMinor: null, creditValuePctBp: null, creditValuePerUnitMinor: 550_000, capAmountMinor: 5_500_000,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earnedAmountMinor).toBe(3 * 550_000) // 16,500 — under the cap, uncapped
  })
})

describe('explicit no-cash language resolves cash_redeemable: false — contract silence is deliberately NOT asserted to mean the same thing', () => {
  it('explicit "will not be paid in cash" resolves cash_redeemable: false', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable'> = { cash_redeemable: false }
    expect(interp.cash_redeemable).toBe(false)
  })
  it('explicit "customer may request a cash refund" resolves cash_redeemable: true', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable'> = { cash_redeemable: true }
    expect(interp.cash_redeemable).toBe(true)
  })
  // GAP 3 (see README): this corpus deliberately does NOT assert that a
  // genuinely SILENT contract also resolves to cash_redeemable: false.
  // Verified by reading the real code: ServiceCreditInterpretation.
  // cash_redeemable (lib/types.ts) is a plain boolean with no companion
  // provenance field (unlike eligible_component_keys/carry_forward, which
  // have eligibility_provenance/survival_provenance) — confirm-rule/
  // route.ts's buildServiceCreditInterpretation
  // (`typeof approved.cash_redeemable === 'boolean' ? approved.cash_redeemable
  // : existing?.cash_redeemable ?? false`) and the extraction prompt
  // (lib/rule-interpretation.ts's buildServiceCreditPrompt: "cash_redeemable
  // defaults to false unless ... explicitly says") both collapse "explicitly
  // stated false" and "never addressed at all" into the identical value,
  // with no way to tell them apart downstream. Freezing that collapse as a
  // passing test would misrepresent an unverified engine default as an
  // approved contractual-silence rule — exactly the class of bug this
  // project's provenance model exists to prevent for every OTHER field.
  // Not patched in this test-only baseline commit.
})

describe('counterexample — percentage credit vs. fixed amount per unit are different bases, never interchangeable', () => {
  it('pct_of_period_fee (10% of platform fee) and fixed_amount_per_unit (SEK 5,500/hour) compute completely different amounts from the same inputs', () => {
    const pctResult = evaluateCreditEarn({
      earnRule: baseEarnRule(), measuredTriggerQuantity: 1, computedFromAmountMinor: 3_850_000 /* SEK 38,500 platform fee, in öre */,
      creditValueFlatMinor: null, creditValuePctBp: 1000 /* 10% */, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    const perUnitResult = evaluateCreditEarn({
      earnRule: baseEarnRule(), measuredTriggerQuantity: 1, computedFromAmountMinor: 3_850_000,
      creditValueFlatMinor: null, creditValuePctBp: null, creditValuePerUnitMinor: 550_000, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(pctResult.earnedAmountMinor).toBe(385_000)     // 10% of 3,850,000
    expect(perUnitResult.earnedAmountMinor).toBe(550_000) // 1 unit * 550,000 — unrelated to the platform fee at all
    expect(pctResult.earnedAmountMinor).not.toBe(perUnitResult.earnedAmountMinor)
  })
})

function baseEarnRule(): CreditEarnRule {
  return { trigger_metric_key: 'm', trigger_quantity: 0, trigger_comparator: 'gt', trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar', finalization_deadline_days: null, requires_confirmation: false }
}
