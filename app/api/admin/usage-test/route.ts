import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'

// GET /api/admin/usage-test
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [orgsRes, subsRes, jobsRes] = await Promise.all([
    supabaseServer.from('organizations').select('id, name').order('name'),
    supabaseServer.from('org_subscriptions').select('org_id, plan_id, usage_counters, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end'),
    supabaseServer.from('jobs').select('id, org_id, created_at').order('created_at', { ascending: false }).limit(50),
  ])

  const orgMap = new Map((orgsRes.data ?? []).map((o: { id: string; name: string }) => [o.id, o.name]))
  const subMap = new Map((subsRes.data ?? []).map((s: Record<string, unknown>) => [s.org_id as string, s]))

  const orgs = (orgsRes.data ?? []).map((o: { id: string; name: string }) => ({
    org_id: o.id,
    org_name: o.name,
    ...((subMap.get(o.id) ?? { plan_id: 'trial', usage_counters: {}, stripe_customer_id: null, stripe_subscription_id: null }) as object),
  }))

  const jobs = (jobsRes.data ?? []).map((j: Record<string, unknown>) => ({
    id:         j.id,
    org_id:     j.org_id,
    org_name:   orgMap.get(j.org_id as string) ?? j.org_id,
    created_at: j.created_at,
  }))

  return NextResponse.json({ orgs, jobs })
}

// POST /api/admin/usage-test
export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const body = await req.json() as {
    action:        'seed' | 'reset' | 'preview'
    org_id?:       string
    metric_type?:  string
    amount?:       number
  }

  const { action, org_id } = body
  if (!org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  // ── Seed test events (ledger only, marked simulated — never inflates real counter) ──
  if (action === 'seed') {
    const meterKey = (body.metric_type ?? 'sync').trim()
    const amount   = Math.max(1, Number(body.amount ?? 1))
    const rows = Array.from({ length: amount }, () => ({
      org_id:       org_id,
      meter_key:    meterKey,
      quantity:     1,
      occurred_at:  new Date().toISOString(),
      is_simulated: true,
      simulated_at: new Date().toISOString(),
    }))
    const { error } = await supabaseServer.from('usage_ledger').insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // ── Reset counter ─────────────────────────────────────────────────────────────
  if (action === 'reset') {
    const metricType = body.metric_type?.trim()

    if (metricType) {
      const { data: sub } = await supabaseServer
        .from('org_subscriptions')
        .select('usage_counters')
        .eq('org_id', org_id)
        .maybeSingle()
      const current = Number(((sub?.usage_counters ?? {}) as Record<string, number>)[metricType] ?? 0)
      if (current > 0) {
        const { error } = await supabaseServer.rpc('deduct_usage_counter', {
          org_id_param: org_id,
          metric_type:  metricType,
          amount:       current,
        })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    } else {
      const { error } = await supabaseServer
        .from('org_subscriptions')
        .update({ usage_counters: {} })
        .eq('org_id', org_id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  // ── Preview billing (current counters, plan-based) ────────────────────────────
  if (action === 'preview') {
    const { data: sub } = await supabaseServer
      .from('org_subscriptions')
      .select('usage_counters, plan_id')
      .eq('org_id', org_id)
      .maybeSingle()

    if (!sub) return NextResponse.json({ breakdown: [], total_eur: 0 })

    const counters = (sub.usage_counters ?? {}) as Record<string, number>
    const { data: plan } = await supabaseServer
      .from('verdix_plans')
      .select('sync_limit, overage_price_eur, metric_config')
      .eq('id', sub.plan_id)
      .maybeSingle()

    type MetricCfg = { included?: number; overage_price_eur?: number }
    const metricConfig = ((plan?.metric_config ?? {}) as Record<string, MetricCfg>)

    const breakdown = Object.entries(counters).map(([metricType, rawCount]) => {
      const count = Number(rawCount ?? 0)
      let included: number | null
      let pricePerUnit: number

      if (metricType === 'sync') {
        included     = plan?.sync_limit ?? null
        pricePerUnit = plan?.overage_price_eur ?? 0
      } else {
        const cfg    = metricConfig[metricType] ?? {}
        included     = cfg.included ?? 0
        pricePerUnit = cfg.overage_price_eur ?? 0
      }

      const overage   = included != null ? Math.max(0, count - included) : count
      const total_eur = Math.round(pricePerUnit * overage * 100) / 100
      return { metric_type: metricType, count, included, overage, price_per_unit: pricePerUnit, total_eur }
    })

    const total_eur = breakdown.reduce((sum, r) => sum + r.total_eur, 0)
    return NextResponse.json({ breakdown, total_eur: Math.round(total_eur * 100) / 100, plan_id: sub.plan_id })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
