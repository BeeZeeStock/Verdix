import { describe, it, expect } from 'vitest'
import { resolveOperationalEventEvidence, isOneTimeFeeHeldForExecution, type OperationalEventEvidence } from './operational-event-evidence'
import type { BillabilityCondition } from './types'

const ASOF = new Date('2026-10-15T00:00:00.000Z')

function evidence(overrides: Partial<OperationalEventEvidence> = {}): OperationalEventEvidence {
  return {
    id: 'ev-1', subjectId: 'fee-1', eventType: 'customer_acceptance',
    occurredAt: '2026-10-12T14:00:00.000Z', source: 'reviewer_attestation',
    recordedAt: '2026-10-13T09:20:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    ...overrides,
  }
}

const CUSTOMER_ACCEPTANCE: BillabilityCondition = { kind: 'event', event_type: 'customer_acceptance' }

describe('resolveOperationalEventEvidence — required flag (immediate/fixed_date/null never need evidence)', () => {
  it('immediate: never required', () => {
    expect(resolveOperationalEventEvidence({ condition: { kind: 'immediate' }, subjectId: 'fee-1', evidence: [], asOf: ASOF }))
      .toEqual({ required: false, satisfied: false })
  })
  it('fixed_date: never required', () => {
    expect(resolveOperationalEventEvidence({ condition: { kind: 'fixed_date', date: '2026-10-15' }, subjectId: 'fee-1', evidence: [], asOf: ASOF }))
      .toEqual({ required: false, satisfied: false })
  })
  it('null/undefined condition: never required (nothing to evidence yet)', () => {
    expect(resolveOperationalEventEvidence({ condition: null, subjectId: 'fee-1', evidence: [], asOf: ASOF })).toEqual({ required: false, satisfied: false })
    expect(resolveOperationalEventEvidence({ condition: undefined, subjectId: 'fee-1', evidence: [], asOf: ASOF })).toEqual({ required: false, satisfied: false })
  })
})

describe('resolveOperationalEventEvidence — matching (item 5/23 adversarial matrix)', () => {
  it('correct event + correct subject → satisfies', () => {
    const result = resolveOperationalEventEvidence({ condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1', evidence: [evidence()], asOf: ASOF })
    expect(result).toEqual({ required: true, satisfied: true, evidence: evidence() })
  })

  it('wrong event type → does not satisfy', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ eventType: 'delivery' })], asOf: ASOF,
    })
    expect(result).toEqual({ required: true, satisfied: false })
  })

  it('correct event for another subject/fee → does not satisfy', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ subjectId: 'fee-2' })], asOf: ASOF,
    })
    expect(result).toEqual({ required: true, satisfied: false })
  })

  it('revoked evidence → does not satisfy', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ status: 'revoked' })], asOf: ASOF,
    })
    expect(result).toEqual({ required: true, satisfied: false })
  })

  it('future-dated occurredAt (relative to asOf) → does not satisfy', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ occurredAt: '2026-11-01T00:00:00.000Z' })], asOf: ASOF,
    })
    expect(result).toEqual({ required: true, satisfied: false })
  })

  it('occurredAt exactly equal to asOf → satisfies (boundary inclusive)', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ occurredAt: ASOF.toISOString() })], asOf: ASOF,
    })
    expect(result.satisfied).toBe(true)
  })

  it('unsupported/untrusted evidence source → does not satisfy (defensive — never trusts an unrecognized source string)', () => {
    const result = resolveOperationalEventEvidence({
      condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1',
      evidence: [evidence({ source: 'customer_email_forwarded' as OperationalEventEvidence['source'] })], asOf: ASOF,
    })
    expect(result).toEqual({ required: true, satisfied: false })
  })

  it('delivery evidence never satisfies customer_acceptance, and vice versa (item 19 — Step 12 distinction preserved)', () => {
    const deliveryCondition: BillabilityCondition = { kind: 'event', event_type: 'delivery' }
    const acceptanceEvidence = [evidence({ eventType: 'customer_acceptance' })]
    expect(resolveOperationalEventEvidence({ condition: deliveryCondition, subjectId: 'fee-1', evidence: acceptanceEvidence, asOf: ASOF }).satisfied).toBe(false)

    const deliveryEvidence = [evidence({ eventType: 'delivery' })]
    expect(resolveOperationalEventEvidence({ condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1', evidence: deliveryEvidence, asOf: ASOF }).satisfied).toBe(false)
  })

  it('no evidence at all → required true, satisfied false', () => {
    expect(resolveOperationalEventEvidence({ condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1', evidence: [], asOf: ASOF }))
      .toEqual({ required: true, satisfied: false })
  })

  it('multiple candidates (defensive — should not occur given the DB uniqueness constraint) → most recent occurrence wins deterministically', () => {
    const older = evidence({ id: 'ev-old', occurredAt: '2026-10-10T00:00:00.000Z' })
    const newer = evidence({ id: 'ev-new', occurredAt: '2026-10-12T00:00:00.000Z' })
    const result = resolveOperationalEventEvidence({ condition: CUSTOMER_ACCEPTANCE, subjectId: 'fee-1', evidence: [older, newer], asOf: ASOF })
    expect(result.evidence?.id).toBe('ev-new')
  })
})

describe('isOneTimeFeeHeldForExecution — item 11, the shared billing-writer execution decision', () => {
  it('a genuine legacy manual_trigger fee (no billability_condition) is held, exactly like Step 11', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: true }, [], ASOF)).toBe(true)
  })

  it('a genuine legacy fee with manual_trigger false is not held', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: false }, [], ASOF)).toBe(false)
    expect(isOneTimeFeeHeldForExecution({}, [], ASOF)).toBe(false)
  })

  it('an event-conditioned fee with no evidence is held, REGARDLESS of the persisted manual_trigger value — never trusts the stale field', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: false, billability_condition: CUSTOMER_ACCEPTANCE, fee_id: 'fee-1' }, [], ASOF)).toBe(true)
  })

  it('an event-conditioned fee WITH satisfied evidence is NOT held — proceeds through normal execution — regardless of a stale manual_trigger:true', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: true, billability_condition: CUSTOMER_ACCEPTANCE, fee_id: 'fee-1' }, [evidence()], ASOF)).toBe(false)
  })

  it('an immediate/fixed_date condition is never held via this function\'s event branch (falls through to manual_trigger, normally false for these)', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: false, billability_condition: { kind: 'immediate' } }, [], ASOF)).toBe(false)
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: false, billability_condition: { kind: 'fixed_date', date: '2026-10-15' } }, [], ASOF)).toBe(false)
  })

  it('revoked evidence does not un-hold an event fee', () => {
    expect(isOneTimeFeeHeldForExecution(
      { manual_trigger: true, billability_condition: CUSTOMER_ACCEPTANCE, fee_id: 'fee-1' },
      [evidence({ status: 'revoked' })], ASOF,
    )).toBe(true)
  })

  it('no fee_id at all → always held, fails closed (can never match real evidence, even evidence that exists for a real subject)', () => {
    expect(isOneTimeFeeHeldForExecution({ manual_trigger: false, billability_condition: CUSTOMER_ACCEPTANCE }, [evidence({ subjectId: 'fee-1' })], ASOF)).toBe(true)
  })
})
