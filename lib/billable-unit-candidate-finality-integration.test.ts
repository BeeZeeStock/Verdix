import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer, createBrowserClient } from './supabase'
import { createSourceBinding } from './source-bindings-service'
import { registerSourceRole } from './source-roles-service'
import { createDraftQualificationRule, confirmQualificationRuleFieldAndPersist, activateQualificationRule } from './billable-unit-qualification-service'
import { createOrGetCandidate, recordCandidateEvidence, getCandidate } from './billable-unit-candidate-service'
import { recordSourceCoverage, revokeSourceCoverage } from './source-coverage-service'
import { evaluateAndFinalizeCandidate } from './billable-unit-candidate-finality-service'
import { OBJECTION_REASON_FACT_KEY, OBJECTION_CHANNEL_FACT_KEY, OBJECTION_TIMESTAMP_FACT_KEY, OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY } from './billable-unit-candidate-finality'
import { computeBusinessDayDeadline } from './business-days'

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests for source_coverage / the widened billable_unit_candidates
// lifecycle / finalize_billable_unit_candidate — real network calls against
// the real (post-migration) database, same pattern as
// lib/billable-unit-candidate-integration.test.ts.
//
// SKIPPED BY DEFAULT — PENDING. Migration
// 20260831000001_billable_unit_candidate_finality.sql has NOT been applied
// to any database and has not been exercised against real Postgres.
// Written and type-checked only; kept opt-in per explicit instruction
// ("Keep new DB integration tests opt-in until review. Do not apply the
// new migration yet."):
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/billable-unit-candidate-finality-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

function minimalRuleInput(jobId: string, orgId: string, unitType: string, effectiveFrom: string) {
  return {
    job_id: jobId, org_id: orgId, unit_type: unitType,
    fact_schema: {
      'account.id': { type: 'string' as const, reference_time: 'booked_at' as const },
      amount: { type: 'number' as const, reference_time: 'occurred_at' as const },
      // Deliberately NOT referenced by criteria/dedupe at all — the one
      // reason genuinely independent of the fast criteria/dedupe paths,
      // needed to exercise an actual OBJECTION-based rejection (see
      // 'independent_reason' below). 'bad_fit' negates the SAME field
      // criteria itself checks, so a substantiated 'bad_fit' always also
      // makes criteria.result 'not_satisfied' and is intercepted by the
      // fast path first — exactly the circularity documented in
      // lib/billable-unit-candidate-finality.test.ts.
      independent_flag: { type: 'boolean' as const, reference_time: 'occurred_at' as const },
      [OBJECTION_REASON_FACT_KEY]: { type: 'enum' as const, enumValues: ['bad_fit', 'independent_reason'], reference_time: 'occurred_at' as const },
      [OBJECTION_CHANNEL_FACT_KEY]: { type: 'string' as const, reference_time: 'occurred_at' as const },
      [OBJECTION_TIMESTAMP_FACT_KEY]: { type: 'timestamp' as const, reference_time: 'occurred_at' as const },
      [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: { type: 'string' as const, reference_time: 'occurred_at' as const },
    },
    criteria: { value: { kind: 'condition' as const, condition: { field: 'amount', operator: 'gte' as const, value: 10 } }, state: 'clear_from_source' as const, provenance: null },
    qualified_contact_role: {
      base: { value: null, state: 'decision_required' as const, provenance: null },
      extensions: { value: null, state: 'decision_required' as const, provenance: null },
      attestation_fact_key: { value: null, state: 'decision_required' as const, provenance: null },
    },
    dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 30, unit: 'calendar' as const }, scope: [], discovery_coverage_role_keys: ['crm'] }, state: 'clear_from_source' as const, provenance: null },
    rejection_rule: {
      value: {
        valid_reasons: ['bad_fit', 'independent_reason'], valid_channels: ['crm'], requires_timestamp: true, requires_identification: true, email_alone_valid: false, channel_exception: null,
        late_rejection_behavior: 'ignored_for_initial_qualification' as const,
        reason_predicates: {
          // 'bad_fit' is never exercised by an objection record in this
          // file (see fact_schema's own note on its circularity with
          // criteria) — present only so activation's "every valid_reasons
          // entry needs a predicate" check is satisfied.
          bad_fit: { kind: 'expression' as const, expect: 'not_satisfied' as const, expression: { kind: 'condition' as const, condition: { field: 'amount', operator: 'gte' as const, value: 10 } } },
          // Genuinely independent of criteria/dedupe — the only reason
          // that can actually reach the objection-based rejection path.
          independent_reason: { kind: 'expression' as const, expect: 'satisfied' as const, expression: { kind: 'condition' as const, condition: { field: 'independent_flag', operator: 'eq' as const, value: true } } },
        },
      },
      state: 'clear_from_source' as const, provenance: null,
    },
    rejection_window: { value: { business_days: 1, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'occurred_at' as const }, state: 'clear_from_source' as const, provenance: null },
    deadline_convention: { value: 'end_of_business_day' as const, state: 'decision_required' as const, provenance: null },
    business_day_end_local_time: { value: null, state: 'decision_required' as const, provenance: null },
    attribution_basis: { value: 'occurred_at' as const, state: 'verdix_recommends' as const, provenance: null },
    evidence_precedence: {},
    fact_evidence_source_roles: {
      amount: { value: null, state: 'decision_required' as const, provenance: null },
      'account.id': { value: null, state: 'decision_required' as const, provenance: null },
      independent_flag: { value: null, state: 'decision_required' as const, provenance: null },
    },
    field_sources: {},
    effective_from: effectiveFrom,
  }
}

function multiSourceRuleInput(jobId: string, orgId: string, unitType: string, effectiveFrom: string) {
  const base = minimalRuleInput(jobId, orgId, unitType, effectiveFrom)
  return {
    ...base,
    // Real-Postgres verification (closeout pass) — a second, multi-capable-
    // source rule variant, mirroring lib/billable-unit-candidate-
    // finality.test.ts's own buildDedupeInstabilityRule: 'account.id' can
    // resolve from EITHER 'crm' or 'enrichment', with an explicit
    // source_precedence ['crm', 'enrichment'] — lets the fact-finality/
    // dedupe-instability tests below exercise a genuinely unstable
    // resolution (lower-priority source resolves while the higher-priority
    // source's own completeness is unproven) against real Postgres.
    evidence_precedence: {
      'account.id': { value: { kind: 'source_precedence' as const, order: ['crm', 'enrichment'] }, state: 'clear_from_source' as const, provenance: 'contract_derived' as const },
    },
    fact_evidence_source_roles: {
      ...base.fact_evidence_source_roles,
      'account.id': { value: ['crm', 'enrichment'], state: 'clear_from_source' as const, provenance: 'contract_derived' as const },
    },
  }
}

// Isolated job/org for the multi-source (crm + enrichment) dedupe-
// instability / fact-precedence tests — deliberately NOT sharing the main
// describe block's job. Real-Postgres discovery: source_coverage is
// job+source_binding scoped, not per-candidate or per-test — the main
// suite's many other tests each record broad, wide-dated 'fact_evidence'
// coverage on the shared crmBindingId (some from '2020-01-01' onward),
// which silently satisfied these two tests' "crm is deliberately
// unproven" precondition when they shared that job, making them assert
// the OPPOSITE of what they were written to prove. A dedicated job/org
// removes any possibility of cross-test coverage contamination.
async function createIsolatedMultiSourceJob() {
  const slug = `buq-finality-multisource-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'buq-finality-multisource-org', slug }).select('id').single()
  if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
  const orgId = org!.id
  const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
    org_id: orgId, name: 'buq-finality-multisource-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
  }).select('id').single()
  if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
  const jobId = job!.id

  const crmRole = await registerSourceRole(jobId, orgId, 'crm')
  const crmBinding = await createSourceBinding(crmRole.id, jobId, orgId, 'CRM', '2026-01-01T00:00:00Z')
  const enrichmentRole = await registerSourceRole(jobId, orgId, 'enrichment')
  const enrichmentBinding = await createSourceBinding(enrichmentRole.id, jobId, orgId, 'ENRICHMENT', '2026-01-01T00:00:00Z')

  const draft = await createDraftQualificationRule(multiSourceRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT_MULTI_SOURCE', '2026-01-01T00:00:00Z'))
  await confirmQualificationRuleFieldAndPersist(draft.id, 'criteria')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.base', { field: 'amount', operator: 'in', value: [25, 3] })
  await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.attestation_fact_key', null)
  await confirmQualificationRuleFieldAndPersist(draft.id, 'dedupe_rule')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_rule')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_window')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'deadline_convention', 'end_of_business_day')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'business_day_end_local_time', '17:00:00')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'attribution_basis')
  await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.amount', ['crm'])
  await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.independent_flag', ['crm'])
  await activateQualificationRule(draft.id)

  return { orgId, jobId, crmBindingId: crmBinding.id, enrichmentBindingId: enrichmentBinding.id }
}

async function cleanupIsolatedJob(jobId: string, orgId: string) {
  await supabaseServer.from('source_coverage').delete().eq('job_id', jobId)
  await supabaseServer.from('candidate_unit_evidence').delete().eq('job_id', jobId)
  await supabaseServer.from('billable_unit_candidates').delete().eq('job_id', jobId)
  await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', jobId)
  await supabaseServer.from('source_bindings').delete().eq('job_id', jobId)
  await supabaseServer.from('source_roles').delete().eq('job_id', jobId)
  await supabaseServer.from('jobs').delete().eq('id', jobId)
  await supabaseServer.from('organizations').delete().eq('id', orgId)
}

describeIf('source_coverage / billable_unit_candidates finality — real Postgres round trip + RLS', () => {
  let orgId: string
  let jobId: string
  let crmBindingId: string

  beforeAll(async () => {
    const slug = `buq-finality-integration-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'buq-finality-integration-test-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'buq-finality-integration-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    const crmRole = await registerSourceRole(jobId, orgId, 'crm')
    const crmBinding = await createSourceBinding(crmRole.id, jobId, orgId, 'CRM', '2026-01-01T00:00:00Z')
    crmBindingId = crmBinding.id

    const draft = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT', '2026-01-01T00:00:00Z'))
    await confirmQualificationRuleFieldAndPersist(draft.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.base', { field: 'amount', operator: 'in', value: [25, 3] })
    await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.attestation_fact_key', null)
    await confirmQualificationRuleFieldAndPersist(draft.id, 'dedupe_rule')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_rule')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'rejection_window')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'deadline_convention', 'end_of_business_day')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'business_day_end_local_time', '17:00:00')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'attribution_basis')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.amount', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.account.id', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft.id, 'fact_evidence_source_roles.independent_flag', ['crm'])
    await activateQualificationRule(draft.id)

    // A SECOND rule, deliberately anchoring rejection_window to booked_at
    // instead of occurred_at (a test-only decoupling, same technique used
    // in lib/billable-unit-candidate-finality.test.ts's own materiality
    // suite) — lets the "fast rejection + unresolved deadline" tests below
    // construct a candidate with occurred_at present (so amount/criteria
    // can conclusively resolve) while booked_at is null (so the deadline
    // genuinely cannot resolve), without those two needs colliding.
    const draft2 = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT_BOOKED_DEADLINE', '2026-01-01T00:00:00Z'))
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'qualified_contact_role.base', { field: 'amount', operator: 'in', value: [25, 3] })
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'qualified_contact_role.attestation_fact_key', null)
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'dedupe_rule')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'rejection_rule')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'rejection_window', { business_days: 1, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'booked_at' })
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'deadline_convention', 'end_of_business_day')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'business_day_end_local_time', '17:00:00')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'attribution_basis')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'fact_evidence_source_roles.amount', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'fact_evidence_source_roles.account.id', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'fact_evidence_source_roles.independent_flag', ['crm'])
    await activateQualificationRule(draft2.id)

    // A THIRD rule — attribution_basis 'booked_at' (unlike draft/draft2,
    // which both use the default 'occurred_at') while
    // rejection_window stays anchored to occurred_at. Real-Postgres
    // discovery: attribution_basis governs which rule VERSION pins to a
    // candidate (lib/billable-unit-candidate.ts's pinQualificationRuleVersion)
    // — a wholly separate concern from rejection_window.reference_time
    // (which governs the DEADLINE anchor). A candidate with occurred_at:
    // null cannot even be CREATED under a rule whose attribution_basis is
    // 'occurred_at' (pinning has nothing to attribute against), regardless
    // of what the deadline test intends — this rule decouples the two so
    // a candidate can pin via booked_at while still exercising an
    // occurred_at-anchored, genuinely-unresolvable deadline.
    const draft4 = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT_BOOKED_ATTRIBUTION', '2026-01-01T00:00:00Z'))
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'qualified_contact_role.base', { field: 'amount', operator: 'in', value: [25, 3] })
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'qualified_contact_role.attestation_fact_key', null)
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'dedupe_rule')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'rejection_rule')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'rejection_window')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'deadline_convention', 'end_of_business_day')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'business_day_end_local_time', '17:00:00')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'attribution_basis', 'booked_at')
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'fact_evidence_source_roles.amount', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'fact_evidence_source_roles.account.id', ['crm'])
    await confirmQualificationRuleFieldAndPersist(draft4.id, 'fact_evidence_source_roles.independent_flag', ['crm'])
    await activateQualificationRule(draft4.id)
  })

  afterAll(async () => {
    await supabaseServer.from('source_coverage').delete().eq('job_id', jobId)
    await supabaseServer.from('candidate_unit_evidence').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_candidates').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', jobId)
    await supabaseServer.from('source_bindings').delete().eq('job_id', jobId)
    await supabaseServer.from('source_roles').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('finalizes a clean candidate to qualified, populates decided_at/rejection_deadline atomically, and is idempotent on retry', async () => {
    const occurredAt = '2026-09-01T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-qualified-1', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-1', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })

    const deadline = '2026-09-02T21:59:59.999Z' // 1 business day, end_of_business_day, 17:00:00 local, CEST
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2026-08-01T00:00:00Z', covered_through: '2026-09-02T00:00:00Z', established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'rejection_source',
      covered_from: occurredAt, covered_through: deadline, established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    // Contractual-finality hardening — 'amount' and 'account.id' are both
    // materially used by the qualified path (criteria + dedupe key_fields)
    // and must themselves be proven final, not just observed once.
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2026-01-01T00:00:00Z', covered_through: occurredAt, established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const asOf = '2026-09-03T00:00:00Z'
    const first = await evaluateAndFinalizeCandidate(candidate.id, asOf)
    expect(first.decision?.outcome).toBe('qualified')
    expect(first.candidate.status).toBe('qualified')
    expect(first.candidate.decided_at).not.toBeNull()
    expect(first.candidate.rejection_deadline).not.toBeNull()

    // Item J — re-finalizing an already-terminal candidate never
    // re-evaluates or mutates it.
    const second = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(second.decision).toBeNull()
    expect(second.candidate.decided_at).toBe(first.candidate.decided_at)
    expect(second.candidate.status).toBe('qualified')

    // The RPC's own WHERE status = 'pending' guard, exercised directly —
    // a second call against an already-terminal row matches zero rows.
    const { data: rpcRetry, error: rpcError } = await supabaseServer.rpc('finalize_billable_unit_candidate', {
      p_candidate_id: candidate.id, p_status: 'rejected', p_decided_at: '2026-12-01T00:00:00Z', p_rejection_deadline: '2026-12-02T00:00:00Z',
    })
    expect(rpcError).toBeNull()
    expect(Array.isArray(rpcRetry) ? rpcRetry.length : 0).toBe(0)

    // Independent backstop — even a RAW update attempt against status/
    // decided_at/rejection_deadline is rejected by the terminal-
    // immutability trigger, not merely unreachable via the RPC's WHERE
    // clause.
    const { error: rawUpdateError } = await supabaseServer.from('billable_unit_candidates')
      .update({ status: 'rejected' }).eq('id', candidate.id)
    expect(rawUpdateError).not.toBeNull()
    expect(rawUpdateError?.message).toMatch(/immutable once terminal/)

    const reread = await getCandidate(candidate.id)
    expect(reread?.status).toBe('qualified')
  })

  it('remains pending when required rejection-source coverage is incomplete, and finalize_billable_unit_candidate is a no-op for a pending candidate outside the service flow', async () => {
    const occurredAt = '2026-09-05T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-pending-1', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-2', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    // No source_coverage recorded at all — rejection/dedupe completeness
    // cannot clear.
    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(result.decision?.outcome).toBe('pending')
    expect(result.candidate.status).toBe('pending')
    expect(result.candidate.decided_at).toBeNull()
  })

  it('source_coverage is append-only — a direct UPDATE attempt is rejected by the trigger', async () => {
    const row = await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    const { error } = await supabaseServer.from('source_coverage').update({ covered_through: '2026-03-01T00:00:00Z' }).eq('id', row.id)
    expect(error).not.toBeNull()
    // Real-Postgres discovery: the migration's actual trigger message is
    // "substantive fields are immutable once inserted", not "append-only"
    // — this test's own regex was never checked against the real trigger
    // until this run (the migration was unapplied until now).
    expect(error?.message).toMatch(/immutable once inserted/)
  })

  it('RLS: anon key gets no rows via SELECT and is rejected on INSERT for source_coverage', async () => {
    const anon = createBrowserClient()
    const { data, error: selectError } = await anon.from('source_coverage').select('id').eq('job_id', jobId)
    if (!selectError) expect(data ?? []).toHaveLength(0)

    const { error: insertError } = await anon.from('source_coverage').insert({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    expect(insertError).toBeTruthy()
  })

  it('RLS: anon cannot execute finalize_billable_unit_candidate', async () => {
    const anon = createBrowserClient()
    const { error } = await anon.rpc('finalize_billable_unit_candidate', {
      p_candidate_id: '00000000-0000-0000-0000-000000000000', p_status: 'qualified', p_decided_at: '2026-01-01T00:00:00Z', p_rejection_deadline: '2026-01-02T00:00:00Z',
    })
    expect(error).not.toBeNull()
    expect((error as { code?: string } | null)?.code).toBe('42501')
  })

  it('a definitive duplicate finalizes to rejected even without dedupe/rejection coverage', async () => {
    const priorOccurredAt = '2026-08-01T09:00:00Z'
    const prior = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-prior-1', booked_at: priorOccurredAt, occurred_at: priorOccurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: prior.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-dup', amount: 25 }, occurred_at: priorOccurredAt, recorded_at: priorOccurredAt, recorded_by: 'test-harness',
    })

    const occurredAt = '2026-08-15T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-dup-1', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-dup', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    // A definitive duplicate is dispositive on its own (item 8) — its
    // material fact set is only dedupe_rule.key_fields (account.id), never
    // criteria. Still requires account.id's OWN finality though (item 1) —
    // a candidate_discovery/rejection_source-only setup would not suffice.
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2026-01-01T00:00:00Z', covered_through: occurredAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(result.decision?.outcome).toBe('rejected')
    expect(result.decision?.dedupe.outcome).toBe('duplicate')
    expect(result.candidate.status).toBe('rejected')
  })

  it('revocation lifecycle: payload immutable, active -> revoked only, revoked_at >= established_at, double revoke rejected', async () => {
    const row = await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2026-01-01T00:00:00Z', covered_through: '2026-02-01T00:00:00Z', established_at: '2026-02-01T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'connector:crm-sync-job-1',
    })
    expect(row.status).toBe('active')

    // A direct payload rewrite is rejected, distinct from the earlier
    // "append-only" test's covered_through change — this one attempts
    // established_by, exercising a different substantive column.
    const { error: payloadError } = await supabaseServer.from('source_coverage').update({ established_by: 'someone-else' }).eq('id', row.id)
    expect(payloadError).not.toBeNull()
    expect(payloadError?.message).toMatch(/immutable once inserted/)

    // The atomic revocation RPC — the ONE real update path.
    const revoked = await revokeSourceCoverage(row.id, '2026-02-15T00:00:00Z', 'reviewer:alice@example.com')
    expect(revoked.status).toBe('revoked')
    expect(revoked.revoked_at).not.toBeNull()
    expect(revoked.revoked_by).toBe('reviewer:alice@example.com')

    // Double revoke rejected — the RPC's own WHERE status='active' guard
    // matches zero rows, so revokeSourceCoverage throws rather than
    // silently clobbering the first revocation.
    await expect(revokeSourceCoverage(row.id, '2026-03-01T00:00:00Z', 'reviewer:bob@example.com')).rejects.toThrow(/was not revoked/)

    // revoked_at >= established_at is enforced at the DB level — a raw
    // RPC call with an earlier revoked_at is rejected outright (using a
    // FRESH row, since the one above is already revoked).
    const row2 = await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2026-03-01T00:00:00Z', covered_through: '2026-04-01T00:00:00Z', established_at: '2026-04-01T00:00:00Z',
      completeness_basis: 'connector_high_watermark', established_by: 'connector:crm-sync-job-2',
    })
    const { error: earlyRevokeError } = await supabaseServer.rpc('revoke_source_coverage', {
      p_coverage_id: row2.id, p_revoked_at: '2026-03-15T00:00:00Z', p_revoked_by: 'reviewer:alice@example.com',
    })
    expect(earlyRevokeError).not.toBeNull()
  })

  it('a corrected replacement (revoke + append) never alters what an earlier historical asOf already established, verified through the real evaluator', async () => {
    const occurredAt = '2026-10-01T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-revocation-1', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-revocation', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const deadline = '2026-10-02T21:59:59.999Z'
    const dedupeRow = await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2026-08-01T00:00:00Z', covered_through: '2026-10-02T00:00:00Z', established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'connector:crm-sync-job-3',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'rejection_source',
      covered_from: occurredAt, covered_through: deadline, established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'connector:crm-sync-job-3',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2026-01-01T00:00:00Z', covered_through: occurredAt, established_at: deadline, completeness_basis: 'connector_high_watermark', established_by: 'connector:crm-sync-job-3',
    })

    const asOfBeforeCorrection = '2026-10-03T00:00:00Z'
    const beforeCorrection = await evaluateAndFinalizeCandidate(candidate.id, asOfBeforeCorrection)
    expect(beforeCorrection.decision?.outcome).toBe('qualified')

    // Discover the dedupe coverage was wrong — revoke it and replace it
    // with a corrected (narrower) assertion, established well after the
    // original decision was already made.
    const revocationTime = '2026-11-01T00:00:00Z'
    await revokeSourceCoverage(dedupeRow.id, revocationTime, 'reviewer:alice@example.com')
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2026-09-01T00:00:00Z', covered_through: '2026-10-02T00:00:00Z', established_at: revocationTime, completeness_basis: 'connector_high_watermark', established_by: 'reviewer:alice@example.com',
    })

    // A SECOND candidate, historically identical, evaluated at the SAME
    // early asOf as the first — the correction must be invisible to it,
    // exactly like the first candidate's own already-finalized decision
    // is untouched (proven separately by evaluateAndFinalizeCandidate's
    // own item-J short-circuit, already covered elsewhere).
    const candidate2 = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-revocation-2', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate2.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-revocation-2', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const historicalReplay = await evaluateAndFinalizeCandidate(candidate2.id, asOfBeforeCorrection)
    expect(historicalReplay.decision?.outcome).toBe('qualified') // old coverage still visible at this historical asOf
  })

  // ═══════════════════════════════════════════════════════════════════
  // Final persistence/materiality correction — rejection_deadline must
  // truthfully represent what the SELECTED decision path depended on:
  // null for a fast criteria/dedupe rejection that never needed it, a
  // real value for an objection-based rejection or 'qualified' (both of
  // which structurally require one). Uses the 'FINALITY_TEST_UNIT_BOOKED_
  // DEADLINE' rule (rejection_window anchored to booked_at) so occurred_at
  // can stay present (letting amount/criteria resolve conclusively) while
  // booked_at is null (so the deadline genuinely cannot resolve).
  // ═══════════════════════════════════════════════════════════════════
  it('criteria rejection + unresolved deadline -> persists terminal rejected with rejection_deadline = null', async () => {
    const occurredAt = '2026-10-10T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT_BOOKED_DEADLINE', source_binding_id: crmBindingId,
      external_id: 'ext-null-deadline-criteria', booked_at: null, occurred_at: occurredAt,
    })
    // amount < 10 -> criteria conclusively not_satisfied. No crm evidence
    // at all (account.id can't resolve with booked_at null anyway) — the
    // fast path never needs it.
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { amount: 3 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(result.decision?.outcome).toBe('rejected')
    expect(result.decision?.materialDependencies).toEqual(['criteria', 'fact_finality'])
    expect(result.candidate.status).toBe('rejected')
    expect(result.candidate.decided_at).not.toBeNull()
    expect(result.candidate.rejection_deadline).toBeNull()
  })

  it('duplicate rejection + unresolved deadline -> persists terminal rejected with rejection_deadline = null', async () => {
    // Uses the 'FINALITY_TEST_UNIT_BOOKED_ATTRIBUTION' rule — deadline
    // stays anchored to occurred_at (so it's genuinely unresolvable when
    // occurred_at is null), but attribution_basis is 'booked_at' (unlike
    // the default rule) so pinning itself does not also need occurred_at.
    // account.id is booked_at-referenced, so booked_at stays present on
    // both candidates (dedupe can resolve and match; pinning succeeds)
    // while occurred_at is null on the current candidate (deadline
    // genuinely unresolvable) — the DB-level mirror of the pure-evaluator
    // "conclusive duplicate + unresolved deadline" regression.
    const priorBookedAt = '2026-09-05T00:00:00Z'
    const prior = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT_BOOKED_ATTRIBUTION', source_binding_id: crmBindingId,
      external_id: 'ext-null-deadline-dup-prior', booked_at: priorBookedAt, occurred_at: priorBookedAt,
    })
    await recordCandidateEvidence({
      candidate_id: prior.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-null-deadline-dup', amount: 25 }, occurred_at: priorBookedAt, recorded_at: priorBookedAt, recorded_by: 'test-harness',
    })

    const candidateBookedAt = '2026-10-05T00:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT_BOOKED_ATTRIBUTION', source_binding_id: crmBindingId,
      external_id: 'ext-null-deadline-dup', booked_at: candidateBookedAt, occurred_at: null,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-null-deadline-dup', amount: 25 }, occurred_at: candidateBookedAt, recorded_at: candidateBookedAt, recorded_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: candidateBookedAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(result.decision?.outcome).toBe('rejected')
    expect(result.decision?.dedupe.outcome).toBe('duplicate')
    expect(result.decision?.materialDependencies).toEqual(['dedupe_observation', 'fact_finality'])
    expect(result.candidate.status).toBe('rejected')
    expect(result.candidate.decided_at).not.toBeNull()
    expect(result.candidate.rejection_deadline).toBeNull()
  })

  it('objection-based rejection requires and persists a real rejection_deadline', async () => {
    const occurredAt = '2026-10-20T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-objection-deadline', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-objection-deadline', amount: 25, independent_flag: true }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const rejectionTimestamp = '2026-10-20T12:00:00Z'
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: {
        [OBJECTION_REASON_FACT_KEY]: 'independent_reason', [OBJECTION_CHANNEL_FACT_KEY]: 'crm',
        [OBJECTION_TIMESTAMP_FACT_KEY]: rejectionTimestamp, [OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]: 'ext-objection-deadline',
      },
      occurred_at: rejectionTimestamp, recorded_at: rejectionTimestamp, recorded_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
    expect(result.decision?.outcome).toBe('rejected')
    expect(result.decision?.rejection.outcome).toBe('rejected')
    expect(result.decision?.materialDependencies).toContain('rejection_deadline')
    expect(result.candidate.status).toBe('rejected')
    expect(result.candidate.rejection_deadline).not.toBeNull()
  })

  // ═══════════════════════════════════════════════════════════════════
  // Real-Postgres verification and closeout — items not yet exercised
  // through the integration framework above.
  // ═══════════════════════════════════════════════════════════════════

  it('unstable positive duplicate: current candidate resolves account.id from the lower-priority source while the higher-priority source is unproven -> pending', async () => {
    const iso = await createIsolatedMultiSourceJob()
    try {
      const priorBookedAt = '2026-07-01T09:00:00Z'
      const prior = await createOrGetCandidate({
        job_id: iso.jobId, org_id: iso.orgId, unit_type: 'FINALITY_TEST_UNIT_MULTI_SOURCE', source_binding_id: iso.crmBindingId,
        external_id: 'ext-instab-prior', booked_at: priorBookedAt, occurred_at: priorBookedAt,
      })
      await recordCandidateEvidence({
        candidate_id: prior.id, job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId,
        facts: { 'account.id': 'acct-instab', amount: 25 }, occurred_at: priorBookedAt, recorded_at: priorBookedAt, recorded_by: 'test-harness',
      })
      // Prior's own account.id resolves from crm (the higher-priority source
      // outright) — its own gate is fully provable.
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId, coverage_kind: 'fact_evidence',
        covered_from: '2020-01-01T00:00:00Z', covered_through: priorBookedAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })

      const bookedAt = '2026-07-15T09:00:00Z'
      const candidate = await createOrGetCandidate({
        job_id: iso.jobId, org_id: iso.orgId, unit_type: 'FINALITY_TEST_UNIT_MULTI_SOURCE', source_binding_id: iso.enrichmentBindingId,
        external_id: 'ext-instab-current', booked_at: bookedAt, occurred_at: bookedAt,
      })
      // account.id ONLY observed via enrichment (the LOWER-priority source in
      // ['crm', 'enrichment']) — matches the prior's value textually, so the
      // dedupe OBSERVATION is a match. But requiredRoleKeys for finality is
      // ['crm', 'enrichment'] (both, since enrichment is idx 1) — crm is
      // never covered for this candidate's own reference time, so the gate
      // must block.
      await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.enrichmentBindingId,
        facts: { 'account.id': 'acct-instab', amount: 25 }, occurred_at: bookedAt, recorded_at: bookedAt, recorded_by: 'test-harness',
      })
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.enrichmentBindingId, coverage_kind: 'fact_evidence',
        covered_from: '2020-01-01T00:00:00Z', covered_through: bookedAt, established_at: '2026-12-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })
      // Deliberately NO crm fact_evidence coverage for this candidate.

      const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-01T00:00:00Z')
      expect(result.decision?.outcome).toBe('pending')
      expect(result.decision?.dedupe.outcome).toBe('duplicate')
      expect(result.candidate.status).toBe('pending')
      const accountFinality = result.decision?.factFinality?.find(f => f.factKey === 'account.id')
      expect(accountFinality?.status).toBe('incomplete')
      expect(accountFinality?.requiredSources).toEqual(['crm', 'enrichment'])
    } finally {
      await cleanupIsolatedJob(iso.jobId, iso.orgId)
    }
  }, 20000)

  it('fact-evidence finality with source precedence: lower-priority resolution + unproven higher-priority source -> pending; proving the higher-priority source silent later -> qualifies', async () => {
    const iso = await createIsolatedMultiSourceJob()
    try {
      // Real-Postgres discovery: SourceCoverage is a per-source-binding time
      // WINDOW, not scoped to a specific fact — a 'fact_evidence' coverage
      // row recorded for one fact's purposes (amount, referenceTime =
      // occurred_at) transparently also satisfies any OTHER fact on the
      // SAME source binding whose own required interval falls inside that
      // window. occurredAt/bookedAt are deliberately DISTINCT (booked_at
      // strictly after occurred_at) so crm's amount-oriented coverage
      // (covering only through occurredAt) does NOT also reach account.id's
      // own required interval (through the later booked_at) — otherwise
      // this test's "crm deliberately unproven for account.id" setup would
      // silently already be satisfied by the amount coverage, exactly the
      // bug this comment documents finding.
      const occurredAt = '2026-07-20T09:00:00Z'
      const bookedAt = '2026-07-21T09:00:00Z'
      const candidate = await createOrGetCandidate({
        job_id: iso.jobId, org_id: iso.orgId, unit_type: 'FINALITY_TEST_UNIT_MULTI_SOURCE', source_binding_id: iso.enrichmentBindingId,
        external_id: 'ext-precedence-1', booked_at: bookedAt, occurred_at: occurredAt,
      })
      await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.enrichmentBindingId,
        facts: { 'account.id': 'acct-precedence-only', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
      })
      // amount's own fact-evidence coverage (fact_evidence_source_roles.amount
      // stays crm-only on this rule) — covers crm ONLY through occurredAt,
      // deliberately short of booked_at (account.id's own reference_time).
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId, coverage_kind: 'fact_evidence',
        covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: '2026-08-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })
      // dedupe/rejection completeness — via crm, independent of the
      // account.id precedence question below.
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId, coverage_kind: 'candidate_discovery',
        covered_from: '2020-01-01T00:00:00Z', covered_through: '2026-08-01T00:00:00Z', established_at: '2026-08-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId, coverage_kind: 'rejection_source',
        covered_from: '2020-01-01T00:00:00Z', covered_through: '2026-08-01T00:00:00Z', established_at: '2026-08-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })
      // enrichment (the resolved winner) is itself covered through
      // booked_at — account.id's own reference_time.
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.enrichmentBindingId, coverage_kind: 'fact_evidence',
        covered_from: '2020-01-01T00:00:00Z', covered_through: bookedAt, established_at: '2026-08-01T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })
      // crm (higher priority) is NOT yet covered through booked_at for
      // account.id.

      const stillPending = await evaluateAndFinalizeCandidate(candidate.id, '2026-08-02T00:00:00Z')
      expect(stillPending.decision?.outcome).toBe('pending')
      const pendingAccountFinality = stillPending.decision?.factFinality?.find(f => f.factKey === 'account.id')
      expect(pendingAccountFinality?.status).toBe('incomplete')

      // Prove crm was searched and is silent for this candidate's reference
      // time — a fact_evidence coverage row over crm, established later.
      await recordSourceCoverage({
        job_id: iso.jobId, org_id: iso.orgId, source_binding_id: iso.crmBindingId, coverage_kind: 'fact_evidence',
        covered_from: '2020-01-01T00:00:00Z', covered_through: bookedAt, established_at: '2026-08-10T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
      })

      const nowQualifies = await evaluateAndFinalizeCandidate(candidate.id, '2026-08-11T00:00:00Z')
      expect(nowQualifies.decision?.outcome).toBe('qualified')
      expect(nowQualifies.candidate.status).toBe('qualified')
    } finally {
      await cleanupIsolatedJob(iso.jobId, iso.orgId)
    }
  }, 20000)

  it('fact_evidence coverage established_at gates historical visibility: invisible for an asOf before established_at, visible after', async () => {
    const occurredAt = '2026-11-05T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-established-gate', booked_at: occurredAt, occurred_at: occurredAt,
    })
    // amount below threshold -> criteria fast-rejects; only 'amount' fact
    // finality is material, isolating the established_at question cleanly.
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { amount: 3 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const establishedAt = '2026-11-10T00:00:00Z'
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: establishedAt, completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    // asOf BEFORE established_at — the coverage row exists in the DB but
    // must be invisible to this replay; the candidate stays pending and
    // nothing is persisted (a 'pending' outcome never calls the RPC).
    const beforeEstablished = await evaluateAndFinalizeCandidate(candidate.id, '2026-11-09T00:00:00Z')
    expect(beforeEstablished.decision?.outcome).toBe('pending')
    expect(beforeEstablished.candidate.status).toBe('pending')

    // asOf AFTER established_at — now visible; the SAME candidate resolves
    // for real and finalizes.
    const afterEstablished = await evaluateAndFinalizeCandidate(candidate.id, '2026-11-11T00:00:00Z')
    expect(afterEstablished.decision?.outcome).toBe('rejected')
    expect(afterEstablished.candidate.status).toBe('rejected')
    expect(afterEstablished.candidate.decided_at).not.toBeNull()
  })

  it('revoking fact_evidence coverage makes it invisible for any asOf after the revocation, without disturbing an already-terminal candidate that used it', async () => {
    const occurredAt = '2026-11-20T09:00:00Z'
    const candidateUsedBefore = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-revoke-visibility-before', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidateUsedBefore.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { amount: 3 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const coverageRow = await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: '2026-11-25T00:00:00Z', established_at: '2026-11-21T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    // Visible and usable before revocation — finalizes for real.
    const before = await evaluateAndFinalizeCandidate(candidateUsedBefore.id, '2026-11-22T00:00:00Z')
    expect(before.decision?.outcome).toBe('rejected')
    expect(before.candidate.status).toBe('rejected')

    await revokeSourceCoverage(coverageRow.id, '2026-11-23T00:00:00Z', 'reviewer:alice@example.com')

    // A second, distinct candidate — evaluated at an asOf AFTER the
    // revocation, with no replacement coverage — must find the same
    // (now-revoked) row invisible.
    const candidateAfterRevoke = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-revoke-visibility-after', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidateAfterRevoke.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { amount: 3 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    const after = await evaluateAndFinalizeCandidate(candidateAfterRevoke.id, '2026-11-24T00:00:00Z')
    expect(after.decision?.outcome).toBe('pending')
    expect(after.candidate.status).toBe('pending')

    // The already-terminal candidate from before the revocation is
    // untouched — re-finalizing returns it as-is (item J), proving the
    // revocation did not retroactively alter an already-decided outcome.
    const reread = await evaluateAndFinalizeCandidate(candidateUsedBefore.id, '2026-12-01T00:00:00Z')
    expect(reread.decision).toBeNull()
    expect(reread.candidate.status).toBe('rejected')
  })

  it('Stockholm business-day deadline correctly skips a public holiday AND the following weekend, using the configured cutoff local time with no hidden fallback', async () => {
    // Thursday 2026-12-24, 1 business day later: Fri 12-25 (Christmas Day,
    // holiday) -> Sat 12-26 (Boxing Day, holiday + weekend) -> Sun 12-27
    // (weekend) -> Mon 12-28 (first real business day). Exercises a
    // holiday immediately compounding into a weekend, not just a plain
    // Friday->Monday roll.
    const occurredAt = '2026-12-24T09:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-holiday-boundary', booked_at: occurredAt, occurred_at: occurredAt,
    })
    await recordCandidateEvidence({
      candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-holiday-boundary', amount: 25 }, occurred_at: occurredAt, recorded_at: occurredAt, recorded_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'candidate_discovery',
      covered_from: '2020-01-01T00:00:00Z', covered_through: '2026-12-29T00:00:00Z', established_at: '2026-12-29T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'rejection_source',
      covered_from: occurredAt, covered_through: '2026-12-29T00:00:00Z', established_at: '2026-12-29T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })
    await recordSourceCoverage({
      job_id: jobId, org_id: orgId, source_binding_id: crmBindingId, coverage_kind: 'fact_evidence',
      covered_from: '2020-01-01T00:00:00Z', covered_through: occurredAt, established_at: '2026-12-29T00:00:00Z', completeness_basis: 'connector_high_watermark', established_by: 'test-harness',
    })

    const result = await evaluateAndFinalizeCandidate(candidate.id, '2026-12-29T12:00:00Z')
    expect(result.decision?.outcome).toBe('qualified')
    expect(result.candidate.rejection_deadline).not.toBeNull()

    const expectedDeadline = computeBusinessDayDeadline({
      referenceTime: occurredAt, businessDays: 1, calendar: 'SE-stockholm', timezone: 'Europe/Stockholm',
      convention: 'end_of_business_day', businessDayEndLocalTime: '17:00:00',
    })
    // business_day_end_local_time '17:00:00' is interpreted INCLUSIVELY
    // through that configured second (computeBusinessDayDeadline appends
    // .999 ms to the configured HH:MM:SS, never rounds down to it) — so
    // Europe/Stockholm 17:00:00 on Mon 2026-12-28 (CET, UTC+1 in December)
    // is 16:00:00.999Z, not 16:00:00.000Z.
    expect(expectedDeadline).toBe('2026-12-28T16:00:00.999Z')
    expect(new Date(result.candidate.rejection_deadline!).toISOString()).toBe(expectedDeadline)
  })
})
