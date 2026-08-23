// Verdix commercial rules — BillabilityCondition (Step 12).
//
// The smallest reusable semantic primitive for "what does the agreement say
// must happen before this fee becomes billable?" — see lib/types.ts's
// BillabilityCondition/BillabilityEventType for the full domain-model
// rationale. This module holds the three pure functions that operate on
// that type: a strict validator (never trust raw AI/client JSON blindly),
// an execution-capability classifier, and the one deterministic projection
// onto the legacy due_date/manual_trigger execution fields.
//
// Deliberately does NOT build event-ingestion, milestone scheduling, or any
// operational-evidence lookup — see getBillabilityExecutionCapability's own
// comment for exactly where that boundary sits.
import type { BillabilityCondition, BillabilityEventType } from './types'

const BILLABILITY_EVENT_TYPES: ReadonlySet<BillabilityEventType> = new Set([
  'contract_signature', 'delivery', 'customer_acceptance', 'final_acceptance', 'change_order_signature',
])

// ISO 8601 calendar date, YYYY-MM-DD — same shape every other date field in
// this codebase uses (due_date, contract_start_date, ...), never a
// timestamp.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Strict, structural validation of a raw value claiming to be a
// BillabilityCondition — the closed-union enforcement point (item 2: "do
// not add a generic free-text executable event"). Used for BOTH raw AI
// extraction output (a model can emit anything as JSON) and any future
// client-supplied value, so a malformed/hallucinated kind, an event_type
// outside the closed five, or a non-ISO date can never enter the domain
// model — returns null for anything that doesn't match exactly, the same
// "fail toward null/unresolved, never guess" discipline every other
// extraction safety net in this codebase uses.
export function parseBillabilityCondition(raw: unknown): BillabilityCondition | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (obj.kind === 'immediate') return { kind: 'immediate' }
  if (obj.kind === 'fixed_date') {
    return typeof obj.date === 'string' && ISO_DATE_RE.test(obj.date) ? { kind: 'fixed_date', date: obj.date } : null
  }
  if (obj.kind === 'event') {
    return typeof obj.event_type === 'string' && BILLABILITY_EVENT_TYPES.has(obj.event_type as BillabilityEventType)
      ? { kind: 'event', event_type: obj.event_type as BillabilityEventType }
      : null
  }
  return null
}

export type BillabilityExecutionCapability =
  | { executable: true }
  | { executable: false; reason: 'condition_unresolved' }
  | { executable: false; reason: 'requires_operational_event'; event_type: BillabilityEventType }

// Item 7 — ONE pure function deciding whether the CURRENT execution model
// can act on a given condition, rather than scattering kind === 'event'
// checks across billing-writer/commercial-rule-status/the UI. Does not
// consult any real-world evidence source (item 26 — no event-ingestion
// system exists yet) — 'event' is always execution-incapable today,
// structurally, regardless of how confident the semantic resolution is.
export function getBillabilityExecutionCapability(
  condition: BillabilityCondition | null | undefined,
): BillabilityExecutionCapability {
  if (!condition) return { executable: false, reason: 'condition_unresolved' }
  switch (condition.kind) {
    case 'immediate':
    case 'fixed_date':
      return { executable: true }
    case 'event':
      return { executable: false, reason: 'requires_operational_event', event_type: condition.event_type }
  }
}

export interface BillabilityExecutionProjection {
  due_date: string | null
  manual_trigger: boolean
}

// Item 15 — the ONE deterministic mapping from BillabilityCondition onto
// the legacy execution fields lib/billing-writer.ts already reads. Applied
// once, wherever a condition becomes known (extraction normalization —
// lib/contract-extractor.ts's normalizeBillabilityCondition), never
// re-derived ad hoc elsewhere — so due_date/manual_trigger can never
// silently disagree with billability_condition.
//
//   'immediate'  -> due_date: null, manual_trigger: false — the existing
//                   "bill now" representation billing-writer.ts's isDue
//                   check already implements (feeDueDate null -> due now).
//   'fixed_date' -> due_date: condition.date, manual_trigger: false — the
//                   existing scheduled-billing representation.
//   'event'      -> due_date: null, manual_trigger: true — billing-writer.ts
//                   never auto-invoices a manual_trigger fee (it always
//                   parks it, requiring a separate human action via
//                   POST /parked-invoices); this is what makes "automatic
//                   invoice must not execute" (item 7) hold for event
//                   conditions using ONLY the existing execution model, with
//                   no billing-writer changes. Safety for this shape is
//                   NOT this projection alone — it is the combination of
//                   this projection AND lib/commercial-rule-status.ts's
//                   RequiredOperationalEventMissingBlocker, which keeps the
//                   whole job's Approve blocked (so billing_customer_id is
//                   never set, so /parked-invoices can never be reached
//                   either) until a future step adds real evidence
//                   ingestion.
export function projectBillabilityConditionToExecutionFields(
  condition: BillabilityCondition,
): BillabilityExecutionProjection {
  switch (condition.kind) {
    case 'immediate': return { due_date: null, manual_trigger: false }
    case 'fixed_date': return { due_date: condition.date, manual_trigger: false }
    case 'event': return { due_date: null, manual_trigger: true }
  }
}

// Acceptance-test fix round — the ONE canonical, human-readable
// description of a BillabilityCondition, used by BOTH the one-time-fee
// review card and the Products & Services overview table (previously two
// independent copies — a page-local one only the review card used, and a
// generic fee-type guess ("Services"/"Hardware"/"On delivery") in the
// overview table that could contradict it). Never raw JSON, never the
// internal event_type string as-is.
const BILLABILITY_EVENT_LABELS: Record<BillabilityEventType, string> = {
  contract_signature: 'Contract signature',
  delivery: 'Delivery',
  customer_acceptance: 'Customer acceptance',
  final_acceptance: 'Final acceptance',
  change_order_signature: 'Signed change order',
}
export function describeBillabilityCondition(condition: BillabilityCondition | null | undefined): string | null {
  if (!condition) return null
  if (condition.kind === 'immediate') return 'Immediate'
  if (condition.kind === 'fixed_date') return `Fixed date — ${condition.date}`
  return BILLABILITY_EVENT_LABELS[condition.event_type] ?? condition.event_type
}

// Acceptance-test fix round, item 3 — the operational definition of
// "conditional" for one-time-fee AGGREGATION purposes (contract-brief
// summary totals, Pricing-overview cards): a fee gated on a Change Order
// is inherently optional — the Change Order may never be executed —
// unlike every other billability event (contract_signature/delivery/
// customer_acceptance/final_acceptance), all of which are events within
// the CURRENT agreement's own guaranteed lifecycle (the fee is definitely
// going to be billed; only the timing is pending). This is the one
// existing, structurally-modeled signal that matches "may never become
// billable" — deliberately not a new schema field, and deliberately not
// the unrelated fee-label/type heuristic (classifyFee in the Configure
// page) some UI elsewhere uses for a different purpose (grouping by kind
// of fee, not by certainty of billing).
export function isChangeOrderConditional(condition: BillabilityCondition | null | undefined): boolean {
  return condition?.kind === 'event' && condition.event_type === 'change_order_signature'
}
