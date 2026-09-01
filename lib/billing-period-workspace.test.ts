import { describe, it, expect } from 'vitest'
import {
  deriveBillingPeriod, computeFixedComponentForPeriod, derivePeriodReadiness, buildBillingPeriodWorkspace,
  derivePeriodExecutionModel, periodBoundsFromRange, derivePeriodAmountPresentation,
  type UsageComponentState, type PerformanceComponentState,
} from './billing-period-workspace'
import type { UsageSourceCard } from './usage-source-cards'
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

  // Step 17F.8, item 16 — "pilot SEK 0 does not become final invoice
  // SEK 0" and "known fixed amount != final total," named explicitly as
  // their own regression (the general shape is already exercised above,
  // this asserts the specific real Remembill January scenario from the
  // task's own worked example: fixed timing still unresolved post-pilot,
  // variable components pending).
  it('January post-pilot: known fixed amount is a real SEK 2,000, but final total stays TBD while billing timing and variable components remain unresolved', () => {
    const workspace = buildBillingPeriodWorkspace({
      period, started: true, alreadyInvoiced: false,
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: unresolvedTiming },
      usage: [{ key: 'issued_payment_request_count', label: 'Payment requests issued', semanticInputKey: 'issued_payment_request_count', sourceName: 'Manual usage', status: 'pending_usage' }],
      performance: [{ feeLabel: 'Performance share', status: 'pending_operational_inputs', missingKeys: ['paid_invoice_value'] }],
    })
    expect(workspace.fixed.amount).toBe(2000)
    expect(workspace.finalTotal).toBeNull()
    expect(workspace.readiness).toBe('fixed_billing_timing_required')
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

// Step 17H.2B item 3/33/34 — derivePeriodExecutionModel is the ONE shared
// orchestrating function both Billing Periods (BillingPeriodWorkspaceCard)
// and the enriched Billing Timeline (BillingSummaryCard) now call, replacing
// what used to be logic inlined once inside BillingPeriodWorkspaceCard's
// PeriodCard. Cross-contract coverage here (generic shapes, never any
// customer/provider-specific branch) is what backs both surfaces at once.
describe('periodBoundsFromRange (Step 17H.2B item 3/33)', () => {
  it('produces the same label/anchorId shape deriveBillingPeriod would for the identical window', () => {
    const viaAsOf = deriveBillingPeriod({ contractStartDate: '2026-10-01', billingFrequency: 'monthly', asOf: new Date('2026-10-15T00:00:00') })!
    const viaRange = periodBoundsFromRange('2026-10-01', '2026-10-31')
    expect(viaRange).toEqual(viaAsOf)
  })

  it('a cross-year window formats with both years shown, matching fmtRangeLabel', () => {
    const bounds = periodBoundsFromRange('2026-12-15', '2027-01-14')
    expect(bounds.label).toBe('15 Dec 2026 – 14 Jan 2027')
  })
})

describe('derivePeriodExecutionModel — cross-contract shapes (Step 17H.2B item 34)', () => {
  const period = deriveBillingPeriod({ contractStartDate: '2026-08-01', billingFrequency: 'monthly', asOf: new Date('2026-08-15') })!

  function terms(overrides: Partial<ContractTerms> = {}): ContractTerms {
    return { contract_start_date: '2026-08-01', discounts: [], escalators: [], currency: 'EUR', ...overrides } as ContractTerms
  }

  it('fixed-only recurring: no usage/performance groups at all, workspace resolves purely from the fixed component', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({ base_monthly_fee: 5000, fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false } }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.pricingGroups.usageMeter).toEqual([])
    expect(model.pricingGroups.performanceBased).toEqual([])
    expect(model.workspace.fixed.amount).toBe(5000)
    expect(model.workspace.finalTotal).toBe(5000) // no variable components -> immediately final
  })

  it('usage-only, unresolved measurement source: awaiting_source, never a fabricated amount', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({
        overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]],
        fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false }, // isolate the usage blocker from the fixed-timing blocker
      }),
      currency: 'EUR', usageSourceCards: [], // no confirmed source card for api_calls
      period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.usage).toHaveLength(1)
    expect(model.workspace.usage[0].status).toBe('awaiting_source')
    expect(model.workspace.readiness).toBe('parked')
  })

  it('usage-only, confirmed source, no consumption data yet: pending_usage (never computed prematurely)', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.usage[0].status).toBe('pending_usage')
    expect(model.workspace.finalTotal).toBeNull()
  })

  it('usage-only, confirmed source, matching consumption data from a CLOSED period: computed, quantity/amount taken verbatim from consumption-summary', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period,
      // status: 'pending' — closed but not yet invoiced, a genuine
      // authoritative measurement (Step 17H.2B.2 item 9/10: only a closed
      // window can satisfy 'computed').
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 },
      performanceShareResults: null,
    })
    expect(model.workspace.usage[0]).toMatchObject({ status: 'computed', quantity: 500, amount: 50, isLiveNotFinal: false })
    expect(model.workspace.finalTotal).toBe(50)
  })

  it('several usage metrics feeding the same CLOSED period independently — one computed, one still pending, neither leaks into the other', () => {
    const usageSourceCards: UsageSourceCard[] = [
      { key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] },
      { key: 'seats', contractUnitType: 'seats', semanticInputKey: 'seats', label: 'Seats', sourceName: 'Manual entry', sourceType: 'manual', status: 'confirmed', consumers: [] },
    ]
    const model = derivePeriodExecutionModel({
      terms: terms({
        overage_tiers: [
          { tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number],
          { tier_label: 'Seats', unit_type: 'seats', rate_per_unit: 20, semantic_input_key: 'seats' } as ContractTerms['overage_tiers'][number],
        ],
      }),
      currency: 'EUR', usageSourceCards, period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 },
      performanceShareResults: null,
    })
    const apiCalls = model.workspace.usage.find(u => u.key === 'API calls')!
    const seats = model.workspace.usage.find(u => u.key === 'Seats')!
    expect(apiCalls.status).toBe('computed')
    expect(seats.status).toBe('pending_usage')
    expect(model.workspace.finalTotal).toBeNull() // seats still unresolved
  })

  it('performance-only, before contract start: not_started, never asks for operational inputs prematurely', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({
        contract_start_date: '2099-01-01',
        additional_recurring_fees: [{ fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]],
      }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.performance[0].status).toBe('not_started')
  })

  it('performance-only, started, no results yet: pending_operational_inputs', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({
        additional_recurring_fees: [{ fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]],
        fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false }, // isolate the performance blocker from the fixed-timing blocker
      }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.performance[0].status).toBe('pending_operational_inputs')
    expect(model.workspace.readiness).toBe('waiting_for_operational_inputs')
  })

  it('performance-only, a real result matching this period\'s own periodStart: computed, never borrowed from a different period', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({
        additional_recurring_fees: [{ fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]],
      }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null,
      performanceShareResults: [{ feeLabel: 'Performance share', status: 'ready', amount: 777, periodStart: period.start }],
    })
    expect(model.workspace.performance[0]).toMatchObject({ status: 'computed', amount: 777 })
  })

  it('a real result for a DIFFERENT period never leaks into this one — falls back to this period\'s own generic pending state', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({
        additional_recurring_fees: [{ fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]],
      }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null,
      performanceShareResults: [{ feeLabel: 'Performance share', status: 'ready', amount: 777, periodStart: '2020-01-01' }],
    })
    expect(model.workspace.performance[0].status).toBe('pending_operational_inputs')
    expect(model.workspace.performance[0].amount).toBeUndefined()
  })

  it('fixed + usage + performance combined: finalTotal only appears once every variable component is resolved, then sums all three', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const feeConfig = { fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]
    const contractTerms = terms({
      base_monthly_fee: 2000,
      overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]],
      additional_recurring_fees: [feeConfig],
      fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false },
    })
    const consumptionPeriod = { periodStart: period.start, periodEnd: period.end, status: 'pending' as const, overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }

    const partial = derivePeriodExecutionModel({
      terms: contractTerms, currency: 'EUR', usageSourceCards, period, consumptionPeriod, performanceShareResults: null,
    })
    expect(partial.workspace.finalTotal).toBeNull() // performance still pending

    const complete = derivePeriodExecutionModel({
      terms: contractTerms, currency: 'EUR', usageSourceCards, period, consumptionPeriod,
      performanceShareResults: [{ feeLabel: 'Performance share', status: 'ready', amount: 300, periodStart: period.start }],
    })
    expect(complete.workspace.finalTotal).toBe(2000 + 50 + 300)
    expect(complete.workspace.readiness).toBe('ready_to_invoice')
  })

  // Step 17H.2B.2 item 10 — the core correctness fix: even when usage AND
  // performance would otherwise both be "ready" data-wise, an OPEN usage
  // window alone must keep finalTotal null and readiness off
  // 'ready_to_invoice' — a live reading can never satisfy period finality,
  // no matter how complete everything else looks.
  it('fixed + usage + performance combined, but the usage window is still OPEN: finalTotal stays null and readiness stays waiting_for_usage, even though performance is ready', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const feeConfig = { fee_label: 'Performance share', percentage_of_basis: { derived_metric: { numerator_input_key: 'a', denominator_input_key: 'b' }, basis_input_key: 'c' } } as NonNullable<ContractTerms['additional_recurring_fees']>[number]
    const contractTerms = terms({
      base_monthly_fee: 2000,
      overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]],
      additional_recurring_fees: [feeConfig],
      fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false },
    })
    const openConsumptionPeriod = { periodStart: period.start, periodEnd: period.end, status: 'current' as const, overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }

    const model = derivePeriodExecutionModel({
      terms: contractTerms, currency: 'EUR', usageSourceCards, period, consumptionPeriod: openConsumptionPeriod,
      performanceShareResults: [{ feeLabel: 'Performance share', status: 'ready', amount: 300, periodStart: period.start }],
    })
    expect(model.workspace.usage[0].status).toBe('live_not_final')
    expect(model.workspace.finalTotal).toBeNull()
    expect(model.workspace.readiness).toBe('waiting_for_usage')
    expect(model.workspace.missingDependencies).toContain('API calls — measurement period still open, not yet final')
  })

  // Step 17H.2B.2 item 3/9/11 — a matched item with NO amount at all (the
  // pricing-free measurement-only path) is 'live_not_final' regardless of
  // the consumptionPeriod's own status — the absence of an amount is
  // itself sufficient, independent of the open/closed signal.
  it('a matched item with no amount at all (pricing-free measurement-only source) is live_not_final even if the period status claims "pending"', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500 }], overageTotal: 0 },
      performanceShareResults: null,
    })
    expect(model.workspace.usage[0]).toMatchObject({ status: 'live_not_final', quantity: 500, amount: undefined })
    expect(model.workspace.finalTotal).toBeNull()
  })

  it('no fixed component at all (base_monthly_fee 0/absent): fixed.amount is 0, never NaN or undefined', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [] }), currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.fixed.amount).toBe(0)
    expect(model.workspace.finalTotal).toBe(0)
  })

  it('a closed ("past") consumption period is surfaced via consumptionPeriodStatus, distinct from the readiness enum itself', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({ base_monthly_fee: 1000 }), currency: 'EUR', usageSourceCards: [], period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'past', overageItems: [], overageTotal: 0 },
      performanceShareResults: null,
    })
    expect(model.consumptionPeriodStatus).toBe('past')
  })

  // Step 17H.2B.1 items 2/9/10 — live-vs-final measurement distinction.
  it('a reading against an OPEN ("current") window is flagged isLiveNotFinal, with metricSource carried through — status/finalTotal gating unchanged', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50, metric_source: 'meter_pull' }], overageTotal: 50 },
      performanceShareResults: null,
    })
    expect(model.workspace.usage[0]).toMatchObject({ status: 'live_not_final', isLiveNotFinal: true, metricSource: 'meter_pull', amount: undefined })
  })

  it('a reading against a CLOSED ("past"/"pending") window is never flagged isLiveNotFinal', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50, metric_source: 'meter_pull' }], overageTotal: 50 },
      performanceShareResults: null,
    })
    expect(model.workspace.usage[0]).toMatchObject({ status: 'computed', isLiveNotFinal: false })
  })

  it('a manual-source reading carries metricSource: manual_entry, distinguishing it from a meter pull', () => {
    const usageSourceCards: UsageSourceCard[] = [{ key: 'seats', contractUnitType: 'seats', semanticInputKey: 'seats', label: 'Seats', sourceName: 'Manual entry', sourceType: 'manual', status: 'confirmed', consumers: [] }]
    const model = derivePeriodExecutionModel({
      terms: terms({ overage_tiers: [{ tier_label: 'Seats', unit_type: 'seats', rate_per_unit: 20, semantic_input_key: 'seats' } as ContractTerms['overage_tiers'][number]] }),
      currency: 'EUR', usageSourceCards, period,
      consumptionPeriod: { periodStart: period.start, periodEnd: period.end, status: 'current', overageItems: [{ meter_key: 'seats', rate_per_unit: 20, total_units: 12, amount: 240, metric_source: 'manual_entry' }], overageTotal: 240 },
      performanceShareResults: null,
    })
    expect(model.workspace.usage[0].metricSource).toBe('manual_entry')
  })

  it('unresolved fixed-fee billing timing blocks readiness independently of usage/performance state', () => {
    const model = derivePeriodExecutionModel({
      terms: terms({ base_monthly_fee: 1000, fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true } }),
      currency: 'EUR', usageSourceCards: [], period, consumptionPeriod: null, performanceShareResults: null,
    })
    expect(model.workspace.readiness).toBe('fixed_billing_timing_required')
    expect(model.workspace.fixed.amount).toBe(1000) // amount still known even though timing isn't
  })
})

// Step 17H.4B0D4H1B4E2.4 §1-6/24 — generic amount-presentation semantics,
// arbitrary fixtures throughout (no fixture-specific labels/values).
describe('derivePeriodAmountPresentation', () => {
  it('a known fixed amount with variable still pending is never presented as the complete invoice total', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: resolvedTiming },
      usage: [{ key: 'u1', label: 'Widget usage', semanticInputKey: 'u1', sourceName: 'x', status: 'pending_usage' }],
      performance: [],
      finalTotal: null,
    })
    expect(p.fixed).toEqual({ status: 'known', amount: 2000 })
    expect(p.variable.status).toBe('pending')
    expect(p.performance.status).toBe('not_applicable')
    expect(p.invoiceTotal).toEqual({ status: 'not_final' })
  })

  it('a waived fixed fee with variable pending is never presented as a zero invoice total', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 0, currency: 'SEK', waived: true, billingTiming: resolvedTiming },
      usage: [{ key: 'u1', label: 'Widget usage', semanticInputKey: 'u1', sourceName: 'x', status: 'live_not_final' }],
      performance: [],
      finalTotal: null,
    })
    expect(p.fixed).toEqual({ status: 'waived', amount: 0 })
    expect(p.variable.status).toBe('pending')
    expect(p.invoiceTotal).toEqual({ status: 'not_final' })
  })

  it('a fully known/final period (fixed + usage + performance all resolved) presents a real final invoice total', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: resolvedTiming },
      usage: [{ key: 'u1', label: 'Widget usage', semanticInputKey: 'u1', sourceName: 'x', status: 'computed', amount: 50 }],
      performance: [{ feeLabel: 'Perf', status: 'computed', amount: 30 }],
      finalTotal: 2080,
    })
    expect(p.fixed).toEqual({ status: 'known', amount: 2000 })
    expect(p.variable).toEqual({ status: 'known', amount: 50 })
    expect(p.performance).toEqual({ status: 'known', amount: 30 })
    expect(p.invoiceTotal).toEqual({ status: 'final', amount: 2080 })
  })

  it('nothing monetary determinable yet (no usage/performance components at all) — variable/performance both not_applicable, total not final unless the fixed alone is the whole story and finalTotal says so', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: { resolved: false, timing: null } },
      usage: [],
      performance: [],
      finalTotal: null, // fixed timing unresolved -> readiness never reaches ready_to_invoice in the real model
    })
    expect(p.variable.status).toBe('not_applicable')
    expect(p.performance.status).toBe('not_applicable')
    expect(p.invoiceTotal).toEqual({ status: 'not_final' })
  })

  it('a waived performance component is distinguished from a genuinely computed one, never summed as a fabricated amount', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: resolvedTiming },
      usage: [],
      performance: [{ feeLabel: 'Perf', status: 'waived' }],
      finalTotal: 2000,
    })
    expect(p.performance).toEqual({ status: 'waived', amount: 0 })
  })

  it('a performance component still pending operational inputs is reported as pending, never as a zero or omitted amount', () => {
    const p = derivePeriodAmountPresentation({
      fixed: { amount: 2000, currency: 'SEK', waived: false, billingTiming: resolvedTiming },
      usage: [],
      performance: [{ feeLabel: 'Perf', status: 'pending_operational_inputs', missingKeys: ['x'] }],
      finalTotal: null,
    })
    expect(p.performance).toEqual({ status: 'pending', amount: null })
    expect(p.invoiceTotal).toEqual({ status: 'not_final' })
  })
})
