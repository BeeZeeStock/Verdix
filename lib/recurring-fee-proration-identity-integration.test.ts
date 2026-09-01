import { describe, it, expect, vi, afterAll } from 'vitest'

// Step 17H.4B0D4H1B4E3.4.2 §10 — real-Postgres validation, mirroring
// lib/variable-invoice-timing-identity-integration.test.ts exactly for the
// sibling rule type. Does NOT depend on the (unapplied)
// 20260916000001_recurring_fee_id.sql migration — recurring_fee_id lives
// inside contract_terms.additional_recurring_fees, a JSONB column that
// already exists.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/recurring-fee-proration-identity-integration.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const ORG_CTX = {
  orgId: 'b911acab-03b1-48fd-8195-e2b2731ed69a', orgName: 'Lynora AB', orgSlug: 'lynora-ab-mr6nexf8',
  role: 'admin' as const, userEmail: 'bilal@lynoraai.com',
}
vi.mock('@/lib/org', () => ({ requireOrg: vi.fn(async () => ORG_CTX), getActiveOrg: vi.fn(async () => ORG_CTX) }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { email: ORG_CTX.userEmail, name: 'Bilal (E3.4.2 integration)' } })) }))

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

describeIf('E3.4.2 — recurring_fee_proration recurring_fee_id-first audit addressing, real Postgres', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    const { supabaseServer } = await import('@/lib/supabase')
    await supabaseServer.from('commercial_rule_interpretations').delete().in('job_id', createdJobIds)
    await supabaseServer.from('contract_terms').delete().in('job_id', createdJobIds)
    await supabaseServer.from('jobs').delete().in('id', createdJobIds)
  })

  it('confirming a fee WITH a recurring_fee_id stores the audit row under recurring_fee:{id}', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.2 integration — recurring_fee_id-first audit key')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{
        recurring_fee_id: 'rf-e342-test-1', fee_label: 'Support tier',
        metric_name: null, rate_per_unit: null, amount: 500,
      }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'recurring_fee_proration', contractUnitType: 'Support tier', approvedInterpretation: { prorate_partial_periods: true, reset_anchor: 'contract_start' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    const body = await res.json()
    console.log('E3.4.2_CONFIRM_RESULT:', res.status, JSON.stringify(body))
    expect(res.status).toBe(200)
    expect(body.propagation.contract_terms).toBe('applied')

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, is_current, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'recurring_fee_proration')
    console.log('E3.4.2_AUDIT_ROWS:', JSON.stringify(auditRows))
    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].contract_unit_type).toBe('recurring_fee:rf-e342-test-1')
    expect(auditRows![0].is_current).toBe(true)

    const { data: afterTerms } = await supabaseServer.from('contract_terms').select('additional_recurring_fees').eq('id', termsRow!.id).single()
    const fee = (afterTerms!.additional_recurring_fees as Array<{ proration?: { prorate_partial_periods?: unknown } }>)[0]
    expect(fee.proration?.prorate_partial_periods).toBe(true)
  }, 20000)

  it('a fee with NO recurring_fee_id stores/finds its audit row under the legacy fee_label key', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.2 integration — legacy fee_label-keyed audit key')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{ fee_label: 'Legacy fee, no id', metric_name: null, rate_per_unit: null, amount: 100 }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'recurring_fee_proration', contractUnitType: 'Legacy fee, no id', approvedInterpretation: { prorate_partial_periods: false, reset_anchor: 'calendar' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type').eq('job_id', jobId).eq('rule_type', 'recurring_fee_proration')
    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].contract_unit_type).toBe('Legacy fee, no id')
  }, 20000)

  it('§10 — a SECOND confirmation for the same recurring_fee_id demotes the first: exactly one current row, full history preserved', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.2 integration — no duplicate current rows')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{ recurring_fee_id: 'rf-e342-test-2', fee_label: 'Support tier', metric_name: null, rate_per_unit: null, amount: 500 }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    for (const prorate of [true, false]) {
      const res = await confirmRule(new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'recurring_fee_proration', contractUnitType: 'Support tier', approvedInterpretation: { prorate_partial_periods: prorate, reset_anchor: 'contract_start' } }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: jobId }) })
      expect(res.status).toBe(200)
    }

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, is_current, revision_number').eq('job_id', jobId).eq('rule_type', 'recurring_fee_proration')
      .order('revision_number')
    console.log('E3.4.2_REVISION_HISTORY:', JSON.stringify(auditRows))
    expect(auditRows).toHaveLength(2)
    const current = (auditRows ?? []).filter(r => r.is_current)
    expect(current).toHaveLength(1)
    expect(current[0].revision_number).toBe(2)
  }, 25000)

  it('mergeRecurringFeeProrationForFees, fed by a REAL id-keyed audit row: silent re-extraction restores the decision across simulated wording drift', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { mergeRecurringFeeProrationForFees } = await import('@/lib/contract-terms-merge')

    const jobId = await seedJob(supabaseServer, 'E3.4.2 integration — merge reads real id-keyed row')
    await supabaseServer.from('commercial_rule_interpretations').insert({
      job_id: jobId, rule_type: 'recurring_fee_proration', contract_unit_type: 'recurring_fee:rf-e342-test-3',
      revision_number: 1, is_current: true,
      approved_interpretation: { prorate_partial_periods: true, reset_anchor: 'contract_start' },
      reviewer_email: ORG_CTX.userEmail, affected_components: [],
    })
    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'recurring_fee_proration').eq('is_current', true)

    const freshFees = [{
      recurring_fee_id: 'rf-e342-test-3',
      fee_label: 'Support package (differently worded this pass)',
      metric_name: null, rate_per_unit: null, amount: 500, percentage_of_basis: null, description: null,
      proration: { reset_anchor: 'contract_start' as const, prorate_partial_periods: 'unclear' as const, requires_confirmation: true, confirmation_reason: null, source_clause: null },
    }]
    const merged = mergeRecurringFeeProrationForFees(freshFees, auditRows ?? [])
    console.log('E3.4.2_MERGE_RESULT:', JSON.stringify(merged[0].proration))
    expect(merged[0].proration?.prorate_partial_periods).toBe(true)
    expect(merged[0].proration?.requires_confirmation).toBe(false)
  }, 15000)
})
