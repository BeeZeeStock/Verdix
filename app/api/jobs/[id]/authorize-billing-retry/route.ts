import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

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
 * and Remembill's invoice-write calls are not safely repeatable — see
 * approve/route.ts's catch block — so a prior FAILED attempt's external
 * outcome may be genuinely uncertain). This route's name states the actual
 * action and its precondition out loud.
 *
 * Requires: admin (same bar as Approve/Revoke — this is billing-execution-
 * adjacent), current execute_status === 'FAILED' exactly, atomically
 * re-asserted on the write. Takes no body — there is nothing to submit;
 * authorizing the retry IS the entire action, after the admin has verified
 * the billing platform out of band.
 *
 * Deliberately does NOT touch operational_event_evidence in any way (item
 * 8: authorizing a retry must never imply evidence remains valid) — the
 * next Approve request re-fetches and re-evaluates it entirely from
 * scratch, exactly as every other Approve call does.
 *
 * Audit trail: no dedicated audit-log table exists in this schema for
 * job-level admin actions (only lib/deletion-log.ts, a different concern).
 * Reusing the existing, already-established pattern instead: jobs.
 * error_message set to a fully system-generated string embedding the
 * admin's email (never raw user-typed notes), and jobs.updated_at, which is
 * already trigger-maintained on every row write (see the jobs_updated_at
 * trigger in supabase/migrations/20260626000000_verdix.sql) — no new
 * columns, no new table.
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

  return NextResponse.json({ ok: true })
}
