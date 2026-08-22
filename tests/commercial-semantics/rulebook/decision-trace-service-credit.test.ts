// Verdix commercial decision trace — service credit survival.carry_forward
// (Step 8, item 9/10). Reuses the exact Step 5E synthetic scenarios (see
// lib/organization-rulebook-e2e-acceptance.test.ts's Scenarios A-F) as pure,
// no-database trace assertions — proving the SAME real production wiring
// (buildCreditApplicationRule, resolveProductionOrganizationField,
// isOrganizationPolicyStale, all reused unmodified) produces an explainable
// trace matching what Step 5E already proved happens at the data layer.
import { describe, it, expect } from 'vitest'
import {
  buildServiceCreditSurvivalCarryForwardTrace, explainServiceCreditSurvivalCarryForward,
} from '@/lib/rulebook/decision-trace-service-credit'
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

const AS_OF = new Date('2026-08-22T12:00:00.000Z')

describe('Scenario A — explicit contract wins; organization default never even considered', () => {
  it('carry_forward=false, contract_derived; an org default (true) exists but is structurally irrelevant', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: false, survival_provenance: 'contract_derived', availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [orgRule({ value: true })], asOf: AS_OF,
    })
    expect(trace.sourceState.explicitContractEvidence).toBe(true)
    expect(trace.final).toEqual({ value: false, authority: 'contract_derived', method: 'existing_normalized_state' })
    expect(trace.organizationRulebook).toEqual({ considered: false, matchedRuleIds: [], status: 'not_applicable' })
    expect(trace.precedence).toEqual({ selectedAuthority: 'contract_derived', suppressedAuthorities: [] })
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('The agreement explicitly specifies this treatment.')
  })
})

describe('Scenario B — organization policy resolves genuine silence', () => {
  it('carry_forward unclear, no provenance; the org policy v1 resolves it automatically', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [orgRule({ id: 'org-rule-v1', version: 1, value: true })], asOf: AS_OF,
    })
    expect(trace.sourceState.explicitContractEvidence).toBe(false)
    expect(trace.organizationRulebook).toEqual({
      considered: true, matchedRuleIds: ['org-rule-v1'], status: 'resolved',
      selectedRuleId: 'org-rule-v1', selectedRuleVersion: 1,
    })
    expect(trace.final).toEqual({ value: true, authority: 'organization_rulebook', method: 'organization_rulebook' })
    expect(trace.precedence).toEqual({ selectedAuthority: 'organization_rulebook', suppressedAuthorities: [] })
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('Organization policy currently supplies this treatment because the agreement does not specify unused-balance treatment.')
  })
})

describe('Scenario C — reviewer override outranks the organization default', () => {
  it('org says true, reviewer explicitly chooses false -> reviewer selected, organization suppressed', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: false, survival_provenance: 'reviewer_policy', availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [orgRule({ id: 'org-rule-v1', version: 1, value: true })], asOf: AS_OF,
    })
    expect(trace.final).toEqual({ value: false, authority: 'reviewer_policy', method: 'existing_normalized_state' })
    expect(trace.organizationRulebook.considered).toBe(true)
    expect(trace.organizationRulebook.matchedRuleIds).toEqual(['org-rule-v1'])
    expect(trace.organizationRulebook.status).toBe('not_applicable')
    expect(trace.precedence).toEqual({ selectedAuthority: 'reviewer_policy', suppressedAuthorities: ['organization_rulebook'] })
    expect(trace.reviewer.suppliedDecision).toBe(true)
    expect(trace.execution.readinessBlocking).toBe(false)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('A reviewer\'s decision currently governs this treatment for this agreement, taking precedence over the organization default.')
  })
})

describe('Scenario D — a Verdix recommendation alone never resolves the field', () => {
  it('contract silent, no org policy, a recommendation exists -> final stays unresolved, readiness blocked', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'verdix_recommends', availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.final).toBeUndefined()
    expect(trace.sourceState.contractProvenance).toBe('verdix_recommends')
    expect(trace.organizationRulebook).toEqual({ considered: true, matchedRuleIds: [], status: 'unresolved' })
    expect(trace.precedence).toEqual({ selectedAuthority: undefined, suppressedAuthorities: ['verdix_recommends'] })
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('The agreement does not currently specify unused-balance treatment. This requires a reviewer decision.')
  })
})

describe('Scenario E — conflicting organization rules fail closed', () => {
  it('two equally-specific active org rules disagree -> conflict, no selected rule, final unresolved, readiness blocked', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a',
      organizationRules: [
        orgRule({ id: 'rule-a', value: true }),
        orgRule({ id: 'rule-b', value: false }),
      ],
      asOf: AS_OF,
    })
    expect(trace.organizationRulebook.status).toBe('conflict')
    expect(trace.organizationRulebook.selectedRuleId).toBeUndefined()
    expect(trace.organizationRulebook.matchedRuleIds.sort()).toEqual(['rule-a', 'rule-b'])
    expect(trace.final).toBeUndefined()
    expect(trace.precedence.selectedAuthority).toBeUndefined()
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('Multiple organization policies currently conflict for this agreement. No treatment is applied automatically.')
  })
})

describe('Scenario F — a stale policy race mints no organization authority', () => {
  it('the AI proposal showed v2; the org policy has since moved to v3 -> stale, no authority minted, readiness blocked', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a',
      organizationRules: [orgRule({ id: 'org-rule-v3', version: 3, value: true })],
      interpretationContext: 'service_credit_proposal',
      seenOrganizationPolicy: { ruleId: 'org-rule-v2', ruleVersion: 2, value: false },
      asOf: AS_OF,
    })
    expect(trace.ai?.seenOrganizationPolicy).toEqual({ ruleId: 'org-rule-v2', ruleVersion: 2 })
    expect(trace.organizationRulebook.status).toBe('resolved') // the fresh resolution WOULD apply...
    expect(trace.organizationRulebook.staleAgainstSeenPolicy).toBe(true) // ...but it's stale against what was shown
    expect(trace.final).toBeUndefined() // ...so no organization authority is minted
    expect(trace.precedence).toEqual({ selectedAuthority: undefined, suppressedAuthorities: ['organization_rulebook'] })
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(explainServiceCreditSurvivalCarryForward(trace)).toBe('The organization policy has changed since this was last reviewed. No treatment is currently applied automatically — please review again.')
  })

  it('when the seen policy matches the fresh one exactly, it is NOT stale and organization authority applies normally', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a',
      organizationRules: [orgRule({ id: 'org-rule-v2', version: 2, value: true })],
      interpretationContext: 'service_credit_proposal',
      seenOrganizationPolicy: { ruleId: 'org-rule-v2', ruleVersion: 2, value: true },
      asOf: AS_OF,
    })
    expect(trace.organizationRulebook.staleAgainstSeenPolicy).toBeUndefined()
    expect(trace.final).toEqual({ value: true, authority: 'organization_rulebook', method: 'organization_rulebook' })
  })
})

describe('AI guidance section — deterministic, structural facts only', () => {
  it('a service_credit_proposal interpretation context carries the exact guidance rule ids and version, never full proposal text', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
      interpretationContext: 'service_credit_proposal', aiProposalState: 'decision_required',
    })
    expect(trace.ai?.guidanceRuleIds).toContain('credit.next_invoice_timing_ne_carry_forward')
    expect(trace.ai?.guidanceRuleIds).toContain('credit.explicit_carry_forward_authoritative')
    expect(trace.ai?.proposalState).toBe('decision_required')
    expect(trace.versions.aiGuidance).toBeTruthy()
  })

  it('omitting interpretationContext omits the ai section entirely — no guidance claimed for an operation that never asked for any', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.ai).toBeUndefined()
    expect(trace.versions.aiGuidance).toBeUndefined()
  })
})

describe('cash_redeemable domain slice — Step 7 amendment rule I participates without affecting survival.carry_forward\'s own trace', () => {
  it('an explicitly cash-redeemable, contract-derived credit does not change the survival trace outcome', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: ['transaction_processing'], carry_forward: false, survival_provenance: 'contract_derived', availability: 'next_period' },
      cashRedeemable: true, cashRedeemableProvenance: 'contract_derived',
      organizationId: 'org-a', organizationRules: [], asOf: AS_OF,
    })
    expect(trace.final).toEqual({ value: false, authority: 'contract_derived', method: 'existing_normalized_state' })
    // Rule I evaluates cash_redeemable, not carry_forward — its finding
    // (if any) is a distinct field within globalRulebook.findings and does
    // not perturb this trace's own field/final/precedence.
    expect(trace.field).toBe('survival.carry_forward')
  })
})
