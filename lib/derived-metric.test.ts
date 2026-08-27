import { describe, it, expect } from 'vitest'
import { computeDerivedMetric } from './derived-metric'
import type { DerivedMetricConfig } from './types'

const RATIO_PCT: DerivedMetricConfig = {
  metric_key: 'value_weighted_payment_rate',
  operation: 'ratio',
  numerator_input_key: 'paid_invoice_value',
  denominator_input_key: 'total_invoice_value_of_issued_requests',
  output_unit: 'percentage',
  min_output_value: 0,
  max_output_value: 100,
}

describe('computeDerivedMetric — deterministic ratio primitive', () => {
  it('computes a basic ratio as a percentage', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: 100_000 })
    expect(result.status).toBe('ready')
    if (result.status === 'ready') {
      expect(result.value).toBe(80)
      expect(result.trace).toEqual({
        metric_key: 'value_weighted_payment_rate',
        operation: 'ratio',
        numerator_input_key: 'paid_invoice_value',
        numerator_value: 80_000,
        denominator_input_key: 'total_invoice_value_of_issued_requests',
        denominator_value: 100_000,
        output_unit: 'percentage',
        value: 80,
      })
    }
  })

  it('output_unit "ratio" leaves the value as a 0..1 fraction, not a percentage', () => {
    const config: DerivedMetricConfig = { ...RATIO_PCT, output_unit: 'ratio', max_output_value: 1 }
    const result = computeDerivedMetric(config, { paid_invoice_value: 50, total_invoice_value_of_issued_requests: 200 })
    expect(result).toMatchObject({ status: 'ready', value: 0.25 })
  })

  it('missing numerator → not_ready (never substituted with 0)', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: null, total_invoice_value_of_issued_requests: 100_000 })
    expect(result.status).toBe('not_ready')
    if (result.status === 'not_ready') expect(result.reason).toMatch(/paid_invoice_value/)
  })

  it('missing denominator → not_ready', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: undefined })
    expect(result.status).toBe('not_ready')
    if (result.status === 'not_ready') expect(result.reason).toMatch(/total_invoice_value_of_issued_requests/)
  })

  it('denominator = 0 → not_ready, never invents a 0% (or any) rate', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 0, total_invoice_value_of_issued_requests: 0 })
    expect(result.status).toBe('not_ready')
    if (result.status === 'not_ready') expect(result.reason).toMatch(/zero denominator/)
  })

  it('numerator exceeding denominator (paid > total) → invalid, not a silently-clamped 100%', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 120_000, total_invoice_value_of_issued_requests: 100_000 })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.reason).toMatch(/exceeds the configured maximum/)
  })

  it('negative numerator → invalid by default (never coerced to 0 or absolute value)', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: -1, total_invoice_value_of_issued_requests: 100_000 })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.reason).toMatch(/negative/)
  })

  it('negative denominator → invalid by default', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 10, total_invoice_value_of_issued_requests: -100 })
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') expect(result.reason).toMatch(/negative/)
  })

  it('allow_negative_operands: true permits a negative operand a future metric might legitimately need', () => {
    const config: DerivedMetricConfig = { ...RATIO_PCT, allow_negative_operands: true, min_output_value: null, max_output_value: null }
    const result = computeDerivedMetric(config, { paid_invoice_value: -10, total_invoice_value_of_issued_requests: 100 })
    expect(result).toMatchObject({ status: 'ready', value: -10 })
  })

  it('floating-point division noise near an exact boundary does not leak into the computed value (49999/100000 reads as exactly 49.999)', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 49_999, total_invoice_value_of_issued_requests: 100_000 })
    expect(result).toMatchObject({ status: 'ready', value: 49.999 })
  })

  it('a value exactly at min_output_value (0) is ready, not invalid — the bound is inclusive', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 0, total_invoice_value_of_issued_requests: 100_000 })
    expect(result).toMatchObject({ status: 'ready', value: 0 })
  })

  it('a value exactly at max_output_value (100) is ready, not invalid — the bound is inclusive', () => {
    const result = computeDerivedMetric(RATIO_PCT, { paid_invoice_value: 100_000, total_invoice_value_of_issued_requests: 100_000 })
    expect(result).toMatchObject({ status: 'ready', value: 100 })
  })

  it('no min/max_output_value configured means no domain bound at all', () => {
    const config: DerivedMetricConfig = { ...RATIO_PCT, min_output_value: null, max_output_value: null }
    const result = computeDerivedMetric(config, { paid_invoice_value: 500_000, total_invoice_value_of_issued_requests: 100_000 })
    expect(result).toMatchObject({ status: 'ready', value: 500 })
  })
})
