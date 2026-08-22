import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getLatestAttempt, getAttemptOperations, recordAdminAction } from '@/lib/billing-execution-store'
import { canSafelyRetryBillingOperation, STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS } from '@/lib/billing-execution-attempt'

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
    .from('jobs').select('org_id, execute_status, billing_platform').eq('id', id).single()
  if (!job || job.org_id !== org.orgId)
    return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (job.execute_status !== 'FAILED') {
    return NextResponse.json(
      { error: 'Billing retry can only be authorized for a job whose last attempt failed.' },
      { status: 400 },
    )
  }

  // Item 16 — inspect the latest attempt (if any) before authorizing.
  // A job whose FAILED status came from a BillingPreconditionError (no
  // attempt ever created — see approve/route.ts's catch block) has nothing
  // to inspect: trivially case A.
  const platform = (job.billing_platform as 'stripe' | 'remembill' | 'chargebee' | null) ?? 'stripe'
  const latestAttempt = await getLatestAttempt(id, platform)
  if (latestAttempt) {
    const operations = await getAttemptOperations(latestAttempt.id)
    const now = new Date()
    // Step 14 final amendment, items 5-8 — the same time-bounded check
    // runTrackedOperation itself uses (never a bare capability check): an
    // idempotent_retry operation stops being auto-safe once the
    // provider's own idempotency-key retention window has elapsed since
    // it was FIRST attempted, even though its stored capability never
    // changes (that field is immutable — see the migration). Authorizing
    // here and then having the next Approve immediately refuse the same
    // operation would be a confusing, avoidable round trip.
    const blocking = operations.find(op => op.status === 'outcome_uncertain' && !canSafelyRetryBillingOperation(op, now))
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

  if (latestAttempt) {
    await recordAdminAction({ attemptId: latestAttempt.id, action: 'retry_authorized', actorEmail: org.userEmail })
  }

  return NextResponse.json({ ok: true })
}
