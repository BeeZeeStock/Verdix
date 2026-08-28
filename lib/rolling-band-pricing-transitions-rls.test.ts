import { describe, it, expect } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17C.2 (revised 17C.2a) — RLS + concurrency/idempotency + historical-
// replay + future-schedule-reconciliation regression for
// rolling_band_pricing_transitions (supabase/migrations/
// 20260904000001_rolling_band_pricing_transitions.sql). Same architecture
// note as lib/operational-input-period-values-rls.test.ts: this app never
// issues per-user Supabase Auth sessions to the browser, so the boundary
// tested here is "can the anon key (shipped to every browser) reach this
// table/RPC at all" — answer must be no.
//
// SKIPPED BY DEFAULT — real network calls, and the migration must actually
// be applied first. Run deliberately after applying it:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/rolling-band-pricing-transitions-rls.test.ts
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
    .insert({ name: 'Rolling band transition RLS test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

async function createScheduledPeriodRow(jobId: string, orgId: string, periodStart: string, periodEnd: string, baseAmount: number): Promise<string> {
  const { data, error } = await supabaseServer
    .from('planned_invoices')
    .insert({ job_id: jobId, org_id: orgId, period_start: periodStart, period_end: periodEnd, base_amount: baseAmount, currency: 'EUR', invoice_type: 'period', status: 'scheduled' })
    .select('id').single()
  if (error || !data) throw new Error(`createScheduledPeriodRow failed: ${error?.message}`)
  return data.id as string
}

const FROM_BAND = { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 }
const TO_BAND = { from_unit: 5001, to_unit: 15000, monthly_fee: 5000 }
const NO_PRICE_BAND = { from_unit: 150001, to_unit: null, monthly_fee: null }

// A real, DB-backed transition row — required for any test that exercises
// reconcileFutureScheduleForTransition's HOLD path: rolling_band_hold_transition_id
// is a real foreign key to rolling_band_pricing_transitions(id) (added in
// Step 17C.2b), so a synthetic/arbitrary id — even a validly-shaped UUID —
// is rejected by the FK constraint the moment a row is actually held. Only
// the "recompute"/"skip" paths never write that column and can safely use
// an arbitrary id; the straddle/hold path always needs a real row.
async function createRealTransition(jobId: string, orgId: string, triggerWindowEnd: string): Promise<string> {
  const { data, error } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
    p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
    p_trigger_window_end: triggerWindowEnd, p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
  })
  if (error || !data?.id) throw new Error(`createRealTransition failed: ${error?.message}`)
  return data.id as string
}

describeIf('rolling_band_pricing_transitions — deliberately service-role-only; anon key must not reach it at all', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows', async () => {
    const { data, error } = await anon.from('rolling_band_pricing_transitions').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT via anon key cannot manufacture a transition', async () => {
    const { error } = await anon.from('rolling_band_pricing_transitions').insert({
      job_id: '00000000-0000-0000-0000-000000000000', org_id: '00000000-0000-0000-0000-000000000000',
      trigger_metric: 'issued_payment_request_count', trigger_window_end: '2027-03-31', trigger_value: 8000,
      from_band: FROM_BAND, to_band: TO_BAND, notice_required: true,
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE via anon key affects no rows', async () => {
    const { error, data } = await anon.from('rolling_band_pricing_transitions')
      .update({ notice_status: 'confirmed' }).eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('DELETE via anon key affects no rows', async () => {
    const { error, data } = await anon.from('rolling_band_pricing_transitions')
      .delete().eq('id', '00000000-0000-0000-0000-000000000000').select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('anon key cannot invoke detect_rolling_band_pricing_transition', async () => {
    const { error } = await anon.rpc('detect_rolling_band_pricing_transition', {
      p_job_id: '00000000-0000-0000-0000-000000000000', p_org_id: '00000000-0000-0000-0000-000000000000',
      p_trigger_metric: 'issued_payment_request_count', p_trigger_window_end: '2027-03-31',
      p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
    })
    expect(error).toBeTruthy()
  })

  it('anon key cannot invoke detect_rolling_band_pricing_required_event', async () => {
    const { error } = await anon.rpc('detect_rolling_band_pricing_required_event', {
      p_job_id: '00000000-0000-0000-0000-000000000000', p_org_id: '00000000-0000-0000-0000-000000000000',
      p_trigger_metric: 'issued_payment_request_count', p_trigger_window_end: '2027-03-31',
      p_trigger_value: 160000, p_from_band: FROM_BAND, p_proposed_band: NO_PRICE_BAND,
    })
    expect(error).toBeTruthy()
  })

  it('anon key cannot invoke confirm_rolling_band_transition_notice', async () => {
    const { error } = await anon.rpc('confirm_rolling_band_transition_notice', {
      p_transition_id: '00000000-0000-0000-0000-000000000000', p_confirmed_by: 'anon@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('anon key cannot invoke resolve_rolling_band_transition_effective_rule', async () => {
    const { error } = await anon.rpc('resolve_rolling_band_transition_effective_rule', {
      p_transition_id: '00000000-0000-0000-0000-000000000000',
      p_effective_rule: { kind: 'next_billing_period', provenance: 'reviewer_policy' }, p_effective_from: '2027-04-01',
    })
    expect(error).toBeTruthy()
  })

  it('anon key cannot invoke resolve_rolling_band_transition_volume_rule', async () => {
    const { error } = await anon.rpc('resolve_rolling_band_transition_volume_rule', {
      p_transition_id: '00000000-0000-0000-0000-000000000000',
      p_volume_rule: { kind: 'band_upper_bound', provenance: 'reviewer_policy' },
    })
    expect(error).toBeTruthy()
  })
})

describeIf('detect_rolling_band_pricing_transition — idempotent detection (Step 17C.2, item 12)', () => {
  it('a second call for the SAME (job, trigger_metric, trigger_window_end) returns the SAME row unchanged, never a duplicate', async () => {
    const orgId = await createTestOrg('Rolling Band Detect Idempotency')
    const jobId = await createTestJob(orgId)
    try {
      const call = () => supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000.333333, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })
      const first = await call()
      expect(first.error).toBeNull()
      expect(first.data.status).toBe('pending_notice')
      expect(first.data.effective_from).toBeNull()
      const second = await call()
      expect(second.error).toBeNull()
      expect(second.data.id).toBe(first.data.id)
      expect(second.data.trigger_value).toBe(first.data.trigger_value)

      const { data: allRows } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId)
      expect(allRows).toHaveLength(1)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('notice_required = false at detection -> status starts decision_required, NOT pending_effective_date (item 1 — timing is never assumed just because notice is not needed)', async () => {
    const orgId = await createTestOrg('Rolling Band No Notice Detect')
    const jobId = await createTestJob(orgId)
    try {
      const { data, error } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })
      expect(error).toBeNull()
      expect(data.status).toBe('decision_required')
      expect(data.effective_from).toBeNull()
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('true concurrency: N simultaneous detect calls for the SAME window never create duplicate rows — the advisory lock serializes them', async () => {
    const orgId = await createTestOrg('Rolling Band Detect Concurrency')
    const jobId = await createTestJob(orgId)
    try {
      const N = 8
      const calls = Array.from({ length: N }, () =>
        supabaseServer.rpc('detect_rolling_band_pricing_transition', {
          p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
          p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
        }),
      )
      const results = await Promise.all(calls)
      for (const r of results) expect(r.error).toBeNull()
      const ids = new Set(results.map(r => r.data.id))
      expect(ids.size).toBe(1)

      const { data: allRows } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId)
      expect(allRows).toHaveLength(1)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('detect_rolling_band_pricing_required_event — Step 17C.2a, item 7 (>150k, no valid price)', () => {
  it('persists a durable pricing_required record, never a price, and shares the same detection identity as a real transition', async () => {
    const orgId = await createTestOrg('Rolling Band Pricing Required')
    const jobId = await createTestJob(orgId)
    try {
      const { data, error } = await supabaseServer.rpc('detect_rolling_band_pricing_required_event', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 170000, p_from_band: FROM_BAND, p_proposed_band: NO_PRICE_BAND,
      })
      expect(error).toBeNull()
      expect(data.status).toBe('pricing_required')
      expect(data.to_band).toEqual(NO_PRICE_BAND)
      expect(data.notice_required).toBe(false)
      expect(data.notice_status).toBeNull()
      expect(data.effective_from).toBeNull()

      const { resolveTransitionLifecycleStatus } = await import('./rolling-band-transition')
      expect(resolveTransitionLifecycleStatus(data, new Date())).toBe('pricing_required')
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('idempotent, same as the real-transition RPC: a second call for the same window returns the same row', async () => {
    const orgId = await createTestOrg('Rolling Band Pricing Required Idempotency')
    const jobId = await createTestJob(orgId)
    try {
      const call = () => supabaseServer.rpc('detect_rolling_band_pricing_required_event', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 170000, p_from_band: FROM_BAND, p_proposed_band: NO_PRICE_BAND,
      })
      const first = await call()
      const second = await call()
      expect(first.data.id).toBe(second.data.id)
      const { data: allRows } = await supabaseServer.from('rolling_band_pricing_transitions').select('id').eq('job_id', jobId)
      expect(allRows).toHaveLength(1)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('rolling_band_pricing_transitions — detection identity is immutable (real Postgres trigger)', () => {
  it('a direct UPDATE to trigger_value/from_band/to_band is rejected by the identity trigger', async () => {
    const orgId = await createTestOrg('Rolling Band Identity Immutable')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })

      const { error: updateError } = await supabaseServer
        .from('rolling_band_pricing_transitions')
        .update({ trigger_value: 999999 })
        .eq('id', inserted.id)
      expect(updateError).toBeTruthy()
      expect(updateError?.message).toMatch(/immutable/)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('confirm_rolling_band_transition_notice / resolve_rolling_band_transition_effective_rule — Step 17C.2a, items 1/2 (decoupled lifecycle)', () => {
  it('confirming notice sets notice_confirmed_at, but leaves status decision_required until effective timing is separately resolved', async () => {
    const orgId = await createTestOrg('Rolling Band Notice Then Timing')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })

      const { data: confirmed, error } = await supabaseServer.rpc('confirm_rolling_band_transition_notice', {
        p_transition_id: inserted.id, p_confirmed_by: 'test@verdix.invalid',
      })
      expect(error).toBeNull()
      expect(confirmed.notice_status).toBe('confirmed')
      expect(confirmed.notice_confirmed_at).not.toBeNull()
      expect(confirmed.notice_confirmed_by).toBe('test@verdix.invalid')
      expect(confirmed.status).toBe('decision_required') // effective timing still unresolved
      expect(confirmed.effective_from).toBeNull()

      // A second confirm attempt on the SAME already-confirmed row matches
      // nothing — never overwrites the first confirmer's identity/timestamp.
      const { data: secondAttempt, error: secondError } = await supabaseServer.rpc('confirm_rolling_band_transition_notice', {
        p_transition_id: inserted.id, p_confirmed_by: 'someone-else@verdix.invalid',
      })
      expect(secondError).toBeNull()
      // A composite-typed Postgres function returning NULL (this RPC's own
      // WHERE guard matching zero rows) is NOT serialized as JSON null by
      // PostgREST — it comes back as an object with every field null (a
      // real, confirmed row_to_json(NULL::sometype) behavior, found via
      // this exact real-Postgres acceptance run). id is the primary key
      // and can only be null in that pathological case.
      expect(secondAttempt?.id).toBeNull()

      const { data: resolved, error: resolveError } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'next_billing_period', provenance: 'reviewer_policy', specific_date: null, source_clause: null },
        p_effective_from: '2027-05-01',
      })
      expect(resolveError).toBeNull()
      expect(resolved.status).toBe('pending_effective_date')
      expect(resolved.effective_from).toBe('2027-05-01')
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('resolving effective timing BEFORE notice is confirmed still leaves status pending_notice (notice gates activation regardless of order)', async () => {
    const orgId = await createTestOrg('Rolling Band Timing Then Notice')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })

      const { data: resolved } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'next_billing_period', provenance: 'reviewer_policy', specific_date: null, source_clause: null },
        p_effective_from: '2027-05-01',
      })
      expect(resolved.status).toBe('pending_notice') // notice not yet confirmed
      expect(resolved.effective_from).toBe('2027-05-01')

      const { resolveTransitionLifecycleStatus } = await import('./rolling-band-transition')
      expect(resolveTransitionLifecycleStatus(resolved, new Date('2027-06-01'))).toBe('pending_notice')
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('re-resolving effective timing is allowed while still in the future, but blocked once the effective date has already arrived', async () => {
    const orgId = await createTestOrg('Rolling Band Re-resolve Guard')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })

      const farFuture = '2099-01-01'
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: farFuture, provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: farFuture,
      })

      // Re-resolving to a different (still future) date is allowed.
      const revisedFuture = '2099-06-01'
      const { data: revised, error: revisedError } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: revisedFuture, provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: revisedFuture,
      })
      expect(revisedError).toBeNull()
      expect(revised.effective_from).toBe(revisedFuture)

      // Now resolve it into the PAST (simulating it having become active) and confirm the guard blocks a further change.
      const pastDate = '2020-01-01'
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: pastDate, provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: pastDate,
      })
      const { data: blockedAttempt, error: blockedError } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: '2030-01-01', provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: '2030-01-01',
      })
      expect(blockedError).toBeNull()
      // See the double-confirm test's own comment — a "no-op" composite
      // return comes back as an all-null-fields object, not JSON null.
      expect(blockedAttempt?.id).toBeNull() // no-op — already-past effective_from is never silently rewritten
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a pricing_required row can never have its effective timing resolved — there is nothing to activate', async () => {
    const orgId = await createTestOrg('Rolling Band Pricing Required No Resolve')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_required_event', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 170000, p_from_band: FROM_BAND, p_proposed_band: NO_PRICE_BAND,
      })
      const { data: attempt, error } = await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'next_billing_period', provenance: 'reviewer_policy', specific_date: null, source_clause: null },
        p_effective_from: '2027-05-01',
      })
      expect(error).toBeNull()
      // See the double-confirm test's own comment — a "no-op" composite
      // return comes back as an all-null-fields object, not JSON null.
      expect(attempt?.id).toBeNull()
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('resolve_rolling_band_transition_volume_rule — Step 17C.2c/17C.2d, the SEPARATE, historically-versioned volume decision', () => {
  it('resolves independently of notice/effective_rule state — a freshly-detected transition (nothing else resolved) can still have its volume rule set, returning a VERSION row', async () => {
    const orgId = await createTestOrg('Volume Rule Independent Of Lifecycle')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })
      // No column on the transition row itself anymore — no version exists yet.
      const { data: noVersions } = await supabaseServer.from('rolling_band_volume_rule_versions').select('id').eq('transition_id', inserted.id)
      expect(noVersions).toHaveLength(0)

      const { data: resolved, error } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id,
        p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })
      expect(error).toBeNull()
      expect(resolved.transition_id).toBe(inserted.id)
      expect(resolved.rule).toEqual({ kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null })
      expect(resolved.superseded_at).toBeNull()
      expect(resolved.resolved_at).not.toBeNull()

      // Notice/effective_rule/status on the TRANSITION row are completely untouched by this call.
      const { data: transitionRow } = await supabaseServer.from('rolling_band_pricing_transitions').select('notice_status, effective_rule, status').eq('id', inserted.id).single()
      expect(transitionRow?.notice_status).toBe('pending')
      expect(transitionRow?.effective_rule).toBeNull()
      expect(transitionRow?.status).toBe('pending_notice')
    } finally {
      await supabaseServer.from('rolling_band_volume_rule_versions').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('re-resolving supersedes the prior version (append, never overwrite) — exactly one row has superseded_at null at a time', async () => {
    const orgId = await createTestOrg('Volume Rule Append Not Overwrite')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })
      const { data: first } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })

      const { data: second, error } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null },
      })
      expect(error).toBeNull()
      expect(second.rule).toEqual({ kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null })
      expect(second.superseded_at).toBeNull()

      const { data: allVersions } = await supabaseServer.from('rolling_band_volume_rule_versions').select('id, superseded_at').eq('transition_id', inserted.id).order('resolved_at', { ascending: true })
      expect(allVersions).toHaveLength(2) // append, never overwrite
      expect(allVersions?.[0].id).toBe(first.id)
      expect(allVersions?.[0].superseded_at).not.toBeNull() // the first version is now superseded
      expect(allVersions?.[1].id).toBe(second.id)
      expect(allVersions?.[1].superseded_at).toBeNull()
    } finally {
      await supabaseServer.from('rolling_band_volume_rule_versions').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('can be re-resolved even AFTER the transition is fully active — no time-based guard, since it never feeds a pre-built schedule', async () => {
    const orgId = await createTestOrg('Volume Rule Re-resolve After Active')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: '2020-01-01', provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: '2020-01-01', // already in the past -> transition is genuinely active
      })
      await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })

      const { data: revised, error } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null },
      })
      expect(error).toBeNull()
      expect(revised.rule).toEqual({ kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null })
    } finally {
      await supabaseServer.from('rolling_band_volume_rule_versions').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a pricing_required row can never have a volume rule resolved — there is no band to attach a volume decision to', async () => {
    const orgId = await createTestOrg('Volume Rule Blocked For Pricing Required')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_required_event', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 170000, p_from_band: FROM_BAND, p_proposed_band: NO_PRICE_BAND,
      })
      const { data: attempt, error } = await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })
      expect(error).toBeNull()
      // See the double-confirm test's own comment — a "no-op" composite
      // return comes back as an all-null-fields object, not JSON null.
      expect(attempt?.id).toBeNull()
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('true concurrency: N simultaneous resolutions for the same transition never leave two "active" (superseded_at null) versions', async () => {
    const orgId = await createTestOrg('Volume Rule Resolve Concurrency')
    const jobId = await createTestJob(orgId)
    try {
      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })
      const N = 8
      const calls = Array.from({ length: N }, (_, i) =>
        supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
          p_transition_id: inserted.id, p_volume_rule: { kind: 'specific_volume', value: 1000 + i, provenance: 'reviewer_policy', source_clause: null },
        }),
      )
      const results = await Promise.all(calls)
      for (const r of results) expect(r.error).toBeNull()

      const { data: allVersions } = await supabaseServer.from('rolling_band_volume_rule_versions').select('id, superseded_at').eq('transition_id', inserted.id)
      expect(allVersions).toHaveLength(N) // every call really did insert its own version
      const activeVersions = (allVersions ?? []).filter(v => v.superseded_at === null)
      expect(activeVersions).toHaveLength(1) // never two "active" versions at once
    } finally {
      await supabaseServer.from('rolling_band_volume_rule_versions').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('Step 17C.2d, item 3 — required regression: historical replay of the volume rule itself', () => {
  it('rule A active for Jan; rule B resolved later -> current/future uses B, but Jan historical asOf still uses A', async () => {
    const orgId = await createTestOrg('Volume Rule Historical Replay')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { resolveEffectiveCommercialStateForPeriod } = await import('./rolling-band-migration-pull')
      const terms = buildRemembillFixtureTerms()

      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2026-12-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: false,
      })
      // effective_from is deliberately far in the past (never dependent on
      // whatever the real "now" happens to be when this suite runs) so the
      // transition is unambiguously active for every asOf point used below
      // — the actual thing under test is the VOLUME RULE's own versioning,
      // not the transition's own activation timing.
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: '2020-01-01', provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: '2020-01-01',
      })

      // Rule A: band_upper_bound (15,000) — resolved_at is real wall-clock
      // "now" as measured by the DB SERVER (the RPC's own now()), which is
      // a different clock than this test process's own. asOfForA adds a
      // small buffer past the RPC call's return so it's unambiguously
      // AFTER rule A's own resolved_at regardless of any small skew
      // between this machine's clock and the remote Postgres server's —
      // a real-Postgres acceptance finding (see lib/usage-pull-rolling-
      // band-integration.test.ts's own nowUnix() for the identical issue).
      // "Jan" here means "the instant rule A was the currently-effective
      // one," not a hard-coded calendar year.
      await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })
      const asOfForA = new Date(Date.now() + 2000)

      const janResult = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: asOfForA })
      expect(janResult.effective_contracted_volume).toBe(15000) // rule A (band_upper_bound)
      expect(janResult.volume_provenance).toBe('reviewer_policy')

      // A real wall-clock gap so rule B's own resolved_at is unambiguously
      // after asOfForA, mirroring the "reviewer changes treatment later"
      // scenario.
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Rule B: specific_volume = 10,000 — resolved "later" (after the gap).
      await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'specific_volume', value: 10000, provenance: 'reviewer_policy', source_clause: null },
      })

      // Current/future (asOf now + buffer, i.e. after rule B was resolved) -> rule B.
      const currentResult = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date(Date.now() + 2000) })
      expect(currentResult.effective_contracted_volume).toBe(10000)

      // Historical replay AT asOfForA -> STILL rule A, never retroactively
      // changed by the later reviewer decision.
      const janReplayResult = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: asOfForA })
      expect(janReplayResult.effective_contracted_volume).toBe(15000)
    } finally {
      await supabaseServer.from('rolling_band_volume_rule_versions').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  }, 10_000)
})

describeIf('Step 17C.2a, item 8 — required regressions: lifecycle gating keeps the OLD band effective until genuinely active', () => {
  it('triggered but notice pending -> old band remains effective (resolveEffectiveCommercialStateForPeriod)', async () => {
    const orgId = await createTestOrg('Regression Notice Pending')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { resolveEffectiveCommercialStateForPeriod } = await import('./rolling-band-migration-pull')
      const terms = buildRemembillFixtureTerms()

      await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })

      const result = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-06-01') })
      expect(result.provenance).toBe('contract_derived')
      expect(result.effective_monthly_fee).toBe(terms.base_monthly_fee) // old €2,000 band
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('notice confirmed but effective timing unresolved (decision_required) -> old band remains effective', async () => {
    const orgId = await createTestOrg('Regression Timing Unresolved')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { resolveEffectiveCommercialStateForPeriod } = await import('./rolling-band-migration-pull')
      const terms = buildRemembillFixtureTerms()

      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })
      await supabaseServer.rpc('confirm_rolling_band_transition_notice', { p_transition_id: inserted.id, p_confirmed_by: 'test@verdix.invalid' })

      const result = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-06-01') })
      expect(result.provenance).toBe('contract_derived')
      expect(result.effective_monthly_fee).toBe(terms.base_monthly_fee)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('timing resolved, future effective date not yet reached -> old band remains effective', async () => {
    const orgId = await createTestOrg('Regression Future Effective Date')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { resolveEffectiveCommercialStateForPeriod } = await import('./rolling-band-migration-pull')
      const terms = buildRemembillFixtureTerms()

      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })
      await supabaseServer.rpc('confirm_rolling_band_transition_notice', { p_transition_id: inserted.id, p_confirmed_by: 'test@verdix.invalid' })
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: '2027-08-01', provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: '2027-08-01',
      })

      const result = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-06-01') })
      expect(result.provenance).toBe('contract_derived')
      expect(result.effective_monthly_fee).toBe(terms.base_monthly_fee)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('active transition -> future full periods use €5,000; historical periods before effective_from remain €2,000 (historical asOf reproduces the right band)', async () => {
    const orgId = await createTestOrg('Regression Active Transition')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { resolveEffectiveCommercialStateForPeriod } = await import('./rolling-band-migration-pull')
      const terms = buildRemembillFixtureTerms()

      const { data: inserted } = await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobId, p_org_id: orgId, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })
      await supabaseServer.rpc('confirm_rolling_band_transition_notice', { p_transition_id: inserted.id, p_confirmed_by: 'test@verdix.invalid' })
      await supabaseServer.rpc('resolve_rolling_band_transition_effective_rule', {
        p_transition_id: inserted.id,
        p_effective_rule: { kind: 'specific_date', specific_date: '2027-05-01', provenance: 'reviewer_policy', source_clause: null },
        p_effective_from: '2027-05-01',
      })

      // Now (asOf) is after the effective date -> active, new band. Volume
      // treatment is still UNRESOLVED at this point (17C.2c) — the base fee
      // is executable regardless, but the volume is not.
      const nowResult = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-06-01') })
      expect(nowResult.provenance).toBe('transition_active')
      expect(nowResult.effective_monthly_fee).toBe(5000)
      expect(nowResult.transition_id).toBe(inserted.id)
      expect(nowResult.effective_contracted_volume).toBeNull()
      expect(nowResult.volume_provenance).toBe('unresolved')

      // A HISTORICAL asOf, before the transition's own effective date,
      // still correctly reproduces the OLD band/volume — item 8's explicit
      // "historical asOf must reproduce which band was effective at that
      // time."
      const historicalResult = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-02-01') })
      expect(historicalResult.provenance).toBe('contract_derived')
      expect(historicalResult.effective_monthly_fee).toBe(terms.base_monthly_fee)
      expect(historicalResult.effective_contracted_volume).toBe(terms.base_fee_committed_volume)

      // Step 17C.2c required regression — resolving the volume treatment
      // NOW (band_upper_bound -> 15,000) must NEVER retroactively change
      // what the historical asOf already reproduced above.
      await supabaseServer.rpc('resolve_rolling_band_transition_volume_rule', {
        p_transition_id: inserted.id, p_volume_rule: { kind: 'band_upper_bound', value: null, provenance: 'reviewer_policy', source_clause: null },
      })
      const nowResultAfterVolumeResolved = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-06-01') })
      expect(nowResultAfterVolumeResolved.effective_contracted_volume).toBe(15000)
      const historicalResultAfterVolumeResolved = await resolveEffectiveCommercialStateForPeriod({ jobId, terms, asOf: new Date('2027-02-01') })
      expect(historicalResultAfterVolumeResolved.provenance).toBe('contract_derived')
      expect(historicalResultAfterVolumeResolved.effective_contracted_volume).toBe(terms.base_fee_committed_volume) // still 5,000 — never retroactively altered
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('Step 17C.2a, item 8 — required regressions: future-schedule reconciliation against real planned_invoices', () => {
  it('an ACTIVE transition recomputes future scheduled periods to the new band, leaves historical/past periods untouched', async () => {
    const orgId = await createTestOrg('Reconciliation Future Recompute')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = [] // no pilot-waiver discount noise for this arithmetic check

      const beforeRowId = await createScheduledPeriodRow(jobId, orgId, '2027-04-01', '2027-04-30', 2000)
      const futureRow1Id = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const futureRow2Id = await createScheduledPeriodRow(jobId, orgId, '2027-06-01', '2027-06-30', 2000)

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: '371c4692-9bc5-4848-8dfb-2ceffbd2801c', to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(result.unsupportedShape).toBeNull()
      expect(result.recomputed).toBe(2)
      expect(result.skipped).toBe(1) // the April row, fully before effective_from

      const { data: rows } = await supabaseServer.from('planned_invoices').select('id, base_amount, status').in('id', [beforeRowId, futureRow1Id, futureRow2Id])
      const byId = Object.fromEntries((rows ?? []).map(r => [r.id, r]))
      expect(Number(byId[beforeRowId].base_amount)).toBe(2000) // untouched
      expect(Number(byId[futureRow1Id].base_amount)).toBe(5000) // recomputed to the new band
      expect(Number(byId[futureRow2Id].base_amount)).toBe(5000)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a period straddling the effective date with no proration rule is HELD as decision_required, base_amount untouched (item 5)', async () => {
    const orgId = await createTestOrg('Reconciliation Straddle Hold')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const straddlingRowId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const transitionId = await createRealTransition(jobId, orgId, '2027-03-31')

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-15' }, // mid-period
      })
      expect(result.held).toBe(1)
      expect(result.recomputed).toBe(0)

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status, error_message').eq('id', straddlingRowId).single()
      expect(Number(row?.base_amount)).toBe(2000) // neither old nor new full-month amount asserted — left as-is
      expect(row?.status).toBe('decision_required')
      expect(row?.error_message).toMatch(/Decision required/)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('repeated reconciliation produces no duplicate/repeated invoice changes — running it twice yields the identical final schedule', async () => {
    const orgId = await createTestOrg('Reconciliation Idempotent Repeat')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      await createScheduledPeriodRow(jobId, orgId, '2027-06-01', '2027-06-30', 2000)
      const transition = { id: '0026a7ec-78f5-4bc6-9d12-32492cd1eb11', to_band: TO_BAND, effective_from: '2027-05-01' }

      const first = await reconcileFutureScheduleForTransition({ jobId, orgId, terms, transition })
      const second = await reconcileFutureScheduleForTransition({ jobId, orgId, terms, transition })
      expect(first.recomputed).toBe(1)
      expect(second.recomputed).toBe(1) // recomputed to the (already correct) value again, no error, no duplication

      const { data: allRows } = await supabaseServer.from('planned_invoices').select('id, base_amount').eq('job_id', jobId)
      expect(allRows).toHaveLength(1) // no new row created
      expect(Number(allRows?.[0].base_amount)).toBe(5000)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('an already-SENT invoice is never rewritten by reconciliation', async () => {
    const orgId = await createTestOrg('Reconciliation Never Rewrites Sent')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const { data: sentRow } = await supabaseServer
        .from('planned_invoices')
        .insert({ job_id: jobId, org_id: orgId, period_start: '2027-06-01', period_end: '2027-06-30', base_amount: 2000, currency: 'EUR', invoice_type: 'period', status: 'sent' })
        .select('id').single()

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: 'fe9843d8-b1de-4b08-8e9d-32c5001dd4e9', to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(result.recomputed).toBe(0) // never even selected — the query itself only reads status='scheduled'

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status').eq('id', sentRow!.id).single()
      expect(Number(row?.base_amount)).toBe(2000) // untouched
      expect(row?.status).toBe('sent')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a row concurrently claimed to processing between read and write is skipped, never rewritten', async () => {
    const orgId = await createTestOrg('Reconciliation Skips Processing Claim')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowId = await createScheduledPeriodRow(jobId, orgId, '2027-06-01', '2027-06-30', 2000)
      // Simulate a concurrent scheduler claim happening BEFORE reconciliation's own write.
      await supabaseServer.from('planned_invoices').update({ status: 'processing' }).eq('id', rowId)

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: '1cd3a196-359b-434a-944b-8691a5b3d8c3', to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(result.recomputed).toBe(0) // the SELECT itself only reads status='scheduled', so this row is invisible to it

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status').eq('id', rowId).single()
      expect(Number(row?.base_amount)).toBe(2000)
      expect(row?.status).toBe('processing')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('Step 17C.2b, item C — exact half-open period-boundary regressions', () => {
  it('effective_from === period_start -> the NEW band applies to the WHOLE period (never held)', async () => {
    const orgId = await createTestOrg('Boundary Effective Equals Start')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: '7133065b-6dd2-4d9c-bda3-ec5d1c8a6e7d', to_band: TO_BAND, effective_from: '2027-05-01' }, // exactly period_start
      })
      expect(result.recomputed).toBe(1)
      expect(result.held).toBe(0)

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status').eq('id', rowId).single()
      expect(Number(row?.base_amount)).toBe(5000)
      expect(row?.status).toBe('scheduled')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('effective_from === period_end -> the OLD band applies to the WHOLE current period (never held); the transition only takes hold next period', async () => {
    const orgId = await createTestOrg('Boundary Effective Equals End')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: '69abce26-5cc3-4d74-832b-658eb3887d3f', to_band: TO_BAND, effective_from: '2027-05-31' }, // exactly period_end
      })
      expect(result.held).toBe(0)
      expect(result.skipped).toBe(1) // old band remains effective for the whole period, untouched

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status').eq('id', rowId).single()
      expect(Number(row?.base_amount)).toBe(2000) // unchanged
      expect(row?.status).toBe('scheduled')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('period_start < effective_from < period_end (strictly between) -> held, exactly as before', async () => {
    const orgId = await createTestOrg('Boundary Strictly Between')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const transitionId = await createRealTransition(jobId, orgId, '2027-03-31')
      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-15' },
      })
      expect(result.held).toBe(1)

      const { data: row } = await supabaseServer.from('planned_invoices').select('status').eq('id', rowId).single()
      expect(row?.status).toBe('decision_required')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('one day before period_end (still strictly inside) -> held; one day AFTER effective_from == period_end boundary -> not held (exact instant discrimination)', async () => {
    const orgId = await createTestOrg('Boundary One Day Each Side')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowAId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const transitionId = await createRealTransition(jobId, orgId, '2027-03-31')
      const resultA = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-30' }, // one day before period_end
      })
      expect(resultA.held).toBe(1)
      const { data: rowA } = await supabaseServer.from('planned_invoices').select('status').eq('id', rowAId).single()
      expect(rowA?.status).toBe('decision_required')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('Step 17C.2b, item B — held (decision_required) planned invoices are automatically recovered once resolvable', () => {
  it('a straddling hold from an earlier (mistaken) effective_from is recovered once the SAME transition is re-resolved to a period-aligned date', async () => {
    const orgId = await createTestOrg('Recovery Re-resolved Aligned')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const rowId = await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const transitionId = await createRealTransition(jobId, orgId, '2027-03-31')

      // First pass: a mid-period effective_from holds the row.
      const first = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-15' },
      })
      expect(first.held).toBe(1)
      const { data: held } = await supabaseServer.from('planned_invoices').select('status, rolling_band_hold_transition_id').eq('id', rowId).single()
      expect(held?.status).toBe('decision_required')
      expect(held?.rolling_band_hold_transition_id).toBe(transitionId)

      // Reviewer corrects the SAME transition's effective date to the
      // period's own start — re-running reconciliation now recovers it.
      const second = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(second.recovered).toBe(1)
      expect(second.held).toBe(0)

      const { data: recovered } = await supabaseServer.from('planned_invoices').select('status, base_amount, error_message, rolling_band_hold_transition_id').eq('id', rowId).single()
      expect(recovered?.status).toBe('scheduled')
      expect(Number(recovered?.base_amount)).toBe(5000)
      expect(recovered?.error_message).toBeNull()
      expect(recovered?.rolling_band_hold_transition_id).toBeNull()
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('never reopens a row that has since moved to processing/sent/finalized, even if it happens to carry this transition\'s hold id', async () => {
    const orgId = await createTestOrg('Recovery Never Reopens Sent')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const { data: heldThenSentRow } = await supabaseServer
        .from('planned_invoices')
        .insert({
          job_id: jobId, org_id: orgId, period_start: '2027-05-01', period_end: '2027-05-31', base_amount: 2000,
          currency: 'EUR', invoice_type: 'period', status: 'sent', // simulates a row that was recovered and already sent by the time we retry
          rolling_band_hold_transition_id: null,
        })
        .select('id').single()

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: 'e43a993b-d3ab-4dfb-8b0d-7d6adb470558', to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(result.recomputed).toBe(0)
      expect(result.recovered).toBe(0)

      const { data: row } = await supabaseServer.from('planned_invoices').select('base_amount, status').eq('id', heldThenSentRow!.id).single()
      expect(Number(row?.base_amount)).toBe(2000)
      expect(row?.status).toBe('sent')
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a row held by a DIFFERENT transition is never recovered by this one — recovery is scoped to "rows attributable to this transition"', async () => {
    const orgId = await createTestOrg('Recovery Scoped To Own Transition')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      const otherTransitionId = await createRealTransition(jobId, orgId, '2027-02-28')
      const thisTransitionId = await createRealTransition(jobId, orgId, '2027-03-31')

      const { data: otherHeldRow } = await supabaseServer
        .from('planned_invoices')
        .insert({
          job_id: jobId, org_id: orgId, period_start: '2027-05-01', period_end: '2027-05-31', base_amount: 2000,
          currency: 'EUR', invoice_type: 'period', status: 'decision_required', error_message: 'held by a different transition',
          rolling_band_hold_transition_id: otherTransitionId,
        })
        .select('id').single()

      const result = await reconcileFutureScheduleForTransition({
        jobId, orgId, terms,
        transition: { id: thisTransitionId, to_band: TO_BAND, effective_from: '2027-05-01' },
      })
      expect(result.recovered).toBe(0)
      expect(result.skipped).toBe(1)

      const { data: row } = await supabaseServer.from('planned_invoices').select('status, rolling_band_hold_transition_id').eq('id', otherHeldRow!.id).single()
      expect(row?.status).toBe('decision_required') // untouched — not this transition's row to recover
      expect(row?.rolling_band_hold_transition_id).toBe(otherTransitionId)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('recovery is atomic/idempotent: running reconciliation twice after resolution never double-recovers or duplicates rows', async () => {
    const orgId = await createTestOrg('Recovery Idempotent Repeat')
    const jobId = await createTestJob(orgId)
    try {
      const { buildRemembillFixtureTerms } = await import('./remembill-fixture')
      const { reconcileFutureScheduleForTransition } = await import('./rolling-band-schedule-reconciliation')
      const terms = buildRemembillFixtureTerms()
      terms.contract_start_date = '2027-01-01'
      terms.discounts = []

      await createScheduledPeriodRow(jobId, orgId, '2027-05-01', '2027-05-31', 2000)
      const transitionId = await createRealTransition(jobId, orgId, '2027-03-31')
      await reconcileFutureScheduleForTransition({ jobId, orgId, terms, transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-15' } })
      await reconcileFutureScheduleForTransition({ jobId, orgId, terms, transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-01' } })

      // Re-running the SAME (already-recovered) reconciliation again must
      // be a pure no-op — the row is now 'scheduled', not
      // 'decision_required', so it's simply recomputed (already correct)
      // via the ordinary path, never re-"recovered", and never duplicated.
      const third = await reconcileFutureScheduleForTransition({ jobId, orgId, terms, transition: { id: transitionId, to_band: TO_BAND, effective_from: '2027-05-01' } })
      expect(third.recovered).toBe(0)
      expect(third.recomputed).toBe(1)

      const { data: allRows } = await supabaseServer.from('planned_invoices').select('id').eq('job_id', jobId)
      expect(allRows).toHaveLength(1)
    } finally {
      await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
      await supabaseServer.from('rolling_band_pricing_transitions').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('tenant/job ownership — real cross-org data isolation', () => {
  it('a transition detected under one org/job is never returned by a query scoped to a different org\'s job', async () => {
    const orgA = await createTestOrg('Rolling Band Tenant A')
    const orgB = await createTestOrg('Rolling Band Tenant B')
    const jobA = await createTestJob(orgA)
    const jobB = await createTestJob(orgB)
    try {
      await supabaseServer.rpc('detect_rolling_band_pricing_transition', {
        p_job_id: jobA, p_org_id: orgA, p_trigger_metric: 'issued_payment_request_count',
        p_trigger_window_end: '2027-03-31', p_trigger_value: 8000, p_from_band: FROM_BAND, p_to_band: TO_BAND, p_notice_required: true,
      })

      const { data: rowsForA } = await supabaseServer.from('rolling_band_pricing_transitions').select('job_id, org_id').eq('job_id', jobA)
      expect(rowsForA).toHaveLength(1)
      expect(rowsForA?.[0].org_id).toBe(orgA)

      const { data: rowsForB } = await supabaseServer.from('rolling_band_pricing_transitions').select('job_id').eq('job_id', jobB)
      expect(rowsForB).toHaveLength(0)
    } finally {
      await supabaseServer.from('rolling_band_pricing_transitions').delete().in('job_id', [jobA, jobB])
      await supabaseServer.from('jobs').delete().in('id', [jobA, jobB])
      await supabaseServer.from('organizations').delete().in('id', [orgA, orgB])
    }
  })
})
