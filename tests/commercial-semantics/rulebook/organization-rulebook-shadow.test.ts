// Organization Rulebook — shadow resolution (Step 5B). Pure tests for
// resolveOrganizationRulebookShadow (lib/rulebook/organization-rulebook-
// shadow.ts) — composing Step 5A's unmodified matchOrganizationRules with
// Step 4's unmodified resolveFieldAuthority, field by field, in shadow
// mode only. No database, no AI, no mutation. Reuses the same fixture
// style as tests/commercial-semantics/rulebook/organization-rules.test.ts
// (Step 5A) rather than re-deriving matcher-level assertions already
// proven there.
import { describe, it, expect } from 'vitest'
import { resolveOrganizationRulebookShadow, type CommercialFieldContext } from '@/lib/rulebook/organization-rulebook-shadow'
import type { OrganizationRuleRecord } from '@/lib/rulebook/organization-rules'
import type { RuleResolutionCandidate } from '@/lib/rulebook/resolution'

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
    sourceKind: 'manual',
    createdBy: 'owner@org-a.test',
    approvedBy: 'owner@org-a.test',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    effectiveFrom: null,
    ...overrides,
  }
}

const SERVICE_CREDIT_MATCH = { rule_type: 'service_credit', application: { timing: 'next_invoice' } }
const AS_OF = new Date('2026-08-22T12:00:00.000Z')

function context(current: CommercialFieldContext['current'], match: Record<string, unknown> = SERVICE_CREDIT_MATCH): CommercialFieldContext {
  return { current, match }
}

describe('required precedence cases (item 4)', () => {
  const rule = orgRule()

  it('unresolved field + org rule -> candidate', () => {
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: 'unclear', provenance: null } }),
      organizationRules: [rule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate).toEqual({ value: true, ruleId: 'rule-1', ruleVersion: 1 })
  })

  it('contract_derived field + org rule -> org rule blocked by precedence', () => {
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: false, provenance: 'contract_derived' } }),
      organizationRules: [rule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('precedence_blocked')
    expect(field.blockedBy).toBe('contract_derived')
    expect(field.organizationCandidate).toBeUndefined()
  })

  it('reviewer_policy field + org rule -> org rule blocked by precedence', () => {
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: false, provenance: 'reviewer_policy' } }),
      organizationRules: [rule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('precedence_blocked')
    expect(field.blockedBy).toBe('reviewer_policy')
  })

  it('verdix_recommends field + org rule -> organization candidate wins precedence', () => {
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: true, provenance: 'verdix_recommends' } }),
      organizationRules: [rule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate?.value).toBe(true)
  })

  it('verdix_rulebook candidate/default + matching org rule -> organization candidate wins precedence', () => {
    const verdixDefault: RuleResolutionCandidate = { field: 'survival.carry_forward', value: false, authority: 'verdix_rulebook', method: 'verdix_rulebook' }
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({}),
      organizationRules: [rule], asOf: AS_OF,
      verdixCandidates: [verdixDefault],
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate?.value).toBe(true) // org's value, not the Verdix default's
  })
})

describe('contract always wins over Organization Rulebook -- hard invariant (item 5)', () => {
  it('org rule matches semantically but is precedence_blocked when the contract has explicit semantics for this field; the contract-derived value remains authoritative (not overwritten in the report)', () => {
    const carryForwardRule = orgRule({ value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: false, provenance: 'contract_derived' } }), // contract: expires after next invoice
      organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('precedence_blocked')
    expect(field.blockedBy).toBe('contract_derived')
    expect(field.current).toEqual({ value: false, provenance: 'contract_derived' })
    expect(field.organizationCandidate).toBeUndefined()
  })
  it('conversely, when the contract is silent, the same organization rule DOES become the candidate', () => {
    const carryForwardRule = orgRule({ value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate?.value).toBe(true)
  })
})

describe('field-by-field independence (item 3) -- a matching rule for one field never touches another', () => {
  it('a carry_forward-targeting org rule does not affect application.timing, even though both are on the same service credit', () => {
    const carryForwardRule = orgRule({ targetField: 'survival.carry_forward', value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({
        'application.timing': { value: 'next_invoice', provenance: 'contract_derived' },
        'survival.carry_forward': { value: null, provenance: null },
      }),
      organizationRules: [carryForwardRule], asOf: AS_OF,
    })
    const timing = results.find(r => r.field === 'application.timing')!
    const carryForward = results.find(r => r.field === 'survival.carry_forward')!
    expect(timing.result).toBe('no_match') // no org rule targets this field at all
    expect(timing.current).toEqual({ value: 'next_invoice', provenance: 'contract_derived' })
    expect(carryForward.result).toBe('candidate')
  })
})

describe('no matching rule / future-effective rule (items 4, 9)', () => {
  it('no matching rule -> no_match', () => {
    const nonMatchingRule = orgRule({ matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'rebate' }] })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [nonMatchingRule], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')!.result).toBe('no_match')
  })
  it('a future-effective rule does not appear as a shadow candidate for an earlier asOf, but does for a later one -- reproducible from a historical asOf', () => {
    const futureRule = orgRule({ effectiveFrom: '2026-09-01T00:00:00.000Z' })
    const historicalAsOf = new Date('2026-08-01T00:00:00.000Z') // before effective_from
    const laterAsOf = new Date('2026-09-15T00:00:00.000Z')      // after effective_from
    const base = { organizationId: 'org-a', commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }), organizationRules: [futureRule] }
    expect(resolveOrganizationRulebookShadow({ ...base, asOf: historicalAsOf }).find(r => r.field === 'survival.carry_forward')!.result).toBe('no_match')
    expect(resolveOrganizationRulebookShadow({ ...base, asOf: laterAsOf }).find(r => r.field === 'survival.carry_forward')!.result).toBe('candidate')
  })
  it('an already-effective rule matches for an asOf on or after its effective_from', () => {
    const effectiveRule = orgRule({ effectiveFrom: '2026-08-01T00:00:00.000Z' })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [effectiveRule], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')!.result).toBe('candidate')
  })
})

describe('specificity — a more specific rule wins over a broader organization default (item 8)', () => {
  it('a rule with more match conditions (more specific) wins over a broader-matching rule for the same field with a conflicting value', () => {
    const broadDefault = orgRule({ id: 'rule-broad', value: false, matchConditions: [] }) // field-level default, matches everything
    const specificRule = orgRule({ id: 'rule-specific', value: true, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }] })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [broadDefault, specificRule], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate).toEqual({ value: true, ruleId: 'rule-specific', ruleVersion: 1 })
  })
  it('order independence: the same result holds regardless of which rule is listed first', () => {
    const broadDefault = orgRule({ id: 'rule-broad', value: false, matchConditions: [] })
    const specificRule = orgRule({ id: 'rule-specific', value: true, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }] })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [specificRule, broadDefault], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')!.organizationCandidate?.ruleId).toBe('rule-specific')
  })
  it('equally specific conflicting rules -> conflict, fail closed (never array order, never newest/lowest-id)', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }] })
    const ruleB = orgRule({ id: 'rule-b', value: false, matchConditions: [{ field: 'rule_type', operator: 'eq', value: 'service_credit' }] })
    const forward = resolveOrganizationRulebookShadow({ organizationId: 'org-a', commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }), organizationRules: [ruleA, ruleB], asOf: AS_OF })
    const reversed = resolveOrganizationRulebookShadow({ organizationId: 'org-a', commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }), organizationRules: [ruleB, ruleA], asOf: AS_OF })
    expect(forward.find(r => r.field === 'survival.carry_forward')!.result).toBe('conflict')
    expect(reversed.find(r => r.field === 'survival.carry_forward')!.result).toBe('conflict')
  })
  it('equally specific AGREEING rules resolve normally, no fabricated conflict', () => {
    const ruleA = orgRule({ id: 'rule-a', value: true })
    const ruleB = orgRule({ id: 'rule-b', value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a', commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [ruleA, ruleB], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')!.result).toBe('candidate')
  })
})

describe('tenant isolation (item 7) -- same normalized field, different private policy per organization', () => {
  const currentUnresolved = context({ 'survival.carry_forward': { value: null, provenance: null } })

  it('Org A and Org B see only their own candidate for the identical normalized field', () => {
    const orgARule = orgRule({ id: 'rule-org-a', organizationId: 'org-a', value: true })
    const orgBRule = orgRule({ id: 'rule-org-b', organizationId: 'org-b', value: false })

    const orgAResults = resolveOrganizationRulebookShadow({ organizationId: 'org-a', commercialContext: currentUnresolved, organizationRules: [orgARule], asOf: AS_OF })
    const orgBResults = resolveOrganizationRulebookShadow({ organizationId: 'org-b', commercialContext: currentUnresolved, organizationRules: [orgBRule], asOf: AS_OF })

    expect(orgAResults.find(r => r.field === 'survival.carry_forward')!.organizationCandidate?.value).toBe(true)
    expect(orgBResults.find(r => r.field === 'survival.carry_forward')!.organizationCandidate?.value).toBe(false)
  })
  it('Org A rule cannot leak into Org B resolution even if mistakenly passed in the rules array (defense in depth from the Step 5A matcher)', () => {
    const orgARule = orgRule({ id: 'rule-org-a', organizationId: 'org-a', value: true })
    const results = resolveOrganizationRulebookShadow({ organizationId: 'org-b', commercialContext: currentUnresolved, organizationRules: [orgARule], asOf: AS_OF })
    expect(results.find(r => r.field === 'survival.carry_forward')!.result).toBe('no_match')
  })
  it('Org C has no matching rule -> no candidate', () => {
    const results = resolveOrganizationRulebookShadow({ organizationId: 'org-c', commercialContext: currentUnresolved, organizationRules: [], asOf: AS_OF })
    expect(results.find(r => r.field === 'survival.carry_forward')!.result).toBe('no_match')
  })
})

// Item 11 — the synthetic service-credit example, end to end.
//
// Review correction: only tests survival.carry_forward — whether an
// unused earned balance survives to another invoice/period AT ALL. It
// deliberately does NOT attempt to represent "carry forward until fully
// used" (a bounded/unbounded EXPIRY treatment for that carried balance) —
// that is a genuinely separate commercial dimension from carry_forward,
// and a separate one again from survival.one_time (whether the credit can
// be EARNED once vs. repeatedly). See ORGANIZATION_RULEBOOK_ALLOWLISTED_
// FIELDS's own comment (lib/rulebook/organization-rules.ts) for the
// recorded schema capability gap: today's Organization Rulebook field
// allowlist has no field capable of expressing expiry/until-fully-used
// treatment (the production concept it would mirror is lib/types.ts's
// CreditApplicationRule.expiry_periods/.expiry_date) — Step 5B does not
// invent or overload an existing field to approximate it.
describe('service-credit example (item 11)', () => {
  const serviceCreditContext = context({
    'application.timing': { value: 'next_invoice', provenance: 'contract_derived' },
    'survival.carry_forward': { value: 'unclear', provenance: null }, // unstated
  })

  it('Org A: active policy resolves the unstated carry_forward field as a candidate, leaving application.timing untouched', () => {
    const orgACarryForward = orgRule({ id: 'a-carry-forward', organizationId: 'org-a', targetField: 'survival.carry_forward', value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a', commercialContext: serviceCreditContext,
      organizationRules: [orgACarryForward], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')).toMatchObject({ result: 'candidate', organizationCandidate: { value: true, ruleId: 'a-carry-forward', ruleVersion: 1 } })
    expect(results.find(r => r.field === 'application.timing')).toMatchObject({ result: 'no_match' })
  })

  it('same contract, but the contract now explicitly states expiry (contract_derived carry_forward=false) -- the organization carry-forward rule is precedence blocked; contract-derived remains authoritative', () => {
    const explicitExpiryContext = context({
      'application.timing': { value: 'next_invoice', provenance: 'contract_derived' },
      'survival.carry_forward': { value: false, provenance: 'contract_derived' }, // "expires after the next invoice"
    })
    const orgACarryForward = orgRule({ id: 'a-carry-forward', organizationId: 'org-a', targetField: 'survival.carry_forward', value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a', commercialContext: explicitExpiryContext,
      organizationRules: [orgACarryForward], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('precedence_blocked')
    expect(field.blockedBy).toBe('contract_derived')
    expect(field.current.value).toBe(false)
  })

  it('Org B: a different private policy on the IDENTICAL normalized (silent) contract produces a different candidate -- proves org rulebooks customize Verdix without changing global semantics', () => {
    const orgBCarryForward = orgRule({ id: 'b-carry-forward', organizationId: 'org-b', targetField: 'survival.carry_forward', value: false })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-b', commercialContext: serviceCreditContext,
      organizationRules: [orgBCarryForward], asOf: AS_OF,
    })
    expect(results.find(r => r.field === 'survival.carry_forward')?.organizationCandidate?.value).toBe(false)
  })
})

// Item 12 — reviewer_policy precedence, explicitly.
describe('reviewer-policy precedence (item 12)', () => {
  it('contract silent, reviewer already explicitly chose carry_forward=false; a matching organization policy (true) is precedence blocked -- reviewer_policy remains authoritative for this agreement', () => {
    const orgRuleTrue = orgRule({ value: true })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: false, provenance: 'reviewer_policy' } }),
      organizationRules: [orgRuleTrue], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('precedence_blocked')
    expect(field.blockedBy).toBe('reviewer_policy')
    expect(field.current).toEqual({ value: false, provenance: 'reviewer_policy' })
  })
})

// Item 13 — organization rules may supersede Verdix recommendations, and
// a lower-precedence Verdix Global Rulebook default, in shadow only.
describe('organization rules supersede Verdix recommendations and defaults, in shadow only (item 13)', () => {
  it('current provenance = verdix_recommends (true); organization rule = false -> organization candidate (false) wins precedence', () => {
    const orgRuleFalse = orgRule({ value: false })
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: true, provenance: 'verdix_recommends' } }),
      organizationRules: [orgRuleFalse], asOf: AS_OF,
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate?.value).toBe(false)
  })
  it('a lower-precedence Verdix Global Rulebook default loses to an approved organization policy when the contract/reviewer layer is silent', () => {
    const orgRuleTrue = orgRule({ value: true })
    const verdixDefault: RuleResolutionCandidate = { field: 'survival.carry_forward', value: false, authority: 'verdix_rulebook', method: 'verdix_rulebook' }
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({}),
      organizationRules: [orgRuleTrue], asOf: AS_OF,
      verdixCandidates: [verdixDefault],
    })
    const field = results.find(r => r.field === 'survival.carry_forward')!
    expect(field.result).toBe('candidate')
    expect(field.organizationCandidate?.value).toBe(true)
  })
})

describe('purity — no mutation, deterministic repeated calls (item 19)', () => {
  it('never mutates its inputs -- a deep-frozen input does not throw', () => {
    const rule = orgRule()
    const input = Object.freeze({
      organizationId: 'org-a',
      commercialContext: Object.freeze({
        current: Object.freeze({ 'survival.carry_forward': Object.freeze({ value: null, provenance: null }) }),
        match: Object.freeze({ ...SERVICE_CREDIT_MATCH }),
      }),
      organizationRules: Object.freeze([Object.freeze(rule)]),
      asOf: AS_OF,
    })
    expect(() => resolveOrganizationRulebookShadow(input as unknown as Parameters<typeof resolveOrganizationRulebookShadow>[0])).not.toThrow()
  })
  it('identical inputs produce byte-identical output across repeated calls', () => {
    const rule = orgRule()
    const input = {
      organizationId: 'org-a',
      commercialContext: context({ 'survival.carry_forward': { value: null, provenance: null } }),
      organizationRules: [rule], asOf: AS_OF,
    }
    const first = resolveOrganizationRulebookShadow(input)
    const second = resolveOrganizationRulebookShadow(input)
    expect(second).toEqual(first)
  })
  it('field order in the output is deterministic (alphabetical), independent of input map/array order', () => {
    const rule = orgRule()
    const results = resolveOrganizationRulebookShadow({
      organizationId: 'org-a',
      commercialContext: context({
        'survival.one_time': { value: null, provenance: null },
        'application.timing': { value: 'next_invoice', provenance: 'contract_derived' },
        'survival.carry_forward': { value: null, provenance: null },
      }),
      organizationRules: [rule], asOf: AS_OF,
    })
    expect(results.map(r => r.field)).toEqual(['application.timing', 'survival.carry_forward', 'survival.one_time'])
  })
})
