import { describe, it, expect } from 'vitest'
import { computePerformanceShareFee } from './performance-share-fee'
import { REMEMBILL_PERFORMANCE_SHARE_SCHEDULE } from './remembill-fixture'
import { PERFORMANCE_SHARE_FEE_COMPONENT } from './performance-share-materiality'
import type { PercentageOfBasisConfig } from './types'

const REMEMBILL_CONFIG: PercentageOfBasisConfig = {
  derived_metric: {
    metric_key: 'value_weighted_payment_rate',
    operation: 'ratio',
    numerator_input_key: 'paid_invoice_value',
    denominator_input_key: 'total_invoice_value_of_issued_requests',
    output_unit: 'percentage',
    min_output_value: 0,
    max_output_value: 100,
  },
  rate_schedule: REMEMBILL_PERFORMANCE_SHARE_SCHEDULE,
  basis_input_key: 'total_invoice_value_of_issued_requests',
}

const PERIOD_START = '2027-03-01' // well outside the 90-day pilot window
const PERIOD_END = '2027-03-31'

function inputs(paid: number, total: number) {
  return { paid_invoice_value: paid, total_invoice_value_of_issued_requests: total }
}

describe('Step 17C.1, section 11 — required Remembill regression cases', () => {
  const cases: Array<[paid: number, total: number, pct: number, ratePct: number, amount: number]> = [
    [4_000, 100_000, 4, 0, 0],
    [5_000, 100_000, 5, 0.20, 200],
    [49_999, 100_000, 49.999, 1.80, 1800],
    [50_000, 100_000, 50, 2.05, 2050],
    [80_000, 100_000, 80, 3.55, 3550],
    [99_999, 100_000, 99.999, 4.30, 4300],
    [100_000, 100_000, 100, 4.50, 4500],
  ]

  for (const [paid, total, pct, ratePct, amount] of cases) {
    it(`paid €${paid.toLocaleString()} / total €${total.toLocaleString()} → ${pct}% → rate ${ratePct}% → €${amount}`, () => {
      const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(paid, total), discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END })
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') return
      expect(result.amount).toBe(amount)
      expect(result.trace.derived_metric.value).toBe(pct)
      expect(result.trace.rate_schedule.rate_pct).toBe(ratePct)
    })
  }
})

describe('Step 17C.1a — non-round-number monetary rounding', () => {
  it('basis €12,345.67 at 2.05% → exactly €253.09, via the shared minor-unit convention', () => {
    // 2.05% is the [50,55) band — 50.1% selects it.
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG,
      inputs: { paid_invoice_value: 6_186.19, total_invoice_value_of_issued_requests: 12_345.67 },
      discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.trace.rate_schedule.rate_pct).toBe(2.05)
    expect(result.amount).toBe(253.09)
  })
})

describe('Step 17C.1, section 11 — held/invalid cases', () => {
  it('denominator missing → held/not ready', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG,
      inputs: { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: null },
      discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    expect(result.status).toBe('not_ready')
  })

  it('numerator missing → held/not ready', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG,
      inputs: { paid_invoice_value: undefined, total_invoice_value_of_issued_requests: 100_000 },
      discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    expect(result.status).toBe('not_ready')
  })

  it('denominator = 0 → held/not ready, never a fabricated 0% rate', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG,
      inputs: inputs(0, 0),
      discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    expect(result.status).toBe('not_ready')
  })

  it('paid > total → validation failure (invalid), not a silently-clamped 100%', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG,
      inputs: inputs(150_000, 100_000),
      discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END,
    })
    expect(result.status).toBe('invalid')
  })

  it('schedule gap → invalid config', () => {
    const badConfig: PercentageOfBasisConfig = {
      ...REMEMBILL_CONFIG,
      rate_schedule: { schedule_key: 'gapped', min_selector_value: 0, max_selector_value: 100, bands: [{ from: 0, to: 50, rate_pct: 1 }, { from: 60, to: null, rate_pct: 2 }] },
    }
    const result = computePerformanceShareFee({ config: badConfig, inputs: inputs(80_000, 100_000), discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect(result.status).toBe('invalid')
  })

  it('overlapping schedule bands → invalid config', () => {
    const badConfig: PercentageOfBasisConfig = {
      ...REMEMBILL_CONFIG,
      rate_schedule: { schedule_key: 'overlapping', min_selector_value: 0, max_selector_value: 100, bands: [{ from: 0, to: 60, rate_pct: 1 }, { from: 50, to: 100, rate_pct: 2 }] },
    }
    const result = computePerformanceShareFee({ config: badConfig, inputs: inputs(55_000, 100_000), discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect(result.status).toBe('invalid')
  })
})

describe('Step 17C.1a, section 2 — period-aware pilot interaction', () => {
  const PILOT_START = '2026-10-01'
  const PILOT_END_INCLUSIVE = '2026-12-29' // start + 90 days

  it('performance_fee not waived ("Fixed platform fee only" confirmed) → calculation executes normally for a period inside the pilot', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee'], possibly_affected_components: [],
      discount_pct: 100, start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-10-15', periodEnd: '2026-11-14' })
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.amount).toBe(3550)
  })

  it('performance_fee waived ("Fixed platform fee + performance fee" confirmed) → €0 / waived obligation for a period fully inside the pilot, trace still preserved', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 100, start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-10-15', periodEnd: '2026-11-14' })
    expect(result.status).toBe('waived')
    if (result.status === 'waived') {
      expect(result.amount).toBe(0)
      expect(result.trace.amount).toBe(3550)
    }
  })

  it('period fully AFTER the pilot: unresolved pilot scope does NOT block — the calculation executes', () => {
    const discounts = [{
      description: 'pilot waiver', affected_components: ['base_recurring_fee'], possibly_affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT],
      start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2027-03-01', periodEnd: '2027-03-31' })
    expect(result.status).toBe('ready')
  })

  it('period fully INSIDE the pilot: unresolved pilot scope blocks readiness', () => {
    const discounts = [{
      description: 'pilot waiver', affected_components: ['base_recurring_fee'], possibly_affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT],
      start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-10-15', periodEnd: '2026-11-14' })
    expect(result.status).toBe('not_ready')
  })

  it('period STRADDLING the pilot expiry, with a CONFIRMED waiver: held not_ready — no confirmed treatment for splitting the monthly basis', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 100, start_date: PILOT_START, duration_days: 90,
    }]
    // December straddles the pilot's Dec 29 expiry.
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-12-01', periodEnd: '2026-12-31' })
    expect(result.status).toBe('not_ready')
  })

  it('period straddling the pilot expiry, but CONFIRMED not-waived: boundary is irrelevant, calculation executes in full', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee'], possibly_affected_components: [],
      discount_pct: 100, start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-12-01', periodEnd: '2026-12-31' })
    expect(result.status).toBe('ready')
    if (result.status === 'ready') expect(result.amount).toBe(3550)
  })

  it('period straddling the pilot START (not the expiry), unresolved scope, still blocks', () => {
    const discounts = [{
      description: 'pilot waiver', affected_components: ['base_recurring_fee'], possibly_affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT],
      start_date: PILOT_START, duration_days: 90,
    }]
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts, periodStart: '2026-09-15', periodEnd: '2026-10-15' })
    expect(result.status).toBe('not_ready')
  })

  it('no discounts at all (contract with no pilot) → performance share executes unaffected', () => {
    const result = computePerformanceShareFee({ config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect(result.status).toBe('ready')
  })

  it('sanity: the pilot window used above really does end 2026-12-29 (start + 90 days inclusive, computed via UTC calendar-day arithmetic — plain local-ms arithmetic lands a day early across Sweden\'s October DST changeover, a real bug this test itself caught and lib/performance-share-materiality.ts\'s addCalendarDaysDstSafe fixes)', () => {
    // Documents the exact boundary the straddle tests above depend on.
    const [y, m, d] = PILOT_START.split('-').map(Number)
    const endUtcMs = Date.UTC(y, m - 1, d) + 89 * 86_400_000
    const end = new Date(endUtcMs)
    const iso = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`
    expect(iso).toBe(PILOT_END_INCLUSIVE)
  })
})

describe('Step 17C.1b, item C — terminal settlement / partial-period handling', () => {
  it('a normal, FULL calendar month (contract in effect the whole period) executes the calculation as usual', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
      contractStartDate: '2026-10-01', contractEndDate: null,
    })
    expect(result).toMatchObject({ status: 'ready', amount: 3550 })
  })

  it('a terminal-settlement PARTIAL month (contract ends mid-period) is held not_ready — the monthly formula is never silently applied to a truncated period', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
      contractStartDate: '2026-10-01', contractEndDate: '2027-03-15', // contract ends mid-March
    })
    expect(result.status).toBe('not_ready')
  })

  it('a first period starting mid-month (contract starts partway through the nominal period) is likewise held — the same isPartialWindow reuse is symmetric', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
      contractStartDate: '2027-03-17', contractEndDate: null, // contract starts mid-March
    })
    expect(result.status).toBe('not_ready')
  })

  it('a genuinely full period where the contract END falls exactly ON periodEnd (not strictly before it) is NOT flagged partial — the boundary itself is a clean full period', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
      contractStartDate: '2026-10-01', contractEndDate: '2027-03-31',
    })
    expect(result).toMatchObject({ status: 'ready', amount: 3550 })
  })

  it('omitting contractStartDate/contractEndDate entirely skips the partial-period check (backward compatible — existing callers that never pass them are unaffected)', () => {
    const result = computePerformanceShareFee({
      config: REMEMBILL_CONFIG, inputs: inputs(80_000, 100_000), discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
    })
    expect(result).toMatchObject({ status: 'ready', amount: 3550 })
  })
})
