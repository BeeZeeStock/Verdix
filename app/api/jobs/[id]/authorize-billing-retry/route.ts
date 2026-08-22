import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { recordAdminAction } from '@/lib/billing-execution-store'
import { STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS } from '@/lib/billing-execution-attempt'
import { getBillingReconciliationState } from '@/lib/billing-reconciliation'

/**
 * POST /api/jobs/[id]/authorize-billing-retry
 *
 * Step 13 final execution-state correction, item 5 — the ONLY way a FAILED
 * job becomes re-approvable. Deliberately a distinct, semantically-named
 * action rather than an extra case in the generic PATCH /api/jobs/[id]
 * status-mutation endpoint: a browser must never be able to move a job from
 * FAILED to READY_TO_APPROVE just by submitting {"execute_status":
 * "READY_TO_APPROVE"} through a generic field — that would look identical
 * to an ordinary, low-stakes status update and hide the real risk (Stripe's
 * and Remembill's invoice-write calls are not all safely repeatable — see
 * approve/route.ts's catch block — so a prior FAILED attempt's external
 * outcome may be genuinely uncertain). This route's name states the actual
 * action and its precondition out loud.
 *
 * Step 14, item 16 — no longer a blanket "flip the status" action. Before
 * authorizing, this inspects the job's latest billing_execution_attempt:
 *
 *   A. Safe idempotent resume — every operation on the latest attempt is
 *      either already succeeded, never started, confirmed-safe-to-retry
 *      (failed_safe), or outcome_uncertain with a provider-proven
 *      idempotent_retry capability (a same-key retry is the provider's OWN
 *      guarantee) -> authorization proceeds. The next Approve call reuses
 *      THIS SAME attempt (lib/billing-execution-store.ts's
 *      getOrCreateAttempt resumes a terminal attempt when its fingerprint
 *      still matches the current plan) — same operation ids, same
 *      idempotency keys, so an operation that already genuinely succeeded
 *      is never re-attempted.
 *   B. External object verified to exist — handled entirely by a SEPARATE
 *      route (POST /api/jobs/[id]/reconcile-billing-operation) that flips
 *      the specific operation's status away from outcome_uncertain first.
 *      Once that has happened, this route's own check sees case A —
 *      deliberately no special-cased "B" branch needed here.
 *   C. Unsafe/ambiguous, unreconciled — any operation still
 *      outcome_uncertain with a NON-idempotent capability blocks
 *      authorization outright (400), naming exactly which operation needs
 *      reconciliation, rather than silently deferring the problem to the
 *      next Approve attempt (which would refuse to auto-retry it anyway,
 *      but only after the job was already moved to READY_TO_APPROVE,
 *      confusingly).
 *
 * Step 15, item 3/22 — this now consumes the SAME derived
 * BillingReconciliationState the reconciliation panel/API use
 * (lib/billing-reconciliation.ts), rather than re-deriving its own
 * "which attempt, which provider" judgment. This also fixed a real
 * pre-existing bug the Step 15 audit found: this route previously derived
 * the provider to inspect via `jobs.billing_platform ?? 'stripe'` — but
 * `jobs.billing_platform` is only ever WRITTEN on a successful Approve, so
 * a job that failed before ever completing (e.g. pushed to Remembill, but
 * every attempt so far failed) had a null billing_platform, silently
 * causing this route to inspect Stripe's (nonexistent) attempt history
 * instead of the job's real Remembill one — trivially "case A" every
 * time, skipping the actual safety check entirely. The shared resolver
 * derives provider from the job's real attempt history instead.
 *
 * Item 22 — this route's scope stays narrow: it authorizes exactly the
 * states where the NEXT Approve call is known to either (a) genuinely
 * retry safely, or (b) recover automatically with no new provider call
 * ('none' / 'safe_to_resume' / 'executed_same_plan' / an
 * 'operation_outcome_uncertain' whose every uncertain operation is still
 * inside its idempotent-retry window). It deliberately refuses — pointing
 * at the reconciliation state instead — for 'partially_executed' and
 * 'executed_plan_changed': retrying either would just hit the identical
 * block on the next Approve call, and 'executed_plan_changed' specifically
 * needs a correction assessment, not a retry (item 10: never offer Retry/
 * Approve again/Bill current plan for that state).
 *
 * Requires: admin (same bar as Approve/Revoke — this is billing-execution-
 * adjacent), current execute_status === 'FAILED' exactly, atomically
 * re-asserted on the write. Takes no body — there is nothing to submit;
 * authorizing the retry IS the entire action, after the admin has verified
 * the billing platform out of band (or, for case C operations, after using
 * the dedicated reconciliation action first).
 *
 * Deliberately does NOT touch operational_event_evidence in any way (item
 * 8: authorizing a retry must never imply evidence remains valid) — the
 * next Approve request re-fetches and re-evaluates it entirely from
 * scratch, exactly as every other Approve call does.
 *
 * Audit trail — item 24: recorded as an immutable billing_execution_
 * admin_actions row (retry_authorized, actor, timestamp, the attempt it
 * applies to) — a trigger rejects every UPDATE for every role including
 * service_role, so no historical action can be silently rewritten (see
 * 20260825000002_billing_execution_admin_actions_append_only.sql); whole-
 * row deletion is still possible only via the existing job-delete cascade,
 * never a targeted mutation of one record. jobs.error_message still
 * carries a human-readable echo for the UI, but is no longer the durable
 * record — the admin_actions row is.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params

  const { data: job } = await supabaseServer
    .from('jobs').select('org_id, execute_status').eq('id', id).single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (job.execute_status !== 'FAILED') {
    return NextResponse.json(
      { error: 'Billing retry can only be authorized for a job whose last attempt failed.' },
      { status: 400 },
    )
  }

  // Item 3/16/22 — the single canonical resolver decides what this attempt
  // history actually means; this route only decides which of those
  // meanings it is willing to authorize past. A job whose FAILED status
  // came from a BillingPreconditionError (no attempt ever created — see
  // approve/route.ts's catch block) resolves to 'none': trivially safe.
  const { state } = await getBillingReconciliationState(id, org.orgId, new Date())

  if (state.kind === 'partially_executed') {
    return NextResponse.json(
      {
        error: 'A previous billing attempt for this job partially succeeded — retrying would not resolve this. Manual recovery is required; see the billing reconciliation panel.',
        code: 'prior_billing_attempt_partially_executed',
        attemptId: state.attemptId,
      },
      { status: 400 },
    )
  }
  if (state.kind === 'executed_plan_changed') {
    return NextResponse.json(
      {
        error: 'Billing already executed using an earlier plan, and the current configuration differs — retrying would not resolve this. Review the correction assessment in the billing reconciliation panel.',
        code: 'billing_already_executed_plan_changed',
        attemptId: state.attemptId,
      },
      { status: 400 },
    )
  }
  if (state.kind === 'operation_outcome_uncertain') {
    // Step 14 final amendment, items 5-8 — the same time-bounded check
    // runTrackedOperation itself uses (never a bare capability check): an
    // idempotent_retry operation stops being auto-safe once the
    // provider's own idempotency-key retention window has elapsed since
    // it was FIRST attempted, even though its stored capability never
    // changes (that field is immutable — see the migration). Authorizing
    // here and then having the next Approve immediately refuse the same
    // operation would be a confusing, avoidable round trip.
    const blocking = state.operations.find(op => op.status === 'outcome_uncertain' && !op.idempotencyWindowStillValid)
    if (blocking) {
      const windowNote = blocking.retryCapability === 'idempotent_retry'
        ? ` its ${STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS}h provider idempotency-retention window has elapsed since it was first attempted, so a blind replay is no longer safe.`
        : ''
      return NextResponse.json(
        {
          error: `Operation "${blocking.operationKey}" has an uncertain outcome and is not currently safely auto-retryable (capability: ${blocking.retryCapability}).${windowNote} Verify it against the billing platform, then use the reconciliation action before authorizing retry.`,
          code: 'operation_requires_reconciliation',
          operationId: blocking.id,
          operationKey: blocking.operationKey,
        },
        { status: 400 },
      )
    }
  }
  // 'none' / 'safe_to_resume' / 'executed_same_plan' / an
  // 'operation_outcome_uncertain' whose every uncertain operation is still
  // safely idempotent-retryable -> authorization proceeds.

  const { data: authorized, error } = await supabaseServer
    .from('jobs')
    .update({
      execute_status: 'READY_TO_APPROVE',
      error_message: `Billing retry authorized by ${org.userEmail} after manual verification of the billing platform.`,
    })
    .eq('id', id)
    .eq('execute_status', 'FAILED') // atomic — only ever transitions a job that is still genuinely FAILED
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!authorized || authorized.length === 0)
    return NextResponse.json({ error: 'Job is no longer FAILED — it may already be in progress or have changed state.' }, { status: 409 })

  if (state.kind !== 'none') {
    await recordAdminAction({ attemptId: state.attemptId, action: 'retry_authorized', actorEmail: org.userEmail })
  }

  return NextResponse.json({ ok: true })
}
