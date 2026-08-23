import { describe, it, expect } from 'vitest'
import {
  parseBillabilityCondition, getBillabilityExecutionCapability, projectBillabilityConditionToExecutionFields,
  describeBillabilityCondition, isChangeOrderConditional, resolveOneTimeFeeTypeLabel,
} from './billability-condition'

describe('parseBillabilityCondition — closed-union enforcement (item 2)', () => {
  it('accepts a valid immediate condition', () => {
    expect(parseBillabilityCondition({ kind: 'immediate' })).toEqual({ kind: 'immediate' })
  })

  it('accepts a valid fixed_date condition with an ISO date', () => {
    expect(parseBillabilityCondition({ kind: 'fixed_date', date: '2026-10-15' })).toEqual({ kind: 'fixed_date', date: '2026-10-15' })
  })

  it('rejects fixed_date with a non-ISO date', () => {
    expect(parseBillabilityCondition({ kind: 'fixed_date', date: '15 Oct 2026' })).toBeNull()
    expect(parseBillabilityCondition({ kind: 'fixed_date', date: '2026-10-15T00:00:00Z' })).toBeNull()
  })

  it('rejects fixed_date with a missing/non-string date', () => {
    expect(parseBillabilityCondition({ kind: 'fixed_date' })).toBeNull()
    expect(parseBillabilityCondition({ kind: 'fixed_date', date: 20261015 })).toBeNull()
  })

  it('accepts every event_type in the closed set', () => {
    for (const event_type of ['contract_signature', 'delivery', 'customer_acceptance', 'final_acceptance', 'change_order_signature']) {
      expect(parseBillabilityCondition({ kind: 'event', event_type })).toEqual({ kind: 'event', event_type })
    }
  })

  it('rejects an event_type outside the closed set — never a generic free-text executable event', () => {
    expect(parseBillabilityCondition({ kind: 'event', event_type: 'deemed_acceptance' })).toBeNull()
    expect(parseBillabilityCondition({ kind: 'event', event_type: 'customer approves the milestone in writing' })).toBeNull()
  })

  it('rejects an unrecognized kind', () => {
    expect(parseBillabilityCondition({ kind: 'manual' })).toBeNull()
    expect(parseBillabilityCondition({ kind: 'deemed_acceptance', window_days: 10 })).toBeNull()
  })

  it('rejects null, undefined, and non-object raw values — the same "fail toward unresolved" discipline as every other extraction safety net', () => {
    expect(parseBillabilityCondition(null)).toBeNull()
    expect(parseBillabilityCondition(undefined)).toBeNull()
    expect(parseBillabilityCondition('event/customer_acceptance')).toBeNull()
    expect(parseBillabilityCondition(42)).toBeNull()
    expect(parseBillabilityCondition(true)).toBeNull()
  })

  it('rejects a bare array or plain object with no kind', () => {
    expect(parseBillabilityCondition([])).toBeNull()
    expect(parseBillabilityCondition({})).toBeNull()
    expect(parseBillabilityCondition({ event_type: 'delivery' })).toBeNull()
  })
})

describe('getBillabilityExecutionCapability (item 7)', () => {
  it('immediate is executable under the current model', () => {
    expect(getBillabilityExecutionCapability({ kind: 'immediate' })).toEqual({ executable: true })
  })

  it('fixed_date is executable under the current model', () => {
    expect(getBillabilityExecutionCapability({ kind: 'fixed_date', date: '2026-10-15' })).toEqual({ executable: true })
  })

  it('event is never executable yet — requires operational evidence, event_type surfaced structurally', () => {
    expect(getBillabilityExecutionCapability({ kind: 'event', event_type: 'customer_acceptance' })).toEqual({
      executable: false, reason: 'requires_operational_event', event_type: 'customer_acceptance',
    })
  })

  it('null/undefined condition is condition_unresolved, not executable', () => {
    expect(getBillabilityExecutionCapability(null)).toEqual({ executable: false, reason: 'condition_unresolved' })
    expect(getBillabilityExecutionCapability(undefined)).toEqual({ executable: false, reason: 'condition_unresolved' })
  })
})

describe('projectBillabilityConditionToExecutionFields (item 15 — the ONE deterministic projection)', () => {
  it('immediate projects to the existing "bill now" representation: due_date null, manual_trigger false', () => {
    expect(projectBillabilityConditionToExecutionFields({ kind: 'immediate' })).toEqual({ due_date: null, manual_trigger: false })
  })

  it('fixed_date projects due_date = condition.date, manual_trigger false', () => {
    expect(projectBillabilityConditionToExecutionFields({ kind: 'fixed_date', date: '2026-10-15' }))
      .toEqual({ due_date: '2026-10-15', manual_trigger: false })
  })

  it('event projects due_date null, manual_trigger true — automatic invoice must not execute (item 8)', () => {
    expect(projectBillabilityConditionToExecutionFields({ kind: 'event', event_type: 'delivery' }))
      .toEqual({ due_date: null, manual_trigger: true })
  })

  it('fixed_date and "payable upon signing" (event/contract_signature) never collapse to the same projection, even when the date coincides with a real calendar date elsewhere (item 9 regression)', () => {
    const fixedDate = projectBillabilityConditionToExecutionFields({ kind: 'fixed_date', date: '2026-09-01' })
    const signatureEvent = projectBillabilityConditionToExecutionFields({ kind: 'event', event_type: 'contract_signature' })
    expect(fixedDate).not.toEqual(signatureEvent)
    expect(signatureEvent.due_date).toBeNull()
  })
})

describe('describeBillabilityCondition — canonical human-readable label, shared by review card and overview table', () => {
  it('describes immediate as "Immediate", never "Contract signature" merely because a signing date coincides with the Effective Date (Agreement A regression)', () => {
    expect(describeBillabilityCondition({ kind: 'immediate' })).toBe('Immediate')
  })

  it('describes fixed_date with the concrete date', () => {
    expect(describeBillabilityCondition({ kind: 'fixed_date', date: '2026-10-15' })).toBe('Fixed date — 2026-10-15')
  })

  it('describes every event_type with its own distinct, human-readable label', () => {
    expect(describeBillabilityCondition({ kind: 'event', event_type: 'contract_signature' })).toBe('Contract signature')
    expect(describeBillabilityCondition({ kind: 'event', event_type: 'delivery' })).toBe('Delivery')
    expect(describeBillabilityCondition({ kind: 'event', event_type: 'customer_acceptance' })).toBe('Customer acceptance')
    expect(describeBillabilityCondition({ kind: 'event', event_type: 'final_acceptance' })).toBe('Final acceptance')
    expect(describeBillabilityCondition({ kind: 'event', event_type: 'change_order_signature' })).toBe('Signed change order')
  })

  it('returns null for a null/undefined condition — never a fabricated label', () => {
    expect(describeBillabilityCondition(null)).toBeNull()
    expect(describeBillabilityCondition(undefined)).toBeNull()
  })
})

describe('isChangeOrderConditional — the structural signal for "may never become billable" (item 3 aggregation)', () => {
  it('is true only for event/change_order_signature', () => {
    expect(isChangeOrderConditional({ kind: 'event', event_type: 'change_order_signature' })).toBe(true)
  })

  it('is false for every other event_type — these are all events within the current agreement\'s guaranteed lifecycle', () => {
    expect(isChangeOrderConditional({ kind: 'event', event_type: 'contract_signature' })).toBe(false)
    expect(isChangeOrderConditional({ kind: 'event', event_type: 'delivery' })).toBe(false)
    expect(isChangeOrderConditional({ kind: 'event', event_type: 'customer_acceptance' })).toBe(false)
    expect(isChangeOrderConditional({ kind: 'event', event_type: 'final_acceptance' })).toBe(false)
  })

  it('is false for immediate and fixed_date', () => {
    expect(isChangeOrderConditional({ kind: 'immediate' })).toBe(false)
    expect(isChangeOrderConditional({ kind: 'fixed_date', date: '2026-10-15' })).toBe(false)
  })

  it('is false for null/undefined — an unresolved condition is not treated as conditional-on-a-change-order', () => {
    expect(isChangeOrderConditional(null)).toBe(false)
    expect(isChangeOrderConditional(undefined)).toBe(false)
  })
})

// Final amendment — never let "On delivery" stand in for an evaluated-but-
// unresolved condition. undefined (never entered Step 12) and null
// (Step 12 evaluated it and found nothing determinable) must resolve to
// genuinely different UI states.
describe('resolveOneTimeFeeTypeLabel — Step 12 undefined/null discriminator (final amendment)', () => {
  it('a real condition resolves to its canonical label, regardless of what a caller might otherwise show for manual_trigger', () => {
    expect(resolveOneTimeFeeTypeLabel({ kind: 'immediate' })).toEqual({ kind: 'condition', label: 'Immediate' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'fixed_date', date: '2026-10-15' })).toEqual({ kind: 'condition', label: 'Fixed date — 2026-10-15' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'contract_signature' })).toEqual({ kind: 'condition', label: 'Contract signature' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'delivery' })).toEqual({ kind: 'condition', label: 'Delivery' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'customer_acceptance' })).toEqual({ kind: 'condition', label: 'Customer acceptance' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'final_acceptance' })).toEqual({ kind: 'condition', label: 'Final acceptance' })
    expect(resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'change_order_signature' })).toEqual({ kind: 'condition', label: 'Signed change order' })
  })

  it('only a real event_type: "delivery" produces the "Delivery" label — never used as a generic fallback', () => {
    const result = resolveOneTimeFeeTypeLabel({ kind: 'event', event_type: 'delivery' })
    expect(result).toEqual({ kind: 'condition', label: 'Delivery' })
    // No other condition or the unresolved/legacy states ever produce this label.
    expect(resolveOneTimeFeeTypeLabel(null)).not.toEqual({ kind: 'condition', label: 'Delivery' })
    expect(resolveOneTimeFeeTypeLabel(undefined)).not.toEqual({ kind: 'condition', label: 'Delivery' })
  })

  it('billability_condition === null (Step 12 evaluated, unresolved) resolves to needs_review — never legacy_undefined, never a condition label', () => {
    expect(resolveOneTimeFeeTypeLabel(null)).toEqual({ kind: 'needs_review' })
  })

  it('billability_condition === undefined (never entered the Step 12 lifecycle — the true legacy shape) resolves to legacy_undefined, distinct from needs_review', () => {
    expect(resolveOneTimeFeeTypeLabel(undefined)).toEqual({ kind: 'legacy_undefined' })
    expect(resolveOneTimeFeeTypeLabel(undefined)).not.toEqual(resolveOneTimeFeeTypeLabel(null))
  })
})
