import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer, createBrowserClient } from './supabase'
import {
  createDraftQualificationRule, getQualificationRule, confirmQualificationRuleFieldAndPersist,
  activateQualificationRule, createSuccessorDraft, activateQualificationRuleSuccessor,
} from './billable-unit-qualification-service'
import { registerSourceRole, ensureReviewerAttestationRole, listSourceRolesForJob } from './source-roles-service'
import { isQualificationRuleReady } from './billable-unit-qualification'
import type { FieldDecision, BillableUnitQualificationRule } from './billable-unit-qualification'

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests for billable_unit_qualification_rules/source_roles —
// real network calls against the real (post-migration) database, same
// pattern as lib/organization-rulebook-rls.test.ts /
// lib/proposal-cache-atomicity.test.ts. Self-contained: creates its own
// scratch org/job/rows and cleans up regardless of pass/fail.
//
// SKIPPED BY DEFAULT — PENDING. Migration
// 20260830000007_billable_unit_qualification.sql has not yet been
// exercised against a disposable Postgres instance (this environment has
// no Docker/Podman/Homebrew/psql, and `supabase start` explicitly
// requires Docker or Podman — confirmed by a real, failed attempt during
// this audit). These tests are fully written and type-checked but their
// actual pass/fail against real Postgres is UNVERIFIED until someone runs
// them in an environment with a disposable Supabase instance:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/billable-unit-qualification-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

function unresolved<T>(): FieldDecision<T> {
  return { value: null, state: 'decision_required', provenance: null }
}

type MinimalRuleInput = Parameters<typeof createDraftQualificationRule>[0]

function minimalDraftInput(jobId: string, orgId: string, unitType: string, opts?: { valid_channel?: string; precedenceSourceA?: string; precedenceSourceB?: string }): MinimalRuleInput {
  return {
    job_id: jobId, org_id: orgId, unit_type: unitType,
    fact_schema: { attendance_minutes: { type: 'number', reference_time: 'occurred_at' } },
    criteria: { value: { kind: 'condition', condition: { field: 'attendance_minutes', operator: 'gte', value: 15 } }, state: 'clear_from_source', provenance: null },
    qualified_contact_role: { base: unresolved(), extensions: unresolved(), attestation_fact_key: unresolved() },
    dedupe_rule: unresolved(),
    rejection_rule: unresolved(),
    rejection_window: unresolved(),
    deadline_convention: unresolved(),
    attribution_basis: unresolved(),
    evidence_precedence: {
      key_a: { value: { kind: 'authoritative_source', source: opts?.precedenceSourceA ?? 'crm' }, state: 'clear_from_source', provenance: null },
      key_b: { value: { kind: 'authoritative_source', source: opts?.precedenceSourceB ?? 'conferencing' }, state: 'clear_from_source', provenance: null },
    },
    field_sources: { criteria: ['2.3 Sales Qualified Meeting'] },
    effective_from: '2026-08-25T00:00:00Z',
  }
}

// Shared later-date fixture for successor tests. minimalDraftInput()
// defaults effective_from to 2026-08-25T00:00:00Z (the predecessor's
// date below); the accepted invariant is
// successor.effective_from > predecessor.effective_from, so every
// successor draft in this file must override it to something later.
const SUCCESSOR_EFFECTIVE_FROM = '2026-09-01T00:00:00Z'

function rejectionRuleValue(validChannel: string) {
  return { valid_reasons: [], valid_channels: [validChannel], requires_timestamp: true, requires_identification: true, email_alone_valid: false, email_exception: 'none' as const, late_rejection_behavior: 'ignored_for_initial_qualification' as const }
}

async function confirmAllFields(ruleId: string, validChannel = 'crm'): Promise<BillableUnitQualificationRule> {
  await confirmQualificationRuleFieldAndPersist(ruleId, 'criteria')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'qualified_contact_role.base', { field: 'contact.role', operator: 'in', value: ['CRO'] })
  await confirmQualificationRuleFieldAndPersist(ruleId, 'qualified_contact_role.attestation_fact_key', null)
  await confirmQualificationRuleFieldAndPersist(ruleId, 'dedupe_rule', { key_fields: ['account.id'], lookback: { days: 90, unit: 'calendar' }, scope: [] })
  await confirmQualificationRuleFieldAndPersist(ruleId, 'rejection_rule', rejectionRuleValue(validChannel))
  await confirmQualificationRuleFieldAndPersist(ruleId, 'rejection_window', { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm' })
  await confirmQualificationRuleFieldAndPersist(ruleId, 'deadline_convention', 'end_of_business_day')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'attribution_basis', 'occurred_at')
  await confirmQualificationRuleFieldAndPersist(ruleId, 'evidence_precedence.key_a')
  const ready = await confirmQualificationRuleFieldAndPersist(ruleId, 'evidence_precedence.key_b')
  expect(isQualificationRuleReady(ready)).toBe(true)
  return ready
}

async function makeAndActivateReadyRule(jobId: string, orgId: string, unitType: string): Promise<BillableUnitQualificationRule> {
  const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, unitType))
  await confirmAllFields(rule.id)
  return activateQualificationRule(rule.id)
}

describeIf('billable_unit_qualification_rules / source_roles — real Postgres round trip + RLS', () => {
  let orgId: string
  let jobId: string
  let otherJobId: string

  beforeAll(async () => {
    const slug = `buq-integration-test-${Date.now()}`
    const { data: org, error: orgError } = await supabaseServer.from('organizations').insert({ name: 'buq-integration-test-org', slug }).select('id').single()
    if (orgError) throw new Error(`organizations insert failed: ${orgError.message}`)
    orgId = org!.id
    const { data: job, error: jobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'buq-integration-test-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (jobError) throw new Error(`jobs insert failed: ${jobError.message}`)
    jobId = job!.id
    const { data: otherJob, error: otherJobError } = await supabaseServer.from('jobs').insert({
      org_id: orgId, name: 'buq-integration-test-other-job', module: 'AUTO_CONFIGURE', status: 'PENDING',
    }).select('id').single()
    if (otherJobError) throw new Error(`jobs insert failed: ${otherJobError.message}`)
    otherJobId = otherJob!.id

    // Registered up front (not inside a test) so every later test can rely
    // on 'crm'/'conferencing' being available regardless of test order.
    await registerSourceRole(jobId, orgId, 'crm')
    await registerSourceRole(jobId, orgId, 'conferencing')
    await ensureReviewerAttestationRole(jobId, orgId)
  })

  afterAll(async () => {
    await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', jobId)
    await supabaseServer.from('billable_unit_qualification_rules').delete().eq('job_id', otherJobId)
    await supabaseServer.from('source_roles').delete().eq('job_id', jobId)
    await supabaseServer.from('source_roles').delete().eq('job_id', otherJobId)
    await supabaseServer.from('jobs').delete().eq('id', jobId)
    await supabaseServer.from('jobs').delete().eq('id', otherJobId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('registered source roles are visible via listSourceRolesForJob, including the reserved reviewer_attestation role', async () => {
    const roles = await listSourceRolesForJob(jobId)
    expect(roles.map(r => r.role_key).sort()).toEqual(['conferencing', 'crm', 'reviewer_attestation'])
  })

  it('ensureReviewerAttestationRole is idempotent', async () => {
    const first = await ensureReviewerAttestationRole(jobId, orgId)
    const second = await ensureReviewerAttestationRole(jobId, orgId)
    expect(second.id).toBe(first.id)
  })

  it('creates a draft rule, confirms fields one at a time, and activates once ready — round-tripping through the real table', async () => {
    const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_BASIC'))
    expect(rule.status).toBe('draft')
    expect(isQualificationRuleReady(rule)).toBe(false)

    // Activation before readiness must fail.
    await expect(activateQualificationRule(rule.id)).rejects.toThrow(/not ready/)

    const activated = await makeAndActivateReadyRule(jobId, orgId, 'SQM_BASIC_2')
    expect(activated.status).toBe('active')

    const persisted = await getQualificationRule(activated.id)
    expect(persisted?.field_sources).toEqual({ criteria: ['2.3 Sales Qualified Meeting'] })
  })

  // ── Part A (prior audit): active-rule immutability, re-verified against the real table ──
  describe('active-rule immutability', () => {
    it('confirmQualificationRuleFieldAndPersist rejects a confirm attempt on an active rule', async () => {
      const active = await makeAndActivateReadyRule(jobId, orgId, 'SQM_IMMUTABLE')
      await expect(confirmQualificationRuleFieldAndPersist(active.id, 'deadline_convention', 'same_clock_time'))
        .rejects.toThrow(/is 'active', not 'draft'/)
      const reread = await getQualificationRule(active.id)
      expect(reread?.deadline_convention).toEqual(active.deadline_convention)
    })

    it('growing qualified_contact_role.extensions on an active rule is rejected', async () => {
      const active = await makeAndActivateReadyRule(jobId, orgId, 'SQM_IMMUTABLE_EXT')
      await expect(confirmQualificationRuleFieldAndPersist(active.id, 'qualified_contact_role.extensions', ['Chief_Growth_Officer']))
        .rejects.toThrow(/is 'active', not 'draft'/)
    })
  })

  // ── Part 4: zero-row draft-gate races are surfaced as explicit errors, never silent success ──
  describe('zero-row draft-gate conflict behavior (concurrent activation vs. confirmation)', () => {
    it('exact scenario: request reads a draft, a second request activates it, the first request\'s confirm attempt fails — no silent success', async () => {
      const draft = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_RACE_EXACT'))
      await confirmAllFields(draft.id) // fully resolved, still draft — "request reads draft"
      await activateQualificationRule(draft.id) // "another request activates it"

      // "first request attempts confirmation" using the id it already had —
      // it has no way to know activation happened concurrently.
      await expect(confirmQualificationRuleFieldAndPersist(draft.id, 'deadline_convention', 'same_clock_time'))
        .rejects.toThrow(/is 'active', not 'draft'/)

      const reread = await getQualificationRule(draft.id)
      expect(reread?.status).toBe('active')
      expect(reread?.deadline_convention.value).toBe('end_of_business_day') // unchanged by the failed attempt
    })

    it('the independent-top-level-column write path fails cleanly on an activated-out-from-under-it rule', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_RACE_COLUMN'))
      await confirmAllFields(rule.id)
      await activateQualificationRule(rule.id)
      await expect(confirmQualificationRuleFieldAndPersist(rule.id, 'attribution_basis', 'occurred_at')).rejects.toThrow(/is 'active', not 'draft'/)
    })

    it('the qualified_contact_role RPC write path fails cleanly on an activated-out-from-under-it rule', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_RACE_CONTACT_RPC'))
      await confirmAllFields(rule.id)
      await activateQualificationRule(rule.id)
      await expect(confirmQualificationRuleFieldAndPersist(rule.id, 'qualified_contact_role.extensions', ['X'])).rejects.toThrow(/is 'active', not 'draft'/)
    })

    it('the evidence_precedence RPC write path fails cleanly on an activated-out-from-under-it rule', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_RACE_EVIDENCE_RPC'))
      await confirmAllFields(rule.id)
      await activateQualificationRule(rule.id)
      await expect(confirmQualificationRuleFieldAndPersist(rule.id, 'evidence_precedence.key_a', { kind: 'authoritative_source', source: 'crm' })).rejects.toThrow(/is 'active', not 'draft'/)
    })
  })

  // ── Concurrent different-field confirmation (prior audit, re-verified) ──
  describe('concurrent different-field confirmation', () => {
    it('two independent top-level columns confirmed concurrently both survive', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_CONCURRENT_A'))
      await Promise.all([
        confirmQualificationRuleFieldAndPersist(rule.id, 'deadline_convention', 'end_of_business_day'),
        confirmQualificationRuleFieldAndPersist(rule.id, 'attribution_basis', 'occurred_at'),
      ])
      const final = await getQualificationRule(rule.id)
      expect(final?.deadline_convention.value).toBe('end_of_business_day')
      expect(final?.attribution_basis.value).toBe('occurred_at')
    })

    it('two different evidence_precedence keys confirmed concurrently both survive', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_CONCURRENT_B'))
      await Promise.all([
        confirmQualificationRuleFieldAndPersist(rule.id, 'evidence_precedence.key_a'),
        confirmQualificationRuleFieldAndPersist(rule.id, 'evidence_precedence.key_b'),
      ])
      const final = await getQualificationRule(rule.id)
      expect(final?.evidence_precedence['key_a'].provenance).toBe('contract_derived')
      expect(final?.evidence_precedence['key_b'].provenance).toBe('contract_derived')
    })

    it('qualified_contact_role.base and .extensions confirmed concurrently both survive', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_CONCURRENT_C'))
      await Promise.all([
        confirmQualificationRuleFieldAndPersist(rule.id, 'qualified_contact_role.base', { field: 'contact.role', operator: 'in', value: ['CRO'] }),
        confirmQualificationRuleFieldAndPersist(rule.id, 'qualified_contact_role.extensions', ['Chief_Growth_Officer']),
      ])
      const final = await getQualificationRule(rule.id)
      expect(final?.qualified_contact_role.base.provenance).toBe('reviewer_policy')
      expect(final?.qualified_contact_role.extensions.value).toEqual(['Chief_Growth_Officer'])
    })
  })

  // ── Part 3: source-role reference validation before activation ──────────
  describe('source-role reference validation before activation', () => {
    it('a referenced role registered for the same job -> activation succeeds (baseline, already exercised above, re-asserted explicitly)', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_ROLE_VALID'))
      await confirmAllFields(rule.id, 'crm')
      await expect(activateQualificationRule(rule.id)).resolves.toMatchObject({ status: 'active' })
    })

    it('a referenced role that is not registered at all for this job -> activation blocked', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_ROLE_MISSING', { precedenceSourceA: 'unregistered_erp' }))
      await confirmAllFields(rule.id)
      await expect(activateQualificationRule(rule.id)).rejects.toThrow(/references source role\(s\) not registered.*unregistered_erp/)
    })

    it('a role_key registered only for a DIFFERENT job -> activation blocked for this job', async () => {
      await registerSourceRole(otherJobId, orgId, 'only_other_job_role')
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_ROLE_OTHER_JOB', { precedenceSourceB: 'only_other_job_role' }))
      await confirmAllFields(rule.id)
      await expect(activateQualificationRule(rule.id)).rejects.toThrow(/references source role\(s\) not registered.*only_other_job_role/)
      // Confirm it's genuinely a job-scoping issue, not a typo: the same
      // key IS valid for the other job.
      const otherJobRoles = await listSourceRolesForJob(otherJobId)
      expect(otherJobRoles.map(r => r.role_key)).toContain('only_other_job_role')
    })

    it('a rejection_rule.valid_channels reference is validated the same way as evidence_precedence', async () => {
      const rule = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_ROLE_REJECTION_CHANNEL'))
      await confirmQualificationRuleFieldAndPersist(rule.id, 'criteria')
      await confirmQualificationRuleFieldAndPersist(rule.id, 'qualified_contact_role.base', { field: 'contact.role', operator: 'in', value: ['CRO'] })
      await confirmQualificationRuleFieldAndPersist(rule.id, 'dedupe_rule', { key_fields: ['account.id'], lookback: { days: 90, unit: 'calendar' }, scope: [] })
      await confirmQualificationRuleFieldAndPersist(rule.id, 'rejection_rule', rejectionRuleValue('unregistered_portal'))
      await confirmQualificationRuleFieldAndPersist(rule.id, 'rejection_window', { business_days: 3, holiday_calendar: 'SE-stockholm', timezone: 'Europe/Stockholm' })
      await confirmQualificationRuleFieldAndPersist(rule.id, 'deadline_convention', 'end_of_business_day')
      await confirmQualificationRuleFieldAndPersist(rule.id, 'attribution_basis', 'occurred_at')
      await confirmQualificationRuleFieldAndPersist(rule.id, 'evidence_precedence.key_a')
      await confirmQualificationRuleFieldAndPersist(rule.id, 'evidence_precedence.key_b')
      await expect(activateQualificationRule(rule.id)).rejects.toThrow(/references source role\(s\) not registered.*unregistered_portal/)
    })
  })

  // ── Part 2: successor lifecycle transactionality ─────────────────────────
  describe('successor lifecycle transactionality', () => {
    it('draft successor creation leaves the predecessor active — the bug this audit found and fixed', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_SUCCESSOR_LEAVES_ACTIVE')
      const v2 = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: SUCCESSOR_EFFECTIVE_FROM })
      expect(v2.status).toBe('draft')
      expect(v2.supersedes_rule_id).toBe(v1.id)

      const rereadV1 = await getQualificationRule(v1.id)
      expect(rereadV1?.status).toBe('active') // NOT superseded merely because a successor draft exists
      expect(rereadV1?.effective_to).toBeNull()
    })

    it('an unresolved successor cannot activate', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_SUCCESSOR_UNRESOLVED')
      const v2 = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: SUCCESSOR_EFFECTIVE_FROM })
      await expect(activateQualificationRuleSuccessor(v2.id)).rejects.toThrow(/not ready/)
      const rereadV1 = await getQualificationRule(v1.id)
      expect(rereadV1?.status).toBe('active')
    })

    it('successful successor activation closes the predecessor at the exact boundary and promotes the successor, atomically', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_SUCCESSOR_SUCCESS')
      const v2Draft = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: '2026-10-01T00:00:00Z' })
      await confirmAllFields(v2Draft.id)

      const { predecessor, successor } = await activateQualificationRuleSuccessor(v2Draft.id)
      expect(predecessor.id).toBe(v1.id)
      expect(predecessor.status).toBe('superseded')
      expect(successor.status).toBe('active')
      expect(successor.version).toBe(v1.version + 1)
      expect(new Date(predecessor.effective_to!).toISOString()).toBe(new Date('2026-10-01T00:00:00Z').toISOString())
      expect(new Date(successor.effective_from).toISOString()).toBe(new Date(predecessor.effective_to!).toISOString())
    })

    it('a failed activation attempt (predecessor no longer active) leaves both rows exactly as they were — no partial supersession, no accidental promotion', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_SUCCESSOR_ROLLBACK')
      const v2Draft = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: SUCCESSOR_EFFECTIVE_FROM })
      await confirmAllFields(v2Draft.id)

      // Simulate the predecessor no longer being active by the time
      // activation is attempted (e.g. a concurrent process already
      // retired it some other way) — corrupt it directly, bypassing the
      // service layer, purely to engineer this precondition for the test.
      await supabaseServer.from('billable_unit_qualification_rules').update({ status: 'draft' }).eq('id', v1.id)

      await expect(activateQualificationRuleSuccessor(v2Draft.id)).rejects.toThrow(/predecessor .* is not active/)

      // Nothing else moved: the successor is still exactly 'draft', not
      // half-activated.
      const rereadV2 = await getQualificationRule(v2Draft.id)
      expect(rereadV2?.status).toBe('draft')
      // Full mid-function crash-safety (a failure after SOME writes had
      // already been issued inside the same function call) is guaranteed
      // by ordinary Postgres transaction semantics — a single SQL/plpgsql
      // function body executes inside the calling transaction, and any
      // unhandled exception aborts everything it did — not something this
      // integration test needs to independently fault-inject to trust.
    })

    it('concurrent successor activation cannot create two active versions — only one wins, the other fails cleanly', async () => {
      // Two real, concurrent network round trips against production
      // Postgres — the second genuinely blocks behind the first's row
      // lock until it commits/rolls back, which can exceed vitest's
      // default 5000ms test timeout. Timeout only; body/assertions
      // unchanged.
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_SUCCESSOR_CONCURRENT')
      // Two different draft successors against the SAME predecessor
      // (distinct version numbers, so creation itself doesn't collide).
      const v2a = await createDraftQualificationRule({ ...minimalDraftInput(jobId, orgId, v1.unit_type), version: v1.version + 1, supersedes_rule_id: v1.id, effective_from: SUCCESSOR_EFFECTIVE_FROM })
      const v2b = await createDraftQualificationRule({ ...minimalDraftInput(jobId, orgId, v1.unit_type), version: v1.version + 2, supersedes_rule_id: v1.id, effective_from: SUCCESSOR_EFFECTIVE_FROM })
      await confirmAllFields(v2a.id)
      await confirmAllFields(v2b.id)

      const results = await Promise.allSettled([
        activateQualificationRuleSuccessor(v2a.id),
        activateQualificationRuleSuccessor(v2b.id),
      ])
      const fulfilled = results.filter(r => r.status === 'fulfilled')
      const rejected = results.filter(r => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const rereadV1 = await getQualificationRule(v1.id)
      expect(rereadV1?.status).toBe('superseded')
      const rereadV2a = await getQualificationRule(v2a.id)
      const rereadV2b = await getQualificationRule(v2b.id)
      const activeCount = [rereadV2a, rereadV2b].filter(r => r?.status === 'active').length
      expect(activeCount).toBe(1) // exactly one successor became active, never both, never neither
    }, 20_000)
  })

  // ── Activation TOCTOU hardening: optimistic revision guard ──────────────
  describe('activation-TOCTOU hardening (optimistic revision guard)', () => {
    it('exact scenario: activation with a stale expected_revision fails; re-reading, re-validating, and activating against the CURRENT revision succeeds', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_REVISION_EXACT')
      const v2 = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: SUCCESSOR_EFFECTIVE_FROM })
      const ready = await confirmAllFields(v2.id)

      // "1. read successor including revision N. 2. validate
      // isQualificationRuleReady. 3. validate referenced SourceRoles."
      const staleRevision = ready.revision
      expect(isQualificationRuleReady(ready)).toBe(true)

      // "concurrent confirmation changes rule -> revision becomes N+1" —
      // re-accepting an already-resolved field is itself a legitimate
      // confirm action, and bumps revision again.
      const afterConcurrentEdit = await confirmQualificationRuleFieldAndPersist(v2.id, 'deadline_convention', 'same_clock_time')
      expect(afterConcurrentEdit.revision).toBe(staleRevision + 1)

      // "4. call activation RPC with expected_revision = N" — called
      // directly (bypassing activateQualificationRuleSuccessor, which
      // would re-read fresh internally and mask the exact race this test
      // proves) to simulate a caller that validated against the now-stale
      // snapshot from step 1.
      const staleAttempt = await supabaseServer.rpc('activate_qualification_rule_successor', {
        p_successor_id: v2.id, p_expected_revision: staleRevision,
      })
      expect(staleAttempt.error).toBeTruthy()
      expect(staleAttempt.error?.message).toMatch(/revision changed concurrently/)

      const stillDraft = await getQualificationRule(v2.id)
      expect(stillDraft?.status).toBe('draft') // the stale attempt activated nothing

      // "reread revision N+1, revalidate, activate expected_revision N+1
      // -> succeeds" — the normal wrapper does exactly this internally.
      const { predecessor, successor } = await activateQualificationRuleSuccessor(v2.id)
      expect(successor.status).toBe('active')
      expect(successor.revision).toBe(staleRevision + 1)
      expect(predecessor.status).toBe('superseded')
    })

    it('the same guard applies to first-ever activation (activateQualificationRule) — same read/validate/activate shape', async () => {
      const draft = await createDraftQualificationRule(minimalDraftInput(jobId, orgId, 'SQM_REVISION_FIRST_EVER'))
      const ready = await confirmAllFields(draft.id)
      const staleRevision = ready.revision
      await confirmQualificationRuleFieldAndPersist(draft.id, 'deadline_convention', 'same_clock_time')

      // activateQualificationRule has no external expected_revision
      // parameter (it always validates against its own fresh internal
      // read — see its own comment for why that's the correct shape for
      // a function with no caller-supplied prior read to honor). To prove
      // the underlying guard exists at the query level, replicate its
      // exact guarded query directly with the STALE revision.
      const staleUpdate = await supabaseServer.from('billable_unit_qualification_rules')
        .update({ status: 'active' })
        .eq('id', draft.id).eq('status', 'draft').eq('revision', staleRevision)
        .select().maybeSingle()
      expect(staleUpdate.data).toBeNull() // zero rows matched — the stale revision blocked it

      const stillDraft = await getQualificationRule(draft.id)
      expect(stillDraft?.status).toBe('draft')

      // The normal call, reading fresh, succeeds.
      const activated = await activateQualificationRule(draft.id)
      expect(activated.status).toBe('active')
    })

    it('a concurrent evidence_precedence change referencing a newly UNREGISTERED role cannot slip through activation using the old, already-validated revision', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_REVISION_ROLE_SWAP')
      const v2 = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: SUCCESSOR_EFFECTIVE_FROM })
      const ready = await confirmAllFields(v2.id)
      const validatedRevision = ready.revision
      // Validation AS OF validatedRevision genuinely passed — both 'crm'
      // and 'conferencing' are registered for this job.
      expect(isQualificationRuleReady(ready)).toBe(true)

      // Concurrent edit swaps evidence_precedence.key_a to reference a
      // role that was never registered for this job — a change that, if
      // activated, should be blocked by source-role validation. Bumps
      // revision past what was already validated.
      const mutated = await confirmQualificationRuleFieldAndPersist(v2.id, 'evidence_precedence.key_a', { kind: 'authoritative_source', source: 'sneaky_unregistered_role' })
      expect(mutated.revision).toBe(validatedRevision + 1)

      // A caller that validated at validatedRevision (before the swap)
      // and only NOW gets around to calling activation with that stale
      // revision must be rejected by the revision guard ALONE — it never
      // even needs to re-run source-role validation for this to be safe,
      // because the row it would have activated no longer matches what
      // was validated.
      const staleAttempt = await supabaseServer.rpc('activate_qualification_rule_successor', {
        p_successor_id: v2.id, p_expected_revision: validatedRevision,
      })
      expect(staleAttempt.error).toBeTruthy()
      expect(staleAttempt.error?.message).toMatch(/revision changed concurrently/)

      const stillDraft = await getQualificationRule(v2.id)
      expect(stillDraft?.status).toBe('draft') // never activated with the bad reference

      // And the NORMAL path (fresh read + fresh source-role validation)
      // independently catches the same problem too — belt and braces.
      await expect(activateQualificationRuleSuccessor(v2.id)).rejects.toThrow(/references source role\(s\) not registered.*sneaky_unregistered_role/)
    })
  })

  // ── Effective-range sanity ────────────────────────────────────────────
  describe('effective-range sanity for successor activation', () => {
    it('createSuccessorDraft rejects an effective_from at or before the predecessor\'s own effective_from — fail-fast, before a bad draft can even exist', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_RANGE_FASTFAIL')
      await expect(createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: v1.effective_from }))
        .rejects.toThrow(/must be strictly after predecessor/)
      const earlier = new Date(new Date(v1.effective_from).getTime() - 86_400_000).toISOString()
      await expect(createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: earlier }))
        .rejects.toThrow(/must be strictly after predecessor/)
    })

    it('the RPC itself independently rejects an invalid governing interval, even if a bad draft reaches activation via a path that skipped createSuccessorDraft\'s own check', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_RANGE_RPC_BACKSTOP')
      // Bypasses createSuccessorDraft's fast-fail on purpose, to prove the
      // RPC's own independent check is real defense in depth, not the
      // only place this is enforced.
      const badDraft = await createDraftQualificationRule({
        ...minimalDraftInput(jobId, orgId, v1.unit_type),
        version: v1.version + 1, supersedes_rule_id: v1.id, effective_from: v1.effective_from,
      })
      await confirmAllFields(badDraft.id)
      await expect(activateQualificationRuleSuccessor(badDraft.id)).rejects.toThrow(/must be strictly after predecessor/)
      const stillDraft = await getQualificationRule(badDraft.id)
      expect(stillDraft?.status).toBe('draft')
    })

    it('a strictly-later effective_from activates normally (baseline, already exercised above, re-asserted explicitly)', async () => {
      const v1 = await makeAndActivateReadyRule(jobId, orgId, 'SQM_RANGE_VALID')
      const later = new Date(new Date(v1.effective_from).getTime() + 86_400_000).toISOString()
      const v2 = await createSuccessorDraft(v1.id, { ...minimalDraftInput(jobId, orgId, v1.unit_type), effective_from: later })
      await confirmAllFields(v2.id)
      const { successor } = await activateQualificationRuleSuccessor(v2.id)
      expect(successor.status).toBe('active')
    })
  })
})

describeIf('billable_unit_qualification_rules / source_roles — anon key must not reach them', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows', async () => {
    const { data: rules, error: rulesError } = await anon.from('billable_unit_qualification_rules').select('id').limit(1)
    if (!rulesError) expect(rules ?? []).toHaveLength(0)
    const { data: roles, error: rolesError } = await anon.from('source_roles').select('id').limit(1)
    if (!rolesError) expect(roles ?? []).toHaveLength(0)
  })

  it('INSERT via anon key is rejected', async () => {
    const { error } = await anon.from('source_roles').insert({
      job_id: '00000000-0000-0000-0000-000000000000',
      org_id: '00000000-0000-0000-0000-000000000000',
      role_key: 'anon_test',
    })
    expect(error).toBeTruthy()
  })

  it('all three atomic RPCs (service_role only) are rejected for the anon key', async () => {
    const { error: e1 } = await anon.rpc('set_qualification_rule_contact_role_field', {
      p_rule_id: '00000000-0000-0000-0000-000000000000', p_field: 'base', p_value: {},
    })
    expect(e1).toBeTruthy()
    const { error: e2 } = await anon.rpc('set_qualification_rule_evidence_precedence_key', {
      p_rule_id: '00000000-0000-0000-0000-000000000000', p_key: 'x', p_value: {},
    })
    expect(e2).toBeTruthy()
    const { error: e3 } = await anon.rpc('activate_qualification_rule_successor', {
      p_successor_id: '00000000-0000-0000-0000-000000000000', p_expected_revision: 1,
    })
    expect(e3).toBeTruthy()
    // A well-formed call (correct arg shape) must be rejected on privilege
    // grounds specifically — not merely "some error occurred", which could
    // also be a function-signature mismatch masking a real grant gap.
    expect(e3?.code).toBe('42501')
    expect(e3?.message).toMatch(/permission denied/i)
  })
})
