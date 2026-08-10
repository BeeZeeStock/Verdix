// Pulls usage and computes overage for a billing period — the single source of
// truth for "how much overage did this period produce," used by the real
// invoice-scheduler cron (creates real invoices) and the read-only consumption
// summary / billing-test simulator (preview only) alike, so they can never
// silently diverge from each other.
import { supabaseServer } from '@/lib/supabase'
import { computeMetricOverage, describeTieredUsage } from '@/lib/tariff'
import { createRemembillUsageConnector } from '@/lib/connectors/usage/remembill'
import type { ContractTerms } from '@/lib/types'

type MeterCfg = {
  meter_key: string
  included_units: number
  overage_tiers: Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number }>
}
type MeterDef = {
  pull_endpoint_url: string | null
  pull_auth_token: string | null
  pull_param_name: string | null
  mode: 'test' | 'live'
  test_usage_value: number | null
  connector: string | null
  response_metric_key: string | null
}
type PullCfg = { client_usage_url: string; client_read_api_key?: string }

// Persisted onto planned_invoices.overage_line_items at send time — this is
// what lets the billing timeline show "what usage produced this invoice"
// without re-deriving it from Stripe/Remembill after the fact.
export type OverageLineItem = {
  meter_key: string
  total_units: number
  included_units: number
  billable_units: number
  rate_per_unit: number
  amount: number
  currency: string
  description: string
  metric_source: 'meter_pull' | 'client_pull'
}

export async function computeOverageForPeriod(params: {
  orgId: string
  jobId: string
  terms: ContractTerms
  customerId: string
  periodStartUnix: number
  periodEndUnix: number
  currency: string
  // Real billing (invoice-scheduler) must skip meters still in test mode —
  // never invoice off an unfinished meter. Read-only previews (consumption
  // summary) create no invoice and no side effect, so they should still show
  // live data for a test-mode meter — that's the whole point of testing it.
  ignoreTestModeGate?: boolean
}): Promise<OverageLineItem[]> {
  const { orgId, jobId, terms, customerId, periodStartUnix, periodEndUnix, currency, ignoreTestModeGate } = params
  const items: OverageLineItem[] = []

  // Primary source: this job's own confirmed agreement-specific tiers.
  // org_billing_config is deliberately NOT used here — it's a single shared
  // row per (org, meter_key), so whichever agreement was confirmed most
  // recently silently overwrites it for every other job at the same org.
  // contract_meter_mappings is the one place tiers/included_units are kept
  // genuinely per-agreement.
  const { data: meterConfigs } = await supabaseServer
    .from('contract_meter_mappings')
    .select('meter_key, included_units, overage_tiers')
    .eq('job_id', jobId)
    .eq('confirmed', true)

  if (meterConfigs && meterConfigs.length > 0) {
    for (const cfg of meterConfigs as MeterCfg[]) {
      const { data: meterDef } = await supabaseServer
        .from('billing_meters')
        .select('pull_endpoint_url, pull_auth_token, pull_param_name, mode, test_usage_value, connector, response_metric_key')
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq('meter_key', cfg.meter_key)
        .maybeSingle()

      const def = meterDef as MeterDef | null

      // Test mode swaps the input source to the admin's last-simulated
      // reading instead of the real endpoint — that's the whole point of
      // testing it. Real billing (invoice-scheduler) still refuses to
      // invoice off a test-mode meter at all, regardless of this value.
      let totalUnits: number
      if (def?.mode === 'test') {
        if (!ignoreTestModeGate) {
          console.warn(`[usage-pull] meter '${cfg.meter_key}' org ${orgId} still in test mode — skipping real overage`)
          continue
        }
        if (def.test_usage_value == null) continue
        totalUnits = def.test_usage_value
      } else if (def?.connector === 'remembill') {
        try {
          const readings = await createRemembillUsageConnector(orgId).pullUsage({
            customerId,
            periodStart: new Date(periodStartUnix * 1000),
            periodEnd:   new Date(periodEndUnix * 1000),
          })
          const metricKey = def.response_metric_key ?? cfg.meter_key.toUpperCase()
          totalUnits = readings.find(r => r.metric === metricKey)?.quantity ?? 0
        } catch (err) {
          console.error(`[usage-pull] remembill pull failed for meter '${cfg.meter_key}' org ${orgId}:`, err)
          continue
        }
      } else {
        if (!def?.pull_endpoint_url) {
          console.warn(`[usage-pull] no pull endpoint for meter '${cfg.meter_key}' org ${orgId}`)
          continue
        }

        const pullUrl = new URL(def.pull_endpoint_url)
        pullUrl.searchParams.set('customer_id',  customerId)
        pullUrl.searchParams.set('period_start', String(periodStartUnix))
        pullUrl.searchParams.set('period_end',   String(periodEndUnix))
        pullUrl.searchParams.set(def.pull_param_name ?? 'billing_parameter', cfg.meter_key)

        const pullHeaders: Record<string, string> = {}
        if (def.pull_auth_token) pullHeaders['Authorization'] = `Bearer ${def.pull_auth_token}`

        const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
        if (!pullRes.ok) {
          console.error(`[usage-pull] pull failed for meter '${cfg.meter_key}' (${pullRes.status})`)
          continue
        }

        const usageData = await pullRes.json() as { total_billable_units?: number | string }
        totalUnits = Number(usageData.total_billable_units ?? 0)
      }
      if (totalUnits <= 0) continue

      const tiers = (cfg.overage_tiers ?? []).map((t, i) => ({
        tier_label:    `Tier ${i + 1}`,
        from_unit:     t.from_unit ?? null,
        to_unit:       t.to_unit   ?? null,
        rate_per_unit: t.rate_per_unit ?? 0,
        unit_type:     cfg.meter_key,
      }))
      const includedUnits = cfg.included_units ?? 0
      const overageEur    = tiers.length > 0 ? computeMetricOverage(totalUnits, tiers, includedUnits) : 0
      if (overageEur <= 0) continue

      const overageDesc = describeTieredUsage(cfg.meter_key, totalUnits, tiers, includedUnits)
      items.push({
        meter_key: cfg.meter_key, total_units: totalUnits, included_units: includedUnits,
        billable_units: Math.max(0, totalUnits - includedUnits), rate_per_unit: tiers[0]?.rate_per_unit ?? 0,
        amount: Math.round(overageEur * 100) / 100, currency: currency.toUpperCase(),
        description: overageDesc, metric_source: 'meter_pull',
      })
    }
    return items
  }

  // Legacy org-level pull config fallback (no confirmed per-job mapping)
  const { data: orgData } = await supabaseServer
    .from('organizations')
    .select('pull_config')
    .eq('id', orgId)
    .maybeSingle()
  const pc = (orgData?.pull_config ?? {}) as Partial<PullCfg>
  if (!pc.client_usage_url) return items

  const pullUrl = new URL(pc.client_usage_url)
  pullUrl.searchParams.set('customer_id',  customerId)
  pullUrl.searchParams.set('period_start', String(periodStartUnix))
  pullUrl.searchParams.set('period_end',   String(periodEndUnix))

  const pullHeaders: Record<string, string> = {}
  if (pc.client_read_api_key) pullHeaders['Authorization'] = `Bearer ${pc.client_read_api_key}`

  const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
  if (!pullRes.ok) {
    console.error(`[usage-pull] legacy pull failed (${pullRes.status}) for job ${jobId}`)
    return items
  }

  const usageData      = await pullRes.json() as { total_billable_units?: number | string }
  const aggregateUnits = Number(usageData.total_billable_units ?? 0)
  const includedUnits  = terms.included_units ?? 0
  if (aggregateUnits <= 0) return items

  const overageAmount = Math.round(computeMetricOverage(aggregateUnits, terms.overage_tiers ?? [], includedUnits) * 100) / 100
  if (overageAmount <= 0) return items

  const overageDesc = describeTieredUsage('Usage', aggregateUnits, terms.overage_tiers ?? [], includedUnits)
  items.push({
    meter_key: 'usage', total_units: aggregateUnits, included_units: includedUnits,
    billable_units: Math.max(0, aggregateUnits - includedUnits), rate_per_unit: terms.overage_tiers?.[0]?.rate_per_unit ?? 0,
    amount: overageAmount, currency: currency.toUpperCase(),
    description: overageDesc, metric_source: 'client_pull',
  })
  return items
}
