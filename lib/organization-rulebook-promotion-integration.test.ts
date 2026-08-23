import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { supabaseServer } from './supabase'
import {
  createOrganizationRule, activateOrganizationRule, supersedeOrganizationRule,
  listAllOrganizationRules, listMatchableOrganizationRules, listActiveOrganizationRules,
  getOrganizationRule, findActiveRuleForSameSlot, findOrganizationRulesForSlot, discardDraftOrganizationRule,
  updateOrganizationRuleDescription, resolveOrganizationPolicySlotForWrite,
  isOrganizationPolicySlotRaceViolation,
} from './rulebook/organization-rules-service'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from './rulebook/organization-rulebook-promotion'
import { classifyOrganizationPolicySlotOutcome, organizationRuleOccupiesSlot } from './rulebook/organization-policy-slot'
import { matchOrganizationRules } from './rulebook/organization-rules'

// Pure — no database, always runs (not gated). isOrganizationPolicySlotRaceViolation
// is the ONE place a raw Postgres error is interpreted as "the expected
// one-draft-per-slot race" vs. every other failure mode; its detection
// logic is tested directly here, independent of ever needing a real
// unique-violation to actually occur.
describe('isOrganizationPolicySlotRaceViolation — pure error-shape detection (concurrency-safety pass)', () => {
  it('recognizes a real Postgres unique-violation on the org_rulebook_one_draft_per_slot index', () => {
    expect(isOrganizationPolicySlotRaceViolation({
      code: '23505',
      message: 'duplicate key value violates unique constraint "org_rulebook_one_draft_per_slot"',
    })).toBe(true)
  })

  it('is indifferent to whether the constraint name appears in message or details', () => {
    expect(isOrganizationPolicySlotRaceViolation({
      code: '23505', message: 'duplicate key value violates unique constraint',
      details: 'Key (slot_key)=(...) already exists. index: org_rulebook_one_draft_per_slot',
    })).toBe(true)
  })

  it('rejects a unique violation on a DIFFERENT constraint', () => {
    expect(isOrganizationPolicySlotRaceViolation({
      code: '23505', message: 'duplicate key value violates unique constraint "some_other_constraint"',
    })).toBe(false)
  })

  it('rejects a non-unique-violation error even if it mentions the constraint name incidentally', () => {
    expect(isOrganizationPolicySlotRaceViolation({ code: '23503', message: 'org_rulebook_one_draft_per_slot foreign key violation' })).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isOrganizationPolicySlotRaceViolation(null)).toBe(false)
    expect(isOrganizationPolicySlotRaceViolation(undefined)).toBe(false)
  })
})

// Same convention as lib/organization-rulebook-rls.test.ts: organizations
// created directly via supabaseServer (never lib/org.ts's createOrg, which
// transitively pulls in next-auth and fails to resolve under plain vitest).
async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 5D — DB-touching regression tests for organization-rulebook-promotion
// .ts's evaluate function composed with organization-rules-service.ts's real
// DB writes, and the new service functions this step adds (listAll,
// findActiveRuleForSameSlot, discardDraftOrganizationRule,
// updateOrganizationRuleDescription). Mirrors app/api/org/rulebook/*/route.ts
// call sequences exactly (routes themselves can't be unit-tested — see
// established next-auth/vitest constraint) so these tests exercise the real
// composition those routes use, not a re-derived approximation of it.
//
// SKIPPED BY DEFAULT — real network calls, creates/cleans up real test
// organizations and rulebook rows:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/organization-rulebook-promotion-integration.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

describeIf('Step 5D — reviewer-decision promotion, draft/approve/activate, supersession, cross-org isolation', () => {
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    orgA = await createTestOrg('step5d-org-a')
    orgB = await createTestOrg('step5d-org-b')
  })

  afterAll(async () => {
    await supabaseServer.from('organization_rulebook_rules').delete().in('organization_id', [orgA, orgB])
    await supabaseServer.from('organizations').delete().in('id', [orgA, orgB])
  })

  const promotionState: PromotableFieldState = {
    targetField: 'survival.carry_forward',
    provenance: 'reviewer_policy',
    value: true,
    matchFacts: { ruleType: 'service_credit', applicationTiming: 'next_invoice' },
  }

  it('explicit promotion creates a draft organization rule, with source_kind = reviewer_promotion (items 2, 6)', async () => {
    const evaluation = evaluateReviewerDecisionForPromotion(promotionState)
    expect(evaluation.eligible).toBe(true)
    if (!evaluation.eligible) return

    const rule = await createOrganizationRule({
      organizationId: orgA,
      name: 'Service Credit carry-forward default',
      targetField: evaluation.targetField,
      value: evaluation.value,
      matchConditions: evaluation.matchConditions,
      sourceKind: 'reviewer_promotion',
      createdBy: 'reviewer@org-a.test',
    })

    expect(rule.status).toBe('draft')
    expect(rule.sourceKind).toBe('reviewer_promotion')
    expect(rule.approvedBy).toBeNull()
    expect(rule.value).toBe(true)

    await discardDraftOrganizationRule(orgA, rule.id)
  })

  it('draft rule cannot affect production — excluded from both listMatchableOrganizationRules and matchOrganizationRules until activated (item 16)', async () => {
    const evaluation = evaluateReviewerDecisionForPromotion(promotionState)
    if (!evaluation.eligible) throw new Error('fixture setup failed')

    const draft = await createOrganizationRule({
      organizationId: orgA,
      name: 'Draft-only, never activated',
      targetField: evaluation.targetField,
      value: evaluation.value,
      matchConditions: evaluation.matchConditions,
      sourceKind: 'reviewer_promotion',
      createdBy: 'reviewer@org-a.test',
    })

    const matchable = await listMatchableOrganizationRules(orgA)
    expect(matchable.find(r => r.id === draft.id)).toBeUndefined()

    const matched = matchOrganizationRules(orgA, { context: { rule_type: 'service_credit', application: { timing: 'next_invoice' } }, contractResolvedFields: new Set() }, matchable, new Date())
    expect(matched.find(r => r.id === draft.id)).toBeUndefined()

    // But it DOES show up in the management page's all-statuses query.
    const all = await listAllOrganizationRules(orgA)
    expect(all.find(r => r.id === draft.id)?.status).toBe('draft')

    await discardDraftOrganizationRule(orgA, draft.id)
  })

  it('approve+activate uses the existing atomic activation path (item 7) — status, approved_by, and effective_from all set together', async () => {
    const evaluation = evaluateReviewerDecisionForPromotion(promotionState)
    if (!evaluation.eligible) throw new Error('fixture setup failed')

    const draft = await createOrganizationRule({
      organizationId: orgA,
      name: 'Approve+activate test',
      targetField: evaluation.targetField,
      value: evaluation.value,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'approve-activate-test' }],
      sourceKind: 'reviewer_promotion',
      createdBy: 'reviewer@org-a.test',
    })

    const activated = await activateOrganizationRule(orgA, draft.id, 'admin@org-a.test', new Date())
    expect(activated.status).toBe('active')
    expect(activated.approvedBy).toBe('admin@org-a.test')
    expect(activated.effectiveFrom).not.toBeNull()

    const nowMatchable = await listMatchableOrganizationRules(orgA)
    expect(nowMatchable.find(r => r.id === draft.id)?.status).toBe('active')
  })

  it('overlapping scope uses supersession/cutover — findActiveRuleForSameSlot detects it, supersede+activate performs the atomic replace, predecessor becomes superseded (item 8, item 9)', async () => {
    const scopeMatchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'overlap-test' }]

    const original = await createOrganizationRule({
      organizationId: orgA,
      name: 'Original policy',
      targetField: 'survival.carry_forward',
      value: true,
      matchConditions: scopeMatchConditions,
      sourceKind: 'manual',
      createdBy: 'admin@org-a.test',
      status: 'active',
      approvedBy: 'admin@org-a.test',
    })

    // A standalone promoted draft targeting the IDENTICAL slot — exactly
    // what app/api/org/rulebook/promote/route.ts would create, unaware yet
    // of the existing active policy.
    const standaloneDraft = await createOrganizationRule({
      organizationId: orgA,
      name: 'Proposed replacement (standalone, not yet linked)',
      targetField: 'survival.carry_forward',
      value: false,
      matchConditions: scopeMatchConditions,
      sourceKind: 'reviewer_promotion',
      createdBy: 'reviewer@org-a.test',
    })

    const conflict = await findActiveRuleForSameSlot(orgA, standaloneDraft.targetField, standaloneDraft.matchConditions, standaloneDraft.lineageId)
    expect(conflict?.id).toBe(original.id)

    // "Replace from effective date" — discard the orphaned standalone draft
    // FIRST (frees the canonical slot), THEN re-derive a properly-linked
    // successor via the EXISTING supersedeOrganizationRule (not a new
    // mechanism) and activate it — exactly
    // app/api/org/rulebook/[id]/activate/route.ts's confirmReplace path,
    // corrected in the final concurrency-safety pass: the standalone draft
    // and its properly-linked successor occupy the identical canonical
    // slot, and the database now permits at most one draft per slot, so
    // discard must happen before supersede, not after.
    await discardDraftOrganizationRule(orgA, standaloneDraft.id)
    const linked = await supersedeOrganizationRule({
      organizationId: orgA,
      previousRuleId: conflict!.id,
      name: standaloneDraft.name,
      targetField: standaloneDraft.targetField,
      value: standaloneDraft.value,
      matchConditions: standaloneDraft.matchConditions,
      createdBy: standaloneDraft.createdBy,
    })
    const activated = await activateOrganizationRule(orgA, linked.id, 'admin@org-a.test', new Date())

    expect(activated.status).toBe('active')
    expect(activated.supersedesRuleId).toBe(original.id)

    const predecessor = await getOrganizationRule(orgA, original.id)
    expect(predecessor?.status).toBe('superseded')
    expect(predecessor?.effectiveTo).not.toBeNull()

    const discardedOrphan = await getOrganizationRule(orgA, standaloneDraft.id)
    expect(discardedOrphan?.status).toBe('disabled')
  })

  it('historical rule/version remains unchanged after successor activation (item 9) — value_json/target_field/match_conditions of the retired version are untouched', async () => {
    const scopeMatchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'historical-unchanged-test' }]
    const v1 = await createOrganizationRule({
      organizationId: orgA,
      name: 'v1',
      targetField: 'survival.carry_forward',
      value: true,
      matchConditions: scopeMatchConditions,
      sourceKind: 'manual',
      createdBy: 'admin@org-a.test',
      status: 'active',
      approvedBy: 'admin@org-a.test',
    })
    const v1Snapshot = { value: v1.value, targetField: v1.targetField, matchConditions: v1.matchConditions, name: v1.name }

    const v2Draft = await supersedeOrganizationRule({
      organizationId: orgA, previousRuleId: v1.id, name: 'v2', targetField: 'survival.carry_forward',
      value: false, matchConditions: scopeMatchConditions, createdBy: 'admin@org-a.test',
    })
    await activateOrganizationRule(orgA, v2Draft.id, 'admin@org-a.test', new Date())

    const v1AfterSupersession = await getOrganizationRule(orgA, v1.id)
    expect(v1AfterSupersession?.value).toBe(v1Snapshot.value)
    expect(v1AfterSupersession?.targetField).toBe(v1Snapshot.targetField)
    expect(v1AfterSupersession?.matchConditions).toEqual(v1Snapshot.matchConditions)
    expect(v1AfterSupersession?.name).toBe(v1Snapshot.name)
    expect(v1AfterSupersession?.status).toBe('superseded')
  })

  it('cosmetic-only edit (updateOrganizationRuleDescription) never changes semantic fields', async () => {
    const rule = await createOrganizationRule({
      organizationId: orgA, name: 'Cosmetic edit test', targetField: 'survival.carry_forward', value: true,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'cosmetic-test' }],
      sourceKind: 'manual', createdBy: 'admin@org-a.test',
    })
    const updated = await updateOrganizationRuleDescription(orgA, rule.id, 'A friendlier description')
    expect(updated.description).toBe('A friendlier description')
    expect(updated.value).toBe(true)
    expect(updated.targetField).toBe('survival.carry_forward')
    expect(updated.version).toBe(1)
  })

  it('Org A cannot create/update/activate/view Org B rule (item 13)', async () => {
    const orgBRule = await createOrganizationRule({
      organizationId: orgB, name: 'Org B private rule', targetField: 'survival.carry_forward', value: true,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'org-b-isolation-test' }],
      sourceKind: 'manual', createdBy: 'admin@org-b.test',
    })

    // View: Org A's org-scoped lookup returns null, not Org B's row.
    expect(await getOrganizationRule(orgA, orgBRule.id)).toBeNull()

    // Update (cosmetic): fails — the row is not found under orgA's scope.
    await expect(updateOrganizationRuleDescription(orgA, orgBRule.id, 'hijacked')).rejects.toThrow()

    // Activate: fails the same way (getOrganizationRule-based ownership
    // check inside activateOrganizationRule's caller — the route itself
    // checks first; the service layer's own DB filter is the second,
    // independent guarantee via the RPC's own p_organization_id match).
    await expect(activateOrganizationRule(orgA, orgBRule.id, 'admin@org-a.test', new Date())).rejects.toThrow()

    // Supersede (create a new version): fails — previousRuleId lookup is
    // org-scoped.
    await expect(supersedeOrganizationRule({
      organizationId: orgA, previousRuleId: orgBRule.id, name: 'hijack attempt', targetField: 'survival.carry_forward',
      value: false, matchConditions: [], createdBy: 'attacker@org-a.test',
    })).rejects.toThrow()

    // Discard: fails — same org-scoped lookup.
    await expect(discardDraftOrganizationRule(orgA, orgBRule.id)).rejects.toThrow()

    // Org B can still see its own rule via its own listAllOrganizationRules.
    const orgBAll = await listAllOrganizationRules(orgB)
    expect(orgBAll.find(r => r.id === orgBRule.id)).toBeTruthy()
    // And Org A's listing never includes it.
    const orgAAll = await listAllOrganizationRules(orgA)
    expect(orgAAll.find(r => r.id === orgBRule.id)).toBeUndefined()
  })

  it('discardDraftOrganizationRule refuses to discard an active rule (only drafts, never a real historically-resolving policy)', async () => {
    const active = await createOrganizationRule({
      organizationId: orgA, name: 'Active, cannot be discarded', targetField: 'survival.carry_forward', value: true,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'discard-guard-test' }],
      sourceKind: 'manual', createdBy: 'admin@org-a.test', status: 'active', approvedBy: 'admin@org-a.test',
    })
    await expect(discardDraftOrganizationRule(orgA, active.id)).rejects.toThrow(/only a draft rule can be discarded/)
    const stillActive = await getOrganizationRule(orgA, active.id)
    expect(stillActive?.status).toBe('active')
  })

  it('listActiveOrganizationRules and listAllOrganizationRules agree on which rows are active, listAll additionally surfaces draft/disabled', async () => {
    const active = await listActiveOrganizationRules(orgA)
    const all = await listAllOrganizationRules(orgA)
    const activeIds = new Set(active.map(r => r.id))
    for (const r of all) {
      if (r.status === 'active') expect(activeIds.has(r.id)).toBe(true)
    }
    expect(all.some(r => r.status === 'draft' || r.status === 'disabled')).toBe(true)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Final amendment — promotion dedup, against the real database. Mirrors
  // exactly what app/api/org/rulebook/promote/route.ts does: look up the
  // slot via findOrganizationRulesForSlot, classify the outcome, then act.
  // The database's own exclusion constraints do NOT cover this (both are
  // scoped to status in ('active','superseded') — see
  // 20260823000001_organization_rulebook_temporal_validity.sql) — a
  // 'draft' row is unprotected at the database layer, so these tests exist
  // specifically to prove the APPLICATION-level check actually closes that
  // gap against real data, not just against pure fixtures.
  // ═══════════════════════════════════════════════════════════════════════
  describe('findOrganizationRulesForSlot + classifyOrganizationPolicySlotOutcome — real-database dedup (item 11)', () => {
    it('repeated identical promotion attempts result in exactly ONE draft, never a second one', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-repeat-test' }]

      // First attempt: no existing rule -> create.
      const first = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      expect(classifyOrganizationPolicySlotOutcome(true, first.activeRule, first.draftRule)).toEqual({ state: 'no_existing' })
      const created = await createOrganizationRule({
        organizationId: orgA, name: 'Dedup repeat test', targetField: 'survival.carry_forward', value: true,
        matchConditions, sourceKind: 'reviewer_promotion', createdBy: 'reviewer@org-a.test',
      })

      // Second attempt for the SAME slot, same value: must find the draft
      // just created and must NOT create another one.
      const second = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      const outcome = classifyOrganizationPolicySlotOutcome(true, second.activeRule, second.draftRule)
      expect(outcome).toEqual({ state: 'existing_draft', rule: created })

      const all = await listAllOrganizationRules(orgA)
      const matchingRows = all.filter(r => organizationRuleOccupiesSlot(r, { organizationId: orgA, targetField: 'survival.carry_forward', matchConditions }))
      expect(matchingRows).toHaveLength(1)

      await discardDraftOrganizationRule(orgA, created.id)
    })

    it('an active rule with the same value already exists -> already_covered, no new row', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-active-same-test' }]
      await createOrganizationRule({
        organizationId: orgA, name: 'Already active', targetField: 'survival.carry_forward', value: true,
        matchConditions, sourceKind: 'manual', createdBy: 'admin@org-a.test', status: 'active', approvedBy: 'admin@org-a.test',
      })

      const { activeRule, draftRule } = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      const outcome = classifyOrganizationPolicySlotOutcome(true, activeRule, draftRule)
      expect(outcome.state).toBe('already_covered')

      const all = await listAllOrganizationRules(orgA)
      const matchingRows = all.filter(r => organizationRuleOccupiesSlot(r, { organizationId: orgA, targetField: 'survival.carry_forward', matchConditions }))
      expect(matchingRows).toHaveLength(1)
    })

    it('a draft with a DIFFERENT value already exists -> draft_conflict, no second competing draft is ever created', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-draft-conflict-test' }]
      const existingDraft = await createOrganizationRule({
        organizationId: orgA, name: 'Existing draft, value false', targetField: 'survival.carry_forward', value: false,
        matchConditions, sourceKind: 'reviewer_promotion', createdBy: 'reviewer@org-a.test',
      })

      const { activeRule, draftRule } = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      const outcome = classifyOrganizationPolicySlotOutcome(true, activeRule, draftRule)
      expect(outcome).toEqual({ state: 'draft_conflict', rule: existingDraft })

      // A route respecting this outcome never calls createOrganizationRule
      // again — confirmed here by asserting only the one original row exists.
      const all = await listAllOrganizationRules(orgA)
      const matchingRows = all.filter(r => organizationRuleOccupiesSlot(r, { organizationId: orgA, targetField: 'survival.carry_forward', matchConditions }))
      expect(matchingRows).toHaveLength(1)

      await discardDraftOrganizationRule(orgA, existingDraft.id)
    })

    it('an active rule with a DIFFERENT value -> proposed_policy_change, resolved via supersedeOrganizationRule (the existing lifecycle), never a second independent active slot', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-active-change-test' }]
      const active = await createOrganizationRule({
        organizationId: orgA, name: 'Active, will be proposed for change', targetField: 'survival.carry_forward', value: true,
        matchConditions, sourceKind: 'manual', createdBy: 'admin@org-a.test', status: 'active', approvedBy: 'admin@org-a.test',
      })

      const { activeRule, draftRule } = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      const outcome = classifyOrganizationPolicySlotOutcome(false, activeRule, draftRule)
      expect(outcome.state).toBe('proposed_policy_change')
      if (outcome.state !== 'proposed_policy_change') return

      const successor = await supersedeOrganizationRule({
        organizationId: orgA, previousRuleId: outcome.rule.id, name: 'Proposed change',
        targetField: 'survival.carry_forward', value: false, matchConditions, createdBy: 'reviewer@org-a.test',
      })
      expect(successor.status).toBe('draft')
      expect(successor.supersedesRuleId).toBe(active.id)

      // The active rule itself is untouched until someone actually
      // approves and activates the successor — no second independent
      // active slot exists in the meantime.
      const stillActive = await getOrganizationRule(orgA, active.id)
      expect(stillActive?.status).toBe('active')

      await discardDraftOrganizationRule(orgA, successor.id)
    })

    it('source_kind alone never creates a different slot — a manual rule and a reviewer_promotion rule with the same organization/target_field/match_conditions are the SAME slot for dedup purposes', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-source-kind-test' }]
      const manualDraft = await createOrganizationRule({
        organizationId: orgA, name: 'Manually authored', targetField: 'survival.carry_forward', value: true,
        matchConditions, sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })

      const { activeRule, draftRule } = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      // A reviewer_promotion attempt at the SAME slot finds the manually-
      // authored draft — source_kind never distinguishes the slot.
      expect(draftRule?.id).toBe(manualDraft.id)
      expect(classifyOrganizationPolicySlotOutcome(true, activeRule, draftRule).state).toBe('existing_draft')

      await discardDraftOrganizationRule(orgA, manualDraft.id)
    })

    it('org A never finds org B\'s rule for the identical slot shape — tenant isolated (item 11)', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'dedup-tenant-isolation-test' }]
      const orgBRule = await createOrganizationRule({
        organizationId: orgB, name: 'Org B rule, identical slot shape', targetField: 'survival.carry_forward', value: true,
        matchConditions, sourceKind: 'manual', createdBy: 'admin@org-b.test', status: 'active', approvedBy: 'admin@org-b.test',
      })

      const forOrgA = await findOrganizationRulesForSlot(orgA, 'survival.carry_forward', matchConditions)
      expect(forOrgA.activeRule).toBeNull()
      expect(forOrgA.draftRule).toBeNull()
      expect(classifyOrganizationPolicySlotOutcome(true, forOrgA.activeRule, forOrgA.draftRule)).toEqual({ state: 'no_existing' })

      const forOrgB = await findOrganizationRulesForSlot(orgB, 'survival.carry_forward', matchConditions)
      expect(forOrgB.activeRule?.id).toBe(orgBRule.id)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Final amendment (concurrency-safety pass, item 6) — fires GENUINE
  // concurrent requests (Promise.all, not sequential awaits) at
  // resolveOrganizationPolicySlotForWrite — the same shared write boundary
  // app/api/org/rulebook/promote/route.ts calls — to prove the database's
  // org_rulebook_one_draft_per_slot partial unique index
  // (20260826000001_organization_policy_slot_uniqueness.sql) actually
  // closes the race the application-level preflight check alone cannot:
  // both requests can observe "no existing draft" before either has
  // written anything. REQUIRES the migration above to have been applied —
  // if it has not, the "exactly one row" assertions below will fail (two
  // rows will exist) rather than silently passing, so this test is a real,
  // honest proof, not a tautology.
  // ═══════════════════════════════════════════════════════════════════════
  describe('resolveOrganizationPolicySlotForWrite — genuine concurrent race (item 6, requires the slot-uniqueness migration applied)', () => {
    it('two concurrent confirmations, same value: exactly one draft row; one request creates it, the other gets existing_draft (never a duplicate, never an opaque DB error)', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'race-same-value-test' }]
      const writeInput = {
        organizationId: orgA, targetField: 'survival.carry_forward', matchConditions, value: true,
        name: 'Race test — same value', description: null, sourceKind: 'reviewer_promotion' as const, createdBy: 'reviewer@org-a.test',
      }

      const [resultA, resultB] = await Promise.all([
        resolveOrganizationPolicySlotForWrite(writeInput),
        resolveOrganizationPolicySlotForWrite(writeInput),
      ])

      // Exactly one of the two actually created a row; the other found it
      // as an existing draft with the same value. Order is not
      // deterministic (either could win the race), so check both orderings.
      const states = [resultA.state, resultB.state].sort()
      expect(states).toEqual(['existing_draft', 'no_existing'])

      const winner = resultA.state === 'no_existing' ? resultA : resultB
      const loser = resultA.state === 'existing_draft' ? resultA : resultB
      if (winner.state !== 'no_existing' || loser.state !== 'existing_draft') throw new Error('unreachable — asserted above')
      expect(loser.existingRule.id).toBe(winner.rule.id)

      const all = await listAllOrganizationRules(orgA)
      const matchingRows = all.filter(r => organizationRuleOccupiesSlot(r, { organizationId: orgA, targetField: 'survival.carry_forward', matchConditions }))
      expect(matchingRows).toHaveLength(1)

      await discardDraftOrganizationRule(orgA, winner.rule.id)
    })

    it('two concurrent confirmations, DIFFERENT values: exactly one draft row; the loser gets draft_conflict, never a second competing draft', async () => {
      const matchConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'race-diff-value-test' }]
      const inputTrue = {
        organizationId: orgA, targetField: 'survival.carry_forward', matchConditions, value: true,
        name: 'Race test — value true', description: null, sourceKind: 'reviewer_promotion' as const, createdBy: 'reviewer-1@org-a.test',
      }
      const inputFalse = { ...inputTrue, value: false, name: 'Race test — value false', createdBy: 'reviewer-2@org-a.test' }

      const [resultTrue, resultFalse] = await Promise.all([
        resolveOrganizationPolicySlotForWrite(inputTrue),
        resolveOrganizationPolicySlotForWrite(inputFalse),
      ])

      const states = [resultTrue.state, resultFalse.state].sort()
      // Exactly one winner (no_existing, whichever value happened to reach
      // the database first) and one loser — draft_conflict, since the
      // loser's own proposed value never matches whatever actually won.
      expect(states).toEqual(['draft_conflict', 'no_existing'])

      const all = await listAllOrganizationRules(orgA)
      const matchingRows = all.filter(r => organizationRuleOccupiesSlot(r, { organizationId: orgA, targetField: 'survival.carry_forward', matchConditions }))
      expect(matchingRows).toHaveLength(1)

      await discardDraftOrganizationRule(orgA, matchingRows[0].id)
    })

    it('concurrent requests for DIFFERENT rule_type scopes never interfere — both create their own draft', async () => {
      const rebateConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'race-distinct-scope-rebate' }]
      const serviceCreditConditions = [{ field: 'rule_type' as const, operator: 'eq' as const, value: 'race-distinct-scope-service-credit' }]

      const [rebateResult, serviceCreditResult] = await Promise.all([
        resolveOrganizationPolicySlotForWrite({
          organizationId: orgA, targetField: 'survival.carry_forward', matchConditions: rebateConditions, value: true,
          name: 'Distinct scope — rebate', description: null, sourceKind: 'reviewer_promotion', createdBy: 'reviewer@org-a.test',
        }),
        resolveOrganizationPolicySlotForWrite({
          organizationId: orgA, targetField: 'survival.carry_forward', matchConditions: serviceCreditConditions, value: true,
          name: 'Distinct scope — service credit', description: null, sourceKind: 'reviewer_promotion', createdBy: 'reviewer@org-a.test',
        }),
      ])

      // Neither request observes the other at all — both are genuinely
      // fresh slots, so both win as no_existing.
      expect(rebateResult.state).toBe('no_existing')
      expect(serviceCreditResult.state).toBe('no_existing')
      if (rebateResult.state !== 'no_existing' || serviceCreditResult.state !== 'no_existing') throw new Error('unreachable — asserted above')
      expect(rebateResult.rule.id).not.toBe(serviceCreditResult.rule.id)

      await discardDraftOrganizationRule(orgA, rebateResult.rule.id)
      await discardDraftOrganizationRule(orgA, serviceCreditResult.rule.id)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Final migration safeguard — closes the NULL-slot_key bypass the partial
  // unique index (org_rulebook_one_draft_per_slot) cannot close on its own,
  // since that index's WHERE clause deliberately excludes slot_key IS NULL
  // rows (to leave the pre-existing Lynora legacy draft alone). These tests
  // go around organization-rules-service.ts on purpose — createOrganizationRule/
  // supersedeOrganizationRule always set slot_key correctly, so the only way
  // to prove the DATABASE (not just well-behaved application code) rejects a
  // null-slot_key draft or a slot_key mutation is a raw insert/update.
  // REQUIRES the trigger in 20260826000001_organization_policy_slot_uniqueness.sql
  // to be applied — if it isn't, the "rejected" assertions below will fail
  // (the raw write will silently succeed) rather than passing vacuously.
  // ═══════════════════════════════════════════════════════════════════════
  describe('slot_key invariants enforced at the database layer (final migration safeguard)', () => {
    it('a raw INSERT of a new draft row with slot_key = null is rejected', async () => {
      const id = randomUUID()
      const { error } = await supabaseServer.from('organization_rulebook_rules').insert({
        id,
        organization_id: orgA,
        name: 'Raw insert, null slot_key — must be rejected',
        target_field: 'survival.carry_forward',
        value_json: true,
        match_conditions_json: [{ field: 'rule_type', operator: 'eq', value: 'raw-insert-null-slot-key-test' }],
        status: 'draft',
        version: 1,
        lineage_id: id,
        source_kind: 'manual',
        created_by: 'admin@org-a.test',
        slot_key: null,
      })
      expect(error).toBeTruthy()
      expect(error?.message).toMatch(/non-null slot_key/)

      const { data: shouldNotExist } = await supabaseServer.from('organization_rulebook_rules').select('id').eq('id', id).maybeSingle()
      expect(shouldNotExist).toBeNull()
    })

    it('a raw UPDATE transitioning a disabled row into draft status with slot_key = null is rejected', async () => {
      // A legitimately-disabled row (created via the service, so it has a
      // real slot_key) attempting to be raw-UPDATEd back into draft status
      // while simultaneously clearing slot_key — must also be rejected, not
      // just the INSERT path.
      const disabled = await createOrganizationRule({
        organizationId: orgA, name: 'Will be disabled then illegally reopened', targetField: 'survival.carry_forward', value: true,
        matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'raw-update-into-draft-null-test' }],
        sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })
      await discardDraftOrganizationRule(orgA, disabled.id)

      const { error } = await supabaseServer.from('organization_rulebook_rules')
        .update({ status: 'draft', slot_key: null })
        .eq('id', disabled.id)
      expect(error).toBeTruthy()
      expect(error?.message).toMatch(/transitioning into draft status must have a non-null slot_key/)

      const stillDisabled = await getOrganizationRule(orgA, disabled.id)
      expect(stillDisabled?.status).toBe('disabled')
    })

    it('a non-null slot_key cannot be changed by a later UPDATE — immutable identity once assigned', async () => {
      const rule = await createOrganizationRule({
        organizationId: orgA, name: 'Slot key immutability test', targetField: 'survival.carry_forward', value: true,
        matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'slot-key-immutable-test' }],
        sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })

      const { error } = await supabaseServer.from('organization_rulebook_rules')
        .update({ slot_key: 'attempted-hijack-of-canonical-slot' })
        .eq('id', rule.id)
      expect(error).toBeTruthy()
      expect(error?.message).toMatch(/slot_key is immutable once assigned/)

      const unchanged = await getOrganizationRule(orgA, rule.id)
      // organization-rules-service.ts's rowToRecord does not project
      // slot_key onto OrganizationRuleRecord — read it back raw to confirm
      // the underlying column was genuinely untouched, not just that the
      // service-layer view looks the same.
      const { data: raw } = await supabaseServer.from('organization_rulebook_rules').select('slot_key').eq('id', rule.id).single()
      expect(raw?.slot_key).toBeTruthy()
      expect(raw?.slot_key).not.toBe('attempted-hijack-of-canonical-slot')
      expect(unchanged?.status).toBe('draft')

      await discardDraftOrganizationRule(orgA, rule.id)
    })

    it('ordinary lifecycle transitions (draft -> active, draft -> disabled) leave slot_key unchanged', async () => {
      const rule = await createOrganizationRule({
        organizationId: orgA, name: 'Lifecycle transition, slot_key must survive unchanged', targetField: 'survival.carry_forward', value: true,
        matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'slot-key-lifecycle-test' }],
        sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })
      const { data: beforeRaw } = await supabaseServer.from('organization_rulebook_rules').select('slot_key').eq('id', rule.id).single()
      expect(beforeRaw?.slot_key).toBeTruthy()

      await activateOrganizationRule(orgA, rule.id, 'admin@org-a.test', new Date())

      const { data: afterActivateRaw } = await supabaseServer.from('organization_rulebook_rules').select('slot_key, status').eq('id', rule.id).single()
      expect(afterActivateRaw?.status).toBe('active')
      expect(afterActivateRaw?.slot_key).toBe(beforeRaw?.slot_key)
    })

    it('the pre-migration Lynora legacy draft (slot_key null) remains completely untouched by this migration', async () => {
      // Not a test-created row — the real production draft this whole
      // concurrency-safety pass was designed around not disturbing. Read-only.
      const { data: legacy } = await supabaseServer.from('organization_rulebook_rules')
        .select('*').eq('id', 'adff7a2e-48df-4e1c-93cf-42eab231275d').maybeSingle()
      if (!legacy) return // not present in every environment this suite might run against
      expect(legacy.status).toBe('draft')
      expect(legacy.slot_key).toBeNull()
      expect(legacy.organization_id).toBe('b911acab-03b1-48fd-8195-e2b2731ed69a')
      expect(legacy.target_field).toBe('survival.carry_forward')
    })

    // ─────────────────────────────────────────────────────────────────────
    // Final safeguard — a legacy NULL-slot draft may be discarded but never
    // activated. Note on what these three tests can and cannot construct:
    // once the trigger above exists, NO new row can ever reach status =
    // 'draft' with slot_key = null (both the INSERT check and the
    // transition-into-draft check refuse it) — that shape is only reachable
    // by rows that predate this migration. So "legacy draft -> active:
    // rejected" is tested directly against the one real such row (the
    // Lynora draft) — safe, because a REJECTED update never persists
    // anything, so this does not violate "must not mutate it". "Legacy
    // draft -> disabled: allowed" is deliberately NOT exercised against
    // that same real row — actually discarding it here would be exactly
    // the mutation earlier instructions forbade ("will be discarded
    // manually after deployment"). Instead it's proven the way that keeps
    // both constraints true simultaneously: the trigger's only two
    // rejection branches match `new.status = 'draft'` or `new.status =
    // 'active'` — there is no third branch for `new.status = 'disabled'`,
    // so a discard is structurally unguarded regardless of the row's
    // slot_key, demonstrated with a real UPDATE against a fresh (non-null
    // slot_key) test row that exercises the identical code path
    // (discardDraftOrganizationRule's `.update({status:'disabled', ...})`)
    // a legacy row would go through.
    // ─────────────────────────────────────────────────────────────────────
    it('a legacy NULL-slot draft cannot be activated — real Lynora row, rejected update never mutates it', async () => {
      const { data: legacyBefore } = await supabaseServer.from('organization_rulebook_rules')
        .select('*').eq('id', 'adff7a2e-48df-4e1c-93cf-42eab231275d').maybeSingle()
      if (!legacyBefore) return // not present in every environment this suite might run against
      expect(legacyBefore.slot_key).toBeNull()

      const { error } = await supabaseServer.from('organization_rulebook_rules')
        .update({ status: 'active', approved_by: 'test-should-never-persist@example.test', effective_from: new Date().toISOString() })
        .eq('id', legacyBefore.id)
      expect(error).toBeTruthy()
      expect(error?.message).toMatch(/cannot become active with a null slot_key/)

      const { data: legacyAfter } = await supabaseServer.from('organization_rulebook_rules')
        .select('*').eq('id', legacyBefore.id).single()
      expect(legacyAfter.status).toBe('draft')
      expect(legacyAfter.slot_key).toBeNull()
      expect(legacyAfter.approved_by).toBeNull()
    })

    it('a draft transitioning to disabled is never blocked by the active/draft slot_key guards, regardless of slot_key — the same code path a legacy discard goes through', async () => {
      const rule = await createOrganizationRule({
        organizationId: orgA, name: 'Discard path, slot_key guard must not interfere', targetField: 'survival.carry_forward', value: true,
        matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'legacy-discard-path-test' }],
        sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })
      await discardDraftOrganizationRule(orgA, rule.id)
      const discarded = await getOrganizationRule(orgA, rule.id)
      expect(discarded?.status).toBe('disabled')
    })

    it('a canonical draft (non-null slot_key) activates normally — the new active-transition guard never blocks a real slot_key', async () => {
      const rule = await createOrganizationRule({
        organizationId: orgA, name: 'Canonical activation, unaffected by the new guard', targetField: 'survival.carry_forward', value: true,
        matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'canonical-activation-guard-test' }],
        sourceKind: 'manual', createdBy: 'admin@org-a.test',
      })
      const activated = await activateOrganizationRule(orgA, rule.id, 'admin@org-a.test', new Date())
      expect(activated.status).toBe('active')
      const { data: raw } = await supabaseServer.from('organization_rulebook_rules').select('slot_key').eq('id', rule.id).single()
      expect(raw?.slot_key).toBeTruthy()
    })
  })
})
