import { describe, it, expect, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.4B0D4H1B4D1 — real-Postgres proof that the four remaining
// high-risk writer families (rebuild-schedule, meter-mappings POST,
// operational-events attest/revoke, org/rulebook/promote) are now hard-
// guarded to AUTO_CONFIGURE jobs only, plus targeted safety-matrix coverage
// for rebuild-schedule's existing (unmodified) billing-hold gate and
// meter-mappings' new configuration-mutation claim wiring.
//
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run "app/api/jobs/[id]/h1b4d1-writer-safety-guard.test.ts"
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
  const slug = `h1b4d1-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name: '17H.4B0D4H1B4D1 guard-test org', slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(module: 'AUTO_CONFIGURE' | 'BILLING_VERIFICATION' | 'PARTNER_RECON', extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: `17H.4B0D4H1B4D1 ${module} guard-test job`, module, currency: 'EUR', org_id: orgId, ...extra })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  cleanupJobIds.push(data.id as string)
  return data.id as string
}

async function setup() {
  if (!orgId) {
    orgId = await createTestOrg()
    const { requireOrg } = await import('@/lib/org')
    ;(requireOrg as ReturnType<typeof vi.fn>).mockResolvedValue({ orgId, orgName: 'test', orgSlug: 'test', role: 'admin', userEmail: 'guard-test@example.com' })
  }
}

afterAll(async () => {
  if (!RUN || !orgId) return
  for (const jobId of cleanupJobIds) {
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('operational_event_evidence').delete().eq('job_id', jobId)
    await supabaseServer.from('current_line_items').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
  }
  await supabaseServer.from('organizations').delete().eq('id', orgId)
})

function jsonRequest(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describeIf('H1B4D1 writer-safety module guards + rebuild-schedule hold matrix', () => {
  it('rebuild-schedule: BILLING_VERIFICATION/PARTNER_RECON rejected before any billing-hold check; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./rebuild-schedule/route')

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
    // No billing_customer_id — module gate passed, ordinary "approve first" validation rejects it.
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('rebuild-schedule: existing billing-hold gate is unmodified — schedule_rebuild_required allowed through, reexecution/reconciliation_blocked rejected, all without any provider call', async () => {
    await setup()
    const { POST } = await import('./rebuild-schedule/route')

    const rebuildJobId = await createTestJob('AUTO_CONFIGURE', { billing_customer_id: 'cus_test_fake', billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() } })
    const rebuildRes = await POST(jsonRequest(), { params: Promise.resolve({ id: rebuildJobId }) })
    // No billing_platform on this fixture — the gate allowed it through, and
    // the NEXT check (no platform recorded) is what actually rejects it —
    // proof the hold gate itself did not block, without ever reaching
    // configureBilling/a real provider call.
    expect(rebuildRes.status).toBe(400)
    expect((await rebuildRes.json()).error).toMatch(/billing platform/)

    const reexecJobId = await createTestJob('AUTO_CONFIGURE', { billing_customer_id: 'cus_test_fake', billing_hold: { reason: 'reexecution', started_at: new Date().toISOString() } })
    const reexecRes = await POST(jsonRequest(), { params: Promise.resolve({ id: reexecJobId }) })
    expect(reexecRes.status).toBe(409)
    expect((await reexecRes.json()).error).toMatch(/re-executed/)

    const blockedJobId = await createTestJob('AUTO_CONFIGURE', { billing_customer_id: 'cus_test_fake', billing_hold: { reason: 'reconciliation_blocked', started_at: new Date().toISOString() } })
    const blockedRes = await POST(jsonRequest(), { params: Promise.resolve({ id: blockedJobId }) })
    expect(blockedRes.status).toBe(409)
    expect((await blockedRes.json()).error).toMatch(/reconciled/)
  })

  it('meter-mappings POST: BILLING_VERIFICATION/PARTNER_RECON rejected before any write; AUTO_CONFIGURE writes contract_meter_mappings under a real claim', async () => {
    await setup()
    const { POST } = await import('./meter-mappings/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest({ mappings: [{ contract_unit_type: 'api_call', meter_key: 'api_call', confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' }] }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { count: bvCount } = await supabaseServer.from('contract_meter_mappings').select('id', { count: 'exact', head: true }).eq('job_id', bvJobId)
    expect(bvCount).toBe(0)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest({ mappings: [{ contract_unit_type: 'api_call', meter_key: 'api_call', confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' }] }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest({ mappings: [{ contract_unit_type: 'api_call', meter_key: 'api_call', confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' }] }), { params: Promise.resolve({ id: acJobId }) })
    expect(acRes.status).toBe(200)
    const acBody = await acRes.json()
    expect(acBody.ok).toBe(true)
    const { data: mappingRow } = await supabaseServer.from('contract_meter_mappings').select('id, meter_key').eq('job_id', acJobId).maybeSingle()
    expect(mappingRow?.meter_key).toBe('api_call')
    // The claim/hold-transition ran without a holdConflict on this
    // uncontended, single-request fixture.
    expect(acBody.holdConflict).toBeUndefined()
  })

  it('operational-events attest: BILLING_VERIFICATION/PARTNER_RECON rejected before any evidence write; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./operational-events/attest/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest({ subjectId: 'fee-1', occurredAt: new Date().toISOString() }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { count } = await supabaseServer.from('operational_event_evidence').select('id', { count: 'exact', head: true }).eq('job_id', bvJobId)
    expect(count).toBe(0)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest({ subjectId: 'fee-1', occurredAt: new Date().toISOString() }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest({ subjectId: 'fee-1', occurredAt: new Date().toISOString() }), { params: Promise.resolve({ id: acJobId }) })
    // No contract_terms on this job — module gate passed, ordinary validation rejects it.
    expect(acRes.status).toBe(400)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('operational-events revoke: BILLING_VERIFICATION/PARTNER_RECON rejected before the execute_status checks; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('./operational-events/revoke/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest({ subjectId: 'fee-1' }), { params: Promise.resolve({ id: bvJobId }) })
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest({ subjectId: 'fee-1' }), { params: Promise.resolve({ id: prJobId }) })
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest({ subjectId: 'fee-1' }), { params: Promise.resolve({ id: acJobId }) })
    expect(acRes.status).toBe(404)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })

  it('operational-events revoke: existing execute_status fail-closed safeguards are unmodified (COMPLETED/APPROVING still block, checked after the module gate)', async () => {
    await setup()
    const { POST } = await import('./operational-events/revoke/route')

    const completedJobId = await createTestJob('AUTO_CONFIGURE', { execute_status: 'COMPLETED' })
    const completedRes = await POST(jsonRequest({ subjectId: 'fee-1' }), { params: Promise.resolve({ id: completedJobId }) })
    expect(completedRes.status).toBe(409)
    expect((await completedRes.json()).code).toBe('billing_already_executed')

    const approvingJobId = await createTestJob('AUTO_CONFIGURE', { execute_status: 'APPROVING' })
    const approvingRes = await POST(jsonRequest({ subjectId: 'fee-1' }), { params: Promise.resolve({ id: approvingJobId }) })
    expect(approvingRes.status).toBe(409)
    expect((await approvingRes.json()).code).toBe('billing_in_progress')
  })

  it('org/rulebook/promote: BILLING_VERIFICATION/PARTNER_RECON rejected before the contract_terms read; AUTO_CONFIGURE passes the gate', async () => {
    await setup()
    const { POST } = await import('../../org/rulebook/promote/route')

    const bvJobId = await createTestJob('BILLING_VERIFICATION')
    const bvRes = await POST(jsonRequest({ jobId: bvJobId, creditId: 'credit-1' }))
    expect(bvRes.status).toBe(400)
    expect((await bvRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    // PARTNER_RECON never has contract_terms_id (H1B4B) — proves the module
    // check is reached and fires BEFORE the contract_terms_id existence
    // check, not merely coincide with a generic not-found.
    const prJobId = await createTestJob('PARTNER_RECON')
    const prRes = await POST(jsonRequest({ jobId: prJobId, creditId: 'credit-1' }))
    expect(prRes.status).toBe(400)
    expect((await prRes.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)

    const acJobId = await createTestJob('AUTO_CONFIGURE')
    const acRes = await POST(jsonRequest({ jobId: acJobId, creditId: 'credit-1' }))
    // No contract_terms_id on this fixture — module gate passed, ordinary
    // not-found validation (distinct code path) rejects it with a plain 404.
    expect(acRes.status).toBe(404)
    expect((await acRes.json()).error).not.toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
  })
})
