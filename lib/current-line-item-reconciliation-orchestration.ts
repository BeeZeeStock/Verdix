// Step 17H.4B0D4H1B3 — the shared Model B+ orchestration used by every
// production caller that generates or repairs a job's current commercial
// line-item configuration (execute's re-execution pipeline, reconcile-
// line-items, confirm-rule's base_fee_proration reconciliation). Reads the
// current population, plans, applies, and — on a stale plan — performs
// exactly ONE bounded retry (re-read, re-plan, re-apply; never a second
// LLM call, never a contract_terms rewrite). Deliberately does NOT own
// jobs.billing_hold or execute_status — those are caller-owned workflow
// concerns (lib/reconciliation-hold-transition.ts is the separate, shared
// policy for the hold side). This keeps the same function reusable by
// three callers with genuinely different broader workflows around it.
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  planCurrentLineItemReconciliation,
  type CurrentLineItemRow, type FreshLineItemLike, type ReconciliationTermsContext,
  type ReconciliationBlocker,
} from './current-line-item-reconciliation-plan'
import { applyCurrentLineItemReconciliationPlan } from './current-line-item-reconciliation-applier'

export type ReconciliationOrchestrationResult =
  | { status: 'applied'; updatedCount: number; insertedCount: number; supersededCount: number; blockers: ReconciliationBlocker[]; retried: boolean }
  | { status: 'stale_plan'; staleReason: 'current_set_changed' | 'current_row_changed'; blockers: ReconciliationBlocker[]; retried: boolean }
  | { status: 'invalid_plan'; invalidReason: string; blockers: ReconciliationBlocker[]; retried: boolean }
  | { status: 'error'; errorMessage: string; blockers: ReconciliationBlocker[]; retried: boolean }

async function readCurrentLineItems(supabase: SupabaseClient, jobId: string): Promise<CurrentLineItemRow[]> {
  const { data, error } = await supabase
    .from('current_line_items')
    // Step 17H.4B0D4H1B4E3.5 — recurring_fee_id added. Its omission was a
    // real, live-reproduced bug: without it, every current row's
    // recurring_fee_id read back as `undefined` (the property simply
    // absent, not the database's real `null`), which silently broke
    // computeIdentityPromotionOnly's `current.recurring_fee_id === null`
    // strict check (undefined !== null) — a legacy row could never be
    // promoted, and classifyLineItemFamily's decisive recurring_fee_id
    // check could never fire for an already-ID-bearing row either,
    // falling through to the label-based fallback and misclassifying as
    // 'unknown' the moment that label drifted even slightly.
    .select('id, product_name, quantity, unit_price, billing_period, total_amount, confidence_score, currency, stripe_price_id, applied_rule, correction_reason, source_section, reviewer_corrected_fields, reviewer_corrected_fields_complete, reviewer_corrected_at, fee_id, tier_id, recurring_fee_id')
    .eq('job_id', jobId)
  if (error) throw new Error(`Failed to read current_line_items for job ${jobId}: ${error.message}`)
  return (data ?? []) as CurrentLineItemRow[]
}

async function planAndApplyOnce<F extends FreshLineItemLike>(
  supabase: SupabaseClient, jobId: string, freshItems: F[], terms: ReconciliationTermsContext,
): Promise<{ plan: ReturnType<typeof planCurrentLineItemReconciliation<F>>; applyResult: Awaited<ReturnType<typeof applyCurrentLineItemReconciliationPlan<F>>> }> {
  const currentItems = await readCurrentLineItems(supabase, jobId)
  const plan = planCurrentLineItemReconciliation({ currentItems, freshItems, terms })
  const applyResult = await applyCurrentLineItemReconciliationPlan(supabase, jobId, plan)
  return { plan, applyResult }
}

// The one production entry point. Never re-runs extraction, never
// re-derives `freshItems`/`terms` — the caller supplies the exact fresh
// commercial truth (already persisted to contract_terms by the time this
// is called) once, and this function only ever re-reads the CURRENT side
// on retry.
export async function reconcileCurrentLineItemsForJob<F extends FreshLineItemLike>(params: {
  supabase: SupabaseClient
  jobId: string
  freshItems: F[]
  terms: ReconciliationTermsContext
}): Promise<ReconciliationOrchestrationResult> {
  const { supabase, jobId, freshItems, terms } = params

  const first = await planAndApplyOnce(supabase, jobId, freshItems, terms)
  if (first.applyResult.status === 'error') {
    return { status: 'error', errorMessage: first.applyResult.message, blockers: first.plan.blockers, retried: false }
  }
  if (first.applyResult.status === 'invalid_plan') {
    return { status: 'invalid_plan', invalidReason: first.applyResult.reason, blockers: first.plan.blockers, retried: false }
  }
  if (first.applyResult.status === 'applied') {
    return {
      status: 'applied', blockers: first.plan.blockers, retried: false,
      updatedCount: first.applyResult.updatedCount, insertedCount: first.applyResult.insertedCount, supersededCount: first.applyResult.supersededCount,
    }
  }

  // stale_plan — exactly one bounded retry: re-read current rows fresh,
  // re-plan against the SAME freshItems/terms, re-apply. No re-extraction,
  // no new LLM call, no contract_terms rewrite — the fresh commercial
  // truth this reconciliation is converging toward never changes mid-retry.
  const second = await planAndApplyOnce(supabase, jobId, freshItems, terms)
  if (second.applyResult.status === 'error') {
    return { status: 'error', errorMessage: second.applyResult.message, blockers: second.plan.blockers, retried: true }
  }
  if (second.applyResult.status === 'invalid_plan') {
    return { status: 'invalid_plan', invalidReason: second.applyResult.reason, blockers: second.plan.blockers, retried: true }
  }
  if (second.applyResult.status === 'applied') {
    return {
      status: 'applied', blockers: second.plan.blockers, retried: true,
      updatedCount: second.applyResult.updatedCount, insertedCount: second.applyResult.insertedCount, supersededCount: second.applyResult.supersededCount,
    }
  }
  // Second attempt is ALSO stale_plan — stop, do not retry again.
  return { status: 'stale_plan', staleReason: second.applyResult.reason, blockers: second.plan.blockers, retried: true }
}
