import { describe, it, expect, vi } from 'vitest'

// Step 17H.4B0D4H1B4E5 — surgical fix for the live-reproduced defect:
// selecting "At the beginning of each billing period" for the
// fixed_fee_billing_timing reviewer question and clicking "Generate billing
// rule" returned `Unknown ruleType: fixed_fee_billing_timing` from
// interpret-rule, leaving the decision permanently unresolvable.
//
// Root cause (confirmed by reading the code, not assumed): interpret-rule's
// if/else dispatch had no case for this ruleType at all — every OTHER
// unresolved-decision path does. confirm-rule already fully supported it
// (proven live in E3.6/E3.7). This suite proves:
//   (a) the free-text path now works via a NEW interpret-rule branch
//       (lib/rule-interpretation.ts's buildFixedFeeBillingTimingPrompt),
//   (b) the "Other/unclear" + no free text guard still fails safely
//       (pre-existing route-level validation, unchanged, still correct for
//       this ruleType),
//   (c) the deterministic structured-option shape the review drawer now
//       sends directly to confirm-rule (bypassing interpret-rule/AI
//       entirely — see page.tsx's applyDeterministicFixedFeeTiming) round-
//       trips correctly for BOTH options,
//   (d) readiness/decision-count moves correctly before/after,
//   (e) the resolved value still compiles to the existing (untouched)
//       scheduling behavior.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/e5-fixed-fee-billing-timing.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

let ORG_ID = ''
vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E5 Test Org', orgSlug: 'e5-test', role: 'admin' as const, userEmail: 'e5@test.invalid' })),
  getActiveOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E5 Test Org', orgSlug: 'e5-test', role: 'admin' as const, userEmail: 'e5@test.invalid' })),
}))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { email: 'e5@test.invalid', name: 'E5 Test' } })) }))

const BASE_TERMS = {
  base_monthly_fee: 1500, currency: 'SEK', contract_start_date: '2027-01-01',
  contract_term_months: 12, billing_frequency: 'monthly', payment_terms_days: 30,
  customer_name: 'E5 Test Customer',
  fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'Not stated in the contract.', source_clause: null },
}

async function createTestOrgAndJob(name: string): Promise<{ orgId: string; jobId: string; contractTermsId: string }> {
  const { supabaseServer } = await import('@/lib/supabase')
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data: org, error: orgErr } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (orgErr || !org) throw new Error(`createTestOrg failed: ${orgErr?.message}`)
  const { data: job, error: jobErr } = await supabaseServer.from('jobs')
    .insert({ name: 'E5 fixed_fee_billing_timing test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: org.id, user_id: 'e5-test@isolation-test.invalid' })
    .select('id').single()
  if (jobErr || !job) throw new Error(`createTestJob failed: ${jobErr?.message}`)
  const { data: terms, error: termsErr } = await supabaseServer.from('contract_terms')
    .insert({ job_id: job.id, ...BASE_TERMS })
    .select('id').single()
  if (termsErr || !terms) throw new Error(`insert contract_terms failed: ${termsErr?.message}`)
  await supabaseServer.from('jobs').update({ contract_terms_id: terms.id }).eq('id', job.id)
  return { orgId: org.id as string, jobId: job.id as string, contractTermsId: terms.id as string }
}

async function cleanup(orgId: string, jobId: string) {
  const { supabaseServer } = await import('@/lib/supabase')
  await supabaseServer.from('commercial_rule_interpretations').delete().eq('job_id', jobId)
  await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
  await supabaseServer.from('jobs').delete().eq('id', jobId)
  await supabaseServer.from('organizations').delete().eq('id', orgId)
}

describeIf('E5 — fixed_fee_billing_timing reviewer decision, real routes', () => {
  it('§1/§5 — free text via interpret-rule no longer returns Unknown ruleType; produces a typed proposal', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5 FreeText Start')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'fixed_fee_billing_timing', freeText: 'Invoice on the first day of each billing period, in advance.' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_FREETEXT_START_RESULT:', res.status, JSON.stringify(body))
      expect(body.error).toBeUndefined()
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.proposal.timing).toBe('bill_at_period_start')
      // §5 — describeWhatWillChange no longer falls through to the wrong
      // escalator-specific wording for this ruleType.
      expect(body.whatWillChange.some((c: { change: string }) => /escalat/i.test(c.change))).toBe(false)
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 60000)

  it('§6 — an unsupported/unrelated free-text instruction fails safely to "unclear", never a fabricated start/end guess', async () => {
    const { POST: interpretRule } = await import('@/app/api/jobs/[id]/interpret-rule/route')
    const { NextRequest } = await import('next/server')
    const fixture = await createTestOrgAndJob('E5 FreeText Unsupported')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'fixed_fee_billing_timing', freeText: 'Double the fee amount on leap years.' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_FREETEXT_UNSUPPORTED_RESULT:', res.status, JSON.stringify(body))
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
    const fixture = await createTestOrgAndJob('E5 Other No FreeText')
    ORG_ID = fixture.orgId
    try {
      const res = await interpretRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/interpret-rule`, {
        method: 'POST',
        body: JSON.stringify({ ruleType: 'fixed_fee_billing_timing', selectedOption: 'other', freeText: '' }),
        headers: { 'content-type': 'application/json' },
      }), { params: Promise.resolve({ id: fixture.jobId }) })
      const body = await res.json()
      console.log('E5_OTHER_NO_FREETEXT_RESULT:', res.status, JSON.stringify(body))
      expect(res.status).toBe(400)
      expect(body.error).toMatch(/Describe how this rule should work, or pick a structured option/)

      const { supabaseServer } = await import('@/lib/supabase')
      const { data: termsAfter } = await supabaseServer.from('contract_terms').select('fixed_fee_billing_timing').eq('job_id', fixture.jobId).single()
      expect((termsAfter?.fixed_fee_billing_timing as { requires_confirmation?: boolean })?.requires_confirmation).toBe(true)
    } finally {
      await cleanup(fixture.orgId, fixture.jobId)
    }
  }, 30000)

  it('§3/§12/§13/§14 — deterministic structured-option persistence (both options), readiness, and schedule-compilation regression', async () => {
    const { POST: confirmRule } = await import('@/app/api/jobs/[id]/confirm-rule/route')
    const { NextRequest } = await import('next/server')
    const { supabaseServer } = await import('@/lib/supabase')
    const { computeCommercialRuleWorkload } = await import('@/lib/commercial-rule-status')
    const { resolveFixedFeeSchedulingDecision } = await import('@/lib/fixed-fee-invoice-scheduling')

    for (const [optionId, expectedDueField] of [['bill_at_period_start', 'period_start'], ['bill_at_period_end', 'period_end']] as const) {
      const fixture = await createTestOrgAndJob(`E5 Deterministic ${optionId}`)
      ORG_ID = fixture.orgId
      try {
        const { data: termsBefore } = await supabaseServer.from('contract_terms')
          .select('base_monthly_fee, fixed_fee_billing_timing, overage_tiers, additional_recurring_fees, discounts, service_credits, one_time_fees, unsupported_commercial_mechanisms')
          .eq('job_id', fixture.jobId).single()
        const workloadBefore = computeCommercialRuleWorkload(termsBefore as never, { total: 0, confirmed: 0 }, 0, new Set(), { configured: true }, [], [], new Date(), true)
        console.log('E5_WORKLOAD_BEFORE:', optionId, JSON.stringify({ totalToConfirm: workloadBefore.totalToConfirm }))
        expect(workloadBefore.totalToConfirm).toBeGreaterThan(0)

        // Exactly the shape page.tsx's applyDeterministicFixedFeeTiming
        // builds and confirmAndApply() sends — interpret-rule/AI never
        // called for this path.
        const res = await confirmRule(new NextRequest(`http://localhost/api/jobs/${fixture.jobId}/confirm-rule`, {
          method: 'POST',
          body: JSON.stringify({ ruleType: 'fixed_fee_billing_timing', reviewerInput: '', approvedInterpretation: { timing: optionId, source_clause: null } }),
          headers: { 'content-type': 'application/json' },
        }), { params: Promise.resolve({ id: fixture.jobId }) })
        const body = await res.json()
        console.log('E5_CONFIRM_RESULT:', optionId, res.status, JSON.stringify(body))
        expect([200, 207]).toContain(res.status)

        const { data: termsAfter } = await supabaseServer.from('contract_terms')
          .select('base_monthly_fee, fixed_fee_billing_timing, overage_tiers, additional_recurring_fees, discounts, service_credits, one_time_fees, unsupported_commercial_mechanisms')
          .eq('job_id', fixture.jobId).single()
        const timingAfter = termsAfter?.fixed_fee_billing_timing as { timing?: string; requires_confirmation?: boolean }
        expect(timingAfter.timing).toBe(optionId)
        expect(timingAfter.requires_confirmation).toBe(false)

        const { data: interpretations } = await supabaseServer.from('commercial_rule_interpretations')
          .select('id, rule_type, is_current').eq('job_id', fixture.jobId).eq('rule_type', 'fixed_fee_billing_timing').eq('is_current', true)
        expect(interpretations?.length).toBe(1)

        const workloadAfter = computeCommercialRuleWorkload(termsAfter as never, { total: 0, confirmed: 0 }, 0, new Set(), { configured: true }, [], [], new Date(), true)
        console.log('E5_WORKLOAD_AFTER:', optionId, JSON.stringify({ totalToConfirm: workloadAfter.totalToConfirm }))
        expect(workloadAfter.totalToConfirm).toBe(workloadBefore.totalToConfirm - 1)

        // §13 — schedule-compiler regression check only, compiler untouched.
        const decision = resolveFixedFeeSchedulingDecision(
          { invoice_type: 'period', period_start: '2027-02-01', period_end: '2027-02-28' },
          timingAfter as never,
          expectedDueField === 'period_start' ? '2027-02-01' : '2027-02-15',
        )
        console.log('E5_SCHEDULE_DECISION:', optionId, JSON.stringify(decision))
        expect(decision.action).toBe(expectedDueField === 'period_start' ? 'due' : 'not_yet_due')
      } finally {
        await cleanup(fixture.orgId, fixture.jobId)
      }
    }
  }, 60000)
})
