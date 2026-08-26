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
import { resolveProductionOrganizationField, organizationPolicyAvailableForUnresolvedReason, resolveAuthoritativeUnresolvedReason } from './rulebook/organization-rulebook-production'
import { buildCreditApplicationRule } from './credit-application-rule'
import type { OrganizationRuleRecord } from './rulebook/organization-rules'
import type { CurrentFieldState } from './rulebook/organization-rulebook-shadow'
import type { UnresolvedReason } from './rule-interpretation'

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

// Step 16A (amended) — the organization-policy availability/application
// predicate (lib/rulebook/organization-rulebook-production.ts). Mirrors the
// exact TWO-STAGE composition both propose-rule/route.ts and
// confirm-rule/route.ts use: resolveAuthoritativeUnresolvedReason turns a
// possibly-missing cached reason + the real source clause into a definite
// UnresolvedReason FIRST, and only that definite value is ever handed to
// organizationPolicyAvailableForUnresolvedReason — the predicate itself
// never sees a stored value or a source clause directly.
function resolveWithUnresolvedReasonGate(
  ruleType: string,
  rules: OrganizationRuleRecord[],
  storedReason: UnresolvedReason | undefined,
  sourceClause: string | null = null,
  current: CurrentFieldState = { value: 'unclear', provenance: null },
) {
  const authoritativeReason = resolveAuthoritativeUnresolvedReason(storedReason, sourceClause, 'survival')
  if (!organizationPolicyAvailableForUnresolvedReason(authoritativeReason)) {
    return { status: 'not_applicable' as const, reason: 'suppressed by explicit contractual non-agreement' }
  }
  return resolveFor(ruleType, rules, current)
}

describe('organizationPolicyAvailableForUnresolvedReason — Step 16A predicate', () => {
  it('is available when unresolved_reason is "silent"', () => {
    expect(organizationPolicyAvailableForUnresolvedReason('silent')).toBe(true)
  })

  it('is NOT available when unresolved_reason is "explicit_non_agreement"', () => {
    expect(organizationPolicyAvailableForUnresolvedReason('explicit_non_agreement')).toBe(false)
  })
})

describe('resolveAuthoritativeUnresolvedReason — Step 16A amendment, item 3: legacy proposal caches must be safe', () => {
  it('a stored "silent" plus a genuinely silent source clause stays "silent"', () => {
    expect(resolveAuthoritativeUnresolvedReason('silent', 'Customer receives a rebate equal to 5% of transaction-processing fees.', 'survival')).toBe('silent')
  })

  it('a stored "explicit_non_agreement" is trusted (validated by construction: any fresh proposal that set it already ran the source-clause check)', () => {
    expect(resolveAuthoritativeUnresolvedReason('explicit_non_agreement', null, 'survival')).toBe('explicit_non_agreement')
  })

  it('legacy cache (no stored reason at all) + a source clause that explicitly establishes non-agreement -> derives explicit_non_agreement, never silently defaults to silent', () => {
    expect(resolveAuthoritativeUnresolvedReason(undefined, 'The parties do not agree in this Agreement whether an unused rebate credit survives termination.', 'survival')).toBe('explicit_non_agreement')
  })

  it('legacy cache (no stored reason at all) + genuine silence in the source clause -> silent, org policy remains available', () => {
    expect(resolveAuthoritativeUnresolvedReason(undefined, 'Customer receives a rebate equal to 5% of transaction-processing fees paid in the prior Contract Year.', 'survival')).toBe('silent')
  })

  it('legacy cache + no source clause captured at all -> silent (nothing to ground a claim of non-agreement in)', () => {
    expect(resolveAuthoritativeUnresolvedReason(undefined, null, 'survival')).toBe('silent')
  })

  // Step 16A second amendment — field specificity must hold through this
  // path too: a legacy cache for a credit whose clause states non-agreement
  // about CASH only must not suppress the org policy, which only ever
  // concerns survival.carry_forward.
  it('legacy cache (no stored reason) + a source clause whose non-agreement language concerns cash, not survival -> survival still resolves to "silent", org policy remains available', () => {
    expect(resolveAuthoritativeUnresolvedReason(undefined, 'Unused credits carry forward until fully used. The parties do not agree whether the credit is redeemable for cash.', 'survival')).toBe('silent')
  })
})

describe('J. true silence + active org policy -> policy still available/applied, exactly as before Step 16A', () => {
  it('resolves normally when unresolved_reason is "silent"', () => {
    const resolution = resolveWithUnresolvedReasonGate('rebate', [rebateRule()], 'silent', 'Customer receives a rebate equal to 5% of transaction-processing fees.')
    expect(resolution.status).toBe('resolved')

    const result = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolution)
    expect(result?.survival_provenance).toBe('organization_rulebook')
    expect(result?.carry_forward).toBe(true)
    expect(result?.requires_confirmation).toBe(false)
  })

  it('legacy cache (unresolved_reason undefined) + a genuinely silent source clause -> policy remains available, resolves normally', () => {
    const resolution = resolveWithUnresolvedReasonGate('rebate', [rebateRule()], undefined, 'Customer receives a rebate equal to 5% of transaction-processing fees paid in the prior Contract Year.')
    expect(resolution.status).toBe('resolved')
  })
})

describe('K. explicit contractual unresolvedness (OS-2026-09 Annual Rebate) + active org policy -> policy suppressed, Decision Required remains', () => {
  it('never even reaches resolveProductionOrganizationField — status stays not_applicable regardless of a real matching, resolved-eligible org policy', () => {
    const resolution = resolveWithUnresolvedReasonGate('rebate', [rebateRule()], 'explicit_non_agreement', null)
    expect(resolution.status).toBe('not_applicable')

    const result = buildCreditApplicationRule(baseApproved('unclear'), null, { eligibility: 'contract_derived', survival: undefined }, resolution)
    expect(result?.survival_provenance).toBeNull()
    expect(result?.carry_forward).toBe('unclear')
    expect(result?.survival_organization_rule_id).toBeNull()
    // The Decision Required gate stays up — the org policy is never
    // silently substituted for the agreement's own explicit unresolvedness.
    expect(result?.requires_confirmation).toBe(true)
  })

  it('legacy cache (unresolved_reason undefined) + a source clause that explicitly establishes non-agreement -> policy suppressed just the same, without needing the cache entry recomputed first', () => {
    const resolution = resolveWithUnresolvedReasonGate('rebate', [rebateRule()], undefined, 'The parties do not agree in this Agreement whether an unused rebate credit survives termination.')
    expect(resolution.status).toBe('not_applicable')
  })

  it('the underlying org policy itself is completely unaffected — same active rule still resolves normally for a different, genuinely silent agreement', () => {
    const rule = rebateRule()
    const suppressed = resolveWithUnresolvedReasonGate('rebate', [rule], 'explicit_non_agreement', null)
    expect(suppressed.status).toBe('not_applicable')

    const stillActiveElsewhere = resolveWithUnresolvedReasonGate('rebate', [rule], 'silent', 'Customer receives a rebate equal to 5% of transaction-processing fees.')
    expect(stillActiveElsewhere.status).toBe('resolved')
    expect(rule.status).toBe('active')
  })
})

describe('L. explicit contract answer always wins over org policy, independent of unresolved_reason (unreachable in practice since state would not be decision_required, exercised directly for completeness)', () => {
  it('an already contract_derived value is untouched even when unresolved_reason would otherwise have permitted org-policy resolution', () => {
    const resolution = resolveWithUnresolvedReasonGate('rebate', [rebateRule()], 'silent', null, { value: false, provenance: 'contract_derived' })
    expect(resolution.status).toBe('not_applicable')

    const result = buildCreditApplicationRule(baseApproved(false), null, { eligibility: 'contract_derived', survival: 'contract_derived' }, resolution)
    expect(result?.carry_forward).toBe(false)
    expect(result?.survival_provenance).toBe('contract_derived')
  })
})
