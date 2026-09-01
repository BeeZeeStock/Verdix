// Step 17H.2A item 20 — the pure, reusable Billing Timeline display
// adapter. This pass only routes PARKED obligations through it
// (recurring-period/one-time/commercial-rule entries stay on
// BillingSummaryCard.tsx's existing, unmigrated TLEntry construction —
// item 19 forbids merging Billing Periods/consumption data in this pass,
// and item 22 says change only what's strictly necessary). The next pass
// extends this same adapter to the rest of the timeline rather than
// inventing a second one. No persistence, no new DB table — pure
// normalization of already-fetched data into what the UI needs to render
// one row: a stable key, an entry kind, an ordering key (no true date
// exists for any parked entry today — item 12 forbids fabricating one, so
// this is always null here), a business label, an amount state, a
// lifecycle state, an icon/status key into the SAME StatusBadge/
// timelineIcon vocabulary BillingSummaryCard.tsx already owns (item 14 —
// never a second parallel status map), an expandable-detail source, and
// the entry's available actions.
import { EVIDENCE_RECORDED_LABELS, EVIDENCE_WAITING_LABELS } from './billability-event-labels'
import type { BillabilityEventType } from './types'

export type ParkedInvoiceSummary = {
  id: string
  // Stable Step-13 subject identity — see lib/types.ts's OneTimeFee.fee_id —
  // null for a genuinely manual/quantity-rate fee that never entered the
  // Step-12 event lifecycle.
  feeId: string | null
  feeLabel: string | null
  currency: string
  baseAmount: number
  metricName: string | null
  ratePerUnit: number | null
  description: string | null
  billabilityCondition:
    | { kind: 'immediate' }
    | { kind: 'fixed_date'; date: string }
    | { kind: 'event'; event_type: BillabilityEventType }
    | null
  evidence: { occurredAt: string; recordedAt: string } | null
  plannedInvoiceStatus: string
}

export type BillingTimelineEntryKind =
  | 'parked_conditional_obligation'
  | 'parked_reusable_template'
  | 'parked_unsupported'

export type BillingTimelineAmountState =
  | { kind: 'fixed'; amount: number; currency: string }
  | { kind: 'rate_per_unit'; ratePerUnit: number | null; currency: string; unitLabel: string }

export type BillingTimelineLifecycleState =
  | 'awaiting_condition'
  | 'condition_confirmed_awaiting_execution'
  | 'reusable_template'
  | 'unsupported'

export interface BillingTimelineEntry {
  displayKey: string
  kind: BillingTimelineEntryKind
  orderingDate: Date | null
  label: string
  description: string | null
  amount: BillingTimelineAmountState
  lifecycleState: BillingTimelineLifecycleState
  iconStatusKey: 'parked_awaiting_evidence' | 'parked_evidence_recorded' | 'parked_manual_template' | 'parked_unsupported'
  secondaryText: string
  detail:
    | { kind: 'event_gated'; eventType: BillabilityEventType; evidence: { occurredAt: string; recordedAt: string } | null }
    | { kind: 'manual_template'; metricName: string | null; ratePerUnit: number | null }
    | { kind: 'unsupported' }
  // No action is currently exposed from the timeline itself for a parked
  // entry — recording evidence and confirming a delivery both stay on
  // ParkedInvoicesCard (item 7's "duplicate visibility, not duplicate
  // control"). Present as a real (empty) field so a future pass can add
  // actions here without a shape change.
  actions: []
}

// Same structural discriminators ParkedInvoicesCard.tsx uses today (never
// inferred from label/description text): a fee with billabilityCondition
// null and a real metricName is the known manual quantity/rate template
// shape; a billabilityCondition of kind 'event' is the event-gated shape;
// anything else fails closed as unsupported. Kept as the ONE place this
// classification is expressed for the timeline adapter — ParkedInvoicesCard
// itself keeps its own copy for now (explicitly not migrated in this pass),
// but a future pass can route it through this same function instead of
// maintaining two independently-written classifiers.
export function buildParkedTimelineEntry(pi: ParkedInvoiceSummary): BillingTimelineEntry {
  if (pi.billabilityCondition?.kind === 'event') {
    const eventType = pi.billabilityCondition.event_type
    // item 9/10 — the one authoritative signal distinguishing "condition
    // not yet met" from "condition met, not yet billed": whether the
    // server-side resolveOperationalEventEvidence call found real, active,
    // matching evidence for this fee. Never inferred from status text or
    // dates.
    const evidenceRecorded = pi.evidence != null
    return {
      displayKey: pi.id,
      kind: 'parked_conditional_obligation',
      orderingDate: null,
      label: pi.feeLabel ?? 'One-time fee',
      description: pi.description,
      amount: { kind: 'fixed', amount: pi.baseAmount, currency: pi.currency },
      lifecycleState: evidenceRecorded ? 'condition_confirmed_awaiting_execution' : 'awaiting_condition',
      iconStatusKey: evidenceRecorded ? 'parked_evidence_recorded' : 'parked_awaiting_evidence',
      secondaryText: evidenceRecorded
        ? `${EVIDENCE_RECORDED_LABELS[eventType]} · awaiting billing execution`
        : EVIDENCE_WAITING_LABELS[eventType],
      detail: { kind: 'event_gated', eventType, evidence: pi.evidence },
      actions: [],
    }
  }
  if (pi.billabilityCondition == null && pi.metricName != null) {
    // item 6 — a reusable manual quantity/rate template, never presented
    // as an already-due invoice: no date, no "awaiting X" condition
    // language, just what it structurally is.
    return {
      displayKey: pi.id,
      kind: 'parked_reusable_template',
      orderingDate: null,
      label: pi.feeLabel ?? 'Service fee',
      description: pi.description,
      amount: { kind: 'rate_per_unit', ratePerUnit: pi.ratePerUnit, currency: pi.currency, unitLabel: pi.metricName },
      lifecycleState: 'reusable_template',
      iconStatusKey: 'parked_manual_template',
      secondaryText: 'Reusable delivery template — confirm each delivery to invoice',
      detail: { kind: 'manual_template', metricName: pi.metricName, ratePerUnit: pi.ratePerUnit },
      actions: [],
    }
  }
  return {
    displayKey: pi.id,
    kind: 'parked_unsupported',
    orderingDate: null,
    label: pi.feeLabel ?? 'Parked fee',
    description: pi.description,
    amount: { kind: 'fixed', amount: pi.baseAmount, currency: pi.currency },
    lifecycleState: 'unsupported',
    iconStatusKey: 'parked_unsupported',
    secondaryText: 'Unrecognized billing configuration',
    detail: { kind: 'unsupported' },
    actions: [],
  }
}
