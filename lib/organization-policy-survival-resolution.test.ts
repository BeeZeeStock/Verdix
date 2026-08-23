// End-to-end pure-function coverage for the Contract B "active Organization
// Policy resolves survival.carry_forward automatically" acceptance
// scenarios — exercises the REAL exported resolveProductionOrganizationField
// (lib/rulebook/organization-rulebook-production.ts) and
// buildCreditApplicationRule (lib/credit-application-rule.ts) together,
// exactly as confirm-rule/route.ts composes them, but without any database
// (matchOrganizationRules/resolveProductionOrganizationField are pure and
// operate on a plain in-memory rule array). No RLS/DB gating needed — every
// scenario below (including the draft/scheduled-policy ones) is provable
// from these two pure functions alone.
import { describe, it, expect } from 'vitest'
import { resolveProductionOrganizationField } from './rulebook/organization-rulebook-production'
import { buildCreditApplicationRule } from './credit-application-rule'
import type { OrganizationRuleRecord } from './rulebook/organization-rules'
import type { CurrentFieldState } from './rulebook/organization-rulebook-shadow'

function rebateRule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'org-rule-1',
    organizationId: 'org-a',
    name: 'Rebate carry-forward default',
    description: null,
    targetField: 'survival.carry_forward',
    value: true,
    matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'rebate' }],
    status: 'active',
    version: 1,
    supersedesRuleId: null,
    lineageId: 'org-rule-1',
    sourceKind: 'manual',
    createdBy: 'admin@lynora.test',
    approvedBy: 'admin@lynora.test',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    effectiveFrom: '2026-08-01T00:00:00Z',
    effectiveTo: null,
    ...overrides,
  }
}

const ASOF = new Date('2026-08-23T00:00:00Z')

function resolveFor(ruleType: string, rules: OrganizationRuleRecord[], current: CurrentFieldState = { value: null, provenance: null }) {
  return resolveProductionOrganizationField('survival.carry_forward', {
    organizationId: 'org-a',
    commercialContext: {
      current: { 'survival.carry_forward': current },
      match: { rule_type: ruleType, application: { timing: 'next_invoice' } },
    },
    organizationRules: rules,
    asOf: ASOF,
  })
}

const baseApproved = (carryForward: unknown) => ({ application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: carryForward } })

describe('A. contract silent + active matching org policy -> organization_rulebook, resolved, no reviewer confirmation required', () => {
  it('resolves and clears readiness without any reviewer-supplied survival provenance', () => {
    const resolution = resolveFor('rebate', [rebateRule()])
    expect(resolution.status).toBe('resolved')
    expect(resolution.value).toBe(true)

    const result = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolution)
    expect(result?.survival_provenance).toBe('organization_rulebook')
    expect(result?.carry_forward).toBe(true)
    expect(result?.survival_organization_rule_id).toBe('org-rule-1')
    expect(result?.requires_confirmation).toBe(false)
  })
})

describe('B. contract explicit same value -> contract_derived, org policy not used', () => {
  it('an already contract_derived carry_forward=true is untouched even though a resolved org candidate exists', () => {
    const resolution = resolveFor('rebate', [rebateRule()], { value: true, provenance: 'contract_derived' })
    expect(resolution.status).toBe('not_applicable')

    const result = buildCreditApplicationRule(baseApproved(true), null, { eligibility: 'contract_derived', survival: 'contract_derived' }, resolution)
    expect(result?.carry_forward).toBe(true)
    expect(result?.survival_provenance).toBe('contract_derived')
    expect(result?.survival_organization_rule_id).toBeNull()
  })
})

describe('C. contract explicit opposite value -> contract_derived, org policy not used', () => {
  it('an already contract_derived carry_forward=false is untouched even though the org policy says true', () => {
    const resolution = resolveFor('rebate', [rebateRule()], { value: false, provenance: 'contract_derived' })
    expect(resolution.status).toBe('not_applicable')

    const result = buildCreditApplicationRule(baseApproved(false), null, { eligibility: 'contract_derived', survival: 'contract_derived' }, resolution)
    expect(result?.carry_forward).toBe(false)
    expect(result?.survival_provenance).toBe('contract_derived')
    expect(result?.survival_organization_rule_id).toBeNull()
  })
})

describe('D. active org policy + reviewer override -> reviewer_policy, contract-only, org policy unchanged', () => {
  it('the reviewer explicitly chooses a different value than the active policy; the rule object itself is never touched (no write path exists)', () => {
    const rule = rebateRule()
    const orgApplied = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolveFor('rebate', [rule]))
    expect(orgApplied?.survival_provenance).toBe('organization_rulebook')

    const overridden = buildCreditApplicationRule(baseApproved(false), orgApplied, { eligibility: undefined, survival: 'reviewer_policy' }, undefined)
    expect(overridden?.carry_forward).toBe(false)
    expect(overridden?.survival_provenance).toBe('reviewer_policy')
    expect(overridden?.survival_organization_rule_id).toBeNull()
    // buildCreditApplicationRule has no organizationRules/DB parameter or
    // write path at all — structurally incapable of mutating the rule.
    expect(rule.value).toBe(true)
    expect(rule.status).toBe('active')
  })
})

describe('E. reviewer override -> revert to org policy -> organization_rulebook becomes effective again', () => {
  it('mirrors the "Use organization policy" client action: carry_forward reset to unclear + survival explicitly null re-triggers resolution', () => {
    const rule = rebateRule()
    const orgApplied = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolveFor('rebate', [rule]))
    const overridden = buildCreditApplicationRule(baseApproved(false), orgApplied, { eligibility: undefined, survival: 'reviewer_policy' }, undefined)
    expect(overridden?.survival_provenance).toBe('reviewer_policy')

    // Revert — mirrors confirm-rule/route.ts's requestsReResolution branch:
    // re-resolve against a genuinely-silent "current" (never the stale
    // reviewer_policy value), never hard-coding the previously-seen value.
    const freshResolution = resolveFor('rebate', [rule], { value: null, provenance: null })
    const reverted = buildCreditApplicationRule(baseApproved('unclear'), overridden, { eligibility: undefined, survival: null }, freshResolution)
    expect(reverted?.survival_provenance).toBe('organization_rulebook')
    expect(reverted?.carry_forward).toBe(true)
    expect(reverted?.survival_organization_rule_id).toBe('org-rule-1')
    expect(reverted?.requires_confirmation).toBe(false)
  })

  it('survival: null forces unresolved even when existing already says reviewer_policy — plain undefined would have preserved it instead (the exact distinction the revert signal depends on)', () => {
    const existingReviewerPolicy = buildCreditApplicationRule(baseApproved(false), null, { eligibility: 'contract_derived', survival: 'reviewer_policy' }, undefined)
    expect(existingReviewerPolicy?.survival_provenance).toBe('reviewer_policy')

    const preservedByUndefined = buildCreditApplicationRule({ application_rule: undefined }, existingReviewerPolicy, undefined, undefined)
    expect(preservedByUndefined?.survival_provenance).toBe('reviewer_policy')

    const clearedByNull = buildCreditApplicationRule(baseApproved('unclear'), existingReviewerPolicy, { eligibility: undefined, survival: null }, undefined)
    expect(clearedByNull?.survival_provenance).toBeNull()
    expect(clearedByNull?.requires_confirmation).toBe(true)
  })
})

describe('F. rebate-scoped policy + service credit rule_type -> no match, Decision Required', () => {
  it('a policy scoped to rule_type=rebate never resolves a service_credit', () => {
    const resolution = resolveFor('service_credit', [rebateRule()])
    expect(resolution.status).toBe('not_applicable')

    const result = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolution)
    expect(result?.survival_provenance).toBeNull()
    expect(result?.carry_forward).toBe('unclear')
    expect(result?.requires_confirmation).toBe(true)
  })
})

describe('G. a DRAFT organization policy never auto-resolves', () => {
  it('status=draft is excluded by matchOrganizationRules itself, not just the DB query layer', () => {
    const resolution = resolveFor('rebate', [rebateRule({ status: 'draft', approvedBy: null })])
    expect(resolution.status).toBe('not_applicable')
  })
})

describe('H. a scheduled (future effective_from) policy never applies early', () => {
  it('an active rule whose effective_from is after asOf does not resolve yet', () => {
    const resolution = resolveFor('rebate', [rebateRule({ effectiveFrom: '2026-09-01T00:00:00Z' })])
    expect(resolution.status).toBe('not_applicable')
  })
})

describe('I. the same scheduled policy applies once its effective_from has passed, per the existing temporal matcher', () => {
  it('an asOf on/after effective_from resolves normally — no new temporal model needed', () => {
    const rule = rebateRule({ effectiveFrom: '2026-09-01T00:00:00Z' })
    const resolution = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: { current: { 'survival.carry_forward': { value: null, provenance: null } }, match: { rule_type: 'rebate', application: { timing: 'next_invoice' } } },
      organizationRules: [rule],
      asOf: new Date('2026-09-02T00:00:00Z'),
    })
    expect(resolution.status).toBe('resolved')
    expect(resolution.value).toBe(true)
  })
})

describe('a disabled policy never auto-resolves either', () => {
  it('status=disabled is excluded the same way draft is', () => {
    const resolution = resolveFor('rebate', [rebateRule({ status: 'disabled' })])
    expect(resolution.status).toBe('not_applicable')
  })
})
