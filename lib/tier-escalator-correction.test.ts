import { describe, it, expect, vi } from 'vitest'
import {
  computeUpdatedOverageTiers, computeUpdatedEscalators, resolveTierLineItemAssociation, resolveTierForLineItem,
  parseTierRateInput, parseEscalatorPctInput, describeTierCorrectionError, describeEscalatorCorrectionError,
  persistTierRateCorrection, persistEscalatorPctCorrection, classifyTierCorrectionTarget,
} from './tier-escalator-correction'

describe('computeUpdatedOverageTiers — Step 17H.3D2', () => {
  const tiers = [
    { tier_label: 'Included', rate_per_unit: 0, from_unit: 0, to_unit: 500 },
    { tier_label: 'Overage', rate_per_unit: 0.6, from_unit: 501, to_unit: null },
  ]

  it('replaces only the entry at idx, preserving every other field on that tier', () => {
    const updated = computeUpdatedOverageTiers(tiers, 1, 0.75)
    expect(updated[1]).toEqual({ tier_label: 'Overage', rate_per_unit: 0.75, from_unit: 501, to_unit: null })
  })

  it('never mutates neighboring tiers — the first tier, middle tier, last tier cases', () => {
    const threeTiers = [
      { tier_label: 'A', rate_per_unit: 1 },
      { tier_label: 'B', rate_per_unit: 2 },
      { tier_label: 'C', rate_per_unit: 3 },
    ]
    expect(computeUpdatedOverageTiers(threeTiers, 0, 10).map(t => t.rate_per_unit)).toEqual([10, 2, 3])
    expect(computeUpdatedOverageTiers(threeTiers, 1, 20).map(t => t.rate_per_unit)).toEqual([1, 20, 3])
    expect(computeUpdatedOverageTiers(threeTiers, 2, 30).map(t => t.rate_per_unit)).toEqual([1, 2, 30])
  })

  it('two tiers with identical rates: editing one never changes the other', () => {
    const sameRate = [
      { tier_label: 'A', rate_per_unit: 0.5 },
      { tier_label: 'B', rate_per_unit: 0.5 },
    ]
    const updated = computeUpdatedOverageTiers(sameRate, 0, 0.99)
    expect(updated[0].rate_per_unit).toBe(0.99)
    expect(updated[1].rate_per_unit).toBe(0.5)
  })

  it('decimal rate and zero rate are both preserved exactly (zero is currently a valid rate)', () => {
    expect(computeUpdatedOverageTiers(tiers, 0, 0).map(t => t.rate_per_unit)).toEqual([0, 0.6])
    expect(computeUpdatedOverageTiers(tiers, 1, 0.0375).map(t => t.rate_per_unit)).toEqual([0, 0.0375])
  })

  it('does not mutate the input array (returns a new array)', () => {
    const original = [...tiers]
    computeUpdatedOverageTiers(tiers, 0, 999)
    expect(tiers).toEqual(original)
  })

  // Step 17H.4B0D4B1G, item 36/47 — tier_id must survive a rate correction
  // untouched: this is what makes the ID-first resolver's identity durable
  // across the correction it exists to support in the first place.
  it('tier_id survives a rate correction unchanged — the full-object spread preserves every other field', () => {
    const withId = [{ tier_label: 'Overage', rate_per_unit: 10, tier_id: 'tier-abc-123' }]
    const updated = computeUpdatedOverageTiers(withId, 0, 12)
    expect(updated[0]).toEqual({ tier_label: 'Overage', rate_per_unit: 12, tier_id: 'tier-abc-123' })
  })
})

describe('computeUpdatedEscalators — Step 17H.3D2', () => {
  it('replaces only the entry at idx, preserving every other field', () => {
    const escalators = [
      { escalator_type: 'fixed_pct', escalator_pct: 3, description: 'Annual' },
      { escalator_type: 'CPI', escalator_pct: null, description: 'CPI-linked' },
    ]
    const updated = computeUpdatedEscalators(escalators, 1, 4.5)
    expect(updated[1]).toEqual({ escalator_type: 'CPI', escalator_pct: 4.5, description: 'CPI-linked' })
    expect(updated[0]).toEqual(escalators[0])
  })

  it('several escalators with the same percentage: editing one never changes the others', () => {
    const same = [
      { escalator_pct: 3 }, { escalator_pct: 3 }, { escalator_pct: 3 },
    ]
    const updated = computeUpdatedEscalators(same, 1, 5)
    expect(updated.map(e => e.escalator_pct)).toEqual([3, 5, 3])
  })

  it('decimal percentage preserved exactly', () => {
    const escalators = [{ escalator_pct: 0 }]
    expect(computeUpdatedEscalators(escalators, 0, 2.75)[0].escalator_pct).toBe(2.75)
  })

  it('does not mutate the input array', () => {
    const escalators = [{ escalator_pct: 3 }]
    const original = [...escalators]
    computeUpdatedEscalators(escalators, 0, 99)
    expect(escalators).toEqual(original)
  })
})

// Step 17H.4B0D4B1G — the canonical FORWARD resolver: given the line item
// being edited (its own tier_id, if any, plus product_name as the
// transitional fallback), find the ONE authoritative
// contract_terms.overage_tiers[] entry it corresponds to. Test numbering
// below follows the 17H.4B0D4B1G task's own §42 matrix verbatim.
describe('resolveTierForLineItem — Step 17H.4B0D4B1G (ID-first, cardinality-aware, bidirectional-preflight forward resolver)', () => {
  it('1. line A + one authoritative A: matched by tier_id, regardless of label', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'Some other label entirely' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Whatever the line item is called' }, tiers)
    expect(result).toEqual({ status: 'matched', tier: tiers[0], index: 0, match_mode: 'tier_id' })
  })

  it('2. line A + multiple authoritative A: ambiguous — never chosen by index/label/rate/bounds', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'X' }, { tier_id: 'A', tier_label: 'Y' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'X' }, tiers)
    expect(result.status).toBe('ambiguous')
  })

  it('3. line A + no authoritative A + unique label match with a DIFFERENT real id B: integrity_conflict, never label fallback', () => {
    const tiers = [{ tier_id: 'B', tier_label: 'Overage' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Overage' }, tiers)
    expect(result.status).toBe('integrity_conflict')
  })

  it('4. line A + no authoritative A + unique label match with tier_id NULL: integrity_conflict — nothing in this pipeline regresses an assigned tier_id back to null', () => {
    const tiers = [{ tier_id: null, tier_label: 'Overage' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Overage' }, tiers)
    expect(result.status).toBe('integrity_conflict')
  })

  it('5. line A + one A + a different, fully-identified sibling B sharing the same label: matched A — a different explicit identity is not ambiguity about A', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'Overage' }, { tier_id: 'B', tier_label: 'Overage' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Overage' }, tiers)
    expect(result).toEqual({ status: 'matched', tier: tiers[0], index: 0, match_mode: 'tier_id' })
  })

  it('6. line A + one A + an UNIDENTIFIED (null) sibling sharing the same label: ambiguous — the null tier could be a stale duplicate of A', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'Overage' }, { tier_id: null, tier_label: 'Overage' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Overage' }, tiers)
    expect(result.status).toBe('ambiguous')
  })

  it('7. line NULL + unique label match (also NULL): legacy match — 100% of live production data today', () => {
    const tiers = [{ tier_id: null, tier_label: 'Issued payment request' }]
    const result = resolveTierForLineItem({ tierId: null, productName: 'issued payment request' }, tiers)
    expect(result).toEqual({ status: 'matched', tier: tiers[0], index: 0, match_mode: 'legacy_label' })
  })

  it('8. line NULL + unique label match on a MODERN tier (tier_id A): legacy match — the line item carries no contradictory identity of its own', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'Issued payment request' }]
    const result = resolveTierForLineItem({ tierId: null, productName: 'Issued payment request' }, tiers)
    expect(result).toEqual({ status: 'matched', tier: tiers[0], index: 0, match_mode: 'legacy_label' })
  })

  it('9. line NULL + multiple label candidates: ambiguous, their tier_id states do not matter', () => {
    const tiers = [{ tier_id: null, tier_label: 'Overage' }, { tier_id: 'X', tier_label: 'Overage' }]
    const result = resolveTierForLineItem({ tierId: null, productName: 'Overage' }, tiers)
    expect(result.status).toBe('ambiguous')
  })

  it('10. no ID match and no label candidate: missing — distinct from explicit disagreement', () => {
    const tiers = [{ tier_id: null, tier_label: 'Unrelated metric' }]
    const result = resolveTierForLineItem({ tierId: null, productName: 'Something else entirely' }, tiers)
    expect(result).toEqual({ status: 'missing' })
  })

  it('11. positive ID match despite total label/product_name mismatch: matched — the desired label independence', () => {
    const tiers = [{ tier_id: 'A', tier_label: 'New label after correction' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Old label from before' }, tiers)
    expect(result).toEqual({ status: 'matched', tier: tiers[0], index: 0, match_mode: 'tier_id' })
  })

  it('12. unrelated tiers (no id or label evidence at all) are ignored, never accidentally matched', () => {
    const tiers = [{ tier_id: 'unrelated-1', tier_label: 'Unrelated one' }, { tier_id: 'unrelated-2', tier_label: 'Unrelated two' }]
    const result = resolveTierForLineItem({ tierId: 'A', productName: 'Something entirely different' }, tiers)
    expect(result).toEqual({ status: 'missing' })
  })

  it('a tier with no tier_label never matches anything by label', () => {
    const result = resolveTierForLineItem({ tierId: null, productName: 'Calls 1–10,000' }, [{ tier_id: null, tier_label: null }])
    expect(result).toEqual({ status: 'missing' })
  })

  it('matches through the same suffix stripping the BoM/render side uses ("— overage" / "— included in base fee")', () => {
    const tiers = [{ tier_id: null, tier_label: 'Calls 1–10,000' }]
    expect(resolveTierForLineItem({ tierId: null, productName: 'Calls 1–10,000 — overage' }, tiers).status).toBe('matched')
    expect(resolveTierForLineItem({ tierId: null, productName: 'Calls 1–10,000 — included in base fee' }, tiers).status).toBe('matched')
  })

  it('several bands for the same metric: each resolves to its own distinct index via id, none collide', () => {
    const tiers = [
      { tier_id: 'band-a', tier_label: 'Band A' }, { tier_id: 'band-b', tier_label: 'Band B' },
      { tier_id: 'band-c', tier_label: 'Band C' }, { tier_id: 'band-d', tier_label: 'Band D' },
    ]
    expect(resolveTierForLineItem({ tierId: 'band-a', productName: 'Band A' }, tiers)).toMatchObject({ status: 'matched', index: 0 })
    expect(resolveTierForLineItem({ tierId: 'band-c', productName: 'Band C' }, tiers)).toMatchObject({ status: 'matched', index: 2 })
  })
})

// Step 17H.4B0D4B1G — the canonical REVERSE resolver: given the authoritative
// tier persistTierRateCorrection just forward-resolved, find the ONE
// current, structurally-eligible line item that represents it. Test
// numbering follows the task's own §43 matrix verbatim. `eligible` items
// below always satisfy the classification doctrine (non-one_time, non-base-
// fee marker, quantity === 0) unless a test is specifically proving that
// doctrine excludes a row.
describe('resolveTierLineItemAssociation — Step 17H.4B0D4B1G (ID-first, cardinality-aware reverse resolver)', () => {
  const eligible = (overrides: Partial<{ id: string; product_name: string; tier_id: string | null }>) => ({
    id: 'x', product_name: 'x', billing_period: 'monthly', quantity: 0, tier_id: null, ...overrides,
  })

  it('1. tier A + exactly one eligible line item with tier_id A: matched', () => {
    const items = [eligible({ id: 'a', product_name: 'Overage', tier_id: 'A' })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result).toEqual({ status: 'matched', item: items[0], match_mode: 'tier_id' })
  })

  it('2. tier A + multiple eligible lines with tier_id A: ambiguous — the operational set itself is duplicated, zero writes even if a reviewer picked one', () => {
    const items = [eligible({ id: 'a', tier_id: 'A' }), eligible({ id: 'b', tier_id: 'A' })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result.status).toBe('ambiguous')
  })

  it('3. tier A + line A + an UNIDENTIFIED (null) same-label line: ambiguous — the unidentified row could be a stale representation of A', () => {
    const items = [eligible({ id: 'a', product_name: 'Overage', tier_id: 'A' }), eligible({ id: 'b', product_name: 'Overage', tier_id: null })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result.status).toBe('ambiguous')
  })

  it('4. tier A + line A + a different, fully-identified sibling B sharing the same label: matched A', () => {
    const items = [eligible({ id: 'a', product_name: 'Overage', tier_id: 'A' }), eligible({ id: 'b', product_name: 'Overage', tier_id: 'B' })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result).toEqual({ status: 'matched', item: items[0], match_mode: 'tier_id' })
  })

  it('5. tier A + no current line A + exactly one unique-label candidate with tier_id NULL: LEGACY MATCH — expected transitional state (authoritative modernized before this line item was regenerated)', () => {
    const items = [eligible({ id: 'legacy', product_name: 'Overage', tier_id: null })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result).toEqual({ status: 'matched', item: items[0], match_mode: 'legacy_label' })
  })

  it('6. tier A + no current line A + unique-label candidate with a DIFFERENT real id B: integrity_conflict, never label fallback across explicit disagreement', () => {
    const items = [eligible({ id: 'b', product_name: 'Overage', tier_id: 'B' })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result.status).toBe('integrity_conflict')
  })

  it('7. tier NULL (legacy authority) + unique NULL-label candidate: legacy match — the existing normalized cardinality-aware bridge, unchanged behavior', () => {
    const items = [eligible({ id: 'a', product_name: 'Issued payment request', tier_id: null })]
    const result = resolveTierLineItemAssociation({ tierId: null, tierLabel: 'issued payment request' }, items)
    expect(result).toEqual({ status: 'matched', item: items[0], match_mode: 'legacy_label' })
  })

  it('8. tier NULL + the only matching-label line item is already identified (non-null tier_id): integrity_conflict — an unidentified authority cannot safely claim an identified operational row', () => {
    const items = [eligible({ id: 'a', product_name: 'Overage', tier_id: 'A' })]
    const result = resolveTierLineItemAssociation({ tierId: null, tierLabel: 'Overage' }, items)
    expect(result.status).toBe('integrity_conflict')
  })

  it('9. tier NULL + multiple matching-label candidates: ambiguous', () => {
    const items = [eligible({ id: 'a', product_name: 'Overage' }), eligible({ id: 'b', product_name: 'Overage — overage' })]
    const result = resolveTierLineItemAssociation({ tierId: null, tierLabel: 'Overage' }, items)
    expect(result.status).toBe('ambiguous')
  })

  it('10. no match at all: missing', () => {
    const items = [eligible({ id: 'a', product_name: 'Completed payment' })]
    const result = resolveTierLineItemAssociation({ tierId: null, tierLabel: 'Something unrelated' }, items)
    expect(result).toEqual({ status: 'missing' })
  })

  it('11. positive ID match despite total label mismatch: matched', () => {
    const items = [eligible({ id: 'a', product_name: 'A totally different display label', tier_id: 'A' })]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result).toEqual({ status: 'matched', item: items[0], match_mode: 'tier_id' })
  })

  it('12. non-tier rows carrying the target tier_id are excluded before any matching happens — classification doctrine wins over a corrupt tier_id', () => {
    const items = [
      { id: 'one-time', product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, tier_id: 'A' },
      { id: 'base-fee', product_name: 'Recurring base fee', billing_period: 'monthly', quantity: 12, tier_id: 'A' },
      { id: 'nonzero', product_name: 'Overage', billing_period: 'monthly', quantity: 5, tier_id: 'A' },
    ]
    const result = resolveTierLineItemAssociation({ tierId: 'A', tierLabel: 'Overage' }, items)
    expect(result).toEqual({ status: 'missing' })
  })

  it('same metric feeding several mechanisms via substring-equivalent label match: still ambiguous when more than one eligible row qualifies (legacy behavior preserved)', () => {
    const items = [eligible({ id: 'flat', product_name: 'Issued payment request' }), eligible({ id: 'overage', product_name: 'Issued payment request — overage' })]
    const result = resolveTierLineItemAssociation({ tierId: null, tierLabel: 'Issued payment request' }, items)
    expect(result.status).toBe('ambiguous')
  })
})

// Step 17H.4B0D1.1 — write-safe routing must never be decided by display
// text. Every fixture below uses the exact shapes lib/line-items.ts's
// buildLineItems actually produces, not artificial objects — including the
// genuinely-reachable collision (a variable-rate additional_recurring_fee
// also gets quantity: 0, with an arbitrary label).
describe('classifyTierCorrectionTarget — Step 17H.4B0D1.1', () => {
  const tiers = [{ tier_label: 'Additional requests' }, { tier_label: 'Calls 1–10,000' }]

  it('a genuine tier with an innocuous label routes to tier, despite containing no "tier"/"overage" words', () => {
    const item = { product_name: 'Additional requests', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'tier', idx: 0 })
  })

  it('a genuine tier still routes correctly when it has an "— overage" suffix', () => {
    const item = { product_name: 'Calls 1–10,000 — overage', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'tier', idx: 1 })
  })

  it('"Overage support package" (non-zero quantity, real service row) never routes to tier merely from its label', () => {
    const item = { product_name: 'Overage support package', billing_period: 'monthly', quantity: 3 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('"Tier migration service" as a one-time fee never routes to tier — billing_period excludes it structurally, regardless of the word "Tier"', () => {
    const item = { product_name: 'Tier migration service', billing_period: 'one_time', quantity: 1 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('"Premium overage onboarding" as a one-time fee never routes to tier, including the parked (quantity 0) shape', () => {
    const item = { product_name: 'Premium overage onboarding', billing_period: 'one_time', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('the recurring-base-fee placeholder marker string never routes to tier, even at quantity 0', () => {
    const item = { product_name: 'Recurring base fee — partial-period treatment unresolved', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('the escalator structural row (quantity: 1, per buildLineItems) never routes to tier', () => {
    const item = { product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('a genuinely reachable structural collision — a variable-rate additional_recurring_fee also has quantity 0 — is uncertain, never guessed as tier', () => {
    const item = { product_name: 'Excess API overage', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'uncertain', reason: 'no_structural_match' })
  })

  it('a quantity-0 row whose label matches two tiers with identical labels is uncertain (ambiguous), never picks one', () => {
    const ambiguousTiers = [{ tier_label: 'Overage' }, { tier_label: 'Overage' }]
    const item = { product_name: 'Overage', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, ambiguousTiers)).toEqual({ target: 'uncertain', reason: 'ambiguous_structural_match' })
  })

  it('an unknown legacy row with no structural evidence either way is uncertain, not silently routed', () => {
    const item = { product_name: 'Some unclassified line', billing_period: 'monthly', quantity: 0 }
    expect(classifyTierCorrectionTarget(item, [])).toEqual({ target: 'uncertain', reason: 'no_structural_match' })
  })

  it('a base-fee row (non-zero quantity, unrelated label) routes to non_tier', () => {
    const item = { product_name: 'Recurring base fee', billing_period: 'monthly', quantity: 12 }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  // Step 17H.4B0D4B1G, §45 — a corrupt/stray tier_id must never override
  // family classification. Classification is decided ENTIRELY from
  // billing_period/base-fee-marker/quantity, before tier_id is ever
  // consulted.
  it('a one-time row carrying a tier_id is still non_tier', () => {
    const item = { product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, tier_id: 'stray-tier-id' }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('the recurring-base-fee marker row carrying a tier_id is still non_tier', () => {
    const item = { product_name: 'Recurring base fee', billing_period: 'monthly', quantity: 12, tier_id: 'stray-tier-id' }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  it('a non-zero-quantity row carrying a tier_id is still non_tier', () => {
    const item = { product_name: 'Additional requests', billing_period: 'monthly', quantity: 3, tier_id: 'stray-tier-id' }
    expect(classifyTierCorrectionTarget(item, tiers)).toEqual({ target: 'non_tier' })
  })

  // Step 17H.4B0D4B1G — new integrity_conflict routing, kept distinct from
  // plain ambiguity: the line item's own tier_id doesn't match any
  // authoritative tier, and the only label-based candidate carries
  // contradicting identity evidence.
  it('an integrity conflict (line has a tier_id no authoritative tier shares, unique label match with a different real id) routes to uncertain/integrity_conflict', () => {
    const conflicting = [{ tier_id: 'B', tier_label: 'Additional requests' }]
    const item = { product_name: 'Additional requests', billing_period: 'monthly', quantity: 0, tier_id: 'A' }
    expect(classifyTierCorrectionTarget(item, conflicting)).toEqual({ target: 'uncertain', reason: 'integrity_conflict' })
  })

  it('a positive tier_id match succeeds even when the label has since changed — label independence, decoupled from the tier_calculation display text', () => {
    const modern = [{ tier_id: 'A', tier_label: 'Brand new label after a rate correction' }]
    const item = { product_name: 'Old label the line item still shows', billing_period: 'monthly', quantity: 0, tier_id: 'A' }
    expect(classifyTierCorrectionTarget(item, modern)).toEqual({ target: 'tier', idx: 0 })
  })
})

describe('describeTierCorrectionError / describeEscalatorCorrectionError — Step 17H.4A', () => {
  it('maps every non-success tier result to a compact, truthful message — never a raw DB error', () => {
    expect(describeTierCorrectionError({ status: 'missing_association' })).toBe('This tier could not be matched safely to its billing line item.')
    expect(describeTierCorrectionError({ status: 'ambiguous_association', candidateCount: 2 })).toBe('Multiple billing line items match this tier. The correction was not applied.')
    expect(describeTierCorrectionError({ status: 'integrity_conflict' })).toBe('The billing item identity conflicts with the current contract tier. Refresh or review the configuration before correcting this rate.')
    expect(describeTierCorrectionError({ status: 'failed' })).toBe('Could not save the corrected rate. No change was confirmed.')
    expect(describeTierCorrectionError({ status: 'partial_failure' })).toBe('The correction was only partially applied. Billing configuration needs review.')
  })

  it('escalator failure message is compact and generic', () => {
    expect(describeEscalatorCorrectionError()).toBe('Could not save the corrected rate. No change was confirmed.')
  })
})

describe('parseTierRateInput — Step 17H.3D2 (byte-for-byte the old saveTierRate parsing)', () => {
  it('parses a plain decimal', () => {
    expect(parseTierRateInput('0.6')).toBe(0.6)
  })

  it('treats a comma as a decimal point (European input)', () => {
    expect(parseTierRateInput('0,035')).toBe(0.035)
  })

  it('strips currency symbols and stray characters', () => {
    expect(parseTierRateInput('SEK 0.60')).toBe(0.6)
  })

  it('zero is valid, not rejected', () => {
    expect(parseTierRateInput('0')).toBe(0)
  })

  it('negative sign is stripped, not preserved (existing behavior — negative tier rates are not currently representable via this input)', () => {
    expect(parseTierRateInput('-5')).toBe(5)
  })

  it('unparseable input returns null, never NaN', () => {
    expect(parseTierRateInput('')).toBeNull()
    expect(parseTierRateInput('abc')).toBeNull()
  })
})

describe('parseEscalatorPctInput — Step 17H.3D2 (byte-for-byte the old saveEscalatorPct parsing)', () => {
  it('parses a plain decimal', () => {
    expect(parseEscalatorPctInput('3.5')).toBe(3.5)
  })

  it('does NOT support comma as a decimal separator — a genuine, pre-existing validation-parity gap versus tier rate, preserved not fixed', () => {
    // The comma is stripped entirely (not translated to a dot), so
    // "3,5" parses as "35", not 3.5 — documenting existing behavior.
    expect(parseEscalatorPctInput('3,5')).toBe(35)
  })

  it('zero is valid', () => {
    expect(parseEscalatorPctInput('0')).toBe(0)
  })

  it('negative sign is stripped', () => {
    expect(parseEscalatorPctInput('-2')).toBe(2)
  })

  it('unparseable input returns null, never NaN', () => {
    expect(parseEscalatorPctInput('')).toBeNull()
    expect(parseEscalatorPctInput('abc')).toBeNull()
  })
})

// Step 17H.4A — full write-sequence/response-handling coverage, the
// actual subject of this hardening pass. fetchImpl is injected so these
// run with no real network/DOM/database — a resolved Response with a
// controlled `ok`/`status`, or a rejected promise (simulating a network
// throw), stands in for the real fetch() the page performs.
function okResponse() { return { ok: true, status: 200 } as Response }
function statusResponse(status: number) { return { ok: false, status } as Response }

describe('persistTierRateCorrection — Step 17H.4A response handling, revised 17H.4B0D4B1G bidirectional preflight', () => {
  const lineItem = (overrides: Partial<{ id: string; product_name: string; tier_id: string | null }> = {}) => ({
    id: 'item-1', product_name: 'Overage', billing_period: 'monthly', quantity: 0, tier_id: 'tier-A', ...overrides,
  })
  const oneTier = [{ tier_id: 'tier-A', tier_label: 'Overage', rate_per_unit: 0.6 }]
  const oneTarget = lineItem()
  const oneLineItems = [oneTarget]

  it('terms 200 + line item 200: success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse())
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'success' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/jobs/job-1/terms', expect.objectContaining({ method: 'PATCH' }))
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/jobs/job-1/line-items', expect.objectContaining({ method: 'PATCH' }))
    // The line-item PATCH body carries the corrected rate, the
    // confidence_score: 1 mark, and (Step 17H.4B0D2) the reviewer-
    // correction metadata command — all in the one request.
    const body = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string)
    expect(body).toEqual({
      itemId: 'item-1',
      fields: { unit_price: 0.75, confidence_score: 1 },
      markReviewerCorrectedFields: ['unit_price'],
    })
  })

  it('terms 400: failed — no line-item request is ever made', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(statusResponse(400))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('terms 500: failed — same as 400, a non-2xx is never treated as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(statusResponse(500))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'failed' })
  })

  it('terms network throw: failed, indistinguishable from a checked non-2xx to the caller', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('network error'))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'failed' })
  })

  it('terms 200 + line-item 400: partial_failure — contract_terms already changed, never reported as plain "failed"', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(statusResponse(400))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'partial_failure' })
  })

  it('terms 200 + line-item 500: partial_failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(statusResponse(500))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'partial_failure' })
  })

  it('terms 200 + line-item network throw: partial_failure, never silently swallowed as success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new TypeError('network error'))
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: oneTarget, overageTiers: oneTier, lineItems: oneLineItems, rate: 0.75, fetchImpl,
    })
    expect(result).toEqual({ status: 'partial_failure' })
  })

  // Item 25 — preflight failure causes zero writes.
  it('missing forward association: zero fetch calls — contract_terms is never written when sync cannot be established', async () => {
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1',
      targetItem: lineItem({ product_name: 'Something unrelated', tier_id: null }),
      overageTiers: [{ tier_id: null, tier_label: 'Unmatched tier', rate_per_unit: 1 }],
      lineItems: [],
      rate: 2, fetchImpl,
    })
    expect(result).toEqual({ status: 'missing_association' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('ambiguous forward association (multiple matching tiers, legacy): zero fetch calls, never guesses which to sync', async () => {
    const fetchImpl = vi.fn()
    const ambiguousTiers = [{ tier_id: null, tier_label: 'Overage' }, { tier_id: null, tier_label: 'Overage' }]
    const result = await persistTierRateCorrection({
      jobId: 'job-1',
      targetItem: lineItem({ tier_id: null }),
      overageTiers: ambiguousTiers,
      lineItems: [lineItem({ tier_id: null })],
      rate: 2, fetchImpl,
    })
    expect(result).toEqual({ status: 'ambiguous_association', candidateCount: 2 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('missing tier_label evidence (legacy line, no id, no label match): zero fetch calls, blocked before any write', async () => {
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1',
      targetItem: lineItem({ tier_id: null }),
      overageTiers: [{ tier_id: null, rate_per_unit: 1 }],
      lineItems: oneLineItems,
      rate: 2, fetchImpl,
    })
    expect(result).toEqual({ status: 'missing_association' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Several tiers, identical rates, only the tier_id-targeted one is
  // resolved and written — proves ID-based targeting stays correct even
  // when rate values alone could never disambiguate the tiers, and even
  // though both tiers happen to share a label prefix.
  it('identical rates on multiple tiers: still resolves and writes the correct one by tier_id, never by rate value or array position', async () => {
    const tiers = [
      { tier_id: 'tier-A', tier_label: 'Tier A', rate_per_unit: 0.5 },
      { tier_id: 'tier-B', tier_label: 'Tier B', rate_per_unit: 0.5 },
    ]
    const items = [
      lineItem({ id: 'a', product_name: 'Tier A', tier_id: 'tier-A' }),
      lineItem({ id: 'b', product_name: 'Tier B', tier_id: 'tier-B' }),
    ]
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse()).mockResolvedValueOnce(okResponse())
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: items[1], overageTiers: tiers, lineItems: items, rate: 0.9, fetchImpl,
    })
    expect(result).toEqual({ status: 'success' })
    const body = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string)
    expect(body.itemId).toBe('b') // Tier B's own item, not Tier A's, despite the identical starting rate
    const termsBody = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)
    expect(termsBody.overage_tiers[1].rate_per_unit).toBe(0.9) // tier-B's own slot, index 1
    expect(termsBody.overage_tiers[0].rate_per_unit).toBe(0.5) // tier-A untouched
  })

  // Same metric consumed by multiple pricing mechanisms sharing a
  // normalized label (legacy, no tier_id anywhere) — end-to-end ambiguous,
  // never guesses which line item to sync. Legacy regression — this is
  // 100% of the live population as of this pass.
  it('same metric feeding several mechanisms (legacy): ambiguous end-to-end, never guesses which line item to sync', async () => {
    const tiers = [{ tier_id: null, tier_label: 'Issued payment request', rate_per_unit: 0.38 }]
    const items = [
      lineItem({ id: 'flat', product_name: 'Issued payment request', tier_id: null }),
      lineItem({ id: 'overage', product_name: 'Issued payment request — overage', tier_id: null }),
    ]
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: items[0], overageTiers: tiers, lineItems: items, rate: 0.5, fetchImpl,
    })
    expect(result.status).toBe('ambiguous_association')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Step 17H.4B0D4B1G, §44 — bidirectional preflight tests.
  it('1. forward matches tier A, reverse uniquely resolves to the SAME target row: proceeds to write', async () => {
    const target = lineItem({ id: 'item-1', tier_id: 'tier-A' })
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse()).mockResolvedValueOnce(okResponse())
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: oneTier, lineItems: [target], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'success' })
  })

  it('2. forward matches tier A, but the CURRENT line-item set has a duplicate tier_id A: zero writes', async () => {
    const target = lineItem({ id: 'item-1', tier_id: 'tier-A' })
    const duplicate = lineItem({ id: 'item-1-dup', tier_id: 'tier-A' })
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: oneTier, lineItems: [target, duplicate], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'ambiguous_association', candidateCount: 2 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('3. forward matches tier A, but reverse resolves to a DIFFERENT row than the one being edited: integrity_conflict, zero writes', async () => {
    // Forward resolves via tier_id A on the target; reverse then resolves
    // A -> the current line-item set. Constructed so reverse's own unique
    // match is a DIFFERENT row than targetItem (targetItem itself is
    // deliberately absent from lineItems, simulating operational drift).
    const target = lineItem({ id: 'item-1', tier_id: 'tier-A' })
    const otherRowWithSameId = lineItem({ id: 'item-OTHER', tier_id: 'tier-A' })
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: oneTier, lineItems: [otherRowWithSameId], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'integrity_conflict' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('4. forward legacy + reverse legacy unique: behaves identically to today (legacy regression)', async () => {
    const target = lineItem({ id: 'item-1', product_name: 'Additional requests', tier_id: null })
    const tiers = [{ tier_id: null, tier_label: 'Additional requests', rate_per_unit: 0.6 }]
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse()).mockResolvedValueOnce(okResponse())
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: tiers, lineItems: [target], rate: 0.9, fetchImpl,
    })
    expect(result).toEqual({ status: 'success' })
  })

  it('5. forward integrity_conflict short-circuits before reverse is ever consulted: zero writes', async () => {
    const target = lineItem({ id: 'item-1', tier_id: 'tier-A' })
    const conflictingTiers = [{ tier_id: 'tier-B', tier_label: 'Overage', rate_per_unit: 0.6 }]
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: conflictingTiers, lineItems: [target], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'integrity_conflict' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('6. forward ambiguous: zero writes', async () => {
    const target = lineItem({ id: 'item-1', tier_id: 'tier-A' })
    const duplicateAuthoritative = [
      { tier_id: 'tier-A', tier_label: 'Overage', rate_per_unit: 0.6 },
      { tier_id: 'tier-A', tier_label: 'Overage 2', rate_per_unit: 0.6 },
    ]
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: duplicateAuthoritative, lineItems: [target], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'ambiguous_association', candidateCount: 2 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('7. forward matches, reverse integrity_conflict (current line-item label match carries a different real id): zero writes', async () => {
    const target = lineItem({ id: 'item-1', product_name: 'Overage', tier_id: null })
    const tiers = [{ tier_id: null, tier_label: 'Overage', rate_per_unit: 0.6 }]
    const conflictingCurrentRow = lineItem({ id: 'other', product_name: 'Overage', tier_id: 'some-other-tier-id' })
    const fetchImpl = vi.fn()
    const result = await persistTierRateCorrection({
      jobId: 'job-1', targetItem: target, overageTiers: tiers, lineItems: [conflictingCurrentRow], rate: 0.8, fetchImpl,
    })
    expect(result).toEqual({ status: 'integrity_conflict' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('persistEscalatorPctCorrection — Step 17H.4A response handling', () => {
  const oneEscalator = [{ escalator_pct: 3 }]

  it('200: success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse())
    const result = await persistEscalatorPctCorrection({ jobId: 'job-1', escalators: oneEscalator, idx: 0, pct: 4, fetchImpl })
    expect(result).toEqual({ status: 'success' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/jobs/job-1/terms', expect.objectContaining({ method: 'PATCH' }))
  })

  it('400: failed, never treated as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(statusResponse(400))
    const result = await persistEscalatorPctCorrection({ jobId: 'job-1', escalators: oneEscalator, idx: 0, pct: 4, fetchImpl })
    expect(result).toEqual({ status: 'failed' })
  })

  it('500: failed', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(statusResponse(500))
    const result = await persistEscalatorPctCorrection({ jobId: 'job-1', escalators: oneEscalator, idx: 0, pct: 4, fetchImpl })
    expect(result).toEqual({ status: 'failed' })
  })

  it('network throw: failed, never silently swallowed', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('network error'))
    const result = await persistEscalatorPctCorrection({ jobId: 'job-1', escalators: oneEscalator, idx: 0, pct: 4, fetchImpl })
    expect(result).toEqual({ status: 'failed' })
  })

  it('several escalators: writes the full array with only the targeted idx changed', async () => {
    const escalators = [{ escalator_pct: 3 }, { escalator_pct: 5 }, { escalator_pct: 3 }]
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse())
    await persistEscalatorPctCorrection({ jobId: 'job-1', escalators, idx: 2, pct: 8, fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)
    expect(body.escalators.map((e: { escalator_pct: number }) => e.escalator_pct)).toEqual([3, 5, 8])
  })
})
