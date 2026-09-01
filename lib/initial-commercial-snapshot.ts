// Step 17H.4B0D4H1B4E3.1 — Initial Commercial Snapshot Bootstrap.
//
// Fixes Finding #1 from the E3 fresh-extraction acceptance pass: execute's
// re-execution pipeline unconditionally ran the Model B+ reconciliation
// orchestration (lib/current-line-item-reconciliation-orchestration.ts)
// even on a job's very first extraction, when current_line_items is
// genuinely empty. The planner's weak-identity-family doctrine (recurring_
// base_fee, escalator, additional_recurring_fixed, additional_recurring_
// variable — lib/current-line-item-reconciliation-plan.ts) treats ANY
// one-sided residual, including "every fresh item, because nothing existed
// yet," as unknown_identity — which computeReconciliationHoldTransition
// always turns into billing_hold: reconciliation_blocked, a hold with NO
// resolving action anywhere in the product.
//
// This module is the separate INITIALIZATION path: it decides whether a
// job has ever had an authoritative commercial snapshot established at
// all, and if not, writes the very first one through a dedicated,
// minimal, atomic RPC (establish_initial_commercial_snapshot, migration
// 20260915000001) rather than the reconciliation planner — there is
// nothing to reconcile against on a genuine first snapshot, so the
// planner's residual/family logic simply does not apply. It does NOT
// replace lib/current-line-item-reconciliation-plan.ts or lib/current-
// line-item-reconciliation-orchestration.ts, which remain the frozen,
// unchanged path for every job that already has a snapshot (§16).
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FreshLineItemLike } from './current-line-item-reconciliation-plan'

// ─────────────────────────────────────────────────────────────────────────
// Eligibility — pure decision logic (§4/§5), separated from the I/O that
// gathers the evidence it decides over so the decision itself is directly
// unit-testable without a database.
//
// markerInitializedAt is the SOLE positive signal ("has this job's initial
// snapshot ever been durably established") — never current_line_items
// emptiness alone (§3: ambiguous between genuine first extraction, a
// crashed earlier init, all-current-rows-since-superseded, or corrupt
// legacy data). Every other field here is a NEGATIVE, fail-closed check:
// if the marker is NULL but ANY of them indicates a prior operational
// lifecycle, initialization is refused — a legitimately first-extraction
// job has none of this evidence, so the checks impose no real cost on the
// common case, and a job that somehow reached an operational state without
// the marker ever being set (e.g. every AUTO_CONFIGURE job that pre-dates
// this migration — see §18's backfill audit) is correctly never
// re-baselined as "new."
export interface InitializationEvidence {
  markerInitializedAt: string | null
  anyLineItemExists: boolean
  anyPlannedInvoiceExists: boolean
  billingCustomerId: string | null
  billingPlatform: string | null
}

export type InitializationEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'already_initialized'; initializedAt: string }
  | { eligible: false; reason: 'ambiguous_legacy_evidence'; evidenceReasons: string[] }

export function evaluateInitializationEligibility(evidence: InitializationEvidence): InitializationEligibility {
  if (evidence.markerInitializedAt) {
    return { eligible: false, reason: 'already_initialized', initializedAt: evidence.markerInitializedAt }
  }
  const evidenceReasons: string[] = []
  if (evidence.anyLineItemExists) evidenceReasons.push('existing_line_items')
  if (evidence.anyPlannedInvoiceExists) evidenceReasons.push('existing_planned_invoices')
  if (evidence.billingCustomerId) evidenceReasons.push('existing_billing_customer_id')
  if (evidence.billingPlatform) evidenceReasons.push('existing_billing_platform')
  if (evidenceReasons.length > 0) {
    return { eligible: false, reason: 'ambiguous_legacy_evidence', evidenceReasons }
  }
  return { eligible: true }
}

export async function gatherInitializationEvidence(supabase: SupabaseClient, jobId: string): Promise<InitializationEvidence> {
  const [{ data: jobRow, error: jobError }, { data: lineItemRow, error: lineItemError }, { data: invoiceRow, error: invoiceError }] = await Promise.all([
    supabase.from('jobs').select('commercial_snapshot_initialized_at, billing_customer_id, billing_platform').eq('id', jobId).single(),
    supabase.from('line_items').select('id').eq('job_id', jobId).limit(1).maybeSingle(),
    supabase.from('planned_invoices').select('id').eq('job_id', jobId).limit(1).maybeSingle(),
  ])
  if (jobError) throw new Error(`Failed to read job for initialization eligibility: ${jobError.message}`)
  if (lineItemError) throw new Error(`Failed to read line_items for initialization eligibility: ${lineItemError.message}`)
  if (invoiceError) throw new Error(`Failed to read planned_invoices for initialization eligibility: ${invoiceError.message}`)
  return {
    markerInitializedAt: jobRow?.commercial_snapshot_initialized_at ?? null,
    anyLineItemExists: !!lineItemRow,
    anyPlannedInvoiceExists: !!invoiceRow,
    billingCustomerId: jobRow?.billing_customer_id ?? null,
    billingPlatform: jobRow?.billing_platform ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The write path. Deliberately mirrors the shape of
// ReconciliationOrchestrationResult (lib/current-line-item-reconciliation-
// orchestration.ts) for its 'invalid_plan'/'error' cases so a caller can
// feed either result into the SAME downstream billing_hold/execute_status
// logic without a translation layer — but 'initialized' and
// 'not_initialization_eligible' have no equivalent there; the caller
// (execute/route.ts) is expected to branch on those explicitly: a caller
// that receives 'not_initialization_eligible' or lost a concurrent init
// race must fall through to the normal reconcileCurrentLineItemsForJob
// path, never treat either as an error.
export type InitialCommercialSnapshotResult =
  | { status: 'initialized'; insertedCount: number; initializedAt: string }
  | { status: 'not_initialization_eligible'; reason: 'already_initialized' | 'ambiguous_legacy_evidence'; evidenceReasons?: string[] }
  | { status: 'invalid_plan'; reason: string }
  | { status: 'error'; message: string }

interface RawEstablishRpcResult {
  status: 'applied' | 'already_initialized' | 'not_eligible' | 'invalid_plan'
  reason?: string
  inserted_count?: number
  initialized_at?: string
}

// The one entry point execute/route.ts calls for a job whose eligibility
// has not yet been decided this request. Re-checks eligibility itself
// (rather than trusting a caller-supplied boolean) immediately before the
// RPC call — cheap, and closes the gap between "the route decided to
// attempt initialization" and "the RPC actually runs," which the RPC's own
// under-lock re-check (§11/§12) then closes completely for the genuine
// concurrency case. This function's own evidence read is a fast-path
// short-circuit (avoids constructing/sending an insert payload for a job
// that's obviously already past initialization), not the sole safety
// mechanism.
export async function establishInitialCommercialSnapshot<F extends FreshLineItemLike>(params: {
  supabase: SupabaseClient
  jobId: string
  freshItems: F[]
}): Promise<InitialCommercialSnapshotResult> {
  const { supabase, jobId, freshItems } = params

  const evidence = await gatherInitializationEvidence(supabase, jobId)
  const eligibility = evaluateInitializationEligibility(evidence)
  if (!eligibility.eligible) {
    if (eligibility.reason === 'already_initialized') {
      return { status: 'not_initialization_eligible', reason: 'already_initialized' }
    }
    return { status: 'not_initialization_eligible', reason: 'ambiguous_legacy_evidence', evidenceReasons: eligibility.evidenceReasons }
  }

  const { data, error } = await supabase.rpc('establish_initial_commercial_snapshot', {
    p_job_id: jobId,
    p_inserts: freshItems,
  })
  if (error) return { status: 'error', message: error.message }

  const raw = data as RawEstablishRpcResult
  if (raw.status === 'applied') {
    return { status: 'initialized', insertedCount: raw.inserted_count ?? 0, initializedAt: raw.initialized_at ?? new Date().toISOString() }
  }
  if (raw.status === 'already_initialized') {
    // Lost a concurrent race between this function's own evidence read and
    // the RPC's under-lock check — a real, expected outcome under genuine
    // concurrency (§13), not an error. The caller must fall through to
    // normal reconciliation against the winner's now-established snapshot.
    return { status: 'not_initialization_eligible', reason: 'already_initialized' }
  }
  if (raw.status === 'not_eligible') {
    return { status: 'not_initialization_eligible', reason: 'ambiguous_legacy_evidence', evidenceReasons: [raw.reason ?? 'existing_line_items_present'] }
  }
  return { status: 'invalid_plan', reason: raw.reason ?? 'unknown' }
}
