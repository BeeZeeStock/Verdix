import { describe, it, expect } from 'vitest'
import { computePercentageOfBasisFee } from './percentage-of-basis-fee'
import { REMEMBILL_PERFORMANCE_SHARE_SCHEDULE } from './remembill-fixture'
import type { PercentageOfBasisConfig } from './types'

const REMEMBILL_CONFIG: PercentageOfBasisConfig = {
  derived_metric: {
    metric_key: 'value_weighted_payment_rate',
    operation: 'ratio',
    numerator_input_key: 'paid_invoice_value',
    denominator_input_key: 'total_invoice_value_of_issued_requests',
    output_unit: 'percentage',
    min_output_value: 0,
    max_output_value: 100,
  },
  rate_schedule: REMEMBILL_PERFORMANCE_SHARE_SCHEDULE,
  basis_input_key: 'total_invoice_value_of_issued_requests',
}

describe('computePercentageOfBasisFee — section 10 worked audit-trace example', () => {
  it('paid €80,000 / total €100,000 → 80% → 3.55% → €3,550, with a complete, replayable trace', () => {
    const result = computePercentageOfBasisFee(REMEMBILL_CONFIG, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.amount).toBe(3550)
    expect(result.trace).toEqual({
      derived_metric: {
        metric_key: 'value_weighted_payment_rate',
        operation: 'ratio',
        numerator_input_key: 'paid_invoice_value',
        numerator_value: 80_000,
        denominator_input_key: 'total_invoice_value_of_issued_requests',
        denominator_value: 100_000,
        output_unit: 'percentage',
        value: 80,
      },
      rate_schedule: {
        schedule_key: 'remembill_value_weighted_payment_rate_schedule',
        selector_value: 80,
        matched_band: { from: 80, to: 85, rate_pct: 3.55 },
        rate_pct: 3.55,
      },
      basis: { input_key: 'total_invoice_value_of_issued_requests', value: 100_000 },
      amount: 3550,
    })
  })
})

describe('computePercentageOfBasisFee — the mandatory basis/selector distinction', () => {
  it('the basis multiplies against basis_input_key, never against the derived metric\'s own numerator (paid_invoice_value) — the classic miscalculation this config prevents', () => {
    const result = computePercentageOfBasisFee(REMEMBILL_CONFIG, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    // 100,000 × 3.55% = 3,550 — NOT 80,000 × 3.55% = 2,840
    expect(result.amount).not.toBe(2840)
    expect(result.amount).toBe(3550)
  })

  it('a basis independent of both the numerator and denominator is honored — proves the selector and basis are genuinely decoupled', () => {
    const config: PercentageOfBasisConfig = { ...REMEMBILL_CONFIG, basis_input_key: 'unrelated_monetary_basis' }
    const result = computePercentageOfBasisFee(config, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
      unrelated_monetary_basis: 500_000,
    })
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.amount).toBe(17_750) // 500,000 × 3.55%
  })
})

describe('computePercentageOfBasisFee — readiness/failure propagation', () => {
  it('missing basis input → not_ready, even when the derived metric itself is ready', () => {
    const result = computePercentageOfBasisFee(REMEMBILL_CONFIG, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
      // basis_input_key here happens to equal the denominator, so it IS
      // present — use a config with a genuinely separate, missing basis.
    })
    expect(result.status).toBe('ready')

    const configWithSeparateBasis: PercentageOfBasisConfig = { ...REMEMBILL_CONFIG, basis_input_key: 'some_other_basis' }
    const held = computePercentageOfBasisFee(configWithSeparateBasis, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
    })
    expect(held).toMatchObject({ status: 'not_ready' })
  })

  it('a not-ready derived metric (missing input) short-circuits before ever touching the rate schedule or basis', () => {
    const result = computePercentageOfBasisFee(REMEMBILL_CONFIG, { total_invoice_value_of_issued_requests: 100_000 })
    expect(result).toMatchObject({ status: 'not_ready' })
  })

  it('an invalid derived metric (paid > total) propagates as invalid, never silently clamped', () => {
    const result = computePercentageOfBasisFee(REMEMBILL_CONFIG, {
      paid_invoice_value: 150_000,
      total_invoice_value_of_issued_requests: 100_000,
    })
    expect(result).toMatchObject({ status: 'invalid' })
  })

  it('a misconfigured (gapped) rate schedule fails as invalid, never silently matching a nearby band', () => {
    const badConfig: PercentageOfBasisConfig = {
      ...REMEMBILL_CONFIG,
      rate_schedule: { schedule_key: 'broken', min_selector_value: 0, max_selector_value: 100, bands: [{ from: 0, to: 50, rate_pct: 1 }] },
    }
    const result = computePercentageOfBasisFee(badConfig, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
    })
    expect(result).toMatchObject({ status: 'invalid' })
  })

  it('a negative basis value is invalid', () => {
    const config: PercentageOfBasisConfig = { ...REMEMBILL_CONFIG, basis_input_key: 'negative_basis' }
    const result = computePercentageOfBasisFee(config, {
      paid_invoice_value: 80_000,
      total_invoice_value_of_issued_requests: 100_000,
      negative_basis: -1,
    })
    expect(result).toMatchObject({ status: 'invalid' })
  })
})
