// Freezes the credit/rebate primitives: calculation basis vs. application
// scope are independent questions; "next invoice" timing never implies a
// carry-forward answer; "future amounts payable" establishes scope/timing
// but never indefinite survival; explicit carry-forward language resolves
// to a concrete, contract_derived survival policy; caps bind the
// calculated credit in its stated window; cash redeemability is a
// three-way, provenanced fact (explicit true/false vs. genuinely unstated)
// — never a silent default. Exercises the real lib/credit-application-
// rule.ts + lib/credit-ledger.ts + lib/commercial-rule-status.ts engine —
// no AI calls.
import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import { filterEligibleComponents, computeRequestedCreditApplication, evaluateCreditEarn } from '@/lib/credit-ledger'
import { isServiceCreditUnresolved, isProvenanceResolved, requiredServiceCreditFields } from '@/lib/commercial-rule-status'
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

// Step 1.5, corrected: cash_redeemable is a three-way, provenanced fact
// (ServiceCreditInterpretation.cash_redeemable: boolean | 'unclear', with a
// companion cash_redeemable_provenance — same FieldProvenance discipline as
// CreditApplicationRule's eligibility_provenance/survival_provenance), but
// it is deliberately NOT a universal readiness blocker. Semantic
// completeness (does Verdix know the contract's answer?) is a separate
// question from execution readiness (does the execution path Verdix is
// actually running need that answer?) — requiredServiceCreditFields draws
// that line. Today's only real execution path, invoice_credit, never needs
// to know whether cash payout would be allowed; a hypothetical
// cash_settlement path would.
describe('cash redeemability — three-way provenanced fact, never a silent default, but not a universal readiness blocker', () => {
  const resolvedApplicationRule = { computed_from_component_keys: null, eligible_component_keys: 'all' as const, excluded_component_keys: [], one_time: false, carry_forward: true, availability: 'next_period' as const, requires_confirmation: false, confirmation_reason: null }

  it('cash "unclear" (contract silent) does not block ordinary invoice-credit execution — the default context', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: 'unclear', cash_redeemable_provenance: null, requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(interp.cash_redeemable).toBe('unclear')
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(false)
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp }, 'invoice_credit')).toBe(false)
  })
  it('explicit "will not be paid in cash" resolves false, contract_derived, and does not block invoice-credit execution', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: false, cash_redeemable_provenance: 'contract_derived', requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(interp.cash_redeemable_provenance).toBe('contract_derived')
    expect(isProvenanceResolved(interp.cash_redeemable_provenance)).toBe(true)
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(false)
  })
  it('explicit "may be paid in cash" resolves true, contract_derived, and does not block invoice-credit execution — a supported execution needs no further decision', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: true, cash_redeemable_provenance: 'contract_derived', requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(interp.cash_redeemable_provenance).toBe('contract_derived')
    expect(isProvenanceResolved(interp.cash_redeemable_provenance)).toBe(true)
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(false)
  })
  it('cash choice required for execution but unresolved — blocks, once the execution context that actually needs it is asked', () => {
    // requiredServiceCreditFields('cash_settlement') includes cash_redeemable —
    // this is the shape a future cash-payout execution path would check
    // against, standing in for "the reviewer requested cash settlement" /
    // "org policy specifies cash settlement" until such a path is real.
    expect(requiredServiceCreditFields('cash_settlement')).toContain('cash_redeemable')
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: 'unclear', cash_redeemable_provenance: null, requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp }, 'cash_settlement')).toBe(true)
  })
  it('a Verdix recommendation for cash_redeemable (verdix_recommends) does not block invoice-credit execution, but still does not resolve a cash_settlement execution either — a proposed value is never treated as a confirmed one', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: false, cash_redeemable_provenance: 'verdix_recommends', requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(false)
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp }, 'cash_settlement')).toBe(true)
  })
  it('reviewer confirmation of a silent contract persists as reviewer_policy — resolves both the default context (already non-blocking) and a cash_settlement context', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: false, cash_redeemable_provenance: 'reviewer_policy', requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp })).toBe(false)
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp }, 'cash_settlement')).toBe(false)
  })
  // "Cash required but downstream platform cannot execute it" is a distinct
  // failure mode from "the contract's answer is unresolved" — it's an
  // execution-CAPABILITY gap (Verdix knows the contract's answer, or the
  // question is even moot, but no code path exists to actually pay cash
  // out), analogous to the existing Remembill-representation capability
  // check pattern elsewhere in this codebase. Nothing in this codebase
  // builds a real cash-settlement execution path today — this test pins
  // that structural fact down (a "current execution capability limitation",
  // same category as CreditApplicationRule.availability's single
  // 'next_period' literal) rather than letting a future contributor
  // fabricate a fake contract interpretation (e.g. quietly forcing
  // cash_redeemable: false) to route around the missing capability.
  it('current execution capability limitation — even a fully-resolved, explicit cash_redeemable: true has no execution path that can actually pay cash out; this must surface as a capability gap, never a fabricated contract answer', () => {
    const interp: Pick<ServiceCreditInterpretation, 'cash_redeemable' | 'cash_redeemable_provenance' | 'requires_confirmation' | 'application_rule'> = {
      cash_redeemable: true, cash_redeemable_provenance: 'contract_derived', requires_confirmation: false,
      application_rule: resolvedApplicationRule,
    }
    // The contract's answer is fully resolved either way...
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: interp }, 'cash_settlement')).toBe(false)
    // ...but no 'cash_settlement' execution context is a real, callable path
    // anywhere in this codebase (CreditApplicationRule.availability is
    // structurally fixed to 'next_period' — see credits.test.ts's "current
    // execution capability" block). A resolved contract fact is not the
    // same claim as "Verdix can act on it" — that gap is what a future
    // execution-capability check (in the spirit of
    // getCreditRepresentationCapability) would need to report, not this
    // provenance predicate.
    expect(resolvedApplicationRule.availability).toBe('next_period')
  })
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
