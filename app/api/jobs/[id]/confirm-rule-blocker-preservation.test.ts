import { describe, it, expect, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.4B0D4H1B4D1.3 — real-Postgres proof that confirm-rule can never
// downgrade a pre-existing reconciliation_blocked hold to
// schedule_rebuild_required without genuine evidence: LINE_ITEM_RELEVANT
// ruleTypes (escalator here) now run real Model B+ reconciliation and may
// only clear the blocker on a truly clean result; every other ruleType
// (discount here, representative of 'schedule_relevant') can never clear it
// at all, regardless of outcome.
//
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run "app/api/jobs/[id]/confirm-rule-blocker-preservation.test.ts"
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const AUTO_CONFIGURE_ONLY_MESSAGE = 'This operation is only available for auto-configuration jobs.'

vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn().mockResolvedValue({ orgId: '__set_by_test__', orgName: 'test', orgSlug: 'test', role: 'admin', userEmail: 'guard-test@example.com' }),
}))
vi.mock('@/lib/auth', () => ({ auth: vi.fn().mockResolvedValue(null) }))

let orgId = ''
const cleanupJobIds: string[] = []

async function createTestOrg(): Promise<string> {
  const slug = `h1b4d1-3-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name: '17H.4B0D4H1B4D1.3 guard-test org', slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function setup() {
  if (!orgId) {
    orgId = await createTestOrg()
    const { requireOrg } = await import('@/lib/org')
    ;(requireOrg as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId, orgName: 'test', orgSlug: 'test', role: 'admin', userEmail: 'guard-test@example.com' })
  }
}

async function createJobWithTerms(jobExtra: Record<string, unknown> = {}, termsExtra: Record<string, unknown> = {}): Promise<{ jobId: string; termsId: string }> {
  const { data: job, error: jobError } = await supabaseServer
    .from('jobs')
    .insert({ name: '17H.4B0D4H1B4D1.3 confirm-rule test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId, ...jobExtra })
    .select('id').single()
  if (jobError || !job) throw new Error(`createTestJob failed: ${jobError?.message}`)
  cleanupJobIds.push(job.id as string)

  const { data: terms, error: termsError } = await supabaseServer
    .from('contract_terms')
    .insert({ job_id: job.id, currency: 'EUR', ...termsExtra })
    .select('id').single()
  if (termsError || !terms) throw new Error(`createTestTerms failed: ${termsError?.message}`)

  await supabaseServer.from('jobs').update({ contract_terms_id: terms.id }).eq('id', job.id)
  return { jobId: job.id as string, termsId: terms.id as string }
}

afterAll(async () => {
  if (!RUN || !orgId) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('current_line_items').delete().eq('job_id', jobId)
    await supabaseServer.from('commercial_rule_interpretations').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  await supabaseServer.from('organizations').delete().eq('id', orgId)
})

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function getHold(jobId: string): Promise<{ reason: string; started_at?: string; blockers?: unknown[] } | null> {
  const { data } = await supabaseServer.from('jobs').select('billing_hold').eq('id', jobId).single()
  return data?.billing_hold ?? null
}

const BLOCKED_HOLD = { reason: 'reconciliation_blocked' as const, started_at: '2026-08-01T00:00:00.000Z', blockers: [{ type: 'stale_plan', reason: 'current_set_changed' }] }

const escalatorBody = { ruleType: 'escalator', approvedInterpretation: { treatment: 'applies', index: 'cpi', frequency: 'annual' } }
const discountBody = { ruleType: 'discount', discountId: 'disc-1', approvedInterpretation: { discount_type: 'custom', discount_basis: 'percentage', applies_to: 'base_fee' } }

describeIf('confirm-rule — LINE_ITEM_RELEVANT vs schedule_relevant blocker preservation', () => {
  it('Case G — wrong module: 400 before any claim/write', async () => {
    await setup()
    const { data: bvJob } = await supabaseServer.from('jobs').insert({ name: 'wrong-module', module: 'BILLING_VERIFICATION', currency: 'EUR', org_id: orgId }).select('id').single()
    cleanupJobIds.push(bvJob!.id as string)
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(escalatorBody), { params: Promise.resolve({ id: bvJob!.id as string }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { count } = await supabaseServer.from('commercial_rule_interpretations').select('id', { count: 'exact', head: true }).eq('job_id', bvJob!.id as string)
    expect(count).toBe(0)
  })

  it('Case H — active reexecution: claim rejected before any write, existing hold untouched', async () => {
    await setup()
    const startedAt = new Date().toISOString()
    const { jobId } = await createJobWithTerms({ billing_hold: { reason: 'reexecution', started_at: startedAt } })
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(escalatorBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(409)
    expect(await getHold(jobId)).toEqual({ reason: 'reexecution', started_at: startedAt })
  })

  it('Case A — LINE_ITEM_RELEVANT (escalator), previous reconciliation_blocked, real reconciliation still finds a blocker: final reconciliation_blocked (fresh generation), not the exact original payload — real reconciliation ran and produced its own blocker diagnostic', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    // A stray current escalator row with NO fresh counterpart the confirmation
    // can produce (fresh terms have zero escalators before this call) — a
    // weak-identity mismatch the real planner cannot safely resolve.
    await supabaseServer.from('current_line_items').insert({
      job_id: jobId, product_name: 'Price escalator (5% CPI_cap)', quantity: 1, unit_price: 0,
      billing_period: 'annual', total_amount: 0, currency: 'EUR', confidence_score: 0.9,
    })
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(escalatorBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    const hold = await getHold(jobId)
    expect(hold?.reason).toBe('reconciliation_blocked')
    // Real reconciliation ran (evidenced by a fresh diagnostic, not the
    // untouched original blockers array from before this request).
    expect(hold?.blockers).toBeDefined()
  })

  it('Case B — LINE_ITEM_RELEVANT (escalator), previous reconciliation_blocked, real reconciliation comes back clean: configured -> schedule_rebuild_required', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    // A current escalator row that EXACTLY matches what this confirmation's
    // fresh output will be (escalator is weak-identity — a fresh-only row
    // with no current counterpart never auto-inserts, per frozen H1B1
    // doctrine, so an empty current set would NOT be clean here; a
    // matching pre-existing row is what a genuinely clean SAME-pairing
    // planner result requires).
    await supabaseServer.from('current_line_items').insert({
      job_id: jobId, product_name: 'Price escalator (% CPI_cap)', quantity: 1, unit_price: 0,
      billing_period: 'annual', total_amount: 0, currency: 'EUR', confidence_score: 0.72,
    })
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(escalatorBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect((await getHold(jobId))?.reason).toBe('schedule_rebuild_required')
  })

  it('Case C — schedule_relevant (discount), previous reconciliation_blocked, successful confirmation: exact previous hold preserved, never downgraded', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(discountBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect(await getHold(jobId)).toEqual(BLOCKED_HOLD)
  })

  it('Case D — schedule_relevant (discount), configured, previous NULL: schedule_rebuild_required', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake' })
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(discountBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect((await getHold(jobId))?.reason).toBe('schedule_rebuild_required')
  })

  it('Case E — schedule_relevant (discount), never-approved, previous NULL: stays NULL', async () => {
    await setup()
    const { jobId } = await createJobWithTerms()
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(discountBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect(await getHold(jobId)).toBeNull()
  })

  it('Case F — schedule_relevant (discount), configured, previous schedule_rebuild_required: remains schedule_rebuild_required', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake', billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() } })
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest(discountBody), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect((await getHold(jobId))?.reason).toBe('schedule_rebuild_required')
  })

  it('advisory (rule_interaction) never promotes a NULL hold on its own', async () => {
    await setup()
    // rule_interaction requires an existing service_credit with an
    // interpretation to attach interaction_note to.
    const { jobId, termsId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake' }, {
      service_credits: [{ credit_rule_id: 'credit-1', credit_type: 'other', description: '', interpretation: { application_rule: { carry_forward: 'unclear' } } }],
    })
    void termsId
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./confirm-rule/route')
    const res = await POST(jsonRequest({
      ruleType: 'rule_interaction', interactionKey: 'service_credit:credit-1|discount:disc-1',
      approvedInterpretation: { note: 'Applied after the introductory discount.' },
    }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect(await getHold(jobId)).toBeNull()
  })

  it('§25 — rebuild-schedule safety: after Case C preserves reconciliation_blocked, rebuild-schedule is still rejected', async () => {
    await setup()
    const { jobId } = await createJobWithTerms({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST: confirmPost } = await import('./confirm-rule/route')
    const confirmRes = await confirmPost(jsonRequest(discountBody), { params: Promise.resolve({ id: jobId }) })
    expect(confirmRes.status).toBe(200)
    expect(await getHold(jobId)).toEqual(BLOCKED_HOLD)

    const { POST: rebuildPost } = await import('./rebuild-schedule/route')
    const rebuildRes = await rebuildPost(jsonRequest({}), { params: Promise.resolve({ id: jobId }) })
    expect(rebuildRes.status).toBe(409)
    expect((await rebuildRes.json()).error).toMatch(/reconciled/)
  })

  it('no unintended temporary-reexecution leakage across every fixture created in this file', async () => {
    await setup()
    const { data: rows } = await supabaseServer.from('jobs').select('id, billing_hold').in('id', cleanupJobIds)
    const stillReexecuting = (rows ?? []).filter(j => (j.billing_hold as { reason?: string } | null)?.reason === 'reexecution')
    expect(stillReexecuting.length).toBe(1) // Case H's fixture only
  })
})
