import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import { createSourceBinding } from './source-bindings-service'
import { registerSourceRole } from './source-roles-service'
import { createDraftQualificationRule, confirmQualificationRuleFieldAndPersist, activateQualificationRule } from './billable-unit-qualification-service'
import { createOrGetCandidate } from './billable-unit-candidate-service'
import { recordSourceCoverage } from './source-coverage-service'
import { buildOs202609SqmTiers } from './os-2026-09-fixture'
import { computeOverageForPeriod } from './usage-pull'
import { enumerateCadenceWindows, clampWindowToContract } from './tariff'
import { QuantitySourceNotReadyError } from './commercial-quantity-source'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 16B.4, hardening item 6 — the PRODUCTION-PATH integration test: calls
// the real, unmodified computeOverageForPeriod (lib/usage-pull.ts) — the
// same function invoice-scheduler's real cron calls — against real
// Postgres, proving a 'qualified_unit_aggregate'-connector meter is
// resolved end-to-end (contract_meter_mappings/billing_meters config ->
// aggregation -> existing tier/minimum pricing) without teaching this file,
// or usage-pull.ts, any SQM/meeting-specific vocabulary beyond the
// meter_key an org's own contract_meter_mappings row happens to name.
//
// lib/usage-pull.test.ts explains why computeOverageForPeriod has
// historically had NO integration test at all: most of its branches need a
// live external connector (Remembill, or a real HTTP pull endpoint) with
// no mocking convention in this codebase. The qualified_unit_aggregate
// branch is the first one that needs ONLY real Postgres — exactly the
// opt-in pattern lib/billable-unit-candidate-finality-integration.test.ts
// already established — so it's finally directly testable.
//
// Real-Postgres discovery (this pass): every test in this file originally
// shared ONE job/period (September). candidate_discovery coverage and
// candidate rows are both append-only and never cleaned between `it`
// blocks (only afterAll), so an earlier test's full-month coverage row, or
// an earlier test's own never-finalized pending candidate, silently
// contaminated a LATER test evaluating the same September period — the
// exact "cross-test coverage/candidate contamination" failure mode already
// found and fixed once before in the 16B.3 finality integration suite.
// Fixed the same way here: each scenario that needs a genuinely clean
// period gets its OWN calendar month (job/rule/meter setup stays shared —
// none of that is period-specific).
//
// RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/usage-pull-qualified-unit-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

function minimalSqmRuleInput(jobId: string, orgId: string) {
  return {
    job_id: jobId, org_id: orgId, unit_type: 'SQM',
    fact_schema: {
      'account.id': { type: 'string' as const, reference_time: 'booked_at' as const },
    },
    criteria: { value: { kind: 'condition' as const, condition: { field: 'account.id', operator: 'in' as const, value: [] } }, state: 'clear_from_source' as const, provenance: null },
    qualified_contact_role: {
      base: { value: { field: 'account.id', operator: 'in' as const, value: [] }, state: 'clear_from_source' as const, provenance: null },
      extensions: { value: null, state: 'decision_required' as const, provenance: null },
      attestation_fact_key: { value: null, state: 'decision_required' as const, provenance: null },
    },
    dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 90, unit: 'calendar' as const }, scope: [], discovery_coverage_role_keys: ['crm'] }, state: 'clear_from_source' as const, provenance: null },
    rejection_rule: {
      value: {
        valid_reasons: ['bad_fit'], valid_channels: ['crm'], requires_timestamp: true, requires_identification: true, email_alone_valid: false, channel_exception: null,
        late_rejection_behavior: 'ignored_for_initial_qualification' as const,
        reason_predicates: { bad_fit: { kind: 'expression' as const, expect: 'not_satisfied' as const, expression: { kind: 'condition' as const, condition: { field: 'account.id', operator: 'in' as const, value: [] } } } },
      },
      state: 'clear_from_source' as const, provenance: null,
    },
    rejection_window: { value: { business_days: 1, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'occurred_at' as const }, state: 'clear_from_source' as const, provenance: null },
    deadline_convention: { value: 'end_of_business_day' as const, state: 'decision_required' as const, provenance: null },
    business_day_end_local_time: { value: null, state: 'decision_required' as const, provenance: null },
    attribution_basis: { value: 'occurred_at' as const, state: 'verdix_recommends' as const, provenance: null },
    evidence_precedence: {},
    fact_evidence_source_roles: {
      'account.id': { value: ['crm'], state: 'decision_required' as const, provenance: null },
    },
    field_sources: {},
    effective_from: '2026-01-01T00:00:00Z',
  }
}

// One full calendar month's [periodStartUnix, periodEndUnix] scan range
// (matching invoice-scheduler's own convention: start-of-month 00:00:00 to
// end-of-month 23:59:59) plus a billingAsOfUnix safely past its close (the
// 5th of the following month).
function monthRangeUnix(year: number, month1to12: number) {
  const start = new Date(Date.UTC(year, month1to12 - 1, 1, 0, 0, 0))
  const lastDay = new Date(Date.UTC(year, month1to12, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, month1to12 - 1, lastDay, 23, 59, 59))
  const billingAsOf = new Date(Date.UTC(year, month1to12, 5, 0, 0, 0))
  return {
    periodStartUnix: Math.floor(start.getTime() / 1000),
    periodEndUnix: Math.floor(end.getTime() / 1000),
    billingAsOfUnix: Math.floor(billingAsOf.getTime() / 1000),
  }
}

describeIf('usage-pull qualified_unit_aggregate connector — real Postgres production-path integration', () => {
  let orgId: string
  let jobId: string
  let crmBindingId: string
  const terms = { contract_start_date: '2026-01-01', contract_end_date: null } as unknown as ContractTerms

  // Hardening item 3 — derives the EXACT [periodStart, periodEnd) boundary
  // the REAL production code (lib/usage-pull.ts's qualified_unit_aggregate
  // branch) will compute for a given scan range, by calling the SAME
  // enumerateCadenceWindows/clampWindowToContract functions with the SAME
  // anchorDate/cadence/contract-end inputs usage-pull.ts itself uses.
  // Real-Postgres discovery (previous pass): these windows are built from
  // LOCAL (server-timezone) Date(y,m,d) construction, so their true UTC
  // instant is OFFSET from a naive '2026-09-01T00:00:00Z' literal whenever
  // the server isn't running in UTC — deriving the boundary this way,
  // rather than padding around it, means an off-by-hours regression in
  // either this file or usage-pull.ts's own window math would show up as a
  // real test failure instead of being silently absorbed.
  function computeExpectedSqmWindow(periodStartUnix: number, periodEndUnix: number): { periodStart: string; periodEnd: string } {
    const anchorDate = new Date(terms.contract_start_date + 'T00:00:00')
    const scanStart = new Date(periodStartUnix * 1000)
    const scanEnd = new Date(periodEndUnix * 1000)
    const windows = enumerateCadenceWindows(anchorDate, 'monthly', scanStart, scanEnd, 'contract_start')
    expect(windows).toHaveLength(1)
    const { start: measureStart, end: measureEnd } = clampWindowToContract(windows[0], anchorDate, null)
    // Mirrors usage-pull.ts's own qualified_unit_aggregate branch exactly:
    // measureEnd is a calendar-day START (see windowEndUnix's +86_399
    // adjustment inside computeOverageForPeriod), so +1 day gives the
    // correct exclusive half-open upper bound.
    const periodEnd = new Date(measureEnd.getTime() + 86_400_000)
    return { periodStart: measureStart.toISOString(), periodEnd: periodEnd.toISOString() }
  }

  beforeAll(async () => {
    const slug = `usage-pull-qua-integration-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'usage-pull-qua-integration-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'usage-pull-qua-integration-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    const crmRole = await registerSourceRole(jobId, orgId, 'crm')
    const crmBinding = await createSourceBinding(crmRole.id, jobId, orgId, 'CRM', '2026-01-01T00:00:00Z')
    crmBindingId = crmBinding.id

    const draft = await createDraftQualificationRule(minimalSqmRuleInput(jobId, orgId))
    await confirmQualificationRuleFieldAndPersist(draft.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.base', { field: 'account.id', operator: 'in', value: [] })
    await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.attestation_fact_key', null)
    await confirmQualificationRuleFieldAndPersist(draft.id, 'dedupe_rule')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_rule')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_window')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'deadline_convention', 'end_of_business_day')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'business_day_end_local_time', '17:00:00')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'attribution_basis')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.account.id', ['crm'])
    await activateQualificationRule(draft.id)

    // contract_meter_mappings — the SAME real table computeOverageForPeriod
    // reads (see lib/usage-pull.ts). meter_key MUST equal the qualification
    // rule's unit_type ('SQM') — that equivalence IS the whole integration
    // point, documented in usage-pull.ts's own new branch.
    const { error: mappingError } = await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'Sales Qualified Meeting', meter_key: 'SQM',
      included_units: 0, overage_tiers: buildOs202609SqmTiers(), billing_cycle: 'monthly', confirmed: true,
    })
    if (mappingError) throw new Error(`contract_meter_mappings insert failed: ${mappingError.message}`)

    // billing_meters — org-scoped (not global) to avoid colliding with any
    // other test/run using meter_key 'SQM'.
    const { error: meterError } = await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: 'SQM', display_name: 'Sales Qualified Meeting', unit_label: 'meeting',
      mode: 'live', connector: 'qualified_unit_aggregate',
    })
    if (meterError) throw new Error(`billing_meters insert failed: ${meterError.message}`)

    // A completely ordinary, PRE-EXISTING test-mode meter in the SAME job —
    // proves the new branch is additive and does not disturb the
    // already-existing test-mode skip behavior for any other meter row.
    const { error: legacyMeterError } = await supabaseServer.from('billing_meters').insert({
      org_id: orgId, meter_key: 'LEGACY_METER', display_name: 'Legacy External Meter', unit_label: 'call',
      mode: 'test', test_usage_value: 999,
    })
    if (legacyMeterError) throw new Error(`legacy billing_meters insert failed: ${legacyMeterError.message}`)
    const { error: legacyMappingError } = await supabaseServer.from('contract_meter_mappings').insert({
      job_id: jobId, contract_unit_type: 'Legacy External Metric', meter_key: 'LEGACY_METER',
      included_units: 0, overage_tiers: [{ from_unit: 1, to_unit: null, rate_per_unit: 1 }], billing_cycle: 'monthly', confirmed: true,
    })
    if (legacyMappingError) throw new Error(`legacy contract_meter_mappings insert failed: ${legacyMappingError.message}`)
  })

  afterAll(async () => {
    await supabaseServer.from('planned_invoices').delete().eq('job_id', jobId)
    await supabaseServer.from('source_coverage').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_candidates').delete().eq('job_id', jobId)
    await supabaseServer.from('contract_meter_mappings').delete().eq('job_id', jobId)
    await supabaseServer.from('billing_meters').delete().eq('org_id', orgId)
    await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', jobId)
    await supabaseServer.from('source_bindings').delete().eq('job_id', jobId)
    await supabaseServer.from('source_roles').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  async function makeQualifiedCandidate(externalId: string, attributionAt: string) {
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'SQM', source_binding_id: crmBindingId,
      external_id: externalId, booked_at: attributionAt, occurred_at: attributionAt,
    })
    const { error } = await supabaseServer.rpc('finalize_billable_unit_candidate', {
      p_candidate_id: candidate.id, p_status: 'qualified', p_decided_at: attributionAt, p_rejection_deadline: attributionAt,
    })
    if (error) throw new Error(`finalize_billable_unit_candidate failed: ${error.message}`)
    return candidate
  }

  it('configured source = qualified_unit_aggregate -> aggregation resolves a ready quantity -> the REAL computeOverageForPeriod prices it via the existing engine, unaffected legacy test-mode meter still skips as before', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 9) // September
    await makeQualifiedCandidate('ext-prod-1', '2026-09-05T09:00:00Z')
    await makeQualifiedCandidate('ext-prod-2', '2026-09-15T09:00:00Z')
    await makeQualifiedCandidate('ext-prod-3', '2026-09-25T09:00:00Z')
    const { periodStart, periodEnd } = computeExpectedSqmWindow(periodStartUnix, periodEndUnix)
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: periodStart, covered_through: periodEnd, established_at: '2026-10-02T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-prod-path',
      periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
    })

    // The legacy test-mode meter is silently skipped (real billing never
    // invoices a test-mode meter) — exactly the pre-16B.4 behavior,
    // undisturbed by the new branch existing alongside it.
    expect(items.find(i => i.meter_key === 'LEGACY_METER')).toBeUndefined()

    const sqmItem = items.find(i => i.meter_key === 'SQM')
    expect(sqmItem).toBeDefined()
    expect(sqmItem!.total_units).toBe(3)
    // 3 * €250 = €750, below the €5,000 floor.
    expect(sqmItem!.amount).toBe(5000)
    expect(sqmItem!.minimumFloorApplied).toBe(true)
    expect(sqmItem!.metric_source).toBe('meter_pull')
  })

  it('coverage exactly matching [periodStart, periodEnd) is complete; falling one meaningful instant short of periodEnd is incomplete (hardening item 3)', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 10) // October — its own clean period
    await makeQualifiedCandidate('ext-exact-1', '2026-10-08T09:00:00Z')
    const { periodStart, periodEnd } = computeExpectedSqmWindow(periodStartUnix, periodEndUnix)

    // Exactly one second short of the real, derived periodEnd — a genuine,
    // meaningful gap, not a padded/approximate boundary.
    const oneInstantShort = new Date(new Date(periodEnd).getTime() - 1000).toISOString()
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: periodStart, covered_through: oneInstantShort, established_at: '2026-11-02T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    await expect(computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-exact-boundary-short',
      periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
    })).rejects.toThrow(QuantitySourceNotReadyError)

    // Extending coverage to EXACTLY periodEnd (no padding) closes the gap
    // and the same real call now succeeds.
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: oneInstantShort, covered_through: periodEnd, established_at: '2026-11-03T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-exact-boundary-complete',
      periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
    })
    expect(items.find(i => i.meter_key === 'SQM')).toBeDefined()
  })

  it('same source pending (a candidate still pending in-period) -> the REAL computeOverageForPeriod throws QuantitySourceNotReadyError before any pricing happens', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 11) // November — its own clean period
    await makeQualifiedCandidate('ext-prod-ready-1', '2026-11-06T09:00:00Z')
    // Deliberately pending — never finalized.
    await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'SQM', source_binding_id: crmBindingId,
      external_id: 'ext-prod-pending-1', booked_at: '2026-11-18T09:00:00Z', occurred_at: '2026-11-18T09:00:00Z',
    })
    const { periodStart, periodEnd } = computeExpectedSqmWindow(periodStartUnix, periodEndUnix)
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: periodStart, covered_through: periodEnd, established_at: '2026-12-02T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    await expect(computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-prod-path-pending',
      periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
    })).rejects.toThrow(QuantitySourceNotReadyError)
  })

  // ═══════════════════════════════════════════════════════════════════
  // Hardening item 2 — scheduler retry/hold audit. Reproduces the EXACT
  // catch-block behavior app/api/admin/invoice-scheduler/route.ts now
  // applies on QuantitySourceNotReadyError (revert the claim to
  // 'scheduled', prefix error_message 'Held:', never 'failed') against a
  // real planned_invoices row, and proves the scheduler's own real
  // selection predicate (status='scheduled') would find it again on a
  // later run — then proves that once the quantity source becomes ready,
  // the SAME planned billing work resolves normally. Does not invoke the
  // full route handler directly (that needs live Stripe/VAT/Remembill
  // wiring, out of scope) — the route's own catch-block logic is small
  // enough to audit by direct reading, exactly like this codebase's own
  // existing precedent for computeOverageForPeriod (see this file's
  // header comment) — this test verifies the DATABASE-VISIBLE CONSEQUENCE
  // of that logic (does the row become retryable, does retrying resolve
  // it) rather than the route's own internal control flow.
  // ═══════════════════════════════════════════════════════════════════
  it('run 1: quantity pending -> row held (reverted to scheduled, never failed); run 2 after readiness completes -> same row retries and resolves normally', async () => {
    const { periodStartUnix, periodEndUnix, billingAsOfUnix } = monthRangeUnix(2026, 12) // December — its own clean period
    const { data: plannedRow, error: insertError } = await supabaseServer.from('planned_invoices').insert({
      job_id: jobId, org_id: orgId, period_start: '2027-01-01', period_end: '2027-01-31',
      base_amount: 0, currency: 'EUR', invoice_type: 'period', status: 'scheduled',
    }).select('id').single()
    if (insertError) throw new Error(`planned_invoices insert failed: ${insertError.message}`)
    const plannedInvoiceId = plannedRow!.id

    // Mirrors the scheduler's OWN real claim step exactly (see
    // app/api/admin/invoice-scheduler/route.ts, the lock UPDATE just
    // before the per-row try block).
    await supabaseServer.from('planned_invoices').update({ status: 'processing', processing_started_at: new Date().toISOString() }).eq('id', plannedInvoiceId)

    await makeQualifiedCandidate('ext-retry-ready-1', '2026-12-07T09:00:00Z')
    const pending = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'SQM', source_binding_id: crmBindingId,
      external_id: 'ext-retry-pending-1', booked_at: '2026-12-19T09:00:00Z', occurred_at: '2026-12-19T09:00:00Z',
    })
    const { periodStart, periodEnd } = computeExpectedSqmWindow(periodStartUnix, periodEndUnix)
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: periodStart, covered_through: periodEnd, established_at: '2027-01-02T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    // ── Run 1 — the "rejection window still open" state ──────────────
    let run1Error: unknown
    try {
      await computeOverageForPeriod({
        orgId, jobId, terms, customerId: 'cust-retry-run1',
        periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
      })
    } catch (err) {
      run1Error = err
    }
    expect(run1Error).toBeInstanceOf(QuantitySourceNotReadyError)
    // The exact route-level handling being audited.
    await supabaseServer.from('planned_invoices').update({
      status: 'scheduled', processing_started_at: null, error_message: `Held: ${(run1Error as Error).message}`,
    }).eq('id', plannedInvoiceId)

    const { data: afterRun1 } = await supabaseServer.from('planned_invoices').select('status, error_message').eq('id', plannedInvoiceId).single()
    expect(afterRun1!.status).toBe('scheduled') // never 'failed'
    expect(afterRun1!.error_message).toMatch(/^Held:/)

    // The scheduler's OWN real selection predicate — proves this row is
    // genuinely re-discoverable by a later run, not just left in a
    // status that happens to be named 'scheduled'.
    const { data: reselected } = await supabaseServer.from('planned_invoices').select('id').eq('status', 'scheduled').eq('id', plannedInvoiceId).maybeSingle()
    expect(reselected?.id).toBe(plannedInvoiceId)

    // ── "The rejection window closes" ─────────────────────────────────
    await supabaseServer.rpc('finalize_billable_unit_candidate', {
      p_candidate_id: pending.id, p_status: 'qualified', p_decided_at: '2026-12-19T09:00:00Z', p_rejection_deadline: '2026-12-19T09:00:00Z',
    })

    // ── Run 2 — re-claim (mirrors the scheduler's own next run) ───────
    await supabaseServer.from('planned_invoices').update({ status: 'processing', processing_started_at: new Date().toISOString() }).eq('id', plannedInvoiceId)
    const items = await computeOverageForPeriod({
      orgId, jobId, terms, customerId: 'cust-retry-run2',
      periodStartUnix, periodEndUnix, currency: 'eur', billingAsOfUnix,
    })
    const sqmItem = items.find(i => i.meter_key === 'SQM')
    expect(sqmItem).toBeDefined()
    expect(sqmItem!.total_units).toBe(2) // ext-retry-ready-1 + the now-qualified ext-retry-pending-1
    expect(sqmItem!.amount).toBe(5000) // 2 * €250 = €500, still below the €5,000 floor
  })
})
