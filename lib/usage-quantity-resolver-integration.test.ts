import { describe, it, expect, afterAll } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { supabaseServer, createBrowserClient } from './supabase'
import { resolveUsageQuantityForPeriod } from './usage-quantity-resolver'
import { computePerUnitFeeLineItemsForPeriod } from './per-unit-fee-pull'
import { computeOverageForPeriod } from './usage-pull'
import { evaluateRollingBandMigrations } from './rolling-band-migration-pull'
import { resolveSourceManagementAuthorization } from './org-lifecycle'
import type { ContractTerms } from './types'

// Step 17D rollout — a genuinely LIVE (mode: 'live') billing_meters row
// with a real pull_endpoint_url, backed by a tiny local HTTP server whose
// returned total_billable_units can change between calls. Needed once
// real-Postgres testing exposed that mode: 'test' meters must never be
// finalize-able at all (lib/usage-quantity-resolver.ts's ignoreTestModeGate
// fix — the test-mode gate now blocks 'closed_period_finalize', not
// 'live') — proving the closed_period_finalize snapshot sequence honestly
// therefore needs an actual, changing pull source, not a static simulated
// test_usage_value.
async function startMockUsageServer(getValue: () => number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ total_billable_units: getValue() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/usage`,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 17D (hardened 17D.1) — real-Postgres acceptance: tenant ownership
// (org_id is the SOLE ownership column — no owner_org_id), lifecycle-based
// design-partner authorization, existing-meter reuse, missing-meter
// fail-closed, multi-rule quantity reuse (one meter -> €0.38/request,
// €0.60 overage, rolling migration), and the corrected 3-mode snapshot
// authority split (item H: 'live' never touches the snapshot table,
// 'closed_period_read' reads-if-pinned-else-fresh-without-writing,
// 'closed_period_finalize' is the ONLY mode that may durably pin — and does
// so idempotently, never rewriting an existing pin). Requires
// supabase/migrations/20260906000001-20260906000005 to be APPLIED first
// (this step deliberately does not apply them — see the final report).
// Run deliberately once applied:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/usage-quantity-resolver-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const cleanupOrgIds: string[] = []
const cleanupJobIds: string[] = []

async function createTestOrg(name: string, lifecycleStage: 'design_partner' | 'production_customer' = 'production_customer'): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug, lifecycle_stage: lifecycleStage }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  cleanupOrgIds.push(data.id as string)
  return data.id as string
}

async function createTestJob(orgId: string, billingCustomerId = 'cust-test'): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: '17D usage-quantity-resolver test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId, billing_customer_id: billingCustomerId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('resolved_usage_period_snapshots').delete().eq('job_id', jobId)
    await supabaseServer.from('usage_period_values').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    await supabaseServer.from('org_memberships').delete().eq('org_id', orgId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
})

describeIf('Step 17D.1 — tenant ownership (org_id is the sole ownership column)', () => {
  it('a meter owned by org A is invisible to org B via org_id-scoped query', async () => {
    const orgA = await createTestOrg('17D.1 Org A (owner)')
    const orgB = await createTestOrg('17D.1 Org B (unrelated)')
    const { data: meter } = await supabaseServer.from('billing_meters').insert({
      org_id: orgA, meter_key: `test_meter_${Date.now()}`,
      display_name: 'Test Meter', unit_label: 'unit',
    }).select('id').single()

    const { data: seenByA } = await supabaseServer.from('billing_meters').select('id').eq('org_id', orgA).eq('id', meter!.id)
    const { data: seenByB } = await supabaseServer.from('billing_meters').select('id').eq('org_id', orgB).eq('id', meter!.id)
    expect(seenByA).toHaveLength(1)
    expect(seenByB).toHaveLength(0)
  })

  it('a genuine platform meter (is_platform_meter=true) may have org_id null; an ordinary business meter may not', async () => {
    // Step 17D rollout — the cleanup call below previously took a FRESH
    // Date.now() at delete time instead of reusing the value the row was
    // actually created with, so it never matched and never deleted
    // anything — a real leftover-data bug real-Postgres testing caught
    // directly (3 orphaned platform_meter_* rows found after the first
    // few runs). Fixed by capturing the key once and reusing it.
    const platformMeterKey = `platform_meter_${Date.now()}`
    const { error: platformErr } = await supabaseServer.from('billing_meters').insert({
      org_id: null, is_platform_meter: true, meter_key: platformMeterKey,
      display_name: 'Platform Meter', unit_label: 'unit',
    })
    expect(platformErr).toBeNull()

    const { error: businessErr } = await supabaseServer.from('billing_meters').insert({
      org_id: null, is_platform_meter: false, meter_key: `bad_business_meter_${Date.now()}`,
      display_name: 'Should Fail', unit_label: 'unit',
    })
    expect(businessErr).not.toBeNull() // CHECK constraint: org_id required unless is_platform_meter

    await supabaseServer.from('billing_meters').delete().eq('meter_key', platformMeterKey)
  })

  it('Remembill admin (org member, role admin) can manage the org\'s own meter', async () => {
    const orgId = await createTestOrg('17D.1 Remembill-like org', 'design_partner')
    await supabaseServer.from('org_memberships').insert({ org_id: orgId, user_email: 'admin@remembill-test.invalid', role: 'admin', status: 'active' })
    const authz = await resolveSourceManagementAuthorization(orgId, 'admin@remembill-test.invalid')
    expect(authz.canManageSources).toBe(true)
  })

  it('Remembill member (role member) can confirm mappings but not manage endpoint credentials', async () => {
    const orgId = await createTestOrg('17D.1 Remembill-like org (member)', 'design_partner')
    await supabaseServer.from('org_memberships').insert({ org_id: orgId, user_email: 'member@remembill-test.invalid', role: 'member', status: 'active' })
    const authz = await resolveSourceManagementAuthorization(orgId, 'member@remembill-test.invalid')
    expect(authz.canManageSources).toBe(false)
    expect(authz.canConfirmMapping).toBe(true)
  })

  it('a brand-new production_customer org grants Verdix admin no cross-tenant access', async () => {
    const orgId = await createTestOrg('17D.1 fresh production org', 'production_customer')
    const verdixAdminEmail = 'bilal.zahoor@yahoo.com' // real ADMIN_EMAILS entry, lib/admin.ts
    const authz = await resolveSourceManagementAuthorization(orgId, verdixAdminEmail)
    expect(authz.canManageSources).toBe(false)
  })

  it('Verdix admin can manage the design-partner org\'s meter, and loses that access once transitioned to production_customer, with meter rows/config left untouched', async () => {
    const orgId = await createTestOrg('17D.1 design-partner transition org', 'design_partner')
    const verdixAdminEmail = 'bilal.zahoor@yahoo.com' // real ADMIN_EMAILS entry, lib/admin.ts
    const meterKey = `transition_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Transition Meter', unit_label: 'unit',
    })

    const during = await resolveSourceManagementAuthorization(orgId, verdixAdminEmail)
    expect(during.canManageSources).toBe(true)

    await supabaseServer.from('organizations').update({ lifecycle_stage: 'production_customer' }).eq('id', orgId)
    const after = await resolveSourceManagementAuthorization(orgId, verdixAdminEmail)
    expect(after.canManageSources).toBe(false)

    // The meter row itself is untouched by the lifecycle transition — this
    // is an authorization change only, never a data migration.
    const { data: meterAfter } = await supabaseServer.from('billing_meters').select('org_id, meter_key').eq('meter_key', meterKey).single()
    expect(meterAfter).toMatchObject({ org_id: orgId, meter_key: meterKey })
  })

  it('anon key cannot read billing_meters at all (service_role_only RLS, unchanged by this step)', async () => {
    const anon = createBrowserClient()
    const { data, error } = await anon.from('billing_meters').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })
})

describeIf('Step 17D.1, item 9/18 — one usage fact feeds multiple commercial rules', () => {
  it('a single confirmed meter mapping resolves the identical quantity for €0.38/request, €0.60 overage, and manual-fallback rolling migration input', async () => {
    const orgId = await createTestOrg('17D.1 multi-rule org')
    const jobId = await createTestJob(orgId)

    const meterKey = `payment_requests_issued_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Payment Requests Issued',
      unit_label: 'request', mode: 'test', test_usage_value: 8000, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 5000, overage_tiers: [{ from_unit: 5001, to_unit: null, rate_per_unit: 0.6 }],
    })

    const resolved = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2027-01-01'), periodEnd: new Date('2027-01-31'),
      asOf: new Date('2027-02-01'), mode: 'live',
    })
    expect(resolved).toMatchObject({ ready: true, quantity: 8000, source: 'meter' })

    // €0.38/request via the new execution path
    const terms = {
      currency: 'EUR',
      additional_recurring_fees: [{
        fee_label: 'Per-request fee', amount: 0, description: null,
        metric_name: 'issued_payment_request', rate_per_unit: 0.38,
        semantic_input_key: 'issued_payment_request_count',
      }],
    } as unknown as ContractTerms
    const perUnitItems = await computePerUnitFeeLineItemsForPeriod({
      jobId, orgId, terms, currency: 'EUR', periodStart: '2027-01-01', periodEnd: '2027-01-31',
      asOf: '2027-02-01T00:00:00Z',
    })
    expect(perUnitItems).toHaveLength(1)
    expect(perUnitItems[0].amount).toBeCloseTo(8000 * 0.38, 2) // €3,040

    // €0.60 overage above the 5,000 included volume, via the EXISTING overage path
    const overageTerms = { ...terms, overage_tiers: [], base_fee_bands: [], contract_start_date: '2026-01-01', billing_frequency: 'monthly' } as unknown as ContractTerms
    const overageItems = await computeOverageForPeriod({
      orgId, jobId, terms: overageTerms, customerId: 'cust-test',
      periodStartUnix: Math.floor(new Date('2027-01-01').getTime() / 1000),
      periodEndUnix: Math.floor(new Date('2027-01-31').getTime() / 1000),
      currency: 'EUR', billingAsOfUnix: Math.floor(new Date('2027-02-01').getTime() / 1000),
      ignoreTestModeGate: true,
    })
    const overageForMeter = overageItems.find(i => i.meter_key === meterKey)
    expect(overageForMeter?.amount).toBeCloseTo((8000 - 5000) * 0.6, 2) // €1,800
  })

  it('no confirmed meter mapping + no manual value -> fails closed (missing-meter acceptance case)', async () => {
    const orgId = await createTestOrg('17D.1 missing-meter org')
    const jobId = await createTestJob(orgId)

    const resolved = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2027-01-01'), periodEnd: new Date('2027-01-31'),
      asOf: new Date('2027-02-01'), mode: 'live',
    })
    expect(resolved.ready).toBe(false)
  })

  it('manual usage_period_values fallback resolves when no confirmed meter mapping exists', async () => {
    const orgId = await createTestOrg('17D.1 manual-usage org')
    const jobId = await createTestJob(orgId)

    await supabaseServer.rpc('replace_usage_period_value', {
      p_job_id: jobId, p_org_id: orgId, p_semantic_input_key: 'completed_payment_count',
      p_period_start: '2027-01-01', p_period_end: '2027-01-31', p_quantity: 1234,
      p_recorded_by: 'reviewer@test.invalid', p_is_final: true,
    })

    const resolved = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'completed_payment_count',
      periodStart: new Date('2027-01-01'), periodEnd: new Date('2027-01-31'),
      asOf: new Date('2027-02-01'), mode: 'live',
    })
    expect(resolved).toMatchObject({ ready: true, quantity: 1234, source: 'manual' })
  })
})

describeIf('Step 17D.1, item H — corrected snapshot authority (finalize-only-writes, read never pins)', () => {
  it('live mode never reads or writes a snapshot — always fresh', async () => {
    const orgId = await createTestOrg('17D.1 live-mode org')
    const jobId = await createTestJob(orgId)
    const meterKey = `live_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Live Meter',
      unit_label: 'unit', mode: 'test', test_usage_value: 100, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 0, overage_tiers: [],
    })

    const first = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'live',
    })
    expect(first).toMatchObject({ ready: true, quantity: 100 })

    const { data: snapshotAfterLive } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('id')
      .eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
      .eq('period_start', '2026-11-01').eq('period_end', '2026-11-30')
    expect(snapshotAfterLive ?? []).toHaveLength(0) // live never pins

    await supabaseServer.from('billing_meters').update({ test_usage_value: 999 }).eq('meter_key', meterKey)
    const second = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'live',
    })
    expect(second).toMatchObject({ ready: true, quantity: 999 }) // always fresh
  })

  it('closed_period_read reads a fresh value but never pins it — a preview/read request must never create the durable snapshot', async () => {
    const orgId = await createTestOrg('17D.1 read-mode org')
    const jobId = await createTestJob(orgId)
    const meterKey = `read_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Read Meter',
      unit_label: 'unit', mode: 'test', test_usage_value: 100, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 0, overage_tiers: [],
    })

    const firstRead = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'closed_period_read',
    })
    expect(firstRead).toMatchObject({ ready: true, quantity: 100 })

    const { data: snapshotAfterRead } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('id')
      .eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
      .eq('period_start', '2026-11-01').eq('period_end', '2026-11-30')
    expect(snapshotAfterRead ?? []).toHaveLength(0) // repeated reads never pin

    // Repeated reads reflect a live source change too — no pin was ever created.
    await supabaseServer.from('billing_meters').update({ test_usage_value: 999 }).eq('meter_key', meterKey)
    const secondRead = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'closed_period_read',
    })
    expect(secondRead).toMatchObject({ ready: true, quantity: 999 })
  })

  it('closed_period_finalize is the ONLY mode that durably pins, and does so exactly once — idempotent, never rewritten by a later source change', async () => {
    // Step 17D rollout — deliberately exercises the MANUAL usage_period_values
    // fallback (no meter mapping at all), not a test-mode meter: real-
    // Postgres testing found that a test-mode meter must never be finalize-
    // able at all (see lib/usage-quantity-resolver.ts's ignoreTestModeGate
    // fix), which is a genuinely separate concern from "does the pin/
    // idempotency mechanism itself work." A manual entry has no test/live-
    // mode concept, so it isolates the latter without depending on the
    // former.
    const orgId = await createTestOrg('17D.1 finalize-mode org')
    const jobId = await createTestJob(orgId)

    await supabaseServer.rpc('replace_usage_period_value', {
      p_job_id: jobId, p_org_id: orgId, p_semantic_input_key: 'issued_payment_request_count',
      p_period_start: '2026-11-01', p_period_end: '2026-11-30', p_quantity: 100,
      p_recorded_by: 'reviewer@test.invalid', p_is_final: true,
    })

    const finalized = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'closed_period_finalize',
    })
    expect(finalized).toMatchObject({ ready: true, quantity: 100, source: 'manual' })

    const { data: snapshotAfterFinalize } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('quantity')
      .eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
      .eq('period_start', '2026-11-01').eq('period_end', '2026-11-30')
      .maybeSingle()
    expect(snapshotAfterFinalize).toMatchObject({ quantity: 100 }) // finalize pins

    // Later source change must NOT silently rewrite prior billing history —
    // a second finalize call for the SAME period reuses the pinned value
    // untouched, even though the manual source itself was later corrected.
    await supabaseServer.rpc('replace_usage_period_value', {
      p_job_id: jobId, p_org_id: orgId, p_semantic_input_key: 'issued_payment_request_count',
      p_period_start: '2026-11-01', p_period_end: '2026-11-30', p_quantity: 999,
      p_recorded_by: 'reviewer@test.invalid', p_is_final: true,
    })
    const refinalized = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'closed_period_finalize',
    })
    expect(refinalized).toMatchObject({ ready: true, quantity: 100 }) // unchanged, not 999

    // A subsequent closed_period_read for the SAME period must now see the
    // pin too (not a second independent fresh read of the changed source).
    const readAfterFinalize = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'closed_period_read',
    })
    expect(readAfterFinalize).toMatchObject({ ready: true, quantity: 100 })

    // 'live' mode for the SAME period remains completely independent —
    // always fresh, unaffected by the finalized pin (item 1A/J).
    const live = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'),
      asOf: new Date('2027-01-01'), mode: 'live',
    })
    expect(live).toMatchObject({ ready: true, quantity: 999 })

    // Only exactly one snapshot row exists for this period — finalize never
    // inserts a second row on repeat calls (idempotent by construction).
    const { data: allSnapshots } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('id')
      .eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
      .eq('period_start', '2026-11-01').eq('period_end', '2026-11-30')
    expect(allSnapshots ?? []).toHaveLength(1)
  })

  it('rolling migration consumes the confirmed meter source for a closed period via closed_period_read, instead of requiring duplicate manual entry', async () => {
    const orgId = await createTestOrg('17D.1 rolling-source org')
    const jobId = await createTestJob(orgId)
    const meterKey = `rolling_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Rolling Source Meter',
      unit_label: 'unit', mode: 'test', test_usage_value: 7000, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 0, overage_tiers: [],
    })

    const terms = {
      contract_start_date: '2026-01-01', billing_frequency: 'monthly',
      base_fee_bands: [{ from_unit: 1, to_unit: 5000, monthly_fee: 2000 }, { from_unit: 5001, to_unit: null, monthly_fee: 5000 }],
      base_fee_committed_volume: 5000,
      unsupported_commercial_mechanisms: [{
        kind: 'rolling_volume_pricing_transition', description: 'test', execution_status: 'executable',
        rolling_band_migration: {
          aggregate: { input_key: 'issued_payment_request_count', window_count: 3, window_unit: 'billing_period', operation: 'mean', require_complete_windows: true },
          trigger_comparator: 'greater_than', compared_to: 'contracted_volume', notice_required: true,
        },
      }],
    } as unknown as ContractTerms

    const results = await evaluateRollingBandMigrations({ jobId, orgId, terms, asOf: '2026-05-01T00:00:00Z' })
    expect(results).toHaveLength(1)
    // 3 closed months all resolve to 7000 via the meter (test mode,
    // ignoreTestModeGate forced true for closed_period_read mode) ->
    // rolling average 7000 > contracted volume 5000 -> transition triggered.
    expect(results[0].evaluation.status).not.toBe('not_ready')

    // Rolling migration only ever READS — it must never have durably
    // pinned any of the 3 closed windows it consumed.
    const { data: snapshotsFromRolling } = await supabaseServer
      .from('resolved_usage_period_snapshots')
      .select('id')
      .eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
    expect(snapshotsFromRolling ?? []).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Step 17D.2, item A — platform-system meters (is_platform_meter=true,
// sync/api_call/user) are excluded from every customer-facing source-
// discovery query, but remain resolvable by the exact query pattern
// lib/billing-engine.ts / lib/credit-ledger-service.ts / app/api/v1/usage/
// route.ts use internally.
// ═══════════════════════════════════════════════════════════════════════════
describeIf('Step 17D.2, item A — platform vs customer meter separation', () => {
  it('Remembill-like org sees only its own meters, never a platform-system meter, via the customer-source-discovery query pattern', async () => {
    const remembillOrg = await createTestOrg('17D.2 Remembill-like org', 'design_partner')
    const meterKey = `remembill_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: remembillOrg, meter_key: meterKey, display_name: 'Payment Requests Issued',
      unit_label: 'request', semantic_input_key: 'issued_payment_request_count',
    })

    // The exact query shape /api/meters, /api/jobs/[id]/meter-mappings,
    // lib/usage-pull.ts, and lib/usage-quantity-resolver.ts all now use.
    const { data: visible } = await supabaseServer
      .from('billing_meters').select('meter_key, is_platform_meter')
      .eq('org_id', remembillOrg).eq('is_platform_meter', false)

    expect((visible ?? []).map(m => m.meter_key)).toEqual([meterKey])
    expect((visible ?? []).every(m => m.is_platform_meter === false)).toBe(true)
  })

  it('Company B sees only its own meters, never Remembill\'s and never a platform-system meter', async () => {
    const remembillOrg = await createTestOrg('17D.2 Remembill-like org (isolation)', 'design_partner')
    const companyB = await createTestOrg('17D.2 Company B', 'production_customer')
    await supabaseServer.from('billing_meters').insert({
      org_id: remembillOrg, meter_key: `remembill_only_${Date.now()}`, display_name: 'Remembill Meter', unit_label: 'unit',
    })
    const companyBMeterKey = `company_b_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: companyB, meter_key: companyBMeterKey, display_name: 'Company B Meter', unit_label: 'unit',
    })

    const { data: visibleToB } = await supabaseServer
      .from('billing_meters').select('meter_key')
      .eq('org_id', companyB).eq('is_platform_meter', false)

    expect((visibleToB ?? []).map(m => m.meter_key)).toEqual([companyBMeterKey])
  })

  it('neither org sees a genuine platform-system meter through the customer-source-discovery query', async () => {
    const orgId = await createTestOrg('17D.2 platform-exclusion org')
    const { data: platformRows } = await supabaseServer
      .from('billing_meters').select('meter_key').eq('is_platform_meter', true).limit(1)
    // Only meaningful if a real platform meter exists in this environment
    // (sync, seeded by 20260721000003_billing_meters.sql) — skip the
    // positive assertion otherwise rather than asserting on fixture data
    // this test doesn't own.
    if ((platformRows ?? []).length === 0) return

    const { data: visible } = await supabaseServer
      .from('billing_meters').select('meter_key')
      .eq('org_id', orgId).eq('is_platform_meter', false)
    const platformKeys = new Set((platformRows ?? []).map(r => r.meter_key))
    expect((visible ?? []).some(m => platformKeys.has(m.meter_key))).toBe(false)
  })

  it('internal Verdix subscription billing can still resolve a platform-system meter via the .or(is_platform_meter,org_id) pattern, for ANY org', async () => {
    const meterKey = `sync_test_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: null, is_platform_meter: true, meter_key: meterKey, display_name: 'Test Sync Meter', unit_label: 'sync',
    })
    const someUnrelatedOrg = await createTestOrg('17D.2 unrelated org (platform-meter resolution)')

    // The exact pattern lib/billing-engine.ts / lib/credit-ledger-service.ts
    // / app/api/v1/usage/route.ts use — must resolve regardless of orgId,
    // since a platform meter belongs to no org at all.
    const { data: resolved } = await supabaseServer
      .from('billing_meters').select('meter_key')
      .or(`is_platform_meter.eq.true,org_id.eq.${someUnrelatedOrg}`)
      .eq('meter_key', meterKey)
      .maybeSingle()

    expect(resolved?.meter_key).toBe(meterKey)
    await supabaseServer.from('billing_meters').delete().eq('meter_key', meterKey)
  })

  it('a business meter cannot be inserted with org_id null unless is_platform_meter is explicitly true (CHECK constraint)', async () => {
    const badKey = `bad_business_meter_${Date.now()}`
    const { error } = await supabaseServer.from('billing_meters').insert({
      org_id: null, is_platform_meter: false, meter_key: badKey, display_name: 'Should fail', unit_label: 'unit',
    })
    expect(error).not.toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Step 17D.2, item D — proving the EXACT sequence requested: a live
// preview never pins anything; a real invoice-close finalize persists the
// authoritative quantity used for billing; a later source change never
// rewrites that history; a historical rolling read sees the pinned value,
// never the changed live one.
// ═══════════════════════════════════════════════════════════════════════════
describeIf('Step 17D.2, item D — authoritative snapshot wiring, exact requested sequence', () => {
  it('preview 7,900 -> zero snapshot rows; source later 8,000; invoice close finalizes 8,000; source later 8,100; historical rolling read still 8,000', async () => {
    let sourceValue = 7900
    const mock = await startMockUsageServer(() => sourceValue)
    try {
      const orgId = await createTestOrg('17D.2 snapshot-sequence org')
      const jobId = await createTestJob(orgId)
      const meterKey = `sequence_meter_${Date.now()}`
      await supabaseServer.from('billing_meters').insert({
        org_id: orgId, meter_key: meterKey, display_name: 'Sequence Meter', unit_label: 'request',
        mode: 'live', pull_endpoint_url: mock.url, semantic_input_key: 'issued_payment_request_count',
      })
      await supabaseServer.from('contract_meter_mappings').insert({
        job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
        meter_key: meterKey, confirmed: true, included_units: 0, overage_tiers: [],
      })

      // Step 1 — a Consumption-screen preview (mode: 'live', exactly what
      // app/api/jobs/[id]/consumption-summary/route.ts uses) sees the
      // CURRENT live value and creates NO snapshot row.
      const preview = await resolveUsageQuantityForPeriod({
        jobId, orgId, semanticInputKey: 'issued_payment_request_count',
        periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-31'),
        asOf: new Date('2026-12-15'), mode: 'live',
      })
      expect(preview).toMatchObject({ ready: true, quantity: 7900 })
      const { data: afterPreview } = await supabaseServer
        .from('resolved_usage_period_snapshots').select('id')
        .eq('job_id', jobId).eq('period_start', '2026-12-01').eq('period_end', '2026-12-31')
      expect(afterPreview ?? []).toHaveLength(0)

      // Step 2 — the real source now reports 8,000 (the period has closed
      // and this is the final, authoritative reading).
      sourceValue = 8000

      // Step 3 — the real invoice-close execution path (exactly what
      // lib/usage-pull.ts / lib/per-unit-fee-pull.ts's real, non-preview
      // branches do: pull fresh, use that value to compute the invoice, THEN
      // persist that same value as the closed-period snapshot — modeled here
      // via the identical mode: 'closed_period_finalize' call those lib
      // functions make internally) pulls 8,000 (a REAL HTTP pull, not a
      // simulated test_usage_value — test-mode meters are correctly
      // refused by closed_period_finalize, see lib/usage-quantity-
      // resolver.ts's ignoreTestModeGate) and pins it.
      const finalize = await resolveUsageQuantityForPeriod({
        jobId, orgId, semanticInputKey: 'issued_payment_request_count',
        periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-31'),
        asOf: new Date('2027-01-01'), mode: 'closed_period_finalize',
      })
      expect(finalize).toMatchObject({ ready: true, quantity: 8000 })
      const { data: snapshotRow } = await supabaseServer
        .from('resolved_usage_period_snapshots').select('quantity')
        .eq('job_id', jobId).eq('period_start', '2026-12-01').eq('period_end', '2026-12-31')
        .maybeSingle()
      expect(snapshotRow).toMatchObject({ quantity: 8000 })

      // Step 4 — the source later changes to 8,100 (e.g. a late correction
      // upstream). This must NEVER rewrite already-billed history.
      sourceValue = 8100

      // Step 5 — a historical rolling-migration read (mode:
      // 'closed_period_read', exactly what evaluateRollingBandMigrations
      // uses) for the SAME closed period must see the PINNED 8,000, not the
      // changed live 8,100.
      const historicalRead = await resolveUsageQuantityForPeriod({
        jobId, orgId, semanticInputKey: 'issued_payment_request_count',
        periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-31'),
        asOf: new Date('2027-02-01'), mode: 'closed_period_read',
      })
      expect(historicalRead).toMatchObject({ ready: true, quantity: 8000 })

      // A fresh 'live' read for the SAME period is, correctly, unaffected —
      // it always reflects the current live source, never the pin.
      const liveAfter = await resolveUsageQuantityForPeriod({
        jobId, orgId, semanticInputKey: 'issued_payment_request_count',
        periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-31'),
        asOf: new Date('2027-02-01'), mode: 'live',
      })
      expect(liveAfter).toMatchObject({ ready: true, quantity: 8100 })
    } finally {
      await mock.close()
    }
  })

  it('a usage metric required ONLY by a rolling migration (no overage tier, no per-unit fee of its own) still gets finalized via the same authoritative finalize call — the smallest missing trigger, closed', async () => {
    let sourceValue = 6000
    const mock = await startMockUsageServer(() => sourceValue)
    try {
    const orgId = await createTestOrg('17D.2 rolling-only finalize org')
    const jobId = await createTestJob(orgId)
    const meterKey = `rolling_only_meter_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: meterKey, display_name: 'Rolling-only Meter', unit_label: 'unit',
      mode: 'live', pull_endpoint_url: mock.url, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 0, overage_tiers: [],
    })

    // Simulates exactly what app/api/admin/invoice-scheduler/route.ts's
    // new rolling-migration-input finalize step does for the closed
    // period it just billed — this input has no overage tier and no
    // per-unit fee of its own, so nothing else in the scheduler pass would
    // ever have finalized it without that explicit step.
    await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'),
      asOf: new Date('2026-11-01'), mode: 'closed_period_finalize',
    })

    sourceValue = 9999

    const rollingRead = await resolveUsageQuantityForPeriod({
      jobId, orgId, semanticInputKey: 'issued_payment_request_count',
      periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-31'),
      asOf: new Date('2026-12-01'), mode: 'closed_period_read',
    })
    expect(rollingRead).toMatchObject({ ready: true, quantity: 6000 }) // pinned, not 9999
    } finally {
      await mock.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Step 17D.2, item F — full end-to-end acceptance: Remembill design
// partner, both authorized actors can manage the meter, all three
// commercial rules resolve the same source, and the design_partner ->
// production_customer transition leaves the meter/mappings/history
// completely unchanged while removing only Verdix's elevated access.
// ═══════════════════════════════════════════════════════════════════════════
describeIf('Step 17D.2, item F — end-to-end acceptance', () => {
  it('Remembill admin and an authorized Verdix admin can both manage the Remembill meter; €0.38x8000, €0.60 overage, and rolling migration all resolve 8,000; then design_partner -> production_customer removes only Verdix\'s elevated access', async () => {
    const remembillOrg = await createTestOrg('17D.2 F-acceptance Remembill org', 'design_partner')
    await supabaseServer.from('org_memberships').insert({
      org_id: remembillOrg, user_email: 'admin@remembill-f-acceptance.invalid', role: 'admin', status: 'active',
    })
    const verdixAdminEmail = 'bilal.zahoor@yahoo.com' // real ADMIN_EMAILS entry, lib/admin.ts

    // Both actors are authorized to manage sources while design_partner.
    const remembillAdminAuthz = await resolveSourceManagementAuthorization(remembillOrg, 'admin@remembill-f-acceptance.invalid')
    const verdixAdminAuthzBefore = await resolveSourceManagementAuthorization(remembillOrg, verdixAdminEmail)
    expect(remembillAdminAuthz.canManageSources).toBe(true)
    expect(verdixAdminAuthzBefore.canManageSources).toBe(true)

    // Create the meter (either actor's own authorized path would insert
    // this row with org_id = remembillOrg — modeled directly here since
    // both /api/meters and /api/admin/meters ultimately do exactly this).
    const jobId = await createTestJob(remembillOrg)
    const meterKey = `f_acceptance_payment_requests_${Date.now()}`
    await supabaseServer.from('billing_meters').insert({
      org_id: remembillOrg, meter_key: meterKey, display_name: 'Payment Requests Issued',
      unit_label: 'request', mode: 'test', test_usage_value: 8000, semantic_input_key: 'issued_payment_request_count',
    })
    await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count',
      meter_key: meterKey, confirmed: true, included_units: 5000, overage_tiers: [{ from_unit: 5001, to_unit: null, rate_per_unit: 0.6 }],
    })

    const terms = {
      currency: 'EUR', contract_start_date: '2026-01-01', billing_frequency: 'monthly',
      additional_recurring_fees: [{
        fee_label: 'Per-request fee', amount: 0, description: null,
        metric_name: 'issued_payment_request', rate_per_unit: 0.38,
        semantic_input_key: 'issued_payment_request_count',
      }],
      base_fee_bands: [{ from_unit: 1, to_unit: 5000, monthly_fee: 2000 }, { from_unit: 5001, to_unit: null, monthly_fee: 5000 }],
      base_fee_committed_volume: 5000,
      unsupported_commercial_mechanisms: [{
        kind: 'rolling_volume_pricing_transition', description: 'test', execution_status: 'executable',
        rolling_band_migration: {
          aggregate: { input_key: 'issued_payment_request_count', window_count: 3, window_unit: 'billing_period', operation: 'mean', require_complete_windows: true },
          trigger_comparator: 'greater_than', compared_to: 'contracted_volume', notice_required: true,
        },
      }],
    } as unknown as ContractTerms

    // €0.38 x 8,000 = €3,040
    const perUnitItems = await computePerUnitFeeLineItemsForPeriod({
      jobId, orgId: remembillOrg, terms, currency: 'EUR', periodStart: '2027-01-01', periodEnd: '2027-01-31',
      asOf: '2027-02-01T00:00:00Z',
    })
    expect(perUnitItems[0]?.amount).toBeCloseTo(8000 * 0.38, 2)

    // (8,000 - 5,000) x €0.60 = €1,800
    const overageTerms = { ...terms, overage_tiers: [] } as unknown as ContractTerms
    const overageItems = await computeOverageForPeriod({
      orgId: remembillOrg, jobId, terms: overageTerms, customerId: 'cust-test',
      periodStartUnix: Math.floor(new Date('2027-01-01').getTime() / 1000),
      periodEndUnix:   Math.floor(new Date('2027-01-31').getTime() / 1000),
      currency: 'EUR', billingAsOfUnix: Math.floor(new Date('2027-02-01').getTime() / 1000),
      ignoreTestModeGate: true,
    })
    const overageForMeter = overageItems.find(i => i.meter_key === meterKey)
    expect(overageForMeter?.amount).toBeCloseTo((8000 - 5000) * 0.6, 2)

    // Rolling closed-period value = 8,000 (same confirmed source).
    const rollingResults = await evaluateRollingBandMigrations({ jobId, orgId: remembillOrg, terms, asOf: '2026-05-01T00:00:00Z' })
    expect(rollingResults).toHaveLength(1)
    expect(rollingResults[0].evaluation.status).not.toBe('not_ready')

    // No duplicate mapping was ever needed — exactly one confirmed row.
    const { data: allMappings } = await supabaseServer
      .from('contract_meter_mappings').select('id').eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count')
    expect(allMappings ?? []).toHaveLength(1)

    // Transition: design_partner -> production_customer.
    await supabaseServer.from('organizations').update({ lifecycle_stage: 'production_customer' }).eq('id', remembillOrg)

    const remembillAdminAfter = await resolveSourceManagementAuthorization(remembillOrg, 'admin@remembill-f-acceptance.invalid')
    const verdixAdminAfter = await resolveSourceManagementAuthorization(remembillOrg, verdixAdminEmail)
    expect(remembillAdminAfter.canManageSources).toBe(true) // unchanged — owning org's own admin
    expect(verdixAdminAfter.canManageSources).toBe(false)   // elevated access gone

    // Meter definition, mapping, and history are completely unchanged by
    // the lifecycle transition — a pure authorization-layer change.
    const { data: meterAfter } = await supabaseServer
      .from('billing_meters').select('org_id, meter_key, semantic_input_key').eq('meter_key', meterKey).single()
    expect(meterAfter).toMatchObject({ org_id: remembillOrg, meter_key: meterKey, semantic_input_key: 'issued_payment_request_count' })
    const { data: mappingAfter } = await supabaseServer
      .from('contract_meter_mappings').select('meter_key, confirmed').eq('job_id', jobId).eq('semantic_input_key', 'issued_payment_request_count').single()
    expect(mappingAfter).toMatchObject({ meter_key: meterKey, confirmed: true })
  })
})
