/**
 * GET  /api/jobs/[id]/usage-values
 *   Lists every persisted MANUAL usage-period value row for this job.
 *   Step 17D, item 13 — deliberately a separate model from
 *   operational_input_period_values (app/api/jobs/[id]/operational-input-
 *   values/route.ts) — a usage fact (issued_payment_request_count,
 *   completed_payment_count, ...) is NOT an operational KPI (paid_invoice_
 *   value, milestone_approved, ...); the review UX keeps "Enter usage
 *   manually" and "Enter [KPI] manually" as separate actions (item 14),
 *   and this route/table is what backs the former only.
 *
 * POST /api/jobs/[id]/usage-values
 *   Appends a new quantity for one (semantic_input_key, period_start,
 *   period_end) — NEVER an update, same append/revoke/finality discipline
 *   as operational-input-values (replace_usage_period_value RPC: lock ->
 *   revoke existing active row if present -> insert -> return).
 *   body: { semantic_input_key, period_start, period_end, quantity, is_final }
 *
 * This is the manual fallback lib/usage-quantity-resolver.ts's
 * resolveUsageQuantityForPeriod() reads when no confirmed
 * contract_meter_mappings row exists for the requested semantic fact —
 * never the mode='test'/test_usage_value simulation aid (that stays a
 * per-meter billing-test simulation input, not production manual usage —
 * see the architecture audit).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { resolveRecognizedOperationalInputKey } from '@/lib/operational-input-canonicalization'

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
  // Step 17D, item 6 — entering/viewing manual usage is a "confirm" class
  // action (no endpoint/credential surface), same discipline as
  // meter-mappings — member-level access is sufficient.
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await loadOwnedJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const { data: rows, error } = await supabaseServer
    .from('usage_period_values')
    .select('id, semantic_input_key, period_start, period_end, quantity, recorded_at, recorded_by, finalized_at, status, revoked_at')
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
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await loadOwnedJob(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const body = await req.json().catch(() => null) as {
    semantic_input_key?: string
    period_start?: string
    period_end?: string
    quantity?: number
    is_final?: boolean
  } | null

  if (!body?.semantic_input_key || !body.period_start || !body.period_end || typeof body.quantity !== 'number') {
    return NextResponse.json({ error: 'semantic_input_key, period_start, period_end, and a numeric quantity are required' }, { status: 400 })
  }
  if (!Number.isFinite(body.quantity) || body.quantity < 0) {
    return NextResponse.json({ error: 'quantity must be a non-negative finite number' }, { status: 400 })
  }
  if (body.period_end < body.period_start) {
    return NextResponse.json({ error: 'period_end must not be before period_start' }, { status: 400 })
  }

  const canonicalKey = resolveRecognizedOperationalInputKey(body.semantic_input_key)
  if (!canonicalKey) {
    return NextResponse.json({ error: `'${body.semantic_input_key}' is not a recognized semantic input key` }, { status: 400 })
  }

  const { data, error } = await supabaseServer.rpc('replace_usage_period_value', {
    p_job_id: jobId,
    p_org_id: org.orgId,
    p_semantic_input_key: canonicalKey,
    p_period_start: body.period_start,
    p_period_end: body.period_end,
    p_quantity: body.quantity,
    p_recorded_by: org.userEmail,
    p_is_final: body.is_final ?? false,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ value: data })
}
