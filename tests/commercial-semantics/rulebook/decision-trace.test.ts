// Verdix commercial decision trace — generic composer (Step 8). Pure tests
// for lib/rulebook/decision-trace.ts's buildCommercialDecisionTrace: the
// field-agnostic layer that composes AI guidance selection, Global
// Rulebook validation, Global Rulebook invariant enforcement, Organization
// Rulebook matching/precedence, and the canonical readiness gate into one
// explainable structure. No database, no AI call, no mutation, zero
// production wiring — see this file's own scenario tests plus
// decision-trace-service-credit.test.ts for the field-specific entry point.
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { buildCommercialDecisionTrace, type DecisionTraceInput } from '@/lib/rulebook/decision-trace'
import { creditApplicationContext } from '@/lib/rulebook/context'
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

const MATCH_CONTEXT = { rule_type: 'service_credit', application: { timing: 'next_invoice' } }
const AS_OF = new Date('2026-08-22T12:00:00.000Z')

// Minimal base input — a genuinely silent survival.carry_forward field
// with no organization rules at all. Each test overrides only what it
// needs, per the established fixture-builder convention this codebase
// uses throughout tests/commercial-semantics/rulebook/.
function baseInput(overrides: Partial<DecisionTraceInput> = {}): DecisionTraceInput {
  return {
    field: 'survival.carry_forward',
    currentValue: null,
    currentProvenance: null,
    domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: 'unclear', availability: 'next_period' }) },
    organizationId: 'org-a',
    organizationRules: [],
    organizationMatchContext: MATCH_CONTEXT,
    asOf: AS_OF,
    ...overrides,
  }
}

describe('field considered / matchedRuleIds / selectedRuleId only appear when genuinely applicable (item 15.4)', () => {
  it('no organization rules at all -> considered true (field genuinely open), matchedRuleIds empty, no selected rule', () => {
    const trace = buildCommercialDecisionTrace(baseInput())
    expect(trace.organizationRulebook.considered).toBe(true)
    expect(trace.organizationRulebook.matchedRuleIds).toEqual([])
    expect(trace.organizationRulebook.selectedRuleId).toBeUndefined()
    expect(trace.organizationRulebook.status).toBe('unresolved')
  })

  it('contract already resolves the field -> considered false, matchedRuleIds empty, even though a matching org rule exists', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: false, currentProvenance: 'contract_derived',
      organizationRules: [orgRule()],
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: false, survival_provenance: 'contract_derived', availability: 'next_period' }) },
    }))
    expect(trace.organizationRulebook.considered).toBe(false)
    expect(trace.organizationRulebook.matchedRuleIds).toEqual([])
    expect(trace.organizationRulebook.status).toBe('not_applicable')
  })

  it('a matching, winning org rule -> considered true, matchedRuleIds populated, selectedRuleId/Version set', () => {
    const trace = buildCommercialDecisionTrace(baseInput({ organizationRules: [orgRule({ id: 'rule-9', version: 3 })] }))
    expect(trace.organizationRulebook.considered).toBe(true)
    expect(trace.organizationRulebook.matchedRuleIds).toEqual(['rule-9'])
    expect(trace.organizationRulebook.selectedRuleId).toBe('rule-9')
    expect(trace.organizationRulebook.selectedRuleVersion).toBe(3)
    expect(trace.organizationRulebook.status).toBe('resolved')
  })

  it('a field outside the production allowlist -> considered false regardless of matching rules', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      field: 'survival.one_time', organizationRules: [orgRule({ targetField: 'survival.one_time', id: 'ot-1' })],
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: 'unclear', availability: 'next_period' }) },
    }))
    expect(trace.organizationRulebook.considered).toBe(false)
    expect(trace.organizationRulebook.status).toBe('not_applicable')
  })
})

describe('same inputs produce a byte-equivalent trace (item 15.1, Step 8 amendment item 4)', () => {
  it('two calls with identical inputs (including a fresh, structurally-identical object) produce JSON-identical output', () => {
    const input = baseInput({ organizationRules: [orgRule()] })
    const first = buildCommercialDecisionTrace(input)
    // Round-trip through JSON to prove genuine structural equality is
    // enough (not object identity) — reconstruct the Date afterward since
    // JSON has no Date type of its own (JSON.stringify serializes it to a
    // string; this is a test-fixture concern, not something the composer
    // itself needs to handle, since it never calls JSON on its own input).
    const roundTripped = JSON.parse(JSON.stringify(input))
    roundTripped.asOf = new Date(input.asOf.getTime())
    const second = buildCommercialDecisionTrace(roundTripped)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('calling twice with the exact same input object is idempotent (no mutation of input, no hidden state)', () => {
    const input = baseInput({ organizationRules: [orgRule()] })
    const first = JSON.stringify(buildCommercialDecisionTrace(input))
    const second = JSON.stringify(buildCommercialDecisionTrace(input))
    expect(second).toBe(first)
  })

  it('same inputs + same explicit asOf -> byte-equivalent trace, and the serialized trace declares itself a reconstructed snapshot', () => {
    const input = baseInput({ organizationRules: [orgRule()], asOf: new Date('2026-08-22T12:00:00.000Z') })
    const first = buildCommercialDecisionTrace(input)
    const second = buildCommercialDecisionTrace({ ...input, asOf: new Date('2026-08-22T12:00:00.000Z') })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.traceMode).toBe('reconstructed_snapshot')
    expect(first.evaluatedAsOf).toBe('2026-08-22T12:00:00.000Z')
    expect(JSON.stringify(first)).toMatch(/"traceMode":"reconstructed_snapshot"/)
  })

  it('a different explicit asOf changes evaluatedAsOf but nothing else about a purely time-independent resolution', () => {
    const input = baseInput({ organizationRules: [orgRule()] })
    const first = buildCommercialDecisionTrace({ ...input, asOf: new Date('2026-08-22T12:00:00.000Z') })
    const second = buildCommercialDecisionTrace({ ...input, asOf: new Date('2027-01-01T00:00:00.000Z') })
    expect(first.evaluatedAsOf).not.toBe(second.evaluatedAsOf)
    const withoutEvaluatedAsOf = (trace: typeof first) => JSON.stringify({ ...trace, evaluatedAsOf: undefined })
    expect(withoutEvaluatedAsOf(first)).toBe(withoutEvaluatedAsOf(second))
  })
})

describe('no raw contract text or AI reasoning enters the trace (item 15.2, 15.3)', () => {
  it('DecisionTraceInput has no field capable of carrying a source clause, full prompt, or AI reasoning string', () => {
    // Structural: TypeScript itself is the enforcement — there is no
    // sourceClause/reasoning/prompt FIELD on DecisionTraceInput at all, so
    // no caller can pass one through. Checks for actual field declarations/
    // property access (e.g. "sourceClause:", ".reasoning") rather than the
    // bare words, since this module's own comments legitimately discuss
    // — in prose — why those concepts are deliberately excluded.
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/rulebook/decision-trace.ts'), 'utf-8')
    expect(source).not.toMatch(/sourceClause\s*[:?]/)
    expect(source).not.toMatch(/[.\s]reasoning\s*[:?]/)
    expect(source).not.toMatch(/\bprompt\s*[:?]/i)
  })

  it('decision-trace.ts has no import line pulling in lib/rule-interpretation.ts or RuleProposal — the module carrying reasoning/sourceClause', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'lib/rulebook/decision-trace.ts'), 'utf-8')
    const importLines = source.split('\n').filter(line => /^import /.test(line.trim()))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line).not.toMatch(/rule-interpretation/)
      expect(line).not.toMatch(/RuleProposal/)
    }
  })

  it('a realistic trace, serialized, never contains customer/org free text — only rule ids, versions, enums, and booleans', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: true, currentProvenance: 'organization_rulebook',
      organizationRules: [orgRule({ name: 'SUPER SECRET CUSTOMER POLICY NAME', description: 'do not leak this description text' })],
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'organization_rulebook', availability: 'next_period' }) },
    }))
    const serialized = JSON.stringify(trace)
    expect(serialized).not.toMatch(/SUPER SECRET/)
    expect(serialized).not.toMatch(/do not leak/)
  })
})

describe('contract-derived authority remains contract-derived even when AI guidance was used (item 15.5)', () => {
  it('explicit, contract_derived carry_forward -> final.authority stays contract_derived; method reflects verdix_rulebook only because the Rulebook affirmed it, never becoming the authority itself', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: true, currentProvenance: 'contract_derived',
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period' }) },
      interpretationContext: 'service_credit_proposal', aiProposalState: 'clear_from_source',
    }))
    expect(trace.final?.authority).toBe('contract_derived')
    expect(trace.final?.method).toBe('verdix_rulebook')
    expect(trace.globalRulebook.matchedRuleIds).toContain('credit.explicit_carry_forward_authoritative')
    expect(trace.globalRulebook.findings.some(f => f.rule_id === 'credit.explicit_carry_forward_authoritative' && f.outcome === 'supports')).toBe(true)
    // AI guidance was genuinely selected for this context...
    expect(trace.ai?.guidanceRuleIds).toContain('credit.explicit_carry_forward_authoritative')
    // ...but never appears as authority anywhere in the trace.
    expect(JSON.stringify(trace)).not.toMatch(/"authority":"verdix_rulebook"/)
  })

  it('a contract_derived value the explicit-carry-forward rule does NOT affirm (e.g. carry_forward=false) -> method falls back to existing_normalized_state, never verdix_rulebook', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: false, currentProvenance: 'contract_derived',
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: false, survival_provenance: 'contract_derived', availability: 'next_period' }) },
    }))
    expect(trace.final?.authority).toBe('contract_derived')
    expect(trace.final?.method).toBe('existing_normalized_state')
  })
})

describe('reviewer_policy correctly outranks organization_rulebook in the trace (item 15.6)', () => {
  it('reviewer override of a previously org-resolved field -> reviewer_policy selected, organization_rulebook suppressed, final reflects the reviewer value', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: false, currentProvenance: 'reviewer_policy',
      organizationRules: [orgRule({ value: true })],
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: false, survival_provenance: 'reviewer_policy', availability: 'next_period' }) },
    }))
    expect(trace.final).toEqual({ value: false, authority: 'reviewer_policy', method: 'existing_normalized_state' })
    expect(trace.precedence.selectedAuthority).toBe('reviewer_policy')
    expect(trace.precedence.suppressedAuthorities).toEqual(['organization_rulebook'])
    expect(trace.organizationRulebook.considered).toBe(true)
    expect(trace.organizationRulebook.matchedRuleIds).toEqual(['rule-1'])
    expect(trace.organizationRulebook.status).toBe('not_applicable')
    expect(trace.reviewer.suppliedDecision).toBe(true)
    expect(trace.execution.readinessBlocking).toBe(false)
  })
})

describe('conflict produces no selected value (item 15.7)', () => {
  it('two equally-specific, conflicting organization rules -> organizationRulebook.status conflict, final undefined, precedence has no selected authority, readiness blocked', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      organizationRules: [
        orgRule({ id: 'rule-a', value: true }),
        orgRule({ id: 'rule-b', value: false }),
      ],
    }))
    expect(trace.organizationRulebook.status).toBe('conflict')
    expect(trace.organizationRulebook.matchedRuleIds.sort()).toEqual(['rule-a', 'rule-b'])
    expect(trace.organizationRulebook.selectedRuleId).toBeUndefined()
    expect(trace.final).toBeUndefined()
    expect(trace.precedence.selectedAuthority).toBeUndefined()
    expect(trace.precedence.suppressedAuthorities).toEqual(['organization_rulebook', 'organization_rulebook'])
    expect(trace.execution.readinessBlocking).toBe(true)
  })
})

describe('a recommendation alone remains unresolved (item 15.8)', () => {
  it('current provenance verdix_recommends, no org policy, no contract/reviewer decision -> final stays undefined, recommendation shows as suppressed, readiness blocked', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: true, currentProvenance: 'verdix_recommends',
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: 'verdix_recommends', availability: 'next_period' }) },
    }))
    expect(trace.final).toBeUndefined()
    expect(trace.precedence.selectedAuthority).toBeUndefined()
    expect(trace.precedence.suppressedAuthorities).toEqual(['verdix_recommends'])
    expect(trace.sourceState.explicitContractEvidence).toBe(false)
    expect(trace.sourceState.contractProvenance).toBe('verdix_recommends')
    expect(trace.execution.readinessBlocking).toBe(true)
  })
})

describe('invariant finding is never confused with an invariant violation (item 15.9)', () => {
  it('a verdix_recommends-graded provenanced field produces a remains_unresolved invariant finding (H), never an execution violation', () => {
    const trace = buildCommercialDecisionTrace(baseInput({
      currentValue: true, currentProvenance: 'verdix_recommends',
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: 'unclear', survival_provenance: 'verdix_recommends', availability: 'next_period' }) },
    }))
    const hFinding = trace.globalRulebook.findings.find(f => f.rule_id === 'provenance.verdix_recommendation_cannot_clear_readiness')
    expect(hFinding?.outcome).toBe('remains_unresolved')
    expect(trace.execution.invariantsEvaluated).toContain('provenance.verdix_recommendation_cannot_clear_readiness')
    expect(trace.execution.invariantViolations).toEqual([])
  })

  it('minimum-floor and all-units execution invariants never match a credit-domain context at all — invariantViolations for survival.carry_forward is always structurally empty', () => {
    const trace = buildCommercialDecisionTrace(baseInput({ organizationRules: [orgRule()] }))
    expect(trace.execution.invariantViolations).toEqual([])
  })
})

describe('versions are carried for later debuggability (item 14)', () => {
  it('trace.versions always includes rulebook and activation versions; aiGuidance only when the ai section is present', () => {
    const withoutAI = buildCommercialDecisionTrace(baseInput())
    expect(withoutAI.versions.rulebook).toBeTruthy()
    expect(withoutAI.versions.activation).toBeTruthy()
    expect(withoutAI.versions.aiGuidance).toBeUndefined()

    const withAI = buildCommercialDecisionTrace(baseInput({ interpretationContext: 'service_credit_proposal' }))
    expect(withAI.versions.aiGuidance).toBeTruthy()
  })
})

describe('AI guidance selection is deterministic, not inferred from output (item 4, item 15)', () => {
  it('guidanceRuleIds is the exact deterministic set for the given context, independent of what the field currently resolves to', () => {
    const unresolvedTrace = buildCommercialDecisionTrace(baseInput({ interpretationContext: 'service_credit_proposal' }))
    const resolvedTrace = buildCommercialDecisionTrace(baseInput({
      currentValue: true, currentProvenance: 'contract_derived', interpretationContext: 'service_credit_proposal',
      domainContext: { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period' }) },
    }))
    expect(unresolvedTrace.ai?.guidanceRuleIds).toEqual(resolvedTrace.ai?.guidanceRuleIds)
  })

  it('service_credit_survival context excludes the basis/scope and cash-redeemability guidance entries, matching lib/rulebook/ai-guidance.ts exactly', () => {
    const trace = buildCommercialDecisionTrace(baseInput({ interpretationContext: 'service_credit_survival' }))
    expect(trace.ai?.guidanceRuleIds).not.toContain('credit.basis_ne_application_scope')
    expect(trace.ai?.guidanceRuleIds).not.toContain('credit.application_scope_ne_cash_redeemability')
    expect(trace.ai?.guidanceRuleIds).toContain('credit.next_invoice_timing_ne_carry_forward')
  })
})
