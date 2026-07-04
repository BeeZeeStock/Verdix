import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json()

  const updates: Record<string, unknown> = {}
  if (body.escalators    !== undefined) updates.escalators    = body.escalators
  if (body.discounts     !== undefined) updates.discounts     = body.discounts
  if (body.ramp_schedule !== undefined) updates.ramp_schedule = body.ramp_schedule
  if (body.year_pricing  !== undefined) updates.year_pricing  = body.year_pricing

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
