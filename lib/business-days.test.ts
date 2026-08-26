import { describe, it, expect } from 'vitest'
import { isBusinessDayAt, computeBusinessDayDeadline } from './business-days'

describe('isBusinessDayAt — Swedish/Stockholm calendar', () => {
  it('an ordinary weekday is a business day', () => {
    expect(isBusinessDayAt('2026-08-25T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(true) // Tuesday
  })
  it('a Saturday and a Sunday are never business days', () => {
    expect(isBusinessDayAt('2026-08-29T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Saturday
    expect(isBusinessDayAt('2026-08-30T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Sunday
  })
  it('fixed-date public holidays are excluded — New Year\'s Day, National Day, Christmas Day', () => {
    expect(isBusinessDayAt('2026-01-01T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false)
    expect(isBusinessDayAt('2026-06-06T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Saturday anyway in 2026, but excluded either way
    expect(isBusinessDayAt('2026-12-25T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false)
  })
  it('Easter-relative holidays are computed algorithmically (2026: Easter Sunday is April 5)', () => {
    expect(isBusinessDayAt('2026-04-03T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Good Friday
    expect(isBusinessDayAt('2026-04-06T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Easter Monday
    expect(isBusinessDayAt('2026-05-14T10:00:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false) // Ascension (Easter + 39d)
  })
  it('a civil date is determined in the given timezone, not raw UTC — near-midnight Stockholm instant resolves to the correct local date', () => {
    // 2026-01-01T23:30:00Z is already 2026-01-02 00:30 in Stockholm (CET, UTC+1) — NOT a holiday.
    expect(isBusinessDayAt('2026-01-01T23:30:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(true)
    // 2026-01-01T00:30:00Z is still 2026-01-01 01:30 in Stockholm — IS New Year's Day.
    expect(isBusinessDayAt('2026-01-01T00:30:00Z', 'SE-stockholm', 'Europe/Stockholm')).toBe(false)
  })
  it('throws for an unsupported holiday calendar rather than silently treating every day as a business day', () => {
    // @ts-expect-error — deliberately passing an unsupported calendar id
    expect(() => isBusinessDayAt('2026-08-25T10:00:00Z', 'US-federal', 'Europe/Stockholm')).toThrow(/unsupported holiday_calendar/)
  })
})

describe('computeBusinessDayDeadline', () => {
  it('same_clock_time: 3 business days after a plain midweek Tuesday preserves the reference clock time', () => {
    // Tue 2026-08-25 14:32 -> Wed, Thu, Fri all business days -> Fri 2026-08-28 14:32
    const deadline = computeBusinessDayDeadline({
      referenceTime: '2026-08-25T12:32:00Z', businessDays: 3, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'same_clock_time',
    })
    // 12:32 UTC on Aug 25 is 14:32 Stockholm (CEST, UTC+2); 3 business days later, same local clock time.
    expect(new Date(deadline).toISOString()).toBe('2026-08-28T12:32:00.000Z')
  })

  it('end_of_business_day: deadline lands at the configured local cutoff on the Nth business day, not a hardcoded end-of-calendar-day', () => {
    const deadline = computeBusinessDayDeadline({
      referenceTime: '2026-08-25T12:32:00Z', businessDays: 3, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'end_of_business_day',
      businessDayEndLocalTime: '17:00:00',
    })
    // 17:00:00 CEST (UTC+2) on 2026-08-28 == 15:00:00Z
    expect(new Date(deadline).toISOString()).toBe('2026-08-28T15:00:00.999Z')
  })

  it("end_of_business_day without a configured businessDayEndLocalTime throws rather than silently meaning 'end of calendar day'", () => {
    expect(() => computeBusinessDayDeadline({
      referenceTime: '2026-08-25T12:32:00Z', businessDays: 3, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'end_of_business_day',
    })).toThrow(/requires businessDayEndLocalTime/)
  })

  it('rejects a malformed businessDayEndLocalTime', () => {
    expect(() => computeBusinessDayDeadline({
      referenceTime: '2026-08-25T12:32:00Z', businessDays: 3, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'end_of_business_day',
      businessDayEndLocalTime: '5pm',
    })).toThrow(/must be 'HH:MM:SS'/)
  })

  it("the reference day itself is never counted, even if it is itself a business day", () => {
    // Reference on a Monday; +1 business day must land on Tuesday, not stay on Monday.
    const deadline = computeBusinessDayDeadline({
      referenceTime: '2026-08-24T09:00:00Z', businessDays: 1, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'same_clock_time',
    })
    expect(new Date(deadline).toISOString().slice(0, 10)).toBe('2026-08-25')
  })

  it('Stockholm holiday/business-day boundary — a weekend + a public holiday are both skipped when counting business days (item H)', () => {
    // Reference: Wed 2026-04-01. Good Friday is 2026-04-03, Easter Monday is 2026-04-06.
    // Business days after Wed 4/1: Thu 4/2 (1), Fri 4/3 is Good Friday (skip),
    // Sat/Sun (skip), Mon 4/6 is Easter Monday (skip), Tue 4/7 (2), Wed 4/8 (3).
    const deadline = computeBusinessDayDeadline({
      referenceTime: '2026-04-01T09:00:00Z', businessDays: 3, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', convention: 'same_clock_time',
    })
    expect(new Date(deadline).toISOString().slice(0, 10)).toBe('2026-04-08')
  })

  it('rejects a non-positive or fractional businessDays value', () => {
    const base = { referenceTime: '2026-08-25T09:00:00Z', calendar: 'SE-stockholm' as const, timezone: 'Europe/Stockholm', convention: 'same_clock_time' as const }
    expect(() => computeBusinessDayDeadline({ ...base, businessDays: 0 })).toThrow(/positive integer/)
    expect(() => computeBusinessDayDeadline({ ...base, businessDays: -1 })).toThrow(/positive integer/)
    expect(() => computeBusinessDayDeadline({ ...base, businessDays: 1.5 })).toThrow(/positive integer/)
  })

  it('is deterministic — identical inputs always produce the identical instant', () => {
    const params = { referenceTime: '2026-08-25T12:32:00Z', businessDays: 3, calendar: 'SE-stockholm' as const, timezone: 'Europe/Stockholm', convention: 'end_of_business_day' as const, businessDayEndLocalTime: '17:00:00' }
    expect(computeBusinessDayDeadline(params)).toBe(computeBusinessDayDeadline(params))
  })
})
