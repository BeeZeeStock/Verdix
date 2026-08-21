// Light coverage per the Step 1 spec — discounts weren't named in the
// enumerated primitive list, but the corpus structure calls for the
// folder. Freezes the one discount-specific readiness guarantee (a
// discount without a confirmed interpretation blocks readiness) and the
// tier-method mapping's independence from the all-units/volume-vs-
// graduated pricing semantics frozen in ../all-units — a discount's own
// tier_method is a SEPARATE field from an overage metric's
// tier_calculation.method, never conflated. No AI calls.
import { describe, it, expect } from 'vitest'
import { isDiscountUnresolved } from '@/lib/commercial-rule-status'
import { deriveSelectedOption } from '@/lib/rule-interpretation'

describe('normalized rule — discount tier_method uses the same graduated/volume/block vocabulary as overage pricing, but is its own independent field', () => {
  it('a volume-discount clause normalizes to tier_method: "volume"', () => {
    expect(deriveSelectedOption('discount', { tier_method: 'volume' })).toBe('volume')
  })
  it('a staircase/graduated discount clause normalizes to tier_method: "graduated"', () => {
    expect(deriveSelectedOption('discount', { tier_method: 'graduated' })).toBe('graduated')
  })
  it('an interpretation with no tier_method at all (flat discount — the field is meaningless for it) falls back to "other", never guessed as graduated', () => {
    expect(deriveSelectedOption('discount', { tier_method: null })).toBe('other')
  })
})

describe('readiness — an unconfirmed discount blocks, a confirmed one does not', () => {
  it('no interpretation at all: unresolved', () => {
    expect(isDiscountUnresolved({ interpretation: undefined })).toBe(true)
  })
  it('interpretation present but requires_confirmation true: unresolved', () => {
    expect(isDiscountUnresolved({ interpretation: { requires_confirmation: true } })).toBe(true)
  })
  it('interpretation present and requires_confirmation false: resolved', () => {
    expect(isDiscountUnresolved({ interpretation: { requires_confirmation: false } })).toBe(false)
  })
})
