/**
 * POST /api/jobs/[id]/reconcile-semantic-keys
 *
 * Step 17F.1, item 1 — the explicit, idempotent write path for backfilling
 * a MISSING additional_recurring_fees/overage_tiers.semantic_input_key on
 * a contract extracted before that field existed in the extraction prompt
 * (see lib/semantic-input-key-reconciliation.ts's own header for the
 * confirmed root cause). Deliberately a separate, explicit action — never
 * triggered from GET (which must stay read-only), never inferring from
 * fee_label/tier_label free text, only ever resolving via the strict
 * canonical registry applied to metric_name/unit_type.
 *
 * Idempotent: a job with nothing to resolve returns
 * { reconciled: false, feeUpdates: 0, tierUpdates: 0 } and writes nothing,
 * on every call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { planSemanticInputKeyReconciliation, applySemanticInputKeyReconciliation, planMeterMappingSemanticKeyReconciliation } from '@/lib/semantic-input-key-reconciliation'
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
  // Same write-class gate as reconcile-line-items — this persists a
  // correction to billing-facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, module, contract_terms ( id, additional_recurring_fees, overage_tiers )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — semantic-key backfill is a Model B+ commercial-
  // write surface (AUTO_CONFIGURE-only by design, per H1B4B's audit);
  // reject before any contract_terms/contract_meter_mappings write.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  const terms = unwrapEmbedded(job.contract_terms as unknown as (ContractTerms & { id: string }) | (ContractTerms & { id: string })[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  const fees = terms.additional_recurring_fees ?? []
  const tiers = terms.overage_tiers ?? []
  const plan = planSemanticInputKeyReconciliation({ fees, tiers })

  // Step 17F.1, item 3 — contract_meter_mappings.semantic_input_key is a
  // SEPARATE storage location real billing's snapshot-finalize path reads
  // (lib/usage-pull.ts) — resolved from the same strict registry, applied
  // to each row's own contract_unit_type, independent of the contract_terms
  // fee/tier reconciliation above (a job can need one, the other, or both).
  const { data: mappingRows } = await supabaseServer
    .from('contract_meter_mappings')
    .select('contract_unit_type, semantic_input_key')
    .eq('job_id', jobId)
  const mappingPlan = planMeterMappingSemanticKeyReconciliation({ mappings: mappingRows ?? [] })

  const hasAnyMutation = plan.feeUpdates.length > 0 || plan.tierUpdates.length > 0 || mappingPlan.mappingUpdates.length > 0

  // Step 17H.4B0D4H1B3.2 §12/§13 — semantic_input_key never appears in
  // buildLineItems' own output (audited directly: lib/line-items.ts never
  // reads it), so it cannot make current_line_items structurally stale —
  // but it IS a real commercial-execution input (traced consumers: lib/
  // usage-pull.ts, app/api/admin/invoice-scheduler/route.ts), resolving
  // WHICH meter feeds a tier/fee's overage computation. Treated as
  // commercial: claimed before any write. A genuine no-op (nothing to
  // resolve) restores the claim immediately, matching reconcile-line-
  // items' own idempotent-call convention — no reason to acquire
  // ownership at all for a call that changes nothing.
  const claim = await beginConfigurationMutationClaim(supabaseServer, jobId)
  if (!claim.claimed) {
    return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
  }
  if (!hasAnyMutation) {
    await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, claim.previousBillingHold).catch(() => {})
    return NextResponse.json({ reconciled: false, feeUpdates: 0, tierUpdates: 0, mappingUpdates: 0 })
  }

  if (plan.feeUpdates.length > 0 || plan.tierUpdates.length > 0) {
    const { fees: reconciledFees, tiers: reconciledTiers } = applySemanticInputKeyReconciliation({ fees, tiers, plan })
    const { error } = await supabaseServer
      .from('contract_terms')
      .update({ additional_recurring_fees: reconciledFees, overage_tiers: reconciledTiers })
      .eq('id', terms.id)
    if (error) {
      await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, claim.previousBillingHold).catch(() => {})
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  for (const u of mappingPlan.mappingUpdates) {
    const { error } = await supabaseServer
      .from('contract_meter_mappings')
      .update({ semantic_input_key: u.semantic_input_key })
      .eq('job_id', jobId)
      .eq('contract_unit_type', u.contract_unit_type)
    if (error) {
      // The additional_recurring_fees/overage_tiers write (if any) already
      // committed by this point — never restored, per the frozen "once a
      // real write commits, never restore" doctrine; leave the claim held
      // and let the transition below fail safe to reconciliation_blocked.
      await applyReconciliationHoldTransition(
        supabaseServer, jobId, claim.newBillingHold,
        { reason: 'reconciliation_blocked', started_at: claim.newBillingHold?.started_at ?? new Date().toISOString(), blockers: [{ type: 'applier_error' }] },
      ).catch(() => {})
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // §12 — "reconcile line_items" per the task's own instruction, run for
  // defense-in-depth even though semantic_input_key structurally cannot
  // change current_line_items today — never used to decide "was this a
  // no-op" (hasAnyMutation already proved otherwise), only combined with
  // it via allowRestoreToNullWhenUnmutated:false so a real semantic-key
  // mutation is NEVER treated as eligible for a restore-to-null, even if
  // the line-item reconciliation itself finds nothing to change.
  // Runs unconditionally (17H.4B0D4H1B3.4) — no longer gated on
  // hasExistingBillingSchedule; every AUTO_CONFIGURE claim is real, and
  // computePostMutationHoldTransition itself resolves a clean outcome to
  // NULL for a never-approved job.
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

  return NextResponse.json({
    reconciled: true,
    feeUpdates: plan.feeUpdates.length,
    tierUpdates: plan.tierUpdates.length,
    mappingUpdates: mappingPlan.mappingUpdates.length,
    ...(holdConflict ? { holdConflict: true } : {}),
    resolvedKeys: [
      ...plan.feeUpdates.map(u => u.semantic_input_key),
      ...plan.tierUpdates.map(u => u.semantic_input_key),
      ...mappingPlan.mappingUpdates.map(u => u.semantic_input_key),
    ],
  })
}
