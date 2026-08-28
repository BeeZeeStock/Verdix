import { describe, it, expect, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { computeCommercialRuleWorkload, type CommercialRuleTerms } from './commercial-rule-status'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17F.4, item 7 — real-Postgres proof, on a SAFE TEST FIXTURE (never
// the real Remembill job — no reviewer selection is ever made on that job
// by this test), that a reviewer's fixed-fee billing-timing choice:
//   1. persists with the chosen timing and requires_confirmation: false
//      (mirrors confirm-rule/route.ts's own buildFixedFeeBillingTimingRule
//      exactly — replicated inline here since confirm-rule's route needs
//      an authenticated session this script context doesn't have, same
//      substitution pattern used throughout this project whenever a real
//      authenticated HTTP call isn't feasible),
//   2. clears the lib/commercial-rule-status.ts readiness blocker.
// Proven for BOTH bill_at_period_start and bill_at_period_end.
//
// Depends on supabase/migrations/20260907000001_fixed_fee_billing_timing_
// column.sql having been applied — this file documents that dependency by
// actually attempting the write and reporting the real result.
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run lib/fixed-fee-billing-timing-review-integration.test.ts
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

async function createTestJobWithFixedFee(orgId: string): Promise<{ jobId: string; termsId: string }> {
  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .insert({ name: '17F.4 fixed-fee-timing review test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId })
    .select('id').single()
  if (jobError || !job) throw new Error(`createTestJob failed: ${jobError?.message}`)
  cleanupJobIds.push(job.id as string)

  const { data: terms, error: termsError } = await supabaseServer
    .from('contract_terms')
    .insert({
      job_id: job.id, currency: 'SEK', base_monthly_fee: 2000,
      fixed_fee_billing_timing: {
        timing: 'unclear', requires_confirmation: true,
        confirmation_reason: 'The agreement does not state whether the recurring fixed fee is invoiced at the beginning or the end of its billing period.',
        source_clause: null,
      },
    })
    .select('id').single()
  if (termsError || !terms) throw new Error(`contract_terms insert failed: ${termsError?.message}`)

  return { jobId: job.id as string, termsId: terms.id as string }
}

// Mirrors app/api/jobs/[id]/confirm-rule/route.ts's own
// buildFixedFeeBillingTimingRule exactly.
function buildConfirmedRule(timing: 'bill_at_period_start' | 'bill_at_period_end', sourceClause: string | null) {
  return { timing, source_clause: sourceClause, requires_confirmation: false, confirmation_reason: null }
}

afterAll(async () => {
  if (!RUN) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  for (const orgId of cleanupOrgIds) {
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  }
}, 60_000)

describeIf('fixed_fee_billing_timing reviewer confirmation — real-Postgres proof (Step 17F.4, item 7)', () => {
  it('a genuinely unresolved fixture blocks readiness before confirmation', async () => {
    const orgId = await createTestOrg('17F.4 fixed-timing-unresolved org')
    const { termsId } = await createTestJobWithFixedFee(orgId)
    const { data: terms } = await supabaseServer.from('contract_terms').select('*').eq('id', termsId).single()
    const workload = computeCommercialRuleWorkload(terms as unknown as CommercialRuleTerms, { total: 0, confirmed: 0 })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.blockers).toContain('fixed_fee_billing_timing')
  })

  it('reviewer selects "beginning of billing period" -> bill_at_period_start, reviewer_policy-shaped rule, blocker clears', async () => {
    const orgId = await createTestOrg('17F.4 fixed-timing-start org')
    const { termsId } = await createTestJobWithFixedFee(orgId)

    const rule = buildConfirmedRule('bill_at_period_start', 'Reviewer confirmed via structured option.')
    const { error } = await supabaseServer.from('contract_terms').update({ fixed_fee_billing_timing: rule }).eq('id', termsId)
    expect(error).toBeNull()

    const { data: after } = await supabaseServer.from('contract_terms').select('*').eq('id', termsId).single()
    expect(after!.fixed_fee_billing_timing).toEqual(rule)
    const workload = computeCommercialRuleWorkload(after as unknown as CommercialRuleTerms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.blockers).not.toContain('fixed_fee_billing_timing')
  })

  it('reviewer selects "end of billing period" -> bill_at_period_end, reviewer_policy-shaped rule, blocker clears', async () => {
    const orgId = await createTestOrg('17F.4 fixed-timing-end org')
    const { termsId } = await createTestJobWithFixedFee(orgId)

    const rule = buildConfirmedRule('bill_at_period_end', 'Reviewer confirmed via structured option.')
    const { error } = await supabaseServer.from('contract_terms').update({ fixed_fee_billing_timing: rule }).eq('id', termsId)
    expect(error).toBeNull()

    const { data: after } = await supabaseServer.from('contract_terms').select('*').eq('id', termsId).single()
    expect(after!.fixed_fee_billing_timing).toEqual(rule)
    const workload = computeCommercialRuleWorkload(after as unknown as CommercialRuleTerms, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.blockers).not.toContain('fixed_fee_billing_timing')
  })
})
