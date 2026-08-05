/**
 * POST /api/jobs/[id]/sync-payment-status
 *
 * Polls Remembill for the current status of all 'sent' planned_invoices for
 * this job and marks any that Remembill reports as PAID.
 * Used by the manual "Refresh payment status" button in the billing UI.
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { requireOrg } from '@/lib/org'
import { REMEMBILL_BASE, remembillHeaders } from '@/lib/billing-writer'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let org
  try { org = await requireOrg() } catch (res) { return res as Response }

  const { id: jobId } = await params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('org_id, billing_platform')
    .eq('id', jobId)
    .eq('org_id', org.orgId)
    .maybeSingle()

  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  if (job.billing_platform !== 'remembill') {
    return NextResponse.json({ error: 'Job is not on Remembill' }, { status: 400 })
  }

  const { data: rbIntegration } = await supabaseServer
    .from('org_integrations')
    .select('config')
    .eq('org_id', org.orgId)
    .eq('connector_name', 'remembill')
    .eq('is_active', true)
    .maybeSingle()

  const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
  if (!rbKey) return NextResponse.json({ error: 'No Remembill API key configured' }, { status: 400 })

  const rbH = remembillHeaders(rbKey)

  // Fetch all sent planned_invoices for this job that have a Remembill invoice ID
  const { data: rows } = await supabaseServer
    .from('planned_invoices')
    .select('id, stripe_invoice_id, status')
    .eq('job_id', jobId)
    .eq('org_id', org.orgId)
    .eq('status', 'sent')
    .not('stripe_invoice_id', 'is', null)

  if (!rows?.length) {
    return NextResponse.json({ checked: 0, paid: 0 })
  }

  let paid = 0

  await Promise.all(rows.map(async row => {
    try {
      const res = await fetch(`${REMEMBILL_BASE}/invoices/${row.stripe_invoice_id}`, { headers: rbH })
      if (!res.ok) return

      const inv = await res.json() as { id: string; status: string; paid_at?: string }

      if (inv.status === 'PAID') {
        await supabaseServer
          .from('planned_invoices')
          .update({
            status:     'paid',
            paid_at:    inv.paid_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
        paid++
      }
    } catch (err) {
      console.error(`[sync-payment-status] failed for invoice ${row.stripe_invoice_id}`, err)
    }
  }))

  return NextResponse.json({ checked: rows.length, paid })
}
