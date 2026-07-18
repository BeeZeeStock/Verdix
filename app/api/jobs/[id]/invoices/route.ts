import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data, error } = await supabaseServer
    .from('computed_invoices')
    .select(
      'id, external_invoice_id, external_subscription_id, connector, ' +
      'period_start, period_end, line_items, total_amount, currency, ' +
      'status, paid_at, validation_result, external_invoice_pdf_url, created_at',
    )
    .eq('job_id', id)
    .not('external_subscription_id', 'is', null)   // subscription-period invoices only
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data ?? [])
}
