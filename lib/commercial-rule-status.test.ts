import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, isMinimumCommitmentModeUnresolved, isMinimumCommitmentProrationUnresolved, isServiceCreditUnresolved, isDiscountUnresolved, type CommercialRuleTerms } from './commercial-rule-status'

describe('computeCommercialRuleWorkload — "all confirmed" must check every rule type (regression)', () => {
  it('minimum commitment, tier calculation, escalator, and meter mapping all confirmed but a discount is NOT: never all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
        { unit_type: 'api_call', rate_per_unit: 2, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
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
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
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
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
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

  // VAT is kept as its own bucket (vat.configured), same treatment as
  // meterMapping — never folded into totalToConfirm, since it's a plain
  // user-provided operational input, not a contract-derived rule.
  it('unresolved VAT alone blocks all_commercial_rules_confirmed, even with every other rule and meter mapping confirmed', () => {
    const terms: CommercialRuleTerms = { overage_tiers: [], escalators: [], discounts: [], service_credits: [] }
    const workload = computeCommercialRuleWorkload(terms, { total: 1, confirmed: 1 }, 0, new Set(), { configured: false })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.vat.configured).toBe(false)
    // Deliberately NOT counted in totalToConfirm — VAT stays a separate
    // bucket a caller adds in on top, exactly like meterMapping.
    expect(workload.totalToConfirm).toBe(0)
  })

  it('VAT configured, everything else confirmed: all_commercial_rules_confirmed', () => {
    const terms: CommercialRuleTerms = { overage_tiers: [], escalators: [], discounts: [], service_credits: [] }
    const workload = computeCommercialRuleWorkload(terms, { total: 1, confirmed: 1 }, 0, new Set(), { configured: true })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('defaults vat.configured to true when the caller omits it entirely — no regression for pre-existing callers', () => {
    const workload = computeCommercialRuleWorkload({ overage_tiers: [], escalators: [], discounts: [], service_credits: [] }, { total: 0, confirmed: 0 })
    expect(workload.vat.configured).toBe(true)
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

  // scenario: TEST-PAY-002's real transaction-processing minimum —
  // "transaction_processing_charge = max(all_units_calculated_charge,
  // 66,000) for each calendar month." mode/amount/period are all explicit
  // and there is no included allowance for this metric (no zero-rate
  // tier) — only the partial first calendar month's treatment is genuinely
  // open. Extraction's own requires_confirmation flag conflated both
  // questions (it was forced true purely by the partial-period gap), which
  // used to make an unrelated "how does the minimum interact with the
  // allowance" card appear despite there being no allowance to interact with.
  it('an explicit, allowance-free minimum with only the partial-period question open counts as ONE outstanding item (partial_period), not two, and the mode/allowance question is NOT counted at all', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'transaction', rate_per_unit: 1.05, reset_anchor: 'calendar', tier_calculation: { requires_confirmation: false }, minimum_commitment: {
          mode: 'floor', prorate_partial_periods: 'unclear', included_allowance_interaction: 'unclear', requires_confirmation: true,
        } },
        { unit_type: 'transaction', rate_per_unit: 0.83, reset_anchor: 'calendar', tier_calculation: { requires_confirmation: false }, minimum_commitment: {
          mode: 'floor', prorate_partial_periods: 'unclear', included_allowance_interaction: 'unclear', requires_confirmation: true,
        } },
      ],
      escalators: [], discounts: [], service_credits: [],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(1)
  })

  it('a minimum with a genuine included allowance (a zero-rate tier present) and an unclear allowance interaction is counted as the mode/allowance item, distinct from proration', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'sms', rate_per_unit: 0, minimum_commitment: {
          mode: 'floor', prorate_partial_periods: false, included_allowance_interaction: 'unclear', requires_confirmation: true,
        } },
        { unit_type: 'sms', rate_per_unit: 0.02, minimum_commitment: {
          mode: 'floor', prorate_partial_periods: false, included_allowance_interaction: 'unclear', requires_confirmation: true,
        } },
      ],
      escalators: [], discounts: [], service_credits: [],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    // Allowance genuinely exists here (a zero-rate tier is present) and its
    // interaction is unclear — this one SHOULD count, while proration is
    // already resolved (false) so it should not add a second item.
    expect(workload.totalToConfirm).toBe(1)
  })
})

describe('isMinimumCommitmentModeUnresolved', () => {
  it('is resolved when mode is stated and no allowance exists, regardless of included_allowance_interaction', () => {
    expect(isMinimumCommitmentModeUnresolved({ mode: 'floor', included_allowance_interaction: 'unclear', requires_confirmation: true }, false)).toBe(false)
  })
  it('is unresolved when mode is missing entirely', () => {
    expect(isMinimumCommitmentModeUnresolved({ requires_confirmation: true }, false)).toBe(true)
  })
  it('is unresolved when an allowance exists and its interaction is unclear', () => {
    expect(isMinimumCommitmentModeUnresolved({ mode: 'floor', included_allowance_interaction: 'unclear', requires_confirmation: true }, true)).toBe(true)
  })
  it('is resolved when an allowance exists and its interaction is stated', () => {
    expect(isMinimumCommitmentModeUnresolved({ mode: 'floor', included_allowance_interaction: 'after_allowance', requires_confirmation: false }, true)).toBe(false)
  })
})

describe('isMinimumCommitmentProrationUnresolved', () => {
  it('is resolved (never blocks) when the metric has no calendar anchor at all — no partial-period question exists', () => {
    expect(isMinimumCommitmentProrationUnresolved({ mode: 'floor', prorate_partial_periods: 'unclear', requires_confirmation: true }, false, 'monthly', '2026-08-17', '2028-08-16')).toBe(false)
  })
  it('is resolved once a reviewer confirms a boolean prorate_partial_periods value, even without dates known', () => {
    expect(isMinimumCommitmentProrationUnresolved({ mode: 'floor', prorate_partial_periods: false, requires_confirmation: false }, true, 'monthly', null, null)).toBe(false)
  })
  it('fails toward "ask" when calendar-anchored, prorate_partial_periods unclear, and dates are not yet known', () => {
    expect(isMinimumCommitmentProrationUnresolved({ mode: 'floor', prorate_partial_periods: 'unclear', requires_confirmation: true }, true, 'monthly', null, null)).toBe(true)
  })
  it('is unresolved when calendar-anchored, prorate_partial_periods was never populated, and the contract genuinely starts mid-month (TEST-PAY-002: 17 Aug)', () => {
    expect(isMinimumCommitmentProrationUnresolved({ mode: 'floor', requires_confirmation: false }, true, 'monthly', '2026-08-17', '2028-08-16')).toBe(true)
  })
  it('is resolved when calendar-anchored and prorate_partial_periods is unclear, but the contract starts on day 1 — no partial window is ever actually touched', () => {
    expect(isMinimumCommitmentProrationUnresolved({ mode: 'floor', prorate_partial_periods: 'unclear', requires_confirmation: true }, true, 'monthly', '2026-08-01', '2028-07-31')).toBe(false)
  })
})

// "One blocker = one actionable UI control" invariant. page.tsx's
// "Service credits"/"Discounts" section card visibility filters call these
// SAME exported functions (not a separately-written copy of the
// expression) — so these tests exercise the exact predicate the UI renders
// from, not a parallel reimplementation that could quietly drift from it.
// A card is either visible for a credit/discount, or that item does not
// contribute to computeCommercialRuleWorkload's totalToConfirm — never both
// "counted but no card" or "card but not counted", by construction.
describe('isServiceCreditUnresolved — shared by the canonical count and page.tsx\'s card visibility', () => {
  it('unresolved when there is no interpretation at all yet', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: null })).toBe(true)
  })
  it('unresolved when the top-level interpretation itself still requires confirmation', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: { requires_confirmation: true } })).toBe(true)
  })
  it('unresolved when the top-level interpretation is confirmed but application_rule still requires confirmation (TEST-PAY-002 Rebate/Service Credit shape: eligibility resolved, survival still open)', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: true } },
    })).toBe(true)
  })
  it('resolved only once BOTH the top-level interpretation and application_rule are confirmed (TEST-PAY-002 Growth Credit shape, post PDF-verified carry_forward)', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false } },
    })).toBe(false)
  })
  it('resolved when the top-level interpretation is confirmed and there is no application_rule sub-object at all (non-credit rule types / legacy rows)', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: { requires_confirmation: false } })).toBe(false)
  })
})

describe('isDiscountUnresolved — shared by the canonical count and page.tsx\'s card visibility', () => {
  it('unresolved when there is no interpretation at all yet', () => {
    expect(isDiscountUnresolved({ discount_rule_id: 'd1', interpretation: null })).toBe(true)
  })
  it('unresolved when the interpretation still requires confirmation', () => {
    expect(isDiscountUnresolved({ discount_rule_id: 'd1', interpretation: { requires_confirmation: true } })).toBe(true)
  })
  it('resolved once the interpretation is confirmed', () => {
    expect(isDiscountUnresolved({ discount_rule_id: 'd1', interpretation: { requires_confirmation: false } })).toBe(false)
  })
})

describe('computeCommercialRuleWorkload.blockers — every blocker key traces to isServiceCreditUnresolved/isDiscountUnresolved returning true for that exact item', () => {
  it('TEST-PAY-002 shape: Rebate and Service Credit unresolved (survival open), Growth Credit resolved — blockers list contains exactly the two unresolved credit_rule_ids, in order, nothing else', () => {
    const terms: CommercialRuleTerms = {
      service_credits: [
        { credit_rule_id: 'rebate', interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: true } } },
        { credit_rule_id: 'growth', interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false } } },
        { credit_rule_id: 'service', interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: true } } },
      ],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.blockers).toEqual(['service_credit:rebate', 'service_credit:service'])
    expect(workload.totalToConfirm).toBe(2)
    // Every blocker key, independently re-derived via isServiceCreditUnresolved
    // against the same source data, must agree with what's in the list —
    // the actual invariant check, not just a hardcoded expected array.
    for (const key of workload.blockers) {
      const creditId = key.replace('service_credit:', '')
      const credit = terms.service_credits!.find(c => c.credit_rule_id === creditId)!
      expect(isServiceCreditUnresolved(credit)).toBe(true)
    }
    // And conversely: every credit NOT in blockers must be resolved.
    const blockedIds = new Set(workload.blockers.map(k => k.replace('service_credit:', '')))
    for (const credit of terms.service_credits!) {
      if (!blockedIds.has(credit.credit_rule_id!)) expect(isServiceCreditUnresolved(credit)).toBe(false)
    }
  })
})
