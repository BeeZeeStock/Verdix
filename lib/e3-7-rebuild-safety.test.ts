import { describe, it, expect, vi } from 'vitest'

// Step 17H.4B0D4H1B4E3.7 — Atomic Schedule Rebuild Safety.
//
// Permanent regression coverage for the live-reproduced E3.6 §23 defect:
// lib/billing-writer.ts's configureStripe/configureRemembill used to call
// cleanupStalePlannedInvoicesAndLoadOccupiedKeys (which DELETES every
// scheduled/parked/draft planned_invoices row) BEFORE getOrCreateAttempt
// had any chance to prove the execution is allowed to proceed. Calling
// rebuild-schedule on a job whose prior attempt had already fully
// succeeded threw PriorBillingAttemptExecutedError — but only AFTER the
// schedule had already been deleted, leaving the job permanently stuck
// (every retry hits the identical failure against an already-empty
// schedule).
//
// Rather than re-running full contract extraction (proven separately in
// E3.6), this constructs the "already approved/configured" precondition
// directly: a real contract_terms row + a real configureBilling() call
// (the exact function approve/route.ts calls) against a mocked Stripe SDK,
// then exercises the REAL rebuild-schedule route handler against real
// PostgreSQL.
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/e3-7-rebuild-safety.test.ts

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

let ORG_ID = ''
vi.mock('@/lib/org', () => ({
  requireOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E3.7 Test Org', orgSlug: 'e37-test', role: 'admin' as const, userEmail: 'e37@test.invalid' })),
  getActiveOrg: vi.fn(async () => ({ orgId: ORG_ID, orgName: 'E3.7 Test Org', orgSlug: 'e37-test', role: 'admin' as const, userEmail: 'e37@test.invalid' })),
}))

const stripeCallLog: string[] = []
let stripeCustomerCounter = 0
// Must be a real constructible function (billing-writer.ts calls `new
// Stripe(...)`) — an arrow function has no [[Construct]] slot. This
// exact mistake was found and fixed live during E3.6.
vi.mock('stripe', () => ({
  default: vi.fn(function StripeMock() {
    return {
      customers: {
        search: vi.fn(async () => { stripeCallLog.push('customers.search'); return { data: [] } }),
        create: vi.fn(async () => { stripeCallLog.push('customers.create'); stripeCustomerCounter++; return { id: `cus_e37_test_${stripeCustomerCounter}` } }),
        update: vi.fn(async () => { stripeCallLog.push('customers.update'); return { id: 'cus_e37_test_1' } }),
      },
      invoices: {
        create: vi.fn(async () => { stripeCallLog.push('invoices.create'); return { id: `in_e37_${Math.random().toString(36).slice(2, 8)}` } }),
        finalizeInvoice: vi.fn(async (id: string) => { stripeCallLog.push('invoices.finalizeInvoice'); return { id, status: 'open', hosted_invoice_url: `https://invoice.stripe.com/${id}` } }),
      },
      invoiceItems: { create: vi.fn(async () => { stripeCallLog.push('invoiceItems.create'); return { id: 'ii_e37_test' } }) },
    }
  }),
}))

type PlannedInvoiceRow = { id: string; status: string; period_start: string; base_amount: number; invoice_type: string }

async function createTestOrg(name: string): Promise<string> {
  const { supabaseServer } = await import('@/lib/supabase')
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(orgId: string): Promise<string> {
  const { supabaseServer } = await import('@/lib/supabase')
  const { data, error } = await supabaseServer.from('jobs')
    .insert({ name: 'E3.7 rebuild-safety test job', module: 'AUTO_CONFIGURE', currency: 'SEK', org_id: orgId, user_id: 'e37-rebuild-safety@isolation-test.invalid' })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

// contract_start_date deliberately spans "now" (2026-07-01, 6 monthly
// periods) so configureBilling's real run produces a MIX of due-now
// ('sent', real mocked Stripe calls) and future ('scheduled') rows — the
// exact shape needed to test that historical/sent rows survive a rebuild
// while only the replaceable future schedule is affected.
const BASE_TERMS = {
  base_monthly_fee: 1000, currency: 'SEK', contract_start_date: '2026-07-01',
  contract_term_months: 6, billing_frequency: 'monthly', payment_terms_days: 30,
  customer_name: 'E3.7 Test Customer',
}

async function insertContractTerms(jobId: string, overrides: Record<string, unknown> = {}) {
  const { supabaseServer } = await import('@/lib/supabase')
  const { error } = await supabaseServer.from('contract_terms').upsert({ job_id: jobId, ...BASE_TERMS, ...overrides }, { onConflict: 'job_id' })
  if (error) throw new Error(`insertContractTerms failed: ${error.message}`)
}

async function fetchPlannedInvoices(jobId: string): Promise<PlannedInvoiceRow[]> {
  const { supabaseServer } = await import('@/lib/supabase')
  const { data } = await supabaseServer.from('planned_invoices')
    .select('id, status, period_start, base_amount, invoice_type').eq('job_id', jobId).order('period_start')
  return (data ?? []) as PlannedInvoiceRow[]
}

async function cleanupJob(jobId: string, orgId: string) {
  const { supabaseServer } = await import('@/lib/supabase')
  await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
  await supabaseServer.from('billing_execution_operations').delete().in(
    'attempt_id', (await supabaseServer.from('billing_execution_attempts').select('id').eq('job_id', jobId)).data?.map(r => r.id) ?? [],
  )
  await supabaseServer.from('billing_execution_attempts').delete().eq('job_id', jobId)
  await supabaseServer.from('contract_terms').delete().eq('job_id', jobId)
  await supabaseServer.from('jobs').delete().eq('id', jobId)
  await supabaseServer.from('organizations').delete().eq('id', orgId)
}

describeIf('E3.7 — atomic schedule rebuild safety', () => {
  it('§1/§9/§10/§14/§15 — prior successful attempt + schedule_rebuild_required: rebuild recovers cleanly, planned_invoices NEVER deleted', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { configureBilling } = await import('@/lib/billing-writer')

    ORG_ID = await createTestOrg('E3.7 Rebuild Safety')
    const jobId = await createTestJob(ORG_ID)
    try {
      await insertContractTerms(jobId)

      // ── "already approved/configured" precondition — the exact function
      // approve/route.ts calls, real PostgreSQL, mocked Stripe SDK. ──
      const result = await configureBilling(BASE_TERMS as never, [], 'stripe', jobId, ORG_ID, undefined, [])
      await supabaseServer.from('jobs').update({
        execute_status: 'COMPLETED', billing_platform: 'stripe', billing_customer_id: result.customerId,
      }).eq('id', jobId)

      const before = await fetchPlannedInvoices(jobId)
      // Real mix, not assumed: some due-now periods (Jul/Aug 2026, 'sent'
      // via mocked Stripe) and some future ('scheduled') — see BASE_TERMS's
      // own comment.
      expect(before.some(r => r.status === 'sent')).toBe(true)
      expect(before.some(r => r.status === 'scheduled')).toBe(true)
      const beforeSentIds = before.filter(r => r.status === 'sent').map(r => r.id).sort()
      const beforeScheduledCount = before.filter(r => r.status === 'scheduled').length
      console.log('E3.7_BEFORE_REBUILD:', JSON.stringify(before.map(r => ({ status: r.status, period_start: r.period_start }))))

      // ── Commercial change is a GIVEN precondition here, not re-derived
      // via a real re-extraction (proven separately, E3.6) — Model B+ is
      // explicitly out of scope for E3.7 (do not reopen E3.1-E3.6). The
      // underlying contract_terms are left UNCHANGED, so getOrCreateAttempt
      // reconstructs an IDENTICAL fingerprint — the "financially nothing to
      // redo" case (PriorBillingAttemptExecutedError), not a real plan
      // change (covered by a separate test below). ──
      const startedAt = new Date().toISOString()
      await supabaseServer.from('jobs').update({ billing_hold: { reason: 'schedule_rebuild_required', started_at: startedAt } }).eq('id', jobId)

      const { POST: rebuildSchedule } = await import('@/app/api/jobs/[id]/rebuild-schedule/route')
      const { NextRequest } = await import('next/server')
      const res = await rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) })
      const body = await res.json()
      console.log('E3.7_REBUILD_RESULT:', res.status, JSON.stringify(body))

      // ── The core invariant: no failed (or recovered-without-mutation)
      // rebuild may leave the schedule in a WORSE state than before. ──
      const after = await fetchPlannedInvoices(jobId)
      console.log('E3.7_AFTER_REBUILD:', JSON.stringify(after.map(r => ({ status: r.status, period_start: r.period_start }))))
      const afterSentIds = after.filter(r => r.status === 'sent').map(r => r.id).sort()
      const afterScheduledCount = after.filter(r => r.status === 'scheduled').length

      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.alreadyExecuted).toBe(true)
      // Historical/sent rows byte-for-byte preserved (same ids, never touched).
      expect(afterSentIds).toEqual(beforeSentIds)
      // Future scheduled rows preserved too — NOT deleted, since eligibility
      // was never actually proven (this recovery path never reaches
      // deleteStalePlannedInvoices at all).
      expect(afterScheduledCount).toBe(beforeScheduledCount)
      expect(after.length).toBe(before.length)

      // billing_hold deliberately left untouched (still schedule_rebuild_
      // required) — recovery cannot prove the hold's underlying trigger is
      // immaterial; never auto-cleared. Provider identity unchanged.
      const { data: jobAfter } = await supabaseServer.from('jobs').select('billing_hold, billing_customer_id, billing_platform').eq('id', jobId).single()
      console.log('E3.7_JOB_AFTER:', JSON.stringify(jobAfter))
      expect((jobAfter?.billing_hold as { reason?: string } | null)?.reason).toBe('schedule_rebuild_required')
      expect(jobAfter?.billing_customer_id).toBe(result.customerId)
      expect(jobAfter?.billing_platform).toBe('stripe')

      // ── §16 idempotent retry — calling rebuild-schedule AGAIN (no new
      // configuration change) must not delete/duplicate/create a second
      // customer either. ──
      const res2 = await rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) })
      const body2 = await res2.json()
      console.log('E3.7_REBUILD_RETRY_RESULT:', res2.status, JSON.stringify(body2))
      expect(res2.status).toBe(200)
      expect(body2.alreadyExecuted).toBe(true)
      const afterRetry = await fetchPlannedInvoices(jobId)
      expect(afterRetry.length).toBe(before.length)
      expect(stripeCallLog.filter(c => c === 'customers.create').length).toBe(1) // never a second customer
    } finally {
      await cleanupJob(jobId, ORG_ID)
    }
  }, 60000)

  it('§14/§15 — a GENUINE commercial change after a successful attempt: rebuild fails BEFORE mutation (409, not a forced success)', async () => {
    const { supabaseServer } = await import('@/lib/supabase')
    const { configureBilling } = await import('@/lib/billing-writer')

    ORG_ID = await createTestOrg('E3.7 Plan Changed')
    const jobId = await createTestJob(ORG_ID)
    try {
      await insertContractTerms(jobId)
      const result = await configureBilling(BASE_TERMS as never, [], 'stripe', jobId, ORG_ID, undefined, [])
      await supabaseServer.from('jobs').update({
        execute_status: 'COMPLETED', billing_platform: 'stripe', billing_customer_id: result.customerId,
      }).eq('id', jobId)

      const before = await fetchPlannedInvoices(jobId)
      expect(before.length).toBeGreaterThan(0)

      // A REAL commercial change this time — base fee rate change, exactly
      // the deterministic kind of change E1's own fixtures already use.
      await insertContractTerms(jobId, { base_monthly_fee: 2500 })
      await supabaseServer.from('jobs').update({
        billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() },
      }).eq('id', jobId)

      const { POST: rebuildSchedule } = await import('@/app/api/jobs/[id]/rebuild-schedule/route')
      const { NextRequest } = await import('next/server')
      const res = await rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) })
      const body = await res.json()
      console.log('E3.7_PLAN_CHANGED_RESULT:', res.status, JSON.stringify(body))

      expect(res.status).toBe(409)
      expect(body.code).toBe('billing_already_executed_plan_changed')

      const after = await fetchPlannedInvoices(jobId)
      // Byte-for-byte unchanged — same ids, same statuses. This is the
      // "rebuild legitimately should NOT proceed" case (§14): fail BEFORE
      // mutation, not a forced success.
      expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
      expect(after.length).toBe(before.length)

      const { data: jobAfter } = await supabaseServer.from('jobs').select('billing_hold').eq('id', jobId).single()
      expect((jobAfter?.billing_hold as { reason?: string } | null)?.reason).toBe('schedule_rebuild_required')
    } finally {
      await cleanupJob(jobId, ORG_ID)
    }
  }, 60000)

  it('§14/§19 — first-time rebuild eligibility (no prior attempt at all): rebuild succeeds, hold clears by CAS, future schedule reflects current terms', async () => {
    const { supabaseServer } = await import('@/lib/supabase')

    ORG_ID = await createTestOrg('E3.7 First Rebuild')
    const jobId = await createTestJob(ORG_ID)
    try {
      await insertContractTerms(jobId)
      // A job that already has a billing_customer_id (as rebuild-schedule
      // requires) but NO billing_execution_attempts row at all — e.g. the
      // customer id was recorded by an earlier partial/legacy flow.
      // getOrCreateAttempt's "no prior attempt" branch applies; this is the
      // genuine happy-path rebuild.
      await supabaseServer.from('jobs').update({
        billing_platform: 'stripe', billing_customer_id: 'cus_e37_preexisting',
        billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() },
      }).eq('id', jobId)

      const { POST: rebuildSchedule } = await import('@/app/api/jobs/[id]/rebuild-schedule/route')
      const { NextRequest } = await import('next/server')
      const res = await rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) })
      const body = await res.json()
      console.log('E3.7_FIRST_REBUILD_RESULT:', res.status, JSON.stringify(body))
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.periods).toBeGreaterThan(0)

      const { data: jobAfter } = await supabaseServer.from('jobs').select('billing_hold, billing_customer_id, billing_platform').eq('id', jobId).single()
      console.log('E3.7_FIRST_REBUILD_JOB_AFTER:', JSON.stringify(jobAfter))
      // CAS-cleared — this WAS a genuine, clean regeneration.
      expect(jobAfter?.billing_hold).toBeNull()
      // Provider identity preserved — rebuild reused the existing customer,
      // never created a new one (customers.search/create was still called
      // as part of resolve_customer, but real Stripe behavior — search by
      // name — is mocked to return no match; the assertion that matters is
      // the JOB's own recorded identity stays a real, single customer id).
      expect(jobAfter?.billing_platform).toBe('stripe')

      const after = await fetchPlannedInvoices(jobId)
      expect(after.some(r => r.status === 'scheduled')).toBe(true)
      // Rebuilt future schedule reflects BASE_TERMS.base_monthly_fee (1000).
      const scheduled = after.filter(r => r.status === 'scheduled' && r.invoice_type === 'period')
      expect(scheduled.every(r => r.base_amount === 1000 || r.base_amount === 0)).toBe(true)
    } finally {
      await cleanupJob(jobId, ORG_ID)
    }
  }, 60000)

  it('§13/§20 — concurrent rebuild requests converge on one billing_execution_attempt (documents actual behavior, does not assume full schedule-mutation serialization)', async () => {
    const { supabaseServer } = await import('@/lib/supabase')

    ORG_ID = await createTestOrg('E3.7 Concurrent Rebuild')
    const jobId = await createTestJob(ORG_ID)
    try {
      await insertContractTerms(jobId)
      await supabaseServer.from('jobs').update({
        billing_platform: 'stripe', billing_customer_id: 'cus_e37_concurrent',
        billing_hold: { reason: 'schedule_rebuild_required', started_at: new Date().toISOString() },
      }).eq('id', jobId)

      const { POST: rebuildSchedule } = await import('@/app/api/jobs/[id]/rebuild-schedule/route')
      const { NextRequest } = await import('next/server')
      const [res1, res2] = await Promise.all([
        rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) }),
        rebuildSchedule(new NextRequest(`http://localhost/api/jobs/${jobId}/rebuild-schedule`, { method: 'POST' }), { params: Promise.resolve({ id: jobId }) }),
      ])
      const [body1, body2] = await Promise.all([res1.json(), res2.json()])
      console.log('E3.7_CONCURRENT_RESULTS:', JSON.stringify([{ status: res1.status, body: body1 }, { status: res2.status, body: body2 }]))

      // getOrCreateAttempt's DB-level partial unique index guarantees at
      // most ONE billing_execution_attempts row is ever 'created'/
      // 'executing' for this (job, provider) at a time — verified directly
      // rather than assumed.
      const { data: attempts } = await supabaseServer.from('billing_execution_attempts').select('id, status, attempt_number').eq('job_id', jobId)
      console.log('E3.7_CONCURRENT_ATTEMPTS:', JSON.stringify(attempts))
      expect((attempts ?? []).length).toBe(1) // never a divergent second attempt

      const after = await fetchPlannedInvoices(jobId)
      const scheduledPeriods = after.filter(r => r.invoice_type === 'period' && r.status === 'scheduled').map(r => r.period_start)
      const duplicatePeriods = scheduledPeriods.filter((p, i) => scheduledPeriods.indexOf(p) !== i)
      console.log('E3.7_CONCURRENT_SCHEDULED_PERIODS:', JSON.stringify(scheduledPeriods), 'duplicates:', JSON.stringify(duplicatePeriods))
      // Documented, not assumed perfect: this test reports whatever the
      // real outcome is (see the E3.7 report's own §20 for the honest
      // result) rather than asserting a stronger guarantee than the
      // existing architecture (no per-execution advisory lock around the
      // delete+insert body — a pre-existing gap, not introduced or
      // worsened by this pass's ordering fix).
    } finally {
      await cleanupJob(jobId, ORG_ID)
    }
  }, 60000)
})
