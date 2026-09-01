import { describe, it, expect } from 'vitest'
import { parseBillingHold, evaluateBillingGate, shouldClearBillingHoldAfterSuccess, describeBillingHoldReason } from './billing-hold'

describe('parseBillingHold — Step 17H.4B0D4H1A', () => {
  it('null/undefined parse as clear', () => {
    expect(parseBillingHold(null)).toEqual({ status: 'clear' })
    expect(parseBillingHold(undefined)).toEqual({ status: 'clear' })
  })

  it('a well-formed hold parses with its reason', () => {
    expect(parseBillingHold({ reason: 'reexecution' })).toEqual({
      status: 'held', hold: { reason: 'reexecution', started_at: undefined, blockers: undefined },
    })
  })

  it('optional started_at/blockers are carried through when present and well-typed', () => {
    const result = parseBillingHold({ reason: 'reconciliation_blocked', started_at: '2026-08-28T00:00:00Z', blockers: [{ family: 'tier' }] })
    expect(result).toEqual({
      status: 'held',
      hold: { reason: 'reconciliation_blocked', started_at: '2026-08-28T00:00:00Z', blockers: [{ family: 'tier' }] },
    })
  })

  it('malformed started_at/blockers are dropped, not fatal — the reason alone still governs', () => {
    const result = parseBillingHold({ reason: 'schedule_rebuild_required', started_at: 123, blockers: 'not-an-array' })
    expect(result).toEqual({ status: 'held', hold: { reason: 'schedule_rebuild_required', started_at: undefined, blockers: undefined } })
  })

  it('an unrecognized reason string is malformed, never silently treated as clear', () => {
    expect(parseBillingHold({ reason: 'some_future_reason_this_code_does_not_know' })).toEqual({ status: 'malformed' })
  })

  it('a non-object non-null value is malformed', () => {
    expect(parseBillingHold('reexecution')).toEqual({ status: 'malformed' })
    expect(parseBillingHold(42)).toEqual({ status: 'malformed' })
    expect(parseBillingHold(true)).toEqual({ status: 'malformed' })
  })

  it('an array is malformed (not a valid hold shape, even though typeof is "object")', () => {
    expect(parseBillingHold(['reexecution'])).toEqual({ status: 'malformed' })
  })

  it('an object with no reason field at all is malformed', () => {
    expect(parseBillingHold({ started_at: '2026-08-28T00:00:00Z' })).toEqual({ status: 'malformed' })
  })
})

describe('evaluateBillingGate — Step 17H.4B0D4H1A (frozen operation-aware gating matrix)', () => {
  // Group 1 — monetary_action: blocked whenever hold != null, no exceptions.
  it('monetary_action: hold NULL -> allowed', () => {
    expect(evaluateBillingGate(null, 'monetary_action')).toEqual({ allowed: true })
  })
  it('monetary_action: reexecution -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reexecution' }, 'monetary_action').allowed).toBe(false)
  })
  it('monetary_action: reconciliation_blocked -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reconciliation_blocked' }, 'monetary_action').allowed).toBe(false)
  })
  it('monetary_action: schedule_rebuild_required -> blocked (never a resolving operation)', () => {
    expect(evaluateBillingGate({ reason: 'schedule_rebuild_required' }, 'monetary_action').allowed).toBe(false)
  })

  // Group 2 — approve.
  it('approve: hold NULL -> allowed (ordinary PENDING_HUMAN_REVIEW approval unaffected)', () => {
    expect(evaluateBillingGate(null, 'approve')).toEqual({ allowed: true })
  })
  it('approve: reexecution -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reexecution' }, 'approve').allowed).toBe(false)
  })
  it('approve: reconciliation_blocked -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reconciliation_blocked' }, 'approve').allowed).toBe(false)
  })
  it('approve: schedule_rebuild_required -> allowed (the hold-resolving state)', () => {
    expect(evaluateBillingGate({ reason: 'schedule_rebuild_required' }, 'approve')).toEqual({ allowed: true })
  })

  // Group 3 — rebuild_schedule, identical matrix to approve.
  it('rebuild_schedule: hold NULL -> allowed', () => {
    expect(evaluateBillingGate(null, 'rebuild_schedule')).toEqual({ allowed: true })
  })
  it('rebuild_schedule: reexecution -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reexecution' }, 'rebuild_schedule').allowed).toBe(false)
  })
  it('rebuild_schedule: reconciliation_blocked -> blocked', () => {
    expect(evaluateBillingGate({ reason: 'reconciliation_blocked' }, 'rebuild_schedule').allowed).toBe(false)
  })
  it('rebuild_schedule: schedule_rebuild_required -> allowed', () => {
    expect(evaluateBillingGate({ reason: 'schedule_rebuild_required' }, 'rebuild_schedule')).toEqual({ allowed: true })
  })

  // Group 4 — malformed non-null hold blocks EVERYTHING, including the two
  // operations that would otherwise be hold-resolving. No admin bypass in
  // this task's scope.
  it('malformed non-null hold: monetary_action blocked', () => {
    expect(evaluateBillingGate({ reason: 'not-a-real-reason' }, 'monetary_action').allowed).toBe(false)
  })
  it('malformed non-null hold: approve blocked (never treated as resolvable)', () => {
    expect(evaluateBillingGate('garbage-string-value', 'approve').allowed).toBe(false)
  })
  it('malformed non-null hold: rebuild_schedule blocked', () => {
    expect(evaluateBillingGate({}, 'rebuild_schedule').allowed).toBe(false)
  })
})

describe('shouldClearBillingHoldAfterSuccess — Step 17H.4B0D4H1A', () => {
  it('clears only for schedule_rebuild_required', () => {
    expect(shouldClearBillingHoldAfterSuccess({ reason: 'schedule_rebuild_required' })).toBe(true)
  })
  it('never clears for reexecution', () => {
    expect(shouldClearBillingHoldAfterSuccess({ reason: 'reexecution' })).toBe(false)
  })
  it('never clears for reconciliation_blocked', () => {
    expect(shouldClearBillingHoldAfterSuccess({ reason: 'reconciliation_blocked' })).toBe(false)
  })
  it('never clears when the hold was already NULL — nothing to clear', () => {
    expect(shouldClearBillingHoldAfterSuccess(null)).toBe(false)
  })
  it('never clears a malformed hold', () => {
    expect(shouldClearBillingHoldAfterSuccess({ reason: 'unknown' })).toBe(false)
  })
})

describe('describeBillingHoldReason — Step 17H.4B0D4H1A', () => {
  it('produces a distinct, non-empty, user-facing message for every reason', () => {
    const messages = new Set(
      (['reexecution', 'reconciliation_blocked', 'schedule_rebuild_required'] as const).map(describeBillingHoldReason),
    )
    expect(messages.size).toBe(3)
    for (const m of messages) expect(m.length).toBeGreaterThan(10)
  })
})
