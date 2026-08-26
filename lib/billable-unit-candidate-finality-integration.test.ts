import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer, createBrowserClient } from './supabase'
import { createSourceBinding } from './source-bindings-service'
import { registerSourceRole } from './source-roles-service'
import { createDraftQualificationRule, confirmQualificationRuleFieldAndPersist, activateQualificationRule } from './billable-unit-qualification-service'
import { createOrGetCandidate, recordCandidateEvidence, getCandidate } from './billable-unit-candidate-service'
import { recordSourceCoverage, revokeSourceCoverage } from './source-coverage-service'
import { evaluateAndFinalizeCandidate } from './billable-unit-candidate-finality-service'
import { OBJECTION_REASON_FACT_KEY, OBJECTION_CHANNEL_FACT_KEY, OBJECTION_TIMESTAMP_FACT_KEY, OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY } from './billable-unit-candidate-finality'

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

    const draft = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT', '2026-08-25T00:00:00Z'))
    await confirmQualificationRuleFieldAndPersist(draft.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft.id, 'qualified_contact_role.base', { field: 'amount', operator: 'gte', value: 0 })
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
    const draft2 = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'FINALITY_TEST_UNIT_BOOKED_DEADLINE', '2026-08-25T00:00:00Z'))
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'criteria')
    await confirmQualificationRuleFieldAndPersist(draft2.id, 'qualified_contact_role.base', { field: 'amount', operator: 'gte', value: 0 })
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
    expect(error?.message).toMatch(/append-only/)
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
    // Uses the DEFAULT 'FINALITY_TEST_UNIT' rule (deadline anchored to
    // occurred_at) — account.id is booked_at-referenced, so booked_at
    // stays present on both candidates (dedupe can resolve and match)
    // while occurred_at is null on the current candidate (deadline
    // genuinely unresolvable) — the DB-level mirror of the pure-evaluator
    // "conclusive duplicate + unresolved deadline" regression.
    const priorBookedAt = '2026-09-05T00:00:00Z'
    const prior = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
      external_id: 'ext-null-deadline-dup-prior', booked_at: priorBookedAt, occurred_at: priorBookedAt,
    })
    await recordCandidateEvidence({
      candidate_id: prior.id, job_id: jobId, org_id: orgId, source_binding_id: crmBindingId,
      facts: { 'account.id': 'acct-null-deadline-dup', amount: 25 }, occurred_at: priorBookedAt, recorded_at: priorBookedAt, recorded_by: 'test-harness',
    })

    const candidateBookedAt = '2026-10-05T00:00:00Z'
    const candidate = await createOrGetCandidate({
      job_id: jobId, org_id: orgId, unit_type: 'FINALITY_TEST_UNIT', source_binding_id: crmBindingId,
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
})
