/**
 * POST /api/jobs/[id]/reconcile-fixed-fee-timing
 *
 * Step 17F.4, item 2 — the explicit, idempotent write path for backfilling
 * a MISSING fixed_fee_billing_timing on a contract extracted before that
 * field existed (Step 17F.3, item 2/8). See
 * lib/fixed-fee-billing-timing-reconciliation.ts's own header for why this
 * is a trivial, unconditional default — never an inference engine.
 * Deliberately a separate, explicit action — never triggered from GET
 * (which must stay read-only), never infers bill_at_period_start from
 * planned-invoice dates/scheduler behavior/cadence/payment terms.
 *
 * Idempotent: a job with nothing to backfill (no fixed fee, or a rule
 * already on file — resolved or not) returns { backfilled: false } and
 * writes nothing, on every call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { planFixedFeeBillingTimingReconciliation } from '@/lib/fixed-fee-billing-timing-reconciliation'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from '@/lib/configuration-mutation-claim'
import { computePostMutationHoldTransition, applyReconciliationHoldTransition } from '@/lib/reconciliation-hold-transition'
import { buildFreshLineItemsFromPersistedTerms } from '@/lib/reconciliation-terms-loader'
import { reconcileCurrentLineItemsForJob, type ReconciliationOrchestrationResult } from '@/lib/current-line-item-reconciliation-orchestration'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same write-class gate as the sibling reconciliation routes (reconcile-
  // line-items, reconcile-semantic-keys) — this persists a correction to
  // billing-facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, module, contract_terms ( id, base_monthly_fee, base_annual_fee, fixed_fee_billing_timing, base_fee_proration )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — fixed-fee-timing backfill is a Model B+
  // commercial-write surface (AUTO_CONFIGURE-only by design, per H1B4B's
  // audit); reject before any backfill write.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  const terms = unwrapEmbedded(job.contract_terms as unknown as (ContractTerms & { id: string }) | (ContractTerms & { id: string })[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  const plan = planFixedFeeBillingTimingReconciliation(terms)
  if (!plan.needsBackfill) {
    return NextResponse.json({ backfilled: false })
  }

  // Step 17H.4B0D4H1B3.2 §14/§15 — fixed_fee_billing_timing never appears
  // in buildLineItems' own output (audited: lib/line-items.ts never reads
  // it), so it cannot make current_line_items structurally stale — but it
  // IS a real commercial-execution input, traced to lib/fixed-fee-invoice-
  // scheduling.ts and app/api/admin/invoice-scheduler/route.ts, controlling
  // WHEN the scheduler bills a fixed fee. Treated as commercial: claimed
  // before the write. plan.needsBackfill===false above is the genuine
  // no-op case (nothing to claim ownership for at all).
  const claim = await beginConfigurationMutationClaim(supabaseServer, jobId)
  if (!claim.claimed) {
    return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
  }

  const { error } = await supabaseServer
    .from('contract_terms')
    .update({ fixed_fee_billing_timing: plan.rule })
    .eq('id', terms.id)
  if (error) {
    await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, claim.previousBillingHold).catch(() => {})
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // §15, revised 17H.4B0D4H1B3.4 — run reconciliation for defense-in-depth
  // (per the shared policy), but a real backfill just happened regardless
  // of what it finds — allowRestoreToNullWhenUnmutated:false means it can
  // never be treated as eligible for a restore-to-null. Runs
  // unconditionally now (no longer gated on hasExistingBillingSchedule) —
  // every AUTO_CONFIGURE claim is real, and computePostMutationHoldTransition
  // itself resolves a clean outcome to NULL for a never-approved job.
  let holdConflict = false
  const built = await buildFreshLineItemsFromPersistedTerms(supabaseServer, jobId)
  const outcome: ReconciliationOrchestrationResult = built
    ? await reconcileCurrentLineItemsForJob({
        supabase: supabaseServer, jobId,
        freshItems: built.freshItems,
        terms: {
          overage_tiers: built.loaded.terms.overage_tiers ?? [],
          additional_recurring_fees: built.loaded.terms.additional_recurring_fees ?? [],
          base_fee_proration: built.loaded.terms.base_fee_proration ?? null,
        },
      }).catch((err): ReconciliationOrchestrationResult => ({
        status: 'error', errorMessage: err instanceof Error ? err.message : String(err), blockers: [], retried: false,
      }))
    : { status: 'error', errorMessage: 'contract_terms could not be re-read after write', blockers: [], retried: false }

  const transition = computePostMutationHoldTransition({
    claim, outcome, allowRestoreToNullWhenUnmutated: false, now: new Date().toISOString(),
  })
  if (transition.changeNeeded) {
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, transition.nextHold)
    holdConflict = !applied
  }

  return NextResponse.json({ backfilled: true, rule: plan.rule, ...(holdConflict ? { holdConflict: true } : {}) })
}
