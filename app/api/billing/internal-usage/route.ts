/**
 * GET /api/billing/internal-usage
 *
 * Internal testing endpoint that satisfies the On-Demand Pull Model interface.
 * Configure pull_config.client_usage_url to point here so the Verdix admin can
 * dogfood the full pull → invoice loop without a real 3PP client.
 *
 * Reads usage_counters from org_subscriptions. The metric_type query param
 * selects which counter to return (default: "sync"). If you need a combined
 * total across all metrics, pass metric_type=__all__ and the endpoint will sum
 * all counter values.
 *
 * Query params (standard pull-model interface):
 *   customer_id   — Stripe cus_xxx of the Verdix subscriber
 *   period_start  — Unix timestamp (accepted for interface compat, not filtered)
 *   period_end    — Unix timestamp (accepted for interface compat, not filtered)
 *   metric_type   — counter key to return (default: "sync", or "__all__" to sum)
 *
 * Authentication:
 *   Authorization: Bearer <INTERNAL_TESTING_SECRET>
 *
 * Response: { total_billable_units: number }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? ''
  const secret     = process.env.INTERNAL_TESTING_SECRET

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Parse params ──────────────────────────────────────────────────────────────
  const { searchParams } = new URL(req.url)
  const customerId  = searchParams.get('customer_id')
  const periodStart = searchParams.get('period_start')
  const periodEnd   = searchParams.get('period_end')
  const metricType  = searchParams.get('metric_type') ?? 'sync'

  if (!customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }

  // ── Look up org_subscriptions by Stripe customer ID ───────────────────────────
  const { data, error } = await supabaseServer
    .from('org_subscriptions')
    .select('usage_counters, org_id, stripe_subscription_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (error) {
    console.error('[internal-usage] org_subscriptions lookup failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!data) {
    console.info(`[internal-usage] no org_subscriptions row for customer ${customerId}`)
    return NextResponse.json({ total_billable_units: 0 })
  }

  const counters = (data.usage_counters ?? {}) as Record<string, number>

  const totalBillableUnits = metricType === '__all__'
    ? Object.values(counters).reduce((sum, v) => sum + Number(v ?? 0), 0)
    : Number(counters[metricType] ?? 0)

  console.info('[internal-usage] hit', {
    customer_id:          customerId,
    org_id:               data.org_id,
    metric_type:          metricType,
    counters,
    period_start:         periodStart,
    period_end:           periodEnd,
    total_billable_units: totalBillableUnits,
  })

  return NextResponse.json({ total_billable_units: totalBillableUnits })
}
