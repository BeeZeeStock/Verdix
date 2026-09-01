import { describe, it, expect, vi, afterAll } from 'vitest'

// Step 17H.4B0D4H1B4E3.3 §38/§39 — real-Postgres validation for:
//   (a) confirm-rule's audit/authoritative-mutation atomicity fix (§23) —
//       a failed contract_terms mutation must not leave an is_current=true
//       commercial_rule_interpretations row behind.
//   (b) the merge functions (lib/contract-terms-merge.ts) fed by REAL rows
//       read from commercial_rule_interpretations, not just the pure unit
//       tests' hand-built fixtures.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/contract-terms-merge-integration.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const ORG_CTX = {
  orgId: 'b911acab-03b1-48fd-8195-e2b2731ed69a', orgName: 'Lynora AB', orgSlug: 'lynora-ab-mr6nexf8',
  role: 'admin' as const, userEmail: 'bilal@lynoraai.com',
}
vi.mock('@/lib/org', () => ({ requireOrg: vi.fn(async () => ORG_CTX), getActiveOrg: vi.fn(async () => ORG_CTX) }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { email: ORG_CTX.userEmail, name: 'Bilal (E3.3 integration)' } })) }))

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

describeIf('E3.3 reviewer-decision authority — real Postgres', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    const { supabaseServer } = await import('@/lib/supabase')
    await supabaseServer.from('commercial_rule_interpretations').delete().in('job_id', createdJobIds)
    await supabaseServer.from('line_items').delete().in('job_id', createdJobIds)
    await supabaseServer.from('contract_terms').delete().in('job_id', createdJobIds)
    await supabaseServer.from('jobs').delete().in('id', createdJobIds)
  })

  it('§23 — a FAILED contract_terms mutation demotes its own audit row and restores whichever decision was previously current', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.3 integration — audit atomicity on failed mutation')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      discounts: [{ discount_rule_id: 'real-discount-id', discount_pct: 10, discount_type: 'introductory', applies_to: 'platform fee', description: 'Intro discount' }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    // First, a genuinely successful confirmation — establishes the row that
    // must survive a LATER failed attempt.
    const goodReq = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'discount', discountId: 'real-discount-id', approvedInterpretation: { discount_type: 'introductory', discount_basis: 'percentage', applies_to: [], application_order: null, worked_example: 'first, good confirmation' } }),
      headers: { 'content-type': 'application/json' },
    })
    const goodRes = await confirmRule(goodReq, { params: Promise.resolve({ id: jobId }) })
    expect((await goodRes.json()).propagation.contract_terms).toBe('applied')

    const { data: afterGood } = await supabaseServer.from('commercial_rule_interpretations').select('id, is_current').eq('job_id', jobId).eq('rule_type', 'discount')
    expect(afterGood).toHaveLength(1)
    const goodRowId = afterGood![0].id as string
    expect(afterGood![0].is_current).toBe(true)

    // Now a confirmation that WILL fail at the contract_terms mutation step
    // (a discountId that matches no real discount, with discounts already
    // non-empty — confirm-rule's own documented 'failed' branch).
    const badReq = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'discount', discountId: 'no-such-discount-id', approvedInterpretation: { discount_type: 'introductory', discount_basis: 'percentage', applies_to: [], application_order: null, worked_example: 'this attempt should fail' } }),
      headers: { 'content-type': 'application/json' },
    })
    const badRes = await confirmRule(badReq, { params: Promise.resolve({ id: jobId }) })
    const badBody = await badRes.json()
    console.log('E3.3_FAILED_CONFIRM_PROPAGATION:', JSON.stringify(badBody.propagation))
    expect(badBody.propagation.contract_terms).toBe('failed')

    const { data: afterBad } = await supabaseServer.from('commercial_rule_interpretations').select('id, is_current, approved_interpretation').eq('job_id', jobId).eq('rule_type', 'discount').order('created_at')
    console.log('E3.3_AUDIT_ROWS_AFTER_FAILED_ATTEMPT:', JSON.stringify(afterBad))
    // Exactly one row is_current — the ORIGINAL good confirmation, restored.
    const currentRows = (afterBad ?? []).filter(r => r.is_current)
    expect(currentRows).toHaveLength(1)
    expect(currentRows[0].id).toBe(goodRowId)
    // The failed attempt's own row exists (append-only audit trail) but is
    // NOT current — it must never be trusted as an authoritative decision.
    const failedRow = (afterBad ?? []).find(r => r.id !== goodRowId)
    expect(failedRow?.is_current).toBe(false)
  }, 30000)

  it('base_fee_proration merge, fed by a REAL commercial_rule_interpretations row: silent re-extraction restores the confirmed decision', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { mergeBaseFeeProrationDecision } = await import('@/lib/contract-terms-merge')

    const jobId = await seedJob(supabaseServer, 'E3.3 integration — base_fee_proration real audit row')
    await supabaseServer.from('commercial_rule_interpretations').insert({
      job_id: jobId, rule_type: 'base_fee_proration', contract_unit_type: null, revision_number: 1, is_current: true,
      approved_interpretation: { prorate_partial_periods: true, reset_anchor: 'contract_start', source_clause: 'confirmed clause' },
      reviewer_email: ORG_CTX.userEmail, affected_components: [],
    })

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'base_fee_proration').eq('is_current', true)

    const freshFromReextraction = { reset_anchor: 'contract_start' as const, prorate_partial_periods: 'unclear' as const, requires_confirmation: true, confirmation_reason: 'ai re-derived ambiguity', source_clause: 'freshly re-extracted clause text' }
    const merged = mergeBaseFeeProrationDecision(freshFromReextraction, auditRows ?? [])
    console.log('E3.3_BASE_FEE_PRORATION_MERGE_RESULT:', JSON.stringify(merged))
    expect(merged?.prorate_partial_periods).toBe(true)
    expect(merged?.requires_confirmation).toBe(false)
    expect(merged?.source_clause).toBe('freshly re-extracted clause text') // evidence refreshed
  }, 15000)

  it('base_fee_proration merge: genuinely conflicting fresh evidence surfaces for review, never silently resolved either way', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { mergeBaseFeeProrationDecision } = await import('@/lib/contract-terms-merge')

    const jobId = await seedJob(supabaseServer, 'E3.3 integration — base_fee_proration conflict')
    await supabaseServer.from('commercial_rule_interpretations').insert({
      job_id: jobId, rule_type: 'base_fee_proration', contract_unit_type: null, revision_number: 1, is_current: true,
      approved_interpretation: { prorate_partial_periods: true, reset_anchor: 'contract_start', source_clause: 'old clause' },
      reviewer_email: ORG_CTX.userEmail, affected_components: [],
    })
    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'base_fee_proration').eq('is_current', true)

    // Simulates a changed contract version whose fresh extraction now
    // explicitly states the OPPOSITE treatment.
    const conflictingFresh = { reset_anchor: 'contract_start' as const, prorate_partial_periods: false, requires_confirmation: false, confirmation_reason: null, source_clause: 'new explicit clause: no proration' }
    const merged = mergeBaseFeeProrationDecision(conflictingFresh, auditRows ?? [])
    expect(merged?.requires_confirmation).toBe(true)
    expect(merged?.confirmation_reason).toMatch(/true/)
    expect(merged?.confirmation_reason).toMatch(/false/)
  }, 15000)
})
