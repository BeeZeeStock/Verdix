import { describe, it, expect } from 'vitest'
import { buildServiceCreditInterpretation } from './service-credit-interpretation'

// End-to-end fresh-contract regression (2026-08-30 follow-up audit, Part 5)
// — stronger than a unit test of the regex alone. buildServiceCreditInterpretation
// is the actual function used at persistence time: confirmed by trace/grep
// to be the ONLY place a ServiceCreditInterpretation is ever constructed
// anywhere in this codebase (lib/contract-extractor.ts deliberately never
// populates `interpretation` at raw extraction — its own prompt says so
// explicitly). That means this test exercises the real, sole normalization
// boundary, not a stand-in for it.
describe('buildServiceCreditInterpretation — fresh Contract-B-style persistence, existing=null', () => {
  // Exactly what a reviewer's first-ever "Confirm & apply" on Contract B's
  // Annual Rebate submits — the AI's proposed_interpretation, echoed back
  // by RuleInterpretationCard's confirm handler. No prior interpretation
  // exists for this credit yet (existing = null), simulating the true
  // first-persistence moment for a freshly extracted, never-before-
  // reviewed credit.
  const freshRebateSubmission = {
    trigger_type: 'usage_threshold',
    trigger_description: 'Customer records more than 1,800,000 Processed Transactions during a Contract Year',
    credit_basis: 'pct_of_affected_component',
    basis_component: 'transaction-processing fees actually paid for that Contract Year',
    credit_value: 3.5,
    source_clause: 'If Customer records more than 1,800,000 Processed Transactions during a Contract Year, Customer earns a rebate equal to 3.5% of the transaction-processing fees actually paid for that Contract Year.',
    earn_rule: {
      trigger_metric_key: 'processed_transactions', trigger_quantity: 1_800_000, trigger_comparator: 'gt',
      trigger_window: 'contract_year', window_anchor: 'contract_start', consecutive_windows_required: 1,
      finalization_deadline_days: 30,
    },
    application_rule: {
      eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees'],
      computed_from_component_keys: ['transaction_processing_fees'],
      excluded_component_keys: ['chargeback_fees', 'one_time_fees', 'taxes', 'previously_applied_credits'],
      one_time: false, carry_forward: true,
    },
  }

  it('derives monetary_basis_recognition=paid/contract_derived on the VERY FIRST persistence — no prior state, no reviewer click on this field specifically', () => {
    const result = buildServiceCreditInterpretation(freshRebateSubmission, null)
    expect(result.monetary_basis_recognition).toBe('paid')
    expect(result.monetary_basis_recognition_provenance).toBe('contract_derived')
    // Sanity: the rest of the interpretation was constructed as expected
    // from the same single submission — proving this isn't a separate pass.
    expect(result.credit_basis).toBe('pct_of_affected_component')
    expect(result.basis_component).toBe('transaction-processing fees actually paid for that Contract Year')
  })

  it('the newly-derived monetary basis immediately makes paid-basis-finalization applicable (Decision Required), without a second confirm', () => {
    const result = buildServiceCreditInterpretation(freshRebateSubmission, null)
    expect(result.earn_rule?.paid_basis_finalization_policy).toBeNull()
    expect(result.earn_rule?.requires_confirmation).toBe(true) // Decision Required, immediately
  })

  it('a second, later confirm on the SAME credit (existing now populated) preserves the already-derived monetary basis unchanged, even if resubmitted text looks different', () => {
    const first = buildServiceCreditInterpretation(freshRebateSubmission, null)
    const second = buildServiceCreditInterpretation(
      { ...freshRebateSubmission, basis_component: 'platform_fee', source_clause: 'invoiced amount' }, // hypothetically different/regressed text
      first,
    )
    expect(second.monetary_basis_recognition).toBe('paid')
    expect(second.monetary_basis_recognition_provenance).toBe('contract_derived')
  })

  it('the generic underspecified "10% of platform fee" scenario stays unclear on its own first persistence — never guessed paid just because a fresh credit is being confirmed for the first time', () => {
    const result = buildServiceCreditInterpretation({
      trigger_type: 'sla_breach', credit_basis: 'pct_of_period_fee', basis_component: 'platform_fee',
      credit_value: 10, source_clause: null,
      earn_rule: { trigger_metric_key: 'platform_availability', trigger_quantity: 99.5, trigger_comparator: 'lt', trigger_window: 'calendar_month', window_anchor: 'calendar', consecutive_windows_required: 1, finalization_deadline_days: null },
      application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true },
    }, null)
    expect(result.monetary_basis_recognition).toBeNull()
    expect(result.monetary_basis_recognition_provenance).toBeNull()
  })
})
