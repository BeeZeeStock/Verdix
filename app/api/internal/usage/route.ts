/**
 * GET /api/internal/usage
 *
 * Verdix's own usage pull endpoint — registered against the 'sync' meter
 * (and any other platform meters) in the billing_meters registry.
 * Verdix admin registers this URL + INTERNAL_API_SECRET as the pull endpoint
 * for platform meters, following the exact same flow as a 3PP SaaS company.
 *
 * Query params:
 *   customer_id        — Stripe customer ID (cus_xxx) or Verdix org UUID
 *   period_start       — Unix timestamp (seconds) or ISO 8601 string
 *   period_end         — Unix timestamp (seconds) or ISO 8601 string
 *   billing_parameter  — meter_key to sum (e.g. "sync", "api_call")
 *
 * Response:
 *   { total_billable_units: number }
 *
 * Auth: Bearer token — must match INTERNAL_API_SECRET env var.
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

function parsePeriod(raw: string): string {
  // Accept Unix timestamp (seconds) or ISO 8601
  const n = Number(raw)
  if (!isNaN(n) && raw.trim().match(/^\d+$/)) {
    return new Date(n * 1000).toISOString()
  }
  return new Date(raw).toISOString()
}

async function resolveOrgId(customerId: string): Promise<string | null> {
  // If it looks like a Stripe customer ID, resolve to org_id
  if (customerId.startsWith('cus_')) {
    const { data } = await supabaseServer
      .from('org_subscriptions')
      .select('org_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    return data?.org_id ?? null
  }
  // Otherwise treat it as the org_id directly
  return customerId
}

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization') ?? ''
  const token      = authHeader.replace(/^Bearer\s+/i, '').trim()
  const secret     = process.env.INTERNAL_API_SECRET ?? ''

  if (!secret || !token || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Params ────────────────────────────────────────────────────────────────────
  const { searchParams } = req.nextUrl
  const customerId       = searchParams.get('customer_id') ?? ''
  const periodStartRaw   = searchParams.get('period_start') ?? ''
  const periodEndRaw     = searchParams.get('period_end') ?? ''
  const billingParameter = searchParams.get('billing_parameter') ?? 'sync'

  if (!customerId || !periodStartRaw || !periodEndRaw) {
    return NextResponse.json(
      { error: 'customer_id, period_start, and period_end are required' },
      { status: 400 },
    )
  }

  // ── Resolve org ───────────────────────────────────────────────────────────────
  const orgId = await resolveOrgId(customerId)
  if (!orgId) {
    return NextResponse.json(
      { error: `No org found for customer_id '${customerId}'` },
      { status: 404 },
    )
  }

  // ── Sum from usage_ledger ─────────────────────────────────────────────────────
  const periodStart = parsePeriod(periodStartRaw)
  const periodEnd   = parsePeriod(periodEndRaw)

  const { data: total, error } = await supabaseServer.rpc('sum_usage_for_period', {
    org_id_param:      orgId,
    meter_key_param:   billingParameter,
    period_start:      periodStart,
    period_end:        periodEnd,
    include_simulated: false,
  })

  if (error) {
    console.error('[internal/usage] sum_usage_for_period error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ total_billable_units: Number(total ?? 0) })
}
