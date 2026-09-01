import { describe, it, expect, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { loadDashboardBillingActions } from './dashboard-billing-actions'

// ═══════════════════════════════════════════════════════════════════════════
// Step E9C.1 §11/§20 — real-Postgres proof that loadDashboardBillingActions
// cannot leak a second organization's contracts into the calling org's
// Billing Actions queue. Every query in that file is scoped through a
// `jobIds` allowlist itself derived from a single `.eq('org_id', orgId)`
// query — this test proves that chain holds end to end against a REAL
// database, not just by reading the code (the same discipline this
// session's other RLS-integration tests use — see lib/performance-share-
// pull-integration.test.ts's identical header/rationale).
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/dashboard-billing-actions-org-isolation.test.ts
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

async function createTestJob(orgId: string, name: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name, module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
}, 60_000)

describeIf('loadDashboardBillingActions — org isolation (Step E9C.1 §11/§20)', () => {
  it('Org A never sees Org B\'s parked/failed invoices or draft manual inputs', async () => {
    const orgAId = await createTestOrg('E9C1 isolation org A')
    const orgBId = await createTestOrg('E9C1 isolation org B')
    const jobAId = await createTestJob(orgAId, 'E9C.1 isolation job A')
    const jobBId = await createTestJob(orgBId, 'E9C.1 isolation job B')

    // Org B: one held (PARKED) period invoice, one FAILED invoice, one
    // draft (unfinalized) operational input — every source
    // loadDashboardBillingActions reads from.
    const { error: parkedErr } = await supabaseServer.from('planned_invoices').insert({
      job_id: jobBId, org_id: orgBId, period_start: '2026-01-01', period_end: '2026-01-31',
      base_amount: 1000, currency: 'SEK', invoice_type: 'period', status: 'scheduled',
      error_message: 'Held: [performance_input] missing required input',
    })
    if (parkedErr) throw new Error(`seed parked failed: ${parkedErr.message}`)

    const { error: failedErr } = await supabaseServer.from('planned_invoices').insert({
      job_id: jobBId, org_id: orgBId, period_start: '2026-02-01', period_end: '2026-02-28',
      base_amount: 1000, currency: 'SEK', invoice_type: 'period', status: 'failed',
      error_message: '[currency_mismatch] mismatch',
    })
    if (failedErr) throw new Error(`seed failed failed: ${failedErr.message}`)

    const { error: inputErr } = await supabaseServer.rpc('replace_operational_input_period_value', {
      p_job_id: jobBId, p_org_id: orgBId, p_input_key: 'paid_invoice_value',
      p_period_start: '2026-01-01', p_period_end: '2026-01-31',
      p_value: 100, p_currency: 'SEK', p_recorded_by: 'isolation-test@verdix.internal', p_is_final: false,
    })
    if (inputErr) throw new Error(`seed draft input failed: ${inputErr.message}`)

    // Org A has NO planned_invoices / operational_input_period_values rows
    // at all — jobAId exists purely so loadDashboardBillingActions has a
    // real (empty) org to query against, proving an empty result isn't
    // just "no jobs found" but genuinely "no cross-org leakage."
    void jobAId

    const orgAActions = await loadDashboardBillingActions(orgAId)

    expect(orgAActions).toHaveLength(0)
    expect(orgAActions.some(a => a.jobId === jobBId)).toBe(false)
    expect(orgAActions.some(a => a.customerName.includes('isolation job B'))).toBe(false)

    // Sanity check the fixture itself is real and detectable — Org B's
    // OWN query must see its own actions, proving the empty Org-A result
    // above is isolation, not a broken fixture / broken query.
    const orgBActions = await loadDashboardBillingActions(orgBId)
    expect(orgBActions.some(a => a.jobId === jobBId && a.actionType === 'invoice_parked')).toBe(true)
    expect(orgBActions.some(a => a.jobId === jobBId && a.actionType === 'invoice_failed')).toBe(true)
  }, 30_000)
})
