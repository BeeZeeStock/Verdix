import { describe, it, expect } from 'vitest'
import { resolveConfirmedDiscountComponents } from './discount-component-targeting'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A hardening (review pass 7), item 2 — closing the loop: a
// reviewer's confirmed scope decision (via /interpret-rule's natural-
// language translation or a direct structured choice) must update the
// TYPED targeting fields the committed-fixed-fee resolver reads, not only
// human-readable interpretation/applies_to.
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveConfirmedDiscountComponents', () => {
  it('EXAMPLE 1 — reviewer confirms "waive fixed fee only": affected_components stays [base_recurring_fee], possibly_affected_components becomes empty', () => {
    const existing = { affected_components: ['base_recurring_fee'], possibly_affected_components: ['performance_fee'] }
    const approvedInterpretation = { affected_components: ['base_recurring_fee'], possibly_affected_components: [] }
    const result = resolveConfirmedDiscountComponents(approvedInterpretation, existing)
    expect(result.affected_components).toEqual(['base_recurring_fee'])
    expect(result.possibly_affected_components).toEqual([])
  })

  it('EXAMPLE 2 — reviewer confirms "waive fixed and performance fee": affected_components gains performance_fee, possibly_affected_components becomes empty', () => {
    const existing = { affected_components: ['base_recurring_fee'], possibly_affected_components: ['performance_fee'] }
    const approvedInterpretation = { affected_components: ['base_recurring_fee', 'performance_fee'], possibly_affected_components: [] }
    const result = resolveConfirmedDiscountComponents(approvedInterpretation, existing)
    expect(result.affected_components).toEqual(['base_recurring_fee', 'performance_fee'])
    expect(result.possibly_affected_components).toEqual([])
  })

  it('a legacy/direct confirmation that never sends typed fields at all PRESERVES the discount\'s existing typed state — never silently clears it', () => {
    const existing = { affected_components: ['base_recurring_fee'], possibly_affected_components: ['performance_fee'] }
    const approvedInterpretation = { discount_type: 'flat_percentage', applies_to: 'fixed platform fee' } // no typed fields at all
    const result = resolveConfirmedDiscountComponents(approvedInterpretation, existing)
    expect(result.affected_components).toEqual(['base_recurring_fee'])
    expect(result.possibly_affected_components).toEqual(['performance_fee'])
  })

  it('a legacy discount with no prior typed state, confirmed via a legacy client -> stays null (never invents typed metadata that was never stated)', () => {
    const result = resolveConfirmedDiscountComponents({ applies_to: 'usage fee' }, undefined)
    expect(result.affected_components).toBeNull()
    expect(result.possibly_affected_components).toBeNull()
  })

  it('an explicit empty array in the confirmed payload IS a resolved answer, not "no information" — it overwrites existing non-empty state', () => {
    const existing = { affected_components: [], possibly_affected_components: ['base_recurring_fee'] }
    const approvedInterpretation = { affected_components: [], possibly_affected_components: [] }
    const result = resolveConfirmedDiscountComponents(approvedInterpretation, existing)
    expect(result.possibly_affected_components).toEqual([])
  })

  it('a first-time confirmation on a discount that previously had no typed metadata at all now sets it from the confirmed payload', () => {
    const result = resolveConfirmedDiscountComponents(
      { affected_components: ['base_recurring_fee'], possibly_affected_components: [] },
      undefined,
    )
    expect(result.affected_components).toEqual(['base_recurring_fee'])
    expect(result.possibly_affected_components).toEqual([])
  })
})
