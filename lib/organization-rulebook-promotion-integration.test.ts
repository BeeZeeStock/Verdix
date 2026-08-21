import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { supabaseServer } from './supabase'
import {
  createOrganizationRule, activateOrganizationRule, supersedeOrganizationRule,
  listAllOrganizationRules, listMatchableOrganizationRules, listActiveOrganizationRules,
  getOrganizationRule, findActiveRuleForSameSlot, discardDraftOrganizationRule,
  updateOrganizationRuleDescription,
} from './rulebook/organization-rules-service'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from './rulebook/organization-rulebook-promotion'
import { matchOrganizationRules } from './rulebook/organization-rules'

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

    // "Replace from effective date" — re-derive a properly-linked successor
    // via the EXISTING supersedeOrganizationRule (not a new mechanism),
    // activate it, then discard the orphaned standalone draft — exactly
    // app/api/org/rulebook/[id]/activate/route.ts's confirmReplace path.
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
    await discardDraftOrganizationRule(orgA, standaloneDraft.id)

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
})
