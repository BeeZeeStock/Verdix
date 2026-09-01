import { describe, it, expect } from 'vitest'
import { resolveDiscountComponentAttachment, discountTypeLabel, discountBusinessLabel, resolveDiscountPeriod, resolveDiscountContractWordingContext } from './discount-commercial-logic'

describe('resolveDiscountComponentAttachment — Step 17H.3D1', () => {
  it('a single recognized affected_components key attaches to that component', () => {
    expect(resolveDiscountComponentAttachment({ affected_components: ['base_recurring_fee'] }))
      .toEqual({ kind: 'component', componentKey: 'base_recurring_fee' })
    expect(resolveDiscountComponentAttachment({ affected_components: ['performance_fee'] }))
      .toEqual({ kind: 'component', componentKey: 'performance_fee' })
    expect(resolveDiscountComponentAttachment({ affected_components: ['usage_fee'] }))
      .toEqual({ kind: 'component', componentKey: 'usage_fee' })
    expect(resolveDiscountComponentAttachment({ affected_components: ['overage_fee'] }))
      .toEqual({ kind: 'component', componentKey: 'overage_fee' })
  })

  it('no affected_components at all is cross-cutting — never defaults to the fixed component', () => {
    expect(resolveDiscountComponentAttachment({ affected_components: null })).toEqual({ kind: 'cross_cutting', reason: 'no_affected_components' })
    expect(resolveDiscountComponentAttachment({ affected_components: [] })).toEqual({ kind: 'cross_cutting', reason: 'no_affected_components' })
    expect(resolveDiscountComponentAttachment({})).toEqual({ kind: 'cross_cutting', reason: 'no_affected_components' })
  })

  it('multiple affected_components is cross-cutting — never arbitrarily picks the first', () => {
    expect(resolveDiscountComponentAttachment({ affected_components: ['base_recurring_fee', 'performance_fee'] }))
      .toEqual({ kind: 'cross_cutting', reason: 'multiple_affected_components' })
  })

  it('an unrecognized component key is cross-cutting, not silently dropped or guessed', () => {
    expect(resolveDiscountComponentAttachment({ affected_components: ['some_future_component_type'] }))
      .toEqual({ kind: 'cross_cutting', reason: 'unrecognized_component_key' })
  })

  it('label/description text is never consulted — the function has no such parameter at all', () => {
    // Structural proof: TypeScript itself would reject a description/
    // applies_to/fee_label field being read, since the function's input
    // type only ever declares affected_components.
    const discount = { affected_components: ['performance_fee'], description: 'Platform waiver', applies_to: 'the hardware fee' }
    expect(resolveDiscountComponentAttachment(discount)).toEqual({ kind: 'component', componentKey: 'performance_fee' })
  })

  // Step 17H.3D1.1, item 6/7 — a deliberately CONTRADICTORY applies_to
  // string (says "hardware fee") must not shift attachment away from the
  // real, typed affected_components value ("base_recurring_fee" — the
  // fixed platform fee). Misleading raw wording changes nothing.
  it('deliberately contradictory applies_to text never changes semantic attachment', () => {
    const misleading = { affected_components: ['base_recurring_fee'], applies_to: 'Applies to the hardware equipment fee only, never the platform subscription' }
    expect(resolveDiscountComponentAttachment(misleading)).toEqual({ kind: 'component', componentKey: 'base_recurring_fee' })
  })

  it('misleading applies_to text with no affected_components still resolves to cross-cutting, never guessed from the text', () => {
    const misleading = { affected_components: [], applies_to: 'Clearly applies to the fixed platform fee' }
    expect(resolveDiscountComponentAttachment(misleading)).toEqual({ kind: 'cross_cutting', reason: 'no_affected_components' })
  })
})

describe('discountTypeLabel — Step 17H.3D1 (typed enum, not label inference)', () => {
  it('maps each of the four typed discount_type values', () => {
    expect(discountTypeLabel('introductory')).toBe('One-time · introductory')
    expect(discountTypeLabel('volume')).toBe('Recurring · volume')
    expect(discountTypeLabel('negotiated')).toBe('Recurring · negotiated')
    expect(discountTypeLabel('other')).toBe('other')
  })

  it('a missing discount_type falls back to a generic label, never a guess', () => {
    expect(discountTypeLabel(null)).toBe('Discount')
    expect(discountTypeLabel(undefined)).toBe('Discount')
  })
})

describe('resolveDiscountPeriod — Step 17H.3D1', () => {
  it('an explicit date range takes precedence when both dates are present', () => {
    expect(resolveDiscountPeriod({ start_date: '2026-01-01', end_date: '2026-04-01', duration_days: 90 }))
      .toEqual({ kind: 'date_range', startDate: '2026-01-01', endDate: '2026-04-01' })
  })

  it('falls back to duration_days when no full date range is known', () => {
    expect(resolveDiscountPeriod({ duration_days: 90 })).toEqual({ kind: 'duration_days', days: 90 })
  })

  it('falls back to duration_months when neither dates nor duration_days are known', () => {
    expect(resolveDiscountPeriod({ duration_months: 6 })).toEqual({ kind: 'duration_months', months: 6 })
  })

  it('no timing fact at all when nothing is populated — never a fabricated period', () => {
    expect(resolveDiscountPeriod({})).toEqual({ kind: 'none' })
  })
})

describe('resolveDiscountContractWordingContext — Step 17H.3D1.1', () => {
  it('structured applicability absent + raw applies_to present: shows the contract wording', () => {
    expect(resolveDiscountContractWordingContext({ applies_to: 'Fixed platform fee during introductory period' }, null))
      .toBe('Fixed platform fee during introductory period')
  })

  it('structured applicability present: never repeats applies_to, even when populated', () => {
    expect(resolveDiscountContractWordingContext(
      { applies_to: 'Fixed platform fee during introductory period' },
      'The fixed platform fee is waived.',
    )).toBeNull()
  })

  it('structured applicability absent + no raw wording: nothing to show, never fabricated', () => {
    expect(resolveDiscountContractWordingContext({ applies_to: null }, null)).toBeNull()
    expect(resolveDiscountContractWordingContext({ applies_to: '' }, null)).toBeNull()
    expect(resolveDiscountContractWordingContext({ applies_to: '   ' }, null)).toBeNull()
    expect(resolveDiscountContractWordingContext({}, null)).toBeNull()
  })

  it('is blind to whether applies_to agrees or disagrees with the structured fact — it never overrides routing, only decides whether raw text is worth showing', () => {
    // Same misleading text as the attachment test above; this function
    // still only answers "is there raw context worth showing," never
    // "what does this text mean" — the caller already made the real
    // routing decision via resolveDiscountComponentAttachment before this
    // is ever consulted.
    const misleading = 'Applies to the hardware equipment fee only'
    expect(resolveDiscountContractWordingContext({ applies_to: misleading }, null)).toBe(misleading)
    expect(resolveDiscountContractWordingContext({ applies_to: misleading }, 'The fixed platform fee is waived.')).toBeNull()
  })
})

describe('discountBusinessLabel — Step 17H.4B0D4H1B4E7.1 §3/§16', () => {
  it('a 100%-off introductory discount is a waiver — the fee is fully suspended', () => {
    expect(discountBusinessLabel({ discount_type: 'introductory', discount_pct: 100 })).toBe('Introductory waiver')
  })

  it('a partial introductory discount is a discount, not a waiver', () => {
    expect(discountBusinessLabel({ discount_type: 'introductory', discount_pct: 25 })).toBe('Introductory discount')
  })

  it('an introductory discount with no percentage (amount-based) reads as a discount, not a waiver', () => {
    expect(discountBusinessLabel({ discount_type: 'introductory', discount_pct: null })).toBe('Introductory discount')
  })

  it('volume and negotiated discounts get their own business labels', () => {
    expect(discountBusinessLabel({ discount_type: 'volume' })).toBe('Volume discount')
    expect(discountBusinessLabel({ discount_type: 'negotiated' })).toBe('Negotiated discount')
  })

  it('an unrecognized discount_type falls back to a humanized version of the raw value, never a blank label', () => {
    expect(discountBusinessLabel({ discount_type: 'custom_type' })).toBe('custom type')
  })

  it('no discount_type at all falls back to a generic "Discount"', () => {
    expect(discountBusinessLabel({ discount_type: null })).toBe('Discount')
  })

  it('never mutates or reads discountTypeLabel — the two are independent, and discountTypeLabel is untouched', () => {
    expect(discountTypeLabel('introductory')).toBe('One-time · introductory')
  })
})
