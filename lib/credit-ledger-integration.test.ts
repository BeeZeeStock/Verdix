import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests for the reserve_credit_balance RPC's actual atomicity —
// Postgres advisory locks are a real database feature, not something a JS
// mock can meaningfully verify, so these run against the real (post-
// migration) database using the service-role client, exactly like
// lib/rls-isolation.test.ts's pattern. Self-contained: creates its own
// scratch job/planned_invoices/credit_ledger_entries rows and cleans them up
// regardless of pass/fail, touching nothing else in the database.
//
// SKIPPED BY DEFAULT. Run after applying supabase/migrations/20260821000001_credit_ledger.sql:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/credit-ledger-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

describeIf('reserve_credit_balance — real Postgres atomicity', () => {
  let orgId: string
  let jobId: string
  const creditRuleId = `integration-test-${Date.now()}`
  const invoiceIds: string[] = []

  beforeAll(async () => {
    const slug = `credit-ledger-integration-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'credit-ledger-integration-test-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'credit-ledger-integration-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    // A confirmed SEK 100,000 balance, already earned and available (window
    // closed well in the past relative to any test period_start used below).
    await supabaseServer.from('credit_ledger_entries').insert({
      job_id: jobId, org_id: orgId, credit_rule_id: creditRuleId, entry_type: 'earn',
      window_start: '2026-01-01', window_end: '2026-01-31', amount_minor: 10_000_000, currency: 'SEK',
    })
  })

  afterAll(async () => {
    await supabaseServer.from('credit_ledger_entries').delete().eq('job_id', jobId)
    await supabaseServer.from('planned_invoices').delete().in('id', invoiceIds)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  async function makeInvoice(): Promise<string> {
    const { data } = await supabaseServer.from('planned_invoices').insert({
      job_id: jobId, org_id: orgId, period_start: '2026-02-01', period_end: '2026-02-28',
      base_amount: 0, currency: 'SEK', invoice_type: 'period', status: 'scheduled',
    }).select('id').single()
    invoiceIds.push(data!.id)
    return data!.id
  }

  it('reserves the requested amount when balance allows it', async () => {
    const invoiceId = await makeInvoice()
    const { data, error } = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceId,
      p_period_start: '2026-02-01', p_requested_amount_minor: 4_000_000, p_currency: 'SEK',
      p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
    })
    expect(error).toBeNull()
    // reserve_credit_balance returns `setof credit_ledger_entries` — a real
    // reservation yields exactly one row; a zero-amount no-op yields [].
    expect(data?.[0]?.amount_minor).toBe(4_000_000)
    expect(data?.[0]?.status).toBe('reserved')
  })

  it('recalculation safety — a second call for the same planned_invoice_id after it is applied returns the identical stored amount', async () => {
    const invoiceId = await makeInvoice()
    const first = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceId,
      p_period_start: '2026-02-01', p_requested_amount_minor: 1_000_000, p_currency: 'SEK',
      p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
    })
    await supabaseServer.from('credit_ledger_entries').update({ status: 'applied' }).eq('id', first.data?.[0]?.id)

    const second = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceId,
      p_period_start: '2026-02-01', p_requested_amount_minor: 9_999_999, p_currency: 'SEK', // deliberately different request
      p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
    })
    expect(second.data?.[0]?.id).toBe(first.data?.[0]?.id)
    expect(second.data?.[0]?.amount_minor).toBe(1_000_000) // unchanged — never recomputed for an already-applied invoice
  })

  it('released -> reserved reuse: a released row is reclaimed by a later retry with a freshly-computed amount', async () => {
    const invoiceId = await makeInvoice()
    const first = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceId,
      p_period_start: '2026-02-01', p_requested_amount_minor: 2_000_000, p_currency: 'SEK',
      p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
    })
    await supabaseServer.from('credit_ledger_entries').update({ status: 'released' }).eq('id', first.data?.[0]?.id)

    const retry = await supabaseServer.rpc('reserve_credit_balance', {
      p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceId,
      p_period_start: '2026-02-01', p_requested_amount_minor: 3_000_000, p_currency: 'SEK',
      p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
    })
    expect(retry.data?.[0]?.id).toBe(first.data?.[0]?.id) // same row reused, not a new insert
    expect(retry.data?.[0]?.status).toBe('reserved')
    expect(retry.data?.[0]?.amount_minor).toBe(3_000_000) // recomputed fresh, not the stale 2,000,000
  })

  it('cross-invoice concurrency: two different invoices concurrently requesting 70,000 each against a 100,000 balance never together reserve more than 100,000', async () => {
    const [invoiceA, invoiceB] = await Promise.all([makeInvoice(), makeInvoice()])
    const [resA, resB] = await Promise.all([
      supabaseServer.rpc('reserve_credit_balance', {
        p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceA,
        p_period_start: '2026-02-01', p_requested_amount_minor: 7_000_000, p_currency: 'SEK',
        p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
      }),
      supabaseServer.rpc('reserve_credit_balance', {
        p_job_id: jobId, p_credit_rule_id: creditRuleId, p_planned_invoice_id: invoiceB,
        p_period_start: '2026-02-01', p_requested_amount_minor: 7_000_000, p_currency: 'SEK',
        p_details: {}, p_is_one_time: false, p_source_clause: null, p_commercial_rule_interpretation_id: null,
      }),
    ])
    const totalReserved = (resA.data?.[0]?.amount_minor ?? 0) + (resB.data?.[0]?.amount_minor ?? 0)
    // The exact split depends on which call's advisory lock wins the race,
    // but the total must never exceed whatever balance genuinely exists —
    // this test's own beforeAll seed (100,000) minus whatever earlier tests
    // in this file already reserved from the same shared credit_rule_id.
    const { data: allApplications } = await supabaseServer
      .from('credit_ledger_entries')
      .select('amount_minor')
      .eq('job_id', jobId).eq('credit_rule_id', creditRuleId).eq('entry_type', 'application')
      .in('status', ['reserved', 'applied'])
    const totalEverReserved = (allApplications ?? []).reduce((s, r) => s + r.amount_minor, 0)
    expect(totalEverReserved).toBeLessThanOrEqual(10_000_000) // the seeded balance — the hard guarantee
    expect(totalReserved).toBeGreaterThan(0) // at least one of the two got something
  })
})
