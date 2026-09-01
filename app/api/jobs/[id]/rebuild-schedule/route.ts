import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { configureBilling, recoverConfigureResultFromSucceededAttempt, type LineItemInput } from '@/lib/billing-writer'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'
import { loadActiveOperationalEventEvidence } from '@/lib/operational-event-evidence-loader'
import { evaluateBillingGate, shouldClearBillingHoldAfterSuccess } from '@/lib/billing-hold'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'
import {
  UnresolvedPriorBillingAttemptError, PriorBillingAttemptExecutedError, PriorBillingAttemptExecutedPlanChangedError,
  PriorBillingAttemptPartiallyExecutedError, getAttemptById, getAttemptOperations,
} from '@/lib/billing-execution-store'

// Rebuilds planned_invoices from the current contract_terms when a job has a
// billing customer but no schedule yet (e.g. schedule generation was skipped
// or failed at approval time). Delegates to configureBilling — the same
// platform-aware function approve/route.ts uses — instead of hardcoding
// Stripe, so a job already committed to Remembill (or Chargebee) can never
// silently get billed through Stripe instead. Safe to call repeatedly:
// configureBilling's idempotent-repush logic leaves already-sent periods
// untouched rather than duplicating or re-charging them.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  // Step 17H.4B0D3B — current_line_items, not line_items: rebuilding a
  // schedule must configure billing off current commercial configuration
  // only, never a superseded row.
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, module, billing_customer_id, billing_platform, billing_hold, contract_terms(*), current_line_items(*)')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .single()

  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4D1 §2 — rebuild-schedule is a hold-RESOLVING operation
  // (schedule_rebuild_required -> configureBilling -> CAS clear), reachable
  // only for AUTO_CONFIGURE jobs (current_line_items/billing_platform/
  // billing_hold are AUTO_CONFIGURE-only concepts, per H1B4B's audit).
  // Rejected before any configureBilling/provider/schedule mutation, and
  // deliberately before the billing_customer_id/billing_hold checks below
  // so a wrong-module job never even reaches those.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }
  if (!job.billing_customer_id) return NextResponse.json({ error: 'No customer configured yet — approve the contract first' }, { status: 400 })

  // Step 17H.4B0D4H1A — billing_hold gate, independent of execute_status
  // (see lib/billing-hold.ts). Captured once at request start so the
  // hold-clear decision below re-checks the SAME snapshot this gate
  // evaluated, never a value that may have changed mid-request.
  const billingHoldAtRequestStart = job.billing_hold
  const rebuildGate = evaluateBillingGate(billingHoldAtRequestStart, 'rebuild_schedule')
  if (!rebuildGate.allowed) {
    return NextResponse.json({ error: rebuildGate.reason }, { status: 409 })
  }

  // This route only ever rebuilds the schedule for whichever platform the
  // job was already configured on — never a fallback or default. A job with
  // no recorded platform can't be safely rebuilt without knowing where its
  // existing customer/subscription actually lives.
  const platform = job.billing_platform as 'stripe' | 'remembill' | 'chargebee' | null
  if (!platform) {
    return NextResponse.json({ error: 'This job has no billing platform recorded — re-approve the contract instead of rebuilding.' }, { status: 400 })
  }
  if (platform === 'chargebee') {
    return NextResponse.json({ error: 'Chargebee billing schedules can’t be rebuilt from here yet — contact support.' }, { status: 400 })
  }

  const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
  if (!terms) return NextResponse.json({ error: 'No contract terms' }, { status: 400 })

  const lineItems = (job.current_line_items ?? []) as LineItemInput[]

  try {
    // Step 17H.2A item 2 fix — this call was previously missing the 7th
    // argument entirely, which meant configureBilling always saw [] and
    // could never see already-recorded evidence, incorrectly re-parking
    // every event-gated one-time fee on every rebuild — including ones
    // already cleared to bill. Loads via the same shared helper
    // approve/route.ts uses (lib/operational-event-evidence.ts), so this is
    // genuinely the same authoritative evidence source, not a second
    // independently-written evaluation.
    const operationalEventEvidence = await loadActiveOperationalEventEvidence(id)
    const result = await configureBilling(
      terms, lineItems, platform, id, org.orgId, job.billing_customer_id as string, operationalEventEvidence,
    )
    // Step 17H.4B0D4H1A.1 — compare-and-clear, never a blind
    // `UPDATE billing_hold = null`. A long-running configureBilling call
    // above may have taken long enough for a DIFFERENT process (most
    // notably a future H1B re-execution) to replace this job's hold with a
    // NEWER one (e.g. schedule_rebuild_required -> reexecution) while this
    // request was still in flight — clear_billing_hold_if_unchanged only
    // clears if the persisted hold is still EXACTLY the one this request
    // was authorized under (see the migration's own header comment for the
    // full race/equality semantics). Clearing is attempted only when this
    // request actually entered under schedule_rebuild_required and the
    // regeneration completed with no blocked one-time fee — otherwise there
    // is nothing to (or nothing safe to) clear.
    let holdConflict = false
    if (shouldClearBillingHoldAfterSuccess(billingHoldAtRequestStart) && !result.hadBlockedOneTimeFee) {
      const { data: cleared, error: clearError } = await supabaseServer.rpc('clear_billing_hold_if_unchanged', {
        p_job_id: id, p_expected_hold: billingHoldAtRequestStart,
      })
      if (clearError) {
        console.error(`[rebuild-schedule] clear_billing_hold_if_unchanged RPC failed for job ${id}:`, clearError)
      } else if (!cleared) {
        // The schedule itself was successfully rebuilt — that write is not
        // undone — but the hold this request was authorized under has
        // since been superseded (e.g. a newer re-execution began). Never
        // convert this into a claimed success: the current hold (whatever
        // it now is) must remain in force, and the caller must be told to
        // refresh and re-check rather than treat billing as safe.
        holdConflict = true
      }
    }
    const { count } = await supabaseServer
      .from('planned_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('job_id', id)
    if (holdConflict) {
      return NextResponse.json(
        { error: 'The billing schedule was rebuilt, but this job’s configuration changed again while the rebuild was running. Refresh and check its current status before proceeding.', platform: result.platform, periods: count ?? 0 },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, platform: result.platform, periods: count ?? 0 })
  } catch (err) {
    // Step 17H.4B0D4H1B4E3.7 — configureBilling shares the SAME
    // getOrCreateAttempt eligibility barrier approve/route.ts goes
    // through (there is no separate "rebuild attempt" concept — audited,
    // not assumed). Before this fix, every one of the four typed errors
    // that barrier can throw fell through to the generic 500 below,
    // reached only AFTER lib/billing-writer.ts's own destructive cleanup
    // had already deleted this job's scheduled/parked/draft
    // planned_invoices — the live-reproduced E3.6/E3.7 defect. That
    // ordering is now fixed at the source (deleteStalePlannedInvoices is
    // only called once eligibility is proven), so every branch below is
    // reached with planned_invoices byte-for-byte unchanged. These
    // branches mirror approve/route.ts's own identical catch block
    // verbatim in spirit (same classifications, same meaning) — never a
    // new recovery semantic invented for rebuild specifically.
    if (err instanceof PriorBillingAttemptExecutedError) {
      // The plan a rebuild would execute right now is financially
      // IDENTICAL (by fingerprint) to one a prior attempt already fully
      // executed — nothing to rebuild. Recovered exactly as approve
      // recovers the same error (never a new attempt, never a replayed
      // provider call). Deliberately does NOT clear schedule_rebuild_
      // required: recoverConfigureResultFromSucceededAttempt can only
      // confirm the FINANCIAL plan is unchanged, not that whatever
      // triggered this hold (a Model B+/current_line_items concern this
      // route has no visibility into) is itself immaterial — the same
      // "recovery never confirms cleanliness" doctrine that function's
      // own header already documents for its hadBlockedOneTimeFee
      // default. The hold stays exactly as it was; an explicit
      // re-reconciliation is the correct path to clear it, not an
      // inferred guess made here.
      const executedAttempt = await getAttemptById(err.executedAttemptId)
      if (!executedAttempt) {
        return NextResponse.json({ error: `Recovery failed: executed attempt ${err.executedAttemptId} could not be re-read.` }, { status: 500 })
      }
      const executedOperations = await getAttemptOperations(err.executedAttemptId)
      const result = await recoverConfigureResultFromSucceededAttempt(executedAttempt, executedOperations, org.orgId)
      return NextResponse.json({
        ok: true, alreadyExecuted: true, platform: result.platform,
        message: 'Nothing to rebuild — the current billing plan is identical to one already executed for this job. The schedule_rebuild_required hold was left in place; resolve it explicitly once the underlying change is confirmed immaterial to billing.',
      })
    }
    if (err instanceof PriorBillingAttemptExecutedPlanChangedError) {
      return NextResponse.json(
        { error: 'Billing has already been executed using an earlier billing plan. The current commercial configuration differs from the executed plan and cannot be rebuilt automatically — this requires an explicit correction/reconciliation workflow.', code: 'billing_already_executed_plan_changed', attemptId: err.executedAttemptId },
        { status: 409 },
      )
    }
    if (err instanceof PriorBillingAttemptPartiallyExecutedError) {
      return NextResponse.json(
        { error: 'A previous billing attempt for this job partially succeeded — some financial side effects already occurred and some did not. This cannot be safely superseded by a rebuild; manual recovery is required.', code: 'prior_billing_attempt_partially_executed', attemptId: err.partiallyExecutedAttemptId },
        { status: 409 },
      )
    }
    if (err instanceof UnresolvedPriorBillingAttemptError) {
      return NextResponse.json(
        { error: 'A previous billing attempt for this job has an unresolved outcome and must be reconciled before the schedule can be rebuilt.', code: 'unresolved_prior_billing_attempt', attemptId: err.unresolvedAttemptId },
        { status: 409 },
      )
    }
    // Surface the real, actionable failure (e.g. a Remembill auth error, a
    // missing org number) instead of a generic message — this is exactly
    // what needs fixing before the schedule can be built.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rebuild-schedule] configureBilling failed for job ${id} on ${platform}:`, err)
    return NextResponse.json({ error: `Failed to build the ${platform} billing schedule: ${message}` }, { status: 500 })
  }
}
