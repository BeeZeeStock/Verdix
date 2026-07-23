import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { runBillingForOrg } from '@/lib/billing-engine'

// GET /api/admin/billing-cron
// Called daily by Vercel Cron or any scheduler. Protected by x-cron-secret header.
// Finds all orgs whose billing period has ended and runs billing for each.
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()

  const { data: dueSubs } = await supabaseServer
    .from('org_subscriptions')
    .select('org_id, plan_id, current_period_end, stripe_customer_id')
    .lte('current_period_end', now)
    .eq('status', 'active')
    .neq('plan_id', 'trial')

  if (!dueSubs?.length) {
    return NextResponse.json({ processed: 0, results: [] })
  }

  const results: { org_id: string; ok: boolean; invoice_id?: string | null; total_eur?: number; error?: string }[] = []

  for (const sub of dueSubs) {
    try {
      const result = await runBillingForOrg(sub.org_id)
      results.push({ org_id: sub.org_id, ok: true, invoice_id: result.invoice_id, total_eur: result.total_eur })
    } catch (err) {
      console.error(`[billing-cron] failed for org ${sub.org_id}:`, err)
      results.push({ org_id: sub.org_id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return NextResponse.json({ processed: results.length, results })
}
