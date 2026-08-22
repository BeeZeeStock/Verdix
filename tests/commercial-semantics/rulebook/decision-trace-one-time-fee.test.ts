// Verdix commercial decision trace — OneTimeFee billability_condition
// (Step 12, item 20; extended Step 13, item 20). Proves the thin adapter
// (lib/rulebook/decision-trace-one-time-fee.ts) composes the unmodified
// Step 8 generic composer correctly, and reuses Step 13's real
// resolveOperationalEventEvidence (unmodified) for the operationalEvidence
// facts — never a hand-rolled duplicate of that matching logic.
import { describe, it, expect } from 'vitest'
import { buildOneTimeFeeBillabilityTrace, ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD } from '@/lib/rulebook/decision-trace-one-time-fee'
import type { OperationalEventEvidence } from '@/lib/operational-event-evidence'

const AS_OF = new Date('2026-10-15T00:00:00.000Z')

function evidence(overrides: Partial<OperationalEventEvidence> = {}): OperationalEventEvidence {
  return {
    id: 'ev-1', subjectId: 'fee-1', eventType: 'customer_acceptance',
    occurredAt: '2026-10-12T14:00:00.000Z', source: 'reviewer_attestation',
    recordedAt: '2026-10-13T09:20:00.000Z', recordedBy: 'reviewer@example.com', status: 'active',
    ...overrides,
  }
}

describe('buildOneTimeFeeBillabilityTrace — semantic resolution vs operational evidence (item 5/20)', () => {
  it('an unresolved condition (billability_provenance null): semantically blocking, evidence required but not yet satisfied', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: null,
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [],
    })
    expect(trace.field).toBe(ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD)
    expect(trace.final).toBeUndefined()
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', satisfied: false, evidenceId: undefined })
  })

  it('a reviewer-confirmed event condition WITHOUT evidence: semantically resolved, but not yet satisfied — the exact Step 12 distinction (item 5)', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [],
    })
    expect(trace.final).toEqual({ value: { kind: 'event', event_type: 'customer_acceptance' }, authority: 'reviewer_policy', method: 'existing_normalized_state' })
    expect(trace.execution.readinessBlocking).toBe(false) // interpretation IS resolved
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', satisfied: false, evidenceId: undefined })
  })

  it('a reviewer-confirmed event condition WITH matching, active, trusted evidence: satisfied, evidenceId surfaced', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [evidence()],
    })
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', satisfied: true, evidenceId: 'ev-1' })
  })

  it('revoked evidence: satisfied stays false — revoked evidence must not satisfy execution', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [evidence({ status: 'revoked' })],
    })
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', satisfied: false, evidenceId: undefined })
  })

  it('wrong subject/fee: evidence for a different fee never satisfies this trace', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [evidence({ subjectId: 'fee-2' })],
    })
    expect(trace.operationalEvidence.satisfied).toBe(false)
  })

  it('a contract_derived event condition: same distinction, different authority', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'contract_signature' },
      provenance: 'contract_derived',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [],
    })
    expect(trace.final?.authority).toBe('contract_derived')
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(trace.operationalEvidence.required).toBe(true)
    expect(trace.operationalEvidence.eventType).toBe('contract_signature')
  })

  it('a confirmed fixed_date condition: semantically resolved AND no operational evidence required at all — fully executable', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'fixed_date', date: '2026-10-15' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(trace.operationalEvidence).toEqual({ required: false, eventType: undefined, satisfied: false, evidenceId: undefined })
  })

  it('a confirmed immediate condition: same as fixed_date — no operational evidence required', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'immediate' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.operationalEvidence.required).toBe(false)
  })

  it('a null condition (genuine silence): semantically blocking, and operational evidence is not the applicable question at all (nothing to require evidence for yet)', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: null,
      provenance: null,
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(trace.operationalEvidence.required).toBe(false)
  })

  it('one_time_fee.billability_condition has no Global/Organization Rulebook domain slice — same zero-new-wiring behavior already proven for one_time_fee.amount', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'delivery' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.organizationRulebook).toEqual({ considered: false, matchedRuleIds: [], status: 'not_applicable' })
    // Only the universal provenance-integrity invariant (matches every
    // provenanced field regardless of domain slice) fires — no
    // billability-condition-specific Rulebook rule exists, and none is
    // added by Step 12/13 (item 22: still 9 active rules).
    expect(trace.globalRulebook.matchedRuleIds).toEqual(['provenance.silence_cannot_become_contract_derived'])
    expect(trace.globalRulebook.findings[0].outcome).toBe('supports')
    expect(trace.traceMode).toBe('reconstructed_snapshot')
  })

  it('never carries raw clause/event free text — only the closed event_type enum value and an opaque evidence id', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      subjectId: 'fee-1', evidence: [evidence()],
    })
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toMatch(/deemed|clause|SEK|customer approves|reviewer@example\.com/i)
  })
})
