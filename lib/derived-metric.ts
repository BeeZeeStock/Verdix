// Step 17C.1 — the first stage of the generic execution chain: raw
// operational inputs -> DerivedMetric -> RateSchedule -> PercentageOfBasis
// -> economic obligation. See lib/types.ts's DerivedMetricConfig doc for
// why this is a small, closed, deterministic primitive (one operation,
// 'ratio') rather than an arbitrary formula/eval language.
import type { DerivedMetricConfig } from './types'

export interface DerivedMetricTrace {
  metric_key: string
  operation: 'ratio'
  numerator_input_key: string
  numerator_value: number
  denominator_input_key: string
  denominator_value: number
  output_unit: 'ratio' | 'percentage'
  value: number
}

export type DerivedMetricResult =
  | { status: 'ready'; value: number; trace: DerivedMetricTrace }
  // Recoverable — the calculation may become ready once more data exists
  // (a missing input, or a zero denominator the contract doesn't define an
  // outcome for). Never silently substituted with 0 or a prior value.
  | { status: 'not_ready'; reason: string }
  // Not recoverable by waiting — the data itself contradicts the metric's
  // configured domain (a negative operand, or a computed value outside
  // min_output_value/max_output_value, e.g. paid_invoice_value exceeding
  // total_invoice_value_of_issued_requests).
  | { status: 'invalid'; reason: string }

// Binary floating-point division (e.g. 5000/100000) can leave sub-1e-9
// noise that would otherwise nudge a value across an exact RateSchedule
// boundary (e.g. 4.999999999999999 instead of 5) — rounded away here, well
// below the 2-decimal-place precision any real contractual rate/value
// actually carries, never affecting a genuine, materially different input.
function roundToRemoveFloatNoise(n: number): number {
  return Math.round(n * 1e9) / 1e9
}

export function computeDerivedMetric(
  config: DerivedMetricConfig,
  inputs: Record<string, number | null | undefined>,
): DerivedMetricResult {
  const numerator = inputs[config.numerator_input_key]
  const denominator = inputs[config.denominator_input_key]

  if (numerator == null) {
    return { status: 'not_ready', reason: `missing operational input '${config.numerator_input_key}'` }
  }
  if (denominator == null) {
    return { status: 'not_ready', reason: `missing operational input '${config.denominator_input_key}'` }
  }
  if (!config.allow_negative_operands) {
    if (numerator < 0) {
      return { status: 'invalid', reason: `operational input '${config.numerator_input_key}' is negative (${numerator})` }
    }
    if (denominator < 0) {
      return { status: 'invalid', reason: `operational input '${config.denominator_input_key}' is negative (${denominator})` }
    }
  }
  // Fails closed, never invents a 0% (or any other) rate for a zero
  // denominator unless the contract explicitly defines that outcome — no
  // such configuration exists in this codebase yet (would need its own
  // explicit config field, deliberately not added speculatively).
  if (denominator === 0) {
    return { status: 'not_ready', reason: `'${config.denominator_input_key}' is zero — no contract-defined outcome for a zero denominator` }
  }

  const ratio = numerator / denominator
  const rawValue = config.output_unit === 'percentage' ? ratio * 100 : ratio
  const value = roundToRemoveFloatNoise(rawValue)

  if (config.min_output_value != null && value < config.min_output_value) {
    return { status: 'invalid', reason: `computed ${config.metric_key} (${value}) is below the configured minimum (${config.min_output_value})` }
  }
  if (config.max_output_value != null && value > config.max_output_value) {
    return { status: 'invalid', reason: `computed ${config.metric_key} (${value}) exceeds the configured maximum (${config.max_output_value}) — '${config.numerator_input_key}' cannot legitimately exceed '${config.denominator_input_key}'` }
  }

  return {
    status: 'ready',
    value,
    trace: {
      metric_key: config.metric_key,
      operation: config.operation,
      numerator_input_key: config.numerator_input_key,
      numerator_value: numerator,
      denominator_input_key: config.denominator_input_key,
      denominator_value: denominator,
      output_unit: config.output_unit,
      value,
    },
  }
}
