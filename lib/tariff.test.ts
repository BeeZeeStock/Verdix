import { describe, it, expect } from 'vitest'
import {
  computeMetricOverage,
  enumerateCadenceWindows,
  findCadenceWindowContaining,
  isPartialWindow,
} from './tariff'
import type { OverageTier, MinimumCommitment } from './types'

function tier(overrides: Partial<OverageTier> = {}): OverageTier {
  return {
    tier_label: 'Tier 1',
    from_unit: 1,
    to_unit: null,
    rate_per_unit: 1,
    unit_type: 'api_call',
    ...overrides,
  }
}

function commitment(overrides: Partial<MinimumCommitment> = {}): MinimumCommitment {
  return {
    mode: 'floor',
    amount: 5000,
    requires_confirmation: false,
    ...overrides,
  }
}

describe('computeMetricOverage — legacy scalar floor (backward compat)', () => {
  it('applies the pure floor when usage is below the minimum', () => {
    const tiers = [tier({ rate_per_unit: 0.1, minimum_period_amount: 100 })]
    // 10 units * 0.1 = 1, well under the 100 floor
    expect(computeMetricOverage(10, tiers, 0)).toBe(100)
  })

  it('does not apply the floor to an open (not-yet-closed) window', () => {
    const tiers = [tier({ rate_per_unit: 0.1, minimum_period_amount: 100 })]
    expect(computeMetricOverage(10, tiers, 0, false)).toBeCloseTo(1)
  })
})

describe('computeMetricOverage — structured minimum_commitment modes', () => {
  it('floor: bills the greater of usage charge or the minimum', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    expect(computeMetricOverage(10, tiers, 0)).toBe(5000) // 10 < 5000
    expect(computeMetricOverage(10000, tiers, 0)).toBe(10000) // 10000 > 5000
  })

  it('additive: charges the minimum on top of usage regardless', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'additive', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0)).toBe(5100)
  })

  it('minimum_spend: behaves as a floor (usage draws against the commitment)', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'minimum_spend', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0)).toBe(5000)
    expect(computeMetricOverage(10000, tiers, 0)).toBe(10000)
  })

  it('prepaid_commitment: only bills usage beyond the prepaid pool', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'prepaid_commitment', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0)).toBe(0) // fully covered by prepaid pool
    expect(computeMetricOverage(6000, tiers, 0)).toBe(1000) // 6000 usage - 5000 prepaid
  })

  it('minimum_quantity: raises the billable quantity itself before tier rates apply', () => {
    const tiers = [tier({ rate_per_unit: 2, minimum_commitment: commitment({ mode: 'minimum_quantity', amount: 1000 }) })]
    // Only 100 units of actual usage, but a 1000-unit take-or-pay commitment
    expect(computeMetricOverage(100, tiers, 0)).toBe(2000) // 1000 * 2
    // Usage already exceeds the commitment — no bump needed
    expect(computeMetricOverage(2000, tiers, 0)).toBe(4000) // 2000 * 2
  })

  it('never silently applies an unconfirmed minimum commitment — usage-only charge instead', () => {
    const tiers = [tier({
      rate_per_unit: 1,
      minimum_commitment: commitment({ mode: 'floor', amount: 5000, requires_confirmation: true }),
    })]
    // Would be 5000 under 'floor' if confirmed — must NOT apply while ambiguous
    expect(computeMetricOverage(10, tiers, 0)).toBe(10)
  })

  it('an unconfirmed minimum_commitment also suppresses the legacy minimum_period_amount fallback', () => {
    // Extraction populates both fields together — the structured commitment
    // must govern exclusively once present, never falling through to the
    // legacy floor as a backdoor silent-apply path.
    const tiers = [tier({
      rate_per_unit: 1,
      minimum_period_amount: 5000,
      minimum_commitment: commitment({ mode: 'floor', amount: 5000, requires_confirmation: true }),
    })]
    expect(computeMetricOverage(10, tiers, 0)).toBe(10)
  })
})

describe('cadence windows — contract_start vs calendar anchoring', () => {
  it('contract_start anchor: windows reset on the contract anniversary, not calendar boundaries', () => {
    const anchor = new Date(2026, 4, 15) // 15 May 2026
    const windows = enumerateCadenceWindows(anchor, 'quarterly', new Date(2026, 4, 15), new Date(2027, 4, 14))
    expect(windows[0].start).toEqual(new Date(2026, 4, 15))
    expect(windows[0].end).toEqual(new Date(2026, 7, 14)) // day before 15 Aug
  })

  it("calendar anchor: windows reset on fixed quarter boundaries (Jan/Apr/Jul/Oct 1) regardless of contract start", () => {
    const anchor = new Date(2026, 4, 15) // contract starts mid-Q2
    const windows = enumerateCadenceWindows(anchor, 'quarterly', new Date(2026, 3, 1), new Date(2026, 9, 1), 'calendar')
    // First calendar-quarter window should start 1 Apr 2026, not 15 May
    expect(windows[0].start).toEqual(new Date(2026, 3, 1))
    expect(windows[0].end).toEqual(new Date(2026, 5, 30))
  })

  it('findCadenceWindowContaining respects the calendar anchor for an in-progress window', () => {
    const anchor = new Date(2026, 4, 15)
    const win = findCadenceWindowContaining(anchor, 'quarterly', new Date(2026, 4, 20), 'calendar')
    expect(win.start).toEqual(new Date(2026, 3, 1)) // 1 Apr 2026
    expect(win.end).toEqual(new Date(2026, 5, 30))   // 30 Jun 2026
  })
})

describe('isPartialWindow', () => {
  it('flags the first window as partial when the contract starts mid-window (calendar anchoring)', () => {
    const window = { start: new Date(2026, 3, 1), end: new Date(2026, 5, 30) } // calendar Q2
    const contractStart = new Date(2026, 4, 15) // contract begins mid-quarter
    expect(isPartialWindow(window, contractStart, null)).toBe(true)
  })

  it('does not flag a window the contract was in effect for the whole span of', () => {
    const window = { start: new Date(2026, 3, 1), end: new Date(2026, 5, 30) }
    const contractStart = new Date(2026, 3, 1) // starts exactly on the boundary
    expect(isPartialWindow(window, contractStart, null)).toBe(false)
  })

  it('flags the last window as partial when the contract ends mid-window', () => {
    const window = { start: new Date(2026, 3, 1), end: new Date(2026, 5, 30) }
    const contractEnd = new Date(2026, 4, 20) // ends mid-quarter
    expect(isPartialWindow(window, null, contractEnd)).toBe(true)
  })

  it('contract_start anchored windows are never partial (they always start exactly on the contract date)', () => {
    const window = { start: new Date(2026, 4, 15), end: new Date(2026, 7, 14) }
    const contractStart = new Date(2026, 4, 15)
    expect(isPartialWindow(window, contractStart, null)).toBe(false)
  })
})
