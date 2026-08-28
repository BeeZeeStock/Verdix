import { describe, it, expect } from 'vitest'
import { planFixedFeeBillingTimingReconciliation } from './fixed-fee-billing-timing-reconciliation'

describe('planFixedFeeBillingTimingReconciliation — Step 17F.4, item 2', () => {
  it('a monthly-fee contract with no fixed_fee_billing_timing at all gets the unconditional unresolved default', () => {
    const plan = planFixedFeeBillingTimingReconciliation({ base_monthly_fee: 2000 })
    expect(plan.needsBackfill).toBe(true)
    expect(plan.rule).toEqual({
      timing: 'unclear',
      requires_confirmation: true,
      confirmation_reason: 'The agreement does not state whether the recurring fixed fee is invoiced at the beginning or the end of its billing period.',
      source_clause: null,
    })
  })

  it('never infers bill_at_period_start — the backfilled rule is always unclear regardless of any other field', () => {
    const plan = planFixedFeeBillingTimingReconciliation({
      base_monthly_fee: 5000,
      // These must never influence the outcome (item 2's explicit
      // constraint) — planned-invoice dates/scheduler behavior/cadence/
      // payment terms are not represented as inputs to this function at
      // all, by construction; this test documents that even fields which
      // ARE accepted (base_fee_proration.source_clause) only ever feed
      // source_clause, never the timing value itself.
      base_fee_proration: { source_clause: 'Fees are billed monthly. Payment due within 30 days.' },
    })
    expect(plan.rule?.timing).toBe('unclear')
    expect(plan.rule?.source_clause).toBe('Fees are billed monthly. Payment due within 30 days.')
  })

  it('a base_annual_fee (not monthly) also qualifies', () => {
    const plan = planFixedFeeBillingTimingReconciliation({ base_annual_fee: 24000 })
    expect(plan.needsBackfill).toBe(true)
  })

  it('a contract with no fixed fee at all is left untouched — nothing to time', () => {
    const plan = planFixedFeeBillingTimingReconciliation({})
    expect(plan.needsBackfill).toBe(false)
    expect(plan.rule).toBeNull()
  })

  it('a contract that already has an UNRESOLVED rule is left untouched (not this reconciliation\'s job — never overwrites, even with the identical default)', () => {
    const existing = { timing: 'unclear' as const, requires_confirmation: true, confirmation_reason: 'existing reason', source_clause: null }
    const plan = planFixedFeeBillingTimingReconciliation({ base_monthly_fee: 2000, fixed_fee_billing_timing: existing })
    expect(plan.needsBackfill).toBe(false)
  })

  it('a contract that already has a RESOLVED rule (contract-derived or reviewer-confirmed) is never touched', () => {
    const resolved = { timing: 'bill_at_period_start' as const, requires_confirmation: false, confirmation_reason: null, source_clause: 'Invoiced in advance.' }
    const plan = planFixedFeeBillingTimingReconciliation({ base_monthly_fee: 2000, fixed_fee_billing_timing: resolved })
    expect(plan.needsBackfill).toBe(false)
  })
})
