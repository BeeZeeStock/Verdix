import { describe, it, expect } from 'vitest'
import { buildCreditEarnRule } from './credit-earn-rule'
import type { CreditEarnRule } from './types'

const EXISTING: CreditEarnRule = {
  trigger_metric_key: 'processed_transactions', trigger_quantity: 1_800_000, trigger_comparator: 'gt',
  trigger_window: 'contract_year', consecutive_windows_required: 1, window_anchor: 'contract_start',
  finalization_deadline_days: 30, quantity_treatment: 'exact',
  paid_basis_finalization_policy: null, paid_basis_finalization_provenance: null,
  requires_confirmation: false, confirmation_reason: null,
}
const REBATE_CONTEXT = {
  creditBasis: 'pct_of_affected_component', basisComponent: 'transaction-processing fees actually paid for that Contract Year',
  monetaryBasisRecognition: 'paid' as const, monetaryBasisRecognitionProvenance: 'contract_derived' as const,
}

describe('buildCreditEarnRule — paid-basis finalization', () => {
  it('A: a fresh confirmation with no policy submitted stays unresolved and requires confirmation', () => {
    const result = buildCreditEarnRule({}, EXISTING, REBATE_CONTEXT)
    expect(result?.paid_basis_finalization_policy).toBeNull()
    expect(result?.paid_basis_finalization_provenance).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('B/H: choosing deadline_cutoff with reviewer_policy provenance resolves and clears requires_confirmation', () => {
    const result = buildCreditEarnRule(
      { earn_rule: { paid_basis_finalization_policy: 'deadline_cutoff' } },
      EXISTING,
      REBATE_CONTEXT,
      'reviewer_policy',
    )
    expect(result?.paid_basis_finalization_policy).toBe('deadline_cutoff')
    expect(result?.paid_basis_finalization_provenance).toBe('reviewer_policy')
    expect(result?.requires_confirmation).toBe(false)
  })

  it('E: choosing full_attribution is a resolved decision (requires_confirmation clears) even though it is not executable', () => {
    const result = buildCreditEarnRule(
      { earn_rule: { paid_basis_finalization_policy: 'full_attribution' } },
      EXISTING,
      REBATE_CONTEXT,
      'reviewer_policy',
    )
    expect(result?.paid_basis_finalization_policy).toBe('full_attribution')
    expect(result?.paid_basis_finalization_provenance).toBe('reviewer_policy')
    expect(result?.requires_confirmation).toBe(false)
  })

  it('never accepts a client-asserted organization_rulebook provenance for this field (no resolution path exists)', () => {
    const result = buildCreditEarnRule(
      { earn_rule: { paid_basis_finalization_policy: 'deadline_cutoff' } },
      EXISTING,
      REBATE_CONTEXT,
      'organization_rulebook',
    )
    expect(result?.paid_basis_finalization_provenance).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('the question never applies to a credit with no percentage-of-component basis — requires_confirmation stays false regardless', () => {
    const nonPaidExisting: CreditEarnRule = { ...EXISTING, finalization_deadline_days: null }
    const result = buildCreditEarnRule({}, nonPaidExisting, { creditBasis: 'flat_amount', basisComponent: null, monetaryBasisRecognition: null, monetaryBasisRecognitionProvenance: null })
    expect(result?.requires_confirmation).toBe(false)
  })

  // 2026-08-30 correction — a percentage-of-component credit whose
  // monetary_basis_recognition is NOT resolved to 'paid' (unclear, or
  // 'component_amount') must never require the paid-basis-finalization
  // decision at all — that question only exists once the basis is known
  // to be paid. This is the exact conflation the correction fixes: before
  // it, credit_basis type alone was sufficient to require this decision.
  it('requires_confirmation stays false when monetary_basis_recognition is unresolved — the paid-basis-finalization question does not even apply yet', () => {
    const result = buildCreditEarnRule({}, EXISTING, { creditBasis: 'pct_of_affected_component', basisComponent: 'x', monetaryBasisRecognition: null, monetaryBasisRecognitionProvenance: null })
    expect(result?.requires_confirmation).toBe(false)
  })
  it('requires_confirmation stays false when monetary_basis_recognition is component_amount — this question is not the mechanism that blocks that case', () => {
    const result = buildCreditEarnRule({}, EXISTING, { creditBasis: 'pct_of_affected_component', basisComponent: 'x', monetaryBasisRecognition: 'component_amount', monetaryBasisRecognitionProvenance: 'contract_derived' })
    expect(result?.requires_confirmation).toBe(false)
  })

  it('F: resolving paid-basis-finalization never touches the source-derived trigger/deadline fields', () => {
    const result = buildCreditEarnRule(
      { earn_rule: { paid_basis_finalization_policy: 'deadline_cutoff' } },
      EXISTING,
      REBATE_CONTEXT,
      'reviewer_policy',
    )
    expect(result?.trigger_metric_key).toBe('processed_transactions')
    expect(result?.trigger_quantity).toBe(1_800_000)
    expect(result?.trigger_comparator).toBe('gt')
    expect(result?.trigger_window).toBe('contract_year')
    expect(result?.finalization_deadline_days).toBe(30)
  })

  it('a later, unrelated confirm on this same credit never downgrades an already-resolved decision back to unresolved', () => {
    const alreadyResolved: CreditEarnRule = { ...EXISTING, paid_basis_finalization_policy: 'deadline_cutoff', paid_basis_finalization_provenance: 'reviewer_policy' }
    const result = buildCreditEarnRule({}, alreadyResolved, REBATE_CONTEXT)
    expect(result?.paid_basis_finalization_policy).toBe('deadline_cutoff')
    expect(result?.paid_basis_finalization_provenance).toBe('reviewer_policy')
    expect(result?.requires_confirmation).toBe(false)
  })
})
