import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer, createBrowserClient } from './supabase'
import { createSourceBinding, resolveSourceBinding, getSourceBinding, ensureReviewerAttestationBinding } from './source-bindings-service'
import { registerSourceRole, ensureReviewerAttestationRole } from './source-roles-service'
import {
  createDraftQualificationRule, confirmQualificationRuleFieldAndPersist, activateQualificationRule, getQualificationRule,
} from './billable-unit-qualification-service'
import {
  createOrGetCandidate, getCandidateByExternalIdentity, recordCandidateEvidence, revokeCandidateEvidence,
  listEvidenceForCandidate,
} from './billable-unit-candidate-service'
import { isEvidenceActiveAsOf, resolveCandidateFact } from './billable-unit-candidate'
import type { FieldDecision, QualificationCondition } from './billable-unit-qualification'

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests for source_bindings/billable_unit_candidates/
// candidate_unit_evidence — real network calls against the real
// (post-migration) database, same pattern as
// lib/billable-unit-qualification-integration.test.ts.
//
// SKIPPED BY DEFAULT — PENDING. Migration
// 20260830000008_billable_unit_candidates_evidence.sql has not been
// applied to any database (including production) and has not been
// exercised against real Postgres. Written and type-checked only; kept
// opt-in per explicit instruction ("write them but keep them opt-in until
// we review the implementation. Do not apply 00008 yet."):
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/billable-unit-candidate-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

function unresolved<T>(): FieldDecision<T> {
  return { value: null, state: 'decision_required', provenance: null }
}

// A minimal, ready-able qualification rule — just enough structure to
// exercise candidate pinning/evidence validation; not the OS-2026-09
// fixture (that fixture's own round trip is 16B.1's concern).
function minimalRuleInput(jobId: string, orgId: string, unitType: string, effectiveFrom: string) {
  return {
    job_id: jobId, org_id: orgId, unit_type: unitType,
    fact_schema: {
      'account.id': { type: 'string' as const, reference_time: 'booked_at' as const },
      amount: { type: 'number' as const, reference_time: 'occurred_at' as const },
    },
    criteria: { value: { kind: 'condition' as const, condition: { field: 'amount', operator: 'gte' as const, value: 10 } }, state: 'clear_from_source' as const, provenance: null },
    qualified_contact_role: { base: unresolved<QualificationCondition>(), extensions: unresolved<string[]>(), attestation_fact_key: unresolved<string | null>() },
    dedupe_rule: { value: { key_fields: ['account.id'], lookback: { days: 30, unit: 'calendar' as const }, scope: [], discovery_coverage_role_keys: [] }, state: 'clear_from_source' as const, provenance: null },
    rejection_rule: { value: { valid_reasons: [], valid_channels: [], requires_timestamp: true, requires_identification: true, email_alone_valid: false, channel_exception: null, late_rejection_behavior: 'ignored_for_initial_qualification' as const, reason_predicates: {} }, state: 'clear_from_source' as const, provenance: null },
    rejection_window: { value: { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm', reference_time: 'occurred_at' as const }, state: 'clear_from_source' as const, provenance: null },
    deadline_convention: { value: 'end_of_business_day' as const, state: 'decision_required' as const, provenance: null },
    business_day_end_local_time: unresolved<string | null>(),
    attribution_basis: { value: 'occurred_at' as const, state: 'verdix_recommends' as const, provenance: null },
    evidence_precedence: {},
    // 'amount' backs both criteria and qualified_contact_role.base (once
    // confirmed with its override below); 'account.id' backs dedupe_rule.
    // key_fields — every fact an executable path references needs an
    // entry, exactly like evidence_precedence.
    fact_evidence_source_roles: {
      amount: unresolved<string[]>(),
      'account.id': unresolved<string[]>(),
    },
    field_sources: {},
    effective_from: effectiveFrom,
  }
}

async function confirmAllMinimalFields(ruleId: string) {
  await confirmQualificationRuleFieldAndPersist(ruleId, 'criteria')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'qualified_contact_role.base', { field: 'amount', operator: 'gte', value: 0 })
  await confirmQualificationRuleFieldAndPersist(ruleId, 'qualified_contact_role.attestation_fact_key', null)
  await confirmQualificationRuleFieldAndPersist(ruleId, 'dedupe_rule')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'rejection_rule')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'rejection_window')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'deadline_convention', 'end_of_business_day')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'business_day_end_local_time', '17:00:00')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'fact_evidence_source_roles.amount', ['crm'])
  await confirmQualificationRuleFieldAndPersist(ruleId, 'fact_evidence_source_roles.account.id', ['crm'])
  return confirmQualificationRuleFieldAndPersist(ruleId, 'attribution_basis')
}

describeIf('source_bindings / billable_unit_candidates / candidate_unit_evidence — real Postgres round trip + RLS', () => {
  let orgId: string
  let jobId: string
  let crmRoleId: string
  let ruleId: string

  beforeAll(async () => {
    const slug = `buq-cand-integration-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'buq-cand-integration-test-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'buq-cand-integration-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id

    const crmRole = await registerSourceRole(jobId, orgId, 'crm')
    crmRoleId = crmRole.id
    await ensureReviewerAttestationRole(jobId, orgId)

    const draft = await createDraftQualificationRule(minimalRuleInput(jobId, orgId, 'CAND_TEST_UNIT', '2026-08-25T00:00:00Z'))
    await confirmAllMinimalFields(draft.id)
    const active = await activateQualificationRule(draft.id)
    ruleId = active.id
  })

  afterAll(async () => {
    await supabaseServer.from('candidate_unit_evidence').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_candidates').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', jobId)
    await supabaseServer.from('source_bindings').delete().eq('job_id', jobId)
    await supabaseServer.from('source_roles').delete().eq('job_id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  // Real-Postgres discovery (this turn): `source_bindings_one_active_per_
  // role_idx` is enforced exactly as designed — at most one active
  // binding per role. Many tests below only need "some real binding," not
  // specifically `crmRoleId`'s own lifecycle, so reusing the shared
  // `crmRoleId` with the same hardcoded effective_from across many
  // independent tests collides with itself (and depends on test
  // execution order) the moment more than one such test runs in the same
  // pass. This helper registers a genuinely fresh, uniquely-named role
  // per call so every test gets its own collision-free, order-independent
  // binding — never touches crmRoleId, never assumes anything about
  // prior test state.
  let scratchRoleCounter = 0
  async function freshCrmBinding(label: string) {
    scratchRoleCounter += 1
    const role = await registerSourceRole(jobId, orgId, `crm_scratch_${scratchRoleCounter}`)
    return createSourceBinding(role.id, jobId, orgId, label, '2026-08-25T00:00:00Z')
  }

  describe('source binding lifecycle', () => {
    it('creates a first binding for a role, then atomically supersedes it — history preserved, at most one active at a time', async () => {
      const b1 = await createSourceBinding(crmRoleId, jobId, orgId, 'Salesforce sandbox A', '2026-08-25T00:00:00Z')
      expect(b1.status).toBe('active')
      expect(b1.supersedes_binding_id).toBeNull()

      const b2 = await createSourceBinding(crmRoleId, jobId, orgId, 'Salesforce prod', '2026-09-15T00:00:00Z')
      expect(b2.status).toBe('active')
      expect(b2.supersedes_binding_id).toBe(b1.id)

      const rereadB1 = await getSourceBinding(b1.id)
      expect(rereadB1?.status).toBe('superseded')
      expect(new Date(rereadB1!.effective_to!).toISOString()).toBe('2026-09-15T00:00:00.000Z')
    })

    it('rejects a new binding whose effective_from is not strictly after the current active binding\'s — no overlapping periods', async () => {
      const role = await registerSourceRole(jobId, orgId, 'calendar')
      await createSourceBinding(role.id, jobId, orgId, 'Google Calendar', '2026-08-25T00:00:00Z')
      await expect(createSourceBinding(role.id, jobId, orgId, 'Outlook Calendar', '2026-08-25T00:00:00Z'))
        .rejects.toThrow(/must be strictly after/)
    })

    it('resolveSourceBinding resolves the HISTORICALLY correct binding, never the currently-active one, for a past referenceTime', async () => {
      const role = await registerSourceRole(jobId, orgId, 'conferencing')
      const old = await createSourceBinding(role.id, jobId, orgId, 'Zoom (legacy)', '2026-08-25T00:00:00Z')
      const current = await createSourceBinding(role.id, jobId, orgId, 'Zoom (current)', '2026-09-15T00:00:00Z')

      const historical = await resolveSourceBinding({ id: role.id, job_id: jobId, org_id: orgId }, '2026-09-01T00:00:00Z')
      expect(historical.id).toBe(old.id)

      const present = await resolveSourceBinding({ id: role.id, job_id: jobId, org_id: orgId }, '2026-10-01T00:00:00Z')
      expect(present.id).toBe(current.id)
    })

    it('exact boundary: the predecessor resolves immediately before T, the successor resolves exactly AT T — no overlap, no gap', async () => {
      const role = await registerSourceRole(jobId, orgId, 'boundary_test_role')
      const T = '2026-09-15T00:00:00.000Z'
      const a = await createSourceBinding(role.id, jobId, orgId, 'Boundary A', '2026-08-25T00:00:00Z')
      const b = await createSourceBinding(role.id, jobId, orgId, 'Boundary B', T)

      const rereadA = await getSourceBinding(a.id)
      expect(rereadA?.status).toBe('superseded')
      expect(new Date(rereadA!.effective_to!).toISOString()).toBe(T)
      expect(new Date(b.effective_from).toISOString()).toBe(T)
      expect(b.status).toBe('active')

      const justBeforeT = new Date(new Date(T).getTime() - 1).toISOString() // T - 1ms
      const resolvedJustBefore = await resolveSourceBinding({ id: role.id, job_id: jobId, org_id: orgId }, justBeforeT)
      expect(resolvedJustBefore.id).toBe(a.id)

      const resolvedAtT = await resolveSourceBinding({ id: role.id, job_id: jobId, org_id: orgId }, T)
      expect(resolvedAtT.id).toBe(b.id)

      // No gap: every instant has exactly one resolvable binding across
      // the boundary — proven directly by the two assertions above
      // together (both resolve, to different bindings, one tick apart).
      // No overlap: resolveSourceBindingFromCandidates itself fails
      // closed ('ambiguous') if more than one binding matches the same
      // instant — a clean single resolution on both sides IS the
      // no-overlap proof.
    })

    it('create_source_binding rejects a source_role/job_id mismatch — never silently creates a cross-job binding', async () => {
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'other-job', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        await expect(createSourceBinding(crmRoleId, otherJob!.id, orgId, 'Wrong job', '2026-08-25T00:00:00Z'))
          .rejects.toThrow()
      } finally {
        // Real-Postgres discovery (this turn): jobs.org_id does not
        // cascade-delete, so a scratch job left behind by a thrown
        // assertion blocks the SHARED org's own afterAll deletion,
        // leaking the entire scratch org for the run — try/finally makes
        // this cleanup unconditional, matching afterAll's own guarantee.
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
      }
    })
  })

  describe('DB ownership consistency chain (pre-commit hardening audit — SourceRole -> SourceBinding -> Candidate -> Evidence)', () => {
    it('the database itself (not just create_source_binding) rejects a source_bindings row whose job_id does not match its source_role — a direct raw insert bypassing the RPC', async () => {
      // A FRESH role, not crmRoleId — crmRoleId may already have an active
      // binding from other tests by now, which would hit
      // source_bindings_one_active_per_role_idx (23505) before ever
      // reaching the ownership FK check this test actually targets (23503).
      const freshRole = await registerSourceRole(jobId, orgId, 'raw_fk_mismatch_test_role')
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'other-job-raw-fk', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        const { error } = await supabaseServer.from('source_bindings').insert({
          source_role_id: freshRole.id, job_id: otherJob!.id, org_id: orgId, // freshRole genuinely belongs to `jobId`, not otherJob
          label: 'raw insert test', effective_from: '2026-08-25T00:00:00Z',
        })
        expect(error).toBeTruthy()
        expect((error as { code?: string })?.code).toBe('23503')
      } finally {
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
      }
    })

    it('the database rejects a billable_unit_candidates row whose job_id does not match its source_binding — a direct raw insert bypassing the service layer', async () => {
      const binding = await freshCrmBinding('CRM for candidate ownership FK')
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'other-job-cand-fk', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        const { error } = await supabaseServer.from('billable_unit_candidates').insert({
          job_id: otherJob!.id, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
          source_binding_id: binding.id, external_id: 'ext-raw-cand-ownership', // binding genuinely belongs to `jobId`, not otherJob
          attribution_at: '2026-09-05T00:00:00Z', qualification_rule_id: ruleId, qualification_rule_version: 1,
        })
        expect(error).toBeTruthy()
        expect((error as { code?: string })?.code).toBe('23503')
      } finally {
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
      }
    })

    it('the database rejects a candidate_unit_evidence row whose job_id does not match its candidate', async () => {
      const binding = await freshCrmBinding('CRM for evidence-candidate ownership FK')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-raw-evidence-cand-ownership',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'other-job-ev-cand-fk', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        const { error } = await supabaseServer.from('candidate_unit_evidence').insert({
          candidate_id: candidate.id, job_id: otherJob!.id, org_id: orgId, // candidate genuinely belongs to `jobId`, not otherJob
          source_binding_id: binding.id, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
        })
        expect(error).toBeTruthy()
        expect((error as { code?: string })?.code).toBe('23503')
      } finally {
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
      }
    })

    it('the database rejects a candidate_unit_evidence row whose job_id does not match its source_binding', async () => {
      const binding = await freshCrmBinding('CRM for evidence-binding ownership FK')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-raw-evidence-binding-ownership',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const { data: otherOrg } = await supabaseServer.from('organizations').insert({ name: 'other-org-ev-binding-fk', slug: `other-org-ev-binding-fk-${Date.now()}` }).select('id').single()
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: otherOrg!.id, name: 'other-job-ev-binding-fk', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        const { error } = await supabaseServer.from('candidate_unit_evidence').insert({
          candidate_id: candidate.id, job_id: otherJob!.id, org_id: otherOrg!.id, // binding genuinely belongs to `jobId`/`orgId`, not otherJob/otherOrg
          source_binding_id: binding.id, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
        })
        expect(error).toBeTruthy()
        expect((error as { code?: string })?.code).toBe('23503')
      } finally {
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
        await supabaseServer.from('organizations').delete().eq('id', otherOrg!.id)
      }
    })
  })

  describe('SourceBinding history immutability (DB trigger — pre-commit hardening audit)', () => {
    it('rejects a direct UPDATE of source_role_id, job_id, org_id, effective_from, or supersedes_binding_id', async () => {
      const role = await registerSourceRole(jobId, orgId, 'source_binding_immutability_test')
      const binding = await createSourceBinding(role.id, jobId, orgId, 'Immutability test binding', '2026-08-25T00:00:00Z')

      const { error: effFromError } = await supabaseServer.from('source_bindings').update({ effective_from: '2020-01-01T00:00:00Z' }).eq('id', binding.id)
      expect(effFromError).toBeTruthy()
      expect(effFromError?.message).toMatch(/immutable/)

      const otherRole = await registerSourceRole(jobId, orgId, 'source_binding_immutability_other_role')
      const { error: roleError } = await supabaseServer.from('source_bindings').update({ source_role_id: otherRole.id }).eq('id', binding.id)
      expect(roleError).toBeTruthy()
      expect(roleError?.message).toMatch(/immutable/)

      const reread = await getSourceBinding(binding.id)
      expect(new Date(reread!.effective_from).toISOString()).toBe('2026-08-25T00:00:00.000Z')
      expect(reread?.source_role_id).toBe(role.id)
    })

    it('allows a direct UPDATE of label — pure display metadata, never read by evidence resolution or audit correctness', async () => {
      const role = await registerSourceRole(jobId, orgId, 'source_binding_label_test')
      const binding = await createSourceBinding(role.id, jobId, orgId, 'Original label', '2026-08-25T00:00:00Z')
      const { error } = await supabaseServer.from('source_bindings').update({ label: 'Renamed label' }).eq('id', binding.id)
      expect(error).toBeNull()
      const reread = await getSourceBinding(binding.id)
      expect(reread?.label).toBe('Renamed label')
    })

    it('still allows the status/effective_to transition create_source_binding\'s own supersession performs', async () => {
      const role = await registerSourceRole(jobId, orgId, 'source_binding_supersession_trigger_test')
      const b1 = await createSourceBinding(role.id, jobId, orgId, 'First', '2026-08-25T00:00:00Z')
      const b2 = await createSourceBinding(role.id, jobId, orgId, 'Second', '2026-09-15T00:00:00Z')
      const rereadB1 = await getSourceBinding(b1.id)
      expect(rereadB1?.status).toBe('superseded')
      expect(new Date(rereadB1!.effective_to!).toISOString()).toBe('2026-09-15T00:00:00.000Z')
      expect(b2.status).toBe('active')
    })
  })

  describe('candidate identity/idempotency + rule-version pinning', () => {
    it('createOrGetCandidate is idempotent — repeated calls with the same (job_id, source_binding_id, external_id) return the SAME row', async () => {
      const binding = await freshCrmBinding('CRM for candidates')
      const first = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-idempotent-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const second = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-idempotent-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      expect(second.id).toBe(first.id)

      const reread = await getCandidateByExternalIdentity(jobId, binding.id, 'ext-idempotent-1')
      expect(reread?.id).toBe(first.id)
    })

    it('pins qualification_rule_id/qualification_rule_version at creation, from the real active rule', async () => {
      const binding = await freshCrmBinding('CRM for pinning')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-pin-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      expect(candidate.qualification_rule_id).toBe(ruleId)
      expect(candidate.qualification_rule_version).toBe(1)
      expect(candidate.status).toBe('pending')
      expect(candidate.decided_at).toBeNull()
    })

    it('the database-level unique index blocks a duplicate identity even if the service-layer idempotency check were bypassed', async () => {
      const binding = await freshCrmBinding('CRM for uniqueness')
      await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-unique-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const { error } = await supabaseServer.from('billable_unit_candidates').insert({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-unique-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z', attribution_at: '2026-09-05T00:00:00Z',
        qualification_rule_id: ruleId, qualification_rule_version: 1,
      })
      expect(error).toBeTruthy()
      expect((error as { code?: string })?.code).toBe('23505')
    })
  })

  describe('candidate evidence — validation, append/revoke discipline', () => {
    it('records evidence whose facts validate against the pinned rule\'s fact_schema', async () => {
      const binding = await freshCrmBinding('CRM for evidence')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-evidence-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 42 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })
      expect(evidence.status).toBe('active')

      const listed = await listEvidenceForCandidate(candidate.id)
      expect(listed.map(e => e.id)).toContain(evidence.id)
    })

    it('rejects facts with an undeclared key against the pinned rule\'s real fact_schema', async () => {
      const binding = await freshCrmBinding('CRM for bad evidence')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-evidence-bad',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      await expect(recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { not_a_declared_fact: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })).rejects.toThrow(/undeclared/)
    })

    it('rejects evidence whose source_binding belongs to another job/org', async () => {
      const { data: otherOrg } = await supabaseServer.from('organizations').insert({ name: 'other-org', slug: `other-org-${Date.now()}` }).select('id').single()
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: otherOrg!.id, name: 'other-job-2', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      const otherRole = await registerSourceRole(otherJob!.id, otherOrg!.id, 'crm')
      const otherBinding = await createSourceBinding(otherRole.id, otherJob!.id, otherOrg!.id, 'Other org CRM', '2026-08-25T00:00:00Z')

      try {
        const binding = await freshCrmBinding('CRM for cross-org test')
        const candidate = await createOrGetCandidate({
          job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
          source_binding_id: binding.id, external_id: 'ext-cross-org',
          booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
        })

        await expect(recordCandidateEvidence({
          candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: otherBinding.id,
          facts: { amount: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
        })).rejects.toThrow(/belongs to job/)
      } finally {
        await supabaseServer.from('source_bindings').delete().eq('job_id', otherJob!.id)
        await supabaseServer.from('source_roles').delete().eq('job_id', otherJob!.id)
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
        await supabaseServer.from('organizations').delete().eq('id', otherOrg!.id)
      }
    })

    it('historical asOf replay, proven directly against Postgres: visible before revocation, invisible after, and a later replacement row never rewrites the earlier historical result', async () => {
      const binding = await freshCrmBinding('CRM for asOf replay')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-asof-replay',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })

      const t1 = '2026-09-05T00:00:00Z' // recorded
      const t2 = '2026-09-06T00:00:00Z' // asOf between recording and revocation
      const t3 = '2026-09-10T00:00:00Z' // revoked
      const t4 = '2026-09-11T00:00:00Z' // asOf after revocation

      const original = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 42 }, occurred_at: t1, recorded_at: t1, recorded_by: 'integration-test',
      })
      await revokeCandidateEvidence(original.id, t3, 'reviewer-1')

      // Real row, refetched from Postgres — not a locally-held object —
      // fed through the same pure isEvidenceActiveAsOf used everywhere else.
      const reread = (await listEvidenceForCandidate(candidate.id)).find(e => e.id === original.id)!
      expect(isEvidenceActiveAsOf(reread, t2)).toBe(true)  // visible before revocation
      expect(isEvidenceActiveAsOf(reread, t4)).toBe(false) // invisible after revocation

      // A later REPLACEMENT row (the append/revoke correction pattern) —
      // recorded well after t2 — must not change what asOf t2 saw.
      const t5 = '2026-09-12T00:00:00Z'
      await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 99 }, occurred_at: t1, recorded_at: t5, recorded_by: 'reviewer-1',
      })

      const allEvidence = await listEvidenceForCandidate(candidate.id)
      const roleKeys = new Map([[binding.id, 'crm']])
      const rule = await getQualificationRule(ruleId)

      const historicalResolution = resolveCandidateFact({
        candidate, rule: rule!, factKey: 'amount',
        evidence: allEvidence, sourceBindingRoleKeys: roleKeys, asOf: t2,
      })
      // asOf t2: only the ORIGINAL row (value 42) was recorded and not
      // yet revoked — the replacement (recorded at t5, long after t2)
      // must be completely invisible to this replay.
      expect(historicalResolution).toMatchObject({ status: 'resolved', value: 42 })
    })

    it('revoke_candidate_evidence is atomic and idempotent-safe: a second revoke attempt on an already-revoked row is a clean no-op failure, never a clobber', async () => {
      const binding = await freshCrmBinding('CRM for revoke')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-revoke-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 42 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })

      const revoked = await revokeCandidateEvidence(evidence.id, '2026-09-10T00:00:00Z', 'reviewer-1')
      expect(revoked.status).toBe('revoked')
      expect(new Date(revoked.revoked_at!).toISOString()).toBe('2026-09-10T00:00:00.000Z')

      await expect(revokeCandidateEvidence(evidence.id, '2026-09-20T00:00:00Z', 'reviewer-2'))
        .rejects.toThrow(/already be revoked/)

      // The FIRST revocation's revoked_at/revoked_by must survive
      // untouched — this is exactly what asOf replay depends on.
      const { data: reread } = await supabaseServer.from('candidate_unit_evidence').select('*').eq('id', evidence.id).single()
      expect(new Date(reread!.revoked_at).toISOString()).toBe('2026-09-10T00:00:00.000Z')
      expect(reread!.revoked_by).toBe('reviewer-1')
    })

    it('revoke_candidate_evidence rejects a revocation that would historically predate recorded_at', async () => {
      const binding = await freshCrmBinding('CRM for temporal guard')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-temporal-guard',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })
      // revoked_at (Sep 1) is BEFORE recorded_at (Sep 5) — a revocation
      // cannot historically predate the evidence becoming known to Verdix.
      await expect(revokeCandidateEvidence(evidence.id, '2026-09-01T00:00:00Z', 'reviewer-1')).rejects.toThrow()
    })
  })

  describe('candidate identity/pin immutability (DB trigger — pre-commit hardening audit)', () => {
    it('a direct UPDATE of any identity/pin field is rejected by the database, independent of there being no service-layer update path', async () => {
      const binding = await freshCrmBinding('CRM for immutability')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-immutable-1',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })

      const { error: externalIdError } = await supabaseServer.from('billable_unit_candidates').update({ external_id: 'rewritten' }).eq('id', candidate.id)
      expect(externalIdError).toBeTruthy()
      expect(externalIdError?.message).toMatch(/immutable/)

      const { error: attributionError } = await supabaseServer.from('billable_unit_candidates').update({ attribution_at: '2030-01-01T00:00:00Z' }).eq('id', candidate.id)
      expect(attributionError).toBeTruthy()
      expect(attributionError?.message).toMatch(/immutable/)

      const { error: ruleError } = await supabaseServer.from('billable_unit_candidates').update({ qualification_rule_version: 999 }).eq('id', candidate.id)
      expect(ruleError).toBeTruthy()

      // Untouched — the trigger rolled back every attempted write.
      const reread = await getCandidateByExternalIdentity(jobId, binding.id, 'ext-immutable-1')
      expect(reread?.external_identity.external_id).toBe('ext-immutable-1')
      expect(new Date(reread!.attribution_at).toISOString()).toBe('2026-09-05T00:00:00.000Z')
      expect(reread?.qualification_rule_version).toBe(1)
    })
  })

  describe('pinned-rule composite FK consistency (DB-level, not solely service-layer)', () => {
    it('rejects a candidate row pinned to a real rule id but the WRONG version — version cannot drift from the rule\'s actual version', async () => {
      const binding = await freshCrmBinding('CRM for version drift')
      const { error } = await supabaseServer.from('billable_unit_candidates').insert({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-version-drift',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z', attribution_at: '2026-09-05T00:00:00Z',
        qualification_rule_id: ruleId, qualification_rule_version: 999, // real rule id, fabricated version
      })
      expect(error).toBeTruthy()
      expect((error as { code?: string })?.code).toBe('23503')
    })

    it('rejects a candidate row whose unit_type does not match the pinned rule\'s own unit_type', async () => {
      const binding = await freshCrmBinding('CRM for unit_type mismatch')
      const { error } = await supabaseServer.from('billable_unit_candidates').insert({
        job_id: jobId, org_id: orgId, unit_type: 'SOME_OTHER_UNIT_TYPE', // real rule is CAND_TEST_UNIT
        source_binding_id: binding.id, external_id: 'ext-unit-type-mismatch',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z', attribution_at: '2026-09-05T00:00:00Z',
        qualification_rule_id: ruleId, qualification_rule_version: 1,
      })
      expect(error).toBeTruthy()
      expect((error as { code?: string })?.code).toBe('23503')
    })

    it('rejects a candidate row belonging to a different job than the one that owns the pinned rule', async () => {
      const { data: otherJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'other-job-fk-test', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      try {
        const otherRole = await registerSourceRole(otherJob!.id, orgId, 'crm')
        const otherBinding = await createSourceBinding(otherRole.id, otherJob!.id, orgId, 'CRM for other job', '2026-08-25T00:00:00Z')

        const { error } = await supabaseServer.from('billable_unit_candidates').insert({
          job_id: otherJob!.id, org_id: orgId, unit_type: 'CAND_TEST_UNIT', // real rule belongs to `jobId`, not otherJob
          source_binding_id: otherBinding.id, external_id: 'ext-cross-job-pin',
          booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z', attribution_at: '2026-09-05T00:00:00Z',
          qualification_rule_id: ruleId, qualification_rule_version: 1,
        })
        expect(error).toBeTruthy()
        expect((error as { code?: string })?.code).toBe('23503')
      } finally {
        await supabaseServer.from('source_bindings').delete().eq('job_id', otherJob!.id)
        await supabaseServer.from('source_roles').delete().eq('job_id', otherJob!.id)
        await supabaseServer.from('jobs').delete().eq('id', otherJob!.id)
      }
    })
  })

  describe('evidence append-only (DB trigger — pre-commit hardening audit)', () => {
    it('a direct UPDATE of any substantive evidence field is rejected by the database', async () => {
      const binding = await freshCrmBinding('CRM for evidence immutability')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-evidence-immutable',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })

      const { error: factsError } = await supabaseServer.from('candidate_unit_evidence').update({ facts: { amount: 999 } }).eq('id', evidence.id)
      expect(factsError).toBeTruthy()
      expect(factsError?.message).toMatch(/append-only/)

      const { error: recordedByError } = await supabaseServer.from('candidate_unit_evidence').update({ recorded_by: 'someone-else' }).eq('id', evidence.id)
      expect(recordedByError).toBeTruthy()

      const listed = await listEvidenceForCandidate(candidate.id)
      const reread = listed.find(e => e.id === evidence.id)
      expect(reread?.facts).toEqual({ amount: 1 })
      expect(reread?.recorded_by).toBe('integration-test')
    })

    it('the trigger independently blocks re-revoking an already-revoked row even via a direct UPDATE bypassing the RPC', async () => {
      const binding = await freshCrmBinding('CRM for double-revoke trigger')
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: binding.id, external_id: 'ext-double-revoke-trigger',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: binding.id,
        facts: { amount: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'integration-test',
      })
      await revokeCandidateEvidence(evidence.id, '2026-09-10T00:00:00Z', 'reviewer-1')

      const { error } = await supabaseServer.from('candidate_unit_evidence').update({ revoked_by: 'reviewer-2' }).eq('id', evidence.id)
      expect(error).toBeTruthy()
      expect(error?.message).toMatch(/already revoked/)
    })
  })

  describe('reviewer-attestation SourceBinding lifecycle', () => {
    it('ensureReviewerAttestationBinding creates exactly one real binding for the reserved role, idempotently', async () => {
      const first = await ensureReviewerAttestationBinding(jobId, orgId, '2026-08-25T00:00:00Z')
      expect(first.status).toBe('active')
      const role = await ensureReviewerAttestationRole(jobId, orgId)
      expect(first.source_role_id).toBe(role.id)

      const second = await ensureReviewerAttestationBinding(jobId, orgId, '2026-09-01T00:00:00Z')
      expect(second.id).toBe(first.id) // idempotent — no second binding created

      // Reviewer evidence is ordinary CandidateUnitEvidence through this
      // real binding — no null-source exception anywhere.
      const candidate = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: first.id, external_id: 'ext-reviewer-evidence',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const evidence = await recordCandidateEvidence({
        candidate_id: candidate.id, job_id: jobId, org_id: orgId, source_binding_id: first.id,
        facts: { amount: 1 }, occurred_at: '2026-09-05T00:00:00Z', recorded_at: '2026-09-05T00:00:00Z', recorded_by: 'reviewer-1',
      })
      expect(evidence.source_binding_id).toBe(first.id)
    })

    it('two concurrent first-ever calls for the same job resolve to exactly one active reviewer_attestation SourceRole and exactly one active SourceBinding — the race is handled, never surfaced as an error', async () => {
      // A FRESH job with no reviewer_attestation role/binding yet at all
      // — the real race only exists on each job's genuinely-first call.
      const { data: freshJob } = await supabaseServer.from('jobs').insert({ org_id: orgId, name: 'fresh-job-attestation-race', module: 'AUTO_CONFIGURE', status: 'PENDING' }).select('id').single()
      const freshJobId = freshJob!.id

      try {
        const [a, b] = await Promise.all([
          ensureReviewerAttestationBinding(freshJobId, orgId, '2026-08-25T00:00:00Z'),
          ensureReviewerAttestationBinding(freshJobId, orgId, '2026-08-25T00:00:00Z'),
        ])
        expect(a.id).toBe(b.id)

        const { data: roles } = await supabaseServer.from('source_roles').select('*').eq('job_id', freshJobId).eq('role_key', 'reviewer_attestation')
        expect(roles).toHaveLength(1)

        const { data: bindings } = await supabaseServer.from('source_bindings').select('*').eq('job_id', freshJobId).eq('status', 'active')
        expect(bindings).toHaveLength(1)
        expect(bindings![0].id).toBe(a.id)
      } finally {
        await supabaseServer.from('source_bindings').delete().eq('job_id', freshJobId)
        await supabaseServer.from('source_roles').delete().eq('job_id', freshJobId)
        await supabaseServer.from('jobs').delete().eq('id', freshJobId)
      }
    })
  })

  describe('external-ID namespace invariant (pre-commit hardening audit)', () => {
    it('the SAME external_id under two DIFFERENT source bindings is NOT deduplicated — proving why a binding must only be created for a genuine re-platform, never routine credential rotation', async () => {
      const bindingA = await freshCrmBinding('CRM namespace A')
      const roleForB = await registerSourceRole(jobId, orgId, 'crm_namespace_test')
      const bindingB = await createSourceBinding(roleForB.id, jobId, orgId, 'CRM namespace B', '2026-08-25T00:00:00Z')

      const candidateUnderA = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: bindingA.id, external_id: 'evt_shared_123',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })
      const candidateUnderB = await createOrGetCandidate({
        job_id: jobId, org_id: orgId, unit_type: 'CAND_TEST_UNIT',
        source_binding_id: bindingB.id, external_id: 'evt_shared_123',
        booked_at: '2026-09-01T00:00:00Z', occurred_at: '2026-09-05T00:00:00Z',
      })

      // Same external_id, different binding -> different identity
      // namespace -> two DISTINCT candidates. This is the documented,
      // intentional consequence — it is exactly why creating a new
      // binding must be reserved for a genuine re-platform.
      expect(candidateUnderA.id).not.toBe(candidateUnderB.id)
    })
  })
})

describeIf('source_bindings / billable_unit_candidates / candidate_unit_evidence — anon key must not reach them', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows on any of the three new tables', async () => {
    for (const table of ['source_bindings', 'billable_unit_candidates', 'candidate_unit_evidence']) {
      const { data, error } = await anon.from(table).select('id').limit(1)
      if (!error) expect(data ?? []).toHaveLength(0)
    }
  })

  it('INSERT via anon key is rejected on all three new tables', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    const { error: e1 } = await anon.from('source_bindings').insert({ source_role_id: nil, job_id: nil, org_id: nil, label: 'x', effective_from: '2026-01-01T00:00:00Z' })
    expect(e1).toBeTruthy()
    const { error: e2 } = await anon.from('billable_unit_candidates').insert({ job_id: nil, org_id: nil, unit_type: 'X', source_binding_id: nil, external_id: 'x', attribution_at: '2026-01-01T00:00:00Z', qualification_rule_id: nil, qualification_rule_version: 1 })
    expect(e2).toBeTruthy()
    const { error: e3 } = await anon.from('candidate_unit_evidence').insert({ candidate_id: nil, job_id: nil, org_id: nil, source_binding_id: nil, occurred_at: '2026-01-01T00:00:00Z', recorded_at: '2026-01-01T00:00:00Z', recorded_by: 'x' })
    expect(e3).toBeTruthy()
  })

  it('both new RPCs (service_role only) are rejected for the anon key with the CORRECT argument shape — a real privilege rejection, not a signature mismatch', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    const { error: e1 } = await anon.rpc('create_source_binding', {
      p_source_role_id: nil, p_job_id: nil, p_org_id: nil, p_label: 'x', p_effective_from: '2026-01-01T00:00:00Z',
    })
    expect(e1).toBeTruthy()
    expect(e1?.code).toBe('42501')

    const { error: e2 } = await anon.rpc('revoke_candidate_evidence', {
      p_evidence_id: nil, p_revoked_at: '2026-01-01T00:00:00Z', p_revoked_by: 'x',
    })
    expect(e2).toBeTruthy()
    expect(e2?.code).toBe('42501')
  })

  it('set_qualification_rule_contact_role_field (widened by 00008 via CREATE OR REPLACE — grants unchanged, not reissued) still rejects anon with a real 42501, using the CURRENT attestation_fact_key-capable signature', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    const { error } = await anon.rpc('set_qualification_rule_contact_role_field', {
      p_rule_id: nil, p_field: 'attestation_fact_key', p_value: 'x',
    })
    expect(error).toBeTruthy()
    expect(error?.code).toBe('42501')
  })
})
