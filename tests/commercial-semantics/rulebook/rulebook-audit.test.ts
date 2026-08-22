// Verdix Global Rulebook — registry integrity audit (Step 9, incl. the
// final amendment's governance-coverage check). Pure tests for
// lib/rulebook/rulebook-audit.ts's auditVerdixRulebook: cross-checking the
// REAL, active Rulebook against the candidate governance registry, and —
// per the amendment — proving every active rule is either grandfathered
// or governed by an approved candidate, closing the "add a rule straight
// to rules.ts" bypass.
import { describe, it, expect } from 'vitest'
import { auditVerdixRulebook } from '@/lib/rulebook/rulebook-audit'
import { GRANDFATHERED_VERDIX_RULE_IDS } from '@/lib/rulebook/rule-candidates'
import type { VerdixRuleCandidate } from '@/lib/rulebook/candidate'
import type { VerdixRulebookRule } from '@/lib/rulebook/types'

function candidate(overrides: Partial<VerdixRuleCandidate> = {}): VerdixRuleCandidate {
  return {
    id: 'candidate.test.1',
    proposedRuleId: 'minimum.floor.non_additive', // a real, active rule id
    proposedClass: 'invariant',
    status: 'approved',
    principle: 'test principle',
    origin: 'verdix_synthetic_test',
    evidenceFixtureIds: [],
    counterexampleFixtureIds: [],
    rationale: 'test rationale',
    ...overrides,
  }
}

// A minimal, synthetic VerdixRulebookRule — never a real rule, never
// touching lib/rulebook/rules.ts's actual verdixCommercialRulebook. Used
// only to exercise auditVerdixRulebook's injectable `rules` parameter
// (added specifically so "a synthetic new active rule" is testable
// without mutating the real, production registry).
function syntheticRule(overrides: Partial<VerdixRulebookRule> = {}): VerdixRulebookRule {
  return {
    id: 'synthetic.brand_new_rule',
    version: 1,
    ruleClass: 'anti_inference',
    description: 'a synthetic rule for audit testing only',
    matches: () => false,
    evaluate: () => [],
    ...overrides,
  }
}

describe('auditVerdixRulebook — the real, live registry (item 10)', () => {
  it('the real registry passes with no arguments (defaults to the real VERDIX_RULE_CANDIDATES)', () => {
    const result = auditVerdixRulebook()
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('approved candidate with a missing active rule is detected (item 14)', () => {
  it('a candidate claiming an activeRuleId that does not exist in verdixCommercialRulebook is flagged', () => {
    const result = auditVerdixRulebook([candidate({ activeRuleId: 'no.such.rule.exists' })])
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('approved_candidate_missing_active_rule')
  })

  it('a candidate at status "approved" with NO activeRuleId at all is not flagged as missing — it simply has not been promoted yet', () => {
    const result = auditVerdixRulebook([candidate({ activeRuleId: undefined })])
    expect(result.issues.map(i => i.code)).not.toContain('approved_candidate_missing_active_rule')
  })

  it('a candidate whose proposedClass has drifted from the now-active rule\'s real class is flagged', () => {
    const result = auditVerdixRulebook([candidate({
      proposedRuleId: 'minimum.floor.non_additive', proposedClass: 'anti_inference', // real rule is actually 'invariant'
      activeRuleId: 'minimum.floor.non_additive',
    })])
    expect(result.issues.map(i => i.code)).toContain('candidate_class_drifted_from_active_rule')
  })
})

describe('active rule with a governance record can be audited cleanly (item 14)', () => {
  it('a candidate that correctly matches an active rule\'s real class produces no issues for that rule', () => {
    const result = auditVerdixRulebook([candidate({
      proposedRuleId: 'minimum.floor.non_additive', proposedClass: 'invariant',
      activeRuleId: 'minimum.floor.non_additive',
    })])
    expect(result.issues.map(i => i.code)).not.toContain('candidate_class_drifted_from_active_rule')
    expect(result.issues.map(i => i.code)).not.toContain('approved_candidate_missing_active_rule')
  })
})

describe('no customer-derived provenance reaches the audit (item 14)', () => {
  it('a candidate with a forbidden origin is flagged even though the type system should already prevent it — defense in depth', () => {
    const result = auditVerdixRulebook([candidate({ origin: 'customer_contract' as never })])
    expect(result.issues.map(i => i.code)).toContain('customer_derived_candidate_origin')
  })
})

describe('AI-guidance eligibility compatibility (item 10)', () => {
  it('no real rule in rules.ts carries aiGuidance while classified outside anti_inference/semantic_interpretation', () => {
    const result = auditVerdixRulebook()
    expect(result.issues.map(i => i.code)).not.toContain('ai_guidance_wrong_class')
  })
})

describe('default_policy governance (item 10)', () => {
  it('zero default_policy rules are active today, so this check is currently vacuous — confirmed rather than assumed', () => {
    const result = auditVerdixRulebook()
    expect(result.issues.map(i => i.code)).not.toContain('default_policy_active_without_approval')
  })
})

describe('audit never mutates the real registries (item 10)', () => {
  it('calling auditVerdixRulebook twice produces identical results — pure, no hidden state', () => {
    const first = JSON.stringify(auditVerdixRulebook())
    const second = JSON.stringify(auditVerdixRulebook())
    expect(second).toBe(first)
  })
})

// ── Step 9 final amendment — governance coverage ───────────────────────

describe('GRANDFATHERED_VERDIX_RULE_IDS is frozen (amendment item 3)', () => {
  it('contains exactly the eight pre-governance rule ids, in this exact set — casually adding a ninth must fail this test', () => {
    expect([...GRANDFATHERED_VERDIX_RULE_IDS].sort()).toEqual([
      'credit.basis_ne_application_scope',
      'credit.explicit_carry_forward_authoritative',
      'credit.future_payable_scope_ne_indefinite_survival',
      'credit.next_invoice_timing_ne_carry_forward',
      'minimum.floor.non_additive',
      'pricing.all_units.non_graduated',
      'provenance.silence_cannot_become_contract_derived',
      'provenance.verdix_recommendation_cannot_clear_readiness',
    ].sort())
    expect(GRANDFATHERED_VERDIX_RULE_IDS).toHaveLength(8)
  })

  it('does NOT include the Step 7 cash-redeemability rule — that rule is governed by its real candidate, not grandfathered (amendment item 5)', () => {
    expect(GRANDFATHERED_VERDIX_RULE_IDS as readonly string[]).not.toContain('credit.application_scope_ne_cash_redeemability')
  })
})

describe('governance coverage — every active rule must be grandfathered or candidate-governed (amendment items 1, 4)', () => {
  it('an existing grandfathered rule (with no candidate at all) passes', () => {
    const result = auditVerdixRulebook([], [syntheticRule({ id: GRANDFATHERED_VERDIX_RULE_IDS[0] })])
    expect(result.ok).toBe(true)
    expect(result.issues.map(i => i.code)).not.toContain('rule_missing_governance_coverage')
  })

  it('an approved candidate + a matching active rule passes governance coverage specifically', () => {
    // Note: the synthetic rule has no VERDIX_RULEBOOK_ACTIVATION entry
    // (that registry is real and global, not injectable), so this
    // isolated case still surfaces an unrelated 'missing_activation_entry'
    // issue — irrelevant to what this test checks: governance coverage.
    const rule = syntheticRule({ id: 'synthetic.governed_rule', ruleClass: 'anti_inference' })
    const cand = candidate({ proposedRuleId: rule.id, proposedClass: 'anti_inference', activeRuleId: rule.id, status: 'approved' })
    const result = auditVerdixRulebook([cand], [rule])
    expect(result.issues.map(i => i.code)).not.toContain('rule_missing_governance_coverage')
    expect(result.issues.map(i => i.code)).not.toContain('candidate_class_drifted_from_active_rule')
    expect(result.issues.map(i => i.code)).not.toContain('approved_candidate_missing_active_rule')
  })

  it('a synthetic new active rule with no candidate and not grandfathered fails the audit', () => {
    const rule = syntheticRule({ id: 'synthetic.ungoverned_rule' })
    const result = auditVerdixRulebook([], [rule])
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'rule_missing_governance_coverage', ruleId: 'synthetic.ungoverned_rule' }))
  })

  it('a new rule cannot become governed merely by being absent from the candidate registry — omission is not coverage', () => {
    // Empty candidates array, not "a candidate that happens not to mention
    // it" — proves the DEFAULT stance is ungoverned, not silently exempt.
    const rule = syntheticRule({ id: 'synthetic.omitted_rule' })
    const resultWithEmptyCandidates = auditVerdixRulebook([], [rule])
    expect(resultWithEmptyCandidates.ok).toBe(false)
    // Also proves an UNRELATED candidate's mere presence in the registry
    // doesn't accidentally cover an unrelated rule.
    const unrelatedCandidate = candidate({ proposedRuleId: 'some.other.rule', activeRuleId: 'some.other.rule' })
    const resultWithUnrelatedCandidate = auditVerdixRulebook([unrelatedCandidate], [rule, syntheticRule({ id: 'some.other.rule', ruleClass: 'invariant' })])
    expect(resultWithUnrelatedCandidate.issues).toContainEqual(expect.objectContaining({ code: 'rule_missing_governance_coverage', ruleId: 'synthetic.omitted_rule' }))
  })

  it('an approved candidate pointing at a missing rule fails the audit outright (reconfirms existing check under the new rules param)', () => {
    const result = auditVerdixRulebook([candidate({ activeRuleId: 'no.such.rule.exists' })], [])
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('approved_candidate_missing_active_rule')
  })

  it('an active rule whose approved candidate has a different class fails the audit outright', () => {
    const rule = syntheticRule({ id: 'synthetic.drifted_rule', ruleClass: 'invariant' })
    const cand = candidate({ proposedRuleId: rule.id, proposedClass: 'anti_inference', activeRuleId: rule.id, status: 'approved' })
    const result = auditVerdixRulebook([cand], [rule])
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('candidate_class_drifted_from_active_rule')
  })

  it('the real, live registry (all nine active rules) passes governance coverage with no arguments', () => {
    const result = auditVerdixRulebook()
    expect(result.issues.map(i => i.code)).not.toContain('rule_missing_governance_coverage')
  })
})
