import { describe, it, expect } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17C.1a — RLS + append/revoke round-trip regression for
// operational_input_period_values (supabase/migrations/
// 20260903000001_operational_input_period_values.sql, reworked before
// first application into an append/revoke-versioned pattern). Same
// architecture note as lib/billing-execution-attempts-rls.test.ts: this
// app never issues per-user Supabase Auth sessions to the browser, so the
// boundary tested here is "can the anon key (shipped to every browser)
// reach this table at all" — answer must be no.
//
// SKIPPED BY DEFAULT — real network calls, and the migration must actually
// be applied first. Run deliberately after applying it:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/operational-input-period-values-rls.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(orgId: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: 'Operational input value RLS test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

describeIf('operational_input_period_values — deliberately service-role-only; anon key must not reach it at all', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows', async () => {
    const { data, error } = await anon.from('operational_input_period_values').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT via anon key cannot manufacture a value', async () => {
    const { error } = await anon.from('operational_input_period_values').insert({
      job_id: '00000000-0000-0000-0000-000000000000', org_id: '00000000-0000-0000-0000-000000000000',
      input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31',
      value: 999_999, recorded_by: 'anon@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE via anon key affects no rows', async () => {
    const { error, data } = await anon.from('operational_input_period_values')
      .update({ value: 1 }).eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('DELETE via anon key affects no rows', async () => {
    const { error, data } = await anon.from('operational_input_period_values')
      .delete().eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('anon key cannot invoke revoke_operational_input_period_value', async () => {
    const { error } = await anon.rpc('revoke_operational_input_period_value', {
      p_value_id: '00000000-0000-0000-0000-000000000000', p_revoked_at: new Date().toISOString(), p_revoked_by: 'anon@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })
})

describeIf('operational_input_period_values — append-only enforcement (real Postgres)', () => {
  it('a direct UPDATE to a substantive field (value) is rejected by the append-only trigger', async () => {
    const orgId = await createTestOrg('Op Input Append-Only')
    const jobId = await createTestJob(orgId)
    try {
      // recorded_at/finalized_at both set to the SAME client-computed
      // instant explicitly — leaving recorded_at to the column's own
      // `default now()` while finalized_at is a separately client-computed
      // timestamp races the client clock against the server's own now()
      // across the network round-trip, and can trip the
      // finalized_not_before_recorded check constraint on a slow request
      // (a real failure mode this test itself hit once). The real RPC
      // (replace_operational_input_period_value) never has this problem —
      // it computes ONE v_now := now() server-side and uses it for both.
      const nowIso = new Date().toISOString()
      const { data: inserted, error: insertError } = await supabaseServer
        .from('operational_input_period_values')
        .insert({ job_id: jobId, org_id: orgId, input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31', value: 80_000, recorded_by: 'test@verdix.invalid', recorded_at: nowIso, finalized_at: nowIso })
        .select('id').single()
      expect(insertError).toBeNull()

      const { error: updateError } = await supabaseServer
        .from('operational_input_period_values')
        .update({ value: 999 })
        .eq('id', inserted!.id)
      expect(updateError).toBeTruthy()
      expect(updateError?.message).toMatch(/append-only/)
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('revoke_operational_input_period_value revokes an active row exactly once; a second revoke attempt matches nothing', async () => {
    const orgId = await createTestOrg('Op Input Revoke Once')
    const jobId = await createTestJob(orgId)
    try {
      const insertNowIso = new Date().toISOString()
      const { data: inserted, error: insertError } = await supabaseServer
        .from('operational_input_period_values')
        .insert({ job_id: jobId, org_id: orgId, input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31', value: 80_000, recorded_by: 'test@verdix.invalid', recorded_at: insertNowIso, finalized_at: insertNowIso })
        .select('id').single()
      expect(insertError).toBeNull()

      const nowIso = new Date().toISOString()
      const { data: revoked, error: revokeError } = await supabaseServer.rpc('revoke_operational_input_period_value', {
        p_value_id: inserted!.id, p_revoked_at: nowIso, p_revoked_by: 'test@verdix.invalid',
      })
      expect(revokeError).toBeNull()
      expect(revoked).toHaveLength(1)
      expect(revoked![0].status).toBe('revoked')

      // A second revoke of the SAME already-revoked row matches nothing —
      // never silently clobbers the original revoked_at/revoked_by.
      const { data: secondAttempt, error: secondError } = await supabaseServer.rpc('revoke_operational_input_period_value', {
        p_value_id: inserted!.id, p_revoked_at: new Date().toISOString(), p_revoked_by: 'someone-else@verdix.invalid',
      })
      expect(secondError).toBeNull()
      expect(secondAttempt).toHaveLength(0)
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('the partial unique index allows a NEW active row for the same (job, input_key, period) once the old one is revoked — the real append/correct workflow', async () => {
    const orgId = await createTestOrg('Op Input Append Correct')
    const jobId = await createTestJob(orgId)
    try {
      const firstNowIso = new Date().toISOString()
      const { data: original, error: originalError } = await supabaseServer
        .from('operational_input_period_values')
        .insert({ job_id: jobId, org_id: orgId, input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31', value: 80_000, recorded_by: 'test@verdix.invalid', recorded_at: firstNowIso, finalized_at: firstNowIso })
        .select('id').single()
      expect(originalError).toBeNull()

      // Inserting a SECOND active row for the same period BEFORE revoking
      // the first must fail — the partial unique index enforces at most
      // one active row per (job, input_key, period).
      const conflictNowIso = new Date().toISOString()
      const { error: conflictError } = await supabaseServer
        .from('operational_input_period_values')
        .insert({ job_id: jobId, org_id: orgId, input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31', value: 82_500, recorded_by: 'test@verdix.invalid', recorded_at: conflictNowIso, finalized_at: conflictNowIso })
      expect(conflictError).toBeTruthy()

      await supabaseServer.rpc('revoke_operational_input_period_value', {
        p_value_id: original!.id, p_revoked_at: new Date().toISOString(), p_revoked_by: 'test@verdix.invalid',
      })

      // Now the correction can be appended.
      const correctionNowIso = new Date().toISOString()
      const { error: correctionError } = await supabaseServer
        .from('operational_input_period_values')
        .insert({ job_id: jobId, org_id: orgId, input_key: 'paid_invoice_value', period_start: '2027-01-01', period_end: '2027-01-31', value: 82_500, recorded_by: 'test@verdix.invalid', recorded_at: correctionNowIso, finalized_at: correctionNowIso })
      expect(correctionError).toBeNull()

      const { data: rows } = await supabaseServer
        .from('operational_input_period_values')
        .select('value, status')
        .eq('job_id', jobId).eq('input_key', 'paid_invoice_value')
        .order('created_at', { ascending: true })
      expect(rows).toHaveLength(2)
      expect(rows?.[0]).toMatchObject({ value: 80_000, status: 'revoked' })
      expect(rows?.[1]).toMatchObject({ value: 82_500, status: 'active' })
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('replace_operational_input_period_value — the atomic RPC (Step 17C.1b, item A)', () => {
  it('anon key cannot invoke it', async () => {
    const anon = createBrowserClient()
    const { error } = await anon.rpc('replace_operational_input_period_value', {
      p_job_id: '00000000-0000-0000-0000-000000000000', p_org_id: '00000000-0000-0000-0000-000000000000',
      p_input_key: 'paid_invoice_value', p_period_start: '2027-01-01', p_period_end: '2027-01-31',
      p_value: 1, p_currency: null, p_recorded_by: 'anon@isolation-test.invalid', p_is_final: false,
    })
    expect(error).toBeTruthy()
  })

  it('a first call with no prior active row simply inserts', async () => {
    const orgId = await createTestOrg('Replace RPC First Call')
    const jobId = await createTestJob(orgId)
    try {
      const { data, error } = await supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobId, p_org_id: orgId, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: 80_000, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: true,
      })
      expect(error).toBeNull()
      expect(data).toMatchObject({ value: 80_000, status: 'active', currency: 'EUR' })
      expect(data.finalized_at).not.toBeNull()
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a second call for the SAME (job, input_key, period) atomically revokes the first and inserts the correction — exactly two rows, exactly one active', async () => {
    const orgId = await createTestOrg('Replace RPC Correction')
    const jobId = await createTestJob(orgId)
    try {
      const call = (value: number, isFinal: boolean) => supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobId, p_org_id: orgId, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: value, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: isFinal,
      })
      await call(80_000, true)
      await call(82_500, true)

      const { data: rows } = await supabaseServer
        .from('operational_input_period_values')
        .select('value, status')
        .eq('job_id', jobId).eq('input_key', 'paid_invoice_value')
        .order('created_at', { ascending: true })
      expect(rows).toHaveLength(2)
      expect(rows?.[0]).toMatchObject({ value: 80_000, status: 'revoked' })
      expect(rows?.[1]).toMatchObject({ value: 82_500, status: 'active' })
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('true concurrency: N simultaneous replace calls for the SAME (job, input_key, period) never create two active rows and never lose a write — the advisory lock serializes them', async () => {
    const orgId = await createTestOrg('Replace RPC Concurrency')
    const jobId = await createTestJob(orgId)
    try {
      const N = 8
      const calls = Array.from({ length: N }, (_, i) =>
        supabaseServer.rpc('replace_operational_input_period_value', {
          p_job_id: jobId, p_org_id: orgId, p_input_key: 'paid_invoice_value',
          p_period_start: '2027-01-01', p_period_end: '2027-01-31',
          p_value: 1000 + i, p_currency: 'EUR', p_recorded_by: `writer-${i}@verdix.invalid`, p_is_final: true,
        }),
      )
      const results = await Promise.all(calls)
      // Every concurrent call must itself succeed (the lock serializes,
      // never rejects a concurrent caller outright) and no write is lost.
      for (const r of results) expect(r.error).toBeNull()

      const { data: allRows } = await supabaseServer
        .from('operational_input_period_values')
        .select('id, value, status')
        .eq('job_id', jobId).eq('input_key', 'paid_invoice_value')
      expect(allRows).toHaveLength(N) // every call really did insert its own row
      const activeRows = (allRows ?? []).filter(r => r.status === 'active')
      expect(activeRows).toHaveLength(1) // never two active rows at once
      const revokedRows = (allRows ?? []).filter(r => r.status === 'revoked')
      expect(revokedRows).toHaveLength(N - 1)
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('correction history / asOf replay — against REAL rows fetched from Postgres (not just the pure-function unit tests)', () => {
  it('replaying a period asOf BEFORE a correction reproduces the ORIGINAL value; asOf after/now reproduces the CORRECTED one — using the real resolver against real fetched rows', async () => {
    const orgId = await createTestOrg('Op Input AsOf Replay')
    const jobId = await createTestJob(orgId)
    try {
      const { resolveInputValueAsOf } = await import('./operational-input-binding')

      const t1 = await supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobId, p_org_id: orgId, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: 80_000, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: true,
      })
      expect(t1.error).toBeNull()
      const originalRecordedAt: string = t1.data.recorded_at
      // A short real gap so the two instants are unambiguously ordered —
      // this is genuine wall-clock time on the real database, not a
      // simulated/mocked clock.
      await new Promise(resolve => setTimeout(resolve, 1100))
      const asOfBetween = new Date().toISOString()
      await new Promise(resolve => setTimeout(resolve, 1100))

      const t2 = await supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobId, p_org_id: orgId, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: 82_500, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: true,
      })
      expect(t2.error).toBeNull()

      const { data: allRows, error: readError } = await supabaseServer
        .from('operational_input_period_values')
        .select('id, input_key, period_start, period_end, value, currency, recorded_at, finalized_at, status, revoked_at')
        .eq('job_id', jobId).eq('input_key', 'paid_invoice_value')
      expect(readError).toBeNull()
      expect(allRows).toHaveLength(2)

      // Historical replay: asOf strictly between the two writes reproduces
      // the ORIGINAL value — proves the correction never retroactively
      // changed what an earlier point in time saw.
      const historical = resolveInputValueAsOf(allRows!, 'paid_invoice_value', '2027-01-01', '2027-01-31', asOfBetween)
      expect(historical).toBe(80_000)

      // "Now" (after both writes) reproduces the CORRECTED value.
      const current = resolveInputValueAsOf(allRows!, 'paid_invoice_value', '2027-01-01', '2027-01-31', new Date().toISOString())
      expect(current).toBe(82_500)

      // Sanity: the original row really was recorded before the asOf
      // point used above, and the correction really was recorded after it.
      expect(new Date(originalRecordedAt).getTime()).toBeLessThan(new Date(asOfBetween).getTime())
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  }, 10_000)
})

describeIf('tenant/job ownership — real cross-org data isolation', () => {
  it('a value recorded under one org/job is never returned by a query scoped to a different org\'s job, and always carries its OWN org_id', async () => {
    const orgA = await createTestOrg('Tenant Isolation Org A')
    const orgB = await createTestOrg('Tenant Isolation Org B')
    const jobA = await createTestJob(orgA)
    const jobB = await createTestJob(orgB)
    try {
      await supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobA, p_org_id: orgA, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: 80_000, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: true,
      })
      await supabaseServer.rpc('replace_operational_input_period_value', {
        p_job_id: jobB, p_org_id: orgB, p_input_key: 'paid_invoice_value',
        p_period_start: '2027-01-01', p_period_end: '2027-01-31',
        p_value: 12_345, p_currency: 'EUR', p_recorded_by: 'test@verdix.invalid', p_is_final: true,
      })

      // Same real query shape the API route's GET handler uses
      // (app/api/jobs/[id]/operational-input-values/route.ts's loadOwnedJob
      // + .eq('job_id', jobId)) — a request scoped to job A must never
      // surface job B's row, and vice versa, regardless of both belonging
      // to the same table with the same input_key/period.
      const { data: rowsForA } = await supabaseServer
        .from('operational_input_period_values')
        .select('job_id, org_id, value')
        .eq('job_id', jobA)
      expect(rowsForA).toHaveLength(1)
      expect(rowsForA?.[0].value).toBe(80_000)
      expect(rowsForA?.[0].org_id).toBe(orgA)

      const { data: rowsForB } = await supabaseServer
        .from('operational_input_period_values')
        .select('job_id, org_id, value')
        .eq('job_id', jobB)
      expect(rowsForB).toHaveLength(1)
      expect(rowsForB?.[0].value).toBe(12_345)
      expect(rowsForB?.[0].org_id).toBe(orgB)

      // A job lookup scoped to the WRONG org (the actual tenant-isolation
      // check app/api/jobs/[id]/operational-input-values/route.ts's own
      // loadOwnedJob performs before ever touching this table) correctly
      // finds nothing — proves the ownership check has real data to bite on.
      const { data: wrongOrgLookup } = await supabaseServer
        .from('jobs').select('id').eq('id', jobA).eq('org_id', orgB).maybeSingle()
      expect(wrongOrgLookup).toBeNull()
    } finally {
      await supabaseServer.from('operational_input_period_values').delete().in('job_id', [jobA, jobB])
      await supabaseServer.from('jobs').delete().in('id', [jobA, jobB])
      await supabaseServer.from('organizations').delete().in('id', [orgA, orgB])
    }
  })
})
