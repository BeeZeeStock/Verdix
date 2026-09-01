import { describe, it, expect } from 'vitest'
import { deriveVariableRateFeeLabels, pricingModelLabelFor, bomDisplayLabel } from './commercial-bom'

describe('deriveVariableRateFeeLabels — Step 17G.4B', () => {
  it('identifies a flat variable-rate fee (metric_name + rate_per_unit, no percentage_of_basis)', () => {
    const labels = deriveVariableRateFeeLabels([
      { fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request', rate_per_unit: 0.38 },
    ])
    expect(labels.has('Per-issued payment request fee')).toBe(true)
  })

  it('excludes a percentage_of_basis fee even if it also carries a metric_name', () => {
    const labels = deriveVariableRateFeeLabels([
      { fee_label: 'Performance share', metric_name: 'value_weighted_payment_rate', percentage_of_basis: {} },
    ])
    expect(labels.has('Performance share')).toBe(false)
  })

  it('excludes a fixed fee with no rate_per_unit', () => {
    const labels = deriveVariableRateFeeLabels([{ fee_label: 'Support add-on', rate_per_unit: null }])
    expect(labels.size).toBe(0)
  })

  it('handles null/undefined input safely', () => {
    expect(deriveVariableRateFeeLabels(null).size).toBe(0)
    expect(deriveVariableRateFeeLabels(undefined).size).toBe(0)
  })

  // The exact real Remembill shape — two flat usage fees identified, the
  // performance-based one and (implicitly, since it's not in this list at
  // all) the true fixed base fee excluded.
  it('the real Remembill additional_recurring_fees shape', () => {
    const labels = deriveVariableRateFeeLabels([
      { fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request', rate_per_unit: 0.38 },
      { fee_label: 'Per-completed payment success fee', metric_name: 'completed_payment', rate_per_unit: 1.70 },
      { fee_label: 'Performance share (resultatdel) — value-weighted payment rate', metric_name: 'value_weighted_payment_rate', percentage_of_basis: {} },
    ])
    expect(labels).toEqual(new Set(['Per-issued payment request fee', 'Per-completed payment success fee']))
  })
})

describe('pricingModelLabelFor — Step 17G.4B', () => {
  it('an overage tier is Usage-based', () => {
    expect(pricingModelLabelFor('overage_tier', false)).toBe('Usage-based')
  })

  it('a flat variable-rate fee is Usage-based even though classifyItem does not distinguish it from the fixed base fee', () => {
    expect(pricingModelLabelFor('some_default_kind', true)).toBe('Usage-based')
  })

  it('a one-time fee is One-time', () => {
    expect(pricingModelLabelFor('one_time', false)).toBe('One-time')
  })

  it('an escalator (resolved or unresolved) is Escalator', () => {
    expect(pricingModelLabelFor('escalator', false)).toBe('Escalator')
    expect(pricingModelLabelFor('escalator_interpretation', false)).toBe('Escalator')
  })

  it('everything else (the true fixed base fee) is Fixed recurring', () => {
    expect(pricingModelLabelFor('base_fee_proration', false)).toBe('Fixed recurring')
    expect(pricingModelLabelFor('anything_else', false)).toBe('Fixed recurring')
  })
})

describe('bomDisplayLabel — Step 17G.4C', () => {
  it('renames the plain base fee product_name to a business label', () => {
    expect(bomDisplayLabel('Recurring base fee')).toBe('Platform subscription')
  })

  it('renames the one-time-base-fee shape too', () => {
    expect(bomDisplayLabel('Base subscription')).toBe('Platform subscription')
  })

  // Step 17H.4B0D4H1B4E6 §6 — previously preserved as "Platform subscription
  // (periods 4–12)"; the periods substring is WHEN/HOW, not WHAT, and is
  // now dropped from the DISPLAY label (the persisted product_name/identity
  // marker this regex matches against is untouched — see the function's
  // own comment).
  it('drops the periods suffix on a multi-rate-block base fee — WHEN/HOW information, not WHAT', () => {
    expect(bomDisplayLabel('Recurring base fee (periods 4–12)')).toBe('Platform subscription')
  })

  // Step 17H.4B0D4H1B4E2.5 §7 — the BoM component NAME stays pure WHAT; an
  // unresolved-HOW fact (partial-period treatment) must never be appended
  // to it. The underlying persisted marker string (identity-critical for
  // Model B+ reconciliation) is untouched — only the display transform.
  it('cleans the unresolved-partial-period placeholder row to the plain component name — never appends unresolved-HOW state', () => {
    expect(bomDisplayLabel('Recurring base fee — partial-period treatment unresolved'))
      .toBe('Platform subscription')
  })

  it('strips a "Per-" prefix and trailing "fee" noun from a flat usage-rate label', () => {
    expect(bomDisplayLabel('Per-issued payment request fee')).toBe('Issued payment request')
  })

  it('strips a trailing "charge" noun too', () => {
    expect(bomDisplayLabel('Per-completed payment charge')).toBe('Completed payment')
  })

  it('leaves a label with no matching pattern completely untouched — never a guess', () => {
    expect(bomDisplayLabel('Extra payment requests above contracted volume of 5,000'))
      .toBe('Extra payment requests above contracted volume of 5,000')
  })

  it('leaves a parenthetical performance-share label untouched — dropping context would be a guess', () => {
    expect(bomDisplayLabel('Performance share (resultatdel) — value-weighted payment rate'))
      .toBe('Performance share (resultatdel) — value-weighted payment rate')
  })
})
