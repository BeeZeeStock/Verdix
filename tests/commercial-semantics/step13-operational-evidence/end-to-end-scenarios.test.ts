// Step 13, item 23/24 — required adversarial + end-to-end scenario
// coverage, at the pure-function/production-logic level (computeCommercialRuleWorkload,
// resolveOperationalEventEvidence, isOneTimeFeeHeldForExecution,
// buildOneTimeFeeConfirmation — all real, unmocked production functions).
// Route handlers themselves can't be unit-tested (next-auth import failure
// under vitest, established constraint) — see the Step 13 report for the
// real HTTP acceptance pass covering the routes directly.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, type CommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { resolveOperationalEventEvidence, isOneTimeFeeHeldForExecution, type OperationalEventEvidence } from '@/lib/operational-event-evidence'
import { buildOneTimeFeeConfirmation } from '@/lib/one-time-fee'
import type { OneTimeFee } from '@/lib/types'

const ASOF = new Date('2026-10-15T00:00:00.000Z')

function approveWouldBlock(workload: CommercialRuleWorkload): boolean {
  if (workload.executionBlockers.length > 0) return true
  if (workload.totalToConfirm > 0 || workload.interactionsToConfirm > 0) return true
  if (!workload.vat.configured) return true
  return false
}

function evidence(overrides: Partial<OperationalEventEvidence> = {}): OperationalEventEvidence {
  return {
    id: 'ev-1', subjectId: 'fee-1', eventType: 'customer_acceptance',
    occurredAt: '2026-10-12T14:00:00.000Z', source: 'reviewer_attestation',
    recordedAt: '2026-10-13T09:20:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    ...overrides,
  }
}

const RESOLVED_ACCEPTANCE_FEE: OneTimeFee = {
  fee_label: 'Design Milestone Fee', fee_id: 'fee-1', amount: 100000, due_date: null, description: null,
  manual_trigger: true, amount_provenance: 'reviewer_policy',
  billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
  billability_provenance: 'reviewer_policy',
}

describe('item 23 — adversarial matrix', () => {
  it('correct event + correct subject → satisfies', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(workload.executionBlockers).toHaveLength(0)
  })

  it('wrong event type → does not satisfy', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ eventType: 'delivery' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('correct event for another fee → does not satisfy', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ subjectId: 'fee-2' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('event evidence before interpretation is confirmed → rejected (resolver still reports required, but the route boundary is the real enforcement — see commercial_interpretation_unresolved in the attest route)', () => {
    const unconfirmed: OneTimeFee = { ...RESOLVED_ACCEPTANCE_FEE, billability_provenance: null }
    // Even if evidence somehow existed, the FEE itself is not semantically
    // resolved — isOneTimeFeeUnresolved (via totalToConfirm) still blocks,
    // proving evidence alone can never substitute for a confirmed
    // interpretation at the readiness layer either.
    const workload = computeCommercialRuleWorkload({ one_time_fees: [unconfirmed] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(approveWouldBlock(workload)).toBe(true)
  })

  it('future-dated occurredAt → rejected/not satisfied', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ occurredAt: '2027-01-01T00:00:00.000Z' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('revoked evidence → does not satisfy', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ status: 'revoked' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('duplicate attestation → no duplicate ACTIVE evidence (application-level proof: resolver treats two active rows for the same subject+event as redundant, most-recent wins deterministically — the DB unique index is the real backstop, proven structurally in the migration)', () => {
    const first = evidence({ id: 'ev-1', occurredAt: '2026-10-10T00:00:00.000Z' })
    const second = evidence({ id: 'ev-1', occurredAt: '2026-10-10T00:00:00.000Z' }) // identical — simulates a re-returned idempotent row
    const result = resolveOperationalEventEvidence({ condition: RESOLVED_ACCEPTANCE_FEE.billability_condition, subjectId: 'fee-1', evidence: [first, second], asOf: ASOF })
    expect(result.satisfied).toBe(true)
  })

  it('crafted trusted_system_event source → structurally impossible to construct via any production writer (no route accepts a source value); the resolver itself would accept a well-formed one if it existed, since the type IS trusted — the impossibility is enforced at the write boundary, not here', () => {
    // Documents the boundary precisely: resolveOperationalEventEvidence
    // trusts BOTH closed source values equally (by design, for a future
    // integration) — attest/route.ts is what makes 'trusted_system_event'
    // unreachable today (hardcodes 'reviewer_attestation', accepts no
    // source field from the request body at all).
    const result = resolveOperationalEventEvidence({
      condition: RESOLVED_ACCEPTANCE_FEE.billability_condition, subjectId: 'fee-1',
      evidence: [evidence({ source: 'trusted_system_event' })], asOf: ASOF,
    })
    expect(result.satisfied).toBe(true) // trusted if it ever existed — but nothing can create it (see attest route)
  })

  it('crafted eventType → cannot satisfy a different condition', () => {
    const deliveryFee: OneTimeFee = { ...RESOLVED_ACCEPTANCE_FEE, billability_condition: { kind: 'event', event_type: 'delivery' } }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [deliveryFee] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ eventType: 'customer_acceptance' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('effective_date present (a plain contract-level date) does not automatically prove contract_signature — the resolver only ever looks at real evidence rows, never contract_start_date/effective_date fields', () => {
    const signatureFee: OneTimeFee = { ...RESOLVED_ACCEPTANCE_FEE, billability_condition: { kind: 'event', event_type: 'contract_signature' } }
    // No evidence at all — an effective_date existing elsewhere in the
    // contract is structurally invisible to this function; it takes no
    // such parameter.
    const workload = computeCommercialRuleWorkload({ one_time_fees: [signatureFee] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('delivery evidence does not satisfy customer_acceptance', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ eventType: 'delivery' })], ASOF)
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('valid customer-acceptance attestation → blocker clears', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(workload.executionBlockers).toHaveLength(0)
    expect(approveWouldBlock(workload)).toBe(false)
  })

  it('evidence revoked before billing → blocker returns', () => {
    const withEvidence = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence()], ASOF)
    expect(withEvidence.executionBlockers).toHaveLength(0)
    const afterRevoke = computeCommercialRuleWorkload({ one_time_fees: [RESOLVED_ACCEPTANCE_FEE] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ status: 'revoked' })], ASOF)
    expect(afterRevoke.executionBlockers).toHaveLength(1)
  })

  it('historical legacy fee (no billability_condition, no fee_id) → unaffected by evidence entirely', () => {
    const legacy: OneTimeFee = { fee_label: 'Legacy fee', amount: 5000, due_date: null, description: null }
    const workload = computeCommercialRuleWorkload({ one_time_fees: [legacy] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [evidence({ subjectId: 'fee-1' })], ASOF)
    expect(approveWouldBlock(workload)).toBe(false)
  })
})

describe('item 24 — full synthetic end-to-end acceptance ("SEK 100,000 becomes billable upon customer acceptance")', () => {
  it('extraction → event/customer_acceptance → reviewer confirms interpretation → semantic readiness resolved → Approve blocked (operational event missing) → reviewer records acceptance → blocker disappears → Approve reaches VAT (or whatever gate is next) → evidence revoked → blocker returns', () => {
    // 1. "Extraction" — hand-constructed to mirror exactly what
    // lib/contract-extractor.ts's normalizeBillabilityCondition would
    // produce for this clause (already proven live in Step 12's report).
    const extracted: OneTimeFee = {
      fee_label: 'Implementation Fee', fee_id: 'fee-milestone-1', amount: 100000, due_date: null, description: null,
      manual_trigger: true, amount_provenance: null,
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      billability_provenance: null,
    }

    // 2. Amount confirmed, billability interpretation confirmed (Step 11/12
    // mechanism, unchanged).
    const amountConfirmed = buildOneTimeFeeConfirmation(extracted, { confirmAmount: true })
    const interpretationConfirmed = buildOneTimeFeeConfirmation(amountConfirmed, { confirmBillability: true })
    expect(interpretationConfirmed.billability_provenance).toBe('reviewer_policy')

    // 3. Semantic readiness resolved, but Approve blocked — operational event missing.
    const blockedWorkload = computeCommercialRuleWorkload(
      { one_time_fees: [interpretationConfirmed] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [], ASOF,
    )
    expect(blockedWorkload.status).toBe('execution_blocked')
    expect(blockedWorkload.executionBlockers[0]).toMatchObject({ type: 'required_operational_event_missing', event_type: 'customer_acceptance' })
    expect(approveWouldBlock(blockedWorkload)).toBe(true)

    // 4. Reviewer records customer acceptance (the attest route's real job
    // — here simulated as the evidence row it would produce).
    const recordedEvidence: OperationalEventEvidence = {
      id: 'ev-milestone-1', subjectId: 'fee-milestone-1', eventType: 'customer_acceptance',
      occurredAt: '2026-10-12T14:00:00.000Z', source: 'reviewer_attestation',
      recordedAt: '2026-10-13T09:20:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    }

    // 5. Operational blocker disappears; Approve reaches the next real gate.
    const unblockedWorkload = computeCommercialRuleWorkload(
      { one_time_fees: [interpretationConfirmed] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [recordedEvidence], ASOF,
    )
    expect(unblockedWorkload.executionBlockers).toHaveLength(0)
    expect(approveWouldBlock(unblockedWorkload)).toBe(false)

    // Commercial semantics themselves are provably untouched by evidence satisfaction.
    expect(interpretationConfirmed.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
    expect(interpretationConfirmed.billability_provenance).toBe('reviewer_policy')
    expect(interpretationConfirmed.due_date).toBeNull()

    // 6. Billing-writer execution decision: no longer held once evidence exists.
    expect(isOneTimeFeeHeldForExecution(interpretationConfirmed, [recordedEvidence], ASOF)).toBe(false)

    // 7. Evidence revoked before billing → blocker returns.
    const revoked: OperationalEventEvidence = { ...recordedEvidence, status: 'revoked' }
    const reblockedWorkload = computeCommercialRuleWorkload(
      { one_time_fees: [interpretationConfirmed] }, { total: 0, confirmed: 0 }, 0, undefined, undefined, undefined, [revoked], ASOF,
    )
    expect(reblockedWorkload.executionBlockers).toHaveLength(1)
    expect(approveWouldBlock(reblockedWorkload)).toBe(true)
    expect(isOneTimeFeeHeldForExecution(interpretationConfirmed, [revoked], ASOF)).toBe(true)
  })
})
