import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getAttemptById, recordAdminAction, markOperationSucceeded, markOperationFailedSafe, recomputeAttemptStatusIfFullyResolved } from '@/lib/billing-execution-store'

type Body = {
  operationId?: string
  outcome?: 'succeeded' | 'not_executed'
  // Required, and only meaningful, when outcome === 'succeeded' — the real
  // provider object id the admin found while manually checking Stripe/
  // Remembill. Never free text/notes (item 24) — this is the one
  // structured fact reconciliation actually needs to record.
  externalObjectId?: string
}

/**
 * POST /api/jobs/[id]/reconcile-billing-operation
 *
 * Step 14, item 16 case B — the explicit administrative action that
 * resolves a specific operation stuck at `outcome_uncertain` after a human
 * has checked the real billing platform. This is the ONLY way such an
 * operation's status can change — there is no automatic path, and no
 * generic PATCH accepts operation status/external id directly (item 17):
 * a browser can never submit "this operation succeeded, id=X" without
 * going through this narrow, admin-gated, ownership-checked action.
 *
 * Ownership proof (item 17/26 — cross-org/cross-job operation ids must be
 * rejected): the operationId's OWNING ATTEMPT is looked up first, and its
 * job_id/org_id are compared against this route's own session-derived org
 * and the :id in the URL — never trusted from the request body, and never
 * assumed just because an operation row with that id exists somewhere.
 *
 * outcome:
 *   'succeeded'    — the admin found the real object in Stripe/Remembill.
 *                     Requires externalObjectId. Operation -> 'succeeded'.
 *                     A future resume (getOrCreateAttempt/runTrackedOperation)
 *                     returns this id without ever calling the provider
 *                     again for this specific operation.
 *   'not_executed' — the admin confirmed the object does NOT exist.
 *                     Operation -> 'failed_safe' (confirmed nothing was
 *                     created — safe to retry once the attempt resumes).
 *
 * Recorded immutably (item 24) as a billing_execution_admin_actions row
 * (operation_verified_succeeded / operation_verified_not_executed), never
 * as a mutable field another code path could later silently overwrite.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as Body
  const { operationId, outcome, externalObjectId } = body

  if (!operationId || typeof operationId !== 'string') {
    return NextResponse.json({ error: 'operationId is required' }, { status: 400 })
  }
  if (outcome !== 'succeeded' && outcome !== 'not_executed') {
    return NextResponse.json({ error: 'outcome must be "succeeded" or "not_executed"' }, { status: 400 })
  }
  if (outcome === 'succeeded' && (!externalObjectId || typeof externalObjectId !== 'string')) {
    return NextResponse.json({ error: 'externalObjectId is required when outcome is "succeeded" — reconciliation must reference the real object found on the billing platform.' }, { status: 400 })
  }

  const { data: operation } = await supabaseServer
    .from('billing_execution_operations').select('*').eq('id', operationId).maybeSingle()
  if (!operation) return NextResponse.json({ error: 'Operation not found' }, { status: 404 })

  // Ownership chain: operation -> attempt -> job -> org, every hop derived
  // server-side, never from the request body. A crafted operationId
  // belonging to a different job or org fails here, even if that job
  // happens to belong to the same organization (job scoping, not just org
  // scoping — matches Step 13's subject-ownership discipline).
  const attempt = await getAttemptById(operation.attempt_id as string)
  if (!attempt || attempt.jobId !== jobId || attempt.organizationId !== org.orgId) {
    return NextResponse.json({ error: 'Operation not found' }, { status: 404 })
  }

  const { data: job } = await supabaseServer.from('jobs').select('org_id').eq('id', jobId).eq('org_id', org.orgId).maybeSingle()
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (operation.status !== 'outcome_uncertain') {
    return NextResponse.json(
      { error: `Operation is not in an uncertain state (current status: ${operation.status}) — reconciliation only applies to an operation genuinely awaiting verification.` },
      { status: 400 },
    )
  }

  if (outcome === 'succeeded') {
    await markOperationSucceeded(operationId, externalObjectId!)
    await recordAdminAction({
      attemptId: attempt.id, operationId, action: 'operation_verified_succeeded',
      actorEmail: org.userEmail, externalObjectId: externalObjectId!,
    })
  } else {
    await markOperationFailedSafe(operationId, 'reconciled_not_executed')
    await recordAdminAction({
      attemptId: attempt.id, operationId, action: 'operation_verified_not_executed', actorEmail: org.userEmail,
    })
  }

  // Step 14 final amendment, item 3 — "reconciliation must resolve the old
  // attempt, not merely authorize the new one." If this was the last
  // operation on the attempt still outcome_uncertain, the attempt's own
  // status now reflects a determinate financial outcome — which is
  // exactly what lib/billing-execution-store.ts's getOrCreateAttempt
  // unresolved-prior-attempt barrier (items 1-4) checks before allowing a
  // new attempt for a changed billing plan. Never deletes or rewrites the
  // historical attempt/operation rows themselves — only the attempt's own
  // aggregate status field.
  await recomputeAttemptStatusIfFullyResolved(attempt.id)

  return NextResponse.json({ ok: true })
}
