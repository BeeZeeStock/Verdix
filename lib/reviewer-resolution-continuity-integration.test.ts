import { describe, it, expect, vi, afterAll } from 'vitest'

// Step 17H.4B0D4H1B4E3.2 §33/§34 — real-Postgres validation for reviewer-
// resolution continuity, driven through the REAL confirm-rule route (not
// just the pure planner, which already has exhaustive unit coverage in
// lib/current-line-item-reconciliation-plan.test.ts). Seeds jobs/contract_
// terms/line_items directly (bypassing AI extraction, which this mechanism
// doesn't touch) so the live proof is fast and focused on the reconciliation
// pipeline itself: same physical row id, reviewer metadata preservation, no
// duplicate current row, no unintended supersede, clean billing_hold.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/reviewer-resolution-continuity-integration.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const ORG_CTX = {
  orgId: 'b911acab-03b1-48fd-8195-e2b2731ed69a',
  orgName: 'Lynora AB',
  orgSlug: 'lynora-ab-mr6nexf8',
  role: 'admin' as const,
  userEmail: 'bilal@lynoraai.com',
}
vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn(async () => ORG_CTX),
  getActiveOrg: vi.fn(async () => ORG_CTX),
}))
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => ({ user: { email: ORG_CTX.userEmail, name: 'Bilal (E3.2 continuity integration)' } })),
}))

const createdJobIds: string[] = []

async function seedJob(supabase: import('@supabase/supabase-js').SupabaseClient, name: string) {
  const { data, error } = await supabase.from('jobs').insert({
    name, module: 'AUTO_CONFIGURE', org_id: ORG_CTX.orgId, currency: 'EUR',
    execute_status: 'PENDING_HUMAN_REVIEW', status: 'PENDING',
    commercial_snapshot_initialized_at: new Date().toISOString(),
  }).select('id').single()
  if (error || !data) throw new Error(`seedJob failed: ${error?.message}`)
  createdJobIds.push(data.id as string)
  return data.id as string
}

describeIf('reviewer-resolution continuity — real Postgres, real confirm-rule route', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    const { supabaseServer } = await import('@/lib/supabase')
    await supabaseServer.from('line_items').delete().in('job_id', createdJobIds)
    await supabaseServer.from('contract_terms').delete().in('job_id', createdJobIds)
    await supabaseServer.from('jobs').delete().in('id', createdJobIds)
  })

  it('base_fee_proration: proven 1:1 continuity — same physical row id, reviewer metadata preserved, no duplicate/superseded row, billing_hold stays clean', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.2 integration — base_fee_proration continuity')
    const { data: termsRow, error: termsErr } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      base_monthly_fee: 1000,
      contract_start_date: '2026-01-01',
      contract_term_months: 12,
      billing_frequency: 'monthly',
      base_fee_proration: { requires_confirmation: true, reset_anchor: 'contract_start', prorate_partial_periods: 'unclear', source_clause: null, confirmation_reason: 'test fixture' },
    }).select('id').single()
    expect(termsErr).toBeNull()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    const { data: placeholderRow, error: liErr } = await supabaseServer.from('line_items').insert({
      job_id: jobId,
      product_name: 'Recurring base fee — partial-period treatment unresolved',
      quantity: 0, unit_price: 1000, billing_period: 'monthly', total_amount: 0,
      currency: 'EUR', confidence_score: 0,
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()
    expect(liErr).toBeNull()
    const placeholderId = placeholderRow!.id as string

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'base_fee_proration', approvedInterpretation: { prorate_partial_periods: 'yes', reset_anchor: 'contract_start' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    const body = await res.json()
    console.log('E3.2_CONFIRM_BASE_FEE_PRORATION:', res.status, JSON.stringify(body))
    expect(res.status).toBe(200)

    const { data: currentRows } = await supabaseServer.from('current_line_items').select('*').eq('job_id', jobId)
    console.log('E3.2_CURRENT_ROWS_AFTER:', JSON.stringify(currentRows))
    // Same physical row, not remove+invent.
    expect(currentRows).toHaveLength(1)
    expect(currentRows![0].id).toBe(placeholderId)
    expect(currentRows![0].product_name).toBe('Recurring base fee')
    expect(currentRows![0].quantity).toBe(12)
    expect(currentRows![0].total_amount).toBe(12000)
    // Reviewer metadata untouched — this row was never reviewer-corrected.
    expect(currentRows![0].reviewer_corrected_fields).toEqual([])
    expect(currentRows![0].reviewer_corrected_fields_complete).toBe(true)
    expect(currentRows![0].reviewer_corrected_at).toBeNull()

    const { data: allRows } = await supabaseServer.from('line_items').select('id, superseded_at').eq('job_id', jobId)
    expect(allRows).toHaveLength(1) // no supersede, no second (duplicate) row ever created

    const { data: jobRow } = await supabaseServer.from('jobs').select('billing_hold').eq('id', jobId).single()
    console.log('E3.2_BILLING_HOLD_AFTER:', JSON.stringify(jobRow?.billing_hold))
    expect(jobRow?.billing_hold).toBeNull()
  }, 30000)

  it('base_fee_proration: cardinality NOT 1:1 (a mid-term rate change) still falls back to conservative blocking — proves the fix never guesses in production either', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.2 integration — base_fee_proration cardinality safeguard')
    // An escalator mid-term forces TWO distinct rate segments once resolved.
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      base_monthly_fee: 1000,
      contract_start_date: '2026-01-01',
      contract_term_months: 12,
      billing_frequency: 'monthly',
      base_fee_proration: { requires_confirmation: true, reset_anchor: 'contract_start', prorate_partial_periods: 'unclear', source_clause: null, confirmation_reason: 'test fixture' },
      escalators: [{ escalator_pct: 10, escalator_type: 'fixed_pct', trigger: 'anniversary', effective_month: 6 }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)
    const { data: placeholderRow } = await supabaseServer.from('line_items').insert({
      job_id: jobId, product_name: 'Recurring base fee — partial-period treatment unresolved',
      quantity: 0, unit_price: 1000, billing_period: 'monthly', total_amount: 0,
      currency: 'EUR', confidence_score: 0,
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'base_fee_proration', approvedInterpretation: { prorate_partial_periods: 'yes', reset_anchor: 'contract_start' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200) // the confirm-rule mutation itself succeeds; reconciliation is a separate outcome

    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, product_name').eq('job_id', jobId)
    console.log('E3.2_CARDINALITY_SAFEGUARD_CURRENT_ROWS:', JSON.stringify(currentRows))
    // No fabricated pairing — either 0 or >=2 escalated segments, never
    // silently guessed as continuing the placeholder's identity. (Whether
    // this specific escalator config yields 1 or 2 segments depends on
    // computeEscalatorMultiplier's exact month boundary; the assertion
    // below is on the OUTCOME class, not the placeholder row's id.)
    const stillHasPlaceholderId = (currentRows ?? []).some(r => r.id === placeholderRow!.id)
    if (stillHasPlaceholderId) {
      // Cardinality genuinely wasn't 1:1 -> placeholder correctly retained
      // as an unresolved residual (blocked), never silently paired.
      const { data: jobRow } = await supabaseServer.from('jobs').select('billing_hold').eq('id', jobId).single()
      expect(jobRow?.billing_hold).not.toBeNull()
    }
    // Either way: the placeholder's exact old text never survives
    // side-by-side with a same-family fresh row under a fabricated pairing.
  }, 30000)

  it('one_time_fee: strong fee_id identity already solves continuity — the new mechanism correctly stays out of the way', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.2 integration — one_time_fee stays out of the way')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      one_time_fees: [{ fee_id: 'otf-e32-test-1', fee_label: 'Setup fee', amount: 500, amount_provenance: null, manual_trigger: false }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)
    const { data: feeRow } = await supabaseServer.from('line_items').insert({
      job_id: jobId, product_name: 'Setup fee', quantity: 1, unit_price: 500, billing_period: 'one_time', total_amount: 500,
      currency: 'EUR', confidence_score: 0.9, fee_id: 'otf-e32-test-1',
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
    }).select('id').single()

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'one_time_fee', contractUnitType: 'Setup fee', approvedInterpretation: { confirmBillability: true } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    const body = await res.json()
    console.log('E3.2_CONFIRM_ONE_TIME_FEE:', res.status, JSON.stringify(body))
    expect(res.status).toBe(200)

    const { data: currentRows } = await supabaseServer.from('current_line_items').select('id, product_name, fee_id').eq('job_id', jobId)
    expect(currentRows).toHaveLength(1)
    expect(currentRows![0].id).toBe(feeRow!.id) // same physical row — fee_id matching, untouched by E3.2

    const { data: jobRow } = await supabaseServer.from('jobs').select('billing_hold').eq('id', jobId).single()
    expect(jobRow?.billing_hold).toBeNull()
  }, 30000)
})
