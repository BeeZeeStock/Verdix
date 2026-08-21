// Freezes: a minimum described as a floor is max(calculated_charge,
// minimum), is not additive, must not be multiplied simply because it is
// represented across multiple tier rows, and partial-period treatment
// remains an independently reviewable question when unstated. Exercises
// the real lib/tariff.ts engine — no AI calls.
import { describe, it, expect } from 'vitest'
import { computeMetricOverage } from '@/lib/tariff'
import { isMinimumCommitmentModeUnresolved, isMinimumCommitmentProrationUnresolved } from '@/lib/commercial-rule-status'
import type { OverageTier, MinimumCommitment } from '@/lib/types'

function tier(overrides: Partial<OverageTier> = {}): OverageTier {
  return { tier_label: 'Tier', from_unit: 1, to_unit: null, rate_per_unit: 1, unit_type: 'transaction', ...overrides }
}
function floorCommitment(overrides: Partial<MinimumCommitment> = {}): MinimumCommitment {
  return { mode: 'floor', amount: 66_000, requires_confirmation: false, ...overrides }
}

describe('normalized rule — floor mode is a distinct, non-additive semantic', () => {
  it('the confirmed mode is "floor", not "additive" — mutually exclusive readings of "if fees are less than SEK 66,000, Customer will instead pay SEK 66,000"', () => {
    const mc = floorCommitment()
    expect(mc.mode).toBe('floor')
    expect(mc.mode).not.toBe('additive')
  })
})

describe('calculation — floor: max(calculated_charge, minimum), never additive', () => {
  it('usage below the floor bills exactly the floor amount, not usage + floor', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ amount: 66_000 }) })]
    // 10,000 units * 1 = 10,000, well under the 66,000 floor
    expect(computeMetricOverage(10_000, tiers, 0).amount).toBe(66_000)
  })
  it('usage above the floor bills the usage charge, the floor never adds on top', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ amount: 66_000 }) })]
    expect(computeMetricOverage(100_000, tiers, 0).amount).toBe(100_000)
  })
  it('exactly at the floor bills the floor amount (boundary, not exceeded)', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ amount: 66_000 }) })]
    expect(computeMetricOverage(66_000, tiers, 0).amount).toBe(66_000)
  })
  it('minimumApplied correctly distinguishes "floor bound" from "usage alone already cleared it"', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ amount: 66_000 }) })]
    expect(computeMetricOverage(10_000, tiers, 0).minimumApplied).toBe(true)
    expect(computeMetricOverage(100_000, tiers, 0).minimumApplied).toBe(false)
  })
})

describe('representation across multiple tier rows must not multiply the floor', () => {
  it('the SAME floor duplicated onto 3 tier rows (extraction\'s real storage convention) still applies exactly once, not 3×', () => {
    const mc = floorCommitment({ amount: 66_000 })
    const tiers = [
      tier({ tier_label: '1–50,000', from_unit: 1, to_unit: 50_000, rate_per_unit: 1.05, minimum_commitment: mc }),
      tier({ tier_label: '50,001–200,000', from_unit: 50_001, to_unit: 200_000, rate_per_unit: 0.83, minimum_commitment: mc }),
      tier({ tier_label: '200,001+', from_unit: 200_001, to_unit: null, rate_per_unit: 0.61, minimum_commitment: mc }),
    ]
    const result = computeMetricOverage(10_000, tiers, 0) // 10,000 * 1.05 = 10,500, under floor
    expect(result.amount).toBe(66_000)                 // not 198,000 (66,000 × 3)
    expect(result.amount).not.toBe(66_000 * 3)
  })
})

describe('counterexample — additive mode is a genuinely different calculation from floor with identical inputs', () => {
  it('additive: the minimum is charged ON TOP of usage, regardless of usage — same amount, different mode, different total', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ mode: 'additive', amount: 66_000 }) })]
    expect(computeMetricOverage(10_000, tiers, 0).amount).toBe(76_000) // 10,000 + 66,000
  })
  it('floor and additive produce DIFFERENT totals for the same usage and the same stated amount — the mode, not just the number, determines the bill', () => {
    const floorTiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ mode: 'floor', amount: 66_000 }) })]
    const additiveTiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ mode: 'additive', amount: 66_000 }) })]
    expect(computeMetricOverage(10_000, floorTiers, 0).amount).toBe(66_000)
    expect(computeMetricOverage(10_000, additiveTiers, 0).amount).toBe(76_000)
  })
})

describe('a genuinely unconfirmed minimum must never silently bill', () => {
  it('requires_confirmation: true on the minimum falls back to usage-only — the floor is never guessed into the bill', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment({ amount: 66_000, requires_confirmation: true }) })]
    expect(computeMetricOverage(10_000, tiers, 0).amount).toBe(10_000)
  })
})

describe('partial-period treatment stays an independently reviewable question when unstated', () => {
  it('a calendar-anchored minimum with prorate_partial_periods unset is unresolved when the contract genuinely starts mid-period (dates unknown fails toward "ask")', () => {
    const mc = floorCommitment({ prorate_partial_periods: undefined })
    expect(isMinimumCommitmentProrationUnresolved(mc, true, 'monthly', undefined, undefined)).toBe(true)
  })
  it('a calendar-anchored minimum with prorate_partial_periods unset is unresolved once the contract dates are known and DO create a partial window (17 Aug start)', () => {
    const mc = floorCommitment({ prorate_partial_periods: undefined })
    expect(isMinimumCommitmentProrationUnresolved(mc, true, 'monthly', '2026-08-17', '2028-08-16')).toBe(true)
  })
  it('the SAME unset partial-period question does not block a metric with NO calendar anchor at all — proration is only a live question under calendar anchoring', () => {
    const mc = floorCommitment({ prorate_partial_periods: undefined })
    expect(isMinimumCommitmentProrationUnresolved(mc, false, 'monthly', undefined, undefined)).toBe(false)
  })
  it('the mode question (floor vs additive vs ...) and the proration question are independently tracked — a metric can have its mode fully confirmed while proration stays open', () => {
    const mc = floorCommitment({ prorate_partial_periods: undefined })
    expect(isMinimumCommitmentModeUnresolved(mc, false)).toBe(false) // mode itself is stated and clear
    expect(isMinimumCommitmentProrationUnresolved(mc, true, 'monthly', '2026-08-17', '2028-08-16')).toBe(true) // proration still open
  })
  it('once a reviewer confirms a boolean prorate_partial_periods, the question resolves regardless of whether dates are known yet', () => {
    const mc = floorCommitment({ prorate_partial_periods: false })
    expect(isMinimumCommitmentProrationUnresolved(mc, true, 'monthly', undefined, undefined)).toBe(false)
  })
})
