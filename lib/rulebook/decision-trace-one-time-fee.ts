// Verdix commercial decision trace — OneTimeFee billability_condition entry
// point (Step 12, item 20). A thin adapter on top of lib/rulebook/
// decision-trace.ts's generic composer, same pattern as decision-trace-
// service-credit.ts — this file adds NO new resolution logic of its own.
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
// happened" (operationalEvidence below, computed from
// lib/billability-condition.ts's getBillabilityExecutionCapability, which
// this module also does not modify). Never persists anything, never calls
// an evidence source — item 26, no event-ingestion system exists yet.
import type { BillabilityCondition, BillabilityEventType, FieldProvenance } from '@/lib/types'
import { getBillabilityExecutionCapability } from '@/lib/billability-condition'
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
    // Always false in Step 12 — no evidence-ingestion layer exists (item
    // 26). Kept as an explicit field, not merely the absence of one, so a
    // future evidence-ingestion step has a real slot to flip rather than
    // reshaping this trace.
    present: boolean
  }
}

export interface OneTimeFeeBillabilityTraceInput {
  condition: BillabilityCondition | null | undefined
  provenance: FieldProvenance | null | undefined
  organizationId: string
  organizationRules: OrganizationRuleRecord[]
  asOf: Date
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

  return {
    ...base,
    operationalEvidence: {
      required: requiresEvent,
      eventType: requiresEvent ? capability.event_type : undefined,
      present: false,
    },
  }
}
