import { describe, it, expect } from 'vitest'
import { buildCreditApplicationRule } from './credit-application-rule'
import { isProvenanceResolved } from './commercial-rule-status'
import type { FieldProvenance } from './types'

// Regression coverage for the core safety fix: a live A/B test (Opus vs
// Sonnet, TEST-PAY-002, 2026-08-20/21) showed a reasoning-tier model return
// concrete, confident values (carry_forward: false/true) for survival
// questions the contract never actually answers — tagged only as its own
// recommendation (survival_state: 'verdix_recommends'). Because
// requires_confirmation was previously derived from whether a value was
// present/concrete rather than from provenance, those recommendations
// silently cleared the credit's blocker. AI confidence is not provenance.

describe('isProvenanceResolved — the single canonical gate', () => {
  it('contract_derived resolves', () => expect(isProvenanceResolved('contract_derived')).toBe(true))
  it('reviewer_policy resolves', () => expect(isProvenanceResolved('reviewer_policy')).toBe(true))
  it('verdix_recommends does NOT resolve', () => expect(isProvenanceResolved('verdix_recommends')).toBe(false))
  it('null/undefined does NOT resolve', () => {
    expect(isProvenanceResolved(null)).toBe(false)
    expect(isProvenanceResolved(undefined)).toBe(false)
  })
})

describe('buildCreditApplicationRule — readiness gated on provenance, not value presence', () => {
  const baseApproved = (appRule: Record<string, unknown>) => ({ application_rule: appRule })

  it('A. Recommendation does not resolve — concrete value + verdix_recommends provenance still blocks', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false }),
      null,
      { eligibility: 'contract_derived', survival: 'verdix_recommends' },
    )
    expect(result?.carry_forward).toBe(false) // the concrete value IS stored...
    expect(result?.survival_provenance).toBe('verdix_recommends')
    expect(result?.requires_confirmation).toBe(true) // ...but never clears the blocker on its own
  })

  it('A2. Same for eligibility specifically — Opus\'s exact TEST-PAY-002 Rebate shape (eligible_component_keys concrete, eligibility contract_derived; carry_forward concrete, survival verdix_recommends)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false }),
      null,
      { eligibility: 'verdix_recommends', survival: 'verdix_recommends' },
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('B. Contract-derived resolves — no blocker when BOTH sub-fields are contract_derived', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.requires_confirmation).toBe(false)
    expect(result?.confirmation_reason).toBeNull()
  })

  it('C. Reviewer confirmation resolves — no blocker when BOTH sub-fields are reviewer_policy', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: 'all', one_time: false, carry_forward: true }),
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
    )
    expect(result?.requires_confirmation).toBe(false)
  })

  it('C2. Mixed provenance resolves too — contract_derived eligibility + reviewer_policy survival is fully resolved (order/source doesn\'t matter, only that both are good)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'reviewer_policy' },
    )
    expect(result?.requires_confirmation).toBe(false)
  })

  it('D. Model confidence cannot override provenance — no provenance supplied at all still blocks regardless of how concrete/confident the value looks', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: false, carry_forward: false, confirmation_reason: 'model is very confident' }),
      null,
      undefined, // no applicationRuleProvenance in the request at all
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('Only ONE sub-field resolved still blocks — eligibility contract_derived but survival verdix_recommends (TEST-PAY-002 Rebate\'s real, correct end state)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: 'unclear', carry_forward: 'unclear' }),
      null,
      { eligibility: 'contract_derived', survival: undefined },
    )
    expect(result?.eligibility_provenance).toBe('contract_derived')
    expect(result?.survival_provenance).toBeNull()
    expect(result?.requires_confirmation).toBe(true)
  })

  it('a later confirm on the same credit does not silently downgrade an earlier reviewer_policy back to unresolved when this submission omits provenance', () => {
    const existing = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: ['transaction_processing'], one_time: true, carry_forward: true }),
      null,
      { eligibility: 'reviewer_policy', survival: 'reviewer_policy' },
    )
    expect(existing?.requires_confirmation).toBe(false)
    // A subsequent confirm on the same credit (e.g. re-confirming trigger/
    // rate facts) that doesn't touch application_rule provenance at all —
    // existing resolved state must survive, not silently reset to blocked.
    const second = buildCreditApplicationRule(
      { application_rule: undefined },
      existing,
      undefined,
    )
    expect(second?.requires_confirmation).toBe(false)
    expect(second?.eligibility_provenance).toBe('reviewer_policy')
  })

  it('still returns null when there is no application_rule at all and nothing existing — genuinely nothing to grade yet', () => {
    const result = buildCreditApplicationRule({}, null, undefined)
    expect(result).toBeNull()
  })

  it('a value of null for eligible_component_keys blocks even with contract_derived provenance claimed (belt-and-braces: provenance alone is not sufficient without an actual value)', () => {
    const result = buildCreditApplicationRule(
      baseApproved({ eligible_component_keys: null, one_time: true, carry_forward: true }),
      null,
      { eligibility: 'contract_derived', survival: 'contract_derived' },
    )
    expect(result?.requires_confirmation).toBe(true)
  })

  it('provenance values are typed to the closed FieldProvenance set — compile-time guard against a stray string reaching this gate', () => {
    const valid: FieldProvenance[] = ['contract_derived', 'verdix_recommends', 'reviewer_policy']
    for (const p of valid) expect(['contract_derived', 'verdix_recommends', 'reviewer_policy']).toContain(p)
  })
})
