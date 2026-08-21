// Freezes the canonical provenance/readiness safety model — the single
// most important guarantee this corpus exists to protect, since it is
// what a future Rulebook resolver must never regress:
//   contract_derived + concrete value  → resolved
//   reviewer_policy   + concrete value → resolved
//   verdix_recommends + concrete value → still unresolved / blocking
//   null / missing / unclear           → unresolved / blocking
// isProvenanceResolved() is the SOLE canonical gate — AI confidence,
// reasoning quality, or the mere existence of a concrete value must never
// substitute for it. See lib/types.ts's FieldProvenance doc comment and
// lib/commercial-rule-status.ts's isProvenanceResolved, both already
// production code exercised here directly. No AI calls.
import { describe, it, expect } from 'vitest'
import { isProvenanceResolved, isServiceCreditUnresolved, isMinimumCommitmentModeUnresolved, isDiscountUnresolved } from '@/lib/commercial-rule-status'
import { buildCreditApplicationRule } from '@/lib/credit-application-rule'
import type { FieldProvenance } from '@/lib/types'

describe('isProvenanceResolved — the canonical 4-state matrix', () => {
  it('contract_derived + concrete value → resolved', () => {
    expect(isProvenanceResolved('contract_derived')).toBe(true)
  })
  it('reviewer_policy + concrete value → resolved', () => {
    expect(isProvenanceResolved('reviewer_policy')).toBe(true)
  })
  it('verdix_recommends + concrete value → still unresolved / blocking — AI confidence is not provenance', () => {
    expect(isProvenanceResolved('verdix_recommends')).toBe(false)
  })
  it('null → unresolved / blocking', () => {
    expect(isProvenanceResolved(null)).toBe(false)
  })
  it('undefined (missing entirely) → unresolved / blocking', () => {
    expect(isProvenanceResolved(undefined)).toBe(false)
  })
})

describe('the gate holds even when the value itself is fully concrete — value presence is never a substitute for provenance', () => {
  it('a fully concrete application_rule (real eligible_component_keys, real carry_forward) with verdix_recommends provenance on survival still blocks', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'verdix_recommends' },
    )
    expect(result?.carry_forward).toBe(true)                  // the value IS there...
    expect(result?.requires_confirmation).toBe(true)          // ...but never clears the blocker on its own
  })
  it('the identical concrete value with reviewer_policy provenance instead DOES clear the blocker — same value, different provenance, different readiness outcome', () => {
    const result = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: true } },
      null,
      { eligibility: 'contract_derived', survival: 'reviewer_policy' },
    )
    expect(result?.carry_forward).toBe(true)
    expect(result?.requires_confirmation).toBe(false)
  })
})

describe('every real readiness predicate in the product ultimately bottoms out on this same gate, not a parallel one', () => {
  it('isServiceCreditUnresolved: a credit with a fully concrete but verdix_recommends-graded application_rule stays unresolved', () => {
    const appRule = buildCreditApplicationRule(
      { application_rule: { eligible_component_keys: 'all', one_time: false, carry_forward: true } },
      null,
      { eligibility: 'verdix_recommends', survival: 'verdix_recommends' },
    )
    expect(isServiceCreditUnresolved({ credit_rule_id: 'c1', interpretation: { requires_confirmation: false, application_rule: appRule } })).toBe(true)
  })
  it('isMinimumCommitmentModeUnresolved: a stated mode with no allowance present resolves — this predicate has no separate provenance concept, mode presence itself is the check (frozen for contrast with the credit predicate above, which DOES gate on provenance)', () => {
    expect(isMinimumCommitmentModeUnresolved({ mode: 'floor', requires_confirmation: false }, false)).toBe(false)
  })
  it('isDiscountUnresolved: requires_confirmation is the only signal this predicate reads — a discount confirmed via reviewer_policy or contract_derived both simply present as requires_confirmation: false by the time this runs (the provenance decision already happened upstream in confirm-rule)', () => {
    expect(isDiscountUnresolved({ interpretation: { requires_confirmation: false } })).toBe(false)
    expect(isDiscountUnresolved({ interpretation: { requires_confirmation: true } })).toBe(true)
  })
})

describe('contract silence must never become contract_derived', () => {
  it('there is no code path in isProvenanceResolved (or anywhere in this gate) that upgrades verdix_recommends to contract_derived — the three provenance values are read verbatim, never inferred upward from confidence', () => {
    // Documents the guarantee structurally: the function is a pure
    // three-way switch (see lib/commercial-rule-status.ts) with no
    // confidence/score input at all — there is nothing for a model's
    // confidence to even feed into. Exhaustively checks all three
    // FieldProvenance values plus the two absence cases resolve to
    // exactly the expected boolean, with no fourth "upgraded" outcome.
    const cases: Array<[FieldProvenance | null | undefined, boolean]> = [
      ['contract_derived', true],
      ['reviewer_policy', true],
      ['verdix_recommends', false],
      [null, false],
      [undefined, false],
    ]
    for (const [provenance, expected] of cases) {
      expect(isProvenanceResolved(provenance)).toBe(expected)
    }
  })
  it('a field the contract never addresses at all (genuinely silent) has no provenance to assign — modeled as null, which resolves to false exactly like an explicit verdix_recommends, never treated as more trustworthy than a graded recommendation', () => {
    expect(isProvenanceResolved(null)).toBe(isProvenanceResolved('verdix_recommends'))
  })
})
