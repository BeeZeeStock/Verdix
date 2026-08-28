import { describe, it, expect } from 'vitest'
import { buildLineItems } from './line-items'
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
})
