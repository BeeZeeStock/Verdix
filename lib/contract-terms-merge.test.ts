import { describe, it, expect } from 'vitest'
import {
  mergeBaseFeeProrationDecision, mergeFixedFeeBillingTimingDecision, mergeVariableInvoiceTimingForFees,
  mergeRecurringFeeProrationForFees, recurringFeeDecisionKey,
  preserveDiscountIdentity, type CurrentRuleAuditRow,
} from './contract-terms-merge'
import type { PeriodProrationRule, FixedFeeBillingTimingRule, AdditionalRecurringFee, Discount } from './types'

// Step 17H.4B0D4H1B4E3.3 — pure merge-doctrine tests. No database — the I/O
// (loading commercial_rule_interpretations, calling these functions from
// execute/route.ts) is exercised separately by the real-Postgres
// integration suite.

function prorationRule(overrides: Partial<PeriodProrationRule> = {}): PeriodProrationRule {
  return { reset_anchor: 'contract_start', prorate_partial_periods: 'unclear', requires_confirmation: true, confirmation_reason: null, source_clause: 'fresh clause', ...overrides }
}
function timingRule(overrides: Partial<FixedFeeBillingTimingRule> = {}): FixedFeeBillingTimingRule {
  return { timing: 'unclear', requires_confirmation: true, confirmation_reason: null, source_clause: 'fresh clause', ...overrides }
}
function auditRow(approved: Record<string, unknown>, contractUnitType: string | null = null): CurrentRuleAuditRow {
  return { contract_unit_type: contractUnitType, approved_interpretation: approved }
}
function discount(overrides: Partial<Discount> = {}): Discount {
  return {
    discount_rule_id: undefined, discount_pct: 10, discount_amount: null, discount_type: 'introductory',
    start_date: '2026-01-01', end_date: '2026-03-31', duration_months: 3, duration_days: null,
    applies_to: 'platform fee', description: 'Introductory discount', interpretation: null,
    ...overrides,
  }
}

describe('mergeBaseFeeProrationDecision', () => {
  it('no confirmed decision exists -> fresh extraction used as-is', () => {
    const fresh = prorationRule({ prorate_partial_periods: 'unclear' })
    expect(mergeBaseFeeProrationDecision(fresh, [])).toBe(fresh)
  })

  it('confirmed decision exists, fresh re-extraction is silent (unclear) -> confirmed decision restored, requires_confirmation false', () => {
    const fresh = prorationRule({ prorate_partial_periods: 'unclear', requires_confirmation: true, source_clause: 'fresh clause v2' })
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' })]
    const merged = mergeBaseFeeProrationDecision(fresh, audit)
    expect(merged?.prorate_partial_periods).toBe(true)
    expect(merged?.requires_confirmation).toBe(false)
    expect(merged?.confirmation_reason).toBeNull()
    // system-owned evidence still refreshes from the fresh extraction
    expect(merged?.source_clause).toBe('fresh clause v2')
  })

  it('confirmed decision exists, fresh re-extraction reaches the SAME concrete value (semantic equivalence, not byte equivalence) -> restored, no conflict', () => {
    const fresh = prorationRule({ prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null })
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' })]
    const merged = mergeBaseFeeProrationDecision(fresh, audit)
    expect(merged?.prorate_partial_periods).toBe(true)
    expect(merged?.requires_confirmation).toBe(false)
  })

  it('confirmed decision exists, fresh re-extraction reaches a DIFFERENT concrete value -> conflict, neither side silently wins', () => {
    const fresh = prorationRule({ prorate_partial_periods: false })
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' })]
    const merged = mergeBaseFeeProrationDecision(fresh, audit)
    expect(merged?.requires_confirmation).toBe(true)
    expect(merged?.confirmation_reason).toMatch(/true/)
    expect(merged?.confirmation_reason).toMatch(/false/)
    // the fresh (new) value is NOT silently discarded — still visible on the object
    expect(merged?.prorate_partial_periods).toBe(false)
  })

  it('ambiguous audit evidence (2+ current rows matching) -> never picks a winner, fresh used as-is', () => {
    const fresh = prorationRule({ prorate_partial_periods: 'unclear' })
    const audit = [auditRow({ prorate_partial_periods: true }), auditRow({ prorate_partial_periods: false })]
    expect(mergeBaseFeeProrationDecision(fresh, audit)).toBe(fresh)
  })

  it('null fresh rule (fee disappeared from fresh extraction) -> passthrough, nothing to merge onto', () => {
    expect(mergeBaseFeeProrationDecision(null, [auditRow({ prorate_partial_periods: true })])).toBeNull()
  })
})

describe('mergeFixedFeeBillingTimingDecision (job-level, same doctrine as base_fee_proration)', () => {
  it('restores a confirmed timing when fresh extraction is silent', () => {
    const fresh = timingRule({ timing: 'unclear' })
    const merged = mergeFixedFeeBillingTimingDecision(fresh, [auditRow({ timing: 'bill_at_period_start' })])
    expect(merged?.timing).toBe('bill_at_period_start')
    expect(merged?.requires_confirmation).toBe(false)
  })

  it('surfaces conflict when fresh extraction explicitly contradicts the confirmed timing', () => {
    const fresh = timingRule({ timing: 'bill_at_period_end' })
    const merged = mergeFixedFeeBillingTimingDecision(fresh, [auditRow({ timing: 'bill_at_period_start' })])
    expect(merged?.requires_confirmation).toBe(true)
    expect(merged?.confirmation_reason).toMatch(/bill_at_period_start/)
    expect(merged?.confirmation_reason).toMatch(/bill_at_period_end/)
  })
})

describe('mergeVariableInvoiceTimingForFees (per-fee, addressed by fee_label)', () => {
  function fee(overrides: Partial<AdditionalRecurringFee> = {}): AdditionalRecurringFee {
    return {
      fee_label: 'Per-issued payment request fee', metric_name: 'request_count', rate_per_unit: 0.38,
      amount: 0, percentage_of_basis: null,
      variable_invoice_timing: { timing: 'unclear', requires_confirmation: true, confirmation_reason: null, source_clause: null },
      ...overrides,
    } as AdditionalRecurringFee
  }

  it('restores the confirmed timing only for the matching fee_label, leaves other fees untouched', () => {
    const fees = [
      fee({ fee_label: 'Per-issued payment request fee' }),
      fee({ fee_label: 'Per-completed payment success fee' }),
    ]
    const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'Per-issued payment request fee')]
    const merged = mergeVariableInvoiceTimingForFees(fees, audit)
    expect(merged[0].variable_invoice_timing?.timing).toBe('invoice_at_period_end')
    expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(false)
    // unrelated fee — no matching audit row — unchanged
    expect(merged[1].variable_invoice_timing?.timing).toBe('unclear')
    expect(merged[1].variable_invoice_timing?.requires_confirmation).toBe(true)
  })

  it('a fee_label with no matching confirmed audit row is left as fresh extraction produced it', () => {
    const fees = [fee({ fee_label: 'Some new fee' })]
    const merged = mergeVariableInvoiceTimingForFees(fees, [])
    expect(merged[0].variable_invoice_timing?.timing).toBe('unclear')
  })

  // Step 17H.4B0D4H1B4E3.4.1 — recurring_fee_id becomes the PRIMARY
  // addressing key once available (confirm-rule/route.ts stores audit rows
  // under 'recurring_fee:{id}' for a fee that has one — see that route's
  // own auditUnitKey computation).
  describe('17H.4B0D4H1B4E3.4.1 — recurring_fee_id-first addressing', () => {
    it('§7 — the real observed wording drift: an ID-stable fee keeps its confirmed timing across a re-extraction that changed only fee_label', () => {
      const fees = [fee({ fee_label: 'Per-completed payment success fee', recurring_fee_id: 'rf-abc' })]
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'recurring_fee:rf-abc')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.timing).toBe('invoice_at_period_end')
      expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(false)
    })

    it('§8 — same/similar label but a DIFFERENT recurring_fee_id does not inherit the decision: identity beats wording', () => {
      const fees = [fee({ fee_label: 'Per-completed payment success fee', recurring_fee_id: 'rf-different' })]
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'recurring_fee:rf-abc')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.timing).toBe('unclear')
      expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(true)
    })

    it('§9 — a changed metric (new recurring_fee_id assigned by preserveRecurringFeeIdentity) does not silently inherit the old decision', () => {
      // Simulates preserveRecurringFeeIdentity already having run and
      // correctly assigned a FRESH id (changed semantic_input_key ->
      // not the same mechanism) — the audit row for the OLD id must not
      // apply here.
      const fees = [fee({ fee_label: 'Per-completed payment success fee', recurring_fee_id: 'rf-fresh-new-metric' })]
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'recurring_fee:rf-old-metric')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(true)
    })

    it('§5/§6 — legacy bridge: a fee with NO recurring_fee_id yet still resolves its decision via the original fee_label-keyed audit row (pre-E3.4.1 confirmations)', () => {
      const fees = [fee({ fee_label: 'Per-issued payment request fee', recurring_fee_id: undefined })]
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'Per-issued payment request fee')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.timing).toBe('invoice_at_period_end')
    })

    it('§10 — ambiguous: two fresh fees share the identical fee_label with no id -> neither inherits via the label fallback (fails closed)', () => {
      const fees = [
        fee({ fee_label: 'Usage fee', recurring_fee_id: undefined }),
        fee({ fee_label: 'Usage fee', recurring_fee_id: undefined, metric_name: 'other_metric' }),
      ]
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'Usage fee')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(true)
      expect(merged[1].variable_invoice_timing?.requires_confirmation).toBe(true)
    })

    it('an id-keyed match takes priority over an (unsafe, ambiguous) shared label among other fees in the same batch', () => {
      const fees = [
        fee({ fee_label: 'Usage fee', recurring_fee_id: 'rf-a' }),
        fee({ fee_label: 'Usage fee', recurring_fee_id: 'rf-b' }),
      ]
      const audit = [
        auditRow({ timing: 'invoice_at_period_end' }, 'recurring_fee:rf-a'),
        auditRow({ timing: 'invoice_at_next_period_start' }, 'recurring_fee:rf-b'),
      ]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.timing).toBe('invoice_at_period_end')
      expect(merged[1].variable_invoice_timing?.timing).toBe('invoice_at_next_period_start')
    })

    it('§11 — organization-policy provenance is opaque to this merge (decision_provenance lives on the audit row, untouched by timing-value comparison)', () => {
      const fees = [fee({ fee_label: 'Per-completed payment success fee', recurring_fee_id: 'rf-abc' })]
      // The merge only ever reads approved_interpretation.timing — provenance
      // itself is a separate column this function never inspects or strips.
      const audit = [auditRow({ timing: 'invoice_at_period_end' }, 'recurring_fee:rf-abc')]
      const merged = mergeVariableInvoiceTimingForFees(fees, audit)
      expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(false)
    })
  })
})

describe('recurringFeeDecisionKey', () => {
  it('produces the shared synthetic key format for a real id', () => {
    expect(recurringFeeDecisionKey('rf-abc')).toBe('recurring_fee:rf-abc')
  })
  it('returns null for a missing/undefined id', () => {
    expect(recurringFeeDecisionKey(undefined)).toBeNull()
    expect(recurringFeeDecisionKey(null)).toBeNull()
  })
})

// Step 17H.4B0D4H1B4E3.4.2 — recurring_fee_proration used the identical
// fee_label-only addressing variable_invoice_timing had BEFORE E3.4.1, and
// (unlike variable_invoice_timing) had NO merge/preservation at all before
// this pass — additional_recurring_fees[].proration was blindly overwritten
// by every re-extraction. Same doctrine/tests as variable_invoice_timing's
// own E3.4.1 suite, mirrored exactly via the shared resolveRecurringFeeAudit
// helper both merges now use.
describe('mergeRecurringFeeProrationForFees (per-fee, recurring_fee_id-first with legacy fee_label bridge)', () => {
  function fee(overrides: Partial<AdditionalRecurringFee> = {}): AdditionalRecurringFee {
    return {
      fee_label: 'Support tier', metric_name: null, rate_per_unit: null,
      amount: 100, percentage_of_basis: null,
      proration: prorationRule(),
      ...overrides,
    } as AdditionalRecurringFee
  }

  it('§6 — an ID-stable fee keeps its confirmed proration decision across a changed fee_label', () => {
    const fees = [fee({ fee_label: 'Support package (renamed)', recurring_fee_id: 'rf-abc' })]
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' }, 'recurring_fee:rf-abc')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.prorate_partial_periods).toBe(true)
    expect(merged[0].proration?.requires_confirmation).toBe(false)
  })

  it('§7 — same/similar label but a DIFFERENT recurring_fee_id does not inherit the decision', () => {
    const fees = [fee({ fee_label: 'Support tier', recurring_fee_id: 'rf-different' })]
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' }, 'recurring_fee:rf-abc')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.requires_confirmation).toBe(true)
    expect(merged[0].proration?.prorate_partial_periods).toBe('unclear')
  })

  it('§8 — a changed mechanism (fresh id assigned by preserveRecurringFeeIdentity) does not silently inherit the old decision', () => {
    const fees = [fee({ fee_label: 'Support tier', recurring_fee_id: 'rf-fresh-new-mechanism' })]
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' }, 'recurring_fee:rf-old-mechanism')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.requires_confirmation).toBe(true)
  })

  it('§5 — a unique legacy no-ID fee still resolves its decision via the fee_label-keyed audit row', () => {
    const fees = [fee({ fee_label: 'Support tier', recurring_fee_id: undefined })]
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' }, 'Support tier')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.prorate_partial_periods).toBe(true)
    expect(merged[0].proration?.requires_confirmation).toBe(false)
  })

  it('§9 — two no-ID legacy fees sharing one fee_label fail closed, never arbitrarily attach the decision to either', () => {
    const fees = [
      fee({ fee_label: 'Support tier', recurring_fee_id: undefined }),
      fee({ fee_label: 'Support tier', recurring_fee_id: undefined, amount: 200 }),
    ]
    const audit = [auditRow({ prorate_partial_periods: true, reset_anchor: 'contract_start' }, 'Support tier')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.requires_confirmation).toBe(true)
    expect(merged[1].proration?.requires_confirmation).toBe(true)
  })

  it('§11 — decision_provenance on the audit row is opaque to this merge (only approved_interpretation.prorate_partial_periods/reset_anchor are read)', () => {
    const fees = [fee({ fee_label: 'Support tier', recurring_fee_id: 'rf-abc' })]
    const audit = [auditRow({ prorate_partial_periods: false, reset_anchor: 'calendar' }, 'recurring_fee:rf-abc')]
    const merged = mergeRecurringFeeProrationForFees(fees, audit)
    expect(merged[0].proration?.prorate_partial_periods).toBe(false)
    expect(merged[0].proration?.reset_anchor).toBe('calendar')
    expect(merged[0].proration?.requires_confirmation).toBe(false)
  })

  it('a fee with no matching audit row at all is left as fresh extraction produced it', () => {
    const fees = [fee({ fee_label: 'Brand new fee', recurring_fee_id: 'rf-new' })]
    const merged = mergeRecurringFeeProrationForFees(fees, [])
    expect(merged[0].proration?.prorate_partial_periods).toBe('unclear')
  })
})

describe('preserveDiscountIdentity — structural fingerprint, not description text', () => {
  it('§11 — description text drifting between extractions (LLM wording non-determinism) does NOT break identity continuity', () => {
    const existing = [discount({ discount_rule_id: 'abc123', description: 'A 90-day pilot waiver on the platform fee', interpretation: { discount_type: 'flat_percentage', discount_basis: 'percentage', tier_method: null, tiers: null, applies_to: null, application_order: null, reset_period: null, worked_example: null, requires_confirmation: false, confirmation_reason: null } })]
    const fresh = [discount({ discount_rule_id: undefined, description: 'Ninety-day pilot period with the platform subscription fee waived', interpretation: null })]
    const merged = preserveDiscountIdentity(existing, fresh)
    expect(merged[0].discount_rule_id).toBe('abc123')
    expect(merged[0].interpretation).not.toBeNull()
  })

  it('a genuinely different discount (different structural shape) does NOT reuse identity merely because both are "introductory"', () => {
    const existing = [discount({ discount_rule_id: 'abc123', start_date: '2026-01-01', end_date: '2026-03-31', duration_months: 3 })]
    const fresh = [discount({ discount_rule_id: undefined, start_date: '2026-06-01', end_date: '2026-12-31', duration_months: 7, interpretation: null })]
    const merged = preserveDiscountIdentity(existing, fresh)
    expect(merged[0].discount_rule_id).toBeUndefined()
    expect(merged[0].interpretation).toBeNull()
  })

  it('a value correction (discount_pct changes) alone does not break identity — mirrors tier rate_per_unit exclusion from fingerprint', () => {
    const existing = [discount({ discount_rule_id: 'abc123', discount_pct: 10 })]
    const fresh = [discount({ discount_rule_id: undefined, discount_pct: 15, interpretation: null })]
    const merged = preserveDiscountIdentity(existing, fresh)
    expect(merged[0].discount_rule_id).toBe('abc123')
    // the corrected value itself is NOT overwritten by the old one
    expect(merged[0].discount_pct).toBe(15)
  })

  it('ambiguous: two existing discounts share the identical structural fingerprint -> never reuse (fail closed)', () => {
    const existing = [
      discount({ discount_rule_id: 'abc123' }),
      discount({ discount_rule_id: 'def456' }),
    ]
    const fresh = [discount({ discount_rule_id: undefined, interpretation: null })]
    const merged = preserveDiscountIdentity(existing, fresh)
    expect(merged[0].discount_rule_id).toBeUndefined()
  })

  it('ambiguous: two fresh discounts share the identical structural fingerprint -> never reuse for either', () => {
    const existing = [discount({ discount_rule_id: 'abc123' })]
    const fresh = [discount({ discount_rule_id: 'x1', interpretation: null }), discount({ discount_rule_id: 'x2', interpretation: null })]
    const merged = preserveDiscountIdentity(existing, fresh)
    expect(merged[0].discount_rule_id).toBe('x1')
    expect(merged[1].discount_rule_id).toBe('x2')
  })

  it('no prior discount exists -> fresh discount keeps its own freshly-assigned id, no interpretation', () => {
    const fresh = [discount({ discount_rule_id: 'freshly-assigned', interpretation: null })]
    const merged = preserveDiscountIdentity([], fresh)
    expect(merged[0].discount_rule_id).toBe('freshly-assigned')
    expect(merged[0].interpretation).toBeNull()
  })
})
