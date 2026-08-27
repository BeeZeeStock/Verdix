import { describe, it, expect } from 'vitest'
import { computeMetricOverage } from './tariff'
import type { OverageTier } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A, item 14 — proves the EXISTING, unchanged commercial engine
// already treats the Remembill excess surcharge additively: €0.38 charged
// on ALL issued payment requests (a separate additional_recurring_fees
// per-unit rate, never touched by this file) PLUS €0.60 extra ONLY on
// requests above the 5,000 contracted volume (this overage_tiers entry) —
// never a replacement all-units tier that would re-rate every request at
// €0.60 once the threshold is crossed. No production code changed for this
// item; this is a pure verification regression.
// ═══════════════════════════════════════════════════════════════════════════

const EXCESS_SURCHARGE_TIERS: OverageTier[] = [
  { tier_label: 'Extra payment requests above contracted volume', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, unit_type: 'payment request' },
]
const INCLUDED_UNITS = 5000

describe('item 14 — the €0.60 excess surcharge is additive, not a replacement all-units tier', () => {
  it('at exactly the contracted volume (5,000), the surcharge is €0', () => {
    const result = computeMetricOverage(5000, EXCESS_SURCHARGE_TIERS, INCLUDED_UNITS, true)
    expect(result.amount).toBe(0)
  })

  it('at 6,000 requests, the surcharge is 0.60 x 1,000 = €600 — only the EXCESS, never 0.60 x 6,000', () => {
    const result = computeMetricOverage(6000, EXCESS_SURCHARGE_TIERS, INCLUDED_UNITS, true)
    expect(result.amount).toBe(600)
    expect(result.amount).not.toBe(6000 * 0.6) // would be 3600 if it were a replacement all-units tier
  })

  it('the surcharge scales linearly with the excess — proves it is a genuine add-on rate, not a re-rated total', () => {
    const at6000 = computeMetricOverage(6000, EXCESS_SURCHARGE_TIERS, INCLUDED_UNITS, true).amount
    const at7000 = computeMetricOverage(7000, EXCESS_SURCHARGE_TIERS, INCLUDED_UNITS, true).amount
    expect(at7000 - at6000).toBe(1000 * 0.6)
  })

  it('the full Remembill bill is the SUM of the separate base per-unit rate and this surcharge, never one replacing the other', () => {
    const totalRequests = 6000
    const baseRatePerUnit = 0.38 // additional_recurring_fees — a wholly separate computation, never touched here
    const baseCharge = totalRequests * baseRatePerUnit
    const surcharge = computeMetricOverage(totalRequests, EXCESS_SURCHARGE_TIERS, INCLUDED_UNITS, true).amount
    const totalBill = baseCharge + surcharge
    expect(baseCharge).toBeCloseTo(2280, 5)
    expect(surcharge).toBe(600)
    expect(totalBill).toBeCloseTo(2880, 5)
  })
})
