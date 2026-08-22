// Step 10, item 9 — the milestone/project-billing candidate records
// (lib/rulebook/rule-candidates.ts) validated through the real Step 9
// governance machinery: validateVerdixRuleCandidate and
// auditVerdixRulebook, unmodified. Proves these records are well-formed
// governance artifacts, not just prose in a report.
import { describe, it, expect } from 'vitest'
import {
  VERDIX_RULE_CANDIDATES,
  MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE,
  MILESTONE_RETENTION_NE_DISCOUNT_OBSERVATION,
  MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION,
  MILESTONE_CHANGE_ORDER_APPROVAL_OBSERVATION,
  MILESTONE_PERCENTAGE_BASIS_NE_PAYMENT_TIMING_OBSERVATION,
} from '@/lib/rulebook/rule-candidates'
import { validateVerdixRuleCandidate } from '@/lib/rulebook/candidate-validation'
import { auditVerdixRulebook } from '@/lib/rulebook/rulebook-audit'
import { VERDIX_FIXTURE_REGISTRY } from '@/lib/rulebook/fixture-registry'

describe('candidate.milestone.delivery_ne_acceptance — the one candidate that reaches VALIDATED', () => {
  it('is anti_inference, verdix_synthetic_test origin, status validated (not approved, not active)', () => {
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.proposedClass).toBe('anti_inference')
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.origin).toBe('verdix_synthetic_test')
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.status).toBe('validated')
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.activeRuleId).toBeUndefined()
  })

  it('has both real positive and counterexample fixture evidence, both registered', () => {
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.evidenceFixtureIds.length).toBeGreaterThan(0)
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.counterexampleFixtureIds.length).toBeGreaterThan(0)
    for (const id of [...MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.evidenceFixtureIds, ...MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.counterexampleFixtureIds]) {
      expect(VERDIX_FIXTURE_REGISTRY[id]).toBeDefined()
    }
  })

  it('passes validateVerdixRuleCandidate outright', () => {
    const result = validateVerdixRuleCandidate(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE, VERDIX_FIXTURE_REGISTRY, VERDIX_RULE_CANDIDATES)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('the four OBSERVED principles — recorded honestly, not force-promoted', () => {
  const observations = [
    MILESTONE_RETENTION_NE_DISCOUNT_OBSERVATION,
    MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION,
    MILESTONE_CHANGE_ORDER_APPROVAL_OBSERVATION,
    MILESTONE_PERCENTAGE_BASIS_NE_PAYMENT_TIMING_OBSERVATION,
  ]

  it('all four stay at status "observed" — item 8: do not immediately add a Global Rulebook rule from repeated exposure alone', () => {
    for (const observation of observations) expect(observation.status).toBe('observed')
  })

  it('none claims fixture evidence it does not have — evidence-gathering for these is exactly what a future step would do, not fabricated here', () => {
    for (const observation of observations) {
      expect(observation.evidenceFixtureIds).toEqual([])
      expect(observation.counterexampleFixtureIds).toEqual([])
    }
  })

  it('all four pass validateVerdixRuleCandidate at their honest, early stage (no evidence is required until validated)', () => {
    for (const observation of observations) {
      const result = validateVerdixRuleCandidate(observation, VERDIX_FIXTURE_REGISTRY, VERDIX_RULE_CANDIDATES)
      expect(result.valid).toBe(true)
    }
  })

  it('every proposedRuleId across all six Step 10 + Step 7 candidates is unique — no accidental collisions', () => {
    const ids = VERDIX_RULE_CANDIDATES.map(c => c.proposedRuleId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Step 10 candidates do not disturb the governance audit — zero new active rules, zero grandfather-list changes (items 15, 16, 17)', () => {
  it('the full registry (Step 7 + Step 10 candidates) still passes auditVerdixRulebook with no arguments', () => {
    const result = auditVerdixRulebook()
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('none of the five new candidates has an activeRuleId — none claims to be an active Global Rulebook rule', () => {
    for (const candidate of [
      MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE, MILESTONE_RETENTION_NE_DISCOUNT_OBSERVATION,
      MILESTONE_ENTITLEMENT_NE_INVOICEABILITY_OBSERVATION, MILESTONE_CHANGE_ORDER_APPROVAL_OBSERVATION,
      MILESTONE_PERCENTAGE_BASIS_NE_PAYMENT_TIMING_OBSERVATION,
    ]) {
      expect(candidate.activeRuleId).toBeUndefined()
    }
  })
})
