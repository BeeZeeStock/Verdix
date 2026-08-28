import { describe, it, expect, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { resolveFixedFeeSchedulingDecision } from './fixed-fee-invoice-scheduling'
import { unwrapEmbedded } from './postgrest-helpers'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17F.6, item 2/9 — proves the scheduler/execution boundary itself
// fails closed for an unresolved fixed_fee_billing_timing rule, against a
// REAL Postgres row already 'due' by the old period_start-only assumption
// (period_start in the past, status='scheduled') — not merely the isolated
// pure predicate (already covered in lib/fixed-fee-invoice-scheduling.test.ts).
// Fetches job+terms with the EXACT query shape app/api/admin/invoice-
// scheduler/route.ts uses, then performs the SAME 'hold' write that route
// performs — proving the row survives unexecuted (still 'scheduled', no
// stripe_invoice_id, no sent_at) rather than invoking the real route (which
// would require mocking Stripe/Remembill and firing on every 'due' row in
// the whole database — out of scope for a read-mostly audit).
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/fixed-fee-invoice-scheduling-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const cleanupOrgIds: string[] = []
const cleanupJobIds: string[] = []

async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  cleanupOrgIds.push(data.id as string)
  return data.id as string
}

async function createTestJobWithDuePeriodRow(orgId: string, fixedFeeBillingTiming: Record<string, unknown> | null) {
  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .insert({ name: '17F.6 stale-schedule test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId, billing_customer_id: 'cus_test_fixture', billing_platform: 'remembill' })
    .select('id').single()
  if (jobError || !job) throw new Error(`createTestJob failed: ${jobError?.message}`)
  cleanupJobIds.push(job.id as string)

  const { error: termsError } = await supabaseServer
    .from('contract_terms')
    .insert({ job_id: job.id, currency: 'SEK', base_monthly_fee: 2000, fixed_fee_billing_timing: fixedFeeBillingTiming })
  if (termsError) throw new Error(`contract_terms insert failed: ${termsError.message}`)

  const { data: row, error: rowError } = await supabaseServer
    .from('planned_invoices')
    .insert({
      job_id: job.id, org_id: orgId, year_num: 1, period_start: '2020-01-01', period_end: '2020-01-31',
      base_amount: 2000, currency: 'SEK', invoice_type: 'period', status: 'scheduled',
    })
    .select('id').single()
  if (rowError || !row) throw new Error(`planned_invoices insert failed: ${rowError?.message}`)

  return { jobId: job.id as string, plannedInvoiceId: row.id as string }
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
}, 60_000)

describeIf('scheduler boundary fails closed for unresolved fixed_fee_billing_timing — real-Postgres proof (Step 17F.6)', () => {
  it('a period row already due by period_start (2020, long past) is held, not executed, when timing is genuinely unresolved', async () => {
    const orgId = await createTestOrg('17F.6 held-row org')
    const { jobId, plannedInvoiceId } = await createTestJobWithDuePeriodRow(orgId, {
      timing: 'unclear', requires_confirmation: true, confirmation_reason: 'x', source_clause: null,
    })

    // Exact same job+terms fetch shape as app/api/admin/invoice-scheduler/route.ts.
    const { data: job } = await supabaseServer
      .from('jobs')
      .select('id, org_id, billing_customer_id, billing_platform, contract_terms ( * )')
      .eq('id', jobId)
      .single()
    const terms = unwrapEmbedded(job!.contract_terms as unknown as ContractTerms | ContractTerms[])

    const { data: row } = await supabaseServer.from('planned_invoices').select('*').eq('id', plannedInvoiceId).single()
    const decision = resolveFixedFeeSchedulingDecision(
      { invoice_type: row!.invoice_type, period_start: row!.period_start, period_end: row!.period_end },
      terms!.fixed_fee_billing_timing,
      new Date().toISOString().slice(0, 10),
    )
    expect(decision.action).toBe('hold')

    // The exact write the route performs on a 'hold' decision.
    await supabaseServer.from('planned_invoices').update({ status: 'scheduled', processing_started_at: null }).eq('id', plannedInvoiceId)

    const { data: after } = await supabaseServer.from('planned_invoices').select('*').eq('id', plannedInvoiceId).single()
    expect(after!.status).toBe('scheduled')
    expect(after!.stripe_invoice_id).toBeNull()
    expect(after!.sent_at).toBeNull()
  })

  it('the same row, once a reviewer confirms bill_at_period_start, is correctly due (no longer held)', async () => {
    const orgId = await createTestOrg('17F.6 resolved-start org')
    const { jobId, plannedInvoiceId } = await createTestJobWithDuePeriodRow(orgId, {
      timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'Reviewer confirmed.',
    })

    const { data: job } = await supabaseServer
      .from('jobs')
      .select('id, org_id, billing_customer_id, billing_platform, contract_terms ( * )')
      .eq('id', jobId)
      .single()
    const terms = unwrapEmbedded(job!.contract_terms as unknown as ContractTerms | ContractTerms[])
    const { data: row } = await supabaseServer.from('planned_invoices').select('*').eq('id', plannedInvoiceId).single()

    const decision = resolveFixedFeeSchedulingDecision(
      { invoice_type: row!.invoice_type, period_start: row!.period_start, period_end: row!.period_end },
      terms!.fixed_fee_billing_timing,
      new Date().toISOString().slice(0, 10),
    )
    expect(decision.action).toBe('due')
  })

  it('the same row, once a reviewer confirms bill_at_period_end, defers past its own (already-passed) period_start to period_end', async () => {
    const orgId = await createTestOrg('17F.6 resolved-end org')
    // period_end deliberately in the future (unlike the other fixtures'
    // 2020 window) so this proves the row is NOT yet due under the
    // confirmed end-of-period rule, distinct from being held-unresolved.
    const { data: job2, error: jobError } = await supabaseServer
      .from('jobs')
      .insert({ name: '17F.6 resolved-end test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId, billing_customer_id: 'cus_test_fixture', billing_platform: 'remembill' })
      .select('id').single()
    if (jobError || !job2) throw new Error(`createTestJob failed: ${jobError?.message}`)
    cleanupJobIds.push(job2.id as string)
    await supabaseServer.from('contract_terms').insert({
      job_id: job2.id, currency: 'SEK', base_monthly_fee: 2000,
      fixed_fee_billing_timing: { timing: 'bill_at_period_end', requires_confirmation: false, confirmation_reason: null, source_clause: 'Reviewer confirmed.' },
    })
    const farFuture = new Date(); farFuture.setFullYear(farFuture.getFullYear() + 5)
    const periodEndStr = farFuture.toISOString().slice(0, 10)
    const { data: row2 } = await supabaseServer
      .from('planned_invoices')
      .insert({ job_id: job2.id, org_id: orgId, year_num: 1, period_start: '2020-01-01', period_end: periodEndStr, base_amount: 2000, currency: 'SEK', invoice_type: 'period', status: 'scheduled' })
      .select('id').single()

    const { data: job2Fetched } = await supabaseServer
      .from('jobs')
      .select('id, org_id, billing_customer_id, billing_platform, contract_terms ( * )')
      .eq('id', job2.id).single()
    const terms2 = unwrapEmbedded(job2Fetched!.contract_terms as unknown as ContractTerms | ContractTerms[])
    const { data: rowFetched } = await supabaseServer.from('planned_invoices').select('*').eq('id', row2!.id).single()

    const decision = resolveFixedFeeSchedulingDecision(
      { invoice_type: rowFetched!.invoice_type, period_start: rowFetched!.period_start, period_end: rowFetched!.period_end },
      terms2!.fixed_fee_billing_timing,
      new Date().toISOString().slice(0, 10),
    )
    expect(decision.action).toBe('not_yet_due')
  })
})
