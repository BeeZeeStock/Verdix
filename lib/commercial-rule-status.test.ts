import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, type CommercialRuleTerms } from './commercial-rule-status'

describe('computeCommercialRuleWorkload — "all confirmed" must check every rule type (regression)', () => {
  it('minimum commitment, tier calculation, escalator, and meter mapping all confirmed but a discount is NOT: never all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
        { unit_type: 'api_call', rate_per_unit: 2, minimum_commitment: { requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
      ],
      escalators: [{ interpretation: { requires_confirmation: false, treatment: 'applies' } }],
      discounts: [{ discount_rule_id: 'disc1', interpretation: null }],
      service_credits: [],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 1, confirmed: 1 })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.totalToConfirm).toBeGreaterThan(0)
  })

  it('everything (including the discount) confirmed and meter mapping done: all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
      ],
      escalators: [{ interpretation: { requires_confirmation: false, treatment: 'applies' } }],
      discounts: [{ discount_rule_id: 'disc1', interpretation: { requires_confirmation: false } }],
      service_credits: [{ credit_rule_id: 'cred1', interpretation: { requires_confirmation: false } }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 1, confirmed: 1 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.totalToConfirm).toBe(0)
  })

  it('commercial rules confirmed but meter mapping still pending: ready_for_billing_configuration, not all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
      ],
      escalators: [],
      discounts: [],
      service_credits: [],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 1, confirmed: 0 })
    expect(workload.status).toBe('ready_for_billing_configuration')
  })

  it('an unresolved interaction alone blocks all_commercial_rules_confirmed even with every individual rule confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [],
      escalators: [],
      discounts: [{ discount_rule_id: 'disc1', interpretation: { requires_confirmation: false } }],
      service_credits: [{ credit_rule_id: 'cred1', interpretation: { requires_confirmation: false } }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 1)
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.interactionsToConfirm).toBe(1)
  })

  it('a contract with no commercial rules at all is trivially confirmed', () => {
    const workload = computeCommercialRuleWorkload({ overage_tiers: [], escalators: [], discounts: [], service_credits: [] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  // scenario: TEST-PAY-002 — a flat-fee-only ambiguity (the platform fee's
  // partial-period treatment) with zero usage-based tiers at all must still
  // block "all confirmed"; base_fee_proration is a job-level field, not
  // tier-scoped, so it needs its own check independent of overage_tiers.
  it('an unresolved base_fee_proration alone blocks all_commercial_rules_confirmed, even with no overage tiers', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [], escalators: [], discounts: [], service_credits: [],
      base_fee_proration: { requires_confirmation: true },
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.totalToConfirm).toBe(1)
  })

  it('a confirmed base_fee_proration does not block all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [], escalators: [], discounts: [], service_credits: [],
      base_fee_proration: { requires_confirmation: false },
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('an unresolved proration on an additional recurring fee blocks all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [], escalators: [], discounts: [], service_credits: [],
      additional_recurring_fees: [{ fee_label: 'Support retainer', amount: 3_100, proration: { requires_confirmation: true } }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.totalToConfirm).toBe(1)
  })
})
