import { describe, it, expect } from 'vitest'
import { detectRuleInteractionCandidates } from './rule-interactions'

describe('detectRuleInteractionCandidates — service credit vs discount (scenario: TEST-SAA-001)', () => {
  it('flags a service credit and an introductory discount that both reference the platform subscription fee', () => {
    const candidates = detectRuleInteractionCandidates({
      service_credits: [{
        credit_rule_id: 'cred1',
        description: 'Monthly availability service credit',
        interpretation: { basis_component: 'platform subscription fee' },
      }],
      discounts: [{
        discount_rule_id: 'disc1',
        description: 'Introductory platform subscription discount',
        applies_to: 'platform subscription',
        start_date: '2026-08-17',
        end_date: '2026-11-16',
      }],
      escalators: [],
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].interactionKey).toBe('service_credit:cred1|discount:disc1')
    expect(candidates[0].otherRule).toEqual({ ruleType: 'discount', id: 'disc1', label: 'Introductory platform subscription discount' })
  })

  it('does not flag a service credit and a discount for unrelated fee components', () => {
    const candidates = detectRuleInteractionCandidates({
      service_credits: [{
        credit_rule_id: 'cred1',
        description: 'Availability credit',
        interpretation: { basis_component: 'platform subscription fee' },
      }],
      discounts: [{
        discount_rule_id: 'disc1',
        description: 'Volume discount on API overage charges',
        applies_to: 'API overage usage charge',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
      }],
      escalators: [],
    })
    expect(candidates).toHaveLength(0)
  })

  it('falls back to the raw extracted description before the credit\'s own interpretation is confirmed', () => {
    const candidates = detectRuleInteractionCandidates({
      service_credits: [{
        credit_rule_id: 'cred1',
        description: 'Credit against the platform subscription fee',
        // interpretation not yet set — the interaction should still surface.
      }],
      discounts: [{
        discount_rule_id: 'disc1',
        description: 'Platform subscription discount',
        applies_to: 'platform subscription',
        start_date: '2026-08-17',
        end_date: '2026-11-16',
      }],
      escalators: [],
    })
    expect(candidates).toHaveLength(1)
  })

  it('flags a service credit and an escalator that reference the same fee component', () => {
    const candidates = detectRuleInteractionCandidates({
      service_credits: [{
        credit_rule_id: 'cred1',
        description: 'Availability credit',
        interpretation: { basis_component: 'platform subscription fee' },
      }],
      discounts: [],
      escalators: [{
        description: 'Annual increase to the platform subscription fee',
        effective_date: '2027-08-17',
      }],
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].otherRule.ruleType).toBe('escalator')
  })

  it('produces no candidates when there are no service credits at all', () => {
    const candidates = detectRuleInteractionCandidates({
      service_credits: [],
      discounts: [{ discount_rule_id: 'disc1', description: 'Discount', applies_to: 'platform subscription' }],
      escalators: [],
    })
    expect(candidates).toEqual([])
  })
})
