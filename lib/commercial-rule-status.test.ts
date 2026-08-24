import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, isMinimumCommitmentModeUnresolved, isMinimumCommitmentProrationUnresolved, isServiceCreditUnresolved, requiredServiceCreditFields, isDiscountUnresolved, countSourceConfirmations, isServiceCreditFullySourceResolved, isOneTimeFeeUnresolved, classifyExecutionBlockers, type CommercialRuleTerms, type UnsupportedCommercialSemanticsBlocker, type RulebookInvariantViolationLike } from './commercial-rule-status'
import type { OperationalEventEvidence } from './operational-event-evidence'

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
      // application_rule must be a populated, resolved object here — null/
      // absent now correctly means "never asked", not "resolved" (see the
      // isServiceCreditUnresolved regression tests below). cash_redeemable_
      // provenance must likewise be a resolved FieldProvenance (Step 1.5) —
      // missing/null now correctly means "never graded", not "resolved".
      service_credits: [{ credit_rule_id: 'cred1', interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'contract_derived' } }],
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
  it('resolved once the top-level interpretation and application_rule are confirmed — cash_redeemable_provenance is NOT required for the default (invoice_credit) execution context', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'contract_derived' },
    })).toBe(false)
  })
  // Step 1.5, corrected: cash_redeemable is real, provenanced metadata (see
  // requiredServiceCreditFields tests below), but it is NOT a universal
  // readiness blocker — the only execution path that exists today
  // (invoice_credit) never needs to know whether cash payout would be
  // allowed. A missing/unresolved cash_redeemable_provenance must not
  // reopen an otherwise fully-configured, already-approved billing rule.
  it('resolved (default context) even when cash_redeemable_provenance is missing entirely — legacy records are not reopened just because this field predates them', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false } },
    })).toBe(false)
  })
  it('resolved (default context) even when cash_redeemable_provenance is explicitly verdix_recommends — an unresolved recommendation here is informational, not blocking', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'verdix_recommends' },
    })).toBe(false)
  })
  it('resolved (default context) when cash_redeemable_provenance is reviewer_policy — an explicitly-confirmed value never blocks either, same as any other case', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'reviewer_policy' },
    })).toBe(false)
  })
  // The explicit 'cash_settlement' execution context is where cash treatment
  // actually becomes load-bearing — no real caller passes this context
  // today (no cash-settlement execution path exists yet), but the predicate
  // must already honor it correctly so a future execution flow can opt in
  // without another isServiceCreditUnresolved redesign.
  it('unresolved under the "cash_settlement" context when cash_redeemable_provenance is missing, even though eligibility/survival are both confirmed', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false } },
    }, 'cash_settlement')).toBe(true)
  })
  it('unresolved under "cash_settlement" when cash_redeemable_provenance is verdix_recommends — a recommendation never resolves it there either', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'verdix_recommends' },
    }, 'cash_settlement')).toBe(true)
  })
  it('resolved under "cash_settlement" once cash_redeemable_provenance is contract_derived or reviewer_policy', () => {
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'contract_derived' },
    }, 'cash_settlement')).toBe(false)
    expect(isServiceCreditUnresolved({
      credit_rule_id: 'c1',
      interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'reviewer_policy' },
    }, 'cash_settlement')).toBe(false)
  })
  // Regression (found live, 2026-08-21): a credit confirmed via the
  // free-text Override path (whose schema didn't ask about eligibility/
  // survival at all) ends up with application_rule: null/undefined — not a
  // populated, resolved object, but the QUESTION never having been asked.
  // Treating that the same as "resolved" let a real, still-open Annual
  // Rebate survival decision (independently confirmed via a live AI
  // proposal to be genuinely unstated) vanish from the review panel
  // entirely. "Never asked" must stay unresolved, same as "asked but
  // still open" — the two are indistinguishable to a downstream billing
  // engine, so they must be indistinguishable here too.
  it('unresolved when the top-level interpretation is confirmed but application_rule is null — "never asked" is not "resolved"', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: { requires_confirmation: false, application_rule: null } })).toBe(true)
  })
  it('unresolved when application_rule is entirely absent from the interpretation object', () => {
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: { requires_confirmation: false } })).toBe(true)
  })
})

describe('requiredServiceCreditFields — execution-context-aware requiredness (Step 1.5, corrected)', () => {
  it('the default/current invoice_credit path never requires cash_redeemable', () => {
    expect(requiredServiceCreditFields('invoice_credit')).toEqual(['eligibility', 'survival'])
  })
  it('a hypothetical cash_settlement path requires cash_redeemable in addition to eligibility/survival', () => {
    expect(requiredServiceCreditFields('cash_settlement')).toEqual(['eligibility', 'survival', 'cash_redeemable'])
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
        { credit_rule_id: 'growth', interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false }, cash_redeemable_provenance: 'contract_derived' } },
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

  // Grounded in the real, currently-unreviewed state of job
  // 83c5d8dc-4468-4278-ab8c-59ef86dd1634 (TEST-PAY-002, AUTO_CONFIGURE),
  // read live from Supabase on 2026-08-21 after fixing execute/route.ts's
  // upsert to stop silently dropping base_fee_proration. Each key in
  // `blockers` is exactly what page.tsx addresses one review card by
  // (BASE_FEE_PRORATION_SENTINEL for base_fee_proration, creditId for
  // service_credit:*, the tier's unit_type for partial_period:*) — this
  // test is the "canonical blocker count === rendered actionable control
  // count" invariant at the data layer: every key present here must have
  // exactly one corresponding card, and no card exists without a key here.
  it('TEST-PAY-002 real current state: 5 blockers — transaction partial-period, platform-fee proration, and all 3 fully-unreviewed service credits', () => {
    const terms: CommercialRuleTerms = {
      contract_start_date: '2026-08-17',
      base_fee_proration: { requires_confirmation: true },
      overage_tiers: [
        {
          unit_type: 'transaction', rate_per_unit: 1, reset_anchor: 'calendar', measurement_period: 'monthly',
          minimum_commitment: { mode: 'floor', requires_confirmation: false, prorate_partial_periods: 'unclear' },
        },
        { unit_type: 'chargeback', rate_per_unit: 195 },
      ],
      escalators: [],
      discounts: [],
      service_credits: [
        { credit_rule_id: '12036e1b', interpretation: null },
        { credit_rule_id: '9f7f5ea8', interpretation: null },
        { credit_rule_id: '716f7088', interpretation: null },
      ],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.blockers).toEqual([
      'partial_period:transaction',
      'base_fee_proration',
      'service_credit:12036e1b',
      'service_credit:9f7f5ea8',
      'service_credit:716f7088',
    ])
    expect(workload.totalToConfirm).toBe(5)
  })
})

describe('isServiceCreditFullySourceResolved — deterministic, extraction-time only, no AI/cache/interaction involved', () => {
  // Real TEST-PAY-002 clauses, verbatim.
  const growthCredit = {
    description: 'One-time SEK 110,000 Growth Credit earned when more than 300,000 Transactions are processed in each of three consecutive calendar months; applicable only against future transaction-processing fees',
    source_clause: 'Customer will earn a one-time SEK 110,000 Growth Credit if Customer processes more than 300,000 Transactions in each of three consecutive calendar months. The Growth Credit becomes earned only after the third qualifying consecutive calendar month has been completed. The Growth Credit: may be applied only against future transaction-processing fees; may not be applied against platform fees; may not be applied against chargeback fees; will not be paid in cash. If the amount of transaction-processing fees in the first billing period following the credit becoming available is less than the remaining Growth Credit, the unused portion will carry forward and may be applied against future transaction-processing fees until fully used.',
  }
  const annualRebate = {
    description: 'Annual volume rebate of 5% of transaction-processing fees if more than 2,000,000 Transactions processed in a Contract Year',
    source_clause: 'If Customer processes more than 2,000,000 Transactions during a Contract Year, Customer will be entitled to a rebate equal to 5% of the transaction-processing fees paid for that Contract Year. For purposes of this clause, the rebate applies only to transaction-processing fees under Section 3. The rebate does not apply to: platform fees; chargeback fees; other fees or charges. Any rebate earned will be calculated after the end of the applicable Contract Year and credited to Customer within 45 days after Contract Year-end.',
  }
  const serviceCredit = {
    description: 'Service availability credit of SEK 5,500 per complete hour of excess unavailability, capped at SEK 55,000 per calendar month',
    source_clause: 'If FluxPay fails to meet the applicable service-availability commitment, Customer will be entitled to SEK 5,500 for each complete hour of excess service unavailability during the applicable calendar month. The total service credit for any calendar month is capped at SEK 55,000. Service credits will be applied against future amounts payable under this Agreement.',
  }

  it('Growth Credit: eligibility ("applied only against"), one-time, and carry-forward are all textually explicit — fully resolved', () => {
    expect(isServiceCreditFullySourceResolved(growthCredit)).toBe(true)
  })

  it('Annual Rebate: eligibility is explicit, but the clause never mentions carry-forward at all — NOT fully resolved, stays a decision', () => {
    expect(isServiceCreditFullySourceResolved(annualRebate)).toBe(false)
  })

  it('Service Credit: eligibility is explicit, but no carry-forward language — NOT fully resolved, stays a decision', () => {
    expect(isServiceCreditFullySourceResolved(serviceCredit)).toBe(false)
  })

  it('a credit with carry-forward language but no eligibility/repeatability marker is NOT fully resolved — all markers required, not just one', () => {
    expect(isServiceCreditFullySourceResolved({
      description: 'Loyalty credit', source_clause: 'Any unused credit will carry forward to the next billing period.',
    })).toBe(false)
  })

  it('a credit with no source_clause or description at all is NOT fully resolved', () => {
    expect(isServiceCreditFullySourceResolved({})).toBe(false)
  })
})

describe('countSourceConfirmations — presentational split, never changes the underlying blocker count, derived from persisted extraction data only', () => {
  const blockers = ['partial_period:transaction', 'base_fee_proration', 'service_credit:rebate', 'service_credit:growth', 'service_credit:service']
  const growthCredit = {
    credit_rule_id: 'growth',
    description: 'One-time SEK 110,000 Growth Credit',
    source_clause: 'Customer will earn a one-time SEK 110,000 Growth Credit. The Growth Credit may be applied only against future transaction-processing fees. The unused portion will carry forward and may be applied against future transaction-processing fees until fully used.',
  }
  const rebate = {
    credit_rule_id: 'rebate',
    description: 'Annual volume rebate',
    source_clause: 'The rebate applies only to transaction-processing fees under Section 3. Any rebate earned will be credited within 45 days after Contract Year-end.',
  }
  const serviceCredits = [growthCredit, rebate]

  it('counts only the service_credit blockers whose OWN persisted source_clause/description clear the deterministic bar', () => {
    expect(countSourceConfirmations(blockers, serviceCredits)).toBe(1)
  })

  it('never counts non-service_credit blocker keys', () => {
    expect(countSourceConfirmations(['base_fee_proration', 'partial_period:transaction'], serviceCredits)).toBe(0)
  })

  it('does not count a blocker whose credit_rule_id cannot be found in the supplied list', () => {
    expect(countSourceConfirmations(['service_credit:unknown'], serviceCredits)).toBe(0)
  })

  it('handles a missing/null serviceCredits list without throwing', () => {
    expect(countSourceConfirmations(blockers, null)).toBe(0)
    expect(countSourceConfirmations(blockers, undefined)).toBe(0)
  })

  // Regression for the exact instability this function existed to fix: the
  // classification must depend ONLY on the credits' own persisted
  // source_clause/description — never on whether a reviewer has opened a
  // card, triggered a propose-rule call, or otherwise populated an AI
  // proposal cache. The function signature itself no longer accepts any
  // interaction/cache-shaped argument, so this is structurally guaranteed,
  // not just true by coincidence — this test pins that guarantee down by
  // calling with the identical `serviceCredits` input multiple times (as if
  // called once before any card was opened, and again after a reviewer had
  // opened every card and populated a full proposal cache) and asserting
  // the result never changes.
  it('is stable across repeated calls with the same persisted data — opening a card / populating a proposal cache cannot change the result, because no such input exists', () => {
    const beforeAnyCardOpened = countSourceConfirmations(blockers, serviceCredits)
    const afterEveryCardOpened = countSourceConfirmations(blockers, serviceCredits) // same persisted input — nothing about "opening a card" is representable here
    expect(afterEveryCardOpened).toBe(beforeAnyCardOpened)
    expect(beforeAnyCardOpened).toBe(1)
  })
})

// Step 11 — OneTimeFee brought into the same readiness/provenance
// architecture every other commercial-rule type already has. See
// lib/rulebook/MILESTONE_BILLING_FINDINGS.md for the full lifecycle audit
// motivating these specific cases.
describe('isOneTimeFeeUnresolved', () => {
  it('a fee with no requires_confirmation flag at all (the historical shape — Step 11 item 10) is resolved, not blocking', () => {
    expect(isOneTimeFeeUnresolved({ fee_label: 'Onboarding fee', amount: 5000 })).toBe(false)
  })
  it('requires_confirmation: true blocks', () => {
    expect(isOneTimeFeeUnresolved({ fee_label: 'Ambiguous fee', amount: 100000, requires_confirmation: true })).toBe(true)
  })
  it('requires_confirmation: true but unresolved_kind "unsupported_semantics" does NOT block via this function — it is a capability blocker instead, handled separately', () => {
    expect(isOneTimeFeeUnresolved({ fee_label: 'Acceptance-gated fee', amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' })).toBe(false)
  })
})

describe('computeCommercialRuleWorkload — OneTimeFee readiness integration (Step 11, item 2/5/10 fixtures)', () => {
  it('item 2: explicit fixed amount, no confirmation needed — does not block (backward compat, and the plain common case)', () => {
    const terms: CommercialRuleTerms = { one_time_fees: [{ fee_label: 'Onboarding fee', amount: 5000 }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(0)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('item 2: a fee explicitly flagged requires_confirmation (the ambiguous due_date/manual_trigger shape) blocks readiness', () => {
    const terms: CommercialRuleTerms = { one_time_fees: [{ fee_label: 'Ambiguous fee', amount: 100000, requires_confirmation: true }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(1)
    expect(workload.blockers).toContain('one_time_fee:Ambiguous fee')
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('item 2: multiple one-time fees are tracked independently', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [
        { fee_label: 'Resolved fee', amount: 5000 },
        { fee_label: 'Needs review 1', amount: 10000, requires_confirmation: true },
        { fee_label: 'Needs review 2', amount: 20000, requires_confirmation: true },
      ],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(2)
    expect(workload.blockers.sort()).toEqual(['one_time_fee:Needs review 1', 'one_time_fee:Needs review 2'])
  })

  it('item 2: a one-time fee alongside recurring/usage components does not perturb the existing counts for those other types', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [
        { unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } },
      ],
      discounts: [{ discount_rule_id: 'd1', interpretation: { requires_confirmation: false } }],
      one_time_fees: [{ fee_label: 'Setup fee', amount: 5000, requires_confirmation: true }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('one_time_fee:Setup fee')
    expect(workload.blockers).not.toContain('minimum_commitment:api_call')
    expect(workload.blockers).not.toContain('discount:d1')
    expect(workload.totalToConfirm).toBe(1)
  })

  it('item 10: absent one_time_fees field entirely (every pre-existing caller/fixture) behaves exactly as before this step', () => {
    const terms: CommercialRuleTerms = { discounts: [{ discount_rule_id: 'd1', interpretation: { requires_confirmation: false } }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('item 10: a historical fee with fields the new safety net never ran on (no requires_confirmation, regardless of amount/due_date shape) is never retroactively reopened', () => {
    const terms: CommercialRuleTerms = { one_time_fees: [{ fee_label: 'Pre-Step-11 fee', amount: 250000 }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(0)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('item 6/7: an unresolved_kind "unsupported_semantics" fee becomes a capability blocker (execution_blocked), never an ordinary reviewer-resolvable item, and never silently invents a resolved value', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{ fee_label: 'Acceptance-gated milestone', amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
    expect(workload.totalToConfirm).toBe(0) // never counted as an ordinary, reviewer-resolvable item
    expect(workload.blockers).not.toContain('one_time_fee:Acceptance-gated milestone')
    expect(workload.executionBlockers).toContainEqual<UnsupportedCommercialSemanticsBlocker>({
      type: 'unsupported_commercial_semantics',
      rule_family: 'one_time_fee',
      missing_capability: 'event_based_billability',
      field: 'one_time_fee:Acceptance-gated milestone',
      reason: 'The source describes a billability condition this fee shape cannot yet represent.',
    })
  })

  it('a capability blocker fails closed even when every other commercial rule is fully confirmed — no amount of unrelated confirmation clears it', () => {
    const terms: CommercialRuleTerms = {
      discounts: [{ discount_rule_id: 'd1', interpretation: { requires_confirmation: false } }],
      one_time_fees: [{ fee_label: 'Blocked fee', amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
  })

  it('the capability-blocker reason never contains raw source text — only the generic, structural description (item 7)', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{ fee_label: 'Milestone 1', amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    const blocker = workload.executionBlockers[0] as UnsupportedCommercialSemanticsBlocker
    expect(blocker.reason).not.toMatch(/SEK|customer acceptance|Milestone/i)
  })

  it('caller-supplied Rulebook violations and internally-derived one-time-fee capability blockers coexist in the same executionBlockers array', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{ fee_label: 'Blocked fee', amount: 100000, requires_confirmation: true, unresolved_kind: 'unsupported_semantics' }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, [
      { type: 'rulebook_invariant_violation', rule_id: 'minimum.floor.non_additive', field: 'minimumCommitment.observed.payableMinor', reason: 'test' },
    ])
    expect(workload.executionBlockers).toHaveLength(2)
    expect(workload.executionBlockers.map(b => b.type).sort()).toEqual(['rulebook_invariant_violation', 'unsupported_commercial_semantics'])
  })

  it('a fee with no fee_label is silently skipped, not counted and not blocking — same defensive discipline as discounts/credits with no rule_id', () => {
    const terms: CommercialRuleTerms = { one_time_fees: [{ amount: 100000, requires_confirmation: true }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBe(0)
  })
})

describe('isOneTimeFeeUnresolved — Step 12 billability_condition awareness', () => {
  it('legacy record (billability_condition undefined) keeps the exact pre-Step-12 manual_trigger-gated check', () => {
    expect(isOneTimeFeeUnresolved({
      fee_label: 'Legacy', amount: 100000, amount_provenance: 'reviewer_policy',
      manual_trigger: true, billability_provenance: null,
    })).toBe(false) // manual_trigger short-circuits billability, exactly as Step 11
  })

  it('a Step-12 event condition with billability_provenance null blocks — needs reviewer confirmation, regardless of the (unrelated) projected manual_trigger:true', () => {
    expect(isOneTimeFeeUnresolved({
      fee_label: 'Milestone fee', amount: 100000, amount_provenance: 'reviewer_policy',
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      manual_trigger: true, // projection side effect — must NOT suppress the check under Step 12
      billability_provenance: null,
    })).toBe(true)
  })

  it('a Step-12 event condition with billability_provenance resolved is no longer counted as an ordinary unresolved item', () => {
    expect(isOneTimeFeeUnresolved({
      fee_label: 'Milestone fee', amount: 100000, amount_provenance: 'reviewer_policy',
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      manual_trigger: true, billability_provenance: 'reviewer_policy',
    })).toBe(false)
  })

  it('a Step-12 immediate/fixed_date condition behaves like any other provenance-gated field — manual_trigger stays false, provenance governs directly', () => {
    const unconfirmed = { fee_label: 'Fixed', amount: 100000, amount_provenance: 'reviewer_policy' as const, billability_condition: { kind: 'fixed_date' as const, date: '2026-10-15' }, billability_provenance: null }
    const confirmed = { ...unconfirmed, billability_provenance: 'reviewer_policy' as const }
    expect(isOneTimeFeeUnresolved(unconfirmed)).toBe(true)
    expect(isOneTimeFeeUnresolved(confirmed)).toBe(false)
  })
})

describe('computeCommercialRuleWorkload — Step 12 operational-evidence blocker (item 6/16)', () => {
  // Contract B live acceptance failure (2026-08-29) — this test originally
  // asserted status === 'execution_blocked' for a PURE
  // required_operational_event_missing case, which is exactly the live bug:
  // an otherwise fully-resolved, event-gated fee waiting only on real-world
  // evidence is a legitimate execution HOLD, not an approval blocker — the
  // agreement must remain approvable (the fee itself parks instead). See
  // classifyExecutionBlockers/computeCommercialRuleWorkload's own comments.
  it('an event condition, confirmed (reviewer_policy), produces a required_operational_event_missing blocker as an execution HOLD — never blocks approval, never unsupported_commercial_semantics', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Design Milestone Fee', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        manual_trigger: true, billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    // A pure operational-event hold no longer blocks approval — status
    // reaches full readiness, not 'execution_blocked'.
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.approvalBlockers).toHaveLength(0)
    expect(workload.executionBlockers).toHaveLength(1)
    expect(workload.executionHolds).toHaveLength(1)
    expect(workload.executionBlockers[0]).toMatchObject({
      type: 'required_operational_event_missing',
      rule_family: 'one_time_fee',
      event_type: 'customer_acceptance',
      field: 'one_time_fee:Design Milestone Fee',
    })
    expect(workload.executionHolds[0]).toMatchObject({
      type: 'required_operational_event_missing',
      event_type: 'customer_acceptance',
    })
    // Never counted as an ordinary reviewer decision — nothing left to confirm.
    expect(workload.totalToConfirm).toBe(0)
    expect(workload.blockers).not.toContain('one_time_fee:Design Milestone Fee')
  })

  it('an event condition NOT yet confirmed is an ordinary reviewer decision, not yet a blocker at all', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Design Milestone Fee', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        manual_trigger: true, billability_provenance: null,
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(0)
    expect(workload.totalToConfirm).toBe(1)
    expect(workload.blockers).toContain('one_time_fee:Design Milestone Fee')
  })

  it('amount stays independently counted even once billability becomes an operational-evidence blocker (item 5 independence, post-Step-12)', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Design Milestone Fee', amount: 100000, amount_provenance: null,
        billability_condition: { kind: 'event', event_type: 'delivery' },
        manual_trigger: true, billability_provenance: 'contract_derived',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(1)
    expect(workload.executionBlockers[0].type).toBe('required_operational_event_missing')
    expect(workload.totalToConfirm).toBe(1) // amount still needs a reviewer decision
    expect(workload.blockers).toContain('one_time_fee:Design Milestone Fee')
  })

  it('an immediate/fixed_date condition, confirmed, never produces an operational-evidence blocker — reaches full readiness', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Implementation Fee', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'fixed_date', date: '2026-10-15' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(0)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('unresolved_kind: unsupported_semantics still takes priority over billability_condition — a genuinely unrepresentable fee never reaches the operational-evidence branch', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Deemed Acceptance Fee', amount: 100000, amount_provenance: 'contract_derived',
        billability_condition: null, requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(1)
    expect(workload.executionBlockers[0].type).toBe('unsupported_commercial_semantics')
  })

  it('legacy fee (billability_condition undefined, manual_trigger true) never produces an operational-evidence blocker — Step 12 does not reopen historical manual_trigger fees', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{ fee_label: 'Professional services', amount: 0, manual_trigger: true }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(0)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })
})

const ASOF = new Date('2026-10-15T00:00:00.000Z')
function evidence(overrides: Partial<OperationalEventEvidence> = {}): OperationalEventEvidence {
  return {
    id: 'ev-1', subjectId: 'fee-1', eventType: 'customer_acceptance',
    occurredAt: '2026-10-12T14:00:00.000Z', source: 'reviewer_attestation',
    recordedAt: '2026-10-13T09:20:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    ...overrides,
  }
}

describe('computeCommercialRuleWorkload — Step 13 operational evidence clears the blocker', () => {
  it('satisfied, matching, active evidence clears required_operational_event_missing entirely', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Design Milestone Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(workload.executionBlockers).toHaveLength(0)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('no evidence at all → blocker remains (unchanged Step 12 behavior)', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Design Milestone Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
    expect(workload.executionBlockers[0].type).toBe('required_operational_event_missing')
  })

  it('wrong event type on the evidence → blocker remains', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ eventType: 'delivery' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('evidence for a different fee_id (another subject) → blocker remains', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ subjectId: 'fee-2' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('revoked evidence → blocker remains', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ status: 'revoked' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('future-dated evidence (relative to asOf) → blocker remains', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ occurredAt: '2027-01-01T00:00:00.000Z' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('a fee with no fee_id at all can never match any evidence — fails closed', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ subjectId: '' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('evidence satisfaction never mutates billability_condition/billability_provenance — item 10', () => {
    const fee = {
      fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy' as const,
      billability_condition: { kind: 'event' as const, event_type: 'customer_acceptance' as const },
      billability_provenance: 'reviewer_policy' as const,
    }
    const before = JSON.stringify(fee)
    computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(JSON.stringify(fee)).toBe(before)
  })

  it('amount stays independently counted even once evidence satisfies billability entirely', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: null,
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(workload.executionBlockers).toHaveLength(0) // billability satisfied
    expect(workload.totalToConfirm).toBe(1) // amount still needs a reviewer decision
  })

  it('a pre-Step-13 caller passing nothing for evidence/asOf keeps exact Step 12 behavior (defaults to [] — always blocked)', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Fee', fee_id: 'fee-1', amount: 100000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(1)
  })
})

// Agreement A final amendment, item 3 — the review-count divergence bug
// (11/7 items shown in different parts of the same page) was two
// independent call sites in app/(dashboard)/configure/[id]/page.tsx each
// building their own arguments (one omitting operationalEventEvidence
// entirely, one folding meterMapping down into a crude 0/1 pair) and each
// defaulting `asOf` ambiently to `new Date()`. The real fix was
// architectural — compute this once in the owning page component and pass
// the single result down as a prop, so a second call site can no longer
// exist to drift in the first place. This is the read-model-boundary
// regression test for that invariant: computeCommercialRuleWorkload is
// pure and must produce byte-identical output for byte-identical
// arguments, INCLUDING when `asOf` is passed explicitly (as the real
// call site does) rather than left to its ambient `new Date()` default —
// two call sites that pass the same explicit asOf can never diverge on
// evidence future-dating, closing off the exact non-determinism vector
// that made the original two-call-site design unsafe.
describe('computeCommercialRuleWorkload — determinism (Agreement A final amendment, item 3: one canonical workload object)', () => {
  it('two calls with byte-identical terms/meterMapping/evidence/asOf produce byte-identical output', () => {
    const terms: CommercialRuleTerms = {
      overage_tiers: [{ unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: true } }],
      discounts: [{ discount_rule_id: 'd1', interpretation: { requires_confirmation: true } }],
      service_credits: [{
        credit_rule_id: 'c1',
        interpretation: { requires_confirmation: false, application_rule: { requires_confirmation: false } },
      }],
      one_time_fees: [{
        fee_label: 'Implementation fee', fee_id: 'fee-1', amount: 150000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const meterMapping = { total: 2, confirmed: 1 }
    const evidenceRows = [evidence()]

    // Simulates the two independent "screens" (main page summary vs.
    // ReviewPanel drawer) that previously each built their own arguments —
    // now, both would receive this SAME computed object rather than
    // calling the function separately at all, but the underlying
    // guarantee this test protects is that doing so would have been safe:
    // identical real inputs -> identical output, always.
    const screenA = computeCommercialRuleWorkload(terms, meterMapping, 0, undefined, { configured: true }, undefined, evidenceRows, ASOF)
    const screenB = computeCommercialRuleWorkload({ ...terms }, { ...meterMapping }, 0, undefined, { configured: true }, undefined, [...evidenceRows], ASOF)
    expect(screenA).toEqual(screenB)
  })

  it('omitting operationalEventEvidence (the actual historical bug) DOES change the result — proving the argument matters and a single shared computation is the only way to guarantee it is never omitted at one call site but not another', () => {
    const terms: CommercialRuleTerms = {
      one_time_fees: [{
        fee_label: 'Implementation fee', fee_id: 'fee-1', amount: 150000, amount_provenance: 'reviewer_policy',
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
        billability_provenance: 'reviewer_policy',
      }],
    }
    const withEvidence = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    const withoutEvidence = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [], ASOF)
    expect(withEvidence.executionBlockers).toHaveLength(0)
    expect(withoutEvidence.executionBlockers).toHaveLength(1)
    expect(withEvidence).not.toEqual(withoutEvidence)
  })
})

// Contract B live acceptance failure (2026-08-29), Part 8 regression
// coverage — the canonical approvalBlockers/executionHolds split, proven
// against the real Contract B Integration Fee shape (SEK 90,000, fee_id
// 0f56a974-68de-496d-8393-3850450e31d9, customer_acceptance) where
// practical, plus classifyExecutionBlockers directly.
describe('classifyExecutionBlockers / approvalBlockers / executionHolds — canonical split (regression)', () => {
  const integrationFeeTerms: CommercialRuleTerms = {
    one_time_fees: [{
      fee_label: 'Integration fee', fee_id: '0f56a974-68de-496d-8393-3850450e31d9',
      amount: 90000, amount_provenance: 'contract_derived',
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      manual_trigger: true, billability_provenance: 'contract_derived',
    }],
  }

  // A — READY_TO_APPROVE + only required_operational_event_missing -> approval allowed.
  it('A: an otherwise fully-resolved event-gated fee with no evidence -> approval allowed (status not execution_blocked, approvalBlockers empty)', () => {
    const workload = computeCommercialRuleWorkload(
      integrationFeeTerms, { total: 0, confirmed: 0 }, 0, undefined, { configured: true }, undefined, [], new Date('2026-10-15'),
    )
    expect(workload.status).not.toBe('execution_blocked')
    expect(workload.approvalBlockers).toHaveLength(0)
    expect(workload.executionHolds).toHaveLength(1)
    expect(workload.executionHolds[0].event_type).toBe('customer_acceptance')
    // Semantic audit (2026-08-29) — the two booleans deliberately disagree
    // here: approval is safe (approvalBlocked false) even though the
    // contract is NOT fully executable right now (executionBlocked stays
    // true — the Integration Fee genuinely cannot execute without
    // evidence). Neither field is derivable from the other.
    expect(workload.approvalBlocked).toBe(false)
    expect(workload.executionBlocked).toBe(true)
  })

  // B — same fee without evidence -> remains non-executable (the hold
  // itself is still present, just not approval-blocking; whether it
  // actually PARKS at push time is lib/billing-writer.ts's
  // isOneTimeFeeHeldForExecution, exercised in its own test file — this
  // proves the classification side of that same fact).
  it('B: without evidence, the fee is still flagged as an execution hold (non-executable), distinct from being fully clear', () => {
    const workload = computeCommercialRuleWorkload(
      integrationFeeTerms, { total: 0, confirmed: 0 }, 0, undefined, { configured: true }, undefined, [], new Date('2026-10-15'),
    )
    expect(workload.executionHolds.map(h => h.field)).toContain('one_time_fee:Integration fee')
  })

  it('B (continued): once satisfied evidence exists, the hold clears entirely', () => {
    const ev: OperationalEventEvidence = {
      id: 'ev-1', subjectId: '0f56a974-68de-496d-8393-3850450e31d9', eventType: 'customer_acceptance',
      occurredAt: '2026-10-10T00:00:00.000Z', source: 'reviewer_attestation',
      recordedAt: '2026-10-10T00:00:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    }
    const workload = computeCommercialRuleWorkload(
      integrationFeeTerms, { total: 0, confirmed: 0 }, 0, undefined, { configured: true }, undefined, [ev], new Date('2026-10-15'),
    )
    expect(workload.executionHolds).toHaveLength(0)
    expect(workload.approvalBlockers).toHaveLength(0)
  })

  // C — unresolved commercial interpretation -> approval still blocked.
  // This is the SEPARATE totalToConfirm/interactionsToConfirm gate in
  // approve/route.ts (unchanged by this pass) — proven here at the
  // workload level: an unconfirmed discount produces totalToConfirm > 0
  // regardless of approvalBlockers/executionHolds being empty.
  it('C: an unresolved commercial interpretation (unconfirmed discount) still leaves totalToConfirm > 0, independent of the blocker classification', () => {
    const terms: CommercialRuleTerms = { discounts: [{ discount_rule_id: 'd1', interpretation: null }] }
    const workload = computeCommercialRuleWorkload(terms, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBeGreaterThan(0)
    expect(workload.approvalBlockers).toHaveLength(0) // not an execution-blocker case at all — a different gate
  })

  // D — genuinely unsafe execution blocker -> approval still blocked.
  // Covers BOTH kinds this codebase supports: an unsupported-semantics
  // capability gap (already had test coverage above) and a caller-supplied
  // rulebook invariant violation (new coverage here).
  it('D: a caller-supplied rulebook invariant violation still blocks approval — status execution_blocked, approvalBlockers non-empty', () => {
    const violation: RulebookInvariantViolationLike = {
      type: 'rulebook_invariant_violation', rule_id: 'r1', field: 'minimum_commitment', reason: 'computed result contradicts the normalized floor',
    }
    const workload = computeCommercialRuleWorkload(
      integrationFeeTerms, { total: 0, confirmed: 0 }, 0, undefined, { configured: true }, [violation], [], new Date('2026-10-15'),
    )
    expect(workload.status).toBe('execution_blocked')
    expect(workload.approvalBlockers).toHaveLength(1)
    expect(workload.approvalBlockers[0].type).toBe('rulebook_invariant_violation')
    // The unrelated execution hold on the Integration Fee is still present
    // and still correctly NOT counted as an approval blocker — a genuine
    // blocker elsewhere doesn't reclassify an unrelated hold.
    expect(workload.executionHolds).toHaveLength(1)
    // Here BOTH booleans agree (unlike test A) — a genuine blocker means
    // neither approval nor full execution is safe.
    expect(workload.approvalBlocked).toBe(true)
    expect(workload.executionBlocked).toBe(true)
  })

  it('D (continued): a rulebook violation blocks approval even when the SAME job also has a satisfied evidence hold (mixed case)', () => {
    const violation: RulebookInvariantViolationLike = {
      type: 'rulebook_invariant_violation', rule_id: 'r2', field: 'tier_calculation', reason: 'graduated result diverges from volume result',
    }
    const ev: OperationalEventEvidence = {
      id: 'ev-1', subjectId: '0f56a974-68de-496d-8393-3850450e31d9', eventType: 'customer_acceptance',
      occurredAt: '2026-10-10T00:00:00.000Z', source: 'reviewer_attestation',
      recordedAt: '2026-10-10T00:00:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    }
    const workload = computeCommercialRuleWorkload(
      integrationFeeTerms, { total: 0, confirmed: 0 }, 0, undefined, { configured: true }, [violation], [ev], new Date('2026-10-15'),
    )
    expect(workload.status).toBe('execution_blocked')
    expect(workload.approvalBlockers).toHaveLength(1)
    expect(workload.executionHolds).toHaveLength(0) // evidence satisfied this one
  })

  // E — UI and API classification agree: both read workload.approvalBlockers/
  // workload.executionHolds directly (app/(dashboard)/configure/[id]/page.tsx's
  // pendingExecutionHolds and approvalBlockersOutstanding; app/api/jobs/[id]/
  // approve/route.ts's two gates) — proven here by testing the single shared
  // classifyExecutionBlockers function they both ultimately depend on.
  it('E: classifyExecutionBlockers is the single implementation — same input always produces the same split, independent of caller', () => {
    const mixed = [
      { type: 'required_operational_event_missing' as const, rule_family: 'one_time_fee', event_type: 'customer_acceptance' as const, field: 'one_time_fee:A', reason: 'r' },
      { type: 'unsupported_commercial_semantics' as const, rule_family: 'one_time_fee', missing_capability: 'x', field: 'one_time_fee:B', reason: 'r' },
      { type: 'rulebook_invariant_violation' as const, rule_id: 'r1', field: 'f', reason: 'r' },
    ]
    const result = classifyExecutionBlockers(mixed)
    expect(result.executionHolds).toEqual([mixed[0]])
    expect(result.approvalBlockers).toEqual([mixed[1], mixed[2]])
    // Idempotent/pure — calling again with the same input reproduces the
    // identical split (what "UI and API can never diverge" actually rests on).
    expect(classifyExecutionBlockers(mixed)).toEqual(result)
  })

  it('E (continued): an empty executionBlockers array classifies to two empty arrays, never undefined/null', () => {
    const result = classifyExecutionBlockers([])
    expect(result).toEqual({ approvalBlockers: [], executionHolds: [] })
  })
})
