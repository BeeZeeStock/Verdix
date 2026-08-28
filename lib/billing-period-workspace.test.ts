import { describe, it, expect } from 'vitest'
import {
  deriveBillingPeriod, computeFixedComponentForPeriod, derivePeriodReadiness, buildBillingPeriodWorkspace,
  type UsageComponentState, type PerformanceComponentState,
} from './billing-period-workspace'
import type { ContractTerms } from './types'

const resolvedTiming = { resolved: true as const, timing: 'bill_at_period_start' as const }
const unresolvedTiming = { resolved: false as const, timing: null }

describe('deriveBillingPeriod', () => {
  it('returns null when the contract has no start date', () => {
    expect(deriveBillingPeriod({ contractStartDate: null, billingFrequency: 'monthly', asOf: new Date('2026-08-28') })).toBeNull()
  })

  it('October 2026 for the Remembill contract, before it starts (asOf before contract start still resolves to the first period)', () => {
    const period = deriveBillingPeriod({ contractStartDate: '2026-10-01', billingFrequency: 'monthly', asOf: new Date('2026-08-28T00:00:00') })
    expect(period).not.toBeNull()
    expect(period!.start).toBe('2026-10-01')
    expect(period!.end).toBe('2026-10-31')
    expect(period!.label).toBe('1 Oct – 31 Oct 2026')
    expect(period!.anchorId).toBe('billing-period-2026-10')
  })

  it('a simulated asOf inside the period resolves to the same period bounds', () => {
    const period = deriveBillingPeriod({ contractStartDate: '2026-10-01', billingFrequency: 'monthly', asOf: new Date('2026-10-15T00:00:00') })
    expect(period!.start).toBe('2026-10-01')
    expect(period!.end).toBe('2026-10-31')
  })
})

describe('computeFixedComponentForPeriod', () => {
  it('the Remembill pilot period is waived to 0 with waived: true', () => {
    const terms: ContractTerms = {
      contract_start_date: '2026-10-01', base_monthly_fee: 2000, currency: 'EUR',
      discounts: [{
        description: '90-day pilot', discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
        affected_components: ['base_recurring_fee'],
      }],
    } as unknown as ContractTerms
    const result = computeFixedComponentForPeriod({ terms, periodStart: '2026-10-01', additionalFixedFeesTotal: 0, currency: 'EUR' })
    expect(result.amount).toBe(0)
    expect(result.waived).toBe(true)
  })

  it('a later, non-waived period bills the full base fee', () => {
    const terms: ContractTerms = { contract_start_date: '2026-10-01', base_monthly_fee: 2000, currency: 'EUR', discounts: [] } as unknown as ContractTerms
    const result = computeFixedComponentForPeriod({ terms, periodStart: '2027-01-01', additionalFixedFeesTotal: 0, currency: 'EUR' })
    expect(result.amount).toBe(2000)
    expect(result.waived).toBe(false)
  })

  // Step 17F.3, item 2/10 — billing timing is a SEPARATE axis from amount;
  // the amount computation itself never changes based on it.
  describe('billingTiming — Step 17F.3, item 2', () => {
    const terms: ContractTerms = { contract_start_date: '2026-10-01', base_monthly_fee: 2000, currency: 'EUR', discounts: [] } as unknown as ContractTerms

    it('no rule at all -> unresolved, timing null (never defaulted to bill_at_period_start)', () => {
      const result = computeFixedComponentForPeriod({ terms, periodStart: '2027-01-01', additionalFixedFeesTotal: 0, currency: 'EUR' })
      expect(result.billingTiming).toEqual({ resolved: false, timing: null })
      expect(result.amount).toBe(2000) // amount unaffected by timing resolution
    })

    it('requires_confirmation: true -> unresolved regardless of what timing value happens to be set', () => {
      const result = computeFixedComponentForPeriod({
        terms, periodStart: '2027-01-01', additionalFixedFeesTotal: 0, currency: 'EUR',
        billingTimingRule: { timing: 'bill_at_period_start', requires_confirmation: true },
      })
      expect(result.billingTiming.resolved).toBe(false)
    })

    it('a confirmed bill_at_period_start rule resolves', () => {
      const result = computeFixedComponentForPeriod({
        terms, periodStart: '2027-01-01', additionalFixedFeesTotal: 0, currency: 'EUR',
        billingTimingRule: { timing: 'bill_at_period_start', requires_confirmation: false },
      })
      expect(result.billingTiming).toEqual({ resolved: true, timing: 'bill_at_period_start' })
    })

    it('a confirmed bill_at_period_end rule resolves to that value', () => {
      const result = computeFixedComponentForPeriod({
        terms, periodStart: '2027-01-01', additionalFixedFeesTotal: 0, currency: 'EUR',
        billingTimingRule: { timing: 'bill_at_period_end', requires_confirmation: false },
      })
      expect(result.billingTiming).toEqual({ resolved: true, timing: 'bill_at_period_end' })
    })
  })
})

describe('derivePeriodReadiness', () => {
  const computedUsage: UsageComponentState = { key: 'a', label: 'A', semanticInputKey: 'a', sourceName: 'Meter A', status: 'computed', amount: 10 }
  const computedPerf: PerformanceComponentState = { feeLabel: 'Performance share', status: 'computed', amount: 5 }

  it('upcoming before the period starts, regardless of dependency state', () => {
    expect(derivePeriodReadiness({ started: false, alreadyInvoiced: false, fixedBillingTimingResolved: false, usage: [], performance: [] })).toBe('upcoming')
  })

  it('invoiced takes priority over every other state', () => {
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: true, fixedBillingTimingResolved: false, usage: [{ ...computedUsage, status: 'awaiting_source' }], performance: [] })).toBe('invoiced')
  })

  // Step 17F.3, item 3/11 — its own distinct state, checked before usage/
  // performance blockers.
  it('fixed_billing_timing_required when the fixed component has no resolved billing timing, even if usage/performance are otherwise fully ready', () => {
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: false, fixedBillingTimingResolved: false, usage: [computedUsage], performance: [computedPerf] })).toBe('fixed_billing_timing_required')
  })

  it('parked when a usage component has no confirmed source at all (billing timing resolved)', () => {
    const usage: UsageComponentState = { ...computedUsage, status: 'awaiting_source' }
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: false, fixedBillingTimingResolved: true, usage: [usage], performance: [] })).toBe('parked')
  })

  it('waiting_for_operational_inputs when a performance component needs manual entry (billing timing resolved)', () => {
    const perf: PerformanceComponentState = { feeLabel: 'Performance share', status: 'pending_operational_inputs', missingKeys: ['paid_invoice_value'] }
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: false, fixedBillingTimingResolved: true, usage: [], performance: [perf] })).toBe('waiting_for_operational_inputs')
  })

  it('waiting_for_usage when a usage component is configured but not yet measured (billing timing resolved)', () => {
    const usage: UsageComponentState = { ...computedUsage, status: 'pending_usage' }
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: false, fixedBillingTimingResolved: true, usage: [usage], performance: [] })).toBe('waiting_for_usage')
  })

  it('ready_to_invoice once every dependency has resolved, including billing timing', () => {
    expect(derivePeriodReadiness({ started: true, alreadyInvoiced: false, fixedBillingTimingResolved: true, usage: [computedUsage], performance: [computedPerf] })).toBe('ready_to_invoice')
  })
})

describe('buildBillingPeriodWorkspace', () => {
  const period = deriveBillingPeriod({ contractStartDate: '2026-10-01', billingFrequency: 'monthly', asOf: new Date('2026-08-28') })!

  it('October before contract start: known fixed amount 0 (waived), usage/performance both pending, final total TBD (null)', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: false, alreadyInvoiced: false,
      fixed: { amount: 0, currency: 'EUR', waived: true, billingTiming: unresolvedTiming },
      usage: [
        { key: 'issued_payment_request_count', label: 'Payment requests issued', semanticInputKey: 'issued_payment_request_count', sourceName: 'Payment Requests Issued', status: 'awaiting_period' },
        { key: 'completed_payment_count', label: 'Completed payments', semanticInputKey: 'completed_payment_count', sourceName: 'Completed Payments', status: 'awaiting_period' },
      ],
      performance: [{ feeLabel: 'Performance share', status: 'not_started', contractStartDate: '2026-10-01' }],
    })
    expect(workspace.readiness).toBe('upcoming')
    expect(workspace.fixed.amount).toBe(0)
    expect(workspace.fixed.waived).toBe(true)
    expect(workspace.finalTotal).toBeNull()
  })

  it('a fully resolved period (usage measured, performance computed, billing timing confirmed) has a real final total — fixed + usage + performance', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming },
      usage: [
        { key: 'issued_payment_request_count', label: 'Payment requests issued', semanticInputKey: 'issued_payment_request_count', sourceName: 'Payment Requests Issued', status: 'computed', quantity: 8000, amount: 3040 + 1800 },
        { key: 'completed_payment_count', label: 'Completed payments', semanticInputKey: 'completed_payment_count', sourceName: 'Completed Payments', status: 'computed', quantity: 2100, amount: 3570 },
      ],
      performance: [{ feeLabel: 'Performance share', status: 'computed', amount: 3550 }],
    })
    expect(workspace.readiness).toBe('ready_to_invoice')
    expect(workspace.finalTotal).toBeCloseTo(2000 + 4840 + 3570 + 3550, 2)
    expect(workspace.missingDependencies).toEqual([])
  })

  // Step 17F.3, item 10 — the known/final AMOUNT is independent of billing-
  // timing resolution: a period can be fully computable while still not
  // being "ready to invoice" because the invoice DATE is unresolved.
  it('a fully computed period with UNRESOLVED billing timing still produces a real finalTotal, but readiness stays fixed_billing_timing_required', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: unresolvedTiming },
      usage: [{ key: 'issued_payment_request_count', label: 'Payment requests issued', semanticInputKey: 'issued_payment_request_count', sourceName: 'Payment Requests Issued', status: 'computed', quantity: 8000, amount: 4840 }],
      performance: [{ feeLabel: 'Performance share', status: 'computed', amount: 3550 }],
    })
    expect(workspace.readiness).toBe('fixed_billing_timing_required')
    expect(workspace.finalTotal).toBeCloseTo(2000 + 4840 + 3550, 2)
    expect(workspace.missingDependencies).toContain('Fixed-fee billing timing — decision required')
  })

  it('missingDependencies names exactly what is blocking — a missing usage source and missing operational inputs (billing timing resolved)', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'EUR', waived: false, billingTiming: resolvedTiming },
      usage: [{ key: 'x', label: 'Chargebacks', semanticInputKey: null, sourceName: null, status: 'awaiting_source' }],
      performance: [{ feeLabel: 'Performance share', status: 'pending_operational_inputs', missingKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'] }],
    })
    expect(workspace.missingDependencies).toEqual([
      'Chargebacks — no confirmed usage source',
      'paid_invoice_value',
      'total_invoice_value_of_issued_requests',
    ])
  })
})
