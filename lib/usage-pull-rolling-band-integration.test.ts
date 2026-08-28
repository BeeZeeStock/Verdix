import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { computeOverageForPeriod } from './usage-pull'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17C.2b item A, revised 17C.2c — the PRODUCTION-PATH integration
// test: calls the real, unmodified computeOverageForPeriod (lib/usage-
// pull.ts) against real Postgres, proving the shared effective-commercial-
// state resolver (lib/rolling-band-migration-pull.ts's
// resolveEffectiveCommercialStateForPeriod) actually changes what OVERAGE
// gets billed once a rolling-band transition is active — AND that the
// SEPARATE, independent volume_transition_rule decision (17C.2c) governs
// which number is used, never a silent assumption that the pricing band's
// own upper bound is automatically the new included volume.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/usage-pull-rolling-band-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

// Step 17C.2d real-Postgres acceptance finding — a volume_transition_rule
// version's resolved_at is always REAL wall-clock "now" (the RPC's own
// SERVER-side now()), never a simulated calendar date. billingAsOf must
// therefore also be real "now" (or later) whenever a test resolves a
// volume rule and then immediately checks its effect — using a fixed
// simulated billingAsOf (e.g. "the 5th of the month after the billed
// period") drifts further into the past every day this suite is actually
// run, and would eventually always predate the volume rule's own
// resolved_at, incorrectly holding forever. periodStart/periodEnd stay
// calendar-fixed (a real contractual fact); only billingAsOf needs to
// track real time here.
//
// The +5s buffer is a second, distinct real-Postgres finding: this test
// process's own clock and the remote Postgres server's clock are two
// different clocks — a resolved_at set by the DB server's now() can be
// microseconds to (rarely) whole seconds ahead of Math.floor(Date.now()/1000)
// read from THIS machine, immediately after the RPC call returns. Without
// the buffer, billingAsOf could occasionally land BEFORE the version it's
// meant to see, intermittently reproducing the exact "holds forever"
// symptom this file's own header describes. The window being billed is
// already long closed relative to any near-present timestamp, so a few
// extra seconds of headroom here has no effect on which billing period is
// being evaluated.
function nowUnix(): number {
  return Math.floor(Date.now() / 1000) + 5
}

function monthRangeUnix(year: number, month1to12: number) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0))
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month1to12 - 1, lastDay, 23, 59, 59))
  const billingAsOf = new Date(Date.UTC(year, month1to12, 5, 0, 0, 0))
  return {
    periodStartUnix: Math.floor(start.getTime() / 1000),
    periodEndUnix: Math.floor(end.getTime() / 1000),
    billingAsOfUnix: Math.floor(billingAsOf.getTime() / 1000),
  }
}

const FROM_BAND = { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 }
const TO_BAND = { from_unit: 5001, to_unit: 15000, monthly_fee: 5000 }

describeIf('computeOverageForPeriod — rolling-band transition + Step 17C.2c volume_transition_rule (real Postgres production path)', () => {
  let orgId: string
  let jobId: string
  let terms: ContractTerms

  beforeAll(async () => {
    const slug = `usage-pull-rolling-band-integration-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'usage-pull-rolling-band-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'usage-pull-rolling-band-job', module: 'AUTO_CONFIGURE', currency: 'EUR',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    terms = buildRemembillFixtureTerms()
    terms.contract_start_date = '2026-01-01'
    terms.billing_frequency = 'monthly'

    // contract_meter_mappings — contract_unit_type MUST equal the
    // mechanism's rolling_band_migration.aggregate.input_key
    // ('issued_payment_request_count') — that equivalence IS the whole
    // integration point (see usage-pull.ts's own new branch).
    const { error: mappingError } = await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'issued_payment_request_count', meter_key: 'payment_requests',
      included_units: 5000, overage_tiers: [{ from_unit: 1, to_unit: null, rate_per_unit: 1 }],
      billing_cycle: 'monthly', confirmed: true,
    })
    if (mappingError) throw new Error(`contract_meter_mappings insert failed: ${mappingError.message}`)

    const { error: meterError } = await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: 'payment_requests', display_name: 'Payment requests', unit_label: 'request',
      mode: 'test', test_usage_value: 8000,
    })
    if (meterError) throw new Error(`billing_meters insert failed: ${meterError.message}`)
  })

  afterAll(async () => {
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('before any transition: 8,000 requests against the original 5,000 included -> 3,000 billable', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 3)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix, ignoreTestModeGate: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].total_units).toBe(8000)
    expect(items[0].included_units).toBe(5000)
    expect(items[0].billable_units).toBe(3000)
  })

  it('Step 17C.2c required regression — an ACTIVE transition with volume treatment UNRESOLVED holds overage entirely (no line item), never silently 5,000 or 15,000', async () => {
    const { data: detected } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
      p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
      p_trigger_window_end: '2026-03-31', p_trigger_value: 8000,
      p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
    })
    await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
      p_transition_id: detected.id,
      p_effective_rule: { kind: 'specific_date', specific_date: '2026-06-01', provenance: 'reviewer_policy', source_clause: null },
      p_effective_from: '2026-06-01',
    })
    // volume_transition_rule is deliberately left null here.

    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 6)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix, ignoreTestModeGate: true, includeZeroUsage: true, // even with this flag, a held meter produces NO item at all
    })
    expect(items).toHaveLength(0)
  })

  it('Step 17C.2c required regression — band_upper_bound resolved -> contracted volume = 15,000 -> 0 billable (the band\'s own capacity now covers it)', async () => {
    const { data: transitions } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId).limit(1)
    const transitionId = transitions![0].id
    await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: transitionId, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
    })

    const { periodStartUnix, periodEndUnix } = monthRangeUnix(2026, 6)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix: nowUnix(), ignoreTestModeGate: true, includeZeroUsage: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].included_units).toBe(15000)
    expect(items[0].billable_units).toBe(0)
  })

  it('Step 17C.2c required regression — rolling_average resolved -> contracted volume = 8,000 (the SAME trigger_value the transition was detected from)', async () => {
    const { data: transitions } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId).limit(1)
    const transitionId = transitions![0].id
    await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: transitionId, p_volume_rule: { kind: 'rolling_average', value: null, provenance: 'reviewer_policy', source_clause: null },
    })

    const { periodStartUnix, periodEndUnix } = monthRangeUnix(2026, 6)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix: nowUnix(), ignoreTestModeGate: true, includeZeroUsage: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].included_units).toBe(8000)
    expect(items[0].billable_units).toBe(0)
  })

  it('Step 17C.2c required regression — specific_volume = 10,000 resolved -> contracted volume = 10,000', async () => {
    const { data: transitions } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId).limit(1)
    const transitionId = transitions![0].id
    await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: transitionId, p_volume_rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null },
    })

    const { periodStartUnix, periodEndUnix } = monthRangeUnix(2026, 6)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix: nowUnix(), ignoreTestModeGate: true, includeZeroUsage: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].included_units).toBe(10000)
  })

  it('Step 17C.2c required regression — unchanged resolved -> contracted volume = 5,000 (the ORIGINAL committed volume, even though the price moved) -> 3,000 billable again', async () => {
    const { data: transitions } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId).limit(1)
    const transitionId = transitions![0].id
    await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: transitionId, p_volume_rule: { kind: 'unchanged', value: null, provenance: 'reviewer_policy', source_clause: null },
    })

    const { periodStartUnix, periodEndUnix } = monthRangeUnix(2026, 6)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix: nowUnix(), ignoreTestModeGate: true, includeZeroUsage: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].included_units).toBe(5000)
    expect(items[0].billable_units).toBe(3000)
  })

  it('a HISTORICAL period before the transition\'s effective_from is NEVER retroactively altered by ANY of the above volume decisions — still 5,000/3,000', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 3)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cus_test', periodStartUnix, periodEndUnix, currency: 'EUR',
      billingAsOfUnix, ignoreTestModeGate: true,
    })
    expect(items).toHaveLength(1)
    expect(items[0].included_units).toBe(5000)
    expect(items[0].billable_units).toBe(3000)
  })
})
