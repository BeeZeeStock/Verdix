// Organization Rulebook — settings-page read model (customer-facing UX
// pass). Pure tests for lib/rulebook/organization-policy-catalog.ts.
import { describe, it, expect } from 'vitest'
import {
  ORGANIZATION_POLICY_CATALOG, buildOrganizationPolicySettingsModel,
} from '@/lib/rulebook/organization-policy-catalog'
import { PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST } from '@/lib/rulebook/organization-rulebook-production'
import { verdixCommercialRulebook } from '@/lib/rulebook/rules'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

function rule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'rule-1', organizationId: 'org-1', name: 'Test rule', description: null,
    targetField: 'survival.carry_forward', value: true, matchConditions: [],
    status: 'active', version: 1, supersedesRuleId: null, lineageId: 'rule-1',
    sourceKind: 'reviewer_promotion', createdBy: 'admin@test.local', approvedBy: 'admin@test.local',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null,
    ...overrides,
  }
}

const asOf = new Date('2026-09-01T00:00:00.000Z')

describe('ORGANIZATION_POLICY_CATALOG — supported policy TYPES, derived from the production allowlist, never a second list', () => {
  it('has exactly one entry per allowlisted field, in allowlist order', () => {
    expect(ORGANIZATION_POLICY_CATALOG.map(p => p.field)).toEqual([...PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST])
  })
  it('never exposes the raw internal field name as its customer-facing title', () => {
    for (const def of ORGANIZATION_POLICY_CATALOG) {
      expect(def.title).not.toContain(def.field)
      expect(def.title.toLowerCase()).not.toContain('survival')
      expect(def.title.toLowerCase()).not.toContain('carry_forward')
    }
  })
  it('a catalog entry describes a CAPABILITY, never assigns a policy value — no true/false/default treatment anywhere on the definition', () => {
    for (const def of ORGANIZATION_POLICY_CATALOG) {
      const serialized = JSON.stringify(def)
      // The definition must never itself carry a boolean treatment value —
      // only real organization_rulebook_rules rows (layer C) may.
      expect(def).not.toHaveProperty('value')
      expect(def).not.toHaveProperty('defaultValue')
      expect(def.suggestedTemplates).toBeUndefined()
      expect(serialized.toLowerCase()).not.toContain('"value":true')
      expect(serialized.toLowerCase()).not.toContain('"value":false')
    }
  })
  it('the Verdix Global Rulebook (9 product-wide rules) is a completely separate module — the catalog never references it', () => {
    expect(verdixCommercialRulebook.length).toBe(9)
    // The catalog's own fields are exclusively drawn from the production
    // ORGANIZATION allowlist, never from Global Rulebook rule ids.
    const globalRuleIds = verdixCommercialRulebook.map(r => r.id)
    for (const def of ORGANIZATION_POLICY_CATALOG) {
      expect(globalRuleIds).not.toContain(def.field)
    }
  })
})

describe('buildOrganizationPolicySettingsModel', () => {
  it('1 supported type + zero organization rules -> supportedTypes=1 / configuredPolicies=0 / not_configured card with no displayed value', () => {
    const model = buildOrganizationPolicySettingsModel([], asOf)
    expect(model.summary).toEqual({ supportedTypes: 1, configuredPolicies: 0, drafts: 0 })
    expect(model.policyTypes).toHaveLength(1)
    expect(model.policyTypes[0].state).toBe('not_configured')
    expect(model.policyTypes[0].activeRules).toEqual([])
    expect(model.policyTypes[0].scheduledRules).toEqual([])
    expect(model.policyTypes[0].draftRules).toEqual([])
    expect(model.policyTypes[0].history).toEqual([])
  })

  it('an active rule -> this is now an actual organization policy: configuredPolicies=1 / active state / value present in activeRules', () => {
    const active = rule({ id: 'r1', status: 'active', effectiveFrom: '2026-01-01T00:00:00.000Z' })
    const model = buildOrganizationPolicySettingsModel([active], asOf)
    expect(model.summary.configuredPolicies).toBe(1)
    expect(model.policyTypes[0].state).toBe('active')
    expect(model.policyTypes[0].activeRules).toEqual([active])
  })

  it('a future-effective rule only -> scheduled state, counted as configured', () => {
    const future = rule({ id: 'r1', status: 'active', effectiveFrom: '2027-01-01T00:00:00.000Z' })
    const model = buildOrganizationPolicySettingsModel([future], asOf)
    expect(model.policyTypes[0].state).toBe('scheduled')
    expect(model.policyTypes[0].scheduledRules).toEqual([future])
    expect(model.summary.configuredPolicies).toBe(1)
  })

  it('an active rule + a future replacement -> active_with_scheduled_change, both surfaced distinctly', () => {
    const active = rule({ id: 'r1', status: 'active', effectiveFrom: '2026-01-01T00:00:00.000Z' })
    const future = rule({ id: 'r2', status: 'active', effectiveFrom: '2027-01-01T00:00:00.000Z', supersedesRuleId: 'r1' })
    const model = buildOrganizationPolicySettingsModel([active, future], asOf)
    expect(model.policyTypes[0].state).toBe('active_with_scheduled_change')
    expect(model.policyTypes[0].activeRules).toEqual([active])
    expect(model.policyTypes[0].scheduledRules).toEqual([future])
  })

  it('a draft only -> draft state, NOT counted as configured (a draft is a policy record, but not yet an active organization default)', () => {
    const draft = rule({ id: 'r1', status: 'draft', approvedBy: null, effectiveFrom: null })
    const model = buildOrganizationPolicySettingsModel([draft], asOf)
    expect(model.policyTypes[0].state).toBe('draft')
    expect(model.policyTypes[0].draftRules).toEqual([draft])
    expect(model.summary.configuredPolicies).toBe(0)
    expect(model.summary.drafts).toBe(1)
  })

  it('superseded history is available but never counted as configured and never shown as active', () => {
    const superseded = rule({ id: 'r1', status: 'superseded', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-06-01T00:00:00.000Z' })
    const model = buildOrganizationPolicySettingsModel([superseded], asOf)
    expect(model.policyTypes[0].state).toBe('not_configured')
    expect(model.policyTypes[0].history).toEqual([superseded])
    expect(model.summary.configuredPolicies).toBe(0)
  })

  it('disabled history is available but never counted as configured', () => {
    const disabled = rule({ id: 'r1', status: 'disabled', approvedBy: null })
    const model = buildOrganizationPolicySettingsModel([disabled], asOf)
    expect(model.policyTypes[0].state).toBe('not_configured')
    expect(model.policyTypes[0].history).toEqual([disabled])
  })

  it('multiple scoped active rules for the same field (different match_conditions) are ALL represented, never collapsed', () => {
    const serviceCredit = rule({
      id: 'r1', matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }], value: true,
    })
    const rebate = rule({
      id: 'r2', matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'rebate' }], value: false,
    })
    const model = buildOrganizationPolicySettingsModel([serviceCredit, rebate], asOf)
    expect(model.policyTypes[0].activeRules).toHaveLength(2)
    expect(model.policyTypes[0].activeRules.map(r => r.id).sort()).toEqual(['r1', 'r2'])
  })

  it('a rule targeting a field OUTSIDE the production allowlist is never shown as a supported policy type', () => {
    const shadowOnly = rule({ id: 'r1', targetField: 'cash_redeemable', status: 'active' })
    const model = buildOrganizationPolicySettingsModel([shadowOnly], asOf)
    // Still exactly the 1 catalog entry (survival.carry_forward) — the
    // shadow-only field's rule is simply not represented anywhere.
    expect(model.policyTypes).toHaveLength(1)
    expect(model.policyTypes[0].field).toBe('survival.carry_forward')
    expect(model.policyTypes[0].state).toBe('not_configured')
    const allRuleIds = model.policyTypes.flatMap(p => [...p.activeRules, ...p.scheduledRules, ...p.draftRules, ...p.history]).map(r => r.id)
    expect(allRuleIds).not.toContain('r1')
  })

  it('two different organizations see the SAME supported types but their own, independent configured policies (tenant isolation at the read-model level)', () => {
    const orgARule = rule({ id: 'r1', organizationId: 'org-a', status: 'active' })
    // Model A is built from only org A's rules (the caller is responsible
    // for org-scoping the query — this function trusts its input, exactly
    // like every other pure function in this codebase).
    const modelA = buildOrganizationPolicySettingsModel([orgARule], asOf)
    const modelB = buildOrganizationPolicySettingsModel([], asOf)
    expect(modelA.summary.supportedTypes).toBe(modelB.summary.supportedTypes)
    expect(modelA.summary.configuredPolicies).toBe(1)
    expect(modelB.summary.configuredPolicies).toBe(0)
    expect(modelB.policyTypes[0].activeRules).toEqual([])
  })
})
