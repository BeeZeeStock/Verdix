import { describe, it, expect } from 'vitest'
import { describeDiscountForBrief } from './discount-brief-summary'

const fmtDate = (s: string | null | undefined) => s ?? '—'

describe('describeDiscountForBrief — Step 17E, item 10', () => {
  it('a 90-day pilot waiving the fixed platform fee (100%, dated, scoped) reads as a scoped waiver, never "the whole contract is free"', () => {
    const text = describeDiscountForBrief({
      discount_pct: 100, discount_type: 'flat_percentage',
      duration_days: 90, affected_components: ['base_recurring_fee'],
    }, fmtDate)
    expect(text).toBe('90-day pilot: fixed platform fee waived')
    expect(text.toLowerCase()).not.toContain('introductory discount')
  })

  it('a partial (non-100%) scoped discount reads as "discounted X%", not "waived"', () => {
    const text = describeDiscountForBrief({
      discount_pct: 25, duration_months: 6, affected_components: ['base_recurring_fee'],
    }, fmtDate)
    expect(text).toBe('6-month pilot: fixed platform fee discounted 25%')
  })

  it('possibly_affected_components is used when affected_components is not yet confirmed', () => {
    const text = describeDiscountForBrief({
      discount_pct: 100, duration_days: 90, possibly_affected_components: ['base_recurring_fee'],
    }, fmtDate)
    expect(text).toBe('90-day pilot: fixed platform fee waived')
  })

  it('multiple affected components are joined, each humanized', () => {
    const text = describeDiscountForBrief({
      discount_pct: 100, duration_days: 30, affected_components: ['base_recurring_fee', 'setup_fee'],
    }, fmtDate)
    expect(text).toBe('30-day pilot: fixed platform fee and setup fee waived')
  })

  it('falls back to the old generic phrasing when the contract states no scope at all', () => {
    const text = describeDiscountForBrief({ discount_pct: 15, discount_type: 'flat_percentage', end_date: '2026-12-31' }, fmtDate)
    expect(text).toBe('15% flat percentage discount through 2026-12-31')
  })

  it('a dated but unscoped discount still names the end date, never a bare percentage with no context', () => {
    const text = describeDiscountForBrief({ discount_pct: 100, end_date: '2026-12-31' }, fmtDate)
    expect(text).toContain('through')
  })
})
