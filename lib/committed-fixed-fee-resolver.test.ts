import { describe, it, expect } from 'vitest'
import { resolveCommittedFixedFeeValue, discountMateriallyAffectsFixedFee, classifyFixedFeeMateriality, BASE_RECURRING_FEE_COMPONENT } from './committed-fixed-fee-resolver'
import type { BaseTcvItem } from './contract-tcv-calc'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A hardening (review pass 2-6) — resolveCommittedFixedFeeValue is
// the ONE reusable resolver every user-facing surface (Contract page,
// New-contracts list, Agreements dashboard) must go through, so none of
// them can ever disagree about whether an agreement's committed fixed fees
// are known yet.
//
// Review pass 6, item 1 — materiality is decided from TYPED component
// targeting (Discount.affected_components) only. applies_to is free text
// for human display/audit and is NEVER read by discountMateriallyAffects
// FixedFee — every test below that needs a discount to actually block sets
// affected_components explicitly; applies_to alone (however suggestive its
// wording) never does.
// ═══════════════════════════════════════════════════════════════════════════

const ITEMS: BaseTcvItem[] = [
  { product_name: 'Recurring base fee', applied_rule: null, total_amount: 24000, billing_period: 'monthly' },
]

describe('resolveCommittedFixedFeeValue', () => {
  it('no discounts at all -> ready, amount = raw computed figure', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, null)
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
    expect(result.reasons).toEqual([])
  })

  it('a discount typed as affecting base_recurring_fee, with no interpretation at all -> unresolved, amount null', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: undefined, description: '90-day pilot', applies_to: 'fixed platform fee', affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain('90-day pilot')
  })

  it('a discount typed as affecting base_recurring_fee, with a CONCRETE rate, remains ready even while its interpretation is unconfirmed (materially determined regardless)', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: { requires_confirmation: true }, description: 'Fixed fee discount', applies_to: 'fixed platform fee', discount_pct: 100, affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('a discount typed as affecting base_recurring_fee WITHOUT a concrete rate (pct/amount both null) DOES block — the rate itself is genuinely unknown', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: undefined, description: 'Unspecified fixed-fee discount', applies_to: 'fixed platform fee', discount_pct: null, discount_amount: null, affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })

  it('a discount with a confirmed interpretation (requires_confirmation false) -> ready', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: { requires_confirmation: false }, description: 'Confirmed discount', applies_to: 'base fee', affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('multiple discounts, only one typed as affecting the fixed fee and unresolved -> still unresolved, only that one\'s reason listed', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: { requires_confirmation: false }, description: 'Resolved one', applies_to: 'base fee', affected_components: ['base_recurring_fee'] },
      { interpretation: undefined, description: 'Unresolved one', applies_to: 'platform fee', affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.reasons).toHaveLength(1)
    expect(result.reasons[0]).toContain('Unresolved one')
  })

  it('never partially computes around the unresolved discount — the WHOLE figure is withheld, not just the named component\'s share', () => {
    const items: BaseTcvItem[] = [
      { product_name: 'Base fee', applied_rule: null, total_amount: 24000, billing_period: 'monthly' },
      { product_name: 'Support fee', applied_rule: null, total_amount: 6000, billing_period: 'monthly' },
    ]
    const result = resolveCommittedFixedFeeValue(items, [
      { interpretation: undefined, description: 'Pilot on base fee only', applies_to: 'base fee', affected_components: ['base_recurring_fee'] },
    ])
    // Even though the discount only targets the base fee component, the
    // support fee's 6,000 is not carved out and shown alone — the whole
    // 30,000 is withheld, matching the instruction's own conservative
    // posture.
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })
})

describe('classifyFixedFeeMateriality — FAIL-CLOSED tri-state (hardening item 1, review pass 7)', () => {
  it('affected_components includes the component -> definitely_affects', () => {
    expect(classifyFixedFeeMateriality({ affected_components: ['base_recurring_fee'] })).toBe('definitely_affects')
  })

  it('possibly_affected_components includes the component (scope unresolved) -> unknown', () => {
    expect(classifyFixedFeeMateriality({ affected_components: [], possibly_affected_components: ['base_recurring_fee'] })).toBe('unknown')
  })

  it('typed targeting explicitly present (even as empty arrays) and NEITHER list includes the component -> definitely_does_not_affect', () => {
    expect(classifyFixedFeeMateriality({ affected_components: ['performance_fee'], possibly_affected_components: [] })).toBe('definitely_does_not_affect')
    expect(classifyFixedFeeMateriality({ affected_components: [], possibly_affected_components: [] })).toBe('definitely_does_not_affect')
  })

  it('REQUIRED — no typed targeting at all (both fields missing/undefined) -> unknown, NEVER definitely_does_not_affect (fail closed, protects legacy agreements)', () => {
    expect(classifyFixedFeeMateriality({})).toBe('unknown')
    expect(classifyFixedFeeMateriality({ applies_to: 'platform fee', discount_pct: 100 })).toBe('unknown')
  })
})

describe('resolveCommittedFixedFeeValue — FAIL-CLOSED typed materiality (hardening item 1, review pass 7): missing typed metadata blocks, never silently "not material"', () => {
  it('REQUIRED — unresolved discount + NO typed targeting at all -> committed fixed value unresolved (protects legacy/pre-typed-targeting agreements)', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: undefined, description: 'Some legacy discount', applies_to: 'platform fee' }, // no affected_components/possibly_affected_components
    ])
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })

  it('REQUIRED — the arbitrary-label regression, using EXPLICIT typed non-targeting (not missing metadata): "platform loyalty rewards program" wording has no authority', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      {
        interpretation: undefined, description: 'Some discount', applies_to: 'platform loyalty rewards program',
        discount_pct: 100, affected_components: ['performance_fee'], possibly_affected_components: [],
      },
    ])
    expect(discountMateriallyAffectsFixedFee({
      applies_to: 'platform loyalty rewards program', discount_pct: 100,
      affected_components: ['performance_fee'], possibly_affected_components: [],
    })).toBe(false)
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('REQUIRED — base_recurring_fee in possibly_affected_components -> unresolved while scope is unresolved', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      {
        interpretation: undefined, description: 'Hybrid-fee waiver, scope open', applies_to: 'platform charge',
        affected_components: [], possibly_affected_components: ['base_recurring_fee'],
      },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })

  it('REQUIRED — the SAME decision, now resolved to EXCLUDE base_recurring_fee -> no longer blocks', () => {
    // Same discount as above, but scope has since been resolved: the
    // reviewer confirmed base_recurring_fee is NOT covered, so it moved out
    // of possibly_affected_components without entering affected_components.
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      {
        interpretation: { requires_confirmation: false }, description: 'Hybrid-fee waiver, scope resolved', applies_to: 'platform charge',
        affected_components: ['performance_fee'], possibly_affected_components: [],
      },
    ])
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('REQUIRED — explicit performance_fee-only target -> fixed value not blocked', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      {
        interpretation: undefined, description: 'Performance-share waiver', applies_to: 'platform performance component',
        affected_components: ['performance_fee'], possibly_affected_components: [],
      },
    ])
    expect(discountMateriallyAffectsFixedFee({ affected_components: ['performance_fee'], possibly_affected_components: [] })).toBe(false)
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('the typed target base_recurring_fee DOES make a discount affect fixed fees, regardless of applies_to wording', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: undefined, description: 'Some discount', applies_to: 'the primary charge', affected_components: [BASE_RECURRING_FEE_COMPONENT] },
    ])
    expect(discountMateriallyAffectsFixedFee({ applies_to: 'the primary charge', affected_components: [BASE_RECURRING_FEE_COMPONENT] })).toBe(true)
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })

  it('unresolved WIDER scope with base_recurring_fee already DEFINITELY included (the Remembill shape) -> fixed commitment NOT blocked', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      {
        interpretation: undefined, // scope formally unconfirmed
        description: '90-day pilot waiver', applies_to: 'fixed platform fee',
        discount_pct: 100, // concrete rate on the definitely-affected component
        affected_components: ['base_recurring_fee'],
        possibly_affected_components: ['performance_fee'], // the genuinely open question — irrelevant to THIS figure
      },
    ])
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
  })

  it('discountMateriallyAffectsFixedFee never reads applies_to at all — a discount with NO applies_to but a concrete affected_components/rate still blocks correctly', () => {
    expect(discountMateriallyAffectsFixedFee({ affected_components: ['base_recurring_fee'] })).toBe(true) // no rate -> blocks
    expect(discountMateriallyAffectsFixedFee({ affected_components: ['base_recurring_fee'], discount_pct: 100 })).toBe(false) // concrete rate -> materially determined
  })
})

describe('resolveCommittedFixedFeeValue — base-fee partial-period proration is a SEPARATE gate from discount scope (hardening item 1, review pass 3)', () => {
  const RESOLVED_DISCOUNT = [{ interpretation: { requires_confirmation: false }, description: 'Pilot waiver', applies_to: 'fixed platform fee', affected_components: ['base_recurring_fee'] }]
  const UNRESOLVED_PRORATION = { requires_confirmation: true }
  const RESOLVED_PRORATION = { requires_confirmation: false }

  it('discount typed as affecting the fixed fee and unresolved, proration untouched (undefined) -> unresolved (discount alone is enough to block)', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, [
      { interpretation: undefined, description: 'Pilot waiver', applies_to: 'fixed platform fee', affected_components: ['base_recurring_fee'] },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
  })

  it('discount resolved, but base-fee proration still unresolved -> STILL unresolved (resolving scope does not resolve partial-period treatment)', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, RESOLVED_DISCOUNT, UNRESOLVED_PRORATION)
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
    expect(result.reasons.some(r => /partial-period/i.test(r))).toBe(true)
    // The discount's own reason must not reappear once it's resolved.
    expect(result.reasons.some(r => /pilot waiver/i.test(r))).toBe(false)
  })

  it('both discount AND base-fee proration resolved -> ready, real number, computeCommittedFixedFees itself untouched', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, RESOLVED_DISCOUNT, RESOLVED_PRORATION)
    expect(result.status).toBe('ready')
    expect(result.amount).toBe(24000)
    expect(result.reasons).toEqual([])
  })

  it('a recurring fee\'s own unresolved proration also blocks readiness, named by fee_label', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, RESOLVED_DISCOUNT, RESOLVED_PRORATION, [
      { fee_label: 'Dedicated support fee', proration: { requires_confirmation: true } },
    ])
    expect(result.status).toBe('unresolved')
    expect(result.reasons.some(r => r.includes('Dedicated support fee'))).toBe(true)
  })

  it('base_fee_proration entirely absent (null/undefined) never blocks readiness by itself — most contracts have no such question', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, RESOLVED_DISCOUNT, null)
    expect(result.status).toBe('ready')
  })
})

describe('resolveCommittedFixedFeeValue — capability gap: a confirmed day-level proration choice the deterministic engine cannot yet compute (hardening item 2, review pass 4)', () => {
  it('confirmed prorate_partial_periods:false, reset_anchor contract_start -> supported, ready', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, null, {
      requires_confirmation: false, reset_anchor: 'contract_start', prorate_partial_periods: false,
    })
    expect(result.status).toBe('ready')
  })

  it('confirmed prorate_partial_periods:true, reset_anchor contract_start -> NOT yet supported, stays unresolved with an honest capability-gap reason', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, null, {
      requires_confirmation: false, reset_anchor: 'contract_start', prorate_partial_periods: true,
    })
    expect(result.status).toBe('unresolved')
    expect(result.amount).toBeNull()
    expect(result.reasons.some(r => /day-level proration/i.test(r))).toBe(true)
  })

  it('confirmed prorate_partial_periods:true, reset_anchor calendar -> IS supported (the engine\'s calendar-anchored path has real day-level proration), ready', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, null, {
      requires_confirmation: false, reset_anchor: 'calendar', prorate_partial_periods: true,
    })
    expect(result.status).toBe('ready')
  })

  it('unresolved (requires_confirmation:true) is checked BEFORE the capability gap — an unconfirmed decision never gets a false "supported" pass', () => {
    const result = resolveCommittedFixedFeeValue(ITEMS, null, {
      requires_confirmation: true, reset_anchor: 'contract_start', prorate_partial_periods: true,
    })
    expect(result.status).toBe('unresolved')
    expect(result.reasons.some(r => /Decision Required/i.test(r))).toBe(true)
    expect(result.reasons.some(r => /day-level proration/i.test(r))).toBe(false)
  })
})
