import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  computeMetricOverage,
  computeUserOverage,
  computeTransactionalOverage,
  enumerateCadenceWindows,
  findCadenceWindowContaining,
  isPartialWindow,
  isBillingWindowClosed,
  computeMinimumCommitmentSchedule,
  resolveWindowMinimum,
  clampWindowToContract,
  enumerateContractWindows,
} from './tariff'
import type { OverageTier, MinimumCommitment, TierCalculationMethod } from './types'

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

function tierCalc(overrides: Partial<TierCalculationMethod> = {}): TierCalculationMethod {
  return {
    method: 'graduated',
    requires_confirmation: false,
    ...overrides,
  }
}

describe('computeMetricOverage — legacy scalar floor (backward compat)', () => {
  it('applies the pure floor when usage is below the minimum', () => {
    const tiers = [tier({ rate_per_unit: 0.1, minimum_period_amount: 100 })]
    // 10 units * 0.1 = 1, well under the 100 floor
    expect(computeMetricOverage(10, tiers, 0).amount).toBe(100)
  })

  it('does not apply the floor to an open (not-yet-closed) window', () => {
    const tiers = [tier({ rate_per_unit: 0.1, minimum_period_amount: 100 })]
    expect(computeMetricOverage(10, tiers, 0, false).amount).toBeCloseTo(1)
  })
})

describe('computeMetricOverage — structured minimum_commitment modes', () => {
  it('floor: bills the greater of usage charge or the minimum', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    expect(computeMetricOverage(10, tiers, 0).amount).toBe(5000) // 10 < 5000
    expect(computeMetricOverage(10000, tiers, 0).amount).toBe(10000) // 10000 > 5000
  })

  describe('floor — applies_at_zero_usage', () => {
    it('unset (undefined): still charges the floor at zero usage — unchanged default behavior', () => {
      const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
      expect(computeMetricOverage(0, tiers, 0).amount).toBe(5000)
    })

    it('"unclear": still charges the floor at zero usage — never silently waived', () => {
      const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000, applies_at_zero_usage: 'unclear' }) })]
      expect(computeMetricOverage(0, tiers, 0).amount).toBe(5000)
    })

    it('explicitly true: charges the floor at zero usage', () => {
      const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000, applies_at_zero_usage: true }) })]
      expect(computeMetricOverage(0, tiers, 0).amount).toBe(5000)
    })

    it('explicitly false: waives the floor only when calculated usage is genuinely zero', () => {
      const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000, applies_at_zero_usage: false }) })]
      expect(computeMetricOverage(0, tiers, 0).amount).toBe(0)
      // Any nonzero calculated usage still compares against the floor normally.
      expect(computeMetricOverage(10, tiers, 0).amount).toBe(5000)
      expect(computeMetricOverage(10000, tiers, 0).amount).toBe(10000)
    })

    it('explicitly false: usage fully inside the included allowance also counts as zero calculated usage', () => {
      const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000, applies_at_zero_usage: false }) })]
      expect(computeMetricOverage(50, tiers, 100).amount).toBe(0) // 50 units, 100 included -> 0 billable
    })
  })

  it('additive: charges the minimum on top of usage regardless', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'additive', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0).amount).toBe(5100)
  })

  it('minimum_spend: behaves as a floor (usage draws against the commitment)', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'minimum_spend', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0).amount).toBe(5000)
    expect(computeMetricOverage(10000, tiers, 0).amount).toBe(10000)
  })

  it('prepaid_commitment: only bills usage beyond the prepaid pool', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'prepaid_commitment', amount: 5000 }) })]
    expect(computeMetricOverage(100, tiers, 0).amount).toBe(0) // fully covered by prepaid pool
    expect(computeMetricOverage(6000, tiers, 0).amount).toBe(1000) // 6000 usage - 5000 prepaid
  })

  it('minimum_quantity: raises the billable quantity itself before tier rates apply', () => {
    const tiers = [tier({ rate_per_unit: 2, minimum_commitment: commitment({ mode: 'minimum_quantity', amount: 1000 }) })]
    // Only 100 units of actual usage, but a 1000-unit take-or-pay commitment
    expect(computeMetricOverage(100, tiers, 0).amount).toBe(2000) // 1000 * 2
    // Usage already exceeds the commitment — no bump needed
    expect(computeMetricOverage(2000, tiers, 0).amount).toBe(4000) // 2000 * 2
  })

  it('never silently applies an unconfirmed minimum commitment — usage-only charge instead', () => {
    const tiers = [tier({
      rate_per_unit: 1,
      minimum_commitment: commitment({ mode: 'floor', amount: 5000, requires_confirmation: true }),
    })]
    // Would be 5000 under 'floor' if confirmed — must NOT apply while ambiguous
    expect(computeMetricOverage(10, tiers, 0).amount).toBe(10)
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
    expect(computeMetricOverage(10, tiers, 0).amount).toBe(10)
  })
})

describe('tier calculation method — graduated vs volume vs block', () => {
  // 1–100 @ 10, 101–200 @ 8 — the worked example: at 150 units, graduated
  // charges 100*10 + 50*8 = 1,400, but volume re-rates the whole 150 at the
  // tier it falls into (101–200 @ 8) = 1,200.
  const twoTiers: OverageTier[] = [
    tier({ tier_label: 'Tier 1', from_unit: 1, to_unit: 100, rate_per_unit: 10 }),
    tier({ tier_label: 'Tier 2', from_unit: 101, to_unit: 200, rate_per_unit: 8 }),
  ]

  it('graduated: each band only applies to the units within it', () => {
    expect(computeTransactionalOverage(150, twoTiers, 'graduated')).toBe(1400)
  })

  it('volume: the whole quantity is re-rated at the tier it falls into', () => {
    expect(computeTransactionalOverage(150, twoTiers, 'volume')).toBe(1200)
  })

  it('block: each band reached contributes its rate as a flat fee, not a per-unit rate', () => {
    expect(computeTransactionalOverage(150, twoTiers, 'block')).toBe(18) // 10 + 8, both bands reached
    expect(computeTransactionalOverage(50, twoTiers, 'block')).toBe(10) // only the first band reached
  })

  it('computeUserOverage supports the same three methods for seat-based metrics', () => {
    expect(computeUserOverage(150, 0, twoTiers, 'graduated')).toBe(1400)
    expect(computeUserOverage(150, 0, twoTiers, 'volume')).toBe(1200)
  })

  it('computeMetricOverage resolves the confirmed method from tier_calculation and reports it back', () => {
    const tiers = twoTiers.map(t => ({ ...t, tier_calculation: tierCalc({ method: 'volume' }) }))
    const result = computeMetricOverage(150, tiers, 0)
    expect(result.amount).toBe(1200)
    expect(result.method).toBe('volume')
    expect(result.requiresConfirmation).toBe(false)
  })

  it('an ambiguous tier method is flagged via requiresConfirmation rather than silently defaulted', () => {
    const tiers = twoTiers.map(t => ({ ...t, tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }))
    const result = computeMetricOverage(150, tiers, 0)
    expect(result.requiresConfirmation).toBe(true)
  })

  it('no tier_calculation at all (pre-existing data) defaults to graduated, not flagged as ambiguous', () => {
    const result = computeMetricOverage(150, twoTiers, 0)
    expect(result.method).toBe('graduated')
    expect(result.amount).toBe(1400)
    expect(result.requiresConfirmation).toBe(false)
  })
})

describe('computeMetricOverage — usage/minimum breakdown', () => {
  it('exposes the pure usage-tier charge separately from a floor-adjusted amount', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    const result = computeMetricOverage(10, tiers, 0)
    expect(result.usageAmount).toBe(10) // pure usage, before the floor
    expect(result.amount).toBe(5000)    // floor wins
    expect(result.minimumApplied).toBe(true)
  })

  it('minimumApplied is false when usage alone already exceeds the floor', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    const result = computeMetricOverage(10000, tiers, 0)
    expect(result.usageAmount).toBe(10000)
    expect(result.amount).toBe(10000)
    expect(result.minimumApplied).toBe(false)
  })

  it('additive: usageAmount is the usage-only component, amount includes the additive charge on top', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'additive', amount: 5000 }) })]
    const result = computeMetricOverage(100, tiers, 0)
    expect(result.usageAmount).toBe(100)
    expect(result.amount).toBe(5100)
    expect(result.minimumApplied).toBe(true)
  })
})

// Verifies the exact worked example from a real contract: an SEK 5,000/
// calendar-quarter commitment on a 12-month agreement running 11 Aug 2026 –
// 10 Aug 2027, which touches 5 calendar quarters (two of them partial).
describe('computeMinimumCommitmentSchedule — partial-period proration', () => {
  const contractStart = new Date(2026, 7, 11)  // 11 Aug 2026
  const contractEnd   = new Date(2027, 7, 10)  // 10 Aug 2027
  const mc5k = { amount: 5000 }

  it('prorated by days: the two partial quarters sum to exactly one full quarter (≈20,000 total)', () => {
    const result = computeMinimumCommitmentSchedule(contractStart, contractEnd, 'quarterly', 'calendar', { ...mc5k, prorate_partial_periods: true })
    expect(result.requiresConfirmation).toBe(false)
    expect(result.total).toBe(20000)
    expect(result.windowCount).toBe(5)
    expect(result.partialWindowCount).toBe(2)
    expect(result.fullWindowCount).toBe(3)
  })

  it('full amount for any touched window: 5 quarters × 5,000 = 25,000', () => {
    const result = computeMinimumCommitmentSchedule(contractStart, contractEnd, 'quarterly', 'calendar', { ...mc5k, prorate_partial_periods: false })
    expect(result.total).toBe(25000)
  })

  it('unclear proration treatment: never silently computed — total is null, requiresConfirmation is true', () => {
    const result = computeMinimumCommitmentSchedule(contractStart, contractEnd, 'quarterly', 'calendar', { ...mc5k, prorate_partial_periods: 'unclear' })
    expect(result.total).toBeNull()
    expect(result.requiresConfirmation).toBe(true)
  })

  it('contract_start anchoring never produces a partial window, so proration treatment never matters', () => {
    const result = computeMinimumCommitmentSchedule(contractStart, contractEnd, 'quarterly', 'contract_start', { ...mc5k, prorate_partial_periods: 'unclear' })
    expect(result.requiresConfirmation).toBe(false)
    expect(result.partialWindowCount).toBe(0)
    expect(result.total).toBe(20000) // exactly 4 full contract-anchored quarters
  })

  // Per-window figures — what the billing timeline shows for one specific
  // quarter, not the term total. Must use the exact same math as the
  // aggregate above (resolveWindowMinimum is the function both share), so a
  // partial quarter's timeline event is never shown as the full SEK 5,000.
  describe('resolveWindowMinimum — per-window figures for the billing timeline', () => {
    const q3_2026 = { start: new Date(2026, 6, 1), end: new Date(2026, 8, 30) }  // Jul 1 – Sep 30 2026
    const q4_2026 = { start: new Date(2026, 9, 1), end: new Date(2026, 11, 31) } // Oct 1 – Dec 31 2026
    const q3_2027 = { start: new Date(2027, 6, 1), end: new Date(2027, 8, 30) }  // Jul 1 – Sep 30 2027

    it('the first partial quarter prorates to ≈2,771.74, not the full 5,000', () => {
      const wm = resolveWindowMinimum(q3_2026, contractStart, contractEnd, 'calendar', { ...mc5k, prorate_partial_periods: true })
      expect(wm.isPartial).toBe(true)
      expect(wm.amount).toBeCloseTo(2771.74, 2)
    })

    it('the final partial quarter prorates to ≈2,228.26', () => {
      const wm = resolveWindowMinimum(q3_2027, contractStart, contractEnd, 'calendar', { ...mc5k, prorate_partial_periods: true })
      expect(wm.isPartial).toBe(true)
      expect(wm.amount).toBeCloseTo(2228.26, 2)
    })

    it('a full quarter in the middle of the term is never prorated', () => {
      const wm = resolveWindowMinimum(q4_2026, contractStart, contractEnd, 'calendar', { ...mc5k, prorate_partial_periods: true })
      expect(wm.isPartial).toBe(false)
      expect(wm.amount).toBe(5000)
    })

    it('unclear proration on a partial window: amount is null and requiresConfirmation is true, never a guessed figure', () => {
      const wm = resolveWindowMinimum(q3_2026, contractStart, contractEnd, 'calendar', { ...mc5k, prorate_partial_periods: 'unclear' })
      expect(wm.amount).toBeNull()
      expect(wm.requiresConfirmation).toBe(true)
    })
  })
})

// Section 18 of the commercial-rule spec — explicit acceptance-test cases.
describe('spec acceptance cases — minimum floor vs additive fee', () => {
  it('A. full-quarter minimum floor: raw usage 3,000 below the 5,000 floor bills 5,000', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    expect(computeMetricOverage(3000, tiers, 0).amount).toBe(5000)
  })

  it('B. full-quarter usage exceeds floor: raw usage 7,000 above the 5,000 floor bills 7,000', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    expect(computeMetricOverage(7000, tiers, 0).amount).toBe(7000)
  })

  it('E. additive fee is a distinct calculation from minimum floor: 5,000 additive + 7,000 usage = 12,000', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'additive', amount: 5000 }) })]
    const result = computeMetricOverage(7000, tiers, 0)
    expect(result.amount).toBe(12000) // NOT max(usage, minimum) = 7000
    expect(result.usageAmount).toBe(7000)
  })

  it('a floor and an additive rule with identical usage produce different totals — the mode, not just the amount, determines the calculation', () => {
    const floorTiers    = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'floor', amount: 5000 }) })]
    const additiveTiers = [tier({ rate_per_unit: 1, minimum_commitment: commitment({ mode: 'additive', amount: 5000 }) })]
    expect(computeMetricOverage(3000, floorTiers, 0).amount).toBe(5000)     // max(3000, 5000)
    expect(computeMetricOverage(3000, additiveTiers, 0).amount).toBe(8000) // 3000 + 5000
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

// Regression: TEST-PAY-002's real contract (2026-08-17 to 2028-08-16,
// monthly calendar-anchored transaction minimum) — the real-billing usage
// pull and the schedule/timeline both used the metric's TRUE, unclamped
// calendar-month end (2028-08-31) as the actual measurement/display bound
// for the final window, both querying/counting transactions after contract
// termination toward the calculated fee AND showing a wrong "31 Aug 2028"
// boundary on the timeline, instead of the real final measurement window
// of 1–16 Aug 2028. clampWindowToContract is the shared fix both call
// sites (lib/usage-pull.ts, app/api/jobs/[id]/billing-summary/route.ts)
// now use — this pins the exact boundary math down independent of either
// caller.
describe('clampWindowToContract — real usage-measurement/display bounds, never resolveWindowMinimum\'s own proration math', () => {
  const contractStart = new Date(2026, 7, 17)  // 2026-08-17
  const contractEnd   = new Date(2028, 7, 16)  // 2028-08-16

  it('clamps the final calendar-month window\'s end to the contract end date, not the full calendar month', () => {
    const finalWindow = { start: new Date(2028, 7, 1), end: new Date(2028, 7, 31) } // Aug 2028, full calendar month
    const { start, end } = clampWindowToContract(finalWindow, contractStart, contractEnd)
    expect(start).toEqual(new Date(2028, 7, 1))   // unaffected — this window's start is already within the contract
    expect(end).toEqual(contractEnd)              // clamped to 2028-08-16, not 2028-08-31
  })

  it('clamps the first calendar-month window\'s start to the contract start date, not the full calendar month', () => {
    const firstWindow = { start: new Date(2026, 7, 1), end: new Date(2026, 7, 31) } // Aug 2026, full calendar month
    const { start, end } = clampWindowToContract(firstWindow, contractStart, contractEnd)
    expect(start).toEqual(contractStart) // clamped to 2026-08-17, not 2026-08-01
    expect(end).toEqual(new Date(2026, 7, 31)) // unaffected — this window's end is well within the contract
  })

  it('leaves a fully-interior window (neither edge touches the contract boundary) completely unchanged', () => {
    const midWindow = { start: new Date(2027, 5, 1), end: new Date(2027, 5, 30) } // June 2027
    expect(clampWindowToContract(midWindow, contractStart, contractEnd)).toEqual(midWindow)
  })

  it('does not clamp the end when contractEndDate is null (open-ended contract)', () => {
    const window = { start: new Date(2028, 7, 1), end: new Date(2028, 7, 31) }
    const { end } = clampWindowToContract(window, contractStart, null)
    expect(end).toEqual(new Date(2028, 7, 31))
  })

  it('end-to-end: enumerateContractWindows\' real final window, once clamped, is exactly 1–16 Aug 2028 — the exact boundary this regression is about', () => {
    const windows = enumerateContractWindows(contractStart, contractEnd, 'monthly', 'calendar')
    const finalWindow = windows[windows.length - 1]
    expect(finalWindow.start).toEqual(new Date(2028, 7, 1))
    expect(finalWindow.end).toEqual(new Date(2028, 7, 31)) // TRUE cadence end — unclamped, as resolveWindowMinimum needs it
    const clamped = clampWindowToContract(finalWindow, contractStart, contractEnd)
    expect(clamped.start).toEqual(new Date(2028, 7, 1))
    expect(clamped.end).toEqual(new Date(2028, 7, 16)) // the real, displayed/measured boundary
  })

  it('resolveWindowMinimum still receives the TRUE unclamped window and correctly applies the reviewer-confirmed full-amount policy to the partial final window, independent of the display/measurement clamp', () => {
    const windows = enumerateContractWindows(contractStart, contractEnd, 'monthly', 'calendar')
    const finalWindow = windows[windows.length - 1]
    const mc = { amount: 66000, prorate_partial_periods: false as const }
    const wm = resolveWindowMinimum(finalWindow, contractStart, contractEnd, 'calendar', mc)
    expect(wm.isPartial).toBe(true)
    expect(wm.amount).toBe(66000) // full floor still applies — proration policy is independent of the measurement clamp
  })
})

// Fail-closed real-billing invariant (usage/minimum period-closure audit,
// final hardening pass). window.end's own convention — confirmed directly
// from enumerateCadenceWindows above (`end = nextStart - 1 day`) — is
// midnight of the window's own LAST INCLUSIVE calendar day, never the day
// after and never that day's own 23:59:59 instant. Contract B's real
// October window: start = 1 Oct 2026 00:00, end = 31 Oct 2026 00:00.
describe('isBillingWindowClosed — canonical closure boundary (usage/minimum period-closure audit)', () => {
  // Oct 1 – Oct 31 2026, matching Contract B's real first calendar-month
  // window exactly (enumerateCadenceWindows would produce this same pair).
  const octWindow = { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) }

  it('mid-period (Oct 15) -> NOT closed — the exact scenario this invariant exists to reject', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 9, 15))).toBe(false)
  })

  it('the window\'s own last calendar day, any time during it (Oct 31 14:00) -> still NOT closed — the day itself has not finished', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 9, 31, 14, 0, 0))).toBe(false)
  })

  it('the very last instant of the window\'s last day (Oct 31 23:59:59) -> still NOT closed, by one second', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 9, 31, 23, 59, 59))).toBe(false)
  })

  it('the exact boundary instant (Nov 1 00:00:00, i.e. window.end + 1 day) -> closed — inclusive lower bound', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 10, 1, 0, 0, 0))).toBe(true)
  })

  it('one second past the boundary (Nov 1 00:00:01) -> closed', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 10, 1, 0, 0, 1))).toBe(true)
  })

  it('well after the window (Dec 1) -> closed', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 11, 1))).toBe(true)
  })

  it('a naive `billingAsOf > window.end` comparison would have wrongly reported Oct 31 as closed — confirms the fix is not equivalent to that', () => {
    const midLastDay = new Date(2026, 9, 31, 14, 0, 0)
    expect(midLastDay.getTime() > octWindow.end.getTime()).toBe(true) // the naive, wrong check
    expect(isBillingWindowClosed(octWindow, midLastDay)).toBe(false) // the correct answer
  })

  it('well before the window (Sep 1) -> not closed', () => {
    expect(isBillingWindowClosed(octWindow, new Date(2026, 8, 1))).toBe(false)
  })
})

// This codebase's window/date model is local-calendar-based throughout
// (new Date(y, m, d) construction, never Date.UTC/Z-suffixed ISO strings —
// confirmed by direct reading of enumerateCadenceWindows/
// findCadenceWindowContaining above; no TZ override exists anywhere in the
// repo). Under a local-calendar model a "calendar day" is not always
// exactly 86,400,000ms: a US fall-back day is 25 real hours, a
// spring-forward day is 23. These tests pin process.env.TZ to a real IANA
// zone with DST for their own duration (Node.js respects TZ reassignment at
// runtime — confirmed empirically) so they exercise a genuine transition
// deterministically, independent of whatever timezone the runner's own
// machine happens to be in. Sun Nov 1 2026 is the real US fall-back
// transition (2am -> 1am), chosen because it also happens to be directly
// adjacent to Contract B's real Oct/Nov 2026 dates used elsewhere in this
// suite.
describe('isBillingWindowClosed / enumerateCadenceWindows — DST fall-back transition (America/New_York, Sun Nov 1 2026)', () => {
  const originalTZ = process.env.TZ
  beforeEach(() => { process.env.TZ = 'America/New_York' })
  afterEach(() => { process.env.TZ = originalTZ })

  it('a window ending Nov 1 is NOT closed at Nov 1 23:00 local, even though that instant is a full 86_400_000ms past window.end -- the naive ms-literal form this helper used to use would have wrongly said "closed" here', () => {
    const window = { start: new Date(2026, 9, 2), end: new Date(2026, 10, 1) } // Oct 2 - Nov 1
    const naiveBoundary = new Date(window.end.getTime() + 86_400_000)
    expect(naiveBoundary.toString()).toContain('Nov 01 2026 23:00:00') // confirms the transition really lands here
    expect(isBillingWindowClosed(window, naiveBoundary)).toBe(false) // still Nov 1 -> not closed
    expect(isBillingWindowClosed(window, new Date(2026, 9, 2))).toBe(false) // sanity: mid-window still open too
  })

  it('that same window IS closed at the true next local midnight, Nov 2 00:00 -- one hour later than the naive boundary above, because Nov 1 was a 25-hour day', () => {
    const window = { start: new Date(2026, 9, 2), end: new Date(2026, 10, 1) }
    const trueNextMidnight = new Date(2026, 10, 2) // Nov 2, 00:00 local, via field construction
    expect(isBillingWindowClosed(window, trueNextMidnight)).toBe(true)
    expect(isBillingWindowClosed(window, new Date(trueNextMidnight.getTime() - 1))).toBe(false) // one ms before -> still not closed
  })

  it('enumerateCadenceWindows itself produces a window.end at exact local midnight (Nov 1 00:00), not skewed into the day, when nextStart falls the day after the fall-back transition', () => {
    // Monthly cadence anchored on day-of-month 2 -> the window ending in
    // early November has nextStart = Nov 2 2026, the real day immediately
    // after the fall-back transition -- exactly the case that provably
    // skewed the old `nextStart.getTime() - 86_400_000` form by one hour.
    const anchor = new Date(2026, 8, 2) // Sep 2, 2026 (day-of-month 2)
    const windows = enumerateCadenceWindows(anchor, 'monthly', new Date(2026, 9, 1), new Date(2026, 10, 5))
    const novemberBoundaryWindow = windows.find(w => w.end.getFullYear() === 2026 && w.end.getMonth() === 10 && w.end.getDate() === 1)
    expect(novemberBoundaryWindow).toBeDefined()
    expect(novemberBoundaryWindow!.end.getHours()).toBe(0) // exact midnight, not 01:00
    expect(novemberBoundaryWindow!.end.getTime()).toBe(new Date(2026, 10, 1).getTime())
  })

  it('findCadenceWindowContaining produces the same exact-midnight end across the same transition', () => {
    const anchor = new Date(2026, 8, 2)
    const window = findCadenceWindowContaining(anchor, 'monthly', new Date(2026, 9, 15))
    expect(window.end.getHours()).toBe(0)
    expect(window.end.getTime()).toBe(new Date(2026, 10, 1).getTime())
  })

  it('isPartialWindow no longer false-positives for a contract ending exactly on this DST-adjacent window\'s last day -- the concrete bug the old ms-subtraction form produced', () => {
    const anchor = new Date(2026, 8, 2)
    const window = findCadenceWindowContaining(anchor, 'monthly', new Date(2026, 9, 15)) // Oct 2 - Nov 1
    const contractStart = new Date(2026, 0, 1)
    const contractEndExactlyOnWindowsLastDay = new Date(2026, 10, 1) // Nov 1, 00:00 -- same calendar day as window.end
    expect(isPartialWindow(window, contractStart, contractEndExactlyOnWindowsLastDay)).toBe(false)
  })
})
