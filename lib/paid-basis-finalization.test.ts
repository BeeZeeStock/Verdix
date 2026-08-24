import { describe, it, expect } from 'vitest'
import { isMonetaryBasisRecognitionApplicable, isPaidBasisFinalizationApplicable, canFreezeMonetaryBasisEarn } from './paid-basis-finalization'

// Contract B's real Annual Rebate shape — 3.5% of transaction-processing
// fees actually paid, calculated within 30 days after Contract Year end.
// monetary_basis_recognition is the sole trusted signal for "paid" — never
// credit_basis type alone (2026-08-30 correction).
const REBATE_INTERP = {
  credit_basis: 'pct_of_affected_component' as const,
  basis_component: 'transaction-processing fees actually paid for that Contract Year',
  monetary_basis_recognition: 'paid' as const,
  monetary_basis_recognition_provenance: 'contract_derived' as const,
  earn_rule: { paid_basis_finalization_policy: null, paid_basis_finalization_provenance: null },
}

describe('isMonetaryBasisRecognitionApplicable', () => {
  it('applies to any percentage-of-component credit, regardless of what monetary_basis_recognition ends up being', () => {
    expect(isMonetaryBasisRecognitionApplicable(REBATE_INTERP)).toBe(true)
    expect(isMonetaryBasisRecognitionApplicable({ ...REBATE_INTERP, monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })).toBe(true)
  })
  it('does not apply to a flat/usage-based credit basis', () => {
    expect(isMonetaryBasisRecognitionApplicable({ ...REBATE_INTERP, credit_basis: 'flat_amount' })).toBe(false)
  })
  it('does not apply when there is no basis_component', () => {
    expect(isMonetaryBasisRecognitionApplicable({ ...REBATE_INTERP, basis_component: null })).toBe(false)
  })
  it('applies for pct_of_period_fee just as it does for pct_of_affected_component', () => {
    expect(isMonetaryBasisRecognitionApplicable({ ...REBATE_INTERP, credit_basis: 'pct_of_period_fee' })).toBe(true)
  })
})

describe('isPaidBasisFinalizationApplicable — 2026-08-30 correction: keyed on monetary_basis_recognition, never credit_basis type alone', () => {
  it('A/B: applies for Contract B — monetary_basis_recognition resolved to "paid"', () => {
    expect(isPaidBasisFinalizationApplicable(REBATE_INTERP)).toBe(true)
  })
  it('C: does NOT apply when monetary_basis_recognition is "component_amount" — this is the exact conflation the correction fixes', () => {
    expect(isPaidBasisFinalizationApplicable({ ...REBATE_INTERP, monetary_basis_recognition: 'component_amount', monetary_basis_recognition_provenance: 'contract_derived' })).toBe(false)
  })
  it('D: does NOT apply when monetary_basis_recognition is unresolved (unclear/null/no provenance) — a percentage-of-component credit_basis alone is no longer sufficient evidence of "paid"', () => {
    expect(isPaidBasisFinalizationApplicable({ ...REBATE_INTERP, monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })).toBe(false)
    expect(isPaidBasisFinalizationApplicable({ ...REBATE_INTERP, monetary_basis_recognition: 'unclear', monetary_basis_recognition_provenance: null })).toBe(false)
  })
  it('a bare "paid" value with no provenance never applies — AI confidence is not provenance, same discipline as every other field', () => {
    expect(isPaidBasisFinalizationApplicable({ ...REBATE_INTERP, monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: null })).toBe(false)
  })
  it('still applies with no finalization_deadline_days stated — the completeness question is not conditional on a stated deadline (prior correction, preserved)', () => {
    expect(isPaidBasisFinalizationApplicable(REBATE_INTERP)).toBe(true) // finalization_deadline_days is no longer part of this predicate at all
  })
})

describe('canFreezeMonetaryBasisEarn', () => {
  it('B: Contract B, unresolved paid_basis_finalization_policy — never freeze', () => {
    expect(canFreezeMonetaryBasisEarn(REBATE_INTERP)).toBe(false)
  })
  it('B: Contract B, deadline_cutoff resolved — freeze permitted', () => {
    expect(canFreezeMonetaryBasisEarn({
      ...REBATE_INTERP, earn_rule: { ...REBATE_INTERP.earn_rule, paid_basis_finalization_policy: 'deadline_cutoff' },
    })).toBe(true)
  })
  it('full_attribution is a resolved decision but still never permits freezing (no invoice-terminality model)', () => {
    expect(canFreezeMonetaryBasisEarn({
      ...REBATE_INTERP, earn_rule: { ...REBATE_INTERP.earn_rule, paid_basis_finalization_policy: 'full_attribution' },
    })).toBe(false)
  })
  it('C: component_amount never permits freezing — no verified execution path today, never silently treated as paid', () => {
    expect(canFreezeMonetaryBasisEarn({
      ...REBATE_INTERP, monetary_basis_recognition: 'component_amount', monetary_basis_recognition_provenance: 'contract_derived',
      earn_rule: { ...REBATE_INTERP.earn_rule, paid_basis_finalization_policy: 'deadline_cutoff' }, // even if somehow set, must not matter
    })).toBe(false)
  })
  it('D: unresolved monetary_basis_recognition never permits freezing — fails closed rather than guessing payment behavior', () => {
    expect(canFreezeMonetaryBasisEarn({ ...REBATE_INTERP, monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })).toBe(false)
    expect(canFreezeMonetaryBasisEarn({ ...REBATE_INTERP, monetary_basis_recognition: 'unclear', monetary_basis_recognition_provenance: null })).toBe(false)
  })
  it('a credit the question does not apply to at all is never gated by it — the deadline-wait mechanism alone governs', () => {
    expect(canFreezeMonetaryBasisEarn({ ...REBATE_INTERP, credit_basis: 'flat_amount' })).toBe(true)
  })
})
