// Pulls usage and computes overage for a billing period — the single source of
// truth for "how much overage did this period produce," used by the real
// invoice-scheduler cron (creates real invoices) and the read-only consumption
// summary / billing-test simulator (preview only) alike, so they can never
// silently diverge from each other.
import { supabaseServer } from '@/lib/supabase'
import { computeMetricOverage, describeTieredUsage, enumerateCadenceWindows, findCadenceWindowContaining } from '@/lib/tariff'
import { createRemembillUsageConnector } from '@/lib/connectors/usage/remembill'
import type { ContractTerms } from '@/lib/types'

type MeterCfg = {
  meter_key: string
  included_units: number
  overage_tiers: Array<{ from_unit?: number | null; to_unit?: number | null; rate_per_unit?: number; minimum_period_amount?: number | null }>
  billing_cycle: string | null
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
  // The actual window this meter was measured over — set whenever the meter
  // has its own measurement cadence, which can differ from the invoice
  // period it's displayed under (e.g. a quarterly-measured metric shown
  // inside a monthly invoice row). Omitted for the legacy client_pull path,
  // which has no per-meter cadence concept.
  windowStart?: string
  windowEnd?: string
  // True when windowEnd is the cadence's natural (not-yet-reached) end date
  // rather than a closed cycle — the figure is "so far", not final.
  windowOpen?: boolean
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
  // Real invoices should only ever contain billable line items — a meter
  // pulled fine but produced $0 overage (usage within the included
  // allowance) has nothing to invoice, so invoice-scheduler must keep
  // skipping it. The read-only preview wants the opposite: showing "we
  // pulled 19, 500 included, 0 billable" is exactly how you confirm the
  // pull actually worked, especially when every meter is under its
  // allowance. This never changes what real billing computes or charges —
  // only whether $0 results are included in the returned list.
  includeZeroUsage?: boolean
  // Read-only preview only: a meter whose cadence is longer than the scan
  // range (a quarterly-measured metric previewed inside a monthly
  // Consumption-card row) has no fully-closed window to show yet — correct
  // for billing, but it means "usage so far this quarter" never appears
  // until the quarter closes. Set this to also surface the meter's
  // currently-open window (clipped to this timestamp) as a live-so-far
  // preview. Never set by invoice-scheduler — real billing must only ever
  // charge for windows that have actually closed.
  livePreviewAsOfUnix?: number
}): Promise<OverageLineItem[]> {
  const { orgId, jobId, terms, customerId, periodStartUnix, periodEndUnix, currency, ignoreTestModeGate, includeZeroUsage, livePreviewAsOfUnix } = params
  const items: OverageLineItem[] = []

  // Primary source: this job's own confirmed agreement-specific tiers.
  // org_billing_config is deliberately NOT used here — it's a single shared
  // row per (org, meter_key), so whichever agreement was confirmed most
  // recently silently overwrites it for every other job at the same org.
  // contract_meter_mappings is the one place tiers/included_units are kept
  // genuinely per-agreement.
  const { data: meterConfigs } = await supabaseServer
    .from('contract_meter_mappings')
    .select('meter_key, included_units, overage_tiers, billing_cycle')
    .eq('job_id', jobId)
    .eq('confirmed', true)

  if (meterConfigs && meterConfigs.length > 0) {
    const scanStart  = new Date(periodStartUnix * 1000)
    const scanEnd    = new Date(periodEndUnix   * 1000)
    // Windows are anchored to the contract's start date so a quarterly meter
    // always resets on the same day-of-cycle the contract began, not on
    // whatever date this particular scan range happens to start.
    const anchorDate = terms.contract_start_date
      ? new Date(terms.contract_start_date + 'T00:00:00')
      : scanStart

    for (const cfg of meterConfigs as MeterCfg[]) {
      const { data: meterDef } = await supabaseServer
        .from('billing_meters')
        .select('pull_endpoint_url, pull_auth_token, pull_param_name, mode, test_usage_value, connector, response_metric_key')
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq('meter_key', cfg.meter_key)
        .maybeSingle()

      const def = meterDef as MeterDef | null

      // A meter measures on its own cadence (billing_cycle — derived from
      // the contract's stated measurement_period for this metric, which can
      // legitimately differ from the deal's overall billing_frequency) —
      // e.g. a metric measured half-yearly inside a contract invoiced
      // monthly. Enumerate every fully-closed window of THIS meter's
      // cadence within the scan range. The common case (meter cadence ==
      // invoice cadence) yields exactly one window spanning the whole scan
      // range, so this is a superset of the old single-period behavior, not
      // a divergent path for it.
      const windows: Array<{ start: Date; end: Date; displayEnd: Date; isOpen?: boolean }> =
        enumerateCadenceWindows(anchorDate, cfg.billing_cycle, scanStart, scanEnd)
          .map(w => ({ ...w, displayEnd: w.end }))

      // Live preview: also surface the currently-open window (not yet
      // closed) so usage-so-far is visible before it actually closes. Marked
      // isOpen so its minimum_period_amount floor doesn't apply below — that
      // guarantee is for the full period, not whatever's accrued on day one.
      // The window queried/pulled is clipped to today (end) — querying the
      // full future-reaching cadence window would ask connectors like
      // Remembill's sandbox for a range it doesn't cap at "today", returning
      // fabricated future usage. displayEnd keeps the *true, uncapped*
      // window end so the UI can still show "this meter measures quarterly,
      // Aug 11 – Nov 10" instead of a misleading same-day range.
      if (livePreviewAsOfUnix != null) {
        const asOf = new Date(livePreviewAsOfUnix * 1000)
        const openWindow = findCadenceWindowContaining(anchorDate, cfg.billing_cycle, asOf)
        const alreadyCovered = windows.some(w => w.start.getTime() === openWindow.start.getTime())
        if (!alreadyCovered && openWindow.start <= asOf) {
          windows.push({
            start: openWindow.start,
            end: asOf < openWindow.end ? asOf : openWindow.end,
            displayEnd: openWindow.end,
            isOpen: true,
          })
        }
      }

      for (const window of windows) {
        const windowStartUnix = Math.floor(window.start.getTime() / 1000)
        const windowEndUnix   = Math.floor(window.end.getTime()   / 1000) + 86_399 // 23:59:59 on the end date

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
              periodStart: window.start,
              periodEnd:   window.end,
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
          pullUrl.searchParams.set('period_start', String(windowStartUnix))
          pullUrl.searchParams.set('period_end',   String(windowEndUnix))
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
        if (totalUnits <= 0 && !includeZeroUsage) continue

        const tiers = (cfg.overage_tiers ?? []).map((t, i) => ({
          tier_label:    `Tier ${i + 1}`,
          from_unit:     t.from_unit ?? null,
          to_unit:       t.to_unit   ?? null,
          rate_per_unit: t.rate_per_unit ?? 0,
          unit_type:     cfg.meter_key,
          minimum_period_amount: t.minimum_period_amount ?? null,
        }))
        const includedUnits = cfg.included_units ?? 0
        const overageEur    = tiers.length > 0 ? computeMetricOverage(totalUnits, tiers, includedUnits, !window.isOpen) : 0
        if (overageEur <= 0 && !includeZeroUsage) continue

        // Show this meter's own measurement window whenever it doesn't
        // exactly match the invoice period it's displayed under — either
        // because several windows of a shorter cadence land on one invoice
        // (multiple monthly windows inside a quarterly arrears row — each
        // needs its own dates to stay legible), or because a single window
        // of a *longer* cadence than the invoice period is being previewed
        // mid-cycle (a quarterly meter shown inside a monthly Consumption
        // row) — without this, that row silently looked like it was
        // measuring the same (wrong) monthly window as everything else.
        const fmtRange = (s: Date, e: Date) =>
          `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        const dateOnly = (d: Date) => d.toISOString().slice(0, 10)
        const matchesScanRange = dateOnly(window.start) === dateOnly(scanStart) && dateOnly(window.displayEnd) === dateOnly(scanEnd)
        const windowSuffix = !matchesScanRange
          ? ` (${fmtRange(window.start, window.displayEnd)})`
          : ''
        const overageDesc = describeTieredUsage(cfg.meter_key, totalUnits, tiers, includedUnits, !window.isOpen) + windowSuffix
        items.push({
          meter_key: cfg.meter_key, total_units: totalUnits, included_units: includedUnits,
          billable_units: Math.max(0, totalUnits - includedUnits), rate_per_unit: tiers[0]?.rate_per_unit ?? 0,
          amount: Math.round(overageEur * 100) / 100, currency: currency.toUpperCase(),
          description: overageDesc, metric_source: 'meter_pull',
          windowStart: window.start.toISOString().slice(0, 10),
          windowEnd:   window.displayEnd.toISOString().slice(0, 10),
          windowOpen:  window.isOpen ?? false,
        })
      }
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
