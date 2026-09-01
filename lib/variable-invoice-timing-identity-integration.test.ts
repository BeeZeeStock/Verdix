import { describe, it, expect, vi, afterAll } from 'vitest'

// Step 17H.4B0D4H1B4E3.4.1 §15 — real-Postgres validation. Deliberately
// does NOT depend on the (unapplied) 20260916000001_recurring_fee_id.sql
// migration: AdditionalRecurringFee.recurring_fee_id lives inside
// contract_terms.additional_recurring_fees, a JSONB column that already
// exists — only line_items.recurring_fee_id (a separate, still-unapplied
// concern) needs that migration. This test proves confirm-rule's new
// recurring_fee_id-first audit addressing and lib/contract-terms-merge.ts's
// matching read side, live, against the real database.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/variable-invoice-timing-identity-integration.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const ORG_CTX = {
  orgId: 'b911acab-03b1-48fd-8195-e2b2731ed69a', orgName: 'Lynora AB', orgSlug: 'lynora-ab-mr6nexf8',
  role: 'admin' as const, userEmail: 'bilal@lynoraai.com',
}
vi.mock('@/lib/org', () => ({ requireOrg: vi.fn(async () => ORG_CTX), getActiveOrg: vi.fn(async () => ORG_CTX) }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { email: ORG_CTX.userEmail, name: 'Bilal (E3.4.1 integration)' } })) }))

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

describeIf('E3.4.1 — variable_invoice_timing recurring_fee_id-first audit addressing, real Postgres', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    const { supabaseServer } = await import('@/lib/supabase')
    await supabaseServer.from('commercial_rule_interpretations').delete().in('job_id', createdJobIds)
    await supabaseServer.from('contract_terms').delete().in('job_id', createdJobIds)
    await supabaseServer.from('jobs').delete().in('id', createdJobIds)
  })

  it('confirming a fee WITH a recurring_fee_id stores the audit row under recurring_fee:{id}, not the raw fee_label', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.1 integration — recurring_fee_id-first audit key')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{
        recurring_fee_id: 'rf-e341-test-1', fee_label: 'Per-completed payment success fee',
        metric_name: 'completed_payment', rate_per_unit: 1.7, amount: 0,
        percentage_of_basis: { rate_schedule: { bands: [] } },
      }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: 'Per-completed payment success fee', approvedInterpretation: { timing: 'invoice_at_period_end' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    const body = await res.json()
    console.log('E3.4.1_CONFIRM_RESULT:', res.status, JSON.stringify(body))
    expect(res.status).toBe(200)
    expect(body.propagation.contract_terms).toBe('applied')

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, is_current, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'variable_invoice_timing')
    console.log('E3.4.1_AUDIT_ROWS:', JSON.stringify(auditRows))
    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].contract_unit_type).toBe('recurring_fee:rf-e341-test-1')
    expect(auditRows![0].is_current).toBe(true)

    // The materialized contract_terms field was also written, keyed by the
    // fee_label match at confirm-time (unchanged behavior — no drift risk
    // within one request).
    const { data: afterTerms } = await supabaseServer.from('contract_terms').select('additional_recurring_fees').eq('id', termsRow!.id).single()
    const fee = (afterTerms!.additional_recurring_fees as Array<{ variable_invoice_timing?: { timing?: string } }>)[0]
    expect(fee.variable_invoice_timing?.timing).toBe('invoice_at_period_end')
  }, 20000)

  it('a fee with NO recurring_fee_id still stores/finds its audit row under the legacy fee_label key (unchanged behavior)', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.1 integration — legacy fee_label-keyed audit key')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{
        fee_label: 'Legacy fee, no id', metric_name: 'm', rate_per_unit: 1, amount: 0,
        percentage_of_basis: { rate_schedule: { bands: [] } },
      }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    const req = new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
      method: 'POST',
      body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: 'Legacy fee, no id', approvedInterpretation: { timing: 'invoice_at_period_end' } }),
      headers: { 'content-type': 'application/json' },
    })
    const res = await confirmRule(req, { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type').eq('job_id', jobId).eq('rule_type', 'variable_invoice_timing')
    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].contract_unit_type).toBe('Legacy fee, no id')
  }, 20000)

  it('a SECOND confirmation for the same recurring_fee_id demotes the first — no duplicate is_current rows', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')

    const jobId = await seedJob(supabaseServer, 'E3.4.1 integration — no duplicate current rows')
    const { data: termsRow } = await supabaseServer.from('contract_terms').insert({
      job_id: jobId,
      additional_recurring_fees: [{
        recurring_fee_id: 'rf-e341-test-2', fee_label: 'Per-completed payment success fee',
        metric_name: 'completed_payment', rate_per_unit: 1.7, amount: 0,
        percentage_of_basis: { rate_schedule: { bands: [] } },
      }],
    }).select('id').single()
    await supabaseServer.from('jobs').update({ contract_terms_id: termsRow!.id }).eq('id', jobId)

    for (const timing of ['invoice_at_period_end', 'invoice_at_next_period_start']) {
      const res = await confirmRule(new NextRequest(`http://localhost/api/jobs/${jobId}/confirm-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: 'Per-completed payment success fee', approvedInterpretation: { timing } }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: jobId }) })
      expect(res.status).toBe(200)
    }

    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, is_current, revision_number').eq('job_id', jobId).eq('rule_type', 'variable_invoice_timing')
      .order('revision_number')
    console.log('E3.4.1_REVISION_HISTORY:', JSON.stringify(auditRows))
    expect(auditRows).toHaveLength(2) // append-only history preserved
    const current = (auditRows ?? []).filter(r => r.is_current)
    expect(current).toHaveLength(1) // exactly one current row
    expect(current[0].revision_number).toBe(2)
  }, 25000)

  it('mergeVariableInvoiceTimingForFees, fed by a REAL id-keyed audit row: silent re-extraction restores the decision across simulated wording drift', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { mergeVariableInvoiceTimingForFees } = await import('@/lib/contract-terms-merge')

    const jobId = await seedJob(supabaseServer, 'E3.4.1 integration — merge reads real id-keyed row')
    await supabaseServer.from('commercial_rule_interpretations').insert({
      job_id: jobId, rule_type: 'variable_invoice_timing', contract_unit_type: 'recurring_fee:rf-e341-test-3',
      revision_number: 1, is_current: true,
      approved_interpretation: { timing: 'invoice_at_period_end' },
      reviewer_email: ORG_CTX.userEmail, affected_components: [],
    })
    const { data: auditRows } = await supabaseServer
      .from('commercial_rule_interpretations')
      .select('contract_unit_type, approved_interpretation')
      .eq('job_id', jobId).eq('rule_type', 'variable_invoice_timing').eq('is_current', true)

    const freshFees = [{
      recurring_fee_id: 'rf-e341-test-3',
      fee_label: 'Per-completed payment success fee (differently worded this pass)',
      metric_name: 'completed_payment', rate_per_unit: 1.7, amount: 0, percentage_of_basis: null, description: null,
      variable_invoice_timing: { timing: 'unclear' as const, requires_confirmation: true, confirmation_reason: null, source_clause: null },
    }]
    const merged = mergeVariableInvoiceTimingForFees(freshFees, auditRows ?? [])
    console.log('E3.4.1_MERGE_RESULT:', JSON.stringify(merged[0].variable_invoice_timing))
    expect(merged[0].variable_invoice_timing?.timing).toBe('invoice_at_period_end')
    expect(merged[0].variable_invoice_timing?.requires_confirmation).toBe(false)
  }, 15000)
})
