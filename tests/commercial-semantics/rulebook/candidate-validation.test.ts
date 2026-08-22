// Verdix Global Rulebook — candidate validation (Step 9). Pure tests for
// lib/rulebook/candidate-validation.ts's validateVerdixRuleCandidate:
// class-aware evidence requirements, structural rejections, and proof
// this validator can only reject a candidate, never promote one.
import { describe, it, expect } from 'vitest'
import { validateVerdixRuleCandidate } from '@/lib/rulebook/candidate-validation'
import { assertAuthorityAllowedForClass, ruleClassAllows } from '@/lib/rulebook/rule-class'
import type { VerdixRuleCandidate } from '@/lib/rulebook/candidate'
import type { VerdixFixtureDescriptor } from '@/lib/rulebook/fixture-registry'

const FIXTURES: Record<string, VerdixFixtureDescriptor> = {
  'fixture.positive.1': { id: 'fixture.positive.1', kind: 'positive', location: 'test', description: 'positive case' },
  'fixture.positive.2': { id: 'fixture.positive.2', kind: 'positive', location: 'test', description: 'second positive case' },
  'fixture.adversarial.1': { id: 'fixture.adversarial.1', kind: 'adversarial', location: 'test', description: 'adversarial edge case' },
  'fixture.counterexample.1': { id: 'fixture.counterexample.1', kind: 'counterexample', location: 'test', description: 'counterexample case' },
  'fixture.counterexample.2': { id: 'fixture.counterexample.2', kind: 'counterexample', location: 'test', description: 'second counterexample case' },
}

function candidate(overrides: Partial<VerdixRuleCandidate> = {}): VerdixRuleCandidate {
  return {
    id: 'candidate.test.1',
    proposedRuleId: 'test.rule_id',
    proposedClass: 'anti_inference',
    status: 'candidate',
    principle: 'A does not, by itself, establish B.',
    origin: 'verdix_synthetic_test',
    evidenceFixtureIds: [],
    counterexampleFixtureIds: [],
    rationale: 'Found during synthetic testing.',
    ...overrides,
  }
}

describe('valid candidates pass, per class (item 14)', () => {
  it('a valid invariant candidate passes: positive + adversarial fixtures, no counterexample', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'invariant', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1', 'fixture.adversarial.1'],
      counterexampleFixtureIds: [],
    }), FIXTURES)
    expect(result.valid).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('a valid anti_inference candidate passes: positive + counterexample fixtures', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'anti_inference', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
    }), FIXTURES)
    expect(result.valid).toBe(true)
  })

  it('a valid semantic_interpretation candidate passes: positive wording variant + negative/absent-wording counterexample', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'semantic_interpretation', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
    }), FIXTURES)
    expect(result.valid).toBe(true)
  })

  it('a valid default_policy candidate passes: >=2 fixtures, a counterexample, and explicit approval metadata', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'default_policy', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1', 'fixture.positive.2'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
      defaultPolicyApproval: {
        approvedBy: 'product@verdix.test', approvedAt: '2026-08-23T00:00:00Z',
        organizationOverrideable: true, productionActivationDecisionRequired: true,
        note: 'Approved as a broadly defensible default; activation is a separate, later decision.',
      },
    }), FIXTURES)
    expect(result.valid).toBe(true)
  })

  it('an early-stage candidate ("observed"/"candidate") with no evidence yet still passes structural checks', () => {
    const observed = validateVerdixRuleCandidate(candidate({ status: 'observed' }), FIXTURES)
    expect(observed.valid).toBe(true)
    const candidateStage = validateVerdixRuleCandidate(candidate({ status: 'candidate' }), FIXTURES)
    expect(candidateStage.valid).toBe(true)
  })
})

describe('customer-derived origin is rejected, not just discouraged (item 2, item 14)', () => {
  it('a candidate asserting a forbidden origin string is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({ origin: 'customer_contract' as never }), FIXTURES)
    expect(result.valid).toBe(false)
    expect(result.issues.map(i => i.code)).toContain('customer_derived_origin')
  })
})

describe('missing structural fields are rejected (item 7, item 14)', () => {
  it('missing principle is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({ principle: '' }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('missing_principle')
  })

  it('an invalid proposed Rulebook class is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({ proposedClass: 'not_a_real_class' as never }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('invalid_proposed_class')
  })

  it('missing positive evidence at validated status is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({
      status: 'validated', evidenceFixtureIds: [], counterexampleFixtureIds: ['fixture.counterexample.1'],
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('no_positive_evidence')
  })

  it('missing counterexample evidence at validated status is rejected (anti_inference/semantic_interpretation)', () => {
    const result = validateVerdixRuleCandidate(candidate({
      status: 'validated', evidenceFixtureIds: ['fixture.positive.1'], counterexampleFixtureIds: [],
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('no_counterexample_evidence')
  })

  it('an invariant candidate WITH a counterexample is rejected — a real invariant has none', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'invariant', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1', 'fixture.adversarial.1'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('invariant_has_counterexample')
  })

  it('an invariant candidate without an adversarial fixture is rejected even with a positive one', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'invariant', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1'], counterexampleFixtureIds: [],
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('invariant_missing_adversarial_fixture')
  })

  it('an unknown fixture ID is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({ evidenceFixtureIds: ['fixture.does.not.exist'] }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('unknown_fixture_id')
  })

  it('a duplicate proposedRuleId without supersession intent is rejected', () => {
    const existing = candidate({ id: 'candidate.existing', proposedRuleId: 'shared.rule_id' })
    const collidingCandidate = candidate({ id: 'candidate.new', proposedRuleId: 'shared.rule_id' })
    const result = validateVerdixRuleCandidate(collidingCandidate, FIXTURES, [existing])
    expect(result.issues.map(i => i.code)).toContain('duplicate_rule_id')
  })

  it('a duplicate proposedRuleId WITH explicit supersession intent is allowed', () => {
    const existing = candidate({ id: 'candidate.existing', proposedRuleId: 'shared.rule_id' })
    const supersedingCandidate = candidate({ id: 'candidate.new', proposedRuleId: 'shared.rule_id', supersedesCandidateId: 'candidate.existing' })
    const result = validateVerdixRuleCandidate(supersedingCandidate, FIXTURES, [existing])
    expect(result.issues.map(i => i.code)).not.toContain('duplicate_rule_id')
  })

  it('default_policy without defaultPolicyApproval is rejected at validated status', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'default_policy', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1', 'fixture.positive.2'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('default_policy_missing_approval')
  })

  it('default_policy needs a materially higher evidence bar than anti_inference/semantic_interpretation — a single positive fixture is not enough', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'default_policy', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1'], // only one — anti_inference would accept this, default_policy must not
      counterexampleFixtureIds: ['fixture.counterexample.1'],
      defaultPolicyApproval: {
        approvedBy: 'product@verdix.test', approvedAt: '2026-08-23T00:00:00Z',
        organizationOverrideable: true, productionActivationDecisionRequired: true, note: 'approved',
      },
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('default_policy_insufficient_evidence')
  })

  it('default_policy approval that is not organization-overrideable is rejected', () => {
    const result = validateVerdixRuleCandidate(candidate({
      proposedClass: 'default_policy', status: 'validated',
      evidenceFixtureIds: ['fixture.positive.1', 'fixture.positive.2'],
      counterexampleFixtureIds: ['fixture.counterexample.1'],
      defaultPolicyApproval: {
        approvedBy: 'product@verdix.test', approvedAt: '2026-08-23T00:00:00Z',
        organizationOverrideable: false, productionActivationDecisionRequired: true, note: 'approved',
      },
    }), FIXTURES)
    expect(result.issues.map(i => i.code)).toContain('default_policy_not_overrideable')
  })

  it('AI guidance proposed for a class that can never carry it (invariant, default_policy) is rejected', () => {
    const invariantWithGuidance = validateVerdixRuleCandidate(candidate({ proposedClass: 'invariant', proposedAIGuidance: 'do something' }), FIXTURES)
    expect(invariantWithGuidance.issues.map(i => i.code)).toContain('ai_guidance_wrong_class')
    const defaultPolicyWithGuidance = validateVerdixRuleCandidate(candidate({ proposedClass: 'default_policy', proposedAIGuidance: 'do something' }), FIXTURES)
    expect(defaultPolicyWithGuidance.issues.map(i => i.code)).toContain('ai_guidance_wrong_class')
  })

  it('AI guidance proposed for an eligible class (anti_inference, semantic_interpretation) is accepted', () => {
    const result = validateVerdixRuleCandidate(candidate({ proposedClass: 'anti_inference', proposedAIGuidance: 'do something' }), FIXTURES)
    expect(result.issues.map(i => i.code)).not.toContain('ai_guidance_wrong_class')
  })
})

describe('validation never mutates the input or the Global Rulebook registry (item 7)', () => {
  it('validateVerdixRuleCandidate is a pure function — the candidate object is untouched', () => {
    const input = candidate({ status: 'validated', evidenceFixtureIds: ['fixture.positive.1'], counterexampleFixtureIds: ['fixture.counterexample.1'] })
    const before = JSON.stringify(input)
    validateVerdixRuleCandidate(input, FIXTURES)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('class capability boundaries reconfirmed at candidate-review time (item 14)', () => {
  it('an anti_inference candidate could never be promoted with a value-producing (silence-filling) authority — reconfirms rule-class.ts\'s existing capability matrix', () => {
    expect(ruleClassAllows('anti_inference', 'canProduceResolutionCandidate')).toBe(false)
    expect(ruleClassAllows('anti_inference', 'canFillContractSilence')).toBe(false)
  })

  it('a semantic_interpretation candidate could never be promoted to mint authority: verdix_rulebook — reconfirms rule-class.ts\'s assertAuthorityAllowedForClass', () => {
    expect(() => assertAuthorityAllowedForClass('semantic_interpretation', 'verdix_rulebook', 'candidate governance check')).toThrow(/may never mint authority: 'verdix_rulebook'/)
  })

  it('only default_policy candidates could ever legitimately mint verdix_rulebook authority if promoted', () => {
    expect(() => assertAuthorityAllowedForClass('default_policy', 'verdix_rulebook')).not.toThrow()
    expect(() => assertAuthorityAllowedForClass('invariant', 'verdix_rulebook')).toThrow()
    expect(() => assertAuthorityAllowedForClass('anti_inference', 'verdix_rulebook')).toThrow()
  })
})
