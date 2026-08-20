import { describe, it, expect } from 'vitest'
import { preserveStableRuleIds } from './rule-id-stability'

type Item = { description: string; discount_rule_id?: string; interpretation?: unknown }

describe('preserveStableRuleIds (scenario: TEST-PAY-002 — re-extraction identity stability)', () => {
  it('carries the id and interpretation forward for an item matched by exact description', () => {
    const existing: Item[] = [
      { description: 'Volume discount', discount_rule_id: 'abc12345', interpretation: { resolved: true } },
    ]
    const fresh: Item[] = [
      { description: 'Volume discount' }, // re-extracted, no id yet
    ]
    const result = preserveStableRuleIds(existing, fresh, 'discount_rule_id')
    expect(result[0].discount_rule_id).toBe('abc12345')
    expect(result[0].interpretation).toEqual({ resolved: true })
  })

  it('leaves a genuinely new item (no description match) untouched — gets its id assigned elsewhere', () => {
    const existing: Item[] = [
      { description: 'Volume discount', discount_rule_id: 'abc12345', interpretation: { resolved: true } },
    ]
    const fresh: Item[] = [
      { description: 'Volume discount' },
      { description: 'New early-payment discount' },
    ]
    const result = preserveStableRuleIds(existing, fresh, 'discount_rule_id')
    expect(result[1].discount_rule_id).toBeUndefined()
    expect(result[1].interpretation).toBeUndefined()
  })

  it('a materially changed description is treated as a new item — no id/interpretation carried over', () => {
    const existing: Item[] = [
      { description: 'Volume discount, 10% above 1000 units', discount_rule_id: 'abc12345', interpretation: { resolved: true } },
    ]
    const fresh: Item[] = [
      { description: 'Volume discount, 15% above 2000 units' }, // materially different clause text
    ]
    const result = preserveStableRuleIds(existing, fresh, 'discount_rule_id')
    expect(result[0].discount_rule_id).toBeUndefined()
    expect(result[0].interpretation).toBeUndefined()
  })

  it('does not carry over an id from an existing item that never had one itself', () => {
    const existing: Item[] = [{ description: 'Volume discount' }]
    const fresh: Item[] = [{ description: 'Volume discount' }]
    const result = preserveStableRuleIds(existing, fresh, 'discount_rule_id')
    expect(result[0].discount_rule_id).toBeUndefined()
  })
})
