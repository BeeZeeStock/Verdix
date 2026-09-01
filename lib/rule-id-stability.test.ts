import { describe, it, expect } from 'vitest'
import { preserveStableRuleIds, preserveOneTimeFeeIdentity, preserveTierIdentity, preserveTierCalculationReviewState, preserveRecurringFeeIdentity, type TierCalculationAuditRow } from './rule-id-stability'
import { buildLineItems } from './line-items'
import type { OneTimeFee, OverageTier, ContractTerms, AdditionalRecurringFee } from './types'

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

describe('preserveOneTimeFeeIdentity — Step 17H.4B0D4B0A.1 cardinality hardening', () => {
  it('old 2 -> new 1, same description: ambiguous, old id never reused (not "last wins")', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-A' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-B' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-fresh-1' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-fresh-1')
    expect(result[0].fee_id).not.toBe('fee-A')
    expect(result[0].fee_id).not.toBe('fee-B')
  })

  it('old 1 -> new 2, same description: ambiguous, neither new fee inherits the old id, and they never collide with each other', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-A' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-fresh-X' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-fresh-Y' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-fresh-X')
    expect(result[1].fee_id).toBe('fee-fresh-Y')
    expect(result[0].fee_id).not.toBe('fee-A')
    expect(result[1].fee_id).not.toBe('fee-A')
    expect(result[0].fee_id).not.toBe(result[1].fee_id)
  })

  it('old 2 -> new 2, same description: ambiguous, no positional/array-index pairing — every fee keeps its own fresh id', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-A' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-B' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-fresh-X' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-fresh-Y' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result.map(f => f.fee_id)).toEqual(['fee-fresh-X', 'fee-fresh-Y'])
  })

  it('a blank/empty-string description never forms an equivalence class — no reuse, no cross-item collision', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: '', fee_id: 'fee-A' }),
      oneTimeFee({ description: null, fee_id: 'fee-B' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: '', fee_id: 'fee-fresh-X' }),
      oneTimeFee({ description: null, fee_id: 'fee-fresh-Y' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-fresh-X')
    expect(result[1].fee_id).toBe('fee-fresh-Y')
  })

  it('unique groups preserve correctly alongside a separate ambiguous group in the same call', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-old' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-A' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-B' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-fresh' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-impl-fresh' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-setup-old') // unique group: reused
    expect(result[1].fee_id).toBe('fee-impl-fresh') // ambiguous group: kept fresh
  })

  it('every fee_id in the result remains unique after preservation, across mixed ambiguous and unique groups', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-old' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-A' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-B' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-fresh' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-impl-fresh-1' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-impl-fresh-2' }),
      oneTimeFee({ description: '', fee_id: 'fee-blank-1' }),
      oneTimeFee({ description: '', fee_id: 'fee-blank-2' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    const ids = result.map(f => f.fee_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => !!id)).toBe(true)
  })

  it('an already-duplicated fee_id in the existing data is never propagated, even through an otherwise-unique description match', () => {
    // Two DIFFERENT existing fees (different descriptions, a pre-existing
    // data-integrity issue this function does not repair) already share
    // one fee_id.
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-shared' }),
      oneTimeFee({ description: 'Onboarding fee', fee_id: 'fee-shared' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-fresh-1' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-fresh-1')
    expect(result[0].fee_id).not.toBe('fee-shared')
  })

  it('amount changes while description stays unique on both sides: identity still preserved (unchanged from before hardening)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', amount: 100000, fee_id: 'fee-abc' })]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', amount: 150000, fee_id: 'fee-fresh' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc')
  })

  it('fee_label changes while description stays unique on both sides: identity still preserved', () => {
    const existing: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_label: 'Old Label', fee_id: 'fee-abc' })]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_label: 'New Label', fee_id: 'fee-fresh' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-abc')
  })
})

describe('preserveOneTimeFeeIdentity — Step 17H.4B0D4B0A.1.1 (legacy NULL existing fee_id)', () => {
  it('old fee_id explicitly null, unique match: fresh id retained (never erased to null)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: undefined })]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: 'fresh-generated-id' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id')
  })

  it('old fee_id property entirely absent (not merely null), unique match: fresh id retained', () => {
    const existing = [{ fee_label: 'Implementation Fee', amount: 100000, due_date: null, description: 'Implementation fee clause' }] as OneTimeFee[]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee clause', fee_id: 'fresh-generated-id' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id')
  })

  it('old fee_id null but amount is identical, unique match: fresh id retained AND eligible amount-axis provenance IS now preserved (the fix)', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      description: 'Implementation fee', fee_id: undefined, amount: 100000,
      amount_provenance: 'reviewer_policy', requires_confirmation: false, unresolved_kind: undefined, confirmation_reason: null,
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      description: 'Implementation fee', fee_id: 'fresh-generated-id', amount: 100000, amount_provenance: null,
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id') // still the fresh id — no old id to reuse
    expect(result[0].amount_provenance).toBe('reviewer_policy') // now preserved — the fix
    expect(result[0].requires_confirmation).toBe(false)
  })

  it('old fee_id null AND billability_condition identical, unique match: fresh id retained AND billability-axis provenance is preserved', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      description: 'Implementation fee', fee_id: undefined,
      billability_provenance: 'reviewer_policy', billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      description: 'Implementation fee', fee_id: 'fresh-generated-id',
      billability_provenance: null, billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id')
    expect(result[0].billability_provenance).toBe('reviewer_policy')
  })

  it('ambiguous description (old 2 -> new 1) still retains fresh id — legacy-NULL fix does not weaken B0A.1 cardinality hardening', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Implementation fee', fee_id: undefined }),
      oneTimeFee({ description: 'Implementation fee', fee_id: undefined }),
    ]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: 'fresh-generated-id', amount_provenance: null })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id')
    expect(result[0].amount_provenance).toBeNull() // no provenance preserved either — ambiguous means no continuity at all
  })

  it('duplicated old fee_id upstream still blocks id reuse — legacy-NULL fix does not weaken the duplicate-id guard', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-shared' }),
      oneTimeFee({ description: 'Onboarding fee', fee_id: 'fee-shared' }),
    ]
    const fresh: OneTimeFee[] = [oneTimeFee({ description: 'Setup fee', fee_id: 'fee-fresh-1' })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-fresh-1')
  })

  it('mixed groups in one call: real-id reuse, legacy-null retention, and ambiguous retention all coexist with unique, non-null output ids', () => {
    const existing: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-old' }), // Group A: real id
      oneTimeFee({ description: 'Implementation fee', fee_id: undefined }), // Group B: legacy null
      oneTimeFee({ description: 'Onboarding fee', fee_id: 'fee-onb-1' }), // Group C: ambiguous (2 old)
      oneTimeFee({ description: 'Onboarding fee', fee_id: 'fee-onb-2' }),
    ]
    const fresh: OneTimeFee[] = [
      oneTimeFee({ description: 'Setup fee', fee_id: 'fee-setup-fresh' }),
      oneTimeFee({ description: 'Implementation fee', fee_id: 'fee-impl-fresh' }),
      oneTimeFee({ description: 'Onboarding fee', fee_id: 'fee-onb-fresh' }),
    ]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fee-setup-old') // Group A: reused
    expect(result[1].fee_id).toBe('fee-impl-fresh') // Group B: fresh retained (legacy null)
    expect(result[2].fee_id).toBe('fee-onb-fresh') // Group C: fresh retained (ambiguous)
    const ids = result.map(f => f.fee_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => !!id)).toBe(true)
  })

  it('legacy-to-modern-to-stable convergence: generation 0 (NULL) -> generation 1 acquires X -> generation 2 retains X', () => {
    // Generation 0 — legacy persisted, no fee_id.
    const gen0: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: undefined })]

    // Generation 1 — fresh extraction receives UUID X; unique match against gen0's NULL.
    const gen1Fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: 'uuid-X' })]
    const gen1Result = preserveOneTimeFeeIdentity(gen0, gen1Fresh)
    expect(gen1Result[0].fee_id).toBe('uuid-X')

    // Generation 2 — a further re-extraction receives a NEW UUID Y; unique
    // match against generation 1's now-persisted state (carrying X).
    const gen2Fresh: OneTimeFee[] = [oneTimeFee({ description: 'Implementation fee', fee_id: 'uuid-Y' })]
    const gen2Result = preserveOneTimeFeeIdentity(gen1Result, gen2Fresh)
    expect(gen2Result[0].fee_id).toBe('uuid-X') // X survives — Y is discarded in favor of the now-real prior identity
  })

  it('description change still breaks identity entirely — no fuzzy continuity inferred through amount/label, even with a legacy-null old record', () => {
    const existing: OneTimeFee[] = [oneTimeFee({
      description: 'Old clause text', fee_id: undefined, amount_provenance: 'reviewer_policy',
    })]
    const fresh: OneTimeFee[] = [oneTimeFee({
      description: 'Materially different clause text', fee_id: 'fresh-generated-id', amount_provenance: null,
    })]
    const result = preserveOneTimeFeeIdentity(existing, fresh)
    expect(result[0].fee_id).toBe('fresh-generated-id')
    expect(result[0].amount_provenance).toBeNull()
  })
})

function overageTier(overrides: Partial<OverageTier> = {}): OverageTier {
  return {
    tier_label: 'Calls 1–10,000', from_unit: 1, to_unit: 10000, rate_per_unit: 0.02, unit_type: 'API call',
    ...overrides,
  }
}

describe('preserveTierIdentity — Step 17H.4B0D4B1A (structural fingerprint: metricKey + from_unit + to_unit)', () => {
  it('unique structural 1:1 match: old tier_id reused', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc')
  })

  it('rate change alone: old tier_id still reused (rate is excluded from the fingerprint)', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', rate_per_unit: 0.02 })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', rate_per_unit: 0.05 })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc')
  })

  it('tier_label change alone: old tier_id still reused (label is presentation, excluded from the fingerprint)', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', tier_label: 'Requests 1–1,000' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', tier_label: 'First 1,000 requests' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc')
  })

  it('tier_calculation/interpretation/confidence-style field changes: still reused (none of these are in the fingerprint)', () => {
    const existing: OverageTier[] = [overageTier({
      tier_id: 'tier-abc',
      tier_calculation: { method: 'graduated', requires_confirmation: true, source_clause: 'old clause' },
    })]
    const fresh: OverageTier[] = [overageTier({
      tier_id: 'tier-fresh',
      tier_calculation: { method: 'volume', requires_confirmation: false, source_clause: 'new clause' },
    })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc')
  })

  it('from_unit changes: fresh tier_id retained (structural change, identity not preserved)', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', from_unit: 1 })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', from_unit: 501 })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('to_unit changes: fresh tier_id retained', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', to_unit: 10000 })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', to_unit: 20000 })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('metric identity changes (unit_type materially different): fresh tier_id retained', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', unit_type: 'API call' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', unit_type: 'SMS message' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('semantic_input_key change (when present) also breaks the fingerprint, even with the same unit_type', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', semantic_input_key: 'issued_payment_request_count' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', semantic_input_key: 'settled_payment_request_count' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('open-ended boundary becomes bounded (to_unit: null -> a number): fresh tier_id retained', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', to_unit: null })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', to_unit: 100000 })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('bounded boundary becomes open-ended (to_unit: a number -> null): fresh tier_id retained', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', to_unit: 100000 })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', to_unit: null })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('old 2 -> new 1, same fingerprint: ambiguous, no old id reused', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-A' }), overageTier({ tier_id: 'tier-B' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('old 1 -> new 2, same fingerprint: no old id reused by either, and they never collide', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-A' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh-X' }), overageTier({ tier_id: 'tier-fresh-Y' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh-X')
    expect(result[1].tier_id).toBe('tier-fresh-Y')
  })

  it('old 2 -> new 2, same fingerprint: no positional/array-order pairing — every tier keeps its own fresh id', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-A' }), overageTier({ tier_id: 'tier-B' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh-X' }), overageTier({ tier_id: 'tier-fresh-Y' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result.map(t => t.tier_id)).toEqual(['tier-fresh-X', 'tier-fresh-Y'])
  })

  it('old tier_id missing (legacy pre-tier_id row), unique structural match: fresh tier_id retained, never null', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: undefined })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('legacy -> modern -> stable convergence: generation 0 (no tier_id) -> generation 1 acquires X -> generation 2 retains X', () => {
    const gen0: OverageTier[] = [overageTier({ tier_id: undefined })]
    const gen1Fresh: OverageTier[] = [overageTier({ tier_id: 'uuid-X' })]
    const gen1Result = preserveTierIdentity(gen0, gen1Fresh)
    expect(gen1Result[0].tier_id).toBe('uuid-X')

    const gen2Fresh: OverageTier[] = [overageTier({ tier_id: 'uuid-Y' })]
    const gen2Result = preserveTierIdentity(gen1Result, gen2Fresh)
    expect(gen2Result[0].tier_id).toBe('uuid-X')
  })

  it('duplicated old tier_id upstream is never propagated, even through an otherwise-unique fingerprint match', () => {
    const existing: OverageTier[] = [
      overageTier({ tier_id: 'tier-shared', unit_type: 'API call', from_unit: 1, to_unit: 10000 }),
      overageTier({ tier_id: 'tier-shared', unit_type: 'SMS message', from_unit: 1, to_unit: 500 }),
    ]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', unit_type: 'API call', from_unit: 1, to_unit: 10000 })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-fresh')
  })

  it('mixed groups in one call: safe reuse, legacy-null retention, and ambiguous retention all coexist with unique, non-null output ids', () => {
    const existing: OverageTier[] = [
      overageTier({ tier_id: 'tier-band1', unit_type: 'API call', from_unit: 1, to_unit: 10000 }), // unique -> reuse
      overageTier({ tier_id: undefined, unit_type: 'SMS message', from_unit: 1, to_unit: 500 }), // legacy null
      overageTier({ tier_id: 'tier-amb-1', unit_type: 'Storage GB', from_unit: 1, to_unit: 100 }), // ambiguous (2 old)
      overageTier({ tier_id: 'tier-amb-2', unit_type: 'Storage GB', from_unit: 1, to_unit: 100 }),
    ]
    const fresh: OverageTier[] = [
      overageTier({ tier_id: 'fresh-1', unit_type: 'API call', from_unit: 1, to_unit: 10000 }),
      overageTier({ tier_id: 'fresh-2', unit_type: 'SMS message', from_unit: 1, to_unit: 500 }),
      overageTier({ tier_id: 'fresh-3', unit_type: 'Storage GB', from_unit: 1, to_unit: 100 }),
    ]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-band1') // reused
    expect(result[1].tier_id).toBe('fresh-2') // legacy null -> fresh retained
    expect(result[2].tier_id).toBe('fresh-3') // ambiguous -> fresh retained
    const ids = result.map(t => t.tier_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => !!id)).toBe(true)
  })

  it('missing metric identity fallback: unit_type normalization is case/whitespace-insensitive only, no fuzzy matching', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', unit_type: '  API Call  ' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', unit_type: 'api call' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc') // same metric after trim+lowercase normalization
  })

  it('semantic_input_key is preferred over unit_type when present on both sides, even if unit_type text differs', () => {
    const existing: OverageTier[] = [overageTier({ tier_id: 'tier-abc', semantic_input_key: 'issued_payment_request_count', unit_type: 'payment request' })]
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh', semantic_input_key: 'issued_payment_request_count', unit_type: 'different label entirely' })]
    const result = preserveTierIdentity(existing, fresh)
    expect(result[0].tier_id).toBe('tier-abc')
  })

  it('candidate array order never changes the outcome for the ambiguous case', () => {
    const a = overageTier({ tier_id: 'tier-A' })
    const b = overageTier({ tier_id: 'tier-B' })
    const fresh: OverageTier[] = [overageTier({ tier_id: 'tier-fresh' })]
    const forward = preserveTierIdentity([a, b], fresh)
    const reversed = preserveTierIdentity([b, a], fresh)
    expect(forward[0].tier_id).toBe('tier-fresh')
    expect(reversed[0].tier_id).toBe('tier-fresh')
  })
})

function tierCalc(overrides: Partial<{ method: 'graduated' | 'volume' | 'block' | 'custom'; requires_confirmation: boolean; confirmation_reason: string | null; source_clause: string | null }> = {}) {
  return {
    method: 'graduated' as const,
    requires_confirmation: false,
    confirmation_reason: null,
    source_clause: null,
    ...overrides,
  }
}

function auditRow(unitType: string | null, method: unknown): TierCalculationAuditRow {
  return { contract_unit_type: unitType, approved_interpretation: { method } }
}

describe('preserveTierCalculationReviewState — Step 17H.4B0D4B1B0D (metric-scoped, unit_type-keyed, method-only fingerprint)', () => {
  it('1. audit/prior/fresh all graduated -> requires_confirmation restored to false, confirmation_reason nulled', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: false }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, confirmation_reason: 'newly ambiguous' }) })]
    const audit = [auditRow('SMS reminder', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(false)
    expect(result[0].tier_calculation?.confirmation_reason).toBeNull()
    expect(result[0].tier_calculation?.method).toBe('graduated') // fresh method retained, never overwritten
  })

  it('2. audit method mismatch (audit=volume, prior/fresh=graduated) -> no preservation', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const audit = [auditRow('API call', 'volume')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('3. fresh method changed (audit=prior=graduated, fresh=volume) -> no preservation, old approval never blesses new semantics', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'volume', requires_confirmation: true, confirmation_reason: 'model default on uncertainty' }) })]
    const audit = [auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.method).toBe('volume')
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
    expect(result[0].tier_calculation?.confirmation_reason).toBe('model default on uncertainty')
  })

  it('4. no audit evidence at all -> no preservation, fresh state untouched', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: false }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, confirmation_reason: 'model uncertain this pass' }) })]
    const result = preserveTierCalculationReviewState(prior, fresh, [])
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
    expect(result[0].tier_calculation?.confirmation_reason).toBe('model uncertain this pass')
  })

  it('5. duplicate current audit rows for the same unit_type -> ambiguous, no preservation even when both agree', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const audit = [auditRow('API call', 'graduated'), auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('6. mixed prior methods within one metric group -> integrity ambiguity, no preservation', () => {
    const prior: OverageTier[] = [
      overageTier({ unit_type: 'API call', from_unit: 1, to_unit: 100, tier_calculation: tierCalc({ method: 'graduated' }) }),
      overageTier({ unit_type: 'API call', from_unit: 101, to_unit: null, tier_calculation: tierCalc({ method: 'volume' }) }),
    ]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const audit = [auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('7. mixed fresh methods within one metric group -> no partial per-band preservation', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [
      overageTier({ unit_type: 'API call', from_unit: 1, to_unit: 100, tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }),
      overageTier({ unit_type: 'API call', from_unit: 101, to_unit: null, tier_calculation: tierCalc({ method: 'volume', requires_confirmation: true }) }),
    ]
    const audit = [auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result.every(t => t.tier_calculation?.requires_confirmation === true)).toBe(true)
  })

  it('8. raw unit_type case change breaks review continuity — deliberately more conservative than tier_id normalization', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API Call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'api call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const audit = [auditRow('API Call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('9. source_clause changed but method aligned three-way -> review state preserved, fresh source_clause kept (never restored from prior)', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', source_clause: 'old clause text' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, source_clause: 'freshly extracted different clause text' }) })]
    const audit = [auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(false)
    expect(result[0].tier_calculation?.confirmation_reason).toBeNull()
    expect(result[0].tier_calculation?.source_clause).toBe('freshly extracted different clause text')
  })

  it('10. zero-rate included band with no tier_calculation stays omitted, never manufactured by preservation', () => {
    const prior: OverageTier[] = [
      overageTier({ unit_type: 'AI processing request', from_unit: 1, to_unit: 100000, rate_per_unit: 0, tier_calculation: undefined }),
      overageTier({ unit_type: 'AI processing request', from_unit: 100001, to_unit: null, rate_per_unit: 0.035, tier_calculation: tierCalc({ method: 'graduated' }) }),
    ]
    const fresh: OverageTier[] = [
      overageTier({ unit_type: 'AI processing request', from_unit: 1, to_unit: 100000, rate_per_unit: 0, tier_calculation: undefined }),
      overageTier({ unit_type: 'AI processing request', from_unit: 100001, to_unit: null, rate_per_unit: 0.035, tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }),
    ]
    const audit = [auditRow('AI processing request', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation).toBeUndefined()
    expect(result[1].tier_calculation?.requires_confirmation).toBe(false)
  })

  it('11. multiple paid calculation-bearing bands in one metric -> all restored together, not just the first', () => {
    const prior: OverageTier[] = [
      overageTier({ unit_type: 'API call', from_unit: 1, to_unit: 100, tier_calculation: tierCalc({ method: 'graduated' }) }),
      overageTier({ unit_type: 'API call', from_unit: 101, to_unit: 1000, tier_calculation: tierCalc({ method: 'graduated' }) }),
      overageTier({ unit_type: 'API call', from_unit: 1001, to_unit: null, tier_calculation: tierCalc({ method: 'graduated' }) }),
    ]
    const fresh: OverageTier[] = prior.map(t => ({ ...t, tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, confirmation_reason: 'fresh pass' }) }))
    const audit = [auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result.every(t => t.tier_calculation?.requires_confirmation === false)).toBe(true)
    expect(result.every(t => t.tier_calculation?.confirmation_reason === null)).toBe(true)
  })

  it('12. malformed/unsupported approved method never authorizes preservation', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const malformed = [auditRow('API call', 'staircase'), auditRow('API call', undefined), auditRow('API call', 123)]
    for (const row of malformed) {
      const result = preserveTierCalculationReviewState(prior, fresh, [row])
      expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
    }
  })

  it('13. historical (non-current) evidence must never be passed as authorizing — caller contract, not the helper\'s own filtering', () => {
    // The helper trusts its input is already is_current=true (matching every
    // other preserve* helper's own trust-the-caller contract) — this test
    // documents that a caller who accidentally includes a stale/non-current
    // row still gets it treated as authorizing, which is exactly why
    // execute/route.ts's query itself must filter is_current=true and this
    // is never re-verified here. Demonstrated via the ambiguous case
    // instead: a genuinely historical row plus a current one for the same
    // unit_type would look identical to "2 current rows" to this helper,
    // and correctly refuses to pick a winner.
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const historicalPlusCurrent = [auditRow('API call', 'volume'), auditRow('API call', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, historicalPlusCurrent)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('14. audit evidence for an unrelated unit_type is ignored', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) })]
    const audit = [auditRow('Some other metric', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(true)
  })

  it('15. two independent metric groups resolved independently', () => {
    const prior: OverageTier[] = [
      overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) }),
      overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'graduated' }) }),
    ]
    const fresh: OverageTier[] = [
      overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }),
      overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }),
    ]
    const audit = [auditRow('API call', 'graduated'), auditRow('SMS reminder', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result.every(t => t.tier_calculation?.requires_confirmation === false)).toBe(true)
  })

  it('16. one group preserves while a sibling group does not (mismatched method)', () => {
    const prior: OverageTier[] = [
      overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated' }) }),
      overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'graduated' }) }),
    ]
    const fresh: OverageTier[] = [
      overageTier({ unit_type: 'API call', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }) }),
      overageTier({ unit_type: 'SMS reminder', tier_calculation: tierCalc({ method: 'volume', requires_confirmation: true }) }),
    ]
    const audit = [auditRow('API call', 'graduated'), auditRow('SMS reminder', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    const apiCall = result.find(t => t.unit_type === 'API call')
    const sms = result.find(t => t.unit_type === 'SMS reminder')
    expect(apiCall?.tier_calculation?.requires_confirmation).toBe(false) // preserved
    expect(sms?.tier_calculation?.requires_confirmation).toBe(true) // fresh method changed -> not preserved
  })

  it('live-data regression fixture: audit=prior=fresh all graduated across 3 independent jobs\' shape — review state preserved (17H.4B0D4B1B0C/.1\'s proven live shape, no customer data)', () => {
    const prior: OverageTier[] = [overageTier({ unit_type: 'metric', tier_calculation: tierCalc({ method: 'graduated' }) })]
    const fresh: OverageTier[] = [overageTier({ unit_type: 'metric', tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, confirmation_reason: 'placeholder' }) })]
    const audit = [auditRow('metric', 'graduated')]
    const result = preserveTierCalculationReviewState(prior, fresh, audit)
    expect(result[0].tier_calculation?.requires_confirmation).toBe(false)
    expect(result[0].tier_calculation?.confirmation_reason).toBeNull()
  })
})

describe('Step 17H.4B0D4B1B0E — preservation chain composes safely: preserveTierIdentity -> preserveTierCalculationReviewState -> buildLineItems', () => {
  it('22. identity continuity AND review-state preservation both survive into the built line item', () => {
    const prior: OverageTier[] = [overageTier({
      tier_id: 'tier-X', unit_type: 'API call', tier_label: 'Calls 1–10,000',
      tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: false }),
    })]
    // Fresh extraction: same structural fingerprint (unit_type/from_unit/
    // to_unit unchanged) but a brand new tier_id (Y) and requires_confirmation
    // reset to true — exactly what a real re-extraction pass produces before
    // either preservation helper runs.
    const freshFromExtraction: OverageTier[] = [overageTier({
      tier_id: 'tier-Y', unit_type: 'API call', tier_label: 'Calls 1–10,000',
      tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true, confirmation_reason: 'model unsure this pass' }),
    })]
    const audit = [auditRow('API call', 'graduated')]

    const afterIdentity = preserveTierIdentity(prior, freshFromExtraction)
    expect(afterIdentity[0].tier_id).toBe('tier-X') // identity continuity established

    const afterReviewState = preserveTierCalculationReviewState(prior, afterIdentity, audit)
    // The review-state helper must never accidentally revert/drop the ID
    // preserveTierIdentity already established.
    expect(afterReviewState[0].tier_id).toBe('tier-X')
    expect(afterReviewState[0].tier_calculation?.requires_confirmation).toBe(false)
    expect(afterReviewState[0].tier_calculation?.confirmation_reason).toBeNull()

    const terms = { currency: 'EUR', overage_tiers: afterReviewState } as unknown as ContractTerms
    const items = buildLineItems(terms, 'EUR') as Array<Record<string, unknown>>
    const tierRow = items.find(i => i.product_name === 'Calls 1–10,000')
    expect(tierRow?.tier_id).toBe('tier-X')
  })

  it('23. tier_id continuity survives with NO review evidence at all — identity preservation never depends on review-state preservation', () => {
    const prior: OverageTier[] = [overageTier({ tier_id: 'tier-X', unit_type: 'API call', tier_label: 'Calls 1–10,000' })]
    const freshFromExtraction: OverageTier[] = [overageTier({
      tier_id: 'tier-Y', unit_type: 'API call', tier_label: 'Calls 1–10,000',
      tier_calculation: tierCalc({ method: 'graduated', requires_confirmation: true }),
    })]

    const afterIdentity = preserveTierIdentity(prior, freshFromExtraction)
    expect(afterIdentity[0].tier_id).toBe('tier-X')

    const afterReviewState = preserveTierCalculationReviewState(prior, afterIdentity, []) // zero audit rows
    expect(afterReviewState[0].tier_id).toBe('tier-X') // unaffected by the absence of review evidence
    expect(afterReviewState[0].tier_calculation?.requires_confirmation).toBe(true) // untouched — extraction's own value stands

    const terms = { currency: 'EUR', overage_tiers: afterReviewState } as unknown as ContractTerms
    const items = buildLineItems(terms, 'EUR') as Array<Record<string, unknown>>
    const tierRow = items.find(i => i.product_name === 'Calls 1–10,000')
    expect(tierRow?.tier_id).toBe('tier-X')
  })
})

// Step 17H.4B0D4H1B4E3.4 — real live-reproduced defect: the identical
// NordicFit PDF, re-extracted, labeled the same clause "Success fee per
// completed payment" on one pass and "Per-completed payment success fee" on
// another. Structural fingerprint (semantic_input_key/billing_frequency/
// derived-metric shape), never product_name/description.
function recurringFee(overrides: Partial<AdditionalRecurringFee> = {}): AdditionalRecurringFee {
  return {
    recurring_fee_id: undefined, fee_label: 'Fee', amount: 0, description: null,
    metric_name: 'completed_payment', rate_per_unit: 1.7, semantic_input_key: 'completed_payment_count',
    billing_frequency: 'monthly',
    ...overrides,
  }
}

describe('preserveRecurringFeeIdentity — 17H.4B0D4H1B4E3.4 (typed structural fingerprint, tolerates AI wording drift)', () => {
  it('§21 — the real observed case: same semantic_input_key, wording drift alone -> identity preserved', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-abc', fee_label: 'Success fee per completed payment' })]
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1', fee_label: 'Per-completed payment success fee' })]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-abc')
  })

  it('§24 — rate change, same metric/cadence -> identity still preserved (rate is a mutable value, not identity, mirrors tier rate_per_unit exclusion)', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-abc', rate_per_unit: 1.7 })]
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1', rate_per_unit: 1.9 })]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-abc')
    expect(merged[0].rate_per_unit).toBe(1.9) // the corrected value is NOT overwritten
  })

  it('§23 — changed semantic metric -> NOT the same mechanism, no identity preserved', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-abc', semantic_input_key: 'completed_payment_count' })]
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1', semantic_input_key: 'issued_payment_request_count' })]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-fresh-1')
  })

  it('§22 — a genuinely NEW fee (different metric) does not inherit an existing fee\'s id merely because both are variable-rate, monthly', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-abc', semantic_input_key: 'completed_payment_count' })]
    const fresh = [
      recurringFee({ recurring_fee_id: 'rf-fresh-1', semantic_input_key: 'completed_payment_count' }), // same as before
      recurringFee({ recurring_fee_id: 'rf-fresh-2', semantic_input_key: 'issued_payment_request_count', fee_label: 'Per-issued payment request fee' }), // genuinely new
    ]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-abc') // preserved
    expect(merged[1].recurring_fee_id).toBe('rf-fresh-2') // stays its own fresh id — never borrows identity
  })

  it('§12/§25 — two fees sharing one semantic metric but otherwise identical typed fields fail closed (schema gap: no typed scope field exists to disambiguate them; label is deliberately never used to force a decision)', () => {
    const existing = [
      recurringFee({ recurring_fee_id: 'rf-a', fee_label: 'Product A fee' }),
      recurringFee({ recurring_fee_id: 'rf-b', fee_label: 'Product B fee' }),
    ]
    const fresh = [
      recurringFee({ recurring_fee_id: 'rf-fresh-a', fee_label: 'Product A fee (renamed)' }),
      recurringFee({ recurring_fee_id: 'rf-fresh-b', fee_label: 'Product B fee (renamed)' }),
    ]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    // Ambiguous cardinality (2 existing <-> 2 fresh sharing the identical
    // fingerprint) -> neither reuses an id. This is the CORRECT, safe
    // behavior given the current schema has no typed scope field beyond
    // metric/cadence/derived-shape — not a defect in this function.
    expect(merged[0].recurring_fee_id).toBe('rf-fresh-a')
    expect(merged[1].recurring_fee_id).toBe('rf-fresh-b')
  })

  it('a fixed fee (no metric) with only one candidate on each side still preserves identity through wording drift', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-fixed-1', fee_label: 'Support tier', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' })]
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1', fee_label: 'Support package', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' })]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-fixed-1')
  })

  it('§26 — two FIXED fees with the same cadence fail closed (reported schema limitation: fixed fees have almost no typed structure beyond billing_frequency)', () => {
    const existing = [
      recurringFee({ recurring_fee_id: 'rf-fixed-a', fee_label: 'Support tier', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' }),
      recurringFee({ recurring_fee_id: 'rf-fixed-b', fee_label: 'Onboarding fee', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' }),
    ]
    const fresh = [
      recurringFee({ recurring_fee_id: 'rf-fresh-a', fee_label: 'Support package', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' }),
      recurringFee({ recurring_fee_id: 'rf-fresh-b', fee_label: 'Onboarding package', metric_name: null, rate_per_unit: null, semantic_input_key: null, billing_frequency: 'monthly' }),
    ]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-fresh-a')
    expect(merged[1].recurring_fee_id).toBe('rf-fresh-b')
  })

  it('product_name/description alone never proves identity — a byte-identical label on a structurally DIFFERENT mechanism does not inherit the old id', () => {
    const existing = [recurringFee({ recurring_fee_id: 'rf-abc', fee_label: 'Usage fee', semantic_input_key: 'completed_payment_count', billing_frequency: 'monthly' })]
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1', fee_label: 'Usage fee', semantic_input_key: 'issued_payment_request_count', billing_frequency: 'quarterly' })]
    const merged = preserveRecurringFeeIdentity(existing, fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-fresh-1')
  })

  it('no prior fee exists -> fresh fee keeps its own freshly-assigned id', () => {
    const fresh = [recurringFee({ recurring_fee_id: 'rf-fresh-1' })]
    const merged = preserveRecurringFeeIdentity([], fresh)
    expect(merged[0].recurring_fee_id).toBe('rf-fresh-1')
  })
})
