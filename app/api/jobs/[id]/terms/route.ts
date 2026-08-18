import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let org
  try { org = await requireOrg('admin') } catch (res) { return res as Response }

  const { id } = await params
  const body = await req.json()

  const { data: ownedJob } = await supabaseServer
    .from('jobs')
    .select('id')
    .eq('id', id)
    .eq('org_id', org.orgId)
    .maybeSingle()
  if (!ownedJob) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  const SCALAR_FIELDS = [
    'contract_id', 'crm_id',
    'contract_start_date', 'contract_end_date', 'contract_term_months',
    'customer_name', 'customer_address', 'customer_email', 'customer_org_number', 'billing_contact',
    'payment_terms_text', 'payment_terms_days',
    'base_monthly_fee', 'base_annual_fee', 'billing_frequency',
    'auto_renews', 'renewal_notice_days',
    'number_format', 'currency',
  ]
  const JSON_FIELDS = ['escalators', 'discounts', 'ramp_schedule', 'year_pricing', 'overage_tiers', 'additional_recurring_fees']

  const updates: Record<string, unknown> = {}
  for (const f of JSON_FIELDS)   if (body[f] !== undefined) updates[f] = body[f]
  for (const f of SCALAR_FIELDS) if (body[f] !== undefined) updates[f] = body[f]

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { error } = await supabaseServer
    .from('contract_terms')
    .update(updates)
    .eq('job_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
