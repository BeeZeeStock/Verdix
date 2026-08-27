// Step 17C.1 — the third stage of the generic execution chain (see
// lib/derived-metric.ts's own header): a selected rate applied to a
// separately-configurable monetary basis. amount = selected_rate ×
// monetary_basis. The rate selector (DerivedMetricConfig) and the
// monetary basis (basis_input_key) are deliberately independent — see
// lib/types.ts's PercentageOfBasisConfig doc for why (Metric A may select
// Rate B, and Rate B may be applied to a different Basis C).
import type { PercentageOfBasisConfig } from './types'
import { computeDerivedMetric, type DerivedMetricTrace } from './derived-metric'
import { selectRate, type RateScheduleSelection } from './rate-schedule'
import { toMinorUnits, fromMinorUnits } from './money'

export interface PercentageOfBasisTrace {
  derived_metric: DerivedMetricTrace
  rate_schedule: {
    schedule_key: string
    selector_value: number
    matched_band: { from: number; to: number | null; rate_pct: number }
    rate_pct: number
  }
  basis: { input_key: string; value: number }
  amount: number
}

export type PercentageOfBasisResult =
  | { status: 'ready'; amount: number; trace: PercentageOfBasisTrace }
  | { status: 'not_ready'; reason: string }
  | { status: 'invalid'; reason: string }

export function computePercentageOfBasisFee(
  config: PercentageOfBasisConfig,
  inputs: Record<string, number | null | undefined>,
): PercentageOfBasisResult {
  const metricResult = computeDerivedMetric(config.derived_metric, inputs)
  if (metricResult.status !== 'ready') return metricResult

  const rateResult: RateScheduleSelection = selectRate(config.rate_schedule, metricResult.value)
  if (rateResult.status === 'invalid_schedule') {
    return { status: 'invalid', reason: `rate schedule '${config.rate_schedule.schedule_key}' is misconfigured: ${rateResult.reason}` }
  }
  if (rateResult.status === 'out_of_bounds') {
    return { status: 'invalid', reason: rateResult.reason }
  }

  // The monetary basis is resolved independently of the derived metric's
  // own operands — it may coincide with one of them (Remembill: the same
  // denominator, total_invoice_value_of_issued_requests) or not, entirely
  // by the caller's own configuration, never assumed here.
  const basisValue = inputs[config.basis_input_key]
  if (basisValue == null) {
    return { status: 'not_ready', reason: `missing monetary basis input '${config.basis_input_key}'` }
  }
  if (basisValue < 0) {
    return { status: 'invalid', reason: `monetary basis input '${config.basis_input_key}' is negative (${basisValue})` }
  }

  // Step 17C.1a, item 4 — reuses lib/money.ts's existing minor-unit
  // convention (the credit ledger's own discipline) rather than a
  // one-off Math.round(...*100)/100 done only at this call site: convert
  // the basis to integer minor units ONCE, do the rate multiplication in
  // minor units, round to the nearest whole minor unit, convert back.
  // Verified against every section-11 worked example — identical results
  // to a direct major-unit calculation for a single multiplication step,
  // but this is the auditable, reusable convention going forward rather
  // than a rounding rule invented fresh here.
  const basisMinor = toMinorUnits(basisValue)
  const amountMinor = Math.round(basisMinor * rateResult.rate_pct / 100)
  const amount = fromMinorUnits(amountMinor)

  return {
    status: 'ready',
    amount,
    trace: {
      derived_metric: metricResult.trace,
      rate_schedule: {
        schedule_key: config.rate_schedule.schedule_key,
        selector_value: metricResult.value,
        matched_band: { from: rateResult.band.from, to: rateResult.band.to, rate_pct: rateResult.band.rate_pct },
        rate_pct: rateResult.rate_pct,
      },
      basis: { input_key: config.basis_input_key, value: basisValue },
      amount,
    },
  }
}
