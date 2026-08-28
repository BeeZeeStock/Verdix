import { describe, it, expect } from 'vitest'
import { computeRollingWindowAggregate, type RollingWindowPeriodValue } from './rolling-window-aggregate'
import type { RollingWindowAggregateConfig } from './types'

const CONFIG: RollingWindowAggregateConfig = {
  input_key: 'issued_payment_request_count',
  window_count: 3,
  window_unit: 'billing_period',
  operation: 'mean',
  require_complete_windows: true,
}

function periods(values: Array<number | null>): RollingWindowPeriodValue[] {
  const months = ['2027-01', '2027-02', '2027-03']
  return values.map((value, i) => ({
    period_start: `${months[i]}-01`,
    period_end: `${months[i]}-28`,
    value,
  }))
}

describe('computeRollingWindowAggregate — Step 17C.2, section 11 numeric cases', () => {
  it('[4000, 4500, 5000] -> mean 4500', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([4000, 4500, 5000]))
    expect(result).toMatchObject({ status: 'ready', value: 4500 })
  })

  it('[5000, 5000, 5001] -> mean 5000.333...', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([5000, 5000, 5001]))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.value).toBeCloseTo(5000.3333333, 5)
  })

  it('[7000, 8000, 9000] -> mean 8000', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([7000, 8000, 9000]))
    expect(result).toMatchObject({ status: 'ready', value: 8000 })
  })

  it('[20000, 30000, 40000] -> mean 30000', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([20000, 30000, 40000]))
    expect(result).toMatchObject({ status: 'ready', value: 30000 })
  })

  it('a full trace records every window\'s own period + value, oldest first', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([7000, 8000, 9000]))
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.trace.windows).toEqual([
      { period_start: '2027-01-01', period_end: '2027-01-28', value: 7000 },
      { period_start: '2027-02-01', period_end: '2027-02-28', value: 8000 },
      { period_start: '2027-03-01', period_end: '2027-03-28', value: 9000 },
    ])
    expect(result.trace.value).toBe(8000)
    expect(result.trace.input_key).toBe('issued_payment_request_count')
  })
})

describe('computeRollingWindowAggregate — readiness/fail-closed behavior', () => {
  it('missing one month (null) -> not_ready', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([7000, null, 9000]))
    expect(result.status).toBe('not_ready')
    if (result.status !== 'not_ready') return
    expect(result.reason).toMatch(/missing finalized/)
  })

  it('fewer than window_count periods supplied at all -> not_ready, never averages a partial set', () => {
    const result = computeRollingWindowAggregate(CONFIG, periods([7000, 8000]))
    expect(result.status).toBe('not_ready')
    if (result.status !== 'not_ready') return
    expect(result.reason).toMatch(/only 2 of the required 3/)
  })

  it('zero periods supplied -> not_ready', () => {
    const result = computeRollingWindowAggregate(CONFIG, [])
    expect(result.status).toBe('not_ready')
  })

  it('only the most recent window_count periods are used when more are supplied — never an arbitrary/stale subset', () => {
    const fourMonths: RollingWindowPeriodValue[] = [
      { period_start: '2026-12-01', period_end: '2026-12-31', value: 1_000_000 }, // would wildly skew the mean if included
      ...periods([7000, 8000, 9000]),
    ]
    const result = computeRollingWindowAggregate(CONFIG, fourMonths)
    expect(result).toMatchObject({ status: 'ready', value: 8000 })
  })
})
