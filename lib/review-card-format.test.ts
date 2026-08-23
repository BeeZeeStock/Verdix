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
  // Regression — carry_forward: false does NOT mean "never applied at
  // all" (that same-period state is structurally unreachable, since
  // CreditApplicationRule.availability is fixed to 'next_period'
  // everywhere in this codebase — see this function's own comment). It
  // structurally means "applied against the next invoice only, then any
  // remainder expires". Found via a real Contract B "Expires after next
  // invoice" reviewer override rendering as the wrong, unreachable state.
  it('false renders the real semantic — applied to next invoice only, then expires', () => {
    expect(formatCarryForwardFact(false)).toBe('Expires after next invoice')
  })
  // 'unclear'/undefined get their OWN distinct branch now — previously
  // collapsed into the same (wrong) text as false, a latent bug this
  // function's real call sites never happened to trigger (always called
  // with a genuine boolean today), but incorrect on its own terms.
  it('unclear/undefined render as Not specified, distinct from false', () => {
    expect(formatCarryForwardFact('unclear')).toBe('Not specified')
    expect(formatCarryForwardFact(undefined)).toBe('Not specified')
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
