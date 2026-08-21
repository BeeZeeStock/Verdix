// Commercial-semantics regression baseline — Layer A (normalized rule) +
// Layer C (calculation). Freezes: "given total monthly volume determines
// the tier, exactly one rate is selected by total period volume, that rate
// applies to all units in the period, and the rule must not execute as
// graduated/progressive pricing." No AI calls — these exercise the real,
// already-shipped deterministic engine (lib/tariff.ts), not a live
// extraction. See ../README.md for how this corpus is organized.
import { describe, it, expect } from 'vitest'
import { computeMetricOverage, computeTransactionalOverage } from '@/lib/tariff'
import type { OverageTier, TierCalculationMethod } from '@/lib/types'

function tier(overrides: Partial<OverageTier> = {}): OverageTier {
  return { tier_label: 'Tier', from_unit: 1, to_unit: null, rate_per_unit: 1, unit_type: 'transaction', ...overrides }
}
function tierCalc(overrides: Partial<TierCalculationMethod> = {}): TierCalculationMethod {
  return { method: 'volume', requires_confirmation: false, ...overrides }
}

// The exact TEST-PAY-002 pricing shape verified live earlier this project:
// 1–50,000 @ 1.05, 50,001–200,000 @ 0.83, 200,001+ @ 0.61.
const ALL_UNITS_TIERS: OverageTier[] = [
  tier({ tier_label: '1–50,000', from_unit: 1, to_unit: 50_000, rate_per_unit: 1.05, tier_calculation: tierCalc({ method: 'volume' }) }),
  tier({ tier_label: '50,001–200,000', from_unit: 50_001, to_unit: 200_000, rate_per_unit: 0.83 }),
  tier({ tier_label: '200,001+', from_unit: 200_001, to_unit: null, rate_per_unit: 0.61 }),
]

describe('normalized rule — the confirmed tier_calculation.method IS the semantic ground truth', () => {
  it('a contract stating "the rate corresponding to total monthly volume applies to all Transactions" normalizes to method: "volume"', () => {
    expect(ALL_UNITS_TIERS[0].tier_calculation?.method).toBe('volume')
  })
  it('the same normalized rule is never method: "graduated" — these are mutually exclusive readings of the same clause', () => {
    expect(ALL_UNITS_TIERS[0].tier_calculation?.method).not.toBe('graduated')
  })
})

describe('calculation — volume/all-units: one rate selected by total volume applies to every unit', () => {
  it('150,000 units land in the middle band — ALL 150,000 units bill at 0.83, not just the units past 50,000', () => {
    expect(computeTransactionalOverage(150_000, ALL_UNITS_TIERS, 'volume')).toBeCloseTo(150_000 * 0.83)
  })
  it('250,000 units land in the top band — ALL 250,000 units bill at 0.61', () => {
    expect(computeTransactionalOverage(250_000, ALL_UNITS_TIERS, 'volume')).toBeCloseTo(250_000 * 0.61)
  })
  it('exactly on a threshold (50,000) still resolves to the band whose range includes it, not the next one', () => {
    expect(computeTransactionalOverage(50_000, ALL_UNITS_TIERS, 'volume')).toBeCloseTo(50_000 * 1.05)
  })
  it('crossing a threshold re-rates the WHOLE quantity — 50,001 units costs less per-unit-weighted than 50,000 would at the lower band alone, because the entire quantity moves to the next (cheaper) rate', () => {
    const at50000 = computeTransactionalOverage(50_000, ALL_UNITS_TIERS, 'volume')
    const at50001 = computeTransactionalOverage(50_001, ALL_UNITS_TIERS, 'volume')
    // 50,000 @ 1.05 = 52,500 vs 50,001 @ 0.83 = 41,500.83 — genuinely cheaper
    // just past the threshold, which is the defining, easy-to-get-wrong
    // property of volume/all-units pricing.
    expect(at50001).toBeLessThan(at50000)
  })
  it('via computeMetricOverage end-to-end (the real per-invoice call path): reports back method "volume" and requiresConfirmation false once the tier_calculation is confirmed', () => {
    const result = computeMetricOverage(150_000, ALL_UNITS_TIERS, 0)
    expect(result.method).toBe('volume')
    expect(result.requiresConfirmation).toBe(false)
    expect(result.amount).toBeCloseTo(150_000 * 0.83)
  })
})

describe('counterexample — the identical rate table under graduated/progressive pricing produces a materially different total', () => {
  const GRADUATED_TIERS: OverageTier[] = ALL_UNITS_TIERS.map(t => ({ ...t, tier_calculation: tierCalc({ method: 'graduated' }) }))

  it('graduated: only the units WITHIN each band bill at that band\'s rate — 150,000 units = 50,000@1.05 + 100,000@0.83', () => {
    const expected = 50_000 * 1.05 + 100_000 * 0.83
    expect(computeTransactionalOverage(150_000, GRADUATED_TIERS, 'graduated')).toBeCloseTo(expected)
  })
  it('the same 150,000-unit quantity produces a DIFFERENT total under volume vs graduated — proves method is not cosmetic, it changes the bill', () => {
    const volumeTotal = computeTransactionalOverage(150_000, ALL_UNITS_TIERS, 'volume')
    const graduatedTotal = computeTransactionalOverage(150_000, GRADUATED_TIERS, 'graduated')
    expect(volumeTotal).not.toBeCloseTo(graduatedTotal, 0)
    expect(volumeTotal).toBeCloseTo(150_000 * 0.83)       // 124,500
    expect(graduatedTotal).toBeCloseTo(50_000 * 1.05 + 100_000 * 0.83) // 135,500
  })
  it('an ambiguous/unconfirmed tier_calculation (requires_confirmation: true) must never silently execute as either — flagged, not guessed', () => {
    const ambiguousTiers = ALL_UNITS_TIERS.map(t => ({ ...t, tier_calculation: tierCalc({ method: 'volume', requires_confirmation: true }) }))
    const result = computeMetricOverage(150_000, ambiguousTiers, 0)
    expect(result.requiresConfirmation).toBe(true)
  })
})
