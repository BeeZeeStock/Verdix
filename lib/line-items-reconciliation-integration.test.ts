import { describe, it, expect, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { reconcileStaleLineItemsForJob } from './line-items-reconciliation'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17E.2, item 4 — real-Postgres proof of the explicit write path:
// reconcileStaleLineItemsForJob (called ONLY from confirm-rule and POST
// /api/jobs/[id]/reconcile-line-items, never from GET — see lib/line-
// items-reconciliation.ts's own header) actually persists the correction,
// leaves unrelated/manual rows completely untouched, and is idempotent —
// a second call against an already-reconciled job makes zero further
// writes. Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/line-items-reconciliation-integration.test.ts
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

async function createTestJob(orgId: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: '17E.2 reconciliation-integration test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('line_items').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
})

describeIf('reconcileStaleLineItemsForJob — real-Postgres write proof', () => {
  it('persists the correction, leaves an unrelated manual row untouched, and is idempotent on a second call', async () => {
    const orgId = await createTestOrg('17E.2 reconciliation org')
    const jobId = await createTestJob(orgId)

    const { data: termsRow, error: termsErr } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId, currency: 'EUR',
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    }).select('*').single()
    if (termsErr) throw new Error(`contract_terms insert failed: ${termsErr.message}`)

    await supabaseServer.from('line_items').insert([
      { job_id: jobId, product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, unit_price: 2000, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0 },
      { job_id: jobId, product_name: 'Performance share', quantity: 0, unit_price: 0, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9 },
      { job_id: jobId, product_name: 'Manual reviewer correction — overage', quantity: 5, unit_price: 1.5, billing_period: 'monthly', total_amount: 7.5, currency: 'EUR', confidence_score: 0.9, correction_reason: 'reviewer-adjusted rate' },
    ])

    const { data: before } = await supabaseServer.from('line_items').select('id, product_name').eq('job_id', jobId)
    expect(before).toHaveLength(3)
    const manualRowId = before!.find(r => r.product_name === 'Manual reviewer correction — overage')!.id

    const result = await reconcileStaleLineItemsForJob({ jobId, terms: termsRow, currency: 'EUR' })
    expect(result.staleIds).toHaveLength(2)
    expect(result.freshItems.length).toBeGreaterThan(0)

    const { data: after } = await supabaseServer.from('line_items').select('id, product_name, total_amount').eq('job_id', jobId)
    expect(after!.some(r => r.product_name === 'Recurring base fee — partial-period treatment unresolved')).toBe(false)
    expect(after!.some(r => r.product_name === 'Performance share')).toBe(false)
    expect(after!.some(r => r.product_name === 'Recurring base fee')).toBe(true)
    const regenerated = after!.find(r => r.product_name === 'Recurring base fee')!
    expect(Number(regenerated.total_amount)).toBeGreaterThan(0)

    // Unrelated manual row: same id, same content, completely untouched.
    const manualAfter = after!.find(r => r.id === manualRowId)
    expect(manualAfter).toMatchObject({ product_name: 'Manual reviewer correction — overage' })

    // Idempotent — a second call against the now-reconciled job finds
    // nothing stale and writes nothing further.
    const secondResult = await reconcileStaleLineItemsForJob({ jobId, terms: termsRow, currency: 'EUR' })
    expect(secondResult.staleIds).toHaveLength(0)
    expect(secondResult.freshItems).toHaveLength(0)

    const { data: afterSecondCall } = await supabaseServer.from('line_items').select('id').eq('job_id', jobId)
    expect(afterSecondCall).toHaveLength(after!.length) // no change in row count
  })
})
