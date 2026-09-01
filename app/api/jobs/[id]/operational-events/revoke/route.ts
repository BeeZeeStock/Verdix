/**
 * POST /api/jobs/[id]/operational-events/revoke
 *
 * Step 13, item 13 — the correction path for a mistaken attestation.
 * Never deletes the original evidence row (item 12: immutable/auditable) —
 * flips status to 'revoked' with a server-minted revoked_at/revoked_by.
 * The operational-event blocker returns immediately (computeCommercialRuleWorkload
 * simply stops finding an active, matching row).
 *
 * Fails closed if the job has already reached execute_status: 'COMPLETED'
 * — Approve's own fail-closed gate (executionBlockers.length > 0) means a
 * COMPLETED job had, at approval time, satisfied evidence for every
 * event-conditioned fee on it; revoking now cannot un-invoice anything, so
 * this is surfaced explicitly as 'billing_already_executed' rather than
 * silently flipping status and implying the blocker meaningfully "returned".
 *
 * Step 13 final amendment, item 5 — ALSO fails closed on execute_status:
 * 'APPROVING', the new in-progress marker approve/route.ts writes right
 * before it calls configureBilling (before the external Stripe/Remembill
 * side effect, not after). Without this, a revoke landing in the window
 * between Approve passing its readiness gate and the external call actually
 * completing would flip evidence to 'revoked' and claim success, while the
 * external invoice is created anyway moments later. code: 'billing_in_progress'
 * distinguishes this (retry shortly) from 'billing_already_executed'
 * (permanent — nothing to retry).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { auth } from '@/lib/auth'
import { AUTO_CONFIGURE_ONLY_MESSAGE } from '@/lib/auto-configure-guard'

type Body = {
  subjectId: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as Body
  const { subjectId } = body
  if (!subjectId || typeof subjectId !== 'string') {
    return NextResponse.json({ error: 'subjectId is required' }, { status: 400 })
  }

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, module, contract_terms_id, execute_status')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Step 17H.4B0D4H1B4D1 §9/§10 — same AUTO_CONFIGURE-only boundary as
  // attest (the sibling of this route); checked before the execute_status
  // fail-closed checks below since those are AUTO_CONFIGURE-only fields too.
  if (job.module !== 'AUTO_CONFIGURE') {
    return NextResponse.json({ error: AUTO_CONFIGURE_ONLY_MESSAGE }, { status: 400 })
  }

  if (job.execute_status === 'COMPLETED') {
    return NextResponse.json({
      error: 'This job has already been approved and configured for billing — revoking evidence now cannot reverse anything already executed.',
      code: 'billing_already_executed',
    }, { status: 409 })
  }
  if (job.execute_status === 'APPROVING') {
    return NextResponse.json({
      error: 'This job is currently being approved — billing may already be underway. Wait for it to finish, then revoke if still needed.',
      code: 'billing_in_progress',
    }, { status: 409 })
  }

  // eventType is re-derived server-side from the CURRENT persisted
  // condition, same as the attest route — a revoke request never carries
  // an eventType of its own to target with.
  const { data: termsRow } = job.contract_terms_id
    ? await supabaseServer.from('contract_terms').select('one_time_fees').eq('id', job.contract_terms_id).maybeSingle()
    : { data: null }
  const fees = (termsRow?.one_time_fees ?? []) as Array<{ fee_id?: string; billability_condition?: { kind: string; event_type?: string } | null }>
  const fee = fees.find(f => f.fee_id === subjectId)
  const eventType = fee?.billability_condition?.kind === 'event' ? fee.billability_condition.event_type : undefined
  if (!eventType) {
    return NextResponse.json({ error: 'One-time fee not found, or its billability condition is not event-based' }, { status: 404 })
  }

  const { data: existing } = await supabaseServer
    .from('operational_event_evidence')
    .select('id')
    .eq('job_id', jobId)
    .eq('subject_id', subjectId)
    .eq('event_type', eventType)
    .eq('status', 'active')
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'No active evidence to revoke for this fee' }, { status: 404 })
  }

  const session = await auth()
  const reviewerEmail = session?.user?.email ?? org.userEmail ?? 'unknown'

  const { error } = await supabaseServer
    .from('operational_event_evidence')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: reviewerEmail })
    .eq('id', existing.id)
    .eq('status', 'active') // idempotency guard — a concurrent revoke can't double-apply

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, revokedId: existing.id })
}
