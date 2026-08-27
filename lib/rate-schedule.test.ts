import { describe, it, expect } from 'vitest'
import { validateRateSchedule, selectRate } from './rate-schedule'
import { REMEMBILL_PERFORMANCE_SHARE_SCHEDULE } from './remembill-fixture'
import type { RateSchedule } from './types'

describe('validateRateSchedule — structural validation, no gaps/no overlaps/deterministic boundaries', () => {
  it('the real Remembill schedule (21 bands, verbatim from Bilaga 1) validates', () => {
    expect(validateRateSchedule(REMEMBILL_PERFORMANCE_SHARE_SCHEDULE)).toEqual({ valid: true })
  })

  it('empty bands array is invalid', () => {
    const schedule: RateSchedule = { schedule_key: 'x', bands: [], min_selector_value: 0, max_selector_value: 100 }
    expect(validateRateSchedule(schedule)).toMatchObject({ valid: false, reason: expect.stringContaining('no bands') })
  })

  it('first band not starting at min_selector_value is invalid', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 10,
      bands: [{ from: 1, to: null, rate_pct: 5 }],
    }
    expect(validateRateSchedule(schedule)).toMatchObject({ valid: false, reason: expect.stringContaining('min_selector_value') })
  })

  it('a gap between bands is invalid config', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 20,
      bands: [
        { from: 0, to: 5, rate_pct: 1 },
        { from: 10, to: null, rate_pct: 2 }, // gap: [5,10) is uncovered
      ],
    }
    const result = validateRateSchedule(schedule)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/gap/)
  })

  it('overlapping bands is invalid config', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 20,
      bands: [
        { from: 0, to: 8, rate_pct: 1 },
        { from: 5, to: null, rate_pct: 2 }, // overlap: [5,8) covered twice
      ],
    }
    const result = validateRateSchedule(schedule)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/overlap/)
  })

  it('a non-last band with to: null (open-ended mid-table) is invalid — gap/overlap against the next band cannot be determined', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 20,
      bands: [
        { from: 0, to: null, rate_pct: 1 },
        { from: 10, to: null, rate_pct: 2 },
      ],
    }
    expect(validateRateSchedule(schedule).valid).toBe(false)
  })

  it('an empty/inverted band (to <= from) is invalid', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 10,
      bands: [{ from: 5, to: 5, rate_pct: 1 }],
    }
    expect(validateRateSchedule(schedule).valid).toBe(false)
  })

  it('last band ending below max_selector_value leaves a gap at the top — invalid', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 100,
      bands: [{ from: 0, to: 50, rate_pct: 1 }],
    }
    const result = validateRateSchedule(schedule)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/gap/)
  })

  it('a schedule with max_selector_value: null (genuinely unbounded) and an open-ended last band validates', () => {
    const schedule: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: null,
      bands: [{ from: 0, to: null, rate_pct: 1 }],
    }
    expect(validateRateSchedule(schedule)).toEqual({ valid: true })
  })
})

describe('selectRate — the real Remembill schedule, exact boundary semantics ([from, to) half-open)', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [4.999, 0],
    [5, 0.20],
    [9.999, 0.20],
    [10, 0.40],
    [49.999, 1.80],
    [50, 2.05],
    [94.999, 4.05],
    [95, 4.30],
    [99.999, 4.30],
    [100, 4.50],
  ]
  for (const [value, expectedRate] of cases) {
    it(`${value}% selects ${expectedRate}%`, () => {
      const result = selectRate(REMEMBILL_PERFORMANCE_SHARE_SCHEDULE, value)
      expect(result).toMatchObject({ status: 'resolved', rate_pct: expectedRate })
    })
  }

  it('a value above 100 fails as out_of_bounds — never matched against an implicit "and above" reading of the top band', () => {
    const result = selectRate(REMEMBILL_PERFORMANCE_SHARE_SCHEDULE, 100.5)
    expect(result).toMatchObject({ status: 'out_of_bounds' })
  })

  it('a negative value fails as out_of_bounds', () => {
    const result = selectRate(REMEMBILL_PERFORMANCE_SHARE_SCHEDULE, -1)
    expect(result).toMatchObject({ status: 'out_of_bounds' })
  })

  it('an invalid (gapped) schedule fails closed as invalid_schedule, never silently matching a nearby band', () => {
    const gapped: RateSchedule = {
      schedule_key: 'x', min_selector_value: 0, max_selector_value: 20,
      bands: [{ from: 0, to: 5, rate_pct: 1 }, { from: 10, to: null, rate_pct: 2 }],
    }
    const result = selectRate(gapped, 7)
    expect(result).toMatchObject({ status: 'invalid_schedule' })
  })
})
