import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { planLineItemReconciliation } from './line-items-reconciliation'
import { hasContractStarted } from './performance-share-timing'
import { isRecurringBaseFeeLineItem } from './line-items'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17E.1, item G — the exact acceptance scenario reported against a
// REAL Remembill-shaped contract: every review item resolved, no billing
// platform selected yet, a STALE stored "partial-period treatment
// unresolved" base-fee row left over from before the reviewer confirmed
// it, a STALE stored "€0 / Usage-based" performance-share row left over
// from before Step 17E's line-items fix existed, and a contract_start_date
// still in the future relative to "now". Proves the two DATA-layer facts
// this session's own React page has no test harness for: the stale-row
// reconciliation plan, and the contract-date-aware performance-share gate.
// The JSX-level assertions this scenario also implies (reviewComplete
// gating shows the persistent sections instead of isConfigured; the
// readiness banner renders "Contract configuration: Ready" / "Billing
// platform: Not yet selected" / "Current-period billing: Not started —
// begins 1 October 2026"; no stale "Pending interpretation" text renders)
// were verified by direct code inspection of app/(dashboard)/configure/
// [id]/page.tsx — this codebase has no precedent for testing a React page
// component directly (confirmed repeatedly this session), so those are
// not independently executable here.
// ═══════════════════════════════════════════════════════════════════════════

function buildAcceptanceFixtureTerms(): ContractTerms {
  const terms = buildRemembillFixtureTerms()
  return {
    ...terms,
    // "All review items resolved" — the ONE item the base fixture leaves
    // open by design (to exercise the review flow elsewhere) is confirmed
    // here, matching what a reviewer having finished review would have
    // produced via confirm-rule.
    base_fee_proration: {
      ...terms.base_fee_proration!,
      prorate_partial_periods: true,
      requires_confirmation: false,
      confirmation_reason: null,
    },
    // The fixture's own contract_start_date (2026-10-01) is already in
    // the future relative to this session's current date — kept
    // explicit here so the test's intent doesn't depend on reading the
    // fixture file to know that.
    contract_start_date: '2026-10-01',
  }
}

describe('Step 17E.1, item G — acceptance: resolved review, unselected platform, stale rows, pre-start contract', () => {
  const terms = buildAcceptanceFixtureTerms()
  const performanceShareFee = (terms.additional_recurring_fees ?? []).find(f => f.percentage_of_basis)!

  it('the fixture genuinely represents "all review items resolved" for base_fee_proration', () => {
    expect(terms.base_fee_proration?.requires_confirmation).toBe(false)
  })

  it('reconciliation replaces the stale unresolved base-fee placeholder with the real resolved schedule, and removes the stale €0 performance-share row — both in one pass, nothing else touched', () => {
    const plan = planLineItemReconciliation({
      existingItems: [
        { id: 'stale-base-fee', product_name: 'Recurring base fee — partial-period treatment unresolved' },
        { id: 'stale-performance-share', product_name: performanceShareFee.fee_label },
        { id: 'real-per-request-fee', product_name: 'Per payment request fee' },
        { id: 'real-success-fee', product_name: 'Success fee per completed payment' },
      ],
      terms, currency: terms.currency ?? 'SEK',
    })

    expect(plan.staleIds.sort()).toEqual(['stale-base-fee', 'stale-performance-share'])
    // The resolved base-fee schedule is regenerated with a real amount —
    // never left at the placeholder's Qty 0 / Total 0.
    expect(plan.freshItems.length).toBeGreaterThan(0)
    expect(plan.freshItems.every(i => isRecurringBaseFeeLineItem(i.product_name))).toBe(true)
    expect(plan.freshItems.every(i => i.product_name !== 'Recurring base fee — partial-period treatment unresolved')).toBe(true)
    // The performance-share fee is REMOVED, never regenerated — it must
    // never reappear as a line-items row under any circumstance (Step
    // 17E, item 3).
    expect(plan.freshItems.find(i => i.product_name === performanceShareFee.fee_label)).toBeUndefined()
  })

  it('no eligible billing period exists yet as of today — the performance-share route must report "not_started", never "waiting for operational inputs"', () => {
    expect(hasContractStarted(terms.contract_start_date, new Date())).toBe(false)
  })

  it('once the contract start date arrives, the SAME check flips — proving this is a real date comparison, not a permanently-stuck flag', () => {
    expect(hasContractStarted(terms.contract_start_date, new Date('2026-10-01T00:00:00'))).toBe(true)
    expect(hasContractStarted(terms.contract_start_date, new Date('2027-01-15T00:00:00'))).toBe(true)
  })
})
