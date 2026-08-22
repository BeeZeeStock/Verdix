// Verdix commercial rules — OperationalEventEvidence (Step 13).
//
// Answers a structurally different question from BillabilityCondition/
// billability_provenance (lib/types.ts, lib/billability-condition.ts):
//   - billability_condition + billability_provenance = "what does the
//     agreement say must happen, and do we trust that reading?" (contractual
//     INTERPRETATION — reviewer_policy/contract_derived FieldProvenance).
//   - OperationalEventEvidence = "did that real-world event actually
//     happen?" (operational FACT — a completely separate ontology, never
//     reusing FieldProvenance's authority values; see the module-level
//     OperationalEventEvidenceSource union below, which shares no member
//     with FieldProvenance on purpose).
// A resolved billability_condition + a satisfied OperationalEventEvidence
// are two independent, independently-auditable facts — confirming one
// never resolves or implies the other. See lib/commercial-rule-status.ts's
// computeCommercialRuleWorkload for where both are checked together to
// decide execution readiness, and lib/types.ts's OneTimeFee.billability_condition
// for the full architecture comment.
import type { BillabilityCondition, BillabilityEventType } from './types'
import { getBillabilityExecutionCapability } from './billability-condition'

// 'reviewer_attestation' — a human explicitly recorded that the event
// occurred. The ONLY source any Step 13 route can mint.
// 'trusted_system_event' — reserved for a FUTURE integration (e-signature,
// CRM, ERP — see the Step 13 report's future-integration matrix) to mint
// from verified external evidence. No writer exists for this in Step 13;
// it is closed-set here so the resolver and persistence layer are ready
// for it without a future schema/type change, not because anything can
// produce it today.
export type OperationalEventEvidenceSource = 'reviewer_attestation' | 'trusted_system_event'

const TRUSTED_EVIDENCE_SOURCES: ReadonlySet<OperationalEventEvidenceSource> = new Set([
  'reviewer_attestation', 'trusted_system_event',
])

export interface OperationalEventEvidence {
  id: string
  subjectId: string
  eventType: BillabilityEventType
  // ISO 8601 timestamp — when the real-world event happened, per the
  // attesting source. Distinct from recordedAt (item 6).
  occurredAt: string
  source: OperationalEventEvidenceSource
  // When Verdix learned about it — server-minted, never caller-supplied.
  recordedAt: string
  recordedBy: string
  status: 'active' | 'revoked'
}

export interface OperationalEventSatisfactionResult {
  // False whenever the condition doesn't require operational evidence at
  // all (immediate/fixed_date/null) — evidence is simply not the relevant
  // question for those; see execution readiness in commercial-rule-status.ts
  // for how those are judged executable without ever consulting this
  // resolver's `satisfied`.
  required: boolean
  satisfied: boolean
  evidence?: OperationalEventEvidence
}

// Item 5 — the ONE pure function deciding whether a billability condition's
// required real-world event is evidenced. No ambient Date.now() — asOf is
// an explicit, required input, exactly like every other Rulebook
// trace/resolution function in this codebase.
//
// Matching rules, all required simultaneously (item 5's adversarial list):
//   - evidence.subjectId === subjectId (a matching event for ANOTHER fee
//     never satisfies this one — items 18/19's exact concern).
//   - evidence.eventType === the condition's required event_type (delivery
//     evidence never satisfies customer_acceptance, or vice versa).
//   - evidence.status === 'active' (revoked evidence never satisfies).
//   - evidence.source is one of the closed, trusted set (defensive — never
//     trusts an unrecognized/forged source string even if one somehow
//     reached this function, e.g. via a bug upstream).
//   - evidence.occurredAt <= asOf (a future-dated occurrence can never
//     satisfy a currently-required event — item 6/23).
// When more than one matching candidate exists (should not happen once the
// database's one-active-per-subject+event constraint is respected, but
// this function stays defensive rather than assuming that), the most
// recent occurrence wins — deterministic, never an arbitrary array-order
// pick.
export function resolveOperationalEventEvidence(params: {
  condition: BillabilityCondition | null | undefined
  subjectId: string
  evidence: OperationalEventEvidence[]
  asOf: Date
}): OperationalEventSatisfactionResult {
  const capability = getBillabilityExecutionCapability(params.condition)
  if (capability.executable || capability.reason !== 'requires_operational_event') {
    return { required: false, satisfied: false }
  }
  const requiredEventType: BillabilityEventType = capability.event_type
  const asOfMs = params.asOf.getTime()

  const candidates = params.evidence.filter(e =>
    e.subjectId === params.subjectId &&
    e.eventType === requiredEventType &&
    e.status === 'active' &&
    TRUSTED_EVIDENCE_SOURCES.has(e.source) &&
    new Date(e.occurredAt).getTime() <= asOfMs,
  )
  if (candidates.length === 0) return { required: true, satisfied: false }

  const winner = candidates.reduce((latest, current) =>
    new Date(current.occurredAt).getTime() > new Date(latest.occurredAt).getTime() ? current : latest,
  )
  return { required: true, satisfied: true, evidence: winner }
}

// Item 11 — the ONE execution-projection decision shared by every billing
// connector (lib/billing-writer.ts's configureStripe/configureRememhill),
// so they can never diverge on it. Deliberately reads billability_condition
// + real evidence FRESH, every call — never a persisted manual_trigger
// value for an event-conditioned fee. Item 10 forbids mutating due_date/
// manual_trigger/billability_condition merely because the event occurred;
// this is the "pure execution projection using condition + event-
// satisfaction state" the step asks for instead — computed at the moment
// billing execution actually needs the answer, never written back to
// contract_terms.
//
// A genuine legacy/manual_trigger fee (billability_condition absent or not
// 'event') is completely unaffected — falls through to the exact Step 11
// manual_trigger check, byte for byte.
export function isOneTimeFeeHeldForExecution(
  fee: { manual_trigger?: boolean; billability_condition?: BillabilityCondition | null; fee_id?: string },
  evidence: OperationalEventEvidence[],
  asOf: Date,
): boolean {
  if (!fee.billability_condition || fee.billability_condition.kind !== 'event') {
    return !!fee.manual_trigger
  }
  const satisfaction = resolveOperationalEventEvidence({
    condition: fee.billability_condition,
    subjectId: fee.fee_id ?? '', // no fee_id -> can never match real evidence -> stays held, fails closed
    evidence,
    asOf,
  })
  return !satisfaction.satisfied
}
