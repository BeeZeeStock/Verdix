// Verdix commercial decision trace — OneTimeFee billability_condition
// (Step 12, item 20). Proves the thin adapter (lib/rulebook/decision-
// trace-one-time-fee.ts) composes the unmodified Step 8 generic composer
// correctly, and adds the ONE new distinction Step 12 needs: "is the
// contractual meaning understood" (execution.readinessBlocking, from the
// generic composer, unchanged) vs. "has the required event actually
// occurred" (operationalEvidence, new).
import { describe, it, expect } from 'vitest'
import { buildOneTimeFeeBillabilityTrace, ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD } from '@/lib/rulebook/decision-trace-one-time-fee'

const AS_OF = new Date('2026-08-22T12:00:00.000Z')

describe('buildOneTimeFeeBillabilityTrace — semantic resolution vs operational evidence (item 5/20)', () => {
  it('an unresolved condition (billability_provenance null): semantically blocking, no operational evidence question yet', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: null,
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.field).toBe(ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD)
    expect(trace.final).toBeUndefined()
    expect(trace.execution.readinessBlocking).toBe(true)
    // Operational evidence is still reported (the condition IS an event),
    // but the interesting/blocking layer here is semantic, not evidentiary.
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', present: false })
  })

  it('a reviewer-confirmed event condition: semantically resolved, but execution still requires operational evidence — the exact Step 12 distinction (item 5)', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.final).toEqual({ value: { kind: 'event', event_type: 'customer_acceptance' }, authority: 'reviewer_policy', method: 'existing_normalized_state' })
    expect(trace.execution.readinessBlocking).toBe(false) // interpretation IS resolved
    expect(trace.operationalEvidence).toEqual({ required: true, eventType: 'customer_acceptance', present: false }) // but evidence is not
  })

  it('a contract_derived event condition: same distinction, different authority', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'contract_signature' },
      provenance: 'contract_derived',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
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
    expect(trace.operationalEvidence).toEqual({ required: false, eventType: undefined, present: false })
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
    // added by Step 12 (item 22: still 9 active rules).
    expect(trace.globalRulebook.matchedRuleIds).toEqual(['provenance.silence_cannot_become_contract_derived'])
    expect(trace.globalRulebook.findings[0].outcome).toBe('supports')
    expect(trace.traceMode).toBe('reconstructed_snapshot')
  })

  it('never carries raw clause/event free text — only the closed event_type enum value', () => {
    const trace = buildOneTimeFeeBillabilityTrace({
      condition: { kind: 'event', event_type: 'customer_acceptance' },
      provenance: 'reviewer_policy',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toMatch(/deemed|clause|SEK|customer approves/i)
  })
})
