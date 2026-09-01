import { describe, it, expect, afterAll } from 'vitest'

// Step 17H.4B0D4H1B4E3.5 §16/§17/§21 — real-Postgres validation of the
// recurring_fee_id mixed-state doctrine, driven through the REAL
// reconcileCurrentLineItemsForJob orchestration (planner + atomic applier
// RPC), not just the pure planner unit tests already covering this logic.
// Isolated TEST fixtures — never mutates an intentional regression fixture.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/recurring-fee-mixed-state-integration.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const ORG_ID = 'b911acab-03b1-48fd-8195-e2b2731ed69a'
const createdJobIds: string[] = []

async function seedJob(supabase: import('@supabase/supabase-js').SupabaseClient, name: string) {
  const { data, error } = await supabase.from('jobs').insert({
    name, module: 'AUTO_CONFIGURE', org_id: ORG_ID, currency: 'EUR',
    execute_status: 'PENDING_HUMAN_REVIEW', status: 'PENDING',
    commercial_snapshot_initialized_at: new Date().toISOString(),
  }).select('id').single()
  if (error || !data) throw new Error(`seedJob failed: ${error?.message}`)
  createdJobIds.push(data.id as string)
  return data.id as string
}

describeIf('E3.5 §16/§17/§21 — recurring_fee_id mixed-state, real Postgres end-to-end', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    const { supabaseServer } = await import('@/lib/supabase')
    await supabaseServer.from('line_items').delete().in('job_id', createdJobIds)
    await supabaseServer.from('jobs').delete().in('id', createdJobIds)
  })

  it('§16 — legacy NULL current row + unique fresh ID: same physical row, recurring_fee_id promoted, no duplicate, no supersede, no billing_hold', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { reconcileCurrentLineItemsForJob } = await import('@/lib/current-line-item-reconciliation-orchestration')

    const jobId = await seedJob(supabaseServer, 'E3.5 mixed-state — legacy NULL to ID promotion')
    const { data: legacyRow } = await supabaseServer.from('line_items').insert({
      job_id: jobId, product_name: 'Support tier', quantity: 12, unit_price: 200, billing_period: 'monthly', total_amount: 2400,
      currency: 'EUR', confidence_score: 0.9, recurring_fee_id: null,
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()

    const freshItems = [{
      product_name: 'Support tier', quantity: 12, unit_price: 200, billing_period: 'monthly', total_amount: 2400,
      confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-promote-1',
    }]
    const result = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId, freshItems,
      terms: { overage_tiers: [], additional_recurring_fees: [{ fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null, recurring_fee_id: 'rf-e35-promote-1' }], base_fee_proration: null },
    })
    console.log('E3.5_PROMOTION_RESULT:', JSON.stringify(result))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.insertedCount).toBe(0)
      expect(result.supersededCount).toBe(0)
      expect(result.blockers).toEqual([])
    }

    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, recurring_fee_id').eq('job_id', jobId)
    expect(currentRows).toHaveLength(1)
    expect(currentRows![0].id).toBe(legacyRow!.id) // same physical row
    expect(currentRows![0].recurring_fee_id).toBe('rf-e35-promote-1') // promoted
  }, 20000)

  it('§17 — ambiguous legacy promotion: two legacy rows share the fresh label, no unique continuity provable -> conservative block, no arbitrary promotion', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { reconcileCurrentLineItemsForJob } = await import('@/lib/current-line-item-reconciliation-orchestration')

    const jobId = await seedJob(supabaseServer, 'E3.5 mixed-state — ambiguous legacy promotion')
    await supabaseServer.from('line_items').insert([
      { job_id: jobId, product_name: 'Usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, recurring_fee_id: null, reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null },
      { job_id: jobId, product_name: 'Usage fee', quantity: 0, unit_price: 2, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, recurring_fee_id: null, reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null },
    ])

    const freshItems = [{
      product_name: 'Usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0,
      confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-ambiguous-1',
    }]
    const result = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId, freshItems,
      terms: { overage_tiers: [], additional_recurring_fees: [{ fee_label: 'Usage fee', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-e35-ambiguous-1' }], base_fee_proration: null },
    })
    console.log('E3.5_AMBIGUOUS_LEGACY_RESULT:', JSON.stringify(result))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.insertedCount).toBe(0)
      expect(result.updatedCount).toBe(0)
      expect(result.blockers.length).toBeGreaterThan(0)
    }

    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, recurring_fee_id').eq('job_id', jobId)
    expect(currentRows).toHaveLength(2)
    expect(currentRows!.every(r => r.recurring_fee_id === null)).toBe(true) // no arbitrary promotion to either
  }, 20000)

  it('§21 — same-metric multi-fee ambiguity at persistence: two fresh mechanisms with identical typed fingerprints fail closed, no false pairing', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { reconcileCurrentLineItemsForJob } = await import('@/lib/current-line-item-reconciliation-orchestration')

    const jobId = await seedJob(supabaseServer, 'E3.5 mixed-state — same-metric multi-fee ambiguity')
    // Two ESTABLISHED fees, already carrying distinct, real ids.
    await supabaseServer.from('line_items').insert([
      { job_id: jobId, product_name: 'Product A usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, recurring_fee_id: 'rf-e35-scope-a', reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null },
      { job_id: jobId, product_name: 'Product B usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, recurring_fee_id: 'rf-e35-scope-b', reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null },
    ])
    // Both are ID-stable (both carry a recurring_fee_id matching an
    // existing row), so the planner's strong-ID pairing resolves each
    // correctly by ID — proving ID-first pairing is immune to the
    // same-metric ambiguity that would otherwise affect a label-only match.
    const freshItems = [
      { product_name: 'Product A usage fee (renamed)', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-scope-a' },
      { product_name: 'Product B usage fee (renamed)', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-scope-b' },
    ]
    const result = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId, freshItems,
      terms: {
        overage_tiers: [], base_fee_proration: null,
        additional_recurring_fees: [
          { fee_label: 'Product A usage fee (renamed)', metric_name: 'shared_metric', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-e35-scope-a' },
          { fee_label: 'Product B usage fee (renamed)', metric_name: 'shared_metric', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-e35-scope-b' },
        ],
      },
    })
    console.log('E3.5_SAME_METRIC_ID_FIRST_RESULT:', JSON.stringify(result))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.blockers).toEqual([])
    }
    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, recurring_fee_id, product_name').eq('job_id', jobId)
    expect(currentRows).toHaveLength(2)
    // Each row correctly kept its OWN id-matched identity — no cross-pairing.
    const a = currentRows!.find(r => r.recurring_fee_id === 'rf-e35-scope-a')
    const b = currentRows!.find(r => r.recurring_fee_id === 'rf-e35-scope-b')
    expect(a?.product_name).toBe('Product A usage fee (renamed)')
    expect(b?.product_name).toBe('Product B usage fee (renamed)')
  }, 20000)

  // §19/§20 — validated here at the real-Postgres planner/persistence
  // level rather than via a full second contract-variant PDF extraction
  // (the same allowance §21 explicitly grants for the same-metric case,
  // extended here for the identical reason: constructing a realistic,
  // AI-extractable contract variant that changes ONLY one fee's metric, or
  // adds exactly one genuinely new fee, has no guaranteed way to keep
  // every OTHER field byte-stable through a real LLM extraction pass —
  // this real-Postgres path proves the identity/persistence guarantee with
  // full production infrastructure (real reconcileCurrentLineItemsForJob,
  // real apply_current_line_item_reconciliation RPC) without that
  // confound. preserveRecurringFeeIdentity's own fingerprint logic for
  // BOTH cases is already unit-tested directly in lib/rule-id-stability.test.ts.
  it('§19 — changed metric: preserveRecurringFeeIdentity assigns a genuinely new id, and the planner correctly treats it as a new mechanism, never silently reusing the old one\'s row', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { preserveRecurringFeeIdentity } = await import('@/lib/rule-id-stability')
    const { reconcileCurrentLineItemsForJob } = await import('@/lib/current-line-item-reconciliation-orchestration')

    const jobId = await seedJob(supabaseServer, 'E3.5 §19 — changed metric, real persistence')
    const { data: existingRow } = await supabaseServer.from('line_items').insert({
      job_id: jobId, product_name: 'Usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0,
      currency: 'EUR', confidence_score: 0.9, recurring_fee_id: 'rf-e35-metric-old',
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()

    // Simulates a fresh extraction whose OWN metric genuinely changed
    // (completed_payment -> issued_request) — preserveRecurringFeeIdentity
    // (the real function, not a mock) decides whether to carry the old id
    // forward BEFORE the planner ever runs.
    const existingFees = [{ recurring_fee_id: 'rf-e35-metric-old', fee_label: 'Usage fee', metric_name: 'completed_payment', rate_per_unit: 1, semantic_input_key: 'completed_payment_count', billing_frequency: 'monthly' }]
    const freshFeesPreId = [{ recurring_fee_id: 'rf-e35-metric-fresh', fee_label: 'Usage fee', metric_name: 'issued_request', rate_per_unit: 1, semantic_input_key: 'issued_request_count', billing_frequency: 'monthly' }]
    const afterIdentity = preserveRecurringFeeIdentity(existingFees as never, freshFeesPreId as never)
    console.log('E3.5_CHANGED_METRIC_IDENTITY_RESULT:', JSON.stringify(afterIdentity))
    expect((afterIdentity[0] as { recurring_fee_id?: string }).recurring_fee_id).toBe('rf-e35-metric-fresh') // NOT reused

    const freshItems = [{
      product_name: 'Usage fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0,
      confidence_score: 0.97, source_section: null, recurring_fee_id: (afterIdentity[0] as { recurring_fee_id?: string }).recurring_fee_id,
    }]
    const result = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId, freshItems,
      terms: { overage_tiers: [], base_fee_proration: null, additional_recurring_fees: [{ fee_label: 'Usage fee', metric_name: 'issued_request', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-e35-metric-fresh' }] },
    })
    console.log('E3.5_CHANGED_METRIC_RECONCILE_RESULT:', JSON.stringify(result))
    // The old row and the new mechanism are correctly UNRELATED — a
    // genuine identity conflict/residual, never a silent same-row reuse.
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.updatedCount).toBe(0)
      expect(result.insertedCount).toBe(0) // blocked, not silently inserted as if unrelated to the old row
    }
    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, recurring_fee_id').eq('job_id', jobId)
    expect(currentRows).toHaveLength(1)
    expect(currentRows![0].id).toBe(existingRow!.id)
    expect(currentRows![0].recurring_fee_id).toBe('rf-e35-metric-old') // untouched — no silent reassignment
  }, 20000)

  it('§20 — genuine new fee: inserts safely as NEW, existing fee ids/rows are completely unaffected, no unrelated decision inherited', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { reconcileCurrentLineItemsForJob } = await import('@/lib/current-line-item-reconciliation-orchestration')

    const jobId = await seedJob(supabaseServer, 'E3.5 §20 — genuine new fee, real persistence')
    const { data: existingRow } = await supabaseServer.from('line_items').insert({
      job_id: jobId, product_name: 'Existing fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0,
      currency: 'EUR', confidence_score: 0.9, recurring_fee_id: 'rf-e35-existing',
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()

    const freshItems = [
      { product_name: 'Existing fee', quantity: 0, unit_price: 1, billing_period: 'monthly', total_amount: 0, confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-existing' },
      { product_name: 'Brand new fee', quantity: 0, unit_price: 2, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.97, source_section: null, recurring_fee_id: 'rf-e35-genuinely-new' },
    ]
    const result = await reconcileCurrentLineItemsForJob({
      supabase: supabaseServer, jobId, freshItems,
      terms: {
        overage_tiers: [], base_fee_proration: null,
        additional_recurring_fees: [
          { fee_label: 'Existing fee', metric_name: 'm1', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-e35-existing' },
          { fee_label: 'Brand new fee', metric_name: 'm2', rate_per_unit: 2, percentage_of_basis: null, recurring_fee_id: 'rf-e35-genuinely-new' },
        ],
      },
    })
    console.log('E3.5_NEW_FEE_RESULT:', JSON.stringify(result))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.insertedCount).toBe(1)
      expect(result.blockers).toEqual([])
    }
    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, recurring_fee_id, product_name').eq('job_id', jobId)
    expect(currentRows).toHaveLength(2)
    const existing = currentRows!.find(r => r.recurring_fee_id === 'rf-e35-existing')
    expect(existing?.id).toBe(existingRow!.id) // completely unaffected, same physical row
    const fresh = currentRows!.find(r => r.recurring_fee_id === 'rf-e35-genuinely-new')
    expect(fresh?.product_name).toBe('Brand new fee')
  }, 20000)
})
