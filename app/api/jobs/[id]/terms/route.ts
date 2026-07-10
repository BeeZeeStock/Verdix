import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json()

  const SCALAR_FIELDS = [
    'contract_start_date', 'contract_end_date', 'contract_term_months',
    'customer_name', 'billing_contact', 'payment_terms_text', 'payment_terms_days',
    'base_monthly_fee', 'base_annual_fee', 'billing_frequency',
  ]
  const JSON_FIELDS = ['escalators', 'discounts', 'ramp_schedule', 'year_pricing']

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
