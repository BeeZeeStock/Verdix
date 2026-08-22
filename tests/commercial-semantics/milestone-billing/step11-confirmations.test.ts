// Step 11 — required confirmations (items 12, 13, 15), each pinned as a
// real, failing-if-violated test rather than only asserted in prose.
import { describe, it, expect } from 'vitest'
import { FIXTURE_F_DELAY_PENALTY } from './fixtures'
import { CASH_REDEEMABILITY_CANDIDATE, MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE, VERDIX_RULE_CANDIDATES } from '@/lib/rulebook/rule-candidates'
import { verdixCommercialRulebook } from '@/lib/rulebook/rules'
import { PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST } from '@/lib/rulebook/organization-rulebook-production'
import { auditVerdixRulebook } from '@/lib/rulebook/rulebook-audit'

describe('item 12 — Case F (delay penalty) remains on the credit path, not moved into OneTimeFee', () => {
  it('Case F\'s fixture clause is unchanged and still describes a credit, never a one-time-fee shape', () => {
    expect(FIXTURE_F_DELAY_PENALTY.contractText).toMatch(/credit equal to 2%/)
    expect(FIXTURE_F_DELAY_PENALTY.expectedConcepts).toContain('delay trigger')
  })

  it('the cash-redeemability candidate (Case F\'s governance record) is untouched by Step 11 — still anti_inference, still approved+active, unrelated to one_time_fee', () => {
    expect(CASH_REDEEMABILITY_CANDIDATE.proposedClass).toBe('anti_inference')
    expect(CASH_REDEEMABILITY_CANDIDATE.status).toBe('approved')
    expect(CASH_REDEEMABILITY_CANDIDATE.activeRuleId).toBe('credit.application_scope_ne_cash_redeemability')
  })
})

describe('item 13 — milestone.delivery_ne_acceptance stays validated, never approved or active', () => {
  it('status is exactly "validated"', () => {
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.status).toBe('validated')
  })
  it('has no activeRuleId — was not promoted', () => {
    expect(MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.activeRuleId).toBeUndefined()
  })
  it('does not correspond to any rule in the real, active Global Rulebook', () => {
    expect(verdixCommercialRulebook.find(r => r.id === MILESTONE_DELIVERY_NE_ACCEPTANCE_CANDIDATE.proposedRuleId)).toBeUndefined()
  })
  it('the Global Rulebook is still exactly 9 rules — no new rule activated by Step 11', () => {
    expect(verdixCommercialRulebook).toHaveLength(9)
  })
  it('the full governance registry (including all Step 10/11 candidates) still passes the audit cleanly', () => {
    const result = auditVerdixRulebook(VERDIX_RULE_CANDIDATES)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('item 15 — Organization Rulebook production allowlist is unchanged', () => {
  it('is still exactly [\'survival.carry_forward\'] — Step 11 adds no one_time_fee entry', () => {
    expect(PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST).toEqual(['survival.carry_forward'])
  })
})
