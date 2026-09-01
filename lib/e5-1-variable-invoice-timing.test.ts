import { describe, it, expect, vi } from 'vitest'

// Step 17H.4B0D4H1B4E5.1 — mirrors E5's fixed_fee_billing_timing fix for
// variable_invoice_timing, the identical pre-existing defect (confirmed by
// direct code read: interpret-rule's if/else dispatch had zero cases for
// this ruleType either, and the review drawer always called generate() for
// every ruleType/selection mode).
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/e5-1-variable-invoice-timing.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

let ORG_ID = ''
vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E5.1 Test Org', orgSlug: 'e5-1-test', role: 'admin' as const, userEmail: 'e51@test.invalid' })),
  getActiveOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E5.1 Test Org', orgSlug: 'e5-1-test', role: 'admin' as const, userEmail: 'e51@test.invalid' })),
}))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { email: 'e51@test.invalid', name: 'E5.1 Test' } })) }))

const FEE_LABEL = 'Performance share (resultatdel)'
const RECURRING_FEE_ID = 'rf-e51-test-1'

function buildTerms(overrides: Record<string, unknown> = {}) {
  return {
    base_monthly_fee: 1500, currency: 'SEK', contract_start_date: '2027-01-01',
    contract_term_months: 12, billing_frequency: 'monthly', payment_terms_days: 30,
    customer_name: 'E5.1 Test Customer',
    additional_recurring_fees: [{
      fee_label: FEE_LABEL, recurring_fee_id: RECURRING_FEE_ID, amount: 0,
      description: 'Monthly performance share, calculated in arrears.',
      percentage_of_basis: { rate_schedule: { bands: [{ from: 0, to: null, rate_pct: 1 }] } },
      variable_invoice_timing: { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'Not stated in the contract.', source_clause: null },
    }],
    ...overrides,
  }
}

async function createTestOrgAndJob(name: string, termsOverrides: Record<string, unknown> = {}): Promise<{ orgId: string; jobId: string }> {
  const { supabaseServer } = await import('@/lib/supabase')
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data: org, error: orgErr } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (orgErr || !org) throw new Error(`createTestOrg failed: ${orgErr?.message}`)
  const { data: job, error: jobErr } = await supabaseServer.from('jobs')
    .insert({ name: 'E5.1 variable_invoice_timing test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: org.id, user_id: 'e51-test@isolation-test.invalid' })
    .select('id').single()
  if (jobErr || !job) throw new Error(`createTestJob failed: ${jobErr?.message}`)
  const { data: terms, error: termsErr } = await supabaseServer.from('contract_terms')
    .insert({ job_id: job.id, ...buildTerms(termsOverrides) })
    .select('id').single()
  if (termsErr || !terms) throw new Error(`insert contract_terms failed: ${termsErr?.message}`)
  await supabaseServer.from('jobs').update({ contract_terms_id: terms.id }).eq('id', job.id)
  return { orgId: org.id as string, jobId: job.id as string }
}

async function cleanup(orgId: string, jobId: string) {
  const { supabaseServer } = await import('@/lib/supabase')
  await supabaseServer.from('commercial_rule_interpretations').delete().eq('job_id', jobId)
  await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
  await supabaseServer.from('jobs').delete().eq('id', jobId)
  await supabaseServer.from('organizations').delete().eq('id', orgId)
}

describeIf('E5.1 — variable_invoice_timing reviewer decision, real routes', () => {
  it('§1/§5 — free text via interpret-rule no longer returns Unknown ruleType; produces a typed proposal', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5.1 FreeText NextPeriod')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: FEE_LABEL, freeText: 'Bill this charge on the next regular monthly invoice, alongside everything else on that invoice.' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_1_FREETEXT_NEXT_PERIOD_RESULT:', res.status, JSON.stringify(body))
      expect(body.error).toBeUndefined()
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.proposal.timing).toBe('invoice_at_next_period_start')
      expect(body.whatWillChange.some((c: { change: string }) => /escalat/i.test(c.change))).toBe(false)
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 60000)

  it('§6 — an unsupported/unrelated free-text instruction fails safely to "unclear"', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5.1 FreeText Unsupported')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: FEE_LABEL, freeText: 'Double the fee amount on leap years.' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_1_FREETEXT_UNSUPPORTED_RESULT:', res.status, JSON.stringify(body))
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.proposal.timing).toBe('unclear')
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 60000)

  it('§7 — "Other / unclear" with no free text fails safely BEFORE any interpretation — decision stays unresolved', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5.1 Other No FreeText')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: FEE_LABEL, selectedOption: 'other', freeText: '' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_1_OTHER_NO_FREETEXT_RESULT:', res.status, JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(body.error).toMatch(/Describe how this rule should work, or pick a structured option/)

      const { supabaseServer } = await import('@/lib/supabase')
      const { data: termsAfter } = await supabaseServer.from('contract_terms').select('additional_recurring_fees').eq('job_id', fixture.jobId).single()
      const fee = (termsAfter?.additional_recurring_fees as Array<{ fee_label: string; variable_invoice_timing?: { requires_confirmation?: boolean } }>).find(f => f.fee_label === FEE_LABEL)
      expect(fee?.variable_invoice_timing?.requires_confirmation).toBe(true)
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 30000)

  it('§3/§9/§11–§14/§16 — deterministic structured-option persistence (both options), recurring_fee_id addressing, readiness, and runtime-semantics regression', async () => {
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')
    const { supabaseServer } = await import('@/lib/supabase')
    const { computeCommercialRuleWorkload } = await import('@/lib/commercial-rule-status')
    const { isVariableInvoiceTimingConfirmed } = await import('@/lib/performance-share-pull')
    const { recurringFeeDecisionKey } = await import('@/lib/contract-terms-merge')

    for (const optionId of ['invoice_at_next_period_start', 'invoice_at_period_end'] as const) {
      const fixture = await createTestOrgAndJob(`E5.1 Deterministic ${optionId}`)
      ORG_ID = fixture.orgId
      try {
        const { data: termsBefore } = await supabaseServer.from('contract_terms')
          .select('base_monthly_fee, additional_recurring_fees, overage_tiers, discounts, service_credits, one_time_fees, unsupported_commercial_mechanisms')
          .eq('job_id', fixture.jobId).single()
        const workloadBefore = computeCommercialRuleWorkload(termsBefore as never, { total: 0, confirmed: 0 })
        console.log('E5_1_WORKLOAD_BEFORE:', optionId, JSON.stringify({ totalToConfirm: workloadBefore.totalToConfirm }))
        expect(workloadBefore.totalToConfirm).toBeGreaterThan(0)

        // Exactly the shape page.tsx's applyDeterministicVariableInvoiceTiming
        // builds — contractUnitType still carries the fee_label unchanged
        // (§9/§4 — no new identity-passing; confirm-rule does recurring_fee_id-
        // first audit addressing server-side from that fee_label, unchanged).
        const res = await confirmRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/confirm-rule`, {
          method: 'POST',
          body: JSON.stringify({ ruleType: 'variable_invoice_timing', contractUnitType: FEE_LABEL, reviewerInput: '', approvedInterpretation: { timing: optionId, source_clause: null } }),
          headers: { 'content-type': 'application/json' },
        }), { params: Promise.resolve({ id: fixture.jobId }) })
        const body = await res.json()
        console.log('E5_1_CONFIRM_RESULT:', optionId, res.status, JSON.stringify(body))
        expect([200, 207]).toContain(res.status)

        const { data: termsAfter } = await supabaseServer.from('contract_terms')
          .select('base_monthly_fee, additional_recurring_fees, overage_tiers, discounts, service_credits, one_time_fees, unsupported_commercial_mechanisms')
          .eq('job_id', fixture.jobId).single()
        const feeAfter = (termsAfter?.additional_recurring_fees as Array<{ fee_label: string; variable_invoice_timing?: { timing?: string; requires_confirmation?: boolean } }>).find(f => f.fee_label === FEE_LABEL)!
        expect(feeAfter.variable_invoice_timing?.timing).toBe(optionId)
        expect(feeAfter.variable_invoice_timing?.requires_confirmation).toBe(false)

        // §4/§9 — audit row addressed by recurring_fee:{id}, never the raw
        // fee_label (E3.4.1 identity doctrine, untouched by this pass).
        const { data: interpretations } = await supabaseServer.from('commercial_rule_interpretations')
          .select('id, contract_unit_type, is_current').eq('job_id', fixture.jobId).eq('rule_type', 'variable_invoice_timing').eq('is_current', true)
        console.log('E5_1_AUDIT_ROWS:', optionId, JSON.stringify(interpretations))
        expect(interpretations?.length).toBe(1)
        expect(interpretations?.[0].contract_unit_type).toBe(recurringFeeDecisionKey(RECURRING_FEE_ID))

        const workloadAfter = computeCommercialRuleWorkload(termsAfter as never, { total: 0, confirmed: 0 })
        console.log('E5_1_WORKLOAD_AFTER:', optionId, JSON.stringify({ totalToConfirm: workloadAfter.totalToConfirm }))
        // Step 17H.4B0D4H1B4E5.2 — updated from this test's original E5.1
        // assertion (unconditional -1 for either option), which encoded
        // the exact "dangerous state" E5.2 closes: requires_confirmation:
        // false alone used to clear readiness even for the non-executable
        // invoice_at_period_end value. Readiness now only clears for the
        // ONE genuinely executable option — see
        // isVariableInvoiceTimingConfirmed's own header for why.
        expect(workloadAfter.totalToConfirm).toBe(
          optionId === 'invoice_at_next_period_start' ? workloadBefore.totalToConfirm - 1 : workloadBefore.totalToConfirm,
        )

        // §13/§16 — FROZEN runtime semantics, verified not re-derived:
        // only 'invoice_at_next_period_start' has a real execution path.
        // 'invoice_at_period_end' is a resolvable, confirmed VALUE that
        // still has no execution path — storage says resolved, execution
        // still correctly holds it. This is documented, existing,
        // untouched behavior (lib/performance-share-pull.ts), not
        // something this pass changed.
        const runtimeConfirmed = isVariableInvoiceTimingConfirmed(feeAfter.variable_invoice_timing as never)
        console.log('E5_1_RUNTIME_CONFIRMED:', optionId, runtimeConfirmed)
        expect(runtimeConfirmed).toBe(optionId === 'invoice_at_next_period_start')
      } finally {
        await cleanup(fixture.orgId, fixture.jobId)
      }
    }
  }, 60000)

  it('§15 — E5 fixed-fee timing behavior unchanged by this pass', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5.1 Regression FixedFee', {
      fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'Not stated.', source_clause: null },
    })
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'fixed_fee_billing_timing', freeText: 'Invoice at the start of each billing period.' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_1_REGRESSION_FIXEDFEE_RESULT:', res.status, JSON.stringify(body))
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.proposal.timing).toBe('bill_at_period_start')
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 60000)
})
