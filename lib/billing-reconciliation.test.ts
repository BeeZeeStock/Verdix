import { describe, it, expect } from 'vitest'
import {
  deriveBillingReconciliationState, deriveReconciliationCapabilities, assessBillingCorrection,
  type BillingReconciliationState,
} from './billing-reconciliation'
import type { BillingExecutionAttempt, BillingExecutionOperation, BillingExecutionOperationStatus } from './billing-execution-attempt'
import type { BillingPlanSnapshot } from './billing-execution-plan'

function makeSnapshot(lines: BillingPlanSnapshot['lines'], overrides: Partial<Omit<BillingPlanSnapshot, 'lines'>> = {}): BillingPlanSnapshot {
  return { provider: 'stripe', currency: 'SEK', customerIdentityKey: 'cust-key', ...overrides, lines }
}

function makeLine(componentKey: string, amount: number, overrides: Partial<BillingPlanSnapshot['lines'][number]> = {}): BillingPlanSnapshot['lines'][number] {
  return {
    kind: 'period', componentKey, amount, currency: 'SEK', quantity: 1, unitPrice: null,
    dueDate: '2026-01-01', vatMode: 'not_configured', vatRatePct: null, ...overrides,
  }
}

function makeAttempt(overrides: Partial<BillingExecutionAttempt> = {}): BillingExecutionAttempt {
  return {
    id: 'attempt-1', organizationId: 'org-1', jobId: 'job-1', provider: 'stripe', attemptNumber: 1,
    billingPlanFingerprint: 'fp-A', billingPlanSnapshot: makeSnapshot([makeLine('period:1:0', 1000)]),
    status: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z', retryOfAttemptId: null,
    ...overrides,
  }
}

function makeOperation(status: BillingExecutionOperationStatus, overrides: Partial<BillingExecutionOperation> = {}): BillingExecutionOperation {
  return {
    id: `op-${Math.random().toString(36).slice(2, 8)}`, attemptId: 'attempt-1', operationKey: 'resolve_customer',
    operationType: 'resolve_customer', idempotencyKey: 'idem-1', status, externalObjectId: status === 'succeeded' ? 'cus_123' : null,
    requestFingerprint: 'req-fp', retryCapability: 'idempotent_retry', errorClass: null,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: null,
    ...overrides,
  }
}

const identityFingerprint = () => 'fp-A' // pretend "current plan" reconstructs identically to the stored one
const differentFingerprint = () => 'fp-B'

describe('deriveBillingReconciliationState (Step 15, item 3 — the canonical resolver)', () => {
  it('no attempts at all -> none', () => {
    const state = deriveBillingReconciliationState({
      attempts: [], operationsByAttemptId: new Map(),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state).toEqual({ kind: 'none' })
  })

  it('latest attempt safe_to_supersede (failed_safe, no side effect) -> safe_to_resume', () => {
    const attempt = makeAttempt({ status: 'failed_safe' })
    const ops = [makeOperation('failed_safe')]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state).toEqual({ kind: 'safe_to_resume', attemptId: attempt.id, provider: 'stripe' })
  })

  it('an outcome_uncertain operation -> operation_outcome_uncertain, with the uncertain operation id surfaced', () => {
    const attempt = makeAttempt({ status: 'outcome_uncertain' })
    const uncertainOp = makeOperation('outcome_uncertain', { operationKey: 'create_invoice_item', operationType: 'create_invoice_item' })
    const ops = [makeOperation('succeeded'), uncertainOp]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    }) as Extract<BillingReconciliationState, { kind: 'operation_outcome_uncertain' }>
    expect(state.kind).toBe('operation_outcome_uncertain')
    expect(state.uncertainOperationIds).toEqual([uncertainOp.id])
    expect(state.operations).toHaveLength(2)
  })

  it('uncertain operation reconciled to not_executed (now failed_safe) with no other side effect -> safe_to_resume', () => {
    const attempt = makeAttempt({ status: 'failed_safe' })
    const ops = [makeOperation('failed_safe', { errorClass: 'reconciled_not_executed' })]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state.kind).toBe('safe_to_resume')
  })

  it('uncertain operation reconciled to succeeded (now the sole/last operation succeeded) -> executed classification', () => {
    const attempt = makeAttempt({ status: 'succeeded' })
    const ops = [makeOperation('succeeded', { externalObjectId: 'ii_manually_verified' })]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state.kind).toBe('executed_same_plan')
  })

  it('every operation succeeded + reconstructed fingerprint MATCHES stored -> executed_same_plan', () => {
    const attempt = makeAttempt()
    const ops = [makeOperation('succeeded')]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state).toEqual({ kind: 'executed_same_plan', attemptId: attempt.id, provider: 'stripe' })
  })

  it('every operation succeeded + reconstructed fingerprint DIFFERS -> executed_plan_changed, with both fingerprints', () => {
    const attempt = makeAttempt()
    const ops = [makeOperation('succeeded')]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: differentFingerprint, asOf: new Date(),
    })
    expect(state).toEqual({ kind: 'executed_plan_changed', attemptId: attempt.id, provider: 'stripe', executedFingerprint: 'fp-A', currentFingerprint: 'fp-B' })
  })

  it('a genuine mix of succeeded/failed_safe operations -> partially_executed, regardless of fingerprint', () => {
    const attempt = makeAttempt()
    const ops = [makeOperation('succeeded'), makeOperation('failed_safe', { operationKey: 'create_invoice', operationType: 'create_invoice' })]
    const state = deriveBillingReconciliationState({
      attempts: [attempt], operationsByAttemptId: new Map([[attempt.id, ops]]),
      recomputeFingerprintExcludingPriorSnapshot: differentFingerprint, asOf: new Date(),
    })
    expect(state.kind).toBe('partially_executed')
  })

  it('scans past a safe_to_supersede LATEST attempt to an older blocking one (defensive — mirrors the real barrier scan, not a latest-only shortcut)', () => {
    const older = makeAttempt({ id: 'attempt-1', attemptNumber: 1, status: 'outcome_uncertain' })
    const newer = makeAttempt({ id: 'attempt-2', attemptNumber: 2, status: 'failed_safe' })
    const state = deriveBillingReconciliationState({
      attempts: [newer, older], // newest-first, as getAttemptsForJob returns
      operationsByAttemptId: new Map([
        [newer.id, [makeOperation('failed_safe')]],
        [older.id, [makeOperation('outcome_uncertain')]],
      ]),
      recomputeFingerprintExcludingPriorSnapshot: identityFingerprint, asOf: new Date(),
    })
    expect(state.kind).toBe('operation_outcome_uncertain')
    if (state.kind === 'operation_outcome_uncertain') expect(state.attemptId).toBe(older.id)
  })
})

describe('deriveReconciliationCapabilities (Step 15, item 21 — server-derived available actions)', () => {
  it('none/executed_same_plan need no admin action at all', () => {
    for (const state of [{ kind: 'none' } as const, { kind: 'executed_same_plan', attemptId: 'a', provider: 'stripe' } as const]) {
      const caps = deriveReconciliationCapabilities(state as BillingReconciliationState)
      expect(caps.noAutomaticAction).toBe(true)
      expect(caps.canVerifySucceeded).toBe(false)
      expect(caps.correctionRequired).toBe(false)
    }
  })

  it('safe_to_resume enables the ordinary retry/approve path, not "no action"', () => {
    const caps = deriveReconciliationCapabilities({ kind: 'safe_to_resume', attemptId: 'a', provider: 'stripe' })
    expect(caps.canAuthorizeResume).toBe(true)
    expect(caps.noAutomaticAction).toBe(false)
    expect(caps.correctionRequired).toBe(false)
  })

  it('operation_outcome_uncertain with an uncertain op enables verify actions', () => {
    const caps = deriveReconciliationCapabilities({
      kind: 'operation_outcome_uncertain', attemptId: 'a', provider: 'stripe', operations: [], uncertainOperationIds: ['op-1'],
    })
    expect(caps.canVerifySucceeded).toBe(true)
    expect(caps.canVerifyNotExecuted).toBe(true)
  })

  it('operation_outcome_uncertain with NO genuinely uncertain op (defensive pending/started case) offers nothing to verify', () => {
    const caps = deriveReconciliationCapabilities({
      kind: 'operation_outcome_uncertain', attemptId: 'a', provider: 'stripe', operations: [], uncertainOperationIds: [],
    })
    expect(caps.canVerifySucceeded).toBe(false)
    expect(caps.canVerifyNotExecuted).toBe(false)
  })

  it('partially_executed offers no automatic action (item 16 — conservative)', () => {
    const caps = deriveReconciliationCapabilities({ kind: 'partially_executed', attemptId: 'a', provider: 'stripe', operations: [] })
    expect(caps.noAutomaticAction).toBe(true)
  })

  it('executed_plan_changed requires a correction review, offers no retry/verify action', () => {
    const caps = deriveReconciliationCapabilities({ kind: 'executed_plan_changed', attemptId: 'a', provider: 'stripe', executedFingerprint: 'A', currentFingerprint: 'B' })
    expect(caps.correctionRequired).toBe(true)
    expect(caps.canAuthorizeResume).toBe(false)
    expect(caps.noAutomaticAction).toBe(false)
  })
})

describe('assessBillingCorrection (Step 15, items 5/7/8 — deterministic, conservative comparison)', () => {
  it('identical executed and current snapshots -> none', () => {
    const snapshot = makeSnapshot([makeLine('period:1:0', 1000)])
    expect(assessBillingCorrection({ executedSnapshot: snapshot, currentCounterfactualSnapshot: snapshot })).toEqual({ kind: 'none' })
  })

  it('current amount higher than executed -> additional_charge_indicated', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000)])
    const current = makeSnapshot([makeLine('period:1:0', 1200)])
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result).toEqual({
      kind: 'additional_charge_indicated', totalDelta: 200,
      components: [{ componentKey: 'period:1:0', executedAmount: 1000, currentAmount: 1200, deltaAmount: 200 }],
    })
  })

  it('current amount lower than executed -> credit_indicated', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000)])
    const current = makeSnapshot([makeLine('period:1:0', 800)])
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result).toEqual({
      kind: 'credit_indicated', totalDelta: -200,
      components: [{ componentKey: 'period:1:0', executedAmount: 1000, currentAmount: 800, deltaAmount: -200 }],
    })
  })

  it('multiple components changing in opposite directions -> mixed_adjustment_indicated', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000), makeLine('fee:setup', 500, { kind: 'one_time_fee' })])
    const current = makeSnapshot([makeLine('period:1:0', 1200), makeLine('fee:setup', 300, { kind: 'one_time_fee' })])
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('mixed_adjustment_indicated')
    if (result.kind === 'mixed_adjustment_indicated') {
      expect(result.netDelta).toBe(0) // +200 and -200 net to zero
      expect(result.components).toHaveLength(2)
    }
  })

  it('customer identity changed -> manual_assessment_required, never a computed delta', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000)], { customerIdentityKey: 'cust-A' })
    const current = makeSnapshot([makeLine('period:1:0', 1200)], { customerIdentityKey: 'cust-B' })
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('manual_assessment_required')
  })

  it('currency changed -> manual_assessment_required', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000)], { currency: 'SEK' })
    const current = makeSnapshot([makeLine('period:1:0', 1000)], { currency: 'EUR' })
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('manual_assessment_required')
  })

  it('a component present in only one snapshot -> manual_assessment_required (item 8 — never fuzzy-matched, never guessed as a credit/charge)', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000)])
    const current = makeSnapshot([makeLine('period:1:1', 1000)]) // different period, not the same component
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('manual_assessment_required')
  })

  it('VAT treatment changed on a matched component -> manual_assessment_required, not a naive amount diff', () => {
    const executed = makeSnapshot([makeLine('period:1:0', 1000, { vatMode: 'zero_rated' })])
    const current = makeSnapshot([makeLine('period:1:0', 1000, { vatMode: 'rate', vatRatePct: 25 })])
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('manual_assessment_required')
  })

  it('never matches by description/label/array position — only by componentKey (item 8)', () => {
    // Two lines with swapped positions but same keys — must still match correctly by key, not position.
    const executed = makeSnapshot([makeLine('period:1:0', 1000), makeLine('period:1:1', 2000)])
    const current = makeSnapshot([makeLine('period:1:1', 2000), makeLine('period:1:0', 1500)]) // reordered
    const result = assessBillingCorrection({ executedSnapshot: executed, currentCounterfactualSnapshot: current })
    expect(result.kind).toBe('additional_charge_indicated')
    if (result.kind === 'additional_charge_indicated') {
      expect(result.components).toEqual([{ componentKey: 'period:1:0', executedAmount: 1000, currentAmount: 1500, deltaAmount: 500 }])
    }
  })
})
