// Verdix commercial decision trace — OneTimeFee billability_condition entry
// point (Step 12, item 20; extended Step 13, item 20). A thin adapter on
// top of lib/rulebook/decision-trace.ts's generic composer, same pattern as
// decision-trace-service-credit.ts — this file adds NO new resolution
// logic of its own; the actual evidence-matching logic is
// lib/operational-event-evidence.ts's resolveOperationalEventEvidence,
// reused here unmodified.
//
// one_time_fee.billability_condition has no Global/Organization Rulebook
// domain slice (domainContext: {}, organizationMatchContext: {}) — the
// existing one_time_fee.amount live-verification test already proved the
// generic composer handles a domainContext-less field correctly with zero
// code changes; this adapter reuses exactly that shape.
//
// The one thing this adapter adds beyond the generic composer: Step 12's
// second distinction (item 5/20) — "is the contractual meaning understood"
// (the generic composer's own execution.readinessBlocking, unmodified) is
// NOT the same question as "has the required real-world event actually
// happened" (operationalEvidence below, Step 13's
// resolveOperationalEventEvidence). Never puts raw reviewer notes, source
// clauses, or event free text into the trace — only the closed event_type
// enum, a boolean, and an evidence id (an opaque reference, not content).
import type { BillabilityCondition, BillabilityEventType, FieldProvenance } from '@/lib/types'
import { getBillabilityExecutionCapability } from '@/lib/billability-condition'
import { resolveOperationalEventEvidence, type OperationalEventEvidence } from '@/lib/operational-event-evidence'
import { buildCommercialDecisionTrace, type CommercialDecisionTrace } from './decision-trace'
import type { OrganizationRuleRecord } from './organization-rules'

export const ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD = 'one_time_fee.billability_condition'

export interface OneTimeFeeBillabilityTrace extends CommercialDecisionTrace {
  operationalEvidence: {
    // True only for an 'event' condition — 'immediate'/'fixed_date' never
    // require operational evidence (lib/billability-condition.ts's
    // getBillabilityExecutionCapability), and a null/unresolved condition
    // has no event to require evidence FOR yet (that's a semantic
    // readiness gap, already reflected in execution.readinessBlocking).
    required: boolean
    eventType?: BillabilityEventType
    // True only when a real, active, matching, non-future-dated,
    // trusted-source evidence record was found (Step 13) — revoked
    // evidence, wrong event/subject, or a future occurrence all leave this
    // false, exactly like the execution-readiness gate itself
    // (lib/commercial-rule-status.ts's computeCommercialRuleWorkload).
    satisfied: boolean
    // Opaque reference only — never the evidence's own content beyond the
    // closed event_type already exposed above.
    evidenceId?: string
  }
}

export interface OneTimeFeeBillabilityTraceInput {
  condition: BillabilityCondition | null | undefined
  provenance: FieldProvenance | null | undefined
  organizationId: string
  organizationRules: OrganizationRuleRecord[]
  asOf: Date
  // Step 13 — the subject identity (OneTimeFee.fee_id) and the job's real
  // evidence rows. Both optional so a caller tracing a field that predates
  // fee_id (or hasn't loaded evidence) still gets a well-formed trace —
  // satisfied simply stays false, exactly as "no evidence" would.
  subjectId?: string
  evidence?: OperationalEventEvidence[]
}

export function buildOneTimeFeeBillabilityTrace(input: OneTimeFeeBillabilityTraceInput): OneTimeFeeBillabilityTrace {
  const base = buildCommercialDecisionTrace({
    field: ONE_TIME_FEE_BILLABILITY_CONDITION_FIELD,
    currentValue: input.condition ?? null,
    currentProvenance: input.provenance,
    domainContext: {},
    organizationId: input.organizationId,
    organizationRules: input.organizationRules,
    organizationMatchContext: {},
    asOf: input.asOf,
  })

  const capability = getBillabilityExecutionCapability(input.condition)
  const requiresEvent = !capability.executable && capability.reason === 'requires_operational_event'

  const satisfaction = resolveOperationalEventEvidence({
    condition: input.condition,
    subjectId: input.subjectId ?? '',
    evidence: input.evidence ?? [],
    asOf: input.asOf,
  })

  return {
    ...base,
    operationalEvidence: {
      required: requiresEvent,
      eventType: requiresEvent ? capability.event_type : undefined,
      satisfied: satisfaction.satisfied,
      evidenceId: satisfaction.evidence?.id,
    },
  }
}
