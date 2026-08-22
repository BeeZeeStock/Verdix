import { describe, it, expect } from 'vitest'
import {
  parseBillabilityCondition, getBillabilityExecutionCapability, projectBillabilityConditionToExecutionFields,
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
