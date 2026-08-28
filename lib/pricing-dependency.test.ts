import { describe, it, expect } from 'vitest'
import { buildPricingDependencyGroups } from './pricing-dependency'
import type { AdditionalRecurringFee, OverageTier } from './types'
import type { UsageSourceCard } from './usage-source-cards'

const usageSources: UsageSourceCard[] = [
  { key: 'issued_payment_request_count', contractUnitType: 'payment request', semanticInputKey: 'issued_payment_request_count', label: 'Payment requests issued', sourceName: 'Payment Requests Issued', sourceType: 'api_meter', status: 'confirmed', consumers: [] },
  { key: 'completed_payment_count', contractUnitType: 'completed payment', semanticInputKey: 'completed_payment_count', label: 'Completed payments', sourceName: 'Completed Payments', sourceType: 'api_meter', status: 'confirmed', consumers: [] },
]

const fees: AdditionalRecurringFee[] = [
  { fee_label: 'Per-issued payment request fee', amount: 0, rate_per_unit: 0.38, semantic_input_key: 'issued_payment_request_count' } as AdditionalRecurringFee,
  { fee_label: 'Per-completed payment success fee', amount: 0, rate_per_unit: 1.70, semantic_input_key: 'completed_payment_count' } as AdditionalRecurringFee,
  {
    fee_label: 'Performance share', amount: 0,
    percentage_of_basis: {
      derived_metric: { numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests' },
      basis_input_key: 'total_invoice_value_of_issued_requests',
    },
  } as unknown as AdditionalRecurringFee,
]

const tiers: OverageTier[] = [
  { tier_label: 'Extra payment requests above contracted volume of 5,000', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count' } as OverageTier,
]

describe('buildPricingDependencyGroups', () => {
  it('classifies the Remembill contract into fixed / usage_meter / performance_based, with real source names attached', () => {
    const result = buildPricingDependencyGroups({ baseMonthlyFee: 2000, fees, tiers, usageSources })

    expect(result.fixed).toEqual([{ kind: 'fixed', key: 'base_monthly_fee', label: 'Platform fee', amount: 2000 }])

    expect(result.usageMeter).toHaveLength(3)
    const perRequest = result.usageMeter.find(u => u.key === 'Per-issued payment request fee')!
    expect(perRequest.ratePerUnit).toBe(0.38)
    expect(perRequest.sourceName).toBe('Payment Requests Issued')
    const completed = result.usageMeter.find(u => u.key === 'Per-completed payment success fee')!
    expect(completed.ratePerUnit).toBe(1.70)
    expect(completed.sourceName).toBe('Completed Payments')
    const overage = result.usageMeter.find(u => u.label.includes('overage') || u.label.includes('Extra'))!
    expect(overage.ratePerUnit).toBe(0.6)
    expect(overage.includedUnits).toBe(5000)
    expect(overage.sourceName).toBe('Payment Requests Issued')

    expect(result.performanceBased).toEqual([{
      kind: 'performance_based', key: 'Performance share', label: 'Performance share',
      numeratorKey: 'paid_invoice_value', denominatorKey: 'total_invoice_value_of_issued_requests', basisKey: 'total_invoice_value_of_issued_requests',
    }])
  })

  it('never puts a percentage_of_basis fee into usage_meter even when it also has a semantic_input_key', () => {
    const result = buildPricingDependencyGroups({ baseMonthlyFee: 0, fees, tiers: [], usageSources })
    expect(result.usageMeter.some(u => u.key === 'Performance share')).toBe(false)
  })

  it('a zero/negative rate never produces a usage_meter fact', () => {
    const zeroFee: AdditionalRecurringFee = { fee_label: 'Unused', amount: 0, rate_per_unit: 0 } as AdditionalRecurringFee
    const result = buildPricingDependencyGroups({ fees: [zeroFee], tiers: [], usageSources: [] })
    expect(result.usageMeter).toEqual([])
  })
})
