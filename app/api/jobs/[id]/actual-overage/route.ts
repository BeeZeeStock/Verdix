import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

type OverageLineItem = { amount: number; description: string; currency: string }

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const { data: planned, error: plannedError } = await supabaseServer
    .from('planned_invoices')
    .select('id, period_start, period_end, currency, base_amount, overage_line_items, status')
    .eq('job_id', id)
    .eq('status', 'sent')
    .order('period_start', { ascending: true })

  if (plannedError) {
    return NextResponse.json({ error: plannedError.message }, { status: 500 })
  }

  if (!planned || planned.length === 0) {
    // No planned_invoices for this job — flag it loudly instead of silently
    // serving stale data from the legacy computed_invoices table, so a job
    // that isn't on the current model surfaces rather than gets masked.
    console.warn(`[actual-overage] no planned_invoices rows for job ${id} — job may predate the planned_invoices model`)
    return NextResponse.json([])
  }

  const result = planned.map(row => {
    const overageItems = (row.overage_line_items ?? []) as OverageLineItem[]
    return {
      id:           row.id,
      period_start: row.period_start,
      period_end:   row.period_end,
      currency:     row.currency,
      total_amount: Number(row.base_amount) + overageItems.reduce((s, i) => s + i.amount, 0),
      line_items:   overageItems.map(i => ({
        type:        'overage',
        amount:      i.amount,
        description: i.description,
        currency:    i.currency,
      })),
    }
  })
  return NextResponse.json(result)
}
