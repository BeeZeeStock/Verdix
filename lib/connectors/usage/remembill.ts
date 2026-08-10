import { getOrgConfig } from '@/lib/billing-writer'
import type { UsageConnector, UsageReading } from './types'

// Remembill's usage-pull API (distinct namespace from their invoicing API at
// api.remembill.com/v1, used by lib/billing-writer.ts): one call returns
// every metered metric for a customer/period in a single response, so this
// connector is shared by every billing_meters row with connector='remembill'
// (invoice_sent, email_sent, sms_sent, letter_sent, reminder_sent, …).
const REMEMBILL_USAGE_BASE = 'https://api.remembill.com/integrations/verdix/v1'

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

async function fetchUsage(orgId: string | undefined, customerId: string, periodStart: Date, periodEnd: Date): Promise<UsageReading[]> {
  const orgConfig = orgId ? await getOrgConfig(orgId, 'remembill') : null
  const apiKey = orgConfig?.api_key ?? process.env.REMEMBILL_API_KEY
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}

  const url = new URL(`${REMEMBILL_USAGE_BASE}/customers/${encodeURIComponent(customerId)}/usage`)
  url.searchParams.set('start', yyyymmdd(periodStart))
  url.searchParams.set('end', yyyymmdd(periodEnd))

  const res = await fetch(url.toString(), { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Remembill usage pull failed (${res.status}) for customer ${customerId}: ${body}`)
  }
  const json = await res.json() as { data?: { usage?: UsageReading[] } }
  return json.data?.usage ?? []
}

// One job can map several meters (INVOICE_SENT, EMAIL_SENT, ...) that all
// resolve to the same Remembill customer/period — cache in-flight/complete
// pulls so a period with 5 mapped meters hits Remembill once, not 5 times.
const cache = new Map<string, Promise<UsageReading[]>>()

export function createRemembillUsageConnector(orgId?: string): UsageConnector {
  return {
    connector: 'remembill',
    pullUsage({ customerId, periodStart, periodEnd }) {
      const key = `${orgId ?? ''}:${customerId}:${yyyymmdd(periodStart)}:${yyyymmdd(periodEnd)}`
      let pending = cache.get(key)
      if (!pending) {
        pending = fetchUsage(orgId, customerId, periodStart, periodEnd)
        pending.catch(() => cache.delete(key)) // don't cache failures
        cache.set(key, pending)
      }
      return pending
    },
  }
}
