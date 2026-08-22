import { describe, it, expect } from 'vitest'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity } from './rule-id-stability'
import type { OneTimeFee } from './types'

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

function oneTimeFee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
  return { fee_label: 'Implementation Fee', amount: 100000, due_date: null, description: 'Implementation fee clause', ...overrides }
}

describe('preserveOneTimeFeeIdentity (Step 13 final amendment — fee_id/reviewed-state stability across re-extraction)', () => {
  it('carries fee_id + the full reviewed state forward for a fee matched by exact description', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      fee_id: 'fee-abc-123', amount_provenance: 'reviewer_policy', billability_provenance: 'reviewer_policy',
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      requires_confirmation: false, unresolved_kind: undefined, confirmation_reason: null,
    })]
    // A genuine re-extraction that reproduces the SAME condition again
    // (unresolved provenance, since this fresh pass hasn't been reviewed
    // yet) — not a placeholder null, which would represent a materially
    // DIFFERENT (missing) condition under the revised, condition-aware
    // preservation logic (see the dedicated changed-condition test below).
    const fresh: OneTimeFee[] = [oneTimeFee({
      fee_id: 'fee-freshly-assigned-999', billability_provenance: null,
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc-123') // NOT the freshly-assigned one
    expect(result[0].amount_provenance).toBe('reviewer_policy')
    expect(result[0].billability_provenance).toBe('reviewer_policy')
    expect(result[0].billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
  })

  it('a genuinely new fee (no description match) is left untouched', () => {
    const existing: OneTimeFee[] = [oneTimeFee({ fee_id: 'fee-abc-123', billability_provenance: 'reviewer_policy' })]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'A brand new, unrelated fee clause', fee_id: 'fee-new-1' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-new-1')
    expect(result[0].billability_provenance).toBeUndefined()
  })

  it('a materially changed description is treated as a new item — fresh fee_id, fully-reset reviewed state (the chosen invariant)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      description: 'SEK 100,000 upon customer acceptance', fee_id: 'fee-old-1',
      billability_provenance: 'reviewer_policy', billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      description: 'SEK 250,000 upon final acceptance of the second milestone', fee_id: 'fee-new-2',
      billability_provenance: null, billability_condition: null,
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-new-2') // the fresh id survives — NOT overwritten
    expect(result[0].billability_provenance).toBeNull() // fully reset, not carried over
  })

  it('does not carry over a fee_id from an existing item that never had one (legacy/exempt fee, first time entering the lifecycle)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({ fee_id: undefined })]
    const fresh: OneTimeFee[] = [oneTimeFee({ fee_id: 'fee-freshly-assigned-1' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-freshly-assigned-1') // untouched — nothing to preserve
  })

  it('old evidence is never silently claimed by a new, unrelated fee_id — the OLD fee_id simply disappears from the CURRENT fee set, never reused for a different item', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Fee A', fee_id: 'fee-A-1', billability_provenance: 'reviewer_policy' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Fee B (completely different clause)', fee_id: 'fee-B-fresh' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    // fee-A-1 does not appear anywhere in the result — it is not
    // transferred to Fee B just because Fee A vanished from this extraction.
    expect(result.map(f => f.fee_id)).not.toContain('fee-A-1')
  })

  it('final amendment (Part B, item 12) — same description but a DIFFERENT amount: fee_id carries forward (same clause), but amount-axis reviewed state resets (nobody reviewed the new number)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      amount: 100000, fee_id: 'fee-abc-123',
      amount_provenance: 'reviewer_policy', requires_confirmation: false, confirmation_reason: null,
      billability_provenance: 'reviewer_policy', billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      amount: 150000, fee_id: 'fee-freshly-assigned-999',
      amount_provenance: null, billability_provenance: null,
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' }, // condition itself unchanged
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc-123') // clause identity preserved
    expect(result[0].amount_provenance).toBeNull() // NOT 'reviewer_policy' — nobody reviewed 150000
    // Billability axis is untouched by an amount change — still carries forward.
    expect(result[0].billability_provenance).toBe('reviewer_policy')
    expect(result[0].billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
  })

  it('final amendment (Part B, item 12) — same description but a DIFFERENT billability_condition: fee_id carries forward, billability-axis resets, amount-axis is untouched', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      amount: 100000, fee_id: 'fee-abc-123',
      amount_provenance: 'reviewer_policy', requires_confirmation: false,
      billability_provenance: 'reviewer_policy', billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      amount: 100000, fee_id: 'fee-freshly-assigned-999',
      billability_provenance: null, billability_condition: { kind: 'event', event_type: 'final_acceptance' },
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc-123') // clause identity preserved
    expect(result[0].amount_provenance).toBe('reviewer_policy') // amount unchanged — still carries forward
    // Billability axis reset — reviewer confirmed customer_acceptance, not final_acceptance.
    expect(result[0].billability_provenance).toBeNull()
    expect(result[0].billability_condition).toEqual({ kind: 'event', event_type: 'final_acceptance' })
  })

  it('final amendment (Part B, item 12) — both amount AND condition unchanged under a matching description: full reviewed state preserved (the common case, unchanged behavior)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      amount: 100000, fee_id: 'fee-abc-123',
      amount_provenance: 'reviewer_policy', requires_confirmation: false,
      billability_provenance: 'reviewer_policy', billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      amount: 100000, fee_id: 'fee-freshly-assigned-999',
      amount_provenance: null, billability_provenance: null,
      billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc-123')
    expect(result[0].amount_provenance).toBe('reviewer_policy')
    expect(result[0].billability_provenance).toBe('reviewer_policy')
  })
})
