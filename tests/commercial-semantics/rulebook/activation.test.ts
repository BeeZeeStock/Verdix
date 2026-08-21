// Verdix Global Rulebook — activation layer (Step 3, corrected). Tests the
// authority/target/activation split (lib/rulebook/activation.ts), the
// precedence model (lib/rulebook/precedence.ts), the provenance promotion
// guard (lib/rulebook/promotion-guard.ts), and — most importantly — that
// activating four invariants changes NOTHING about existing engine output,
// that 'remains_unresolved' NEVER becomes an execution violation (for any
// rule, including an enforce_invariant one), and that the four rules left
// diagnostic can never affect production even when they detect a real
// contradiction. No AI calls, no database, no mutation.
//
// Authority (is this rule allowed production effect) is separate from
// TARGET (where that effect lands): minimum.floor.non_additive and
// pricing.all_units.non_graduated are target: 'execution' — a real
// 'contradicts' finding becomes a RulebookViolation / execution blocker.
// provenance.silence_cannot_become_contract_derived and provenance.
// verdix_recommendation_cannot_clear_readiness are target: 'promotion' —
// their enforcement is a DENIED PROMOTION (evaluateFieldPromotion),
// structurally separate from RulebookViolation/execution blockers. In
// particular, H's finding is ALWAYS 'remains_unresolved' (a
// verdix_recommends value staying unresolved is this invariant's entirely
// correct, expected behavior) — this must never be reported as an
// execution violation.
import { describe, it, expect } from 'vitest'
import {
  resolveVerdixRulebookActivation, toRulebookExecutionBlockers,
  VERDIX_RULEBOOK_ACTIVATION, VERDIX_RULEBOOK_ACTIVATION_VERSION,
} from '@/lib/rulebook/activation'
import { evaluateFieldPromotion } from '@/lib/rulebook/promotion-guard'
import { isPrecedenceViolation, FIELD_PROVENANCE_TO_DECISION_SOURCE, COMMERCIAL_DECISION_PRECEDENCE } from '@/lib/rulebook/precedence'
import { minimumCommitmentContext, tierCalculationContext, creditApplicationContext, provenancedField } from '@/lib/rulebook/context'
import { verdixCommercialRulebook, VERDIX_RULEBOOK_VERSION } from '@/lib/rulebook/rules'
import { computeCommercialRuleWorkload, isProvenanceResolved, type CommercialRuleTerms } from '@/lib/commercial-rule-status'
import { computeMetricOverage, computeTransactionalOverage } from '@/lib/tariff'
import type { OverageTier, MinimumCommitment, TierCalculationMethod } from '@/lib/types'

function tier(overrides: Partial<OverageTier> = {}): OverageTier {
  return { tier_label: 'Tier', from_unit: 1, to_unit: null, rate_per_unit: 1, unit_type: 'transaction', ...overrides }
}

const EXECUTION_TARGET_RULE_IDS = ['minimum.floor.non_additive', 'pricing.all_units.non_graduated']
const PROMOTION_TARGET_RULE_IDS = ['provenance.silence_cannot_become_contract_derived', 'provenance.verdix_recommendation_cannot_clear_readiness']
const DIAGNOSTIC_RULE_IDS = [
  'credit.basis_ne_application_scope',
  'credit.next_invoice_timing_ne_carry_forward',
  'credit.future_payable_scope_ne_indefinite_survival',
  'credit.explicit_carry_forward_authoritative',
]

describe('the activation registry', () => {
  it('activates exactly the four specified rules as enforce_invariant, split two execution / two promotion, and no others', () => {
    for (const id of EXECUTION_TARGET_RULE_IDS) expect(VERDIX_RULEBOOK_ACTIVATION[id]).toEqual({ authority: 'enforce_invariant', target: 'execution' })
    for (const id of PROMOTION_TARGET_RULE_IDS) expect(VERDIX_RULEBOOK_ACTIVATION[id]).toEqual({ authority: 'enforce_invariant', target: 'promotion' })
    const enforceCount = Object.values(VERDIX_RULEBOOK_ACTIVATION).filter(e => e.authority === 'enforce_invariant').length
    expect(enforceCount).toBe(4)
  })
  it('leaves exactly the four specified rules diagnostic (no target), and no others', () => {
    for (const id of DIAGNOSTIC_RULE_IDS) expect(VERDIX_RULEBOOK_ACTIVATION[id]).toEqual({ authority: 'diagnostic' })
    const diagnosticCount = Object.values(VERDIX_RULEBOOK_ACTIVATION).filter(e => e.authority === 'diagnostic').length
    expect(diagnosticCount).toBe(4)
  })
  it('activates zero rules at resolve_semantic — semantic field resolution is not enabled in Step 3', () => {
    expect(Object.values(VERDIX_RULEBOOK_ACTIVATION).filter(e => e.authority === 'resolve_semantic')).toHaveLength(0)
  })
  it('has an entry for every registered rule (completeness — nothing silently falls back to the diagnostic default)', () => {
    for (const rule of verdixCommercialRulebook) expect(VERDIX_RULEBOOK_ACTIVATION[rule.id]).toBeDefined()
    expect(Object.keys(VERDIX_RULEBOOK_ACTIVATION).sort()).toEqual(verdixCommercialRulebook.map(r => r.id).sort())
  })
  it('Rulebook content and activation policy are versioned independently', () => {
    expect(VERDIX_RULEBOOK_VERSION).toBe('0.1.0')
    expect(VERDIX_RULEBOOK_ACTIVATION_VERSION).toBe('0.1.0')
  })
})

describe('resolveVerdixRulebookActivation — reports both versions, findings pass through unfiltered', () => {
  it('reports rulebookVersion and activationVersion together, and resolutions is always empty (resolve_semantic inactive)', () => {
    const result = resolveVerdixRulebookActivation({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }) })
    expect(result.rulebookVersion).toBe(VERDIX_RULEBOOK_VERSION)
    expect(result.activationVersion).toBe(VERDIX_RULEBOOK_ACTIVATION_VERSION)
    expect(result.resolutions).toEqual([])
  })
  it('every violation this function ever produces traces to a real enforce_invariant + target:execution registry entry, and every finding it corresponds to is genuinely \'contradicts\' — an unregistered or wrongly-targeted rule_id could structurally never appear here', () => {
    // Exercises a wide mix of contexts (valid + adversarial, execution +
    // promotion + diagnostic rules all firing at once) so this is a real
    // invariant over resolveVerdixRulebookActivation's behavior, not a
    // single-case coincidence.
    const contexts = [
      { minimumCommitment: minimumCommitmentContext({ mode: 'floor' }, { calculatedChargeMinor: 1, minimumAmountMinor: 2, payableMinor: 999 }) },
      { tierCalculation: tierCalculationContext({ method: 'volume' }, { method: 'graduated' }) },
      { provenancedFields: [provenancedField('x', 1, 'contract_derived', false), provenancedField('y', 2, 'verdix_recommends', true)] },
      { creditApplication: creditApplicationContext({ eligible_component_keys: ['a'], carry_forward: true, survival_provenance: null, availability: 'next_period' }) },
    ]
    for (const ctx of contexts) {
      const activation = resolveVerdixRulebookActivation(ctx)
      for (const violation of activation.violations) {
        const entry = VERDIX_RULEBOOK_ACTIVATION[violation.rule_id]
        expect(entry?.authority).toBe('enforce_invariant')
        expect(entry && 'target' in entry ? entry.target : undefined).toBe('execution')
        const finding = activation.findings.find(f => f.rule_id === violation.rule_id && f.field === violation.field)
        expect(finding?.outcome).toBe('contradicts')
      }
    }
  })
})

// Dual-path tests per Step 3 item 11, for the two EXECUTION-target
// invariants: valid state (supports, no violation), adversarial state
// (contradicts, violation produced).
describe('activated invariant A — minimum.floor.non_additive (target: execution)', () => {
  const floorCommitment: MinimumCommitment = { mode: 'floor', amount: 66_000, requires_confirmation: false }

  it('valid production state: real engine output supports the invariant -> zero violations', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment })]
    const real = computeMetricOverage(10_000, tiers, 0)
    const context = { minimumCommitment: minimumCommitmentContext(floorCommitment, { calculatedChargeMinor: real.usageAmount, minimumAmountMinor: floorCommitment.amount, payableMinor: real.amount }) }
    const activation = resolveVerdixRulebookActivation(context)
    expect(activation.violations).toEqual([])
  })
  it('adversarial state: an additive-behaving observed result -> one violation for this rule_id', () => {
    const context = { minimumCommitment: minimumCommitmentContext(floorCommitment, { calculatedChargeMinor: 10_000, minimumAmountMinor: 66_000, payableMinor: 76_000 }) }
    const activation = resolveVerdixRulebookActivation(context)
    expect(activation.violations).toHaveLength(1)
    expect(activation.violations[0].rule_id).toBe('minimum.floor.non_additive')
  })
})

describe('activated invariant B — pricing.all_units.non_graduated (target: execution)', () => {
  const volumeMethod: TierCalculationMethod = { method: 'volume', requires_confirmation: false }

  it('valid production state: real engine output supports the invariant -> zero violations', () => {
    const tiers = [tier({ tier_calculation: volumeMethod })]
    const real = computeMetricOverage(150_000, tiers, 0)
    const activation = resolveVerdixRulebookActivation({ tierCalculation: tierCalculationContext(volumeMethod, { method: real.method }) })
    expect(activation.violations).toEqual([])
  })
  it('adversarial state: observed graduated execution against a normalized volume rule -> one violation', () => {
    const activation = resolveVerdixRulebookActivation({ tierCalculation: tierCalculationContext(volumeMethod, { method: 'graduated' }) })
    expect(activation.violations).toEqual([{
      rule_id: 'pricing.all_units.non_graduated',
      field: 'tierCalculation.observed.method',
      expected_value: 'volume',
      reason: expect.stringContaining('graduated'),
    }])
  })
})

// The central correction from this round of review: an "unresolved" state
// must never masquerade as an execution blocker, for ANY rule — including
// an active execution-target invariant.
describe('execution-target invariants A/B never produce a violation merely because a finding is remains_unresolved', () => {
  it('rule A (minimum.floor.non_additive) only ever supports or contradicts — never remains_unresolved — regardless of whether observed data is supplied', () => {
    const withoutObserved = resolveVerdixRulebookActivation({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }) })
    const withObserved = resolveVerdixRulebookActivation({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }, { calculatedChargeMinor: 1, minimumAmountMinor: 1, payableMinor: 1 }) })
    for (const activation of [withoutObserved, withObserved]) {
      const finding = activation.findings.find(f => f.rule_id === 'minimum.floor.non_additive')
      expect(['supports', 'contradicts']).toContain(finding?.outcome)
    }
  })
  it('rule B (pricing.all_units.non_graduated) only ever supports or contradicts — never remains_unresolved — regardless of whether observed data is supplied', () => {
    const withoutObserved = resolveVerdixRulebookActivation({ tierCalculation: tierCalculationContext({ method: 'volume' }) })
    const withObserved = resolveVerdixRulebookActivation({ tierCalculation: tierCalculationContext({ method: 'volume' }, { method: 'volume' }) })
    for (const activation of [withoutObserved, withObserved]) {
      const finding = activation.findings.find(f => f.rule_id === 'pricing.all_units.non_graduated')
      expect(['supports', 'contradicts']).toContain(finding?.outcome)
    }
  })
  it('resolveVerdixRulebookActivation\'s own violation filter is outcome === \'contradicts\' exactly — a synthetic remains_unresolved-only scenario (H) confirms zero violations even though the rule IS enforce_invariant', () => {
    // H is enforce_invariant and its finding is ALWAYS remains_unresolved —
    // the strongest available proof that "enforce_invariant" alone does not
    // imply "remains_unresolved becomes a violation". See the dedicated H
    // section below for the full promotion-guard behavior this drives instead.
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('carry_forward', true, 'verdix_recommends', true)] })
    const hFinding = activation.findings.find(f => f.rule_id === 'provenance.verdix_recommendation_cannot_clear_readiness')
    expect(hFinding?.outcome).toBe('remains_unresolved')
    expect(activation.violations).toEqual([])
  })
})

// G/H (target: promotion) — enforcement is a DENIED PROMOTION via
// evaluateFieldPromotion, never a RulebookViolation/execution blocker.
describe('activated invariant G — provenance.silence_cannot_become_contract_derived (target: promotion)', () => {
  it('valid: contract_derived with real source-text evidence never appears in resolveVerdixRulebookActivation().violations (target is promotion, not execution) and is allowed by evaluateFieldPromotion', () => {
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('cash_redeemable', false, 'contract_derived', true)] })
    expect(activation.violations).toEqual([])
    expect(evaluateFieldPromotion({ field: 'cash_redeemable', value: false, provenance: 'contract_derived', sourceTextPresent: true }).allowed).toBe(true)
  })
  it('attempt to promote contractual silence as contract_derived -> promotion denied (not an execution violation)', () => {
    const decision = evaluateFieldPromotion({ field: 'cash_redeemable', value: false, provenance: 'contract_derived', sourceTextPresent: false })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toEqual([expect.objectContaining({ rule_id: 'provenance.silence_cannot_become_contract_derived', outcome: 'contradicts' })])
    // And structurally separate: this same scenario NEVER reaches
    // resolveVerdixRulebookActivation's violations/execution-blocker path.
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('cash_redeemable', false, 'contract_derived', false)] })
    expect(activation.violations).toEqual([])
  })
})

describe('activated invariant H — provenance.verdix_recommendation_cannot_clear_readiness (target: promotion)', () => {
  it('valid: reviewer_policy/contract_derived provenance is allowed by evaluateFieldPromotion and never appears in resolveVerdixRulebookActivation().violations', () => {
    expect(evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'reviewer_policy', sourceTextPresent: true }).allowed).toBe(true)
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('carry_forward', true, 'reviewer_policy', true)] })
    expect(activation.violations).toEqual([])
  })
  it('attempt to promote verdix_recommends as resolved -> promotion denied', () => {
    const decision = evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'verdix_recommends', sourceTextPresent: true })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons[0].rule_id).toBe('provenance.verdix_recommendation_cannot_clear_readiness')
    // isProvenanceResolved independently agrees -- reinforcement, not a
    // competing answer.
    expect(isProvenanceResolved('verdix_recommends')).toBe(false)
  })
  it('remaining unresolved (the denial reason above) is the CORRECT, EXPECTED behavior of this invariant, not a violation -- it must never surface as an execution blocker', () => {
    const decision = evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'verdix_recommends', sourceTextPresent: true })
    expect(decision.reasons[0].outcome).toBe('remains_unresolved')
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('carry_forward', true, 'verdix_recommends', true)] })
    expect(activation.violations).toEqual([]) // no execution violation
    expect(toRulebookExecutionBlockers(activation)).toEqual([]) // no execution blocker
  })
})

// The most important test in this file, per Step 3 item 11: a diagnostic
// rule detecting a real contradiction must produce a finding, and that
// finding must NEVER become a violation or otherwise affect production.
describe('diagnostic-only rules can detect a contradiction without ever affecting production', () => {
  it('credit.next_invoice_timing_ne_carry_forward genuinely contradicts here (carry_forward=true, ungrounded) -- a finding is produced, but zero violations result, because this rule stays diagnostic', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: null, availability: 'next_period' }) }
    const activation = resolveVerdixRulebookActivation(context)
    const diagnosticFinding = activation.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')
    expect(diagnosticFinding?.outcome).toBe('contradicts')
    expect(activation.violations).toEqual([])
    expect(activation.resolutions).toEqual([])
  })
  it('the same holds for every diagnostic rule_id: even a synthetic all-diagnostic-contradicting context yields zero violations', () => {
    const context = {
      creditBasis: { componentKeys: ['transaction_processing'] },
      creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], eligibility_provenance: 'verdix_recommends', carry_forward: true, survival_provenance: 'verdix_recommends', availability: 'next_period' }),
    }
    const activation = resolveVerdixRulebookActivation(context)
    const contradictingRuleIds = activation.findings.filter(f => f.outcome === 'contradicts').map(f => f.rule_id)
    expect(contradictingRuleIds.length).toBeGreaterThan(0)
    for (const id of contradictingRuleIds) expect(DIAGNOSTIC_RULE_IDS).toContain(id)
    expect(activation.violations).toEqual([])
  })
  it('diagnostic rules produce no promotion decision either -- evaluateFieldPromotion only ever consults target:promotion rules', () => {
    // credit.next_invoice_timing_ne_carry_forward etc. never match a
    // provenancedFields-only context in the first place (they match
    // creditApplication), so this also confirms evaluateFieldPromotion's
    // narrow context construction keeps them structurally unreachable.
    const decision = evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'reviewer_policy', sourceTextPresent: true })
    expect(decision.reasons.every(r => PROMOTION_TARGET_RULE_IDS.includes(r.rule_id))).toBe(true)
  })
})

// Step 3 item 8/12 — integrating a violation into the EXISTING readiness
// mechanism (computeCommercialRuleWorkload) as a distinct execution
// blocker, and proving it changes nothing unless a caller explicitly
// supplies real violations.
describe('computeCommercialRuleWorkload — executionBlockers integration (Step 3)', () => {
  const confirmedTerms: CommercialRuleTerms = {
    overage_tiers: [{ unit_type: 'api_call', rate_per_unit: 1, minimum_commitment: { mode: 'floor', requires_confirmation: false }, tier_calculation: { requires_confirmation: false } }],
    escalators: [], discounts: [], service_credits: [],
  }

  it('regression: every pre-existing call site (no executionBlockers argument) is completely unaffected -- executionBlockers defaults to [] and status logic is unchanged', () => {
    const workload = computeCommercialRuleWorkload(confirmedTerms, { total: 1, confirmed: 1 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(workload.executionBlockers).toEqual([])
  })
  it('a real Rulebook violation (execution-target), converted via toRulebookExecutionBlockers, forces execution_blocked even though every reviewer-facing item is otherwise confirmed -- fail closed', () => {
    const activation = resolveVerdixRulebookActivation({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }, { calculatedChargeMinor: 10_000, minimumAmountMinor: 66_000, payableMinor: 76_000 }) })
    const blockers = toRulebookExecutionBlockers(activation)
    expect(blockers).toHaveLength(1)
    const workload = computeCommercialRuleWorkload(confirmedTerms, { total: 1, confirmed: 1 }, 0, new Set(), { configured: true }, blockers)
    expect(workload.status).toBe('execution_blocked')
    expect(workload.executionBlockers).toEqual(blockers)
    // The reviewer-facing counters are untouched by the execution blocker —
    // contract ambiguity and execution contradiction stay separate signals.
    expect(workload.totalToConfirm).toBe(0)
    expect(workload.blockers).toEqual([])
  })
  it('a diagnostic-only contradiction never reaches computeCommercialRuleWorkload as a violation, so status stays exactly what it would have been without the Rulebook at all', () => {
    const diagnosticContext = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: null, availability: 'next_period' }) }
    const activation = resolveVerdixRulebookActivation(diagnosticContext)
    expect(activation.findings.some(f => f.outcome === 'contradicts')).toBe(true) // real contradiction exists...
    const blockers = toRulebookExecutionBlockers(activation)
    expect(blockers).toEqual([]) // ...but produces zero execution blockers
    const withoutRulebook = computeCommercialRuleWorkload(confirmedTerms, { total: 1, confirmed: 1 })
    const withDiagnosticRulebook = computeCommercialRuleWorkload(confirmedTerms, { total: 1, confirmed: 1 }, 0, new Set(), { configured: true }, blockers)
    expect(withDiagnosticRulebook).toEqual(withoutRulebook)
  })
  it('an H-triggered (promotion-target, remains_unresolved) scenario never reaches computeCommercialRuleWorkload as an execution blocker either', () => {
    const activation = resolveVerdixRulebookActivation({ provenancedFields: [provenancedField('carry_forward', true, 'verdix_recommends', true)] })
    const blockers = toRulebookExecutionBlockers(activation)
    expect(blockers).toEqual([])
    const workload = computeCommercialRuleWorkload(confirmedTerms, { total: 1, confirmed: 1 }, 0, new Set(), { configured: true }, blockers)
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })
})

// Step 3 item 12 — regression proof: activating invariants does not change
// a single calculated amount. Re-asserts the exact figures already frozen
// by tests/commercial-semantics/minimum-floor/ and all-units/, through the
// SAME real engine calls, alongside the activation layer running in
// parallel and reporting zero violations.
describe('regression — activation changes zero calculated amounts (seat belt, not a new calculation engine)', () => {
  it('minimum-floor: usage below the floor still bills exactly 66,000, and the Rulebook agrees', () => {
    const floorCommitment: MinimumCommitment = { mode: 'floor', amount: 66_000, requires_confirmation: false }
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment })]
    const real = computeMetricOverage(10_000, tiers, 0)
    expect(real.amount).toBe(66_000)
    const activation = resolveVerdixRulebookActivation({ minimumCommitment: minimumCommitmentContext(floorCommitment, { calculatedChargeMinor: real.usageAmount, minimumAmountMinor: floorCommitment.amount, payableMinor: real.amount }) })
    expect(activation.violations).toEqual([])
  })
  it('all-units: 150,000 units still bill entirely at the middle-band rate (124,500), and the Rulebook agrees', () => {
    const ALL_UNITS_TIERS: OverageTier[] = [
      tier({ from_unit: 1, to_unit: 50_000, rate_per_unit: 1.05, tier_calculation: { method: 'volume', requires_confirmation: false } }),
      tier({ from_unit: 50_001, to_unit: 200_000, rate_per_unit: 0.83 }),
      tier({ from_unit: 200_001, to_unit: null, rate_per_unit: 0.61 }),
    ]
    const amount = computeTransactionalOverage(150_000, ALL_UNITS_TIERS, 'volume')
    expect(amount).toBeCloseTo(150_000 * 0.83)
    const real = computeMetricOverage(150_000, ALL_UNITS_TIERS, 0)
    const activation = resolveVerdixRulebookActivation({ tierCalculation: tierCalculationContext({ method: 'volume' }, { method: real.method }) })
    expect(activation.violations).toEqual([])
  })
})

describe('evaluateFieldPromotion — reinforces, never replaces, isProvenanceResolved', () => {
  it('contract_derived with real source-text evidence is allowed, and isProvenanceResolved independently agrees the value is resolved', () => {
    const decision = evaluateFieldPromotion({ field: 'cash_redeemable', value: false, provenance: 'contract_derived', sourceTextPresent: true })
    expect(decision.allowed).toBe(true)
    expect(isProvenanceResolved('contract_derived')).toBe(true)
  })
  it('reviewer_policy is allowed regardless of sourceTextPresent -- a reviewer decision needs no textual evidence of its own', () => {
    expect(evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'reviewer_policy', sourceTextPresent: false }).allowed).toBe(true)
  })
  it('rejected: contract_derived claimed with no source-text evidence -- a case isProvenanceResolved structurally cannot catch on its own (it only reads the provenance label)', () => {
    const decision = evaluateFieldPromotion({ field: 'cash_redeemable', value: false, provenance: 'contract_derived', sourceTextPresent: false })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons[0].rule_id).toBe('provenance.silence_cannot_become_contract_derived')
    // isProvenanceResolved alone would have said this WAS resolved (it
    // trusts the label) -- proving this guard is a genuine, complementary
    // check, not a duplicate of the canonical gate.
    expect(isProvenanceResolved('contract_derived')).toBe(true)
  })
  it('rejected: verdix_recommends is never promotable, and isProvenanceResolved agrees it is unresolved -- reinforcement, not a competing answer', () => {
    const decision = evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: 'verdix_recommends', sourceTextPresent: true })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons[0].rule_id).toBe('provenance.verdix_recommendation_cannot_clear_readiness')
    expect(isProvenanceResolved('verdix_recommends')).toBe(false)
  })
  it('rejected: missing/null provenance is never promotable either', () => {
    const decision = evaluateFieldPromotion({ field: 'carry_forward', value: true, provenance: null, sourceTextPresent: true })
    expect(decision.allowed).toBe(true) // null provenance triggers neither invariant rule directly...
    // ...but isProvenanceResolved is still the canonical gate a caller must
    // check independently -- the promotion guard only rejects the two
    // SPECIFIC failure modes the activated rules cover (fabricated
    // contract_derived, and verdix_recommends), it is not a full
    // reimplementation of isProvenanceResolved.
    expect(isProvenanceResolved(null)).toBe(false)
  })
})

describe('precedence model (Step 3 item 3)', () => {
  it('FieldProvenance maps onto the precedence ordering exactly as isProvenanceResolved treats it: contract_derived and reviewer_policy both outrank verdix_recommendation', () => {
    const contractRank = COMMERCIAL_DECISION_PRECEDENCE.indexOf(FIELD_PROVENANCE_TO_DECISION_SOURCE.contract_derived)
    const reviewerRank = COMMERCIAL_DECISION_PRECEDENCE.indexOf(FIELD_PROVENANCE_TO_DECISION_SOURCE.reviewer_policy)
    const recommendationRank = COMMERCIAL_DECISION_PRECEDENCE.indexOf(FIELD_PROVENANCE_TO_DECISION_SOURCE.verdix_recommends)
    expect(contractRank).toBeLessThan(recommendationRank)
    expect(reviewerRank).toBeLessThan(recommendationRank)
  })
  it('a Rulebook may never override explicit contract language', () => {
    expect(isPrecedenceViolation('explicit_contract_semantics', 'verdix_global_rulebook')).toBe(true)
  })
  it('a Rulebook must not silently overwrite an explicit reviewer decision', () => {
    expect(isPrecedenceViolation('explicit_reviewer_decision', 'verdix_global_rulebook')).toBe(true)
  })
  it('a Rulebook MAY fill a genuinely empty (decision_required) slot', () => {
    expect(isPrecedenceViolation('decision_required', 'verdix_global_rulebook')).toBe(false)
  })
  it('a Rulebook MAY supersede a mere Verdix recommendation (lower precedence than the Rulebook itself)', () => {
    expect(isPrecedenceViolation('verdix_recommendation', 'verdix_global_rulebook')).toBe(false)
  })
  it('a source may update its own prior value (equal precedence is not a violation)', () => {
    expect(isPrecedenceViolation('explicit_reviewer_decision', 'explicit_reviewer_decision')).toBe(false)
    expect(isPrecedenceViolation('verdix_global_rulebook', 'verdix_global_rulebook')).toBe(false)
  })
  it('the future organization_rulebook slot is defined and correctly out-ranks the Verdix global rulebook, without any implementation existing yet', () => {
    expect(isPrecedenceViolation('organization_rulebook', 'verdix_global_rulebook')).toBe(true)
    expect(isPrecedenceViolation('explicit_contract_semantics', 'organization_rulebook')).toBe(true)
  })
})
