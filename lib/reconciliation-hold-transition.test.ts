import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeReconciliationHoldTransition, buildReconciliationBlockerDiagnostic, isReconciliationOutcomeClean,
  applyReconciliationHoldTransition, computePostMutationHoldTransition, computeReviewerPatchHoldTransition,
} from './reconciliation-hold-transition'
import type { ReconciliationOrchestrationResult } from './current-line-item-reconciliation-orchestration'
import type { BillingHold } from './billing-hold'

// Step 17H.4B0D4H1B3 — full transition-matrix coverage (§17/§18/§27/§29),
// pure, no DB. Extended 17H.4B0D4H1B3.4 for the never-approved AUTO_
// CONFIGURE ownership/reconciliation-safety correction — every AUTO_
// CONFIGURE claim now establishes a real hold regardless of whether an
// existing billing schedule exists; hasExistingBillingSchedule (renamed
// from previouslyApproved/previously_approved) only decides a CLEAN
// outcome's target (schedule_rebuild_required vs NULL), never whether the
// transition runs at all.

describe('computeReconciliationHoldTransition', () => {
  const NOW = '2026-09-14T00:00:00.000Z'

  it('schedule_rebuild_required: never touched, clean or not, regardless of hasExistingBillingSchedule', () => {
    const hold: BillingHold = { reason: 'schedule_rebuild_required', started_at: '2026-09-01T00:00:00.000Z' }
    for (const outcomeClean of [true, false]) {
      for (const hasExistingBillingSchedule of [true, false]) {
        const result = computeReconciliationHoldTransition({ startingKind: 'schedule_rebuild_required', currentHold: hold, outcomeClean, hasExistingBillingSchedule, blockerDiagnostic: [], now: NOW })
        expect(result).toEqual({ nextHold: hold, changeNeeded: false })
      }
    }
  })

  it('clear + clean outcome: stays clear, no change', () => {
    const result = computeReconciliationHoldTransition({ startingKind: 'clear', currentHold: null, outcomeClean: true, hasExistingBillingSchedule: true, blockerDiagnostic: [], now: NOW })
    expect(result).toEqual({ nextHold: null, changeNeeded: false })
  })

  it('clear + non-clean outcome: fresh schedule_rebuild_required, never reconciliation_blocked', () => {
    const result = computeReconciliationHoldTransition({ startingKind: 'clear', currentHold: null, outcomeClean: false, hasExistingBillingSchedule: true, blockerDiagnostic: [{ family: 'tier', reason: 'ambiguous', affectedCurrentIds: ['c1'] }], now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: NOW }, changeNeeded: true })
  })

  it('reexecution + clean + hasExistingBillingSchedule: schedule_rebuild_required, started_at carried forward', () => {
    const hold: BillingHold = { reason: 'reexecution', started_at: '2026-09-10T00:00:00.000Z' }
    const result = computeReconciliationHoldTransition({ startingKind: 'reexecution', currentHold: hold, outcomeClean: true, hasExistingBillingSchedule: true, blockerDiagnostic: [], now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: '2026-09-10T00:00:00.000Z' }, changeNeeded: true })
  })

  it('17H.4B0D4H1B3.4 §6: reexecution + clean + NO existing billing schedule: NULL, never schedule_rebuild_required', () => {
    const hold: BillingHold = { reason: 'reexecution', started_at: '2026-09-10T00:00:00.000Z' }
    const result = computeReconciliationHoldTransition({ startingKind: 'reexecution', currentHold: hold, outcomeClean: true, hasExistingBillingSchedule: false, blockerDiagnostic: [], now: NOW })
    expect(result).toEqual({ nextHold: null, changeNeeded: true })
  })

  it('reexecution + not clean: reconciliation_blocked, started_at carried forward, blockers attached — REGARDLESS of hasExistingBillingSchedule', () => {
    const hold: BillingHold = { reason: 'reexecution', started_at: '2026-09-10T00:00:00.000Z' }
    const diagnostic = [{ type: 'stale_plan', reason: 'current_set_changed' }]
    for (const hasExistingBillingSchedule of [true, false]) {
      const result = computeReconciliationHoldTransition({ startingKind: 'reexecution', currentHold: hold, outcomeClean: false, hasExistingBillingSchedule, blockerDiagnostic: diagnostic, now: NOW })
      expect(result).toEqual({ nextHold: { reason: 'reconciliation_blocked', started_at: '2026-09-10T00:00:00.000Z', blockers: diagnostic }, changeNeeded: true })
    }
  })

  it('reconciliation_blocked + clean: promoted to a FRESH schedule_rebuild_required (new started_at, not carried forward)', () => {
    const hold: BillingHold = { reason: 'reconciliation_blocked', started_at: '2026-09-05T00:00:00.000Z', blockers: [{ family: 'tier', reason: 'ambiguous' }] }
    const result = computeReconciliationHoldTransition({ startingKind: 'reconciliation_blocked', currentHold: hold, outcomeClean: true, hasExistingBillingSchedule: true, blockerDiagnostic: [], now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: NOW }, changeNeeded: true })
  })

  it('reconciliation_blocked + not clean: stays reconciliation_blocked with the LATEST blockers diagnostic', () => {
    const hold: BillingHold = { reason: 'reconciliation_blocked', started_at: '2026-09-05T00:00:00.000Z', blockers: [{ family: 'tier', reason: 'ambiguous' }] }
    const newDiagnostic = [{ family: 'one_time', reason: 'residual_identity_drift' }]
    const result = computeReconciliationHoldTransition({ startingKind: 'reconciliation_blocked', currentHold: hold, outcomeClean: false, hasExistingBillingSchedule: true, blockerDiagnostic: newDiagnostic, now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'reconciliation_blocked', started_at: '2026-09-05T00:00:00.000Z', blockers: newDiagnostic }, changeNeeded: true })
  })
})

describe('isReconciliationOutcomeClean', () => {
  it('applied with zero blockers is clean', () => {
    expect(isReconciliationOutcomeClean({ status: 'applied', updatedCount: 0, insertedCount: 0, supersededCount: 0, blockers: [], retried: false })).toBe(true)
  })
  it('applied with blockers is not clean', () => {
    expect(isReconciliationOutcomeClean({ status: 'applied', updatedCount: 0, insertedCount: 0, supersededCount: 0, blockers: [{ family: 'tier', reason: 'ambiguous', affectedCurrentIds: [] }], retried: false })).toBe(false)
  })
  it('stale_plan/invalid_plan/error are never clean', () => {
    expect(isReconciliationOutcomeClean({ status: 'stale_plan', staleReason: 'current_set_changed', blockers: [], retried: true })).toBe(false)
    expect(isReconciliationOutcomeClean({ status: 'invalid_plan', invalidReason: 'x', blockers: [], retried: false })).toBe(false)
    expect(isReconciliationOutcomeClean({ status: 'error', errorMessage: 'x', blockers: [], retried: false })).toBe(false)
  })
})

describe('buildReconciliationBlockerDiagnostic', () => {
  it('applied: returns the real planner blockers verbatim', () => {
    const blockers = [{ family: 'tier' as const, reason: 'ambiguous' as const, affectedCurrentIds: ['c1'] }]
    const outcome: ReconciliationOrchestrationResult = { status: 'applied', updatedCount: 0, insertedCount: 0, supersededCount: 0, blockers, retried: false }
    expect(buildReconciliationBlockerDiagnostic(outcome)).toEqual(blockers)
  })
  it('stale_plan: synthetic single entry with the real stale reason', () => {
    const outcome: ReconciliationOrchestrationResult = { status: 'stale_plan', staleReason: 'current_row_changed', blockers: [], retried: true }
    expect(buildReconciliationBlockerDiagnostic(outcome)).toEqual([{ type: 'stale_plan', reason: 'current_row_changed' }])
  })
  it('invalid_plan: synthetic single entry with the real reason string', () => {
    const outcome: ReconciliationOrchestrationResult = { status: 'invalid_plan', invalidReason: 'update_changes_forbidden_key: confidence_score', blockers: [], retried: false }
    expect(buildReconciliationBlockerDiagnostic(outcome)).toEqual([{ type: 'invalid_plan', reason: 'update_changes_forbidden_key: confidence_score' }])
  })
  it('error: synthetic entry with NO raw error message (never persisted into a hold)', () => {
    const outcome: ReconciliationOrchestrationResult = { status: 'error', errorMessage: 'connection string leaked here', blockers: [], retried: false }
    const diagnostic = buildReconciliationBlockerDiagnostic(outcome)
    expect(diagnostic).toEqual([{ type: 'applier_error' }])
    expect(JSON.stringify(diagnostic)).not.toContain('connection string')
  })
})

describe('applyReconciliationHoldTransition', () => {
  it('returns applied:true on a successful CAS', async () => {
    const rpcSpy = vi.fn().mockResolvedValue({ data: true, error: null })
    const client = { rpc: rpcSpy } as unknown as SupabaseClient
    const next = { reason: 'schedule_rebuild_required' as const, started_at: '2026-09-14T00:00:00.000Z' }
    const result = await applyReconciliationHoldTransition(client, 'job-1', null, next)
    expect(result).toEqual({ applied: true, nextHold: next })
    expect(rpcSpy).toHaveBeenCalledWith('replace_billing_hold_if_unchanged', { p_job_id: 'job-1', p_expected_hold: null, p_next_hold: next })
  })

  it('returns applied:false on a CAS miss, never throws', async () => {
    const rpcSpy = vi.fn().mockResolvedValue({ data: false, error: null })
    const client = { rpc: rpcSpy } as unknown as SupabaseClient
    const result = await applyReconciliationHoldTransition(client, 'job-1', null, { reason: 'schedule_rebuild_required', started_at: 'x' })
    expect(result.applied).toBe(false)
  })

  it('returns applied:false on an RPC error, never throws', async () => {
    const rpcSpy = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const client = { rpc: rpcSpy } as unknown as SupabaseClient
    const result = await applyReconciliationHoldTransition(client, 'job-1', null, { reason: 'schedule_rebuild_required', started_at: 'x' })
    expect(result.applied).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.4B0D4H1B3.1, revised 17H.4B0D4H1B3.4 — the claim-first pattern's
// post-mutation transition.
describe('computePostMutationHoldTransition', () => {
  const NOW = '2026-09-15T00:00:00.000Z'
  const cleanApplied = (n = 0): ReconciliationOrchestrationResult => ({ status: 'applied', updatedCount: n, insertedCount: 0, supersededCount: 0, blockers: [], retried: false })
  const blockedApplied: ReconciliationOrchestrationResult = { status: 'applied', updatedCount: 0, insertedCount: 1, supersededCount: 0, blockers: [{ family: 'tier', reason: 'ambiguous', affectedCurrentIds: ['c1'] }], retried: false }
  const errorOutcome: ReconciliationOrchestrationResult = { status: 'error', errorMessage: 'network reset', blockers: [], retried: false }

  it('17H.4B0D4H1B3.4: never-approved + clean -> NULL (no existing schedule to rebuild), always runs now (never a no-op skip)', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: false }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(), allowRestoreToNullWhenUnmutated: false, now: NOW })
    expect(result).toEqual({ nextHold: null, changeNeeded: true })
  })

  it('17H.4B0D4H1B3.4 §7: never-approved + blockers -> reconciliation_blocked (first approval must be refused)', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: false }
    const result = computePostMutationHoldTransition({ claim, outcome: blockedApplied, allowRestoreToNullWhenUnmutated: false, now: NOW })
    expect(result.nextHold).toEqual({ reason: 'reconciliation_blocked', started_at: NOW, blockers: blockedApplied.blockers })
  })

  it('reconcile-line-items case (§13): previous NULL + clean + zero mutations -> restore NULL', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(0), allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result).toEqual({ nextHold: null, changeNeeded: true })
  })

  it('reconcile-line-items case (§14): previous NULL + clean + real mutations -> schedule_rebuild_required, not restored', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(3), allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: NOW }, changeNeeded: true })
  })

  it('confirm-rule case: allowRestoreToNullWhenUnmutated=false — previous NULL + clean + zero mutations still promotes to schedule_rebuild_required (when hasExistingBillingSchedule)', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(0), allowRestoreToNullWhenUnmutated: false, now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: NOW }, changeNeeded: true })
  })

  it('§18: an ambiguous RPC error can never trigger the restore-to-null branch, even with previous NULL', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: null, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: errorOutcome, allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result.nextHold).toEqual({ reason: 'reconciliation_blocked', started_at: NOW, blockers: [{ type: 'applier_error' }] })
  })

  it('blockers present -> reconciliation_blocked, started_at carried from the temporary claim', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: '2026-09-10T00:00:00.000Z' }
    const claim = { previousBillingHold: { reason: 'reconciliation_blocked' as const, started_at: '2026-09-01T00:00:00.000Z' }, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: blockedApplied, allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result.nextHold).toEqual({ reason: 'reconciliation_blocked', started_at: '2026-09-10T00:00:00.000Z', blockers: blockedApplied.blockers })
  })

  it('previous reconciliation_blocked + clean (even with mutations) -> schedule_rebuild_required', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: { reason: 'reconciliation_blocked' as const, started_at: '2026-09-01T00:00:00.000Z' }, newBillingHold: temp, hasExistingBillingSchedule: true }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(2), allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result).toEqual({ nextHold: { reason: 'schedule_rebuild_required', started_at: NOW }, changeNeeded: true })
  })

  it('17H.4B0D4H1B3.4 §15: never-approved job starting from reconciliation_blocked, resolved cleanly -> NULL, not schedule_rebuild_required', () => {
    const temp: BillingHold = { reason: 'reexecution', started_at: NOW }
    const claim = { previousBillingHold: { reason: 'reconciliation_blocked' as const, started_at: '2026-09-01T00:00:00.000Z' }, newBillingHold: temp, hasExistingBillingSchedule: false }
    const result = computePostMutationHoldTransition({ claim, outcome: cleanApplied(2), allowRestoreToNullWhenUnmutated: true, now: NOW })
    expect(result).toEqual({ nextHold: null, changeNeeded: true })
  })
})

describe('computeReviewerPatchHoldTransition', () => {
  const NOW = '2026-09-15T00:00:00.000Z'

  it('clear + hasExistingBillingSchedule -> fresh schedule_rebuild_required', () => {
    const result = computeReviewerPatchHoldTransition({ startingKind: 'clear', originalHold: null, hasExistingBillingSchedule: true, now: NOW })
    expect(result).toEqual({ reason: 'schedule_rebuild_required', started_at: NOW })
  })

  it('17H.4B0D4H1B3.4: clear + NO existing billing schedule -> NULL, never manufactures a hold for a never-approved job', () => {
    const result = computeReviewerPatchHoldTransition({ startingKind: 'clear', originalHold: null, hasExistingBillingSchedule: false, now: NOW })
    expect(result).toBeNull()
  })

  it('schedule_rebuild_required -> stays schedule_rebuild_required, started_at carried forward', () => {
    const original: BillingHold = { reason: 'schedule_rebuild_required', started_at: '2026-09-01T00:00:00.000Z' }
    const result = computeReviewerPatchHoldTransition({ startingKind: 'schedule_rebuild_required', originalHold: original, hasExistingBillingSchedule: true, now: NOW })
    expect(result).toEqual({ reason: 'schedule_rebuild_required', started_at: '2026-09-01T00:00:00.000Z' })
  })

  it('reconciliation_blocked -> released back to its exact prior content, never downgraded, regardless of hasExistingBillingSchedule', () => {
    const original: BillingHold = { reason: 'reconciliation_blocked', started_at: '2026-09-01T00:00:00.000Z', blockers: [{ family: 'tier' }] }
    for (const hasExistingBillingSchedule of [true, false]) {
      const result = computeReviewerPatchHoldTransition({ startingKind: 'reconciliation_blocked', originalHold: original, hasExistingBillingSchedule, now: NOW })
      expect(result).toEqual(original)
    }
  })
})
