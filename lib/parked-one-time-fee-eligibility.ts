// Contract B pre-approval pass — event-gated parked one-time fee release
// (Part A), revised for the TOCTOU-race fix.
//
// The pure decision app/api/admin/invoice-scheduler/route.ts consults to
// DISCOVER whether a `parked`, event-gated one-time fee (e.g. Contract B's
// SEK 90,000 Integration Fee, billability_condition.kind = 'event') looks
// currently executable, and to resolve the contract-interpretation facts
// (fee identity, required event_type, canonical amount) needed to attempt
// an execution claim. Deliberately separate from — and reusing, never
// duplicating — lib/operational-event-evidence.ts's
// isOneTimeFeeHeldForExecution, which is Stage A's (billing-writer.ts's)
// own gate at push/configure time.
//
// IMPORTANT — this function is NO LONGER the final authorization to
// execute. A positive result here is a discovery/diagnostic signal only:
// time passes between this evaluation and the DB write that follows it, in
// which matching evidence could be revoked. The sole final authorization
// is the atomic `claim_parked_event_fee` SQL function (see the migration
// alongside this file) — it re-verifies row state and evidence itself,
// inside one transaction, immediately before the parked -> processing
// transition. Contract interpretation (fee_id resolution, billability_
// condition.kind, required event_type, canonical amount) stays here in
// application logic on purpose — the SQL function only validates current
// row/evidence STATE, it never re-derives contract meaning.
//
// No ambient Date.now() — asOf is an explicit required input, exactly like
// every other resolution function in this codebase's Rulebook/evidence
// layer.
import type { OneTimeFee, BillabilityEventType } from './types'
import { isOneTimeFeeHeldForExecution, type OperationalEventEvidence } from './operational-event-evidence'

export type ParkedOneTimeFeeEligibility =
  | { eligible: true; amount: number; feeId: string; eventType: BillabilityEventType }
  | {
      eligible: false
      // 'fee_not_found'      — candidateFeeId no longer resolves against the
      //                        job's CURRENT contract_terms.one_time_fees
      //                        (e.g. re-extraction changed/removed it).
      // 'not_event_gated'    — the fee this row points at is no longer (or
      //                        was never) billability_condition.kind ===
      //                        'event' — never auto-executed; a quantity x
      //                        rate manual fee stays exclusively human-
      //                        driven via POST /parked-invoices.
      // 'evidence_not_satisfied' — isOneTimeFeeHeldForExecution says held:
      //                        evidence absent, revoked, for a different
      //                        fee/event type, or future-dated relative to
      //                        asOf.
      reason: 'fee_not_found' | 'not_event_gated' | 'evidence_not_satisfied'
    }

export function evaluateParkedOneTimeFeeEligibility(params: {
  // planned_invoices.fee_id for the candidate row — the sole structural
  // link back to the contract's one_time_fees[], never fee_label matching.
  candidateFeeId: string | null | undefined
  oneTimeFees: OneTimeFee[]
  evidence: OperationalEventEvidence[]
  asOf: Date
}): ParkedOneTimeFeeEligibility {
  const fee = params.candidateFeeId
    ? params.oneTimeFees.find(f => f.fee_id === params.candidateFeeId)
    : undefined
  if (!fee) return { eligible: false, reason: 'fee_not_found' }

  if (!fee.billability_condition || fee.billability_condition.kind !== 'event') {
    return { eligible: false, reason: 'not_event_gated' }
  }

  if (isOneTimeFeeHeldForExecution(fee, params.evidence, params.asOf)) {
    return { eligible: false, reason: 'evidence_not_satisfied' }
  }

  // A3 — the canonical fixed amount, sourced fresh from contract state
  // right now. No reviewer input, no quantity x rate; this is never routed
  // through the manual parked-fee workflow. eventType is surfaced here
  // (rather than re-derived by the caller) so ALL contract-interpretation
  // logic — including "which event type this fee requires" — stays
  // centralized in this one function; the caller passes it straight
  // through to claim_parked_event_fee as an opaque, already-resolved fact.
  return { eligible: true, amount: fee.amount, feeId: fee.fee_id!, eventType: fee.billability_condition.event_type }
}
