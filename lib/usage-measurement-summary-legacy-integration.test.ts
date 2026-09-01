import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { supabaseServer } from './supabase'
import { resolveMeasurementSummaryForPeriod } from './usage-measurement-summary'
import { computeOverageForPeriod } from './usage-pull'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.2C item 3 — the legacy org-level client_usage_url fallback,
// measurement-only. Real Postgres for org/job/contract_meter_mappings
// state; global.fetch stubbed for the ONE external HTTP call the legacy
// path itself makes (lib/usage-pull.ts's resolveLegacyClientPullQuantity),
// exactly like real production traffic would hit an org's own configured
// endpoint — never a second, independently-written HTTP client.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/usage-measurement-summary-legacy-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const LEGACY_URL = 'https://legacy-pull.invalid/usage'

// Stubbing global.fetch broadly also intercepts supabase-js's own internal
// REST calls (it uses fetch under the hood) — every real Supabase query
// inside resolveMeasurementSummaryForPeriod/computeOverageForPeriod would
// silently receive this mock's response instead. Discriminate by URL:
// only the legacy endpoint is mocked, everything else (including Supabase
// itself) goes to the real, original fetch.
function stubLegacyEndpoint(realFetch: typeof fetch, totalBillableUnits: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith(LEGACY_URL)) {
      return { ok: true, json: async () => ({ total_billable_units: totalBillableUnits }) } as Response
    }
    return realFetch(input, init)
  }) as unknown as typeof fetch
}

function monthRangeUnix(year: number, month1to12: number) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0))
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month1to12 - 1, lastDay, 23, 59, 59))
  return { periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10) }
}

describeIf('resolveMeasurementSummaryForPeriod — legacy client_usage_url fallback (real Postgres production path)', () => {
  let orgId: string
  let jobId: string
  let terms: ContractTerms
  const realFetch = global.fetch

  afterEach(() => { global.fetch = realFetch })

  beforeAll(async () => {
    const slug = `usage-measurement-legacy-integration-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({
      name: 'usage-measurement-legacy-org', slug,
      pull_config: { client_usage_url: LEGACY_URL, client_read_api_key: 'test-key' },
    }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'usage-measurement-legacy-job', module: 'AUTO_CONFIGURE', currency: 'EUR',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    terms = {
      contract_start_date: '2026-01-01', billing_frequency: 'monthly', currency: 'EUR',
      discounts: [], escalators: [], included_units: 50,
      overage_tiers: [{ from_unit: 1, to_unit: null, rate_per_unit: 2 }],
    } as unknown as ContractTerms
  })

  afterAll(async () => {
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('no confirmed mapping + legacy fallback configured -> fallback measurement available, no amount field', async () => {
    global.fetch = stubLegacyEndpoint(realFetch, 275)

    const now = new Date()
    const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
    const facts = await resolveMeasurementSummaryForPeriod({ orgId, jobId, terms, customerId: 'cust-legacy', periodStart, periodEnd, asOf: now })

    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ meter_key: 'usage', total_units: 275, metric_source: 'client_pull', rate_per_unit: 2 })
    expect('amount' in facts[0]).toBe(false)
  })

  it('resolves the IDENTICAL quantity computeOverageForPeriod resolves via the same legacy fallback — only the priced path computes an amount', async () => {
    global.fetch = stubLegacyEndpoint(realFetch, 275)

    const now = new Date()
    const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
    const asOfUnix = Math.floor(now.getTime() / 1000)

    const facts = await resolveMeasurementSummaryForPeriod({ orgId, jobId, terms, customerId: 'cust-legacy', periodStart, periodEnd, asOf: now })
    const priced = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-legacy',
      periodStartUnix: Math.floor(new Date(periodStart + 'T00:00:00Z').getTime() / 1000),
      periodEndUnix: Math.floor(new Date(periodEnd + 'T23:59:59Z').getTime() / 1000),
      currency: 'EUR', billingAsOfUnix: asOfUnix, livePreviewAsOfUnix: asOfUnix,
    })

    expect(priced).toHaveLength(1)
    expect(priced[0].metric_source).toBe('client_pull')
    expect(facts[0].total_units).toBe(priced[0].total_units)
    expect(priced[0].amount).toBeGreaterThan(0) // (275 - 50) * 2 = 450
    expect('amount' in facts[0]).toBe(false)
  })

  it('a CONFIRMED contract_meter_mappings row always wins over the legacy fallback, even though it is also configured', async () => {
    const { error: mappingError } = await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'confirmed_metric', meter_key: 'confirmed_meter',
      included_units: 10, overage_tiers: [{ from_unit: 1, to_unit: null, rate_per_unit: 5 }],
      billing_cycle: 'monthly', confirmed: true,
    })
    if (mappingError) throw new Error(`contract_meter_mappings insert failed: ${mappingError.message}`)
    const { error: meterError } = await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: 'confirmed_meter', display_name: 'Confirmed metric', unit_label: 'unit',
      mode: 'test', test_usage_value: 42,
    })
    if (meterError) throw new Error(`billing_meters insert failed: ${meterError.message}`)

    let legacyEndpointCalled = false
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(LEGACY_URL)) { legacyEndpointCalled = true; return { ok: true, json: async () => ({ total_billable_units: 999 }) } as Response }
      return realFetch(input, init)
    }) as unknown as typeof fetch

    try {
      const now = new Date()
      const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
      const facts = await resolveMeasurementSummaryForPeriod({ orgId, jobId, terms, customerId: 'cust-legacy', periodStart, periodEnd, asOf: now })

      expect(facts).toHaveLength(1)
      expect(facts[0]).toMatchObject({ meter_key: 'confirmed_meter', total_units: 42, metric_source: 'meter_pull' })
      // The legacy HTTP endpoint was never even called — precedence holds
      // structurally, not just "the confirmed value happened to win."
      expect(legacyEndpointCalled).toBe(false)
    } finally {
      await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
      await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    }
  })

  it('neither a confirmed mapping nor a legacy fallback configured -> empty, truthful unresolved result, no error', async () => {
    const slug = `usage-measurement-no-source-${Date.now()}`
    const { data: bareOrg } = await supabaseServer.from('organizations').insert({ name: 'usage-measurement-no-source-org', slug }).select('id').single()
    const bareOrgId = bareOrg!.id
    const { data: bareJob } = await supabaseServer.from('jobs').insert({
      org_id: bareOrgId, name: 'usage-measurement-no-source-job', module: 'AUTO_CONFIGURE', currency: 'EUR',
    }).select('id').single()
    const bareJobId = bareJob!.id

    try {
      const now = new Date()
      const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
      const facts = await resolveMeasurementSummaryForPeriod({ orgId: bareOrgId, jobId: bareJobId, terms, customerId: 'cust-none', periodStart, periodEnd, asOf: now })
      expect(facts).toEqual([])
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', bareJobId)
      await supabaseServer.from('organizations').delete().eq('id', bareOrgId)
    }
  })
})
