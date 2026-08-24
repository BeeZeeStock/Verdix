import { describe, it, expect } from 'vitest'
import { formatEligibleComponentsFact, formatCarryForwardFact, formatCashRedeemableFact, formatEarningBasisFact, computeExcludedFromEarningBasisKeys } from './review-card-format'

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

describe('formatEarningBasisFact', () => {
  it('renders Contract B\'s real computed_from_component_keys', () => {
    expect(formatEarningBasisFact(['transaction_processing_fees'])).toBe('Transaction-processing fees')
  })
  it('renders null/empty as Not specified', () => {
    expect(formatEarningBasisFact(null)).toBe('Not specified')
    expect(formatEarningBasisFact([])).toBe('Not specified')
  })
})

// 2026-08-30 UI fix — earning basis and application scope are independent
// facts; a component key can legitimately appear under BOTH "Can be
// applied against" (eligible_component_keys) and "Excluded from rebate
// basis" (computeExcludedFromEarningBasisKeys) at once. This is the exact
// regression the Confirmed billing rules card previously misrepresented by
// blending both questions into one "Eligible components" row.
describe('computeExcludedFromEarningBasisKeys — earning basis vs. application scope independence', () => {
  // Contract B's real, live Annual Rebate shape.
  const CONTRACT_B_PARAMS = {
    computedFromComponentKeys: ['transaction_processing_fees'],
    eligibleComponentKeys: ['transaction_processing_fees', 'platform_subscription_fees'],
    excludedComponentKeys: ['chargeback_fees', 'one_time_fees', 'taxes', 'previously_applied_credits'],
  }

  it('platform_subscription_fees is excluded from the rebate basis while simultaneously an eligible application target', () => {
    const excludedFromBasis = computeExcludedFromEarningBasisKeys(CONTRACT_B_PARAMS)
    expect(excludedFromBasis).toContain('platform_subscription_fees')
    // Simultaneously an eligible APPLICATION target — the two lists are
    // independent, not mutually exclusive.
    expect(CONTRACT_B_PARAMS.eligibleComponentKeys).toContain('platform_subscription_fees')
  })

  it('the full excluded-from-basis set is everything in eligible+excluded minus computed_from, matching the exact conceptual UI list', () => {
    const excludedFromBasis = computeExcludedFromEarningBasisKeys(CONTRACT_B_PARAMS)
    expect(new Set(excludedFromBasis)).toEqual(new Set([
      'platform_subscription_fees', 'chargeback_fees', 'one_time_fees', 'taxes', 'previously_applied_credits',
    ]))
    // transaction_processing_fees is the earning basis itself — never
    // listed as excluded from it.
    expect(excludedFromBasis).not.toContain('transaction_processing_fees')
  })

  it('renders to the exact conceptual UI copy for Contract B', () => {
    const excludedFromBasis = computeExcludedFromEarningBasisKeys(CONTRACT_B_PARAMS)
    expect(formatEligibleComponentsFact(excludedFromBasis)).toBe(
      'Platform subscription fees, chargeback fees, one time fees, taxes, previously applied credits',
    )
  })

  it('eligible_component_keys "all" falls back to the stated excluded_component_keys only — never guesses what "all minus basis" would contain', () => {
    const excludedFromBasis = computeExcludedFromEarningBasisKeys({
      computedFromComponentKeys: ['transaction_processing_fees'],
      eligibleComponentKeys: 'all',
      excludedComponentKeys: ['chargeback_fees'],
    })
    expect(excludedFromBasis).toEqual(['chargeback_fees'])
  })

  it('a key appearing in both eligible and excluded is de-duplicated', () => {
    const excludedFromBasis = computeExcludedFromEarningBasisKeys({
      computedFromComponentKeys: ['transaction_processing_fees'],
      eligibleComponentKeys: ['transaction_processing_fees', 'chargeback_fees'],
      excludedComponentKeys: ['chargeback_fees'],
    })
    expect(excludedFromBasis).toEqual(['chargeback_fees'])
  })

  it('no computed_from_component_keys means nothing is excluded from a basis that does not exist', () => {
    expect(computeExcludedFromEarningBasisKeys({
      computedFromComponentKeys: null,
      eligibleComponentKeys: ['transaction_processing_fees'],
      excludedComponentKeys: ['chargeback_fees'],
    })).toEqual(['transaction_processing_fees', 'chargeback_fees'])
  })
})
