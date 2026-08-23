// Organization Rulebook — reviewer-decision promotion (Step 5D). Pure tests
// for evaluateReviewerDecisionForPromotion (lib/rulebook/organization-
// rulebook-promotion.ts) — no database, no AI, no mutation (the function
// itself has no side effects at all; DB-touching promotion tests — actual
// draft creation, activation, supersession, cross-org isolation — live in
// lib/organization-rulebook-promotion-integration.test.ts, gated behind
// RUN_RLS_INTEGRATION_TESTS the same way lib/organization-rulebook-rls.
// test.ts already is).
import { describe, it, expect } from 'vitest'
import { evaluateReviewerDecisionForPromotion, type PromotableFieldState } from '@/lib/rulebook/organization-rulebook-promotion'

const eligibleServiceCreditState: PromotableFieldState = {
  targetField: 'survival.carry_forward',
  provenance: 'reviewer_policy',
  value: true,
  matchFacts: { ruleType: 'service_credit', applicationTiming: 'next_invoice' },
}

describe('evaluateReviewerDecisionForPromotion — eligibility gates', () => {
  it('a resolved reviewer_policy decision with a concrete value is eligible, with a narrow structured scope (item 4)', () => {
    const result = evaluateReviewerDecisionForPromotion(eligibleServiceCreditState)
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.targetField).toBe('survival.carry_forward')
    expect(result.value).toBe(true)
    // Final amendment — survival.carry_forward's canonical scope is
    // rule_type ONLY (ORGANIZATION_POLICY_SCOPE_DIMENSIONS). application.
    // timing must never appear in match_conditions for this field: it
    // concerns WHEN a credit first becomes applicable, a different
    // commercial dimension from unused-balance SURVIVAL, and including it
    // would make a carry-forward default fail to generalize across
    // credits that differ only in timing.
    expect(result.matchConditions).toEqual([
      { field: 'rule_type', operator: 'eq', value: 'service_credit' },
    ])
    // scopeSummary still carries applicationTimingLabel — display CONTEXT
    // about the specific credit being promoted, never applicability.
    expect(result.scopeSummary).toEqual({
      ruleTypeLabel: 'Service Credit',
      applicationTimingLabel: 'Next invoice',
      treatmentLabel: 'Carry forward until fully used',
    })
  })

  it('the annual-rebate reviewer decision promotes with match_conditions containing rule_type=rebate ONLY (item 11, test 1)', () => {
    const result = evaluateReviewerDecisionForPromotion({
      ...eligibleServiceCreditState,
      matchFacts: { ruleType: 'rebate', applicationTiming: 'next_invoice' },
    })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.matchConditions).toEqual([
      { field: 'rule_type', operator: 'eq', value: 'rebate' },
    ])
    expect(result.matchConditions.some(c => c.field === 'application.timing')).toBe(false)
  })

  it('application.timing never enters match_conditions regardless of what value the credit itself has', () => {
    const withFutureInvoices = evaluateReviewerDecisionForPromotion({
      ...eligibleServiceCreditState,
      matchFacts: { ruleType: 'rebate', applicationTiming: 'future_invoices' },
    })
    expect(withFutureInvoices.eligible).toBe(true)
    if (!withFutureInvoices.eligible) return
    // Identical match_conditions regardless of applicationTiming's value —
    // proves the dimension genuinely isn't part of the scope, not merely
    // that this one example happened to omit it.
    expect(withFutureInvoices.matchConditions).toEqual([
      { field: 'rule_type', operator: 'eq', value: 'rebate' },
    ])
    expect(withFutureInvoices.scopeSummary.applicationTimingLabel).toBe('Future Invoices')
  })

  it('a false value produces the correct "does not carry forward" treatment label', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, value: false })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.scopeSummary.treatmentLabel).toBe('Does not carry forward past the period earned')
  })

  it('contract-derived value cannot be promoted (item 16)', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, provenance: 'contract_derived' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('contract_derived_cannot_promote')
  })

  it('organization_rulebook-originated value cannot recursively promote itself (item 16)', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, provenance: 'organization_rulebook' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('already_organization_policy')
  })

  it('verdix_recommends (never confirmed by a reviewer) is not eligible', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, provenance: 'verdix_recommends' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('not_a_resolved_reviewer_decision')
  })

  it('null/undefined provenance (never touched at all) is not eligible', () => {
    expect(evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, provenance: null }).eligible).toBe(false)
    expect(evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, provenance: undefined }).eligible).toBe(false)
  })

  it('reviewer_policy provenance but no concrete value (should not occur, checked belt-and-braces) is not eligible', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, value: 'unclear' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('no_concrete_value')
  })

  it('an invalid/non-allowlisted field cannot be promoted (item 16) — e.g. survival.one_time, which has real shadow support but no PRODUCTION authority', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, targetField: 'survival.one_time' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('field_not_promotable')
  })

  it('a field outside the allowlisted vocabulary entirely is also rejected, not just outside the production subset', () => {
    const result = evaluateReviewerDecisionForPromotion({ ...eligibleServiceCreditState, targetField: 'not_a_real_field' })
    expect(result.eligible).toBe(false)
    if (result.eligible) return
    expect(result.reason).toBe('field_not_promotable')
  })

  it('is a pure function — repeated calls with identical input produce identical output, no side effects', () => {
    const first = evaluateReviewerDecisionForPromotion(eligibleServiceCreditState)
    const second = evaluateReviewerDecisionForPromotion(eligibleServiceCreditState)
    expect(first).toEqual(second)
  })

  it('a different rule_type produces a correspondingly different structured scope, never a generic/global one', () => {
    const result = evaluateReviewerDecisionForPromotion({
      ...eligibleServiceCreditState,
      matchFacts: { ruleType: 'rebate', applicationTiming: 'next_invoice' },
    })
    expect(result.eligible).toBe(true)
    if (!result.eligible) return
    expect(result.matchConditions).toEqual([
      { field: 'rule_type', operator: 'eq', value: 'rebate' },
    ])
    expect(result.scopeSummary.ruleTypeLabel).toBe('Rebate')
  })
})
