// Step 17E.1, items C/D (re-scoped in 17E.2) — self-heals STORED
// line_items rows that have gone stale relative to the contract's own
// CURRENT typed state, for a job that was extracted/executed before a fix
// existed (or before a reviewer's confirmation was ever propagated back
// into buildLineItems' stored output). Two distinct staleness shapes,
// both fixed the same way (typed terms as sole authority, never label-
// inference on the STORED row itself — only used to locate which stored
// row a typed fact concerns):
//
//   1. Recurring-base-fee family — lib/line-items.ts emits a placeholder
//      row ("...partial-period treatment unresolved", Qty/Total 0) while
//      base_fee_proration.requires_confirmation is true. Once resolved
//      (Step 17E, item 4's confirm-rule fix), the row must be replaced
//      with the real computed schedule — this module is what makes that
//      correction happen for a contract that was ALREADY confirmed before
//      that fix existed, not just for one confirmed going forward.
//
//   2. percentage_of_basis fee rows — Step 17E, item 3 made
//      buildLineItems() skip these going forward; a job's STORED
//      line_items from before that fix can still carry the old "€0 /
//      Usage-based" row. Identified by matching the stored row's
//      product_name against a CURRENT additional_recurring_fees entry
//      that has percentage_of_basis compiled — the typed config is the
//      authority, the label match only locates which stored row it
//      concerns (never the reverse).
//
// Deliberately narrow: every OTHER stored line_items row (overage tiers,
// one-time fees, a reviewer's own manual per-row correction via
// saveLineItemField) is left completely untouched — this never does a
// blanket regenerate-and-replace-everything pass.
//
// Step 17E.2, item 3 — identity audit: matching against the stored row's
// product_name (a label) is NOT a choice here, it's the only mechanism
// available. Audited both sides: `line_items` (supabase/migrations/
// 20260626000000_verdix.sql) has no component-kind/source-fee-reference
// column at all — id/job_id/product_name/quantity/unit_price/
// billing_period/total_amount/currency/confidence_score/stripe_price_id/
// applied_rule/correction_reason/created_at, nothing that ties a row back
// to which typed fee/mechanism produced it. On the OTHER side,
// AdditionalRecurringFee (lib/types.ts) — home of percentage_of_basis —
// has no stable id either, unlike its sibling shapes (Discount.
// discount_rule_id, ServiceCredit.credit_rule_id, OneTimeFee.fee_id all
// exist; AdditionalRecurringFee has none). base_fee_proration is a
// job-level singleton (exactly one recurring base fee schedule per
// contract), so there is nothing to disambiguate there even in principle.
// No schema change made solely for this, per the task's own instruction —
// reported as a real, current gap instead: a future step wanting
// non-label identity for AdditionalRecurringFee-family rows would need a
// genuinely new fee_id-style column, mirroring the existing sibling
// pattern.
//
// Step 17E.2, item 1 — this module's PURE planLineItemReconciliation is
// the only thing app/api/jobs/[id]/route.ts's GET handler calls now (to
// shape its own in-memory response view); the DB-touching
// reconcileStaleLineItemsForJob below is called ONLY from explicit write
// paths — confirm-rule (right after a reviewer's own confirmation) and
// POST /api/jobs/[id]/reconcile-line-items (the explicit legacy-backfill
// command). GET must never call the DB-touching wrapper.
import { buildLineItems, isRecurringBaseFeeLineItem } from './line-items'
import { supabaseServer } from './supabase'
import type { ContractTerms } from './types'

type BuiltLineItem = ReturnType<typeof buildLineItems>[number]

export interface StoredLineItemRef {
  id: string
  product_name: string
}

export interface LineItemReconciliationPlan {
  staleIds: string[]
  freshItems: BuiltLineItem[]
}

// The DB-touching wrapper's own return shape — freshItems here carry the
// REAL id/job_id Postgres actually assigned on insert (never a locally-
// fabricated placeholder id), so a caller building an immediate response
// from this result never hands the client an id `saveLineItemField`-style
// edits would fail to find.
export interface LineItemReconciliationResult {
  staleIds: string[]
  freshItems: Array<BuiltLineItem & { id: string; job_id: string }>
}

export function planLineItemReconciliation(params: {
  existingItems: StoredLineItemRef[]
  terms: ContractTerms
  currency: string
}): LineItemReconciliationPlan {
  const { existingItems, terms, currency } = params
  const staleIds = new Set<string>()
  let freshItems: BuiltLineItem[] = []

  // (1) Recurring-base-fee family — only a genuine staleness, never a
  // blanket "always regenerate": the placeholder's own distinctive
  // product_name must actually be present, AND the underlying policy must
  // actually be resolved now. A contract that's still genuinely
  // unresolved (or was never in this state at all) triggers nothing.
  const hasStalePlaceholder = existingItems.some(i => isRecurringBaseFeeLineItem(i.product_name) && i.product_name === 'Recurring base fee — partial-period treatment unresolved')
  const isResolvedNow = !terms.base_fee_proration?.requires_confirmation
  if (hasStalePlaceholder && isResolvedNow) {
    for (const item of existingItems) {
      if (isRecurringBaseFeeLineItem(item.product_name)) staleIds.add(item.id)
    }
    freshItems = buildLineItems(terms, currency).filter(i => isRecurringBaseFeeLineItem(i.product_name))
  }

  // (2) percentage_of_basis fee rows — typed component is authority; the
  // fee_label match only locates which stored row it concerns.
  const percentageOfBasisLabels = new Set(
    (terms.additional_recurring_fees ?? []).filter(f => f.percentage_of_basis).map(f => f.fee_label),
  )
  for (const item of existingItems) {
    if (percentageOfBasisLabels.has(item.product_name)) staleIds.add(item.id)
  }

  return { staleIds: Array.from(staleIds), freshItems }
}

// DB-touching wrapper — the sole place this plan is actually executed.
// Best-effort by design (never throws past this function): called from
// confirm-rule (right after a reviewer's own base_fee_proration
// confirmation — an explicit write already in flight) and from POST
// /api/jobs/[id]/reconcile-line-items (the explicit legacy-backfill
// command, for a job confirmed before either fix existed). Deliberately
// NEVER called from GET — see this file's own header, Step 17E.2 item 1.
export async function reconcileStaleLineItemsForJob(params: {
  jobId: string
  terms: ContractTerms
  currency: string
  // Already-fetched stored items, when the caller has them on hand (the
  // job GET route always does) — avoids a redundant read. Fetched fresh
  // when omitted (confirm-rule's own call site doesn't have them handy).
  existingItems?: StoredLineItemRef[]
}): Promise<LineItemReconciliationResult> {
  const { jobId, terms, currency } = params
  try {
    const existingItems = params.existingItems ?? (
      (await supabaseServer.from('line_items').select('id, product_name').eq('job_id', jobId)).data ?? []
    )
    const plan = planLineItemReconciliation({ existingItems, terms, currency })
    if (plan.staleIds.length === 0) return { staleIds: [], freshItems: [] }

    await supabaseServer.from('line_items').delete().in('id', plan.staleIds)
    let inserted: Array<BuiltLineItem & { id: string; job_id: string }> = []
    if (plan.freshItems.length > 0) {
      const { data } = await supabaseServer
        .from('line_items')
        .insert(plan.freshItems.map(item => ({ ...item, job_id: jobId })))
        .select('*')
      inserted = (data ?? []) as Array<BuiltLineItem & { id: string; job_id: string }>
    }
    return { staleIds: plan.staleIds, freshItems: inserted }
  } catch (err) {
    console.error(`[line-items-reconciliation] failed to reconcile stale line items for job ${jobId}:`, err)
    return { staleIds: [], freshItems: [] }
  }
}
