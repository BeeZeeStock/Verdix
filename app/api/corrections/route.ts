import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireAdmin } from '@/lib/admin'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    jobId,
    fieldName,
    extractedValue,
    correctedValue,
    correctionReason,
    customerName,
    applyToFuture = true,
  } = body

  if (!jobId || !fieldName || !correctedValue) {
    return NextResponse.json({ error: 'jobId, fieldName, and correctedValue are required' }, { status: 400 })
  }

  const { data, error } = await supabaseServer
    .from('extraction_corrections')
    .insert({
      job_id: jobId,
      field_name: fieldName,
      extracted_value: extractedValue ?? null,
      corrected_value: correctedValue,
      correction_reason: correctionReason ?? null,
      customer_name: customerName ?? null,
      apply_to_future: applyToFuture,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, correctionId: data.id }, { status: 201 })
}

export async function GET(req: NextRequest) {
  // extraction_corrections has no org_id column — it's a cross-org, platform-
  // wide learning log (job_id/customer_name only), so viewing it is a Verdix-
  // staff concern, not something any customer org member should see.
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const url = new URL(req.url)
  const customer = url.searchParams.get('customer')

  let query = supabaseServer
    .from('extraction_corrections')
    .select('id, field_name, extracted_value, corrected_value, correction_reason, customer_name, apply_to_future, created_at')
    .eq('apply_to_future', true)
    .order('created_at', { ascending: false })
    .limit(200)

  if (customer) {
    query = supabaseServer
      .from('extraction_corrections')
      .select('id, field_name, extracted_value, corrected_value, correction_reason, customer_name, apply_to_future, created_at')
      .eq('apply_to_future', true)
      .or(`customer_name.eq.${customer},customer_name.is.null`)
      .order('created_at', { ascending: false })
      .limit(200)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
