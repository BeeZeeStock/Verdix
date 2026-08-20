/**
 * GET  /api/jobs/[id]/vat-config
 *   Returns the VAT treatment for this job — from customer_vat_config once
 *   a billing customer exists, or from the job's own pending_vat_* staging
 *   fields before approval (see jobs.pending_vat_mode/pending_vat_rate_pct).
 *
 * POST /api/jobs/[id]/vat-config
 *   Sets it. body: { mode: 'rate' | 'zero_rated', ratePct?: number }
 *   ('not_configured' is never set explicitly — it's the absence of a value.)
 *   Writes to customer_vat_config once a billing customer exists, otherwise
 *   to the job's pending_vat_* staging fields — approval promotes a pending
 *   value into customer_vat_config once the real customer is created (see
 *   app/api/jobs/[id]/approve/route.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getCustomerVatConfig, setCustomerVatConfig } from '@/lib/vat-service'
import type { VatMode, VatTreatment } from '@/lib/vat'

async function getJobVatContext(jobId: string, orgId: string) {
  const { data } = await supabaseServer
    .from('jobs')
    .select('billing_customer_id, pending_vat_mode, pending_vat_rate_pct')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .single()
  return data as { billing_customer_id: string | null; pending_vat_mode: VatMode | null; pending_vat_rate_pct: number | null } | null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const job = await getJobVatContext(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  if (job.billing_customer_id) {
    const treatment = await getCustomerVatConfig(org.orgId, job.billing_customer_id)
    return NextResponse.json({ configured: !!treatment, treatment, source: 'customer_vat_config' })
  }

  const pending: VatTreatment | null = job.pending_vat_mode && job.pending_vat_mode !== 'not_configured'
    ? { mode: job.pending_vat_mode, ratePct: job.pending_vat_rate_pct }
    : null
  return NextResponse.json({ configured: !!pending, treatment: pending, source: 'pending_job_vat' })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const body = await req.json() as { mode: VatMode; ratePct?: number }
  if (body.mode !== 'rate' && body.mode !== 'zero_rated') {
    return NextResponse.json({ error: "mode must be 'rate' or 'zero_rated'" }, { status: 400 })
  }
  if (body.mode === 'rate' && (typeof body.ratePct !== 'number' || body.ratePct < 0 || body.ratePct > 100)) {
    return NextResponse.json({ error: 'ratePct must be a number between 0 and 100 when mode is rate' }, { status: 400 })
  }

  const job = await getJobVatContext(jobId, org.orgId)
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  if (job.billing_customer_id) {
    const { error } = await setCustomerVatConfig(
      org.orgId, job.billing_customer_id,
      { mode: body.mode, ratePct: body.mode === 'rate' ? body.ratePct! : null },
      org.userEmail,
    )
    if (error) return NextResponse.json({ error }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { error } = await supabaseServer
    .from('jobs')
    .update({ pending_vat_mode: body.mode, pending_vat_rate_pct: body.mode === 'rate' ? body.ratePct : null })
    .eq('id', jobId)
    .eq('org_id', org.orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
