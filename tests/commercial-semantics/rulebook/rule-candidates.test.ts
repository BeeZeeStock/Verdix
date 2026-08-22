// Verdix Global Rulebook — candidate registry (Step 9). Proves the first
// retrospective governance record — credit.application_scope_ne_cash_
// redeemability, the Step 7 amendment rule — is itself well-formed and
// passes both the candidate validator and the full registry audit. This
// is the "worked example" required by item 6: showing the lifecycle
// (observed -> candidate -> validated -> approved -> active) actually
// holds up under the governance machinery Step 9 introduces.
import { describe, it, expect } from 'vitest'
import { CASH_REDEEMABILITY_CANDIDATE, VERDIX_RULE_CANDIDATES } from '@/lib/rulebook/rule-candidates'
import { validateVerdixRuleCandidate } from '@/lib/rulebook/candidate-validation'
import { auditVerdixRulebook } from '@/lib/rulebook/rulebook-audit'
import { verdixCommercialRulebook } from '@/lib/rulebook/rules'
import { VERDIX_FIXTURE_REGISTRY } from '@/lib/rulebook/fixture-registry'

describe('the retrospective cash-redeemability candidate record (item 6)', () => {
  it('is classified anti_inference, matching the real active rule', () => {
    expect(CASH_REDEEMABILITY_CANDIDATE.proposedClass).toBe('anti_inference')
    const activeRule = verdixCommercialRulebook.find(r => r.id === CASH_REDEEMABILITY_CANDIDATE.activeRuleId)
    expect(activeRule?.ruleClass).toBe('anti_inference')
  })

  it('has a Verdix-controlled origin, never customer-derived', () => {
    expect(CASH_REDEEMABILITY_CANDIDATE.origin).toBe('verdix_synthetic_test')
  })

  it('references real, registered fixture ids for both positive evidence and counterexamples', () => {
    expect(CASH_REDEEMABILITY_CANDIDATE.evidenceFixtureIds).toEqual(['credit.application_scope_only.cash_unresolved'])
    expect(CASH_REDEEMABILITY_CANDIDATE.counterexampleFixtureIds).toEqual([
      'credit.application_scope_explicit_no_cash', 'credit.application_scope_explicit_cash_allowed',
    ])
    for (const id of [...CASH_REDEEMABILITY_CANDIDATE.evidenceFixtureIds, ...CASH_REDEEMABILITY_CANDIDATE.counterexampleFixtureIds]) {
      expect(VERDIX_FIXTURE_REGISTRY[id]).toBeDefined()
    }
  })

  it('is status approved and points at the real, active rule it documents', () => {
    expect(CASH_REDEEMABILITY_CANDIDATE.status).toBe('approved')
    expect(CASH_REDEEMABILITY_CANDIDATE.activeRuleId).toBe('credit.application_scope_ne_cash_redeemability')
    expect(verdixCommercialRulebook.some(r => r.id === CASH_REDEEMABILITY_CANDIDATE.activeRuleId)).toBe(true)
  })

  // Local to THIS retrospective record only (Step 9 final amendment, item
  // 6) — accurately describes this specific promotion, where the proposed
  // guidance text and what shipped are known to be identical. This is
  // NOT a general governance invariant: auditVerdixRulebook() does not,
  // and must not, require proposedAIGuidance to exactly equal a rule's
  // current aiGuidance.instruction globally — a candidate preserves what
  // was proposed/reviewed at approval time, and a LATER, separately
  // governed revision to a rule's guidance wording may legitimately
  // diverge from that historical record without invalidating it.
  it('its proposedAIGuidance matches the real, active rule\'s aiGuidance.instruction today — the candidate record accurately documents what shipped at promotion time', () => {
    const activeRule = verdixCommercialRulebook.find(r => r.id === CASH_REDEEMABILITY_CANDIDATE.activeRuleId)
    expect(activeRule?.aiGuidance?.instruction).toBe(CASH_REDEEMABILITY_CANDIDATE.proposedAIGuidance)
  })

  it('this record does not change the already-active rule itself — it is a documentation-only record (item 6)', () => {
    // The candidate module has no import of anything that could mutate
    // rules.ts, and rules.ts has no import of the candidate registry —
    // structurally two one-way, non-overlapping dependency directions.
    expect(verdixCommercialRulebook.length).toBe(9)
  })

  it('passes validateVerdixRuleCandidate outright — a real, well-formed governance record, not just an illustrative sketch', () => {
    const result = validateVerdixRuleCandidate(CASH_REDEEMABILITY_CANDIDATE, VERDIX_FIXTURE_REGISTRY, VERDIX_RULE_CANDIDATES)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('passes the full registry integrity audit (item 14: "Step 7 cash-redeemability rule passes the full governance audit")', () => {
    const result = auditVerdixRulebook(VERDIX_RULE_CANDIDATES)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})
