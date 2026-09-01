import { describe, it, expect, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.4B0D4H1B4D1.1/.2 — real-Postgres proof of meter-mappings POST's
// configuration-mutation claim lifecycle. .2 specifically proves that a
// non-reconciling mapping mutation can NEVER downgrade a pre-existing
// reconciliation_blocked hold to schedule_rebuild_required — only an
// operation that actually runs Model B+ reconciliation (reconcile-line-
// items, terms, confirm-rule's base_fee_proration branch) may make that
// claim. Every other starting state (NULL, schedule_rebuild_required)
// behaves exactly as .1 established.
//
// Run deliberately:
//   RUN_RLS_INTEGRATION_TESTS=true node --env-file=.env.local node_modules/.bin/vitest run "app/api/jobs/[id]/meter-mappings-claim-lifecycle.test.ts"
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
  const slug = `h1b4d1-2-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name: '17H.4B0D4H1B4D1.2 guard-test org', slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: '17H.4B0D4H1B4D1.2 meter-mapping lifecycle job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId, ...extra })
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
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
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

const oneMapping = (overrides: Record<string, unknown> = {}) => ([{
  contract_unit_type: 'api_call', meter_key: 'api_call', confirmed: false,
  included_units: 0, overage_tiers: [], billing_cycle: 'monthly', ...overrides,
}])

const BLOCKED_HOLD = { reason: 'reconciliation_blocked' as const, started_at: '2026-08-01T00:00:00.000Z', blockers: [{ type: 'stale_plan', reason: 'current_set_changed' }] }

describeIf('meter-mappings POST — configuration-mutation claim lifecycle', () => {
  it('wrong module: 400 before any claim/write', async () => {
    await setup()
    const { POST } = await import('./meter-mappings/route')
    const { data: bvJob } = await supabaseServer.from('jobs').insert({ name: 'wrong-module', module: 'BILLING_VERIFICATION', currency: 'EUR', org_id: orgId }).select('id').single()
    cleanupJobIds.push(bvJob!.id as string)
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: bvJob!.id as string }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(AUTO_CONFIGURE_ONLY_MESSAGE)
    const { count } = await supabaseServer.from('contract_meter_mappings').select('id', { count: 'exact', head: true }).eq('job_id', bvJob!.id as string)
    expect(count).toBe(0)
  })

  it('Case A — configured job, previous reconciliation_blocked, mapping succeeds: final state is still reconciliation_blocked, with the EXACT original blocker payload preserved', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    const hold = await getHold(jobId)
    expect(hold).toEqual(BLOCKED_HOLD)
  })

  it('Case B — never-approved job, previous reconciliation_blocked, mapping succeeds: still reconciliation_blocked, NOT cleared to NULL merely because no schedule exists', async () => {
    await setup()
    const jobId = await createTestJob({ billing_hold: BLOCKED_HOLD }) // no billing_customer_id
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    const hold = await getHold(jobId)
    expect(hold).toEqual(BLOCKED_HOLD)
  })

  it('Case C — configured, previous schedule_rebuild_required, mapping succeeds: stays schedule_rebuild_required', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake', billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() } })
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect((await getHold(jobId))?.reason).toBe('schedule_rebuild_required')
  })

  it('Case D — configured, previous NULL, mapping succeeds: schedule_rebuild_required', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake' })
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect((await getHold(jobId))?.reason).toBe('schedule_rebuild_required')
  })

  it('Case E — never-approved, previous NULL, mapping succeeds: NULL', async () => {
    await setup()
    const jobId = await createTestJob()
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    expect(await getHold(jobId)).toBeNull()
  })

  it('Case F — previous reconciliation_blocked, fully-confirmed mapping (real org-wide write attempted): still reconciliation_blocked regardless of the org-wide write outcome — the code branches on the previous hold before ever consulting orgWideConfigWriteFailed', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping({ confirmed: true }) }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.all_confirmed).toBe(true)
    // The org-wide write itself succeeded (nothing to violate here) — this
    // is the STRONGER proof: even a fully successful, all-confirmed
    // completion does not clear a pre-existing blocker, because the code
    // never reaches the orgWideConfigWriteFailed branch at all once the
    // previous hold is reconciliation_blocked (see route source: the
    // reconciliation_blocked check comes first, unconditionally).
    expect(body.orgWideConfigWriteFailed).toBeUndefined()
    const hold = await getHold(jobId)
    expect(hold).toEqual(BLOCKED_HOLD)
  })

  it('write failure before mutation (meter_key NOT NULL violated): claim restored to the exact previous hold via CAS', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake' })
    expect(await getHold(jobId)).toBeNull()
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping({ meter_key: null }) }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(500)
    expect(await getHold(jobId)).toBeNull()
    const { count } = await supabaseServer.from('contract_meter_mappings').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
    expect(count).toBe(0)
  })

  it('write failure before mutation, starting from reconciliation_blocked: restored to the exact previous blocked hold, not NULL', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping({ meter_key: null }) }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(500)
    expect(await getHold(jobId)).toEqual(BLOCKED_HOLD)
  })

  it('active reexecution: claim rejected before any write, existing hold untouched', async () => {
    await setup()
    const startedAt = new Date().toISOString()
    const jobId = await createTestJob({ billing_hold: { reason: 'reexecution', started_at: startedAt } })
    const { POST } = await import('./meter-mappings/route')
    const res = await POST(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(res.status).toBe(409)
    expect(await getHold(jobId)).toEqual({ reason: 'reexecution', started_at: startedAt })
  })

  it('§13 — rebuild-schedule safety: after Case A preserves reconciliation_blocked, rebuild-schedule is still rejected by the billing-hold gate', async () => {
    await setup()
    const jobId = await createTestJob({ billing_customer_id: 'cus_test_fake', billing_hold: BLOCKED_HOLD })
    const { POST: mappingsPost } = await import('./meter-mappings/route')
    const mapRes = await mappingsPost(jsonRequest({ mappings: oneMapping() }), { params: Promise.resolve({ id: jobId }) })
    expect(mapRes.status).toBe(200)
    expect(await getHold(jobId)).toEqual(BLOCKED_HOLD)

    const { POST: rebuildPost } = await import('./rebuild-schedule/route')
    const rebuildRes = await rebuildPost(jsonRequest({}), { params: Promise.resolve({ id: jobId }) })
    expect(rebuildRes.status).toBe(409)
    expect((await rebuildRes.json()).error).toMatch(/reconciled/)
    // Proves an unrelated meter-mapping edit cannot accidentally make a
    // still-blocked job eligible for schedule rebuild/hold clear.
    expect(await getHold(jobId)).toEqual(BLOCKED_HOLD)
  })

  it('no unintended temporary-reexecution leakage across every fixture created in this file', async () => {
    await setup()
    const { data: rows } = await supabaseServer
      .from('jobs')
      .select('id, billing_hold')
      .in('id', cleanupJobIds)
    const stillReexecuting = (rows ?? []).filter(j => (j.billing_hold as { reason?: string } | null)?.reason === 'reexecution')
    // Exactly one job in this file's fixtures is EXPECTED to still be under
    // 'reexecution': the "active reexecution" scenario, which meter-mappings
    // never touches (claim.claimed was false).
    expect(stillReexecuting.length).toBe(1)
  })
})
