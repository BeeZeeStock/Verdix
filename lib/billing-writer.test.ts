import { describe, it, expect } from 'vitest'
import { monthCursor, computeDiscountMultiplier, computeEscalatorMultiplier, computeBillingSchedule, computeFixedFeePeriodAmount } from './billing-writer'
import type { ContractTerms } from './types'

// Only a handful of ContractTerms fields are ever read by the functions
// under test here — the rest of the (very large) interface is irrelevant to
// billing math, so the fixture is deliberately partial and cast, same
// pattern lib/contract-extractor.ts itself already uses for test/parse data.
function terms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    discounts: [],
    escalators: [],
    ...overrides,
  } as ContractTerms
}

describe('monthCursor', () => {
  it('preserves the contract start day-of-month, not day 1', () => {
    // The bug this guards: a contract starting 2026-08-11 previously walked
    // months via new Date(y, m, 1) — day pinned to 1 — so a discount window
    // anchored to 2026-08-11 never matched period 1's cursor (2026-08-01),
    // shifting every discount/ramp/escalator comparison one period late.
    const start = new Date(2026, 7, 11) // 11 Aug 2026
    expect(monthCursor(start, 0)).toEqual(new Date(2026, 7, 11))
    expect(monthCursor(start, 1)).toEqual(new Date(2026, 8, 11))
    expect(monthCursor(start, 3)).toEqual(new Date(2026, 10, 11))
  })
})

describe('computeFixedFeePeriodAmount — Step 17C.2b, item D (the one shared fixed-fee-period arithmetic step)', () => {
  it('(base + additional) * escalator * discount, no surprises', () => {
    expect(computeFixedFeePeriodAmount(2000, 500, 1, 1)).toBe(2500)
    expect(computeFixedFeePeriodAmount(2000, 0, 1.1, 1)).toBeCloseTo(2200, 6)
    expect(computeFixedFeePeriodAmount(2000, 0, 1, 0.75)).toBe(1500)
    expect(computeFixedFeePeriodAmount(5000, 200, 1.05, 0.9)).toBeCloseTo((5000 + 200) * 1.05 * 0.9, 6)
  })

  it('is EXACTLY the function computeBillingSchedule\'s own flat/contract-anchored branch uses for a simple one-month period — proving there is no second, independently-drifting copy of this formula', () => {
    const contractTerms = terms({
      contract_start_date: '2027-01-01', contract_term_months: 1, billing_frequency: 'monthly',
      base_monthly_fee: 2000, additional_recurring_fees: [{ fee_label: 'Extra', amount: 300, description: null, source_clause: null, required_operational_inputs: null, unresolved_kind: null, derived_metric: null, percentage_of_basis: null, proration: null, source_sections: null, billing_frequency: null }],
    })
    const periods = computeBillingSchedule(contractTerms)
    expect(periods).toHaveLength(1)
    expect(periods[0].baseAmount).toBe(computeFixedFeePeriodAmount(2000, 300, 1, 1))
  })
})

describe('computeDiscountMultiplier — introductory discount window alignment (scenario: TEST-SAA-001)', () => {
  // 25% off for the first 3 months of a contract starting 17 Aug 2026.
  const contractTerms = terms({
    discounts: [{
      discount_pct: 25,
      discount_amount: null,
      discount_type: 'introductory',
      start_date: '2026-08-17',
      end_date: '2026-11-16',
      duration_months: 3,
      applies_to: 'platform subscription',
      description: '25% off for the first 3 months',
    }],
  })
  const contractStart = new Date(2026, 7, 17)

  it('period 1 (17 Aug) is discounted — the exact off-by-one this fix targets', () => {
    const d = monthCursor(contractStart, 0)
    expect(computeDiscountMultiplier(contractTerms, d)).toBe(0.75)
  })

  it('periods 2 and 3 (17 Sep, 17 Oct) are discounted', () => {
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 1))).toBe(0.75)
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 2))).toBe(0.75)
  })

  it('period 4 (17 Nov) is full price — the discount does not bleed into the next period', () => {
    const d = monthCursor(contractStart, 3)
    expect(computeDiscountMultiplier(contractTerms, d)).toBe(1)
  })

  it('discount total across periods 1-3 on a 7500/month platform fee is 5625 (3 x 1875)', () => {
    const monthlyFee = 7500
    let discountTotal = 0
    for (let i = 0; i < 3; i++) {
      const d = monthCursor(contractStart, i)
      const mult = computeDiscountMultiplier(contractTerms, d)
      discountTotal += monthlyFee - monthlyFee * mult
    }
    expect(discountTotal).toBe(5625)
  })
})

describe('computeDiscountMultiplier — day-stated duration (duration_days, no end_date) implies a real window (hardening item 2, review pass 4)', () => {
  // A 90-day pilot waiver starting 2026-10-01 with no end_date — same
  // extraction shape as the Remembill fixture. 90 days inclusive of the
  // start day ends 2026-12-29 (day 1 = Oct 1; day 90 = Dec 29).
  const contractTerms = terms({
    discounts: [{
      discount_pct: 100, discount_amount: null, discount_type: 'introductory',
      start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: 90,
      applies_to: 'fixed platform fee', description: '90-day pilot waiver',
    }],
  })
  const contractStart = new Date(2026, 9, 1)

  it('previously produced NO discount at all (end_date null) — now correctly discounts the window', () => {
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 0))).toBe(0) // Oct
  })

  it('November (fully inside the 90-day window) is still fully discounted', () => {
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 1))).toBe(0) // Nov
  })

  it('December — the month CONTAINING day 90 (Dec 29) — is discounted at month-cursor granularity (the whole month, since the cursor is month-start)', () => {
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 2))).toBe(0) // Dec (cursor = Dec 1, <= Dec 29)
  })

  it('January (the next full month after the implied end date) is full price', () => {
    expect(computeDiscountMultiplier(contractTerms, monthCursor(contractStart, 3))).toBe(1) // Jan
  })

  it('an explicit end_date always wins over an implied one, even when duration_days is also present', () => {
    const explicitEnd = terms({
      discounts: [{
        discount_pct: 100, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: '2026-10-31', duration_months: null, duration_days: 90,
        applies_to: 'fixed platform fee', description: 'Explicit 1-month waiver despite duration_days',
      }],
    })
    expect(computeDiscountMultiplier(explicitEnd, monthCursor(contractStart, 0))).toBe(0) // Oct — matches explicit end_date
    expect(computeDiscountMultiplier(explicitEnd, monthCursor(contractStart, 1))).toBe(1) // Nov — NOT the duration_days-implied Dec window
  })

  it('a discount with neither end_date nor duration_days still produces no discount (pre-existing behavior, unchanged)', () => {
    const noEnd = terms({
      discounts: [{
        discount_pct: 50, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: null,
        applies_to: 'base fee', description: 'Unspecified-duration discount',
      }],
    })
    expect(computeDiscountMultiplier(noEnd, monthCursor(contractStart, 0))).toBe(1)
  })
})

describe('computeEscalatorMultiplier — renewal-triggered vs ordinary annual escalation', () => {
  it('automatic annual escalator compounds every 12 months from effective_date', () => {
    const contractTerms = terms({
      escalators: [{
        escalator_pct: 4, escalator_type: 'CPI_cap', effective_date: '2027-08-17', applies_from_year: null, cap_pct: 4,
        description: 'Annual CPI escalator',
        interpretation: {
          treatment: 'applies', index: 'CPI', index_name: 'HICP', frequency: 'annual', effective_date: '2027-08-17',
          cap_pct: 4, calculation_method: 'HICP + cap 4%', discretion: 'automatic', renewal_triggered: false,
          requires_confirmation: false, confirmation_reason: null,
        },
      }],
    })
    // Before the effective date: no escalation yet.
    expect(computeEscalatorMultiplier(contractTerms, new Date(2027, 6, 1))).toBe(1)
    // At the effective date: first step applied.
    expect(computeEscalatorMultiplier(contractTerms, new Date(2027, 7, 17))).toBeCloseTo(1.04)
    // 12 months later: second step compounds.
    expect(computeEscalatorMultiplier(contractTerms, new Date(2028, 7, 17))).toBeCloseTo(1.0816)
  })

  it('discretionary escalator ("may be increased") never compounds until confirmed automatic', () => {
    const contractTerms = terms({
      escalators: [{
        escalator_pct: 4, escalator_type: 'CPI_cap', effective_date: '2027-08-17', applies_from_year: null, cap_pct: 4,
        description: 'may be increased by HICP, capped at 4%',
        interpretation: {
          treatment: 'applies', index: 'CPI', index_name: 'HICP', frequency: 'annual', effective_date: '2027-08-17',
          cap_pct: 4, calculation_method: 'HICP + cap 4%, requires approval at renewal',
          discretion: 'requires_renewal_approval', renewal_triggered: true,
          requires_confirmation: false, confirmation_reason: null,
        },
      }],
    })
    expect(computeEscalatorMultiplier(contractTerms, new Date(2028, 7, 17))).toBe(1)
  })
})

describe('computeBillingSchedule — calendar-anchored base fee proration (TEST-PAY-002 scenario)', () => {
  // Contract starts mid-month (17 Aug 2026), monthly platform fee of SEK
  // 38,500 stated to bill "each calendar month" — a genuine partial first
  // period (17-31 Aug) whose treatment the contract doesn't state.
  const baseFixture = {
    contract_start_date: '2026-08-17',
    contract_term_months: 12,
    billing_frequency: 'monthly' as const,
    base_monthly_fee: 38_500,
    currency: 'SEK',
    discounts: [], escalators: [],
  }

  it('unresolved (requires_confirmation: true) withholds the stub period amount — never guesses full or prorated', () => {
    const contractTerms = terms({
      ...baseFixture,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: 'unclear', requires_confirmation: true },
    })
    const periods = computeBillingSchedule(contractTerms)
    expect(periods[0].periodStart).toEqual(new Date(2026, 7, 17))
    expect(periods[0].periodEnd).toEqual(new Date(2026, 7, 31))
    expect(periods[0].baseAmount).toBe(0)
    // Subsequent full calendar months bill the full 38,500.
    expect(periods[1].periodStart).toEqual(new Date(2026, 8, 1))
    expect(periods[1].baseAmount).toBe(38_500)
  })

  it('reviewer confirms "full month applies" — the stub period bills the complete 38,500, not a fraction', () => {
    const contractTerms = terms({
      ...baseFixture,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: false, requires_confirmation: false },
    })
    const periods = computeBillingSchedule(contractTerms)
    expect(periods[0].baseAmount).toBe(38_500)
  })

  it('reviewer confirms "prorate by days" — the stub period (15 of 31 days) bills 15/31 of 38,500', () => {
    const contractTerms = terms({
      ...baseFixture,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false },
    })
    const periods = computeBillingSchedule(contractTerms)
    // 17-31 Aug inclusive = 15 days, out of 31 days in August.
    expect(periods[0].baseAmount).toBeCloseTo(38_500 * (15 / 31), 2)
  })

  it('no base_fee_proration at all (the common, unambiguous case) preserves the original contract-start-anchored schedule unchanged', () => {
    const contractTerms = terms(baseFixture)
    const periods = computeBillingSchedule(contractTerms)
    expect(periods[0].periodStart).toEqual(new Date(2026, 7, 17))
    expect(periods[0].periodEnd).toEqual(new Date(2026, 8, 16))
    expect(periods[0].baseAmount).toBe(38_500)
  })

  it('reviewer confirms "full fee per contract month" (reset_anchor: contract_start) — same schedule as no proration rule at all, no partial period ever occurs', () => {
    const contractTerms = terms({
      ...baseFixture,
      base_fee_proration: { reset_anchor: 'contract_start', prorate_partial_periods: false, requires_confirmation: false },
    })
    const periods = computeBillingSchedule(contractTerms)
    // Contract-start-anchored periods (17th–16th), never calendar-month
    // windows — must match the no-proration-rule schedule exactly, proving
    // the reviewer's confirmed anchor is actually followed, not silently
    // overridden by the presence of a base_fee_proration record.
    expect(periods[0].periodStart).toEqual(new Date(2026, 7, 17))
    expect(periods[0].periodEnd).toEqual(new Date(2026, 8, 16))
    expect(periods[0].baseAmount).toBe(38_500)
  })

  it('an additional recurring fee with its own confirmed proration prorates independently of the base fee', () => {
    const contractTerms = terms({
      ...baseFixture,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: false, requires_confirmation: false },
      additional_recurring_fees: [{
        fee_label: 'Support retainer', amount: 3_100, description: null,
        proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false },
      }],
    })
    const periods = computeBillingSchedule(contractTerms)
    // Base fee bills in full (38,500); the support retainer prorates (15/31 x 3,100).
    expect(periods[0].baseAmount).toBeCloseTo(38_500 + 3_100 * (15 / 31), 2)
  })
})
