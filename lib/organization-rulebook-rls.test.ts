import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'
import {
  createOrganizationRule, supersedeOrganizationRule, activateOrganizationRule, listActiveOrganizationRules, getOrganizationRule,
} from './rulebook/organization-rules-service'

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
// Tenant-isolation + versioning regression test for organization_rulebook_
// rules (supabase/migrations/20260822000001_organization_rulebook_rules.sql).
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
// SKIPPED BY DEFAULT — real network calls, and creates/cleans up two real
// organizations plus their rulebook rows. Run deliberately after applying
// the migration:
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
  it('Org A CAN supersede its own rule -- the new version is created as a DRAFT, never directly active, and the prior one is marked superseded', async () => {
    const newVersion = await supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: orgARuleId, name: 'Org A carry-forward default (v2)',
      targetField: 'survival.carry_forward', value: false,
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
      createdBy: 'owner@org-a-rulebook.test',
    })
    expect(newVersion.version).toBe(2)
    expect(newVersion.supersedesRuleId).toBe(orgARuleId)
    // Safety guarantee (Step 5A review, item 3): supersedeOrganizationRule
    // NEVER produces an active row directly -- there is no parameter that
    // could have made this 'active'.
    expect(newVersion.status).toBe('draft')
    expect(newVersion.approvedBy).toBeNull()

    const previous = await getOrganizationRule(orgAId, orgARuleId)
    expect(previous?.status).toBe('superseded')

    // The new draft is not yet active, so it correctly does NOT appear in
    // listActiveOrganizationRules -- and neither does the now-superseded
    // previous version. This field has ZERO active organization rule right
    // now, which is the safe intermediate state (falls through to Verdix
    // default / remains unresolved), never a stale or duplicated one.
    const activeAfterSupersede = await listActiveOrganizationRules(orgAId)
    expect(activeAfterSupersede.map(r => r.id)).not.toContain(newVersion.id)
    expect(activeAfterSupersede.map(r => r.id)).not.toContain(orgARuleId)

    // Only this SEPARATE, explicit activation step -- reachable only after
    // supersession already succeeded -- promotes the new version.
    const activated = await activateOrganizationRule(orgAId, newVersion.id, 'owner@org-a-rulebook.test')
    expect(activated.status).toBe('active')
    expect(activated.approvedBy).toBe('owner@org-a-rulebook.test')

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

  it('if the previous rule is no longer active when the supersede-update step runs (simulating a lost race), supersedeOrganizationRule throws and the newly-created version stays a harmless, never-activated draft -- the unsafe two-active-versions state is structurally impossible', async () => {
    const raceRule = await createOrganizationRule({
      organizationId: orgAId, name: 'race target', targetField: 'cash_redeemable', value: true,
      matchConditions: [], sourceKind: 'manual', createdBy: 'owner@org-a-rulebook.test',
      status: 'active', approvedBy: 'owner@org-a-rulebook.test',
    })

    // Simulate "someone/something else already changed this row" between
    // supersedeOrganizationRule's own fetch of `previous` and its later
    // update-to-superseded step, by flipping it out of 'active' directly.
    await supabaseServer.from('organization_rulebook_rules').update({ status: 'disabled' }).eq('id', raceRule.id)

    await expect(supersedeOrganizationRule({
      organizationId: orgAId, previousRuleId: raceRule.id, name: 'race v2',
      targetField: 'cash_redeemable', value: false, matchConditions: [], createdBy: 'owner@org-a-rulebook.test',
    })).rejects.toThrow(/failed to mark .* superseded/)

    // The old row is exactly as the race left it -- 'disabled', not
    // magically reactivated, and never a second active row alongside it.
    const raced = await getOrganizationRule(orgAId, raceRule.id)
    expect(raced?.status).toBe('disabled')

    // Any row this failed attempt created (supersedes_rule_id pointing at
    // raceRule.id) is a harmless draft -- never active.
    const { data: leftovers } = await supabaseServer
      .from('organization_rulebook_rules')
      .select('status')
      .eq('organization_id', orgAId)
      .eq('supersedes_rule_id', raceRule.id)
    for (const row of leftovers ?? []) expect(row.status).toBe('draft')

    // And critically: at no point does this field end up with TWO active
    // rows for the same organization/target_field.
    const activeForField = await listActiveOrganizationRules(orgAId)
    expect(activeForField.filter(r => r.targetField === 'cash_redeemable' && r.status === 'active')).toHaveLength(0)
  })
})
