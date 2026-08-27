import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { buildLineItems } from './line-items'
import { validateRateSchedule } from './rate-schedule'
import { computePerformanceShareFee } from './performance-share-fee'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17C.1 — end-to-end wiring sanity against the REAL, persisted-shape
// Remembill fixture (not a locally re-typed copy) — proves the actual
// extraction output this step targets produces the correct commercial
// result, the same discipline every prior step's own step-NNNN.test.ts
// file already establishes for this fixture.
// ═══════════════════════════════════════════════════════════════════════════

describe('Step 17C.1 — buildLineItems no longer silently drops the performance-share fee', () => {
  it('the performance-share fee appears in the TCV preview at quantity 0 / total 0 — operational, unresolved, never invented', () => {
    const terms = buildRemembillFixtureTerms()
    const items = buildLineItems(terms, terms.currency ?? 'EUR')
    const perf = items.find(i => i.product_name === 'Performance share (value-weighted payment rate)')
    expect(perf).toBeDefined()
    expect(perf!.quantity).toBe(0)
    expect(perf!.total_amount).toBe(0)
  })
})

describe('Step 17C.1 — the Remembill fixture\'s own persisted schedule validates structurally', () => {
  it('validateRateSchedule accepts the fixture\'s real percentage_of_basis.rate_schedule', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    expect(validateRateSchedule(perf.percentage_of_basis!.rate_schedule)).toEqual({ valid: true })
  })
})

describe('Step 17C.1 — computePerformanceShareFee against the fixture\'s own persisted config (not a re-typed copy)', () => {
  it('paid €80,000 / total €100,000 → €3,550, using percentage_of_basis exactly as buildRemembillFixtureTerms() produces it (no pilot interference)', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    const result = computePerformanceShareFee({
      config: perf.percentage_of_basis!,
      inputs: { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: 100_000 },
      discounts: null,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
    })
    expect(result).toMatchObject({ status: 'ready', amount: 3550 })
  })

  it('the fixture\'s own pilot discount (base_recurring_fee definite, performance_fee still only possible) blocks readiness while unresolved, for a period INSIDE the 90-day pilot window', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    const result = computePerformanceShareFee({
      config: perf.percentage_of_basis!,
      inputs: { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: 100_000 },
      discounts: terms.discounts, // pilot-waiver's possibly_affected_components still includes performance_fee, unconfirmed
      periodStart: '2026-10-15', periodEnd: '2026-11-14', // fixture pilot: 2026-10-01 + 90 days
    })
    expect(result.status).toBe('not_ready')
  })

  it('Step 17C.1a — the SAME unresolved pilot discount does NOT block a period fully after the 90-day pilot window (period-aware fix)', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    const result = computePerformanceShareFee({
      config: perf.percentage_of_basis!,
      inputs: { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: 100_000 },
      discounts: terms.discounts,
      periodStart: '2027-03-01', periodEnd: '2027-03-31',
    })
    expect(result).toMatchObject({ status: 'ready', amount: 3550 })
  })
})
