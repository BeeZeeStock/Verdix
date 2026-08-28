import { describe, it, expect } from 'vitest'
import { planLineItemReconciliation } from './line-items-reconciliation'
import type { ContractTerms } from './types'

function baseTerms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    customer_name: 'Test AB', currency: 'EUR', one_time_fees: [],
    discounts: [], service_credits: [], overage_tiers: [], escalators: [],
    additional_recurring_fees: [],
    ...overrides,
  } as ContractTerms
}

describe('planLineItemReconciliation — Step 17E.1, items C/D', () => {
  it('item C: a stale unresolved base-fee placeholder is replaced with the real computed schedule once the policy is confirmed', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
    })
    const plan = planLineItemReconciliation({
      existingItems: [
        { id: 'stale-1', product_name: 'Recurring base fee — partial-period treatment unresolved' },
        { id: 'unrelated-1', product_name: 'Included SMS reminders 1–500' },
      ],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds).toEqual(['stale-1'])
    expect(plan.freshItems.length).toBeGreaterThan(0)
    expect(plan.freshItems.every(i => i.product_name !== 'Recurring base fee — partial-period treatment unresolved')).toBe(true)
    expect(plan.freshItems.some(i => i.total_amount > 0)).toBe(true)
  })

  it('item C: does nothing when the placeholder is present but the policy is STILL genuinely unresolved', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: 'unclear', requires_confirmation: true, confirmation_reason: 'still open' },
    })
    const plan = planLineItemReconciliation({
      existingItems: [{ id: 'legit-1', product_name: 'Recurring base fee — partial-period treatment unresolved' }],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds).toEqual([])
    expect(plan.freshItems).toEqual([])
  })

  it('item C: does nothing when no placeholder row exists at all — never regenerates an already-correct schedule', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
    })
    const plan = planLineItemReconciliation({
      existingItems: [{ id: 'already-correct', product_name: 'Recurring base fee' }],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds).toEqual([])
  })

  it('item D: a stale percentage_of_basis €0 row is removed, keyed to the typed fee (not a bare label heuristic on the row itself)', () => {
    const terms = baseTerms({
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    })
    const plan = planLineItemReconciliation({
      existingItems: [
        { id: 'stale-perf-share', product_name: 'Performance share' },
        { id: 'unrelated-tier', product_name: 'Included SMS reminders 1–500' },
      ],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds).toEqual(['stale-perf-share'])
    // Never regenerated — percentage_of_basis fees never belong in line_items at all.
    expect(plan.freshItems.find(i => i.product_name === 'Performance share')).toBeUndefined()
  })

  it('item D: a row that merely SHARES a label with something else, but has no percentage_of_basis fee behind it, is left untouched', () => {
    const terms = baseTerms({
      additional_recurring_fees: [{ fee_label: 'Performance share', amount: 500, description: null }],
    })
    const plan = planLineItemReconciliation({
      existingItems: [{ id: 'real-fee', product_name: 'Performance share' }],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds).toEqual([])
  })

  it('unrelated/manual reviewer-edited rows are never touched by either reconciliation', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    })
    const plan = planLineItemReconciliation({
      existingItems: [
        { id: 'stale-base-fee', product_name: 'Recurring base fee — partial-period treatment unresolved' },
        { id: 'stale-perf-share', product_name: 'Performance share' },
        { id: 'manual-overage-correction', product_name: 'SMS reminders 501–2,000 — overage' },
        { id: 'one-time-fee', product_name: 'Implementation fee' },
      ],
      terms, currency: 'EUR',
    })
    expect(plan.staleIds.sort()).toEqual(['stale-base-fee', 'stale-perf-share'])
  })
})

describe('planLineItemReconciliation — Step 17E.2, item 1 (GET read-only view application)', () => {
  // Mirrors EXACTLY what app/api/jobs/[id]/route.ts's GET handler now
  // does with the plan: filter out staleIds, splice in freshItems — pure,
  // in-memory, no DB write. Proves the resulting VIEW is correct (no
  // stale rows survive) and that repeating the exact same computation
  // produces the exact same result every time — i.e. nothing about this
  // computation depends on, or mutates, persisted state, which is the
  // property that makes "GET performs zero DB writes" true by
  // construction rather than merely by convention.
  it('applying the plan to the stored rows produces a view with no stale Pending-interpretation row and no stale performance-share row', () => {
    const terms = baseTerms({
      contract_start_date: '2026-01-01', contract_term_months: 12, billing_frequency: 'monthly',
      base_monthly_fee: 2000,
      base_fee_proration: { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null },
      additional_recurring_fees: [{
        fee_label: 'Performance share', amount: 0, description: null,
        percentage_of_basis: {
          derived_metric: {
            metric_key: 'value_weighted_payment_rate', operation: 'ratio',
            numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests',
            output_unit: 'percentage', min_output_value: 0, max_output_value: 100,
          },
          rate_schedule: { schedule_key: 'x', bands: [{ from: 0, to: null, rate_pct: 1 }], min_selector_value: 0, max_selector_value: 100 },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
      }],
    })
    const storedRows = [
      { id: 'stale-base-fee', product_name: 'Recurring base fee — partial-period treatment unresolved' },
      { id: 'stale-perf-share', product_name: 'Performance share' },
      { id: 'unrelated-tier', product_name: 'Included SMS reminders 1–500' },
    ]

    function applyPlanInMemory(rows: typeof storedRows) {
      const plan = planLineItemReconciliation({ existingItems: rows, terms, currency: 'EUR' })
      const staleIdSet = new Set(plan.staleIds)
      return [
        ...rows.filter(r => !staleIdSet.has(r.id)),
        ...plan.freshItems.map(item => ({ id: `ephemeral-${item.product_name}`, product_name: item.product_name })),
      ]
    }

    const view = applyPlanInMemory(storedRows)
    expect(view.some(r => r.product_name === 'Recurring base fee — partial-period treatment unresolved')).toBe(false)
    expect(view.some(r => r.product_name === 'Performance share')).toBe(false)
    expect(view.some(r => r.product_name === 'Included SMS reminders 1–500')).toBe(true) // untouched
    expect(view.some(r => r.product_name === 'Recurring base fee')).toBe(true) // regenerated, real schedule

    // Repeating the computation against the SAME (never-mutated) stored
    // rows produces an identical view every time — no hidden state, no
    // side effect accumulating across calls.
    const secondView = applyPlanInMemory(storedRows)
    expect(secondView).toEqual(view)
    const thirdView = applyPlanInMemory(storedRows)
    expect(thirdView).toEqual(view)
  })
})
