// Step 10, item 7 — does the EXISTING Global Rulebook (9 rules, zero
// changes) already help this new contract family? Builds a
// CommercialSemanticContext from Case F's REAL captured interpretation
// result (a live Sonnet call against buildServiceCreditProposalPrompt,
// the current, unmodified production prompt — see lib/rulebook/
// MILESTONE_BILLING_FINDINGS.md for the full transcript) and runs it
// through the real, unmodified Step 2/3/8 machinery. No new Rulebook
// guidance, no prompt changes, no new rule.
import { describe, it, expect } from 'vitest'
import { resolveVerdixRulebookShadow } from '@/lib/rulebook/resolver'
import { resolveVerdixRulebookActivation } from '@/lib/rulebook/activation'
import { creditBasisContext, creditApplicationContext } from '@/lib/rulebook/context'
import { buildServiceCreditSurvivalCarryForwardTrace } from '@/lib/rulebook/decision-trace-service-credit'
import type { CommercialSemanticContext } from '@/lib/rulebook/types'

// Case F's real, captured proposed_interpretation.application_rule /
// credit_basis (live Sonnet call, buildServiceCreditProposalPrompt,
// unmodified) — the delay-penalty clause is explicit on trigger/value/cap
// but genuinely silent on application scope, survival, and cash treatment,
// exactly as a correct reading of the clause should be.
const CASE_F_CONTEXT: CommercialSemanticContext = {
  creditBasis: creditBasisContext(['milestone_3_fee']),
  creditApplication: creditApplicationContext({
    eligible_component_keys: null,
    eligibility_provenance: null,
    carry_forward: 'unclear',
    survival_provenance: null,
    availability: 'next_period',
  }),
}

describe('existing Global Rulebook rules already generalize to milestone/delay-credit clauses, unmodified', () => {
  it('credit.basis_ne_application_scope (rule C) fires: calculation basis (milestone_3_fee) is known, application scope correctly stays unresolved', () => {
    const shadow = resolveVerdixRulebookShadow(CASE_F_CONTEXT)
    expect(shadow.matchedRuleIds).toContain('credit.basis_ne_application_scope')
    const finding = shadow.findings.find(f => f.rule_id === 'credit.basis_ne_application_scope')
    expect(finding?.outcome).toBe('remains_unresolved')
  })

  it('credit.next_invoice_timing_ne_carry_forward (rule D) fires: availability=next_period does not establish carry_forward, which correctly stays unresolved', () => {
    const shadow = resolveVerdixRulebookShadow(CASE_F_CONTEXT)
    expect(shadow.matchedRuleIds).toContain('credit.next_invoice_timing_ne_carry_forward')
    const finding = shadow.findings.find(f => f.rule_id === 'credit.next_invoice_timing_ne_carry_forward')
    expect(finding?.outcome).toBe('remains_unresolved')
  })

  it('credit.future_payable_scope_ne_indefinite_survival (rule E) and credit.application_scope_ne_cash_redeemability (rule I) correctly do NOT fire — eligible_component_keys is null, not "all" or a concrete list, so there is no scope yet for either rule to reason about', () => {
    const shadow = resolveVerdixRulebookShadow(CASE_F_CONTEXT)
    expect(shadow.matchedRuleIds).not.toContain('credit.future_payable_scope_ne_indefinite_survival')
    expect(shadow.matchedRuleIds).not.toContain('credit.application_scope_ne_cash_redeemability')
  })

  it('no execution-target invariant fires — none of this context is a minimum-commitment/tier-pricing shape (expected, not a gap)', () => {
    const activation = resolveVerdixRulebookActivation(CASE_F_CONTEXT)
    expect(activation.violations).toEqual([])
  })

  it('exactly two of the nine current rules match this contract family — the rest are either credit-shape-specific (E, F, I) or invariant/provenance rules with nothing to evaluate at proposal time (A, B, G, H)', () => {
    const shadow = resolveVerdixRulebookShadow(CASE_F_CONTEXT)
    expect(shadow.matchedRuleIds.sort()).toEqual([
      'credit.basis_ne_application_scope',
      'credit.next_invoice_timing_ne_carry_forward',
    ].sort())
  })
})

describe('Step 8 decision tracing already generalizes to a milestone delay-credit\'s survival.carry_forward field, unmodified', () => {
  it('produces a real, well-formed trace: genuinely unresolved, readiness-blocking, zero organization rules matched for this synthetic exploration', () => {
    const trace = buildServiceCreditSurvivalCarryForwardTrace({
      applicationRule: { eligible_component_keys: null, carry_forward: 'unclear', survival_provenance: null, availability: 'next_period' },
      organizationId: 'step10-exploration-org',
      organizationRules: [],
      ruleType: 'service_credit',
      asOf: new Date('2026-08-24T00:00:00.000Z'),
    })
    expect(trace.final).toBeUndefined()
    expect(trace.execution.readinessBlocking).toBe(true)
    expect(trace.sourceState.explicitContractEvidence).toBe(false)
    expect(trace.traceMode).toBe('reconstructed_snapshot')
  })

  // Milestone amount, retention split, and change-order gating have NO
  // corresponding trace at all — there is no buildXxxTrace function
  // anywhere for retention/change-order/milestone percentage, because
  // lib/rulebook/decision-trace.ts's generic composer requires a real
  // field/value/provenance triple to trace, and none of these three
  // concepts has one yet (item 14: report unavailability, never fabricate
  // a generic trace to make every fixture look traceable — see
  // lib/rulebook/MILESTONE_BILLING_FINDINGS.md's decision-trace section
  // for the explicit "trace unavailable" statement per concept).
})
