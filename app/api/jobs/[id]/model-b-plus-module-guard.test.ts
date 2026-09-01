import { describe, it, expect, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.4B0D4H1B4C — real-Postgres proof that the six Model B+ commercial-
// mutation routes (reconcile-line-items, confirm-rule, terms PATCH, reviewer
// line-items PATCH, reconcile-semantic-keys, reconcile-fixed-fee-timing) are
// now hard-guarded to AUTO_CONFIGURE jobs only, per H1B4B's audit finding
// that BILLING_VERIFICATION/PARTNER_RECON never legitimately reach any of
// them. Exercises the real exported route handlers (not a re-implementation
// of the guard logic) against real synthetic jobs of all three modules in
// the test database — requireOrg/auth are mocked (no next-auth session
// machinery needed), everything else is real.
//
// Each route's positive (AUTO_CONFIGURE) case only asserts that the module
// guard did not fire — it may still fail on ordinary business validation
// (missing contract_terms, missing body fields) since these fixtures are
// deliberately minimal; that's a *different*, non-module 400/200, which is
// exactly the proof needed that the module check let it through.
//
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run app/api/jobs/[id]/model-b-plus-module-guard.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

const AUTO_CONFIGURE_ONLY_MESSAGE = 'This operation is only available for auto-configuration jobs.'

vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn().mockResolvedValue({
    orgId: '__set_by_test__', orgName: 'test', orgSlug: 'test', role: 'admin', userEmail: 'guard-test@example.com',
  }),
}))
vi.mock('@/lib/auth', () => ({ auth: vi.fn().mockResolvedValue(null) }))

// requireOrg is mocked at module scope above (orgId fixed at mock-definition
// time) — routed around by scoping every fixture under ONE org created once,
// and pointing the mock's orgId at it before any test runs.
let orgId = ''
const cleanupJobIds: string[] = []

async function createTestOrg(): Promise<string> {
  const slug = `h1b4c-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name: '17H.4B0D4H1B4C guard-test org', slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(module: 'AUTO_CONFIGURE' | 'BILLING_VERIFICATION' | 'PARTNER_RECON'): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: `17H.4B0D4H1B4C ${module} guard-test job`, module, currency: 'EUR', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

async function setup() {
  if (!orgId) {
    orgId = await createTestOrg()
    const { requireOrg } = await import('@/lib/org')
    ;(requireOrg as ReturnType<typeof vi.fn>).mockResolvedValue({
      orgId, orgName: 'test', orgSlug: 'test', role: 'admin', userEmail: 'guard-test@example.com',
    })
  }
}

afterAll(async () => {
  if (!RUN || !orgId) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('current_line_items').delete().eq('job_id', jobId)
    await supabaseServer.from('line_items').delete().eq('job_id', jobId)
    await supabaseServer.from('commercial_rule_interpretations').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  await supabaseServer.from('organizations').delete().eq('id', orgId)
})

function jsonRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describeIf('Model B+ commercial-mutation routes — AUTO_CONFIGURE module guard', () => {
  it('reconcile-line-items: BILLING_VERIFICATION and PARTNER_RECON are rejected before any claim/mutation; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./reconcile-line-items/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest(), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { data: bvJob } = await supabaseServer.from('jobs').select('billing_hold').eq('id', bvJobId).single()
    expect(bvJob!.billing_hold).toBeNull()

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest(), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest(), { params: Promise.resolve({ id: acJobId }) })
    // No contract_terms fixture on this job — the module gate passed, and
    // ordinary business validation (no contract terms on file) is what
    // actually rejects it.
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('confirm-rule: BILLING_VERIFICATION and PARTNER_RECON are rejected before the audit insert; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./confirm-rule/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest({ ruleType: 'escalator', approvedInterpretation: {} }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { count } = await supabaseServer.from('commercial_rule_interpretations').select('id', { count: 'exact', head: true }).eq('job_id', bvJobId)
    expect(count).toBe(0)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest({ ruleType: 'escalator', approvedInterpretation: {} }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest({}), { params: Promise.resolve({ id: acJobId }) })
    // Missing ruleType/approvedInterpretation — the module gate passed, and
    // ordinary body validation is what actually rejects it.
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('terms PATCH: BILLING_VERIFICATION and PARTNER_RECON are rejected before contract_terms.update; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { PATCH } = await import('./terms/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await PATCH(jsonRequest({ currency: 'USD' }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await PATCH(jsonRequest({ currency: 'USD' }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await PATCH(jsonRequest({}), { params: Promise.resolve({ id: acJobId }) })
    // No valid fields in the body — the module gate passed, and ordinary
    // field validation is what actually rejects it.
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('reviewer line-items PATCH: BILLING_VERIFICATION and PARTNER_RECON are rejected before the stale-row read, even for a confidence-only edit; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { PATCH } = await import('./line-items/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await PATCH(jsonRequest({ itemId: 'does-not-matter', fields: { confidence_score: 0.9 } }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await PATCH(jsonRequest({ itemId: 'does-not-matter', fields: { confidence_score: 0.9 } }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await PATCH(jsonRequest({ itemId: 'nonexistent-item', fields: { confidence_score: 0.9 } }), { params: Promise.resolve({ id: acJobId }) })
    // Module gate passed; itemId matches no row, so the update is a
    // no-op 200 (existing, unrelated behavior for a missing itemId).
    expect(acRes.status).not.toBe(400)
  })

  it('reconcile-semantic-keys: BILLING_VERIFICATION and PARTNER_RECON are rejected before any write; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./reconcile-semantic-keys/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest(), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest(), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest(), { params: Promise.resolve({ id: acJobId }) })
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('reconcile-fixed-fee-timing: BILLING_VERIFICATION and PARTNER_RECON are rejected before any write; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./reconcile-fixed-fee-timing/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest(), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest(), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest(), { params: Promise.resolve({ id: acJobId }) })
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })
})
