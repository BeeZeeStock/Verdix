import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { beginConfigurationMutationClaim, describeConfigurationMutationClaimRejection } from '@/lib/configuration-mutation-claim'
import { computePostMutationHoldTransition, applyReconciliationHoldTransition } from '@/lib/reconciliation-hold-transition'
import { buildFreshLineItemsFromPersistedTerms } from '@/lib/reconciliation-terms-loader'
import { reconcileCurrentLineItemsForJob, type ReconciliationOrchestrationResult } from '@/lib/current-line-item-reconciliation-orchestration'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

// Step 17H.4B0D4H1B3.2 — this is the most direct commercial-terms editor in
// the system: a raw PATCH accepting nearly every contract_terms field in
// one call, with no reviewer-metadata tracking of its own (unlike
// line_items' reviewer_corrected_fields). Almost every field it accepts
// directly feeds buildLineItems/the calculation engine (base fee, billing
// frequency, overage tiers, additional recurring fees, escalators, ramp
// schedule/year pricing, contract dates/term, currency) — the handful that
// don't (contract_id/crm_id/customer_* /billing_contact/payment_terms_text/
// auto_renews/renewal_notice_days/number_format) are still accepted in the
// SAME single request as any commercial field, with no way to split them
// apart client-side. Per this task's own explicit "uncertain -> commercial
// for v1" policy, the WHOLE route is treated as commercial — building a
// brittle per-field partition here risks silently missing a genuinely
// material field, which is a worse outcome than being conservative on a
// few administrative ones.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()

  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id, module')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4C — contract_terms PATCH is a Model B+ commercial-write
  // surface (AUTO_CONFIGURE-only by design, per H1B4B's audit); reject before
  // the mutation claim and before contract_terms.update.
  if (ownedJob.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  const SCALAR_FIELDS = [
    'contract_id', 'crm_id',
    'contract_start_date', 'contract_end_date', 'contract_term_months',
    'customer_name', 'customer_address', 'customer_email', 'customer_org_number', 'billing_contact',
    'payment_terms_text', 'payment_terms_days',
    'base_monthly_fee', 'base_annual_fee', 'billing_frequency',
    'auto_renews', 'renewal_notice_days',
    'number_format', 'currency',
  ]
  const JSON_FIELDS = ['escalators', 'discounts', 'ramp_schedule', 'year_pricing', 'overage_tiers', 'additional_recurring_fees']

  const updates: Record<string, unknown> = {}
  for (const f of JSON_FIELDS)   if (body[f] !== undefined) updates[f] = body[f]
  for (const f of SCALAR_FIELDS) if (body[f] !== undefined) updates[f] = body[f]

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  // Step 17H.4B0D4H1B3.2 §5 — ownership claimed BEFORE the write. Rejects
  // EXTRACTING/APPROVING/an active reexecution or configuration mutation/
  // malformed hold, exactly like every other protected commercial writer.
  const claim = await beginConfigurationMutationClaim(supabaseServer, id)
  if (!claim.claimed) {
    return NextResponse.json({ error: describeConfigurationMutationClaimRejection(claim) }, { status: 409 })
  }

  const { error } = await supabaseServer
    .from('contract_terms')
    .update(updates)
    .eq('job_id', id)

  if (error) {
    // §8 — write never took effect: restore the claim exactly like every
    // other pre-mutation-failure path.
    await applyReconciliationHoldTransition(supabaseServer, id, claim.newBillingHold, claim.previousBillingHold).catch(() => {})
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // §6/§22 — reconcile from the AUTHORITATIVE POST-WRITE persisted terms,
  // never the in-memory `updates` object (DB normalization/defaults may
  // have altered what was actually stored). Runs regardless of
  // previously-approved-ness, mirroring confirm-rule's own behavior — it
  // keeps current_line_items in sync with contract_terms for every job,
  // not only ones with an active billing schedule to protect.
  const built = await buildFreshLineItemsFromPersistedTerms(supabaseServer, id)
  let outcome: ReconciliationOrchestrationResult
  if (!built) {
    // The write just succeeded but contract_terms can't be re-read — either
    // a genuinely missing row (should not happen; update() matched
    // something) or an infra read failure. Fail safe, never silently skip.
    outcome = { status: 'error', errorMessage: 'contract_terms could not be re-read after write', blockers: [], retried: false }
  } else {
    outcome = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId: id,
      freshItems: built.freshItems,
      terms: {
        overage_tiers: built.loaded.terms.overage_tiers ?? [],
        additional_recurring_fees: built.loaded.terms.additional_recurring_fees ?? [],
        base_fee_proration: built.loaded.terms.base_fee_proration ?? null,
      },
    }).catch((err): ReconciliationOrchestrationResult => ({
      status: 'error', errorMessage: err instanceof Error ? err.message : String(err), blockers: [], retried: false,
    }))
  }

  // §9/§10, revised 17H.4B0D4H1B3.4 — a successful contract_terms write
  // here is BY DEFINITION a real commercial change (this route exists to
  // make one) — never a no-op eligible for restoring to the prior hold,
  // unlike reconcile-line-items' own genuinely-idempotent case.
  // allowRestoreToNullWhenUnmutated is therefore false, matching confirm-
  // rule's own policy exactly. Runs unconditionally now — every
  // AUTO_CONFIGURE claim is real, and computePostMutationHoldTransition
  // itself resolves a clean outcome to NULL for a never-approved job.
  let holdConflict = false
  const transition = computePostMutationHoldTransition({
    claim, outcome, allowRestoreToNullWhenUnmutated: false, now: new Date().toISOString(),
  })
  if (transition.changeNeeded) {
    const { applied } = await applyReconciliationHoldTransition(supabaseServer, id, claim.newBillingHold, transition.nextHold)
    holdConflict = !applied
  }

  return NextResponse.json({ ok: true, ...(holdConflict ? { holdConflict: true } : {}) })
}
