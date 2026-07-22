import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin'
import { supabaseServer } from '@/lib/supabase'
import { computeMetricOverage } from '@/lib/tariff'
import type { OverageTier } from '@/lib/types'

type ConfigTier = { from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }
function toOverageTiers(raw: ConfigTier[], meterKey: string): OverageTier[] {
  return raw.map((t, i) => ({
    tier_label:    `Tier ${i + 1}`,
    from_unit:     t.from_unit ?? null,
    to_unit:       t.to_unit   ?? null,
    rate_per_unit: t.rate_per_unit ?? 0,
    unit_type:     meterKey,
  }))
}

// Spread N events across totalDays days using the chosen distribution pattern.
function generateTimestamps(
  start: Date,
  totalDays: number,
  totalEvents: number,
  distribution: string,
): Date[] {
  const dayMs   = 86_400_000
  const counts  = new Array<number>(totalDays).fill(0)

  if (distribution === 'even') {
    const base      = Math.floor(totalEvents / totalDays)
    const remainder = totalEvents - base * totalDays
    for (let i = 0; i < totalDays; i++) counts[i] = base + (i < remainder ? 1 : 0)
  } else if (distribution === 'front') {
    // Linear decay: earlier days get more events
    const totalWeight = (totalDays * (totalDays + 1)) / 2
    let placed = 0
    for (let i = 0; i < totalDays; i++) {
      const weight = totalDays - i
      const n = i < totalDays - 1
        ? Math.round((weight / totalWeight) * totalEvents)
        : totalEvents - placed
      counts[i] = Math.max(0, n)
      placed += counts[i]
    }
  } else {
    // Random — each event lands on a random day
    for (let e = 0; e < totalEvents; e++) {
      counts[Math.floor(Math.random() * totalDays)]++
    }
  }

  const timestamps: Date[] = []
  for (let d = 0; d < totalDays; d++) {
    const dayStart = new Date(start.getTime() + d * dayMs)
    for (let e = 0; e < counts[d]; e++) {
      const ts = new Date(dayStart)
      ts.setHours(
        Math.floor(Math.random() * 24),
        Math.floor(Math.random() * 60),
        Math.floor(Math.random() * 60),
        0,
      )
      timestamps.push(ts)
    }
  }
  return timestamps
}

// GET /api/admin/usage-test
export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const [orgsRes, subsRes, jobsRes] = await Promise.all([
    supabaseServer.from('organizations').select('id, name').order('name'),
    supabaseServer.from('org_subscriptions').select('org_id, plan_id, usage_counters, stripe_customer_id, stripe_subscription_id'),
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
    action:        'seed' | 'reset' | 'preview' | 'seed_period' | 'simulate_billing' | 'clear_simulated'
    org_id?:       string
    metric_type?:  string
    meter_key?:    string
    amount?:       number
    period_start?: string
    period_end?:   string
    total_events?: number
    distribution?: 'even' | 'random' | 'front'
  }

  const { action, org_id } = body
  if (!org_id) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  // ── Seed test events (ledger only, marked simulated — never inflates real counter) ──
  if (action === 'seed') {
    const meterKey = (body.metric_type ?? body.meter_key ?? 'sync').trim()
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

  // ── Seed simulated events across a date range ─────────────────────────────────
  if (action === 'seed_period') {
    const meterKey    = (body.meter_key ?? body.metric_type ?? 'sync').trim()
    const periodStart = body.period_start
    const periodEnd   = body.period_end
    if (!periodStart || !periodEnd) {
      return NextResponse.json({ error: 'period_start and period_end required' }, { status: 400 })
    }

    const start      = new Date(periodStart)
    const end        = new Date(periodEnd)
    const dayMs      = 86_400_000
    const totalDays  = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / dayMs))
    const totalEvents = Math.min(5000, Math.max(1, Number(body.total_events ?? 100)))
    const distribution = body.distribution ?? 'even'

    const timestamps = generateTimestamps(start, totalDays, totalEvents, distribution)

    // Insert in batches of 200 directly into usage_ledger with is_simulated=true
    const BATCH = 200
    for (let i = 0; i < timestamps.length; i += BATCH) {
      const rows = timestamps.slice(i, i + BATCH).map(ts => ({
        org_id:       org_id,
        meter_key:    meterKey,
        quantity:     1,
        occurred_at:  new Date().toISOString(),
        is_simulated: true,
        simulated_at: ts.toISOString(),
      }))
      const { error } = await supabaseServer.from('usage_ledger').insert(rows)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Build day-bucket summary for the bar chart
    const byDay: Record<string, number> = {}
    timestamps.forEach(ts => {
      const day = ts.toISOString().split('T')[0]
      byDay[day] = (byDay[day] ?? 0) + 1
    })

    return NextResponse.json({ ok: true, by_day: byDay, total: timestamps.length })
  }

  // ── Simulate a billing run for a period (ledger-based, config-aware) ──────────
  if (action === 'simulate_billing') {
    const periodStart = body.period_start
    const periodEnd   = body.period_end
    if (!periodStart || !periodEnd) {
      return NextResponse.json({ error: 'period_start and period_end required' }, { status: 400 })
    }

    type OrgBillingConfig = {
      meter_key:      string
      included_units: number
      overage_tiers:  ConfigTier[]
      billing_cycle:  string
      source:         string
    }
    type SimRow = {
      meter_key:   string
      count:       number
      included:    number
      overage:     number
      overage_eur: number
      source:      string
      tiers_count: number
    }

    const { data: configs } = await supabaseServer
      .from('org_billing_config')
      .select('*')
      .eq('org_id', org_id)
      .eq('active', true)

    const breakdown: SimRow[] = []

    if (configs && configs.length > 0) {
      for (const cfg of (configs as OrgBillingConfig[])) {
        const { data: usageSum } = await supabaseServer.rpc('sum_usage_for_period', {
          org_id_param:      org_id,
          meter_key_param:   cfg.meter_key,
          period_start:      periodStart,
          period_end:        periodEnd,
          include_simulated: true,
        })

        const count     = Number(usageSum ?? 0)
        const tiers     = toOverageTiers(cfg.overage_tiers ?? [], cfg.meter_key)
        const included  = cfg.included_units ?? 0
        const overageEur = tiers.length > 0
          ? computeMetricOverage(count, tiers, included)
          : 0

        breakdown.push({
          meter_key:   cfg.meter_key,
          count,
          included,
          overage:     Math.max(0, count - included),
          overage_eur: Math.round(overageEur * 100) / 100,
          source:      cfg.source,
          tiers_count: tiers.length,
        })
      }
    } else {
      // Fallback: plan pricing + ledger sum for 'sync'
      const { data: sub } = await supabaseServer
        .from('org_subscriptions')
        .select('plan_id')
        .eq('org_id', org_id)
        .maybeSingle()

      const planId = sub?.plan_id ?? 'trial'
      const [syncSumRes, planRes] = await Promise.all([
        supabaseServer.rpc('sum_usage_for_period', {
          org_id_param:      org_id,
          meter_key_param:   'sync',
          period_start:      periodStart,
          period_end:        periodEnd,
          include_simulated: true,
        }),
        supabaseServer
          .from('verdix_plans')
          .select('sync_limit, overage_price_eur')
          .eq('id', planId)
          .maybeSingle(),
      ])

      const count        = Number(syncSumRes.data ?? 0)
      const included     = planRes.data?.sync_limit ?? 0
      const pricePerUnit = planRes.data?.overage_price_eur ?? 0
      const overage      = Math.max(0, count - included)
      const overageEur   = Math.round(pricePerUnit * overage * 100) / 100

      if (count > 0) {
        breakdown.push({
          meter_key: 'sync', count, included, overage,
          overage_eur: overageEur, source: 'plan', tiers_count: 0,
        })
      }
    }

    const totalEur = breakdown.reduce((s, r) => s + r.overage_eur, 0)
    return NextResponse.json({
      breakdown,
      total_eur: Math.round(totalEur * 100) / 100,
    })
  }

  // ── Clear simulated ledger entries for this org ───────────────────────────────
  if (action === 'clear_simulated') {
    const { data, error } = await supabaseServer
      .from('usage_ledger')
      .delete()
      .eq('org_id', org_id)
      .eq('is_simulated', true)
      .select('id')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, deleted: data?.length ?? 0 })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
