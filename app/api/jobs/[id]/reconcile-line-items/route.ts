/**
 * POST /api/jobs/[id]/reconcile-line-items
 *
 * Step 17E.2, item 2 — the explicit, idempotent write path for repairing
 * an already-confirmed contract's STALE stored line_items against its
 * current persisted contract_terms. No extraction, no LLM call.
 *
 * Step 17H.4B0D4H1B3 — migrated off the legacy reconcileStaleLineItemsForJob
 * (physical DELETE+INSERT, no locking, no snapshot validation) onto the
 * shared Model B+ orchestration (lib/current-line-item-reconciliation-
 * orchestration.ts) — plan, atomic apply, one bounded stale-plan retry,
 * never a physical delete.
 *
 * Step 17H.4B0D4H1B3.1 — billing safety moved to BEFORE the mutation, not
 * after: this route now acquires a temporary configuration-mutation claim
 * (lib/configuration-mutation-claim.ts — the SAME begin_job_configuration_
 * mutation RPC confirm-rule and the reviewer PATCH use) BEFORE the applier
 * can change anything, closing the exact window the H1B3 design left open
 * (scheduler could claim a stale schedule between the mutation and the
 * old post-hoc hold write). No-op calls still restore straight back to
 * whatever hold existed before this call — "preserves current product
 * convenience" per the spec — never manufacturing a hold out of nothing.
 *
 * Idempotent: a job with nothing to reconcile is claim/restore-neutral —
 * safe to call any number of times.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { buildLineItems } from '@/lib/line-items'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'
import { reconcileCurrentLineItemsForJob } from '@/lib/current-line-item-reconciliation-orchestration'
import { computePostMutationHoldTransition, applyReconciliationHoldTransition } from '@/lib/reconciliation-hold-transition'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from '@/lib/configuration-mutation-claim'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Same write-class gate as confirm-rule (the other place this exact
  // reconciliation happens) — this persists a correction to billing-
  // facing data, never merely confirms/views one.
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, module, currency, contract_terms ( * )')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — Model B+ (current_line_items/billing_hold) is
  // AUTO_CONFIGURE-only by design (H1B4B's audit); BILLING_VERIFICATION and
  // PARTNER_RECON jobs must be rejected here, before the mutation claim.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  if (!terms) return NextResponse.json({ error: 'No contract terms on file for this job' }, { status: 400 })

  // Step 17H.4B0D4H1B3.1 §12 — claim BEFORE the applier can mutate
  // anything, not after. Rejects EXTRACTING/APPROVING/malformed-hold/an
  // active reexecution or configuration-mutation from another operation.
  // A never-approved job still gets this ownership check (protects
  // against racing a concurrent execute) even though no hold is set.
  const claim = await beginConfigurationMutationClaim(supabaseServer, jobId)
  if (!claim.claimed) {
    return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
  }

  const currency = (job.currency as string | undefined) ?? terms.currency ?? 'USD'
  const freshItems = buildLineItems(terms, currency)

  // A thrown exception here (e.g. the orchestration's own current_line_items
  // read failing) must never leave the temporary claim dangling — normalized
  // to the same 'error' outcome shape a failed applier RPC call already
  // produces, so the transition logic below always runs and the job never
  // gets stuck under an un-transitionable reexecution hold.
  const result = await reconcileCurrentLineItemsForJob({
    supabase: supabaseServer, jobId,
    freshItems,
    terms: {
      overage_tiers: terms.overage_tiers ?? [],
      additional_recurring_fees: terms.additional_recurring_fees ?? [],
      base_fee_proration: terms.base_fee_proration ?? null,
    },
  }).catch((err) => ({
    status: 'error' as const, errorMessage: err instanceof Error ? err.message : String(err), blockers: [], retried: false,
  }))

  // Step 17H.4B0D4H1B3.1 §13/§14/§16/§17/§18 — allowRestoreToNullWhenUnmutated
  // is true here (and only here, not confirm-rule): this route never
  // touches contract_terms, so "clean and zero mutations" genuinely means
  // nothing happened at all — restoring straight back to whatever held
  // before this call (including NULL) is correct. An ambiguous applier
  // RPC error can never hit that branch (isReconciliationOutcomeClean is
  // false for it), so it always resolves to reconciliation_blocked
  // instead, per §18's explicit fail-safe requirement.
  const transition = computePostMutationHoldTransition({
    claim, outcome: result, allowRestoreToNullWhenUnmutated: true, now: new Date().toISOString(),
  })
  let holdConflict = false
  if (transition.changeNeeded) {
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, jobId, claim.newBillingHold, transition.nextHold)
    holdConflict = !applied
  }

  return NextResponse.json({
    status: result.status,
    updatedCount: result.status === 'applied' ? result.updatedCount : 0,
    insertedCount: result.status === 'applied' ? result.insertedCount : 0,
    supersededCount: result.status === 'applied' ? result.supersededCount : 0,
    blockers: result.blockers,
    retried: result.retried,
    ...(holdConflict ? { holdConflict: true } : {}),
  })
}
