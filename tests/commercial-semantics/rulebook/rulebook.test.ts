// Verdix Global Rulebook — shadow mode (Step 2). Asks, of the SAME
// normalized inputs and real engine calls the Step 1 regression corpus
// already exercises (minimum-floor/, all-units/, credits/, provenance/):
// "given this normalized representation, what would the Rulebook
// conclude?" Never duplicates those corpus fixtures wholesale — builds the
// same minimal representative shapes those files use, and where a real
// engine call is useful (lib/tariff.ts's computeMetricOverage), calls it
// directly so an "observed execution" finding reflects the real,
// already-shipped engine, not a hand-simulated stand-in.
//
// resolveVerdixRulebookShadow makes no mutations and has no side effects —
// it is exercised here purely as a read-only shadow layer; nothing in
// lib/, app/api/, or app/(dashboard)/ calls it.
import { describe, it, expect } from 'vitest'
import { resolveVerdixRulebookShadow } from '@/lib/rulebook/resolver'
import { minimumCommitmentContext, tierCalculationContext, creditApplicationContext, creditBasisContext, provenancedField } from '@/lib/rulebook/context'
import { VERDIX_RULEBOOK_VERSION, verdixCommercialRulebook } from '@/lib/rulebook/rules'
import { computeMetricOverage } from '@/lib/tariff'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import type { OverageTier, MinimumCommitment, TierCalculationMethod } from '@/lib/types'

function tier(overrides: Partial<OverageTier> = {}): OverageTier {
  return { tier_label: 'Tier', from_unit: 1, to_unit: null, rate_per_unit: 1, unit_type: 'transaction', ...overrides }
}

describe('the Rulebook registry itself', () => {
  it('has between 6 and 8 rules, matching Step 2\'s "start with only validated rules" scope', () => {
    expect(verdixCommercialRulebook.length).toBeGreaterThanOrEqual(6)
    expect(verdixCommercialRulebook.length).toBeLessThanOrEqual(8)
  })
  // Step 6 — category ('invariant' | 'semantic') was replaced by the
  // finer-grained ruleClass taxonomy; see tests/commercial-semantics/
  // rulebook/rule-class.test.ts for the full per-rule classification
  // coverage this test deliberately doesn't duplicate.
  it('every rule has a stable id, a version, and a ruleClass', () => {
    for (const rule of verdixCommercialRulebook) {
      expect(rule.id).toMatch(/^[a-z0-9_.]+$/)
      expect(rule.version).toBeGreaterThanOrEqual(1)
      expect(['invariant', 'semantic_interpretation', 'default_policy', 'anti_inference']).toContain(rule.ruleClass)
    }
  })
  it('rule ids are unique', () => {
    const ids = verdixCommercialRulebook.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('resolveVerdixRulebookShadow — pure, no mutation, reports its own version', () => {
  it('reports the current Rulebook version alongside matched rule ids and findings', () => {
    const result = resolveVerdixRulebookShadow({ minimumCommitment: minimumCommitmentContext({ mode: 'floor' }) })
    expect(result.rulebookVersion).toBe(VERDIX_RULEBOOK_VERSION)
    expect(result.matchedRuleIds).toContain('minimum.floor.non_additive')
    expect(result.findings.length).toBeGreaterThan(0)
  })
  it('never mutates the context object it is given — a frozen (deep) context does not throw', () => {
    const context = Object.freeze({
      minimumCommitment: Object.freeze(minimumCommitmentContext({ mode: 'floor' })),
      creditApplication: Object.freeze(creditApplicationContext({
        eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period',
      })),
    })
    expect(() => resolveVerdixRulebookShadow(context)).not.toThrow()
  })
  it('is deterministic — calling twice with the same input (which matches multiple rules: D, E, and F) produces the identical version, matched-rule set, and finding order every time', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period' }) }
    const first = resolveVerdixRulebookShadow(context)
    const second = resolveVerdixRulebookShadow(context)
    // Whole-result deep equality (version + matched rules + findings, in order).
    expect(second).toEqual(first)
    // Same checks spelled out individually, so a future change to any ONE
    // of these three guarantees fails its own assertion rather than a single
    // opaque toEqual — the exact three properties the Step 2 spec calls out.
    expect(second.rulebookVersion).toBe(first.rulebookVersion)
    expect(second.matchedRuleIds).toEqual(first.matchedRuleIds)
    expect(second.findings.map(f => f.rule_id)).toEqual(first.findings.map(f => f.rule_id))
    // Sanity: this context genuinely exercises multiple matched rules and
    // multiple findings, so the ordering check above is not vacuous.
    expect(first.matchedRuleIds.length).toBeGreaterThanOrEqual(3)
    expect(first.findings.length).toBeGreaterThanOrEqual(3)
    // No unstable data anywhere in the result — no timestamps, random ids,
    // model output, or raw contract text; every finding's keys are exactly
    // the fixed RulebookFinding shape (plus the top-level version/matched-
    // rules/findings triad), nothing else.
    expect(Object.keys(first).sort()).toEqual(['findings', 'matchedRuleIds', 'rulebookVersion'])
    const knownFindingKeys = new Set(['rule_id', 'field', 'outcome', 'expected_value', 'reason'])
    for (const finding of first.findings) {
      for (const key of Object.keys(finding)) expect(knownFindingKeys.has(key)).toBe(true)
    }
  })
  it('an empty context matches no rules and produces no findings', () => {
    const result = resolveVerdixRulebookShadow({})
    expect(result.matchedRuleIds).toEqual([])
    expect(result.findings).toEqual([])
  })
})

// A — mirrors tests/commercial-semantics/minimum-floor/minimum-floor.test.ts.
describe('Rule A — minimum floor is non-additive', () => {
  const floorCommitment: MinimumCommitment = { mode: 'floor', amount: 66_000, requires_confirmation: false }

  it('floor mode alone (no observed calculation) supports the invariant with the expected formula', () => {
    const result = resolveVerdixRulebookShadow({ minimumCommitment: minimumCommitmentContext(floorCommitment) })
    expect(result.matchedRuleIds).toEqual(['minimum.floor.non_additive'])
    expect(result.findings[0].outcome).toBe('supports')
    expect(result.findings[0].expected_value).toBe('max(calculated_charge, minimum)')
  })
  it('a real computeMetricOverage call under the floor (usage below floor) — the real engine\'s output supports the invariant', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment })]
    const real = computeMetricOverage(10_000, tiers, 0) // 10,000 * 1 = 10,000, under the 66,000 floor
    const context = { minimumCommitment: minimumCommitmentContext(floorCommitment, {
      calculatedChargeMinor: real.usageAmount, minimumAmountMinor: floorCommitment.amount, payableMinor: real.amount,
    }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings[0].outcome).toBe('supports')
    expect(result.findings[0].expected_value).toBe(66_000)
  })
  it('a real computeMetricOverage call above the floor — usage alone clears it, still supports (payable = usage, which is also max(usage, floor))', () => {
    const tiers = [tier({ rate_per_unit: 1, minimum_commitment: floorCommitment })]
    const real = computeMetricOverage(100_000, tiers, 0)
    const context = { minimumCommitment: minimumCommitmentContext(floorCommitment, {
      calculatedChargeMinor: real.usageAmount, minimumAmountMinor: floorCommitment.amount, payableMinor: real.amount,
    }) }
    expect(resolveVerdixRulebookShadow(context).findings[0]).toMatchObject({ outcome: 'supports', expected_value: 100_000 })
  })
  it('counterexample — a synthetic observed result behaving additively (usage + minimum, not max) is flagged as a contradiction', () => {
    // Deliberately hand-constructed to behave like the additive counterexample
    // in minimum-floor.test.ts — this is not a real production bug, it proves
    // the Rulebook would catch this exact class of regression if the real
    // engine ever drifted into it.
    const context = { minimumCommitment: minimumCommitmentContext(floorCommitment, {
      calculatedChargeMinor: 10_000, minimumAmountMinor: 66_000, payableMinor: 76_000, // 10,000 + 66,000, additive
    }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings[0].outcome).toBe('contradicts')
    expect(result.findings[0].expected_value).toBe(66_000)
  })
  it('mode "additive" does not match this rule at all — additive is a genuinely different, valid mode, not a violation of the floor invariant', () => {
    const result = resolveVerdixRulebookShadow({ minimumCommitment: minimumCommitmentContext({ mode: 'additive' }) })
    expect(result.matchedRuleIds).not.toContain('minimum.floor.non_additive')
  })
})

// B — mirrors tests/commercial-semantics/all-units/all-units.test.ts, and is
// the Step 2 spec's own worked contradiction example (item 8).
describe('Rule B — all-units pricing is not graduated', () => {
  const volumeMethod: TierCalculationMethod = { method: 'volume', requires_confirmation: false }
  const ALL_UNITS_TIERS: OverageTier[] = [
    tier({ from_unit: 1, to_unit: 50_000, rate_per_unit: 1.05, tier_calculation: volumeMethod }),
    tier({ from_unit: 50_001, to_unit: 200_000, rate_per_unit: 0.83 }),
    tier({ from_unit: 200_001, to_unit: null, rate_per_unit: 0.61 }),
  ]

  it('the all-units fixture: Rulebook recognizes the invariant, no contradiction', () => {
    const real = computeMetricOverage(150_000, ALL_UNITS_TIERS, 0)
    const context = { tierCalculation: tierCalculationContext(volumeMethod, { method: real.method }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.matchedRuleIds).toEqual(['pricing.all_units.non_graduated'])
    expect(result.findings[0].outcome).toBe('supports')
  })
  it('exactly the Step 2 spec\'s own example — calculation_method = all_units but execution model behaves graduated produces a contradiction', () => {
    const context = { tierCalculation: tierCalculationContext(volumeMethod, { method: 'graduated' }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings).toEqual([{
      rule_id: 'pricing.all_units.non_graduated',
      field: 'tierCalculation.observed.method',
      outcome: 'contradicts',
      expected_value: 'volume',
      reason: expect.stringContaining('graduated'),
    }])
  })
  it('a genuinely graduated normalized rule does not match this rule at all', () => {
    const result = resolveVerdixRulebookShadow({ tierCalculation: tierCalculationContext({ method: 'graduated' }) })
    expect(result.matchedRuleIds).not.toContain('pricing.all_units.non_graduated')
  })
})

// C — mirrors credits.test.ts's "calculation basis vs. application scope
// are independent questions" block.
describe('Rule C — calculation basis does not establish application scope', () => {
  it('basis known, scope null (genuinely unresolved, e.g. the Annual Rebate) — remains_unresolved, not treated as a problem', () => {
    const appRule = buildCreditApplicationRule({ application_rule: { eligible_component_keys: null, one_time: false, carry_forward: 'unclear' } }, null)
    const context = {
      creditBasis: creditBasisContext(['transaction_processing']),
      creditApplication: creditApplicationContext(appRule),
    }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings.find(f => f.rule_id === 'credit.basis_ne_application_scope')?.outcome).toBe('remains_unresolved')
  })
  it('scope independently confirmed via reviewer_policy, even though it happens to equal the basis — supports (grounded, not merely inferred)', () => {
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true } },
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
    )
    const context = { creditBasis: creditBasisContext(['transaction_processing']), creditApplication: creditApplicationContext(appRule) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.basis_ne_application_scope')
    expect(finding?.outcome).toBe('supports')
  })
  it('counterexample — scope identical to basis with only verdix_recommends grading (never independently confirmed) is a contradiction: looks copied from the basis alone', () => {
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true } },
      null,
      { eligibility: 'verdix_recommends', survival: 'verdix_recommends' },
    )
    const context = { creditBasis: creditBasisContext(['transaction_processing']), creditApplication: creditApplicationContext(appRule) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.basis_ne_application_scope')
    expect(finding?.outcome).toBe('contradicts')
  })
})

// D — the Step 2 spec's own worked examples: "next-invoice + survival
// unclear -> timing recognized, survival remains unresolved" and
// "next-invoice + carry_forward=true without supporting evidence ->
// Rulebook emits contradiction."
describe('Rule D — next-invoice timing does not establish carry-forward', () => {
  it('next-invoice + survival unclear: timing recognized, survival remains unresolved', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: 'unclear', availability: 'next_period' }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.matchedRuleIds).toContain('credit.next_invoice_timing_ne_carry_forward')
    expect(result.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')?.outcome).toBe('remains_unresolved')
  })
  it('next-invoice + carry_forward=true without supporting evidence -> Rulebook emits contradiction', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: null, availability: 'next_period' }) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')
    expect(finding?.outcome).toBe('contradicts')
  })
  it('next-invoice + carry_forward=true WITH contract_derived evidence -> supports (Growth Credit\'s real shape)', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period' }) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')
    expect(finding?.outcome).toBe('supports')
  })
})

// E — mirrors credits.test.ts's "future amounts payable never establishes
// indefinite survival" cases (Service Credit / Rebate shape).
describe('Rule E — future-payable scope does not establish indefinite survival', () => {
  it('eligible_component_keys="all" + carry_forward unclear (the Service Credit/Rebate shape) — remains_unresolved', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: 'unclear', availability: 'next_period' }) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.future_payable_scope_ne_indefinite_survival')
    expect(finding?.outcome).toBe('remains_unresolved')
  })
  it('counterexample — eligible_component_keys="all" + carry_forward=true with no independent grounding is a contradiction (future-payable scope alone must never imply indefinite survival)', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: 'all', carry_forward: true, survival_provenance: 'verdix_recommends', availability: 'next_period' }) }
    const finding = resolveVerdixRulebookShadow(context).findings.find(f => f.rule_id === 'credit.future_payable_scope_ne_indefinite_survival')
    expect(finding?.outcome).toBe('contradicts')
  })
})

// F — mirrors credits.test.ts's explicit-carry-forward case (Growth Credit).
describe('Rule F — explicit carry-forward is authoritative', () => {
  it('carry_forward=true + contract_derived provenance — Rulebook agrees, supports', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: 'contract_derived', availability: 'next_period' }) }
    expect(resolveVerdixRulebookShadow(context).matchedRuleIds).toContain('credit.explicit_carry_forward_authoritative')
  })
  // Three counterexamples, one per non-authoritative provenance state — this
  // rule's matches() requires survivalProvenance === 'contract_derived'
  // exactly, so none of these can ever be mistaken for the contract itself
  // having established carry-forward. reviewer_policy is real, valid
  // EXECUTABLE policy (see lib/commercial-rule-status.ts's
  // isProvenanceResolved, which treats it as equally resolved to
  // contract_derived for readiness purposes) — but "a reviewer chose this"
  // and "the contract explicitly says this" are different claims, and this
  // rule is specifically about the latter. All three still fall through
  // correctly to Rule D (credit.next_invoice_timing_ne_carry_forward),
  // which — for reviewer_policy — reports the value as independently
  // grounded and 'supports' (a resolved, executable policy), and — for
  // verdix_recommends/missing — reports 'contradicts' (an ungrounded value
  // riding on next-invoice timing alone). Rule F only ever narrows what
  // counts as CONTRACT-authoritative; it never widens what counts as
  // resolved/executable — that remains Rule D's and isProvenanceResolved's
  // job, untouched here.
  it('counterexample — carry_forward=true + reviewer_policy (valid executable policy, but not the contract itself) does not match this rule', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: 'reviewer_policy', availability: 'next_period' }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.matchedRuleIds).not.toContain('credit.explicit_carry_forward_authoritative')
    expect(result.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')?.outcome).toBe('supports')
  })
  it('counterexample — carry_forward=true + verdix_recommends (a recommendation, not the contract) does not match this rule, and Rule D correctly reports it as ungrounded', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: 'verdix_recommends', availability: 'next_period' }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.matchedRuleIds).not.toContain('credit.explicit_carry_forward_authoritative')
    expect(result.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')?.outcome).toBe('contradicts')
  })
  it('counterexample — carry_forward=true + missing/null provenance (never graded at all) does not match this rule, and Rule D correctly reports it as ungrounded', () => {
    const context = { creditApplication: creditApplicationContext({ eligible_component_keys: ['transaction_processing'], carry_forward: true, survival_provenance: null, availability: 'next_period' }) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.matchedRuleIds).not.toContain('credit.explicit_carry_forward_authoritative')
    expect(result.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')?.outcome).toBe('contradicts')
  })
})

// G/H — mirrors tests/commercial-semantics/provenance/provenance.test.ts's
// canonical 4-state matrix, generalized to any provenanced field.
describe('Rule G — contract silence cannot become contract_derived', () => {
  it('contract_derived with real source-text evidence — supports', () => {
    const context = { provenancedFields: [provenancedField('cash_redeemable', false, 'contract_derived', true)] }
    expect(resolveVerdixRulebookShadow(context).findings[0].outcome).toBe('supports')
  })
  it('counterexample — contract_derived with NO source-text evidence is exactly the failure mode this rule exists to catch: contradicts', () => {
    const context = { provenancedFields: [provenancedField('cash_redeemable', false, 'contract_derived', false)] }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings[0].outcome).toBe('contradicts')
    expect(result.findings[0].reason).toContain('silence')
  })
})

describe('Rule H — a Verdix recommendation cannot clear readiness', () => {
  it('verdix_recommends never resolves, regardless of whether source text happens to be present', () => {
    const context = {
      provenancedFields: [
        provenancedField('carry_forward', true, 'verdix_recommends', true),
        provenancedField('cash_redeemable', false, 'verdix_recommends', false),
      ],
    }
    const result = resolveVerdixRulebookShadow(context)
    const findings = result.findings.filter(f => f.rule_id === 'provenance.verdix_recommendation_cannot_clear_readiness')
    expect(findings).toHaveLength(2)
    expect(findings.every(f => f.outcome === 'remains_unresolved')).toBe(true)
  })
  it('reviewer_policy and contract_derived never trigger this rule at all', () => {
    const context = {
      provenancedFields: [
        provenancedField('a', 1, 'reviewer_policy', true),
        provenancedField('b', 2, 'contract_derived', true),
      ],
    }
    expect(resolveVerdixRulebookShadow(context).matchedRuleIds).not.toContain('provenance.verdix_recommendation_cannot_clear_readiness')
  })
})

// Confirms the whole registry produces zero contradictions against the
// REAL, correct TEST-PAY-002 shapes already frozen by the Step 1 corpus —
// shadow mode should agree with production today, not flag it.
describe('sanity — the real, already-confirmed TEST-PAY-002 credit shapes produce no contradictions', () => {
  it('Growth Credit: eligible=[transaction_processing] (contract_derived), carry_forward=true (contract_derived)', () => {
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    const context = { creditBasis: creditBasisContext(['transaction_processing']), creditApplication: creditApplicationContext(appRule) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings.some(f => f.outcome === 'contradicts')).toBe(false)
  })
  it('Service Credit: eligible="all" (contract_derived), carry_forward unclear (genuinely unstated)', () => {
    const appRule = buildCreditApplicationRule({ application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: 'unclear' } }, null, { eligibility: 'contract_derived' })
    const context = { creditApplication: creditApplicationContext(appRule) }
    const result = resolveVerdixRulebookShadow(context)
    expect(result.findings.some(f => f.outcome === 'contradicts')).toBe(false)
  })
})
