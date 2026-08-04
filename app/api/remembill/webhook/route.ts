/**
 * POST /api/remembill/webhook
 *
 * Receives payment and invoice status events from Remembill.
 * When a payment is confirmed, marks the corresponding planned_invoice row
 * as 'paid' and records the billing sync event.
 *
 * Secured by a shared secret: Remembill should send
 *   X-Remembill-Secret: <REMEMBILL_WEBHOOK_SECRET>
 * in all webhook requests. Set REMEMBILL_WEBHOOK_SECRET in Vercel env vars.
 *
 * Register this URL in your Remembill account under Settings → Webhooks:
 *   https://yourdomain.com/api/remembill/webhook
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// Known Remembill event types (extend as their API evolves)
type RememhillEvent = {
  event:   string   // e.g. 'invoice.paid' | 'invoice.sent' | 'invoice.overdue'
  invoice: {
    id:          string
    status:      string   // DRAFT | QUEUED | GENERATING | SENT | PAID | OVERDUE
    customer_id: string
    amount?:     number   // total amount in minor units
    currency?:   string
    paid_at?:    string   // ISO date when payment was confirmed
  }
}

export async function POST(req: NextRequest) {
  // ── Verify shared secret ────────────────────────────────────────────────────
  const secret = req.headers.get('x-remembill-secret')
  if (process.env.REMEMBILL_WEBHOOK_SECRET && secret !== process.env.REMEMBILL_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: RememhillEvent
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { event, invoice } = body
  if (!event || !invoice?.id) {
    return NextResponse.json({ error: 'Missing event or invoice' }, { status: 400 })
  }

  console.log(`[remembill/webhook] event=${event} invoice=${invoice.id} status=${invoice.status}`)

  // ── Find the matching planned_invoice row ────────────────────────────────────
  // The Remembill invoice ID is stored in stripe_invoice_id (generic external ID column)
  const { data: row } = await supabaseServer
    .from('planned_invoices')
    .select('id, job_id, org_id, status')
    .eq('stripe_invoice_id', invoice.id)
    .maybeSingle()

  if (!row) {
    // Could be an invoice created outside Verdix — log and acknowledge
    console.warn(`[remembill/webhook] no planned_invoice found for Remembill invoice ${invoice.id}`)
    return NextResponse.json({ ok: true, matched: false })
  }

  // ── Handle event ─────────────────────────────────────────────────────────────
  if (event === 'invoice.paid' || invoice.status === 'PAID') {
    await supabaseServer
      .from('planned_invoices')
      .update({
        status:    'paid',
        paid_at:   invoice.paid_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)

    // Record a billing sync event so the dashboard reflects the payment
    if (row.job_id && row.org_id) {
      const { recordSync } = await import('@/lib/billing')
      await recordSync(row.org_id, row.job_id, 'billing_audit').catch(err =>
        console.error('[remembill/webhook] recordSync failed', err)
      )
    }
  } else if (event === 'invoice.sent' || invoice.status === 'SENT') {
    // Invoice was delivered — update URL if we now have a confirmed one
    await supabaseServer
      .from('planned_invoices')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'processing')
  } else if (event === 'invoice.overdue') {
    await supabaseServer
      .from('planned_invoices')
      .update({ status: 'failed', error_message: 'Invoice overdue', updated_at: new Date().toISOString() })
      .eq('id', row.id)
  }

  return NextResponse.json({ ok: true, matched: true, event })
}
