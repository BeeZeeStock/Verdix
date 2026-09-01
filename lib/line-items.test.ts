import { describe, it, expect } from 'vitest'
import { buildLineItems, isRecurringBaseFeeLineItem, computeReviewerCorrectedFieldsUpdate, checkLineItemCorrectionGate } from './line-items'
import { computeBaseTcv, computeCommittedFixedFees } from './contract-tcv-calc'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A, items 7/8/13 — grounded in the actual Remembill_Kundavtal_SV.pdf
// bug: a "€0.38 per issued payment request" per-unit fee was extracted with
// the contract's 12-month TERM used as its billing QUANTITY, producing a
// fabricated committed total (€18,024.96) that included two operational
// rates that should never have contributed a fixed amount at all.
// ═══════════════════════════════════════════════════════════════════════════

function baseTerms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    customer_name: 'NordicFit Test AB', currency: 'EUR', one_time_fees: [],
    discounts: [], service_credits: [], overage_tiers: [], escalators: [],
    additional_recurring_fees: [],
    ...overrides,
  } as ContractTerms
}

describe('item 7 — a per-unit/variable-rate recurring fee never gets a fixed committed quantity', () => {
  it('a 12-month contract does NOT create quantity 12 for a per-event fee (the actual Remembill bug)', () => {
    const terms = baseTerms({
      contract_start_date: '2026-10-01', contract_term_months: 12, billing_frequency: 'monthly',
      additional_recurring_fees: [
        { fee_label: 'Per payment request fee', amount: 0, description: null, metric_name: 'issued_payment_request', rate_per_unit: 0.38 },
        { fee_label: 'Success fee per completed payment', amount: 0, description: null, metric_name: 'completed_payment', rate_per_unit: 1.7 },
      ],
    })
    const items = buildLineItems(terms, 'EUR')
    const requestFee = items.find(i => i.product_name === 'Per payment request fee')
    const successFee = items.find(i => i.product_name === 'Success fee per completed payment')
    expect(requestFee).toBeDefined()
    expect(successFee).toBeDefined()
    // Never 12 (the contract's term length), never any fixed quantity at all.
    expect(requestFee!.quantity).toBe(0)
    expect(successFee!.quantity).toBe(0)
    expect(requestFee!.total_amount).toBe(0)
    expect(successFee!.total_amount).toBe(0)
    // The rate itself stays visible (unit_price), for reviewer/UI context —
    // "extracted, not dropped" (item 11), just contributing nothing fixed.
    expect(requestFee!.unit_price).toBe(0.38)
    expect(successFee!.unit_price).toBe(1.7)
  })

  it('an ordinary FIXED additional recurring fee is unaffected — still gets a real committed quantity', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      additional_recurring_fees: [
        { fee_label: 'Dedicated Support', amount: 1200, description: null },
      ],
    })
    const items = buildLineItems(terms, 'EUR')
    const support = items.find(i => i.product_name === 'Dedicated Support')
    expect(support).toBeDefined()
    expect(support!.quantity).toBe(12)
    expect(support!.total_amount).toBe(14400)
  })
})

describe('item 8 — committed fixed fees exclude operational/usage rates', () => {
  it('computeCommittedFixedFees never includes a per-unit fee\'s (zero) contribution as if it were meaningfully committed', () => {
    const terms = baseTerms({
      contract_start_date: '2026-10-01', contract_term_months: 12, billing_frequency: 'monthly', base_monthly_fee: 2000,
      additional_recurring_fees: [
        { fee_label: 'Per payment request fee', amount: 0, description: null, metric_name: 'issued_payment_request', rate_per_unit: 0.38 },
        { fee_label: 'Success fee per completed payment', amount: 0, description: null, metric_name: 'completed_payment', rate_per_unit: 1.7 },
      ],
    })
    const items = buildLineItems(terms, 'EUR')
    const committed = computeCommittedFixedFees(items)
    const baseTotal = computeBaseTcv(items)
    // Only the recurring base fee (12 x 2000 = 24000) contributes — the two
    // per-unit fees contribute exactly 0, never €0.38x12 + €1.70x12 (4.56 +
    // 20.40) folded into a false "committed" total.
    expect(committed).toBe(24000)
    expect(baseTotal).toBe(24000)
  })
})

describe('item 13 — fixed-fee band provenance is preserved, not flattened', () => {
  it('base_monthly_fee stays the selected band\'s fee; base_fee_bands/base_fee_committed_volume preserve the full causal chain', () => {
    const terms = baseTerms({
      contract_start_date: '2026-10-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_committed_volume: 5000,
      base_fee_bands: [
        { from_unit: 1, to_unit: 500, monthly_fee: 500 },
        { from_unit: 501, to_unit: 1500, monthly_fee: 1200 },
        { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 },
      ],
    })
    // buildLineItems still only ever consumes the resolved base_monthly_fee
    // — no behavior change to the pricing engine itself.
    const items = buildLineItems(terms, 'EUR')
    const base = items.find(i => i.product_name === 'Recurring base fee')
    expect(base).toBeDefined()
    expect(base!.unit_price).toBe(2000)
    // The causal chain itself lives on contract_terms, fully intact.
    expect(terms.base_fee_committed_volume).toBe(5000)
    expect(terms.base_fee_bands).toHaveLength(3)
    expect(terms.base_fee_bands![2]).toEqual({ from_unit: 1501, to_unit: 5000, monthly_fee: 2000 })
  })
})

describe('Step 17C.3b, item A — a percentage-of-basis fee is never duplicated as a generic line item', () => {
  it('the fresh Remembill output\'s performance-share fee (percentage_of_basis compiled) does not appear in buildLineItems at all — PerformanceShareCard is its sole representation', () => {
    const terms = buildRemembillFixtureTerms()
    const items = buildLineItems(terms, terms.currency)

    const performanceShareItems = items.filter(i => i.product_name === 'Performance share (value-weighted payment rate)')
    expect(performanceShareItems).toHaveLength(0)

    // Every OTHER additional_recurring_fees entry on this same fixture (the
    // ordinary per-unit fees) is unaffected — this isn't a blanket
    // suppression of the fee array, only of the percentage_of_basis shape.
    expect(items.some(i => i.product_name === 'Per payment request fee')).toBe(true)
    expect(items.some(i => i.product_name === 'Success fee per completed payment')).toBe(true)
  })

  it('a genuine independent €0 included-usage overage tier is NOT suppressed by this change', () => {
    const terms = baseTerms({
      overage_tiers: [
        { tier_label: 'Included SMS reminders 1–500', from_unit: 1, to_unit: 500, rate_per_unit: 0, unit_type: 'SMS reminder' },
      ],
    })
    const items = buildLineItems(terms, 'EUR')
    const includedTier = items.find(i => i.product_name === 'Included SMS reminders 1–500')
    expect(includedTier).toBeDefined()
    expect(includedTier!.unit_price).toBe(0)
  })

  it('a fee with percentage_of_basis but zero amount and no variable rate contributes nothing to this table (fully replaced by the dedicated card)', () => {
    const terms = baseTerms({
      contract_start_date: '2026-10-01', contract_term_months: 12, billing_frequency: 'monthly',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null, unresolved_kind: null,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    })
    const items = buildLineItems(terms, 'EUR')
    expect(items.find(i => i.product_name === 'Performance share')).toBeUndefined()
  })

  // Step 17E, item 3 — the OLD guard (`!fee.amount && !isVariableRate`)
  // only worked because a percentage_of_basis fee never ALSO had
  // metric_name/rate_per_unit set. That was never structurally enforced —
  // a fee could in principle carry both shapes. This proves the fix is
  // unconditional: percentage_of_basis alone is enough to suppress the
  // row, even when isVariableRate would independently have been true.
  it('percentage_of_basis suppresses the row even when the fee ALSO looks like a variable-rate per-unit fee', () => {
    const terms = baseTerms({
      contract_start_date: '2026-10-01', contract_term_months: 12, billing_frequency: 'monthly',
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null, unresolved_kind: null,
        metric_name: 'value-weighted payment rate', rate_per_unit: 5,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    })
    const items = buildLineItems(terms, 'EUR')
    expect(items.find(i => i.product_name === 'Performance share')).toBeUndefined()
  })
})

describe('Step 17E, item 4 — confirmed base_fee_proration clears the stale "Pending interpretation" state', () => {
  it('unresolved requires_confirmation:true emits the placeholder marker row (Qty 0 / Total 0), resolved requires_confirmation:false emits the real computed schedule — never both, never the placeholder once resolved', () => {
    const sharedFields: Partial<ContractTerms> = {
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
    }

    const unresolved = baseTerms({
      ...sharedFields,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: 'unclear', requires_confirmation: true, confirmation_reason: 'pilot waiver expiry unclear' },
    })
    const unresolvedItems = buildLineItems(unresolved, 'EUR').filter(i => isRecurringBaseFeeLineItem(i.product_name))
    expect(unresolvedItems).toHaveLength(1)
    expect(unresolvedItems[0]).toMatchObject({ product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, total_amount: 0 })

    // This is EXACTLY what confirm-rule/route.ts's base_fee_proration
    // branch does after the reviewer confirms: the SAME terms with only
    // requires_confirmation flipped to false (buildPeriodProrationRule's
    // own guaranteed output shape).
    const resolved = baseTerms({
      ...sharedFields,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
    })
    const resolvedItems = buildLineItems(resolved, 'EUR').filter(i => isRecurringBaseFeeLineItem(i.product_name))
    expect(resolvedItems.length).toBeGreaterThan(0)
    expect(resolvedItems.every(i => i.product_name !== 'Recurring base fee — partial-period treatment unresolved')).toBe(true)
    expect(resolvedItems.some(i => i.total_amount > 0)).toBe(true)
    expect(resolvedItems.some(i => i.product_name === 'Recurring base fee')).toBe(true)
  })
})

describe('Step 17E, item 4 — isRecurringBaseFeeLineItem identifies exactly the recurring-base-fee-block product_name shapes', () => {
  it('matches every shape the recurring-base-fee block can produce', () => {
    expect(isRecurringBaseFeeLineItem('Base subscription')).toBe(true)
    expect(isRecurringBaseFeeLineItem('Recurring base fee')).toBe(true)
    expect(isRecurringBaseFeeLineItem('Recurring base fee — partial-period treatment unresolved')).toBe(true)
    expect(isRecurringBaseFeeLineItem('Recurring base fee (periods 1–3)')).toBe(true)
    expect(isRecurringBaseFeeLineItem('Recurring base fee (periods 4–12)')).toBe(true)
  })

  it('never matches an unrelated row — overage tiers, one-time fees, other additional recurring fees, escalators', () => {
    expect(isRecurringBaseFeeLineItem('Per payment request fee')).toBe(false)
    expect(isRecurringBaseFeeLineItem('Included SMS reminders 1–500')).toBe(false)
    expect(isRecurringBaseFeeLineItem('Implementation fee')).toBe(false)
    expect(isRecurringBaseFeeLineItem('Price escalator (3% cpi)')).toBe(false)
    expect(isRecurringBaseFeeLineItem('Performance share')).toBe(false)
  })
})

describe('Step 17H.4B0D2 — every buildLineItems row starts under full correction tracking', () => {
  const fullTerms: ContractTerms = {
    customer_name: 'Acme Co',
    currency: 'EUR',
    contract_start_date: '2026-01-01',
    contract_end_date: '2026-12-31',
    contract_term_months: 12,
    billing_frequency: 'monthly',
    base_monthly_fee: 1000,
    additional_recurring_fees: [
      { fee_label: 'Support tier', amount: 200, description: null },
      { fee_label: 'Chargeback fee', amount: 0, metric_name: 'chargeback', rate_per_unit: 195, description: null },
    ],
    overage_tiers: [
      { tier_label: 'Calls 1–10,000', from_unit: 1, to_unit: 10000, rate_per_unit: 0.02, unit_type: 'API call' },
    ],
    one_time_fees: [{ fee_label: 'Setup fee', amount: 5000, due_date: null, description: null }],
    escalators: [{ escalator_pct: 5, escalator_type: 'fixed_pct', effective_date: null, applies_from_year: 2, cap_pct: null, description: '5% annual increase' }],
  } as unknown as ContractTerms

  it('every row kind (base fee, recurring fee, variable-rate fee, tier, one-time fee, escalator) is emitted with fresh, fully-tracked metadata', () => {
    const items = buildLineItems(fullTerms, 'EUR')
    expect(items.length).toBeGreaterThan(4)
    for (const item of items as Array<Record<string, unknown>>) {
      expect(item.reviewer_corrected_fields).toEqual([])
      expect(item.reviewer_corrected_fields_complete).toBe(true)
      expect(item.reviewer_corrected_at).toBeNull()
    }
  })

  it('a job with only a flat base fee (no dates/schedule) still gets tracking defaults', () => {
    const items = buildLineItems({ customer_name: 'X', currency: 'EUR', base_monthly_fee: 500 } as unknown as ContractTerms, 'EUR')
    expect(items).toHaveLength(1)
    expect((items[0] as Record<string, unknown>).reviewer_corrected_fields).toEqual([])
    expect((items[0] as Record<string, unknown>).reviewer_corrected_fields_complete).toBe(true)
  })

  it('an unresolved base_fee_proration placeholder row also carries fresh tracking defaults', () => {
    const items = buildLineItems({
      customer_name: 'X', currency: 'EUR', base_monthly_fee: 500,
      contract_start_date: '2026-01-01', contract_term_months: 6,
      base_fee_proration: { requires_confirmation: true, mode: null, effective_date: null, confirmation_reason: 'ambiguous' },
    } as unknown as ContractTerms, 'EUR')
    expect(items).toHaveLength(1)
    expect((items[0] as Record<string, unknown>).reviewer_corrected_fields).toEqual([])
    expect((items[0] as Record<string, unknown>).reviewer_corrected_fields_complete).toBe(true)
  })
})

describe('Step 17H.4B0D4B0B — buildLineItems propagates one_time_fees[].fee_id, and ONLY there', () => {
  const termsWithFeeId: ContractTerms = {
    customer_name: 'Acme Co',
    currency: 'EUR',
    contract_start_date: '2026-01-01',
    contract_end_date: '2026-12-31',
    contract_term_months: 12,
    billing_frequency: 'monthly',
    base_monthly_fee: 1000,
    additional_recurring_fees: [{ fee_label: 'Support tier', amount: 200, description: null }],
    overage_tiers: [
      { tier_label: 'Calls 1–10,000', from_unit: 1, to_unit: 10000, rate_per_unit: 0.02, unit_type: 'API call' },
    ],
    one_time_fees: [
      { fee_label: 'Setup fee', amount: 5000, due_date: null, description: null, fee_id: 'fee-abc-123' },
      { fee_label: 'Legacy fee', amount: 1000, due_date: null, description: null }, // no fee_id — predates it
    ],
    escalators: [{ escalator_pct: 5, escalator_type: 'fixed_pct', effective_date: null, applies_from_year: 2, cap_pct: null, description: '5% annual increase' }],
  } as unknown as ContractTerms

  it('a one-time fee WITH a fee_id: the emitted line item receives the same fee_id', () => {
    const items = buildLineItems(termsWithFeeId, 'EUR') as Array<Record<string, unknown>>
    const setupRow = items.find(i => i.product_name === 'Setup fee')
    expect(setupRow?.fee_id).toBe('fee-abc-123')
  })

  it('a one-time fee WITHOUT a fee_id: the emitted line item receives null (never manufactured here)', () => {
    const items = buildLineItems(termsWithFeeId, 'EUR') as Array<Record<string, unknown>>
    const legacyRow = items.find(i => i.product_name === 'Legacy fee')
    expect(legacyRow?.fee_id).toBeNull()
  })

  it('every non-one-time family (base fee, additional recurring fee, tier, escalator) never receives a one-time fee_id', () => {
    const items = buildLineItems(termsWithFeeId, 'EUR') as Array<Record<string, unknown>>
    const nonOneTime = items.filter(i => i.billing_period !== 'one_time')
    expect(nonOneTime.length).toBeGreaterThan(0)
    for (const row of nonOneTime) {
      expect(row.fee_id).toBeUndefined()
    }
  })
})

describe('Step 17H.4B0D4B1B0E — buildLineItems propagates overage_tiers[].tier_id, and ONLY there', () => {
  const termsWithTierId: ContractTerms = {
    customer_name: 'Acme Co',
    currency: 'EUR',
    contract_start_date: '2026-01-01',
    contract_end_date: '2026-12-31',
    contract_term_months: 12,
    billing_frequency: 'monthly',
    base_monthly_fee: 1000,
    additional_recurring_fees: [
      { fee_label: 'Support tier', amount: 200, description: null },
      { fee_label: 'API overage surcharge', amount: null, metric_name: 'api_call', rate_per_unit: 0.01, description: null },
    ],
    overage_tiers: [
      { tier_label: 'Calls 1–10,000', from_unit: 1, to_unit: 10000, rate_per_unit: 0.02, unit_type: 'API call', tier_id: 'tier-abc-123' },
      { tier_label: 'Calls 10,001+', from_unit: 10001, to_unit: null, rate_per_unit: 0.01, unit_type: 'API call' }, // no tier_id — legacy
      { tier_label: 'SMS 1–500', from_unit: 1, to_unit: 500, rate_per_unit: 0.05, unit_type: 'SMS reminder', tier_id: 'tier-sms-999' },
    ],
    one_time_fees: [
      { fee_label: 'Setup fee', amount: 5000, due_date: null, description: null, fee_id: 'fee-abc-123' },
    ],
    escalators: [{ escalator_pct: 5, escalator_type: 'fixed_pct', effective_date: null, applies_from_year: 2, cap_pct: null, description: '5% annual increase' }],
  } as unknown as ContractTerms

  it('a tier WITH a tier_id: the emitted line item receives the identical tier_id verbatim', () => {
    const items = buildLineItems(termsWithTierId, 'EUR') as Array<Record<string, unknown>>
    const row = items.find(i => i.product_name === 'Calls 1–10,000')
    expect(row?.tier_id).toBe('tier-abc-123')
  })

  it('a tier WITHOUT a tier_id: the emitted line item receives null (never manufactured here)', () => {
    const items = buildLineItems(termsWithTierId, 'EUR') as Array<Record<string, unknown>>
    const row = items.find(i => i.product_name === 'Calls 10,001+')
    expect(row?.tier_id).toBeNull()
  })

  it('two tiers each retain their own distinct tier_id — no cross-contamination, no truncation/normalization', () => {
    const items = buildLineItems(termsWithTierId, 'EUR') as Array<Record<string, unknown>>
    const apiTier = items.find(i => i.product_name === 'Calls 1–10,000')
    const smsTier = items.find(i => i.product_name === 'SMS 1–500')
    expect(apiTier?.tier_id).toBe('tier-abc-123')
    expect(smsTier?.tier_id).toBe('tier-sms-999')
  })

  it('additional-recurring variable-rate fee (quantity=0, structurally similar to a tier row) never receives a tier_id', () => {
    const items = buildLineItems(termsWithTierId, 'EUR') as Array<Record<string, unknown>>
    const row = items.find(i => i.product_name === 'API overage surcharge')
    expect(row?.quantity).toBe(0)
    expect(row?.tier_id).toBeUndefined()
  })

  it('base fee, one-time fee, and escalator rows never receive a tier_id; one-time fee_id behavior is unaffected', () => {
    const items = buildLineItems(termsWithTierId, 'EUR') as Array<Record<string, unknown>>
    const baseFee = items.find(i => i.product_name === 'Recurring base fee' || i.product_name === 'Base subscription')
    const oneTime = items.find(i => i.product_name === 'Setup fee')
    const escalator = items.find(i => typeof i.product_name === 'string' && (i.product_name as string).startsWith('Price escalator'))
    expect(baseFee?.tier_id).toBeUndefined()
    expect(oneTime?.tier_id).toBeUndefined()
    expect(oneTime?.fee_id).toBe('fee-abc-123')
    expect(escalator?.tier_id).toBeUndefined()
  })
})

describe('computeReviewerCorrectedFieldsUpdate — Step 17H.4B0D2', () => {
  const now = '2026-09-08T00:00:00.000Z'

  it('a legacy row (prior fields NULL) receiving its first correction gets exactly that field', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price'], fields: { unit_price: 0.75 }, priorReviewerCorrectedFields: null, now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['unit_price'], reviewer_corrected_at: now })
  })

  it('a new fully-tracked row (prior fields []) receiving its first correction gets exactly that field', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price'], fields: { unit_price: 0.75 }, priorReviewerCorrectedFields: [], now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['unit_price'], reviewer_corrected_at: now })
  })

  it('a second, different field union-merges with the prior array — never erases it', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['quantity'], fields: { quantity: 4 }, priorReviewerCorrectedFields: ['unit_price'], now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['quantity', 'unit_price'], reviewer_corrected_at: now })
  })

  it('the same field corrected twice does not create a duplicate array member', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price'], fields: { unit_price: 0.9 }, priorReviewerCorrectedFields: ['unit_price'], now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['unit_price'], reviewer_corrected_at: now })
  })

  it('confirm-as-is (no markReviewerCorrectedFields at all) marks nothing — returns null', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: undefined, fields: { confidence_score: 1 }, priorReviewerCorrectedFields: null, now,
    })
    expect(result).toBeNull()
  })

  it('a claimed field not actually present in this request\'s fields is dropped, never trusted as a bare claim', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price'], fields: { confidence_score: 1 }, priorReviewerCorrectedFields: null, now,
    })
    expect(result).toBeNull()
  })

  it('a field outside the typed allowlist is dropped even if present in fields', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['confidence_score'], fields: { confidence_score: 1 }, priorReviewerCorrectedFields: null, now,
    })
    expect(result).toBeNull()
  })

  it('total_amount is never marked merely because it was recomputed alongside a genuinely-authored unit_price', () => {
    // The caller (page.tsx) only ever sends ['unit_price'] even though
    // `fields` also includes a derived total_amount — proving the function
    // itself never infers additional marks beyond what was explicitly
    // requested and validated.
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price'], fields: { unit_price: 0.75, total_amount: 750 }, priorReviewerCorrectedFields: null, now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['unit_price'], reviewer_corrected_at: now })
  })

  it('mixed valid and invalid requested marks: only the valid, genuinely-changing ones survive', () => {
    const result = computeReviewerCorrectedFieldsUpdate({
      requestedMarks: ['unit_price', 'confidence_score', 'quantity'],
      fields: { unit_price: 0.75, confidence_score: 1 },
      priorReviewerCorrectedFields: null, now,
    })
    expect(result).toEqual({ reviewer_corrected_fields: ['unit_price'], reviewer_corrected_at: now })
  })
})

describe('checkLineItemCorrectionGate — Step 17H.4B0D3B', () => {
  it('a current row (superseded_at null) is ok', () => {
    expect(checkLineItemCorrectionGate({ superseded_at: null })).toEqual({ status: 'ok' })
  })

  it('a superseded row (superseded_at set) is rejected', () => {
    expect(checkLineItemCorrectionGate({ superseded_at: '2026-09-10T00:00:00.000Z' })).toEqual({ status: 'superseded' })
  })

  it('a genuinely missing row (existing === null) is not_found, never conflated with superseded', () => {
    expect(checkLineItemCorrectionGate(null)).toEqual({ status: 'not_found' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Surgical generic rule — Eliminate duplicated extracted-amount surfaces.
// The configure page's Commercial BoM table is the single WHAT authority;
// the standalone "Verify extracted amounts"/"Pricing" section was removed
// and its correction affordance colocated directly on each BoM row
// (item.confidence_score < 0.95), reusing the exact same correction()/
// setCorr()/CorrectionInput mechanism, never a per-family special case.
// These tests prove the DATA-MODEL foundation that makes that generic,
// family-agnostic gate correct: every economic component (fixed base fee
// however it's expressed — flat, year-priced, or ramped — a per-unit tier
// rate, a one-time fee) collapses into exactly ONE family of buildLineItems
// rows, never a second, differently-shaped duplicate, and every item
// independently carries the confidence_score field the generic gate reads.
// Uses arbitrary contract shapes/values throughout — no customer name,
// section number, amount, currency, or fee family is hardcoded to any real
// fixture.
// ═══════════════════════════════════════════════════════════════════════════
describe('surgical generic rule — fixed-fee value representation collapses to one family, regardless of shape', () => {
  it('year_pricing alone (no base_monthly_fee) produces Recurring-base-fee-family rows, never a separate "pricing" item', () => {
    const terms = baseTerms({
      customer_name: 'Acme Test Co', contract_start_date: '2027-01-01', contract_term_months: 24, billing_frequency: 'monthly',
      year_pricing: { year1: 12000, year2: 18000 },
    })
    const items = buildLineItems(terms, 'USD')
    expect(items.some(i => /pricing/i.test(i.product_name))).toBe(false)
    expect(items.some(i => isRecurringBaseFeeLineItem(i.product_name))).toBe(true)
    // The year-over-year step-up is real: at least two distinct recurring
    // rows exist (one per rate), never collapsed into a single flat figure.
    const recurring = items.filter(i => isRecurringBaseFeeLineItem(i.product_name))
    expect(recurring.length).toBeGreaterThanOrEqual(2)
  })

  it('ramp_schedule alone (no base_monthly_fee, no year_pricing) produces Recurring-base-fee-family rows, never a separate "ramp" item', () => {
    const terms = baseTerms({
      customer_name: 'Globex Test Ltd', contract_start_date: '2027-03-01', contract_term_months: 12, billing_frequency: 'monthly',
      ramp_schedule: [
        { label: 'Ramp step 1', monthly_fee: 500, start_date: '2027-03-01', end_date: '2027-05-31' },
        { label: 'Ramp step 2', monthly_fee: 900, start_date: '2027-06-01', end_date: '2028-02-28' },
      ],
    })
    const items = buildLineItems(terms, 'GBP')
    expect(items.some(i => /ramp/i.test(i.product_name))).toBe(false)
    expect(items.some(i => isRecurringBaseFeeLineItem(i.product_name))).toBe(true)
  })

  it('a plain flat base_monthly_fee (no dates, the simple fallback shape) still produces the same recurring-base-fee family, not a distinct "monthly fee" item', () => {
    const terms = baseTerms({ customer_name: 'Initech Test Inc', base_monthly_fee: 750 })
    const items = buildLineItems(terms, 'SEK')
    expect(items.some(i => isRecurringBaseFeeLineItem(i.product_name))).toBe(true)
  })
})

describe('surgical generic rule — every commercial-component family independently carries confidence_score, so the same generic low-confidence gate applies without per-family special-casing', () => {
  it('fixed, variable/tier, and one-time rows all expose their own confidence_score field on an arbitrary mixed contract', () => {
    const terms = baseTerms({
      customer_name: 'Umbrella Test Group', contract_start_date: '2027-05-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 1100,
      overage_tiers: [
        { unit_type: 'widget', tier_label: 'Widgets 1-1000', from_unit: 1, to_unit: 1000, rate_per_unit: 0.05 },
      ],
      one_time_fees: [
        { fee_label: 'Setup', amount: 3000, due_date: null, description: null },
      ],
    })
    const items = buildLineItems(terms, 'NOK')
    const fixed = items.find(i => isRecurringBaseFeeLineItem(i.product_name))
    const tier = items.find(i => i.product_name === 'Widgets 1-1000')
    const oneTime = items.find(i => i.product_name === 'Setup')
    expect(fixed).toBeDefined()
    expect(tier).toBeDefined()
    expect(oneTime).toBeDefined()
    for (const item of [fixed, tier, oneTime]) {
      expect(typeof item!.confidence_score).toBe('number')
    }
  })
})
