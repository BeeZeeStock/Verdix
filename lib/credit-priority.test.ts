import { describe, it, expect } from 'vitest'
import { detectCreditPriorityNeed } from './credit-priority'
import type { CreditApplicationRule } from './types'

function rule(overrides: Partial<CreditApplicationRule>): CreditApplicationRule {
  return {
    computed_from_component_keys: null,
    eligible_component_keys: null,
    excluded_component_keys: [],
    one_time: false,
    carry_forward: true,
    availability: 'next_period',
    requires_confirmation: false,
    confirmation_reason: null,
    ...overrides,
  }
}

describe('detectCreditPriorityNeed (scenario: TEST-PAY-002 — overlapping credit application order)', () => {
  it('disjoint scopes never need a priority decision', () => {
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'a', application_rule: rule({ eligible_component_keys: ['transaction_processing'] }) },
      { credit_rule_id: 'b', application_rule: rule({ eligible_component_keys: ['chargeback'] }) },
    ])
    expect(result).toEqual({ needed: false })
  })

  it('fewer than two resolvable credits never needs a priority decision', () => {
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'a', application_rule: rule({ eligible_component_keys: 'all' }) },
    ])
    expect(result).toEqual({ needed: false })
  })

  it('a narrow credit overlapping a broad "all" credit recommends the narrow one first', () => {
    // Growth Credit (narrow, transaction-processing only) vs Service Credit (broad, all).
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'growth', application_rule: rule({ eligible_component_keys: ['transaction_processing'] }) },
      { credit_rule_id: 'service', application_rule: rule({ eligible_component_keys: 'all' }) },
    ])
    expect(result.needed).toBe(true)
    if (result.needed) {
      expect(result.conflictingIds.sort()).toEqual(['growth', 'service'])
      expect(result.recommendedOrder).toEqual(['growth', 'service'])
    }
  })

  it('two equally broad overlapping credits with no natural ordering is pure Decision required', () => {
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'a', application_rule: rule({ eligible_component_keys: 'all' }) },
      { credit_rule_id: 'b', application_rule: rule({ eligible_component_keys: 'all' }) },
    ])
    expect(result.needed).toBe(true)
    if (result.needed) expect(result.recommendedOrder).toBeNull()
  })

  it('unresolved credits (requires_confirmation) are excluded from the conflict check entirely', () => {
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'a', application_rule: rule({ eligible_component_keys: 'all' }) },
      { credit_rule_id: 'b', application_rule: rule({ eligible_component_keys: null, requires_confirmation: true }) },
    ])
    expect(result).toEqual({ needed: false })
  })

  it('excluded_component_keys narrows an otherwise-"all" scope for overlap purposes', () => {
    const result = detectCreditPriorityNeed([
      { credit_rule_id: 'a', application_rule: rule({ eligible_component_keys: ['transaction_processing'] }) },
      { credit_rule_id: 'b', application_rule: rule({ eligible_component_keys: 'all', excluded_component_keys: ['transaction_processing'] }) },
    ])
    expect(result).toEqual({ needed: false })
  })
})
