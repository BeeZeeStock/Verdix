// Organization Rulebook — controlled production resolution (Step 5C). Pure
// tests for resolveProductionOrganizationField (lib/rulebook/organization-
// rulebook-production.ts) — the thin, allowlist-gated interpreter sitting on
// top of Step 5B's unmodified resolveOrganizationRulebookShadow. Reuses the
// exact same orgRule/context/AS_OF fixture style as
// organization-rulebook-shadow.test.ts (Step 5B) deliberately, so these
// tests exercise ONLY the one new thing Step 5C adds — the production
// allowlist gate — never re-proving matcher/precedence behavior already
// covered there.
import { describe, it, expect } from 'vitest'
import {
  resolveProductionOrganizationField, isProductionActivatedOrganizationField,
  isOrganizationPolicyStale, PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST,
} from '@/lib/rulebook/organization-rulebook-production'
import { resolveOrganizationRulebookShadow, type CommercialFieldContext } from '@/lib/rulebook/organization-rulebook-shadow'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'

function orgRule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'rule-1',
    organizationId: 'org-a',
    name: 'Service credits carry forward',
    description: null,
    targetField: 'survival.carry_forward',
    value: true,
    matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
    status: 'active',
    version: 1,
    supersedesRuleId: null,
    lineageId: 'rule-1',
    sourceKind: 'manual',
    createdBy: 'owner@org-a.test',
    approvedBy: 'owner@org-a.test',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    effectiveFrom: null,
    effectiveTo: null,
    ...overrides,
  }
}

const SERVICE_CREDIT_MATCH = { rule_type: 'service_credit', application: { timing: 'next_invoice' } }
const AS_OF = new Date('2026-08-22T12:00:00.000Z')

function context(current: CommercialFieldContext['current'], match: Record<string, unknown> = SERVICE_CREDIT_MATCH): CommercialFieldContext {
  return { current, match }
}

describe('production activation allowlist (item 1)', () => {
  it('activates exactly survival.carry_forward, and nothing else', () => {
    expect(PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST).toEqual(['survival.carry_forward'])
  })
  it('isProductionActivatedOrganizationField is true only for the allowlisted field', () => {
    expect(isProductionActivatedOrganizationField('survival.carry_forward')).toBe(true)
    expect(isProductionActivatedOrganizationField('survival.one_time')).toBe(false)
    expect(isProductionActivatedOrganizationField('application.timing')).toBe(false)
    expect(isProductionActivatedOrganizationField('partial_period_treatment')).toBe(false)
  })
})

describe('proof: an unactivated field remains shadow-only even with an active, matching, otherwise-winning organization rule (item 1)', () => {
  it('survival.one_time has a real shadow candidate, but production resolution refuses it', () => {
    const oneTimeRule = orgRule({ id: 'one-time-rule', targetField: 'survival.one_time', value: false })
    const shadowInput = {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.one_time': { value: 'unclear', provenance: null } }),
      organizationRules: [oneTimeRule], asOf: AS_OF,
    }
    // The shadow layer (Step 5B, unmodified) DOES produce a real candidate —
    // proving this isn't a case where nothing matched at all.
    const shadow = resolveOrganizationRulebookShadow(shadowInput)
    expect(shadow.find(r => r.field === 'survival.one_time')).toMatchObject({ result: 'candidate', organizationCandidate: { value: false } })

    // Production resolution for the SAME field, SAME input, refuses to
    // apply it — the one new gate Step 5C adds on top.
    const production = resolveProductionOrganizationField('survival.one_time', shadowInput)
    expect(production.status).toBe('not_applicable')
    expect(production.reason).toMatch(/not in the Step 5C production activation allowlist/)
  })
})

// Item 11 — the acceptance fixture, verbatim: Contract states a service
// credit, application timing = next invoice, carry-forward unstated. Active
// organization policy: rule_type = service_credit, target =
// survival.carry_forward, value = true.
describe('service-credit acceptance fixture (item 11)', () => {
  const carryForwardRule = orgRule({ value: true })
  const silentContext = context({ 'survival.carry_forward': { value: 'unclear', provenance: null } })

  it('resolved: carry_forward = true, provenance implied organization_rulebook, with rule id/version', () => {
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    expect(result).toMatchObject({ status: 'resolved', value: true, ruleId: 'rule-1', ruleVersion: 1 })
  })

  it('explicit contract wins: contract says carry_forward = false, org says true -> not_applicable (contract stays authoritative)', () => {
    const explicitContractContext = context({ 'survival.carry_forward': { value: false, provenance: 'contract_derived' } })
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: explicitContractContext, organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    expect(result.status).toBe('not_applicable')
  })

  it('reviewer override wins: reviewer says false, org says true -> not_applicable (reviewer stays authoritative for this agreement)', () => {
    const reviewerContext = context({ 'survival.carry_forward': { value: false, provenance: 'reviewer_policy' } })
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: reviewerContext, organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    expect(result.status).toBe('not_applicable')
  })

  it('future rule: effective tomorrow does not resolve today', () => {
    const tomorrow = new Date(AS_OF.getTime() + 24 * 60 * 60 * 1000).toISOString()
    const futureRule = orgRule({ effectiveFrom: tomorrow })
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: [futureRule], asOf: AS_OF,
    })
    expect(result.status).toBe('not_applicable')
  })

  it('conflicting org rules -> conflict, fails closed (never newest/oldest/first)', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true })
    const ruleB = orgRule({ id: 'rule-b', value: false })
    const forward = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: [ruleA, ruleB], asOf: AS_OF,
    })
    const reversed = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: [ruleB, ruleA], asOf: AS_OF,
    })
    expect(forward.status).toBe('conflict')
    expect(reversed.status).toBe('conflict')
    expect(forward.value).toBeUndefined()
    expect(reversed.value).toBeUndefined()
  })
})

describe('historical determinism (item 9) — resolution uses an explicit asOf, never ambient time', () => {
  const ruleA = orgRule({
    id: 'rule-a', lineageId: 'lineage-1', value: false, version: 1,
    status: 'superseded', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-07-01T00:00:00.000Z',
  })
  const ruleB = orgRule({
    id: 'rule-b', lineageId: 'lineage-1', value: true, version: 2, supersedesRuleId: 'rule-a',
    status: 'active', effectiveFrom: '2026-07-01T00:00:00.000Z', effectiveTo: null,
  })
  const lineage = [ruleA, ruleB]
  const silentContext = context({ 'survival.carry_forward': { value: 'unclear', provenance: null } })

  it('a historical asOf inside rule A\'s window resolves to rule A\'s value, even though it is now superseded by rule B', () => {
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: lineage,
      asOf: new Date('2026-04-01T00:00:00.000Z'),
    })
    expect(result).toMatchObject({ status: 'resolved', value: false, ruleId: 'rule-a', ruleVersion: 1 })
  })

  it('an asOf at/after the cutover resolves to rule B\'s value', () => {
    const result = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: lineage,
      asOf: new Date('2026-07-01T00:00:00.000Z'),
    })
    expect(result).toMatchObject({ status: 'resolved', value: true, ruleId: 'rule-b', ruleVersion: 2 })
  })

  it('an already-issued billing period must resolve using the policy version applicable to THAT period, not today\'s policy — proven by re-running the exact same historical asOf after rule B has since superseded rule A', () => {
    const call = () => resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a', commercialContext: silentContext, organizationRules: lineage,
      asOf: new Date('2026-04-01T00:00:00.000Z'),
    })
    expect(call()).toEqual(call())
    expect(call().value).toBe(false) // rule A's value, never rule B's, for this historical period
  })
})

describe('purity — deterministic, no mutation', () => {
  it('identical inputs produce identical output across repeated calls', () => {
    const rule = orgRule()
    const input = {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [rule], asOf: AS_OF,
    }
    expect(resolveProductionOrganizationField('survival.carry_forward', input)).toEqual(resolveProductionOrganizationField('survival.carry_forward', input))
  })
})

// Pre-commit review, item 3 — isOrganizationPolicyStale is the pure
// comparison confirm-rule/route.ts uses between what a reviewer was SHOWN
// (propose-rule's advisory survival_organization_policy) and what confirm-
// rule's OWN, independently re-resolved authoritative result actually is.
// Never itself a source of authority — see the function's own comment.
describe('isOrganizationPolicyStale — TOCTOU comparison (item 3)', () => {
  const seen = { ruleId: 'rule-1', ruleVersion: 1, value: true }

  it('matching rule id, version, and value -> not stale', () => {
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [orgRule()], asOf: AS_OF,
    })
    expect(isOrganizationPolicyStale(fresh, seen)).toBe(false)
  })

  it('fresh resolution is not_applicable (policy disabled/no longer effective) -> stale', () => {
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [orgRule({ status: 'disabled' })], asOf: AS_OF,
    })
    expect(fresh.status).toBe('not_applicable')
    expect(isOrganizationPolicyStale(fresh, seen)).toBe(true)
  })

  it('fresh resolution is conflict (a second, disagreeing active rule appeared) -> stale', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true })
    const ruleB = orgRule({ id: 'rule-b', value: false })
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [ruleA, ruleB], asOf: AS_OF,
    })
    expect(fresh.status).toBe('conflict')
    expect(isOrganizationPolicyStale(fresh, { ruleId: 'rule-a', ruleVersion: 1, value: true })).toBe(true)
  })

  it('fresh resolution is still resolved but a DIFFERENT rule id -> stale (never silently substitute one policy for another)', () => {
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [orgRule({ id: 'rule-different' })], asOf: AS_OF,
    })
    expect(fresh.status).toBe('resolved')
    expect(isOrganizationPolicyStale(fresh, seen)).toBe(true)
  })

  it('same rule id, but a newer version -> stale (the policy was edited between propose and confirm)', () => {
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [orgRule({ version: 2 })], asOf: AS_OF,
    })
    expect(fresh.status).toBe('resolved')
    expect(isOrganizationPolicyStale(fresh, seen)).toBe(true)
  })

  it('same rule id/version, but the value itself changed -> stale', () => {
    const fresh = resolveProductionOrganizationField('survival.carry_forward', {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [orgRule({ value: false })], asOf: AS_OF,
    })
    expect(fresh.status).toBe('resolved')
    expect(fresh.value).toBe(false)
    expect(isOrganizationPolicyStale(fresh, seen)).toBe(true) // seen.value was true
  })
})
