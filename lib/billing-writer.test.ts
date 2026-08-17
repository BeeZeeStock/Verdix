import { describe, it, expect } from 'vitest'
import { monthCursor, computeDiscountMultiplier, computeEscalatorMultiplier } from './billing-writer'
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
