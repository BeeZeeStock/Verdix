import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, type CommercialRuleTerms } from './commercial-rule-status'
import type { FixedFeeBillingTimingRule, VariableInvoiceTimingRule } from './types'

// Step 17F.5, item 6 — proves the two Step 17F.3 timing rules
// (fixed_fee_billing_timing, variable_invoice_timing) surface and clear as
// two genuinely INDEPENDENT blockers, not a single combined gate: resolving
// one must never silently resolve or hide the other. Pure — no DB needed,
// computeCommercialRuleWorkload takes plain CommercialRuleTerms.
const unresolvedFixed: FixedFeeBillingTimingRule = { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'x', source_clause: null }
const resolvedFixed: FixedFeeBillingTimingRule = { timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'x' }
const unresolvedVariable: VariableInvoiceTimingRule = { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'x', source_clause: null }
const resolvedVariable: VariableInvoiceTimingRule = { timing: 'invoice_at_next_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'x' }

function fixture(fixedTiming: FixedFeeBillingTimingRule, variableTiming: VariableInvoiceTimingRule): CommercialRuleTerms {
  return {
    base_monthly_fee: 2000,
    fixed_fee_billing_timing: fixedTiming,
    additional_recurring_fees: [{
      fee_label: 'Performance share',
      percentage_of_basis: { rate_schedule: { bands: [] }, derived_metric: {}, basis_input_key: 'x' },
      variable_invoice_timing: variableTiming,
    }],
  } as unknown as CommercialRuleTerms
}

describe('fixed_fee_billing_timing / variable_invoice_timing surface as independent blockers (Step 17F.5)', () => {
  it('both unresolved -> exactly 2 blockers, not all_commercial_rules_confirmed', () => {
    const w = computeCommercialRuleWorkload(fixture(unresolvedFixed, unresolvedVariable), { total: 0, confirmed: 0 })
    expect(w.blockers).toContain('fixed_fee_billing_timing')
    expect(w.blockers).toContain('variable_invoice_timing:Performance share')
    expect(w.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('fixed timing confirmed only -> variable timing blocker remains, still not Ready', () => {
    const w = computeCommercialRuleWorkload(fixture(resolvedFixed, unresolvedVariable), { total: 0, confirmed: 0 })
    expect(w.blockers).not.toContain('fixed_fee_billing_timing')
    expect(w.blockers).toContain('variable_invoice_timing:Performance share')
    expect(w.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('variable timing confirmed only -> fixed timing blocker remains, still not Ready', () => {
    const w = computeCommercialRuleWorkload(fixture(unresolvedFixed, resolvedVariable), { total: 0, confirmed: 0 })
    expect(w.blockers).toContain('fixed_fee_billing_timing')
    expect(w.blockers).not.toContain('variable_invoice_timing:Performance share')
    expect(w.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('both confirmed -> both timing blockers clear', () => {
    const w = computeCommercialRuleWorkload(fixture(resolvedFixed, resolvedVariable), { total: 0, confirmed: 0 })
    expect(w.blockers).not.toContain('fixed_fee_billing_timing')
    expect(w.blockers).not.toContain('variable_invoice_timing:Performance share')
    expect(w.status).toBe('all_commercial_rules_confirmed')
  })
})
