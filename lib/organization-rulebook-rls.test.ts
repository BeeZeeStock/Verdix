import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'
import {
  createOrganizationRule, supersedeOrganizationRule, activateOrganizationRule,
  listActiveOrganizationRules, listMatchableOrganizationRules, getOrganizationRule,
} from './rulebook/organization-rules-service'
import { matchOrganizationRules } from './rulebook/organization-rules'
import { loadAndResolveOrganizationRulebookShadow } from './rulebook/organization-rulebook-shadow-service'

// Organizations are created directly via supabaseServer (never lib/org.ts's
// createOrg) — lib/org.ts imports lib/auth.ts, which transitively pulls in
// next-auth, which fails to resolve under plain vitest (no Next.js
// runtime). Same convention already used by lib/credit-ledger-integration
// .test.ts for exactly this reason.
async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-isolation + versioning + temporal-validity regression test for
// organization_rulebook_rules (supabase/migrations/20260822000001_
// organization_rulebook_rules.sql,
// 20260823000001_organization_rulebook_temporal_validity.sql).
//
// Same architecture note as lib/rls-isolation.test.ts / lib/credit-ledger-
// rls.test.ts: this app never issues per-user Supabase Auth sessions to the
// browser, so the database-layer boundary tested here is "can the anon key
// (shipped to every browser) reach this table at all" — answer must be no.
// The REAL per-organization isolation boundary (Org A can never read/write
// Org B's rows) is application code — lib/rulebook/organization-rules-
// service.ts's queries, always filtered by a trusted organization_id — so
// this file also exercises that service module directly against two real
// organizations, proving Org A's calls structurally cannot reach Org B's
// rows even though both go through the same service-role client.
//
// SKIPPED BY DEFAULT — real network calls, and creates/cleans up real
// organizations plus their rulebook rows. Run deliberately after applying
// BOTH migrations:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/organization-rulebook-rls.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

describeIf('organization_rulebook_rules — anon key must not reach it', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows', async () => {
    const { data, error } = await anon.from('organization_rulebook_rules').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT via anon key is rejected', async () => {
    const { error } = await anon.from('organization_rulebook_rules').insert({
      organization_id: '00000000-0000-0000-0000-000000000000',
      name: 'anon-test',
      target_field: 'survival.carry_forward',
      value_json: true,
      created_by: 'anon-test@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE via anon key affects no rows', async () => {
    const { error, data } = await anon
      .from('organization_rulebook_rules')
      .update({ status: 'active' })
      .eq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('the activate_organization_rule_supersession RPC is not callable with the anon key', async () => {
    const { error } = await anon.rpc('activate_organization_rule_supersession', {
      p_organization_id: '00000000-0000-0000-0000-000000000000',
      p_new_rule_id: '00000000-0000-0000-0000-000000000000',
      p_approved_by: 'anon-test@isolation-test.invalid',
      p_effective_at: new Date().toISOString(),
    })
    expect(error).toBeTruthy()
  })
})

describeIf('organization_rulebook_rules — database CHECK constraint: no rule is ever active without an explicit approver', () => {
  let orgId: string

  beforeAll(async () => {
    orgId = await createTestOrg('Org Rulebook Constraint Test')
  })
  afterAll(async () => {
    await supabaseServer.from('organization_rulebook_rules').delete().eq('organization_id', orgId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('service-layer rejects status "active" with no approvedBy before ever reaching the database', async () => {
    await expect(createOrganizationRule({
      organizationId: orgId, name: 'bad', targetField: 'survival.carry_forward', value: true,
      matchConditions: [], sourceKind: 'manual', createdBy: 'test@isolation-test.invalid', status: 'active',
    })).rejects.toThrow(/approvedBy/)
  })

  it('a direct database insert bypassing the service layer is still rejected by the CHECK constraint', async () => {
    const { error } = await supabaseServer.from('organization_rulebook_rules').insert({
      organization_id: orgId, name: 'bad-direct', target_field: 'survival.carry_forward',
      value_json: true, status: 'active', approved_by: null, created_by: 'test@isolation-test.invalid',
      lineage_id: randomUUID(),
    })
    expect(error).toBeTruthy()
  })

  it('an unapproved verdix_pattern_suggestion cannot be inserted as active either -- the constraint applies uniformly regardless of source_kind', async () => {
    await expect(createOrganizationRule({
      organizationId: orgId, name: 'suggestion', targetField: 'survival.carry_forward', value: true,
      matchConditions: [], sourceKind: 'verdix_pattern_suggestion', createdBy: 'verdix-suggestion-engine',
      status: 'active', approvedBy: null,
    })).rejects.toThrow(/approvedBy/)
  })
})

describeIf('organization_rulebook_rules — application-layer tenant isolation (the real boundary)', () => {
  let orgAId: string
  let orgBId: string
  let orgARuleId: string

  beforeAll(async () => {
    orgAId = await createTestOrg('Org Rulebook Test A')
    orgBId = await createTestOrg('Org Rulebook Test B')

    const rule = await createOrganizationRule({
      organizationId: orgAId, name: 'Org A carry-forward default', targetField: 'survival.carry_forward',
      value: true, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
      sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test', status: 'active', approvedBy: 'owner@org-a-rulebook.test',
    })
    orgARuleId = rule.id
  })
  afterAll(async () => {
    await supabaseServer.from('organization_rulebook_rules').delete().in('organization_id', [orgAId, orgBId])
    await supabaseServer.from('organizations').delete().in('id', [orgAId, orgBId])
  })

  it('Org A can read its own rule via listActiveOrganizationRules', async () => {
    const rules = await listActiveOrganizationRules(orgAId)
    expect(rules.map(r => r.id)).toContain(orgARuleId)
  })
  it('Org B cannot read Org A\'s rule -- listActiveOrganizationRules(orgB) never includes it', async () => {
    const rules = await listActiveOrganizationRules(orgBId)
    expect(rules.map(r => r.id)).not.toContain(orgARuleId)
  })
  it('Org B cannot fetch Org A\'s rule directly by id via getOrganizationRule either', async () => {
    const rule = await getOrganizationRule(orgBId, orgARuleId)
    expect(rule).toBeNull()
  })
  it('Org B cannot supersede (mutate) Org A\'s rule -- the org-scoped lookup fails before any write is attempted', async () => {
    await expect(supersedeOrganizationRule({
      organizationId: orgBId, previousRuleId: orgARuleId, name: 'hijacked', targetField: 'survival.carry_forward',
      value: false, matchConditions: [], createdBy: 'attacker@org-b-rulebook.test',
    })).rejects.toThrow(/not found/)

    // Confirm Org A's rule is completely unaffected by the rejected attempt.
    const stillOrgAsOriginal = await getOrganizationRule(orgAId, orgARuleId)
    expect(stillOrgAsOriginal?.value).toBe(true)
    expect(stillOrgAsOriginal?.status).toBe('active')
  })
  it('Org A CAN supersede its own rule -- the new version is created as a DRAFT (predecessor stays active, untouched) until a separate, atomic activation', async () => {
    const newVersion = await supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: orgARuleId, name: 'Org A carry-forward default (v2)',
      targetField: 'survival.carry_forward', value: false,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
      createdBy: 'owner@org-a-rulebook.test',
    })
    expect(newVersion.version).toBe(2)
    expect(newVersion.supersedesRuleId).toBe(orgARuleId)
    expect(newVersion.lineageId).toBe(orgARuleId) // inherited from the predecessor's own lineage
    // Safety guarantee (Step 5A, refined Step 5B.5): supersedeOrganizationRule
    // NEVER produces an active row directly, and does NOT touch the
    // predecessor's status/timestamps at all.
    expect(newVersion.status).toBe('draft')
    expect(newVersion.approvedBy).toBeNull()
    expect(newVersion.effectiveFrom).toBeNull()

    const previousStillActive = await getOrganizationRule(orgAId, orgARuleId)
    expect(previousStillActive?.status).toBe('active') // NOT yet superseded
    expect(previousStillActive?.effectiveTo).toBeNull()

    // Only this SEPARATE, atomic activation call — reachable only after
    // supersession already succeeded — retires the predecessor AND
    // promotes the new version, together. Real "now", not a fixed
    // calendar date — activate_organization_rule_supersession rejects a
    // clearly retroactive effective_at (Step 5B.5 review item 3; see the
    // dedicated tests below), so this cutover must be genuinely current.
    const cutover = new Date()
    const activated = await activateOrganizationRule(orgAId, newVersion.id, 'owner@org-a-rulebook.test', cutover)
    expect(activated.status).toBe('active')
    expect(activated.approvedBy).toBe('owner@org-a-rulebook.test')
    // Compared as parsed instants, not raw strings -- Postgres/PostgREST's
    // timestamptz serialization format need not byte-match JS's
    // toISOString() (e.g. offset notation, sub-millisecond precision).
    expect(new Date(activated.effectiveFrom!).getTime()).toBe(cutover.getTime())

    const previousNow = await getOrganizationRule(orgAId, orgARuleId)
    expect(previousNow?.status).toBe('superseded')
    // No ambiguous overlap at exactly T: predecessor's effectiveTo equals
    // the successor's effectiveFrom, to the millisecond.
    expect(new Date(previousNow!.effectiveTo!).getTime()).toBe(cutover.getTime())
    expect(previousNow?.effectiveTo).toBe(activated.effectiveFrom)

    const activeAfterActivation = await listActiveOrganizationRules(orgAId)
    expect(activeAfterActivation.map(r => r.id)).toContain(newVersion.id)
    expect(activeAfterActivation.map(r => r.id)).not.toContain(orgARuleId)
  })

  it('activateOrganizationRule refuses to activate without an explicit approvedBy', async () => {
    const draft = await createOrganizationRule({
      organizationId: orgAId, name: 'needs approval', targetField: 'survival.one_time', value: true,
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
    })
    // @ts-expect-error -- deliberately omitting the required approvedBy
    await expect(activateOrganizationRule(orgAId, draft.id, undefined)).rejects.toThrow(/approvedBy/)
  })

  // Step 5B.5 review item 3 — the chosen product invariant: an ordinary
  // activation may not backdate effective_at into the past (beyond a
  // small request-latency grace window), but a future-dated activation is
  // always fine.
  it('activateOrganizationRule rejects a clearly retroactive effectiveAt -- must not silently rewrite what policy was authoritative during an already-invoiced period', async () => {
    const draft = await createOrganizationRule({
      organizationId: orgAId, name: 'retroactive attempt', targetField: 'application.eligible_component_keys', value: ['x'],
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
    })
    const wayInThePast = new Date('2020-01-01T00:00:00.000Z')
    await expect(
      activateOrganizationRule(orgAId, draft.id, 'owner@org-a-rulebook.test', wayInThePast),
    ).rejects.toThrow(/retroactive/)

    // Never activated -- the whole transaction rolled back.
    const after = await getOrganizationRule(orgAId, draft.id)
    expect(after?.status).toBe('draft')
    expect(after?.effectiveFrom).toBeNull()
  })
  it('activateOrganizationRule ACCEPTS a future-dated effectiveAt -- future-dating is a legitimate scheduled activation, not backdating', async () => {
    const draft = await createOrganizationRule({
      organizationId: orgAId, name: 'future-dated activation', targetField: 'cash_redeemable', value: false,
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
    })
    const oneYearFromNow = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    const activated = await activateOrganizationRule(orgAId, draft.id, 'owner@org-a-rulebook.test', oneYearFromNow)
    expect(activated.status).toBe('active')
    expect(new Date(activated.effectiveFrom!).getTime()).toBe(oneYearFromNow.getTime())

    // The temporal matcher correctly does NOT surface it as a candidate
    // yet -- it only becomes eligible once asOf reaches that future instant.
    const rules = await listMatchableOrganizationRules(orgAId)
    const rightNow = matchOrganizationRules(orgAId, { context: {}, contractResolvedFields: new Set() }, rules, new Date())
    expect(rightNow.map(r => r.id)).not.toContain(activated.id)
    const afterItsFutureEffectiveDate = matchOrganizationRules(orgAId, { context: {}, contractResolvedFields: new Set() }, rules, oneYearFromNow)
    expect(afterItsFutureEffectiveDate.map(r => r.id)).toContain(activated.id)
  })

  it('failed activation (predecessor no longer active) leaves the predecessor exactly as it was and the draft never activates -- the unsafe two-active-versions state is structurally impossible', async () => {
    // A unique match_conditions discriminator (not just cash_redeemable + [])
    // so this test's slot cannot collide with the "future-dated
    // effectiveAt" test above, which also targets cash_redeemable within
    // this same shared org — org_rulebook_no_overlapping_scope is keyed on
    // (organization_id, target_field, match_conditions_json), so two
    // otherwise-unrelated tests reusing the identical empty [] conditions
    // on the same field would otherwise collide with each other, not with
    // anything this test is actually trying to exercise.
    const raceConditions = [{ field: 'rule_type', operator: 'eq' as const, value: 'race-test-only' }]
    const raceRule = await createOrganizationRule({
      organizationId: orgAId, name: 'race target', targetField: 'cash_redeemable', value: true,
      matchConditions: raceConditions, sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
      status: 'active', approvedBy: 'owner@org-a-rulebook.test',
    })
    const draftSuccessor = await supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: raceRule.id, name: 'race v2',
      targetField: 'cash_redeemable', value: false, matchConditions: raceConditions, createdBy: 'owner@org-a-rulebook.test',
    })

    // Simulate a concurrent change that took the predecessor out of
    // 'active' between supersedeOrganizationRule creating the draft and
    // someone attempting to activate it.
    await supabaseServer.from('organization_rulebook_rules').update({ status: 'disabled' }).eq('id', raceRule.id)

    await expect(
      activateOrganizationRule(orgAId, draftSuccessor.id, 'owner@org-a-rulebook.test', new Date()),
    ).rejects.toThrow(/not currently active/)

    // The RPC's transaction rolled back entirely: predecessor is exactly
    // as the race left it ('disabled', not reactivated, no effective_to
    // written), and the draft was never activated.
    const predecessor = await getOrganizationRule(orgAId, raceRule.id)
    expect(predecessor?.status).toBe('disabled')
    expect(predecessor?.effectiveTo).toBeNull()

    const draftAfter = await getOrganizationRule(orgAId, draftSuccessor.id)
    expect(draftAfter?.status).toBe('draft')
    expect(draftAfter?.effectiveFrom).toBeNull()
    expect(draftAfter?.approvedBy).toBeNull()

    // Neither the (now-disabled) predecessor nor the (still-draft)
    // successor is active -- checked by id, not by bare targetField,
    // since an unrelated earlier test in this same shared org also
    // legitimately has an active cash_redeemable row (a different slot,
    // via a different match_conditions discriminator: the future-dated
    // effectiveAt test above) that must NOT be mistaken for a leftover
    // of this race.
    const activeForField = await listActiveOrganizationRules(orgAId)
    expect(activeForField.map(r => r.id)).not.toContain(raceRule.id)
    expect(activeForField.map(r => r.id)).not.toContain(draftSuccessor.id)
  })

  it('two draft successors of the same predecessor cannot both become authoritative -- the second activation attempt fails once the first has already retired the predecessor', async () => {
    const original = await createOrganizationRule({
      organizationId: orgAId, name: 'contested field', targetField: 'application.eligible_component_keys', value: ['a'],
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
      status: 'active', approvedBy: 'owner@org-a-rulebook.test',
    })
    const successorOne = await supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: original.id, name: 'successor 1',
      targetField: 'application.eligible_component_keys', value: ['b'], matchConditions: [], createdBy: 'owner@org-a-rulebook.test',
    })
    const successorTwo = await supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: original.id, name: 'successor 2',
      targetField: 'application.eligible_component_keys', value: ['c'], matchConditions: [], createdBy: 'owner@org-a-rulebook.test',
    })

    const firstActivation = await activateOrganizationRule(orgAId, successorOne.id, 'owner@org-a-rulebook.test', new Date())
    expect(firstActivation.status).toBe('active')

    await expect(
      activateOrganizationRule(orgAId, successorTwo.id, 'owner@org-a-rulebook.test', new Date()),
    ).rejects.toThrow(/not currently active/)

    const successorTwoAfter = await getOrganizationRule(orgAId, successorTwo.id)
    expect(successorTwoAfter?.status).toBe('draft') // never activated

    const activeForField = await listActiveOrganizationRules(orgAId)
    const activeMatches = activeForField.filter(r => r.targetField === 'application.eligible_component_keys')
    expect(activeMatches).toHaveLength(1)
    expect(activeMatches[0].id).toBe(successorOne.id)
  })

  it('the database-level exclusion constraint rejects an overlapping validity window even when written directly, bypassing the RPC entirely', async () => {
    const base = await createOrganizationRule({
      organizationId: orgAId, name: 'overlap-guard base', targetField: 'survival.one_time', value: true,
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
      status: 'active', approvedBy: 'owner@org-a-rulebook.test', effectiveFrom: '2026-01-01T00:00:00.000Z',
    })
    // Attempt to insert a second row in the SAME lineage, also 'active',
    // whose validity window plainly overlaps the first (no effective_to on
    // either) -- must be rejected by org_rulebook_no_overlapping_validity,
    // not merely by application code (nothing in this test goes through
    // organization-rules-service.ts at all for this second insert).
    const { error } = await supabaseServer.from('organization_rulebook_rules').insert({
      organization_id: orgAId, name: 'overlap-guard intruder', target_field: 'survival.one_time',
      value_json: false, status: 'active', approved_by: 'owner@org-a-rulebook.test',
      created_by: 'owner@org-a-rulebook.test', lineage_id: base.lineageId,
      effective_from: '2026-02-01T00:00:00.000Z',
    })
    expect(error).toBeTruthy()
  })
})

// Step 5B.5 review item 1 — the exact scenario from the review: two
// INDEPENDENT lineages (never linked via supersedes_rule_id at all)
// describing the identical organization-policy slot (same organization,
// same target_field, same match_conditions) must not both be able to
// become authoritative for an overlapping time window. lineage_id alone
// cannot catch this (by definition the two lineages have different
// lineage_ids) -- org_rulebook_no_overlapping_scope is the constraint
// that does. Given its own dedicated, isolated org (rather than sharing
// orgAId with the many tests above) so its choice of target_field/
// match_conditions can never accidentally collide with an unrelated
// test's own already-active slot.
describeIf('organization_rulebook_rules — cross-lineage slot uniqueness (Step 5B.5 review item 1)', () => {
  let orgId: string
  beforeAll(async () => { orgId = await createTestOrg('Org Rulebook Cross-Lineage Test') })
  afterAll(async () => {
    await supabaseServer.from('organization_rulebook_rules').delete().eq('organization_id', orgId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  it('a second, INDEPENDENT lineage describing the identical policy slot (organization + target_field + match_conditions) with an overlapping validity window is rejected by the database, even though it shares no lineage_id with the first', async () => {
    const sharedConditions = [{ field: 'rule_type', operator: 'eq' as const, value: 'service_credit' }]
    const lineageX = await createOrganizationRule({
      organizationId: orgId, name: 'Lineage X', targetField: 'survival.carry_forward', value: true,
      matchConditions: sharedConditions, sourceKind: 'manual', createdBy: 'owner@org-hist.test',
      status: 'active', approvedBy: 'owner@org-hist.test', effectiveFrom: '2026-01-01T00:00:00.000Z',
    })
    // A genuinely separate lineage -- created via createOrganizationRule
    // (a fresh row, its OWN lineage_id), never supersedeOrganizationRule.
    await expect(createOrganizationRule({
      organizationId: orgId, name: 'Lineage Y', targetField: 'survival.carry_forward', value: false,
      matchConditions: sharedConditions, sourceKind: 'manual', createdBy: 'owner@org-hist.test',
      status: 'active', approvedBy: 'owner@org-hist.test', effectiveFrom: '2026-03-01T00:00:00.000Z', // overlaps Lineage X's still-open window
    })).rejects.toThrow()

    // Confirm they are indeed different lineages (proving this rejection
    // came from the slot-scoped constraint, not the lineage-scoped one).
    expect(lineageX.lineageId).toBe(lineageX.id)
  })

  it('the SAME two policies do NOT collide if their validity windows genuinely do not overlap (proves the constraint checks time, not just identity)', async () => {
    const sharedConditions = [{ field: 'rule_type', operator: 'eq' as const, value: 'service_credit' }]
    const lineageX = await createOrganizationRule({
      organizationId: orgId, name: 'Lineage X non-overlapping', targetField: 'application.timing', value: 'x',
      matchConditions: sharedConditions, sourceKind: 'manual', createdBy: 'owner@org-hist.test',
      status: 'active', approvedBy: 'owner@org-hist.test', effectiveFrom: '2026-01-01T00:00:00.000Z',
    })
    // createOrganizationRule has no effectiveTo parameter (only
    // activate_organization_rule_supersession ever sets it as part of a
    // real supersession) -- set it directly here purely to construct this
    // fixture's "already closed" window.
    await supabaseServer.from('organization_rulebook_rules').update({ effective_to: '2026-06-01T00:00:00.000Z' }).eq('id', lineageX.id)

    // A distinct row, distinct lineage, SAME slot, but its window starts
    // exactly where the first one's ends -- no overlap, must succeed.
    const lineageY = await createOrganizationRule({
      organizationId: orgId, name: 'Lineage Y non-overlapping', targetField: 'application.timing', value: 'y',
      matchConditions: sharedConditions, sourceKind: 'manual', createdBy: 'owner@org-hist.test',
      status: 'active', approvedBy: 'owner@org-hist.test', effectiveFrom: '2026-06-01T00:00:00.000Z',
    })
    expect(lineageY.status).toBe('active')
  })
})

// Step 5B.5 items 1, 4, 6, 9 — full historical-reproduction matrix, driven
// entirely through the real, migrated database (createOrganizationRule ->
// supersedeOrganizationRule -> activateOrganizationRule), then read back
// via listMatchableOrganizationRules + the unmodified matchOrganizationRules
// and loadAndResolveOrganizationRulebookShadow.
describeIf('organization_rulebook_rules — historical validity end to end (Step 5B.5)', () => {
  let orgId: string
  let ruleAId: string
  let ruleBId: string
  // Rule A's effectiveFrom is set directly via createOrganizationRule
  // (unrestricted — no existing authoritative record is being retired by
  // a brand-new rule), so a fixed past calendar date is fine there. The
  // CUTOVER (Rule B's activation) goes through the guarded RPC, which
  // rejects a clearly retroactive effective_at (Step 5B.5 review item 3)
  // — so it must be real "now", captured at test-run time, not a fixed
  // 2026 date that may itself be in the past by the time this runs.
  const RULE_A_START = new Date('2026-01-01T00:00:00.000Z')
  let cutover: Date

  beforeAll(async () => {
    orgId = await createTestOrg('Org Rulebook Historical Test')
    const ruleA = await createOrganizationRule({
      organizationId: orgId, name: 'Rule A', targetField: 'survival.carry_forward', value: 'rule-a-value',
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
      sourceKind: 'manual', createdBy: 'owner@org-hist.test', status: 'active', approvedBy: 'owner@org-hist.test',
      effectiveFrom: RULE_A_START.toISOString(),
    })
    ruleAId = ruleA.id
    const ruleBDraft = await supersedeOrganizationRule({
      organizationId: orgId, previousRuleId: ruleAId, name: 'Rule B',
      targetField: 'survival.carry_forward', value: 'rule-b-value',
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
      createdBy: 'owner@org-hist.test',
    })
    cutover = new Date()
    const ruleB = await activateOrganizationRule(orgId, ruleBDraft.id, 'owner@org-hist.test', cutover)
    ruleBId = ruleB.id
  })
  afterAll(async () => {
    await supabaseServer.from('organization_rulebook_rules').delete().eq('organization_id', orgId)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })

  const matchContext = { context: { rule_type: 'service_credit' }, contractResolvedFields: new Set<string>() }

  it('before Rule A even started -> no match', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    expect(matchOrganizationRules(orgId, matchContext, rules, new Date('2025-12-31T23:59:59.999Z'))).toEqual([])
  })
  it('Rule A\'s exact start -> Rule A', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    const matched = matchOrganizationRules(orgId, matchContext, rules, RULE_A_START)
    expect(matched.map(r => r.id)).toEqual([ruleAId])
  })
  it('the instant just before cutover (still inside Rule A\'s window) -> Rule A', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    const matched = matchOrganizationRules(orgId, matchContext, rules, new Date(cutover.getTime() - 1))
    expect(matched.map(r => r.id)).toEqual([ruleAId])
  })
  it('exactly at the cutover -> Rule B', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    const matched = matchOrganizationRules(orgId, matchContext, rules, cutover)
    expect(matched.map(r => r.id)).toEqual([ruleBId])
  })
  it('well after the cutover -> Rule B', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    const matched = matchOrganizationRules(orgId, matchContext, rules, new Date(cutover.getTime() + 24 * 60 * 60 * 1000))
    expect(matched.map(r => r.id)).toEqual([ruleBId])
  })
  it('deterministic across repeated calls for the same historical asOf', async () => {
    const rules = await listMatchableOrganizationRules(orgId)
    const asOf = new Date('2026-04-01T00:00:00.000Z')
    const first = matchOrganizationRules(orgId, matchContext, rules, asOf)
    const second = matchOrganizationRules(orgId, matchContext, rules, asOf)
    expect(second).toEqual(first)
  })
  it('the Step 5B shadow resolver reproduces the correct historical organization candidate end to end', async () => {
    const commercialContext = { current: { 'survival.carry_forward': { value: null, provenance: null } }, match: { rule_type: 'service_credit' } }
    const historical = await loadAndResolveOrganizationRulebookShadow({ organizationId: orgId, commercialContext, asOf: new Date('2026-04-01T00:00:00.000Z') })
    const current = await loadAndResolveOrganizationRulebookShadow({ organizationId: orgId, commercialContext, asOf: new Date(cutover.getTime() + 24 * 60 * 60 * 1000) })
    expect(historical.find(r => r.field === 'survival.carry_forward')?.organizationCandidate).toMatchObject({ value: 'rule-a-value', ruleId: ruleAId })
    expect(current.find(r => r.field === 'survival.carry_forward')?.organizationCandidate).toMatchObject({ value: 'rule-b-value', ruleId: ruleBId })
  })
  it('historical Org A policy never leaks to a differently-scoped Org B query, even for the identical historical asOf', async () => {
    const otherOrgId = await createTestOrg('Org Rulebook Historical Test B')
    try {
      const rules = await listMatchableOrganizationRules(otherOrgId)
      expect(rules).toEqual([])
      expect(matchOrganizationRules(otherOrgId, matchContext, rules, new Date('2026-04-01T00:00:00.000Z'))).toEqual([])
    } finally {
      await supabaseServer.from('organizations').delete().eq('id', otherOrgId)
    }
  })
})
