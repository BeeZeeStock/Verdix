// Step 17D, item 11 — extracted verbatim from lib/usage-pull.ts's own
// inline test/remembill/generic-endpoint dispatch (previously duplicated
// nowhere else, now shared with lib/usage-quantity-resolver.ts) so
// computeOverageForPeriod stops OWNING meter retrieval as a private
// overage-only concern, without changing its behavior at all — every
// branch below is the same logic, same order, same fallback, just callable
// from more than one place now.
import { createRemembillUsageConnector } from '@/lib/connectors/usage/remembill'
export type MeterDefForPull = {
  pull_endpoint_url: string | null
  pull_auth_token: string | null
  pull_param_name: string | null
  mode: 'test' | 'live'
  test_usage_value: number | null
  connector: string | null
  response_metric_key: string | null
}

export type MeterQuantityPullResult =
  | { status: 'ok'; totalUnits: number }
  // Mirrors the existing `continue`-with-a-console.warn/error behavior at
  // every one of usage-pull.ts's original call sites — never thrown,
  // since a single meter failing to pull was never fatal to the rest of a
  // billing run.
  | { status: 'skip'; reason: string }

export async function pullMeterQuantity(params: {
  orgId: string
  meterKey: string
  def: MeterDefForPull | null
  customerId: string
  periodStart: Date
  periodEnd: Date
  ignoreTestModeGate?: boolean
}): Promise<MeterQuantityPullResult> {
  const { orgId, meterKey, def, customerId, periodStart, periodEnd, ignoreTestModeGate } = params

  if (def?.mode === 'test') {
    if (!ignoreTestModeGate) {
      return { status: 'skip', reason: `meter '${meterKey}' org ${orgId} still in test mode — skipping real overage` }
    }
    if (def.test_usage_value == null) return { status: 'skip', reason: `meter '${meterKey}' has no test_usage_value configured` }
    return { status: 'ok', totalUnits: def.test_usage_value }
  }

  if (def?.connector === 'remembill') {
    try {
      const readings = await createRemembillUsageConnector(orgId).pullUsage({ customerId, periodStart, periodEnd })
      const metricKey = def.response_metric_key ?? meterKey.toUpperCase()
      const totalUnits = readings.find(r => r.metric === metricKey)?.quantity ?? 0
      return { status: 'ok', totalUnits }
    } catch (err) {
      return { status: 'skip', reason: `remembill pull failed for meter '${meterKey}' org ${orgId}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (!def?.pull_endpoint_url) {
    return { status: 'skip', reason: `no pull endpoint for meter '${meterKey}' org ${orgId}` }
  }

  const pullUrl = new URL(def.pull_endpoint_url)
  pullUrl.searchParams.set('customer_id', customerId)
  pullUrl.searchParams.set('period_start', String(Math.floor(periodStart.getTime() / 1000)))
  pullUrl.searchParams.set('period_end', String(Math.floor(periodEnd.getTime() / 1000)))
  pullUrl.searchParams.set(def.pull_param_name ?? 'billing_parameter', meterKey)

  const pullHeaders: Record<string, string> = {}
  if (def.pull_auth_token) pullHeaders['Authorization'] = `Bearer ${def.pull_auth_token}`

  const pullRes = await fetch(pullUrl.toString(), { headers: pullHeaders })
  if (!pullRes.ok) {
    return { status: 'skip', reason: `pull failed for meter '${meterKey}' (${pullRes.status})` }
  }

  const usageData = await pullRes.json() as { total_billable_units?: number | string }
  return { status: 'ok', totalUnits: Number(usageData.total_billable_units ?? 0) }
}
