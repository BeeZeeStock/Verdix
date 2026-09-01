import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { resolveMeasurementSummaryForPeriod } from './usage-measurement-summary'
import { computeOverageForPeriod } from './usage-pull'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.2B.2 items 2-5/24 — the PRODUCTION-PATH integration test for the
// pricing-free measurement-only path: calls the real, unmodified
// resolveMeasurementSummaryForPeriod against real Postgres, using the exact
// same test-mode meter/contract_meter_mappings fixture shape
// computeOverageForPeriod's own integration tests use — proving both
// functions resolve the IDENTICAL quantity from the IDENTICAL underlying
// source (they share resolveUsageMeasurementWindows), while only
// computeOverageForPeriod ever produces a monetary amount.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/usage-measurement-summary-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

function monthRangeUnix(year: number, month1to12: number) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0))
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month1to12 - 1, lastDay, 23, 59, 59))
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  }
}

describeIf('resolveMeasurementSummaryForPeriod — pricing-free, real Postgres production path', () => {
  let orgId: string
  let jobId: string
  let terms: ContractTerms

  beforeAll(async () => {
    const slug = `usage-measurement-summary-integration-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'usage-measurement-summary-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'usage-measurement-summary-job', module: 'AUTO_CONFIGURE', currency: 'EUR',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    terms = { contract_start_date: '2026-01-01', billing_frequency: 'monthly', currency: 'EUR', discounts: [], escalators: [] } as unknown as ContractTerms

    const { error: mappingError } = await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'api_calls', meter_key: 'api_calls_meter',
      included_units: 100, overage_tiers: [{ from_unit: 1, to_unit: null, rate_per_unit: 0.5 }],
      billing_cycle: 'monthly', confirmed: true,
    })
    if (mappingError) throw new Error(`contract_meter_mappings insert failed: ${mappingError.message}`)

    const { error: meterError } = await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: 'api_calls_meter', display_name: 'API calls', unit_label: 'call',
      mode: 'test', test_usage_value: 340,
    })
    if (meterError) throw new Error(`billing_meters insert failed: ${meterError.message}`)
  })

  afterAll(async () => {
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('returns the quantity with NO amount field at all — structurally never a monetary calculation', async () => {
    // The CURRENT real month — a genuine 'current'-period scenario (what
    // Refresh actually calls this for). Using today's own month keeps this
    // aligned with the SAME "surface the currently-open window" behavior
    // computeOverageForPeriod's own livePreviewAsOfUnix branch already has
    // — a period further in the past would additionally surface today's
    // still-open window as a second, unrelated result.
    const now = new Date()
    const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
    const facts = await resolveMeasurementSummaryForPeriod({
      orgId, jobId, terms, customerId: 'cust-test', periodStart, periodEnd, asOf: now,
    })
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ meter_key: 'api_calls_meter', total_units: 340, metric_source: 'meter_pull' })
    // The one structural guarantee this module makes: no fact it produces
    // ever carries an 'amount' property.
    expect('amount' in facts[0]).toBe(false)
  })

  it('resolves the IDENTICAL quantity computeOverageForPeriod resolves for the same window — same underlying source, only one of them prices it', async () => {
    const now = new Date()
    const { periodStart, periodEnd } = monthRangeUnix(now.getUTCFullYear(), now.getUTCMonth() + 1)
    const asOfUnix = Math.floor(now.getTime() / 1000)

    const facts = await resolveMeasurementSummaryForPeriod({ orgId, jobId, terms, customerId: 'cust-test', periodStart, periodEnd, asOf: now })
    const priced = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-test',
      periodStartUnix: Math.floor(new Date(periodStart + 'T00:00:00Z').getTime() / 1000),
      periodEndUnix: Math.floor(new Date(periodEnd + 'T23:59:59Z').getTime() / 1000),
      currency: 'EUR', billingAsOfUnix: asOfUnix, livePreviewAsOfUnix: asOfUnix,
      ignoreTestModeGate: true,
    })

    expect(priced).toHaveLength(1)
    expect(facts[0].total_units).toBe(priced[0].total_units)
    // Same quantity, but only the priced path carries a monetary amount —
    // this IS the separation items 2-4 require.
    expect(priced[0].amount).toBeGreaterThan(0)
    expect('amount' in facts[0]).toBe(false)
  })
})
