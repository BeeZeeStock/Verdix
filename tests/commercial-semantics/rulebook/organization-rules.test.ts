// Private Organization Rulebook — pure matcher/adapter/precedence
// composition tests (Step 5A, shadow mode only). No database — see
// lib/organization-rulebook-rls.test.ts for tenant-isolation/versioning
// tests against the real (migrated) database. No AI calls, no mutation.
import { describe, it, expect } from 'vitest'
import {
  matchOrganizationRules, organizationRuleToCandidate, validateOrganizationRuleShape,
  isAllowlistedOrganizationRuleField, ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS,
  type OrganizationRuleRecord, type OrganizationRuleMatchContext,
} from '@/lib/rulebook/organization-rules'
import { resolveFieldAuthority, type RuleResolutionCandidate } from '@/lib/rulebook/resolution'
import * as organizationRulesModule from '@/lib/rulebook/organization-rules'

function orgRule(overrides: Partial<OrganizationRuleRecord> = {}): OrganizationRuleRecord {
  return {
    id: 'rule-1',
    organizationId: 'org-a',
    name: 'Service credits carry forward',
    description: null,
    targetField: 'survival.carry_forward',
    value: true,
    matchConditions: [
      { field: 'rule_type', operator: 'eq', value: 'service_credit' },
      { field: 'application.timing', operator: 'eq', value: 'next_invoice' },
    ],
    status: 'active',
    version: 1,
    supersedesRuleId: null,
    sourceKind: 'manual',
    createdBy: 'owner@org-a.test',
    approvedBy: 'owner@org-a.test',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    effectiveFrom: null,
    ...overrides,
  }
}

const MATCHING_CONTEXT: OrganizationRuleMatchContext = {
  rule_type: 'service_credit',
  application: { timing: 'next_invoice' },
}
const NO_RESOLVED_FIELDS = new Set<string>()
// Fixed reference instant for every test — matchOrganizationRules never
// reads ambient Date.now() itself, so tests supply their own asOf and stay
// deterministic regardless of when they actually run.
const AS_OF = new Date('2026-08-22T12:00:00.000Z')

describe('validateOrganizationRuleShape — no eval, no arbitrary paths, no unsupported operators', () => {
  it('accepts an allowlisted target_field and allowlisted, supported-operator conditions', () => {
    expect(validateOrganizationRuleShape({
      targetField: 'survival.carry_forward',
      matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }],
    })).toEqual({ valid: true })
  })
  it('rejects a target_field outside the allowlisted vocabulary', () => {
    const result = validateOrganizationRuleShape({ targetField: 'arbitrary.raw.path', matchConditions: [] })
    expect(result.valid).toBe(false)
  })
  it('rejects a match condition field outside the allowlisted vocabulary', () => {
    const result = validateOrganizationRuleShape({
      targetField: 'survival.carry_forward',
      matchConditions: [{ field: 'DROP TABLE contracts', operator: 'eq', value: 1 }],
    })
    expect(result.valid).toBe(false)
  })
  it('rejects an unsupported operator even on an allowlisted field', () => {
    const result = validateOrganizationRuleShape({
      targetField: 'survival.carry_forward',
      // @ts-expect-error -- deliberately an operator outside the supported set
      matchConditions: [{ field: 'rule_type', operator: 'regex', value: '.*' }],
    })
    expect(result.valid).toBe(false)
  })
  it('every allowlisted field is a plausible dotted normalized path (sanity on the vocabulary itself)', () => {
    for (const field of ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS) {
      expect(isAllowlistedOrganizationRuleField(field)).toBe(true)
    }
    expect(isAllowlistedOrganizationRuleField('not_in_the_list')).toBe(false)
  })
})

describe('matchOrganizationRules — deterministic, status-gated matching', () => {
  it('a matching ACTIVE rule is returned as a candidate', () => {
    const rule = orgRule()
    const matched = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)
    expect(matched).toEqual([rule])
    const candidate = organizationRuleToCandidate(matched[0])
    expect(candidate).toEqual({ field: 'survival.carry_forward', value: true, authority: 'organization_rulebook', method: 'organization_rulebook', rule_id: 'rule-1' })
  })
  it('a DRAFT rule is ignored even though its conditions match', () => {
    const rule = orgRule({ status: 'draft', approvedBy: null })
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([])
  })
  it('a DISABLED rule is ignored even though its conditions match', () => {
    const rule = orgRule({ status: 'disabled' })
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([])
  })
  it('a SUPERSEDED rule is ignored even though its conditions match', () => {
    const rule = orgRule({ status: 'superseded' })
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([])
  })
  it('a rule whose conditions do NOT match the context is excluded', () => {
    const rule = orgRule()
    const nonMatchingContext: OrganizationRuleMatchContext = { rule_type: 'rebate', application: { timing: 'next_invoice' } }
    expect(matchOrganizationRules('org-a', { context: nonMatchingContext, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([])
  })
  it('organization rule when the contract is silent on this field -> eligible', () => {
    const rule = orgRule()
    const matched = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)
    expect(matched).toHaveLength(1)
  })
  it('organization rule whose target_field is ALREADY contract/reviewer-resolved -> excluded from matching entirely, before precedence is even involved', () => {
    const rule = orgRule()
    const matched = matchOrganizationRules('org-a', {
      context: MATCHING_CONTEXT,
      contractResolvedFields: new Set(['survival.carry_forward']),
    }, [rule], AS_OF)
    expect(matched).toEqual([])
  })
  it('an unapproved verdix_pattern_suggestion (draft) never matches -> never produces a candidate', () => {
    const suggestion = orgRule({ status: 'draft', sourceKind: 'verdix_pattern_suggestion', approvedBy: null })
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [suggestion], AS_OF)).toEqual([])
  })
  it('Org A rule cannot enter Org B resolution context -- defense-in-depth organizationId check inside the matcher itself', () => {
    const orgARule = orgRule({ organizationId: 'org-a' })
    const matchedForOrgB = matchOrganizationRules('org-b', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [orgARule], AS_OF)
    expect(matchedForOrgB).toEqual([])
    // Confirms the real boundary (organization-scoped fetch) is what's
    // actually relied on -- the matcher's own check is a second layer, not
    // a substitute for never passing mixed-org rules in the first place.
    const matchedForOrgA = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [orgARule], AS_OF)
    expect(matchedForOrgA).toEqual([orgARule])
  })
})

// Step 5A review correction: effective_from is persisted but must not be
// silently ignored by the matcher — enforced here via a required, explicit
// `asOf` parameter (never ambient Date.now() inside matchOrganizationRules
// itself).
describe('matchOrganizationRules — effective_from is enforced via an explicit asOf, never ambient Date.now()', () => {
  it('a rule effective YESTERDAY (relative to asOf) matches', () => {
    const rule = orgRule({ effectiveFrom: '2026-08-21T12:00:00.000Z' }) // one day before AS_OF
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([rule])
  })
  it('a rule effective EXACTLY at asOf matches (inclusive boundary)', () => {
    const rule = orgRule({ effectiveFrom: AS_OF.toISOString() })
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([rule])
  })
  it('a rule effective TOMORROW (relative to asOf) does NOT match', () => {
    const rule = orgRule({ effectiveFrom: '2026-08-23T12:00:00.000Z' }) // one day after AS_OF
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)).toEqual([])
  })
  it('effectiveFrom: null always matches regardless of asOf -- "always effective" is the default', () => {
    const rule = orgRule({ effectiveFrom: null })
    const farPast = new Date('2000-01-01T00:00:00.000Z')
    const farFuture = new Date('2100-01-01T00:00:00.000Z')
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], farPast)).toEqual([rule])
    expect(matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], farFuture)).toEqual([rule])
  })
  it('a future-effective rule and a currently-effective rule for the same field are evaluated independently -- only the currently-effective one is returned', () => {
    const futureRule = orgRule({ id: 'rule-future', value: false, effectiveFrom: '2026-09-01T00:00:00.000Z' })
    const currentRule = orgRule({ id: 'rule-current', value: true, effectiveFrom: '2026-08-01T00:00:00.000Z' })
    const matched = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [futureRule, currentRule], AS_OF)
    expect(matched).toEqual([currentRule])
  })
})

describe('composing matched organization rules with Step 4 field resolution (shadow only)', () => {
  it('organization rule conflicting with an explicit contract candidate -> contract wins', () => {
    const rule = orgRule()
    const [matched] = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)
    const orgCandidate = organizationRuleToCandidate(matched)
    const contractCandidate: RuleResolutionCandidate = { field: 'survival.carry_forward', value: false, authority: 'contract_derived', method: 'existing_normalized_state' }
    const result = resolveFieldAuthority([orgCandidate, contractCandidate])
    expect(result.selected).toEqual(contractCandidate)
    expect(result.status).toBe('resolved')
  })
  it('organization rule conflicting with a contract-specific reviewer decision -> reviewer wins', () => {
    const rule = orgRule()
    const [matched] = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)
    const orgCandidate = organizationRuleToCandidate(matched)
    const reviewerCandidate: RuleResolutionCandidate = { field: 'survival.carry_forward', value: false, authority: 'reviewer_policy', method: 'reviewer' }
    const result = resolveFieldAuthority([orgCandidate, reviewerCandidate])
    expect(result.selected).toEqual(reviewerCandidate)
  })
  it('organization rule conflicting with a plain Verdix default -> organization wins', () => {
    const rule = orgRule()
    const [matched] = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [rule], AS_OF)
    const orgCandidate = organizationRuleToCandidate(matched)
    const verdixCandidate: RuleResolutionCandidate = { field: 'survival.carry_forward', value: false, authority: 'verdix_rulebook', method: 'verdix_rulebook' }
    const result = resolveFieldAuthority([orgCandidate, verdixCandidate])
    expect(result.selected).toEqual(orgCandidate)
  })
  it('two conflicting active organization policies for the same field -> conflict, fail closed (never array order)', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true })
    const ruleB = orgRule({ id: 'rule-b', value: false })
    const matched = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [ruleA, ruleB], AS_OF)
    expect(matched).toHaveLength(2)
    const candidates = matched.map(organizationRuleToCandidate)
    const result = resolveFieldAuthority(candidates)
    expect(result.status).toBe('conflict')
    expect(result.selected).toBeUndefined()
  })
  it('two identical, agreeing active organization policies for the same field -> resolved, no fabricated conflict', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true })
    const ruleB = orgRule({ id: 'rule-b', value: true })
    const matched = matchOrganizationRules('org-a', { context: MATCHING_CONTEXT, contractResolvedFields: NO_RESOLVED_FIELDS }, [ruleA, ruleB], AS_OF)
    const result = resolveFieldAuthority(matched.map(organizationRuleToCandidate))
    expect(result.status).toBe('resolved')
    expect(result.selected?.value).toBe(true)
  })
})

// Item 10: no automatic learning. Confirmed structurally -- this module
// exports exactly the matching/validation/adapter surface documented
// above, nothing that takes reviewer history or an AI-detected pattern and
// produces (or activates) an organization rule.
describe('no automatic promotion from reviewer behavior or AI pattern detection', () => {
  it('the module exports no function resembling automatic promotion/learning', () => {
    const exportNames = Object.keys(organizationRulesModule)
    const suspiciousNamePattern = /promote|learn|autocreate|auto_create|detectPattern/i
    const suspicious = exportNames.filter(name => suspiciousNamePattern.test(name))
    expect(suspicious).toEqual([])
  })
  it('creating/matching a rule never happens as a side effect of calling resolveFieldAuthority or any pure Step 4 function -- matching only ever happens via the explicit matchOrganizationRules call in this test file', () => {
    // Purely illustrative: resolveFieldAuthority takes candidates it is
    // GIVEN -- it has no way to reach into organization-rules-service.ts
    // and fetch/create anything, since it doesn't import that module at
    // all (see lib/rulebook/resolution.ts's own imports).
    const contract: RuleResolutionCandidate = { field: 'survival.carry_forward', value: true, authority: 'contract_derived', method: 'existing_normalized_state' }
    const result = resolveFieldAuthority([contract])
    expect(result.selected).toEqual(contract)
  })
})
