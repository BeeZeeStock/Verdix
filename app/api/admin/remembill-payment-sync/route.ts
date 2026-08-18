/**
 * GET /api/admin/remembill-payment-sync
 *
 * Daily cron: polls Remembill for the status of every 'sent' planned_invoice
 * across all orgs and marks paid ones accordingly.
 *
 * Protected by x-cron-secret header (same CRON_SECRET env var as other crons).
 *
 * Add to vercel.json:
 *   { "path": "/api/admin/remembill-payment-sync", "schedule": "0 8 * * *" }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { REMEMBILL_BASE, remembillHeaders } from '@/lib/billing-writer'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Find all sent Remembill invoices across all orgs
  const { data: rows, error } = await supabaseServer
    .from('planned_invoices')
    .select('id, job_id, org_id, stripe_invoice_id, status')
    .eq('status', 'sent')
    .not('stripe_invoice_id', 'is', null)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[remembill-payment-sync] fetch failed', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!rows?.length) {
    return NextResponse.json({ checked: 0, paid: 0 })
  }

  // Filter to Remembill jobs only (billing_platform column lives on jobs table)
  const jobIds = [...new Set(rows.map(r => r.job_id))]
  const { data: jobs } = await supabaseServer
    .from('jobs')
    .select('id, org_id, billing_platform')
    .in('id', jobIds)
    .eq('billing_platform', 'remembill')

  const remembillJobIds = new Set((jobs ?? []).map(j => j.id))
  const remembillRows   = rows.filter(r => remembillJobIds.has(r.job_id))

  if (!remembillRows.length) {
    return NextResponse.json({ checked: 0, paid: 0 })
  }

  // Cache API keys per org to avoid repeated lookups
  const apiKeyCache = new Map<string, string>()
  async function getApiKey(orgId: string): Promise<string | null> {
    if (apiKeyCache.has(orgId)) return apiKeyCache.get(orgId)!
    const { data: integration } = await supabaseServer
      .from('org_integrations')
      .select('config')
      .eq('org_id', orgId)
      .eq('connector_name', 'remembill')
      .eq('is_active', true)
      .maybeSingle()
    const key = (integration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY ?? null
    if (key) apiKeyCache.set(orgId, key)
    return key
  }

  let checked = 0
  let paid    = 0

  await Promise.all(remembillRows.map(async row => {
    try {
      const apiKey = await getApiKey(row.org_id)
      if (!apiKey) return

      const res = await fetch(`${REMEMBILL_BASE}/invoices/${row.stripe_invoice_id}`, {
        headers: remembillHeaders(apiKey),
      })
      if (!res.ok) return

      checked++
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
        console.log(`[remembill-payment-sync] marked paid: planned_invoice ${row.id}`)
      }
    } catch (err) {
      console.error(`[remembill-payment-sync] failed for invoice ${row.stripe_invoice_id}`, err)
    }
  }))

  console.log(`[remembill-payment-sync] checked ${checked}, marked paid ${paid}`)
  return NextResponse.json({ checked, paid })
}
