import { describe, it, expect } from 'vitest'
import { formatEligibleComponentsFact, formatCarryForwardFact, formatCashRedeemableFact } from './review-card-format'

describe('formatEligibleComponentsFact', () => {
  it('renders "all" as the full-payable-pool phrase', () => {
    expect(formatEligibleComponentsFact('all')).toBe('Future amounts payable')
  })
  it('renders a component list as a readable, comma-joined, sentence-cased phrase', () => {
    expect(formatEligibleComponentsFact(['transaction_processing'])).toBe('Transaction-processing')
    expect(formatEligibleComponentsFact(['transaction_processing', 'platform_fee'])).toBe('Transaction-processing, platform fee')
  })
  it('hyphenates "X processing" compounds per the established house style, without a fixed key lookup table', () => {
    expect(formatEligibleComponentsFact(['transaction_processing_fees', 'platform_subscription_fees'])).toBe('Transaction-processing fees, platform subscription fees')
  })
  it('renders null/empty/undefined as Not specified', () => {
    expect(formatEligibleComponentsFact(null)).toBe('Not specified')
    expect(formatEligibleComponentsFact(undefined)).toBe('Not specified')
    expect(formatEligibleComponentsFact([])).toBe('Not specified')
  })
})

describe('formatCarryForwardFact', () => {
  it('false/unclear/undefined all render as does-not-carry-forward', () => {
    expect(formatCarryForwardFact(false)).toBe('Does not carry forward')
    expect(formatCarryForwardFact('unclear')).toBe('Does not carry forward')
    expect(formatCarryForwardFact(undefined)).toBe('Does not carry forward')
  })
  it('true with no expiry renders as until fully used', () => {
    expect(formatCarryForwardFact(true)).toBe('Until fully used')
  })
  it('true with expiry_periods 1 renders as next period only', () => {
    expect(formatCarryForwardFact(true, 1)).toBe('Next period only')
  })
  it('true with expiry_periods > 1 renders the period count', () => {
    expect(formatCarryForwardFact(true, 4)).toBe('4 periods')
  })
  it('an expiry_date takes priority over expiry_periods', () => {
    expect(formatCarryForwardFact(true, 4, '2027-01-01')).toBe('Until 2027-01-01')
  })
})

describe('formatCashRedeemableFact', () => {
  it('true/false/unclear render as Redeemable/Not redeemable/Not specified', () => {
    expect(formatCashRedeemableFact(true)).toBe('Redeemable')
    expect(formatCashRedeemableFact(false)).toBe('Not redeemable')
    expect(formatCashRedeemableFact('unclear')).toBe('Not specified')
    expect(formatCashRedeemableFact(undefined)).toBe('Not specified')
  })
})
