/**
 * GET  /api/jobs/[id]/vat-config
 *   Returns the standing VAT default for this job's billing customer.
 *
 * POST /api/jobs/[id]/vat-config
 *   Sets it. body: { mode: 'rate' | 'zero_rated', ratePct?: number }
 *   ('not_configured' is never set explicitly — it's the absence of a row.)
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { getCustomerVatConfig, setCustomerVatConfig } from '@/lib/vat-service'
import type { VatMode } from '@/lib/vat'

async function getBillingCustomerId(jobId: string, orgId: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from('jobs')
    .select('billing_customer_id')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .single()
  return (data?.billing_customer_id as string | null) ?? null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg('member') } catch (res) { return res as Response }

  const { id: jobId } = await params
  const customerId = await getBillingCustomerId(jobId, org.orgId)
  if (!customerId) return NextResponse.json({ configured: false, treatment: null, reason: 'no_billing_customer' })

  const treatment = await getCustomerVatConfig(org.orgId, customerId)
  return NextResponse.json({ configured: !!treatment, treatment })
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

  const customerId = await getBillingCustomerId(jobId, org.orgId)
  if (!customerId) return NextResponse.json({ error: 'This job has no billing customer yet — approve the contract first.' }, { status: 400 })

  const { error } = await setCustomerVatConfig(
    org.orgId, customerId,
    { mode: body.mode, ratePct: body.mode === 'rate' ? body.ratePct! : null },
    org.userEmail,
  )
  if (error) return NextResponse.json({ error }, { status: 500 })

  return NextResponse.json({ ok: true })
}
