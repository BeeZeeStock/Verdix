/**
 * GET  /api/jobs/[id]/operational-input-values
 *   Lists every persisted operational-input period value row for this job
 *   (across all input_keys/periods, all statuses) — the raw, append/
 *   revoke-versioned rows a caller shapes into a calculation-ready map via
 *   lib/operational-input-binding.ts's buildOperationalInputMap/
 *   resolveInputValueAsOf, or checks for review-card readiness via
 *   hasAnyBindingActivity.
 *
 * POST /api/jobs/[id]/operational-input-values
 *   Appends a new value for one (input_key, period_start, period_end) —
 *   NEVER an update. Calls the single atomic
 *   replace_operational_input_period_value RPC (lock -> revoke existing
 *   active row if present -> insert -> return), never a separate
 *   find-then-revoke-then-insert sequence of calls — see the migration's
 *   own header (Step 17C.1b, item A) for why: two concurrent submissions
 *   for the SAME (job, input_key, period) must never both succeed in
 *   creating an active row, and a crash between "revoked the old row" and
 *   "inserted the new one" must never be possible. This is the
 *   "Save draft"/"Mark final" workflow: both are the same RPC call,
 *   distinguished only by is_final.
 *   body: { input_key, period_start, period_end, value, currency?, is_final }
 *
 * Step 17C.1a, item 1/3 — see lib/operational-input-binding.ts's own
 * header for why this is manual-entry-only, not a live connector, and the
 * migration's own header for the full append/revoke rationale.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

// Verifies the job genuinely belongs to the CALLER's own org (never a
// client-supplied org_id) — the actual tenant-isolation boundary, per this
// codebase's own standing convention (RLS is not the enforcement boundary,
// requireOrg() plus this ownership check is). Shared by both handlers so
// GET and POST can never diverge on this check.
async function loadOwnedJob(jobId: string, orgId: string): Promise<{ id: string } | null> {
  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .maybeSingle()
  return job
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await loadOwnedJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const { data: rows, error } = await supabaseServer
    .from('operational_input_period_values')
    .select('id, input_key, period_start, period_end, value, currency, recorded_at, recorded_by, finalized_at, status, revoked_at')
    .eq('job_id', jobId)
    .order('period_start', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ values: rows ?? [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await loadOwnedJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const body = await req.json().catch(() => null) as {
    input_key?: string
    period_start?: string
    period_end?: string
    value?: number
    currency?: string | null
    is_final?: boolean
  } | null

  if (!body?.input_key || !body.period_start || !body.period_end || typeof body.value !== 'number') {
    return NextResponse.json({ error: 'input_key, period_start, period_end, and a numeric value are required' }, { status: 400 })
  }
  if (!Number.isFinite(body.value) || body.value < 0) {
    return NextResponse.json({ error: 'value must be a non-negative finite number' }, { status: 400 })
  }
  if (body.period_end < body.period_start) {
    return NextResponse.json({ error: 'period_end must not be before period_start' }, { status: 400 })
  }

  // Single atomic call — lock (job, input_key, period), revoke the
  // current active row if one exists, insert the new row, return it, all
  // inside one Postgres transaction. Never two separate service-role
  // calls (see this file's own header + the migration's item-A comment).
  // replace_operational_input_period_value returns a single composite row
  // (not setof) — Supabase/PostgREST hands that back as a plain object in
  // `data` directly, no .single() call needed or valid here.
  const { data, error } = await supabaseServer.rpc('replace_operational_input_period_value', {
    p_job_id: jobId,
    p_org_id: org.orgId,
    p_input_key: body.input_key,
    p_period_start: body.period_start,
    p_period_end: body.period_end,
    p_value: body.value,
    p_currency: body.currency ?? null,
    p_recorded_by: org.userEmail,
    p_is_final: body.is_final ?? false,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ value: data })
}
