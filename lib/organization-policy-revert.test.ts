// Final safety-check amendment — adversarial regression coverage for
// resolveOrganizationPolicyRevert, the server-authoritative decision behind
// "Use organization policy". Every scenario here is specifically about
// preventing a crafted/stale request from either (a) clearing a
// higher-authority contract_derived value, or (b) silently leaving a field
// unresolved instead of failing closed when no active policy applies
// anymore.
import { describe, it, expect } from 'vitest'
import { resolveOrganizationPolicyRevert } from './organization-policy-revert'
import type { OrganizationRuleRecord } from './rulebook/organization-rules'

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
const baseInput = {
  organizationId: 'org-a',
  ruleType: 'rebate',
  asOf: ASOF,
}

describe('resolveOrganizationPolicyRevert', () => {
  it('reviewer_policy + matching active org policy -> eligible, resolved, carries the real rule id/version/value', () => {
    const rule = rebateRule()
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.resolution.status).toBe('resolved')
    expect(result.resolution.value).toBe(true)
    expect(result.resolution.ruleId).toBe('org-rule-1')
    expect(result.resolution.ruleVersion).toBe(1)
  })

  it('reviewer_policy + policy disabled between render and click -> revert rejected, policy_no_longer_applicable', () => {
    const rule = rebateRule({ status: 'disabled' })
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'policy_no_longer_applicable' })
  })

  it('reviewer_policy + policy superseded by a currently-applicable successor -> uses the successor\'s own id/version, per the existing temporal matcher', () => {
    const predecessor = rebateRule({
      id: 'org-rule-1', version: 1, value: false, status: 'superseded',
      effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-08-10T00:00:00Z',
    })
    const successor = rebateRule({
      id: 'org-rule-2', version: 2, value: true, status: 'active', lineageId: 'org-rule-1', supersedesRuleId: 'org-rule-1',
      effectiveFrom: '2026-08-10T00:00:00Z', effectiveTo: null,
    })
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [predecessor, successor] })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.resolution.ruleId).toBe('org-rule-2')
    expect(result.resolution.ruleVersion).toBe(2)
    expect(result.resolution.value).toBe(true)
  })

  it('contract_derived + crafted revert attempt -> rejected outright, never re-resolved, regardless of an active matching policy existing', () => {
    const rule = rebateRule()
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'contract_derived', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'not_eligible_for_revert' })
  })

  it('a field with no provenance at all (never resolved) is also not eligible for revert — there is nothing to revert FROM', () => {
    const rule = rebateRule()
    expect(resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: null, organizationRules: [rule] })).toEqual({ eligible: false, reason: 'not_eligible_for_revert' })
    expect(resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: undefined, organizationRules: [rule] })).toEqual({ eligible: false, reason: 'not_eligible_for_revert' })
  })

  it('an organization_rulebook-provenanced field is also not eligible — reverting only makes sense from a reviewer override', () => {
    const rule = rebateRule()
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'organization_rulebook', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'not_eligible_for_revert' })
  })

  it('no matching policy for this rule_type -> revert rejected', () => {
    const rule = rebateRule() // scoped to rule_type: rebate
    const result = resolveOrganizationPolicyRevert({ ...baseInput, ruleType: 'service_credit', existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'policy_no_longer_applicable' })
  })

  it('a draft policy never makes a revert eligible', () => {
    const rule = rebateRule({ status: 'draft', approvedBy: null })
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'policy_no_longer_applicable' })
  })

  it('a scheduled (future effective_from) policy never makes a revert eligible early', () => {
    const rule = rebateRule({ effectiveFrom: '2026-09-01T00:00:00Z' })
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result).toEqual({ eligible: false, reason: 'policy_no_longer_applicable' })
  })

  it('the function accepts no value/rule id/rule version from its caller at all — every resolved field is derived solely from the matched rule fixture, structurally impossible to forge from outside', () => {
    const rule = rebateRule({ id: 'org-rule-99', version: 7, value: false })
    const result = resolveOrganizationPolicyRevert({ ...baseInput, existingSurvivalProvenance: 'reviewer_policy', organizationRules: [rule] })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    // Whatever the ACTIVE rule's own value/id/version are — never anything
    // else, since resolveOrganizationPolicyRevert's input type has no
    // value/ruleId/ruleVersion parameter for a caller to supply.
    expect(result.resolution.value).toBe(false)
    expect(result.resolution.ruleId).toBe('org-rule-99')
    expect(result.resolution.ruleVersion).toBe(7)
  })
})
