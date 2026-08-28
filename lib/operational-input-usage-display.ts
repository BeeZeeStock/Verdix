// Step 17E.3, item 2 — the approved-contract GUI's Operational Inputs
// section previously showed raw internal schema strings verbatim (e.g.
// "additional_recurring_fees: Performance share (resultatdel) — value-
// weighted payment rate (derived_metric)"), and could show the SAME
// commercial component twice for one input (once via
// required_operational_inputs, once via derived_metric.raw_inputs —
// lib/operational-data-inputs.ts's collectOperationalDataInputs treats
// these as two distinct source STRINGS, since they differ only by a
// "(derived_metric)" suffix). This module replaces that with a business-
// facing, deduplicated-by-FEE description, derived from the same typed
// additional_recurring_fees data already on the page — never a second,
// hard-coded Remembill-specific label. A fee compiled as percentage_of_
// basis (the generic "Performance share" mechanism, named identically
// everywhere else in this codebase — PerformanceShareCard/
// PerformanceShareDisplay) is labeled "Performance share" regardless of
// its own free-text fee_label wording; any other fee falls back to its
// own (already business-authored) fee_label.
export interface OperationalInputConsumer {
  label: string
  detail?: string | null
}

interface FeeForUsageDisplay {
  fee_label: string
  percentage_of_basis?: {
    derived_metric: { metric_key: string; numerator_input_key: string; denominator_input_key: string }
    basis_input_key: string
  } | null
  derived_metric?: { raw_inputs?: string[] | null } | null
  required_operational_inputs?: string[] | null
}

// A small, generic (not Remembill-specific) linguistic touch-up: English
// compound modifiers ending in "_weighted" are conventionally hyphenated
// ("value-weighted", "time-weighted", ...) — applied before the general
// underscore-to-space pass so "value_weighted_payment_rate" reads as
// "value-weighted payment rate", not "value weighted payment rate".
function humanizeMetricKey(key: string): string {
  return key.replace(/(\w+)_weighted_/g, '$1-weighted ').replace(/_/g, ' ')
}

function feeReferencesInput(fee: FeeForUsageDisplay, inputKey: string): boolean {
  if (fee.percentage_of_basis) {
    const c = fee.percentage_of_basis
    if (c.derived_metric.numerator_input_key === inputKey) return true
    if (c.derived_metric.denominator_input_key === inputKey) return true
    if (c.basis_input_key === inputKey) return true
  }
  if (fee.derived_metric?.raw_inputs?.includes(inputKey)) return true
  if (fee.required_operational_inputs?.includes(inputKey)) return true
  return false
}

export function describeOperationalInputConsumers(params: {
  inputKey: string
  fees: FeeForUsageDisplay[]
}): OperationalInputConsumer[] {
  const { inputKey, fees } = params
  const seen = new Set<string>()
  const out: OperationalInputConsumer[] = []

  for (const fee of fees) {
    if (!feeReferencesInput(fee, inputKey)) continue
    const consumer: OperationalInputConsumer = fee.percentage_of_basis
      ? { label: 'Performance share', detail: `Used to calculate the ${humanizeMetricKey(fee.percentage_of_basis.derived_metric.metric_key)}` }
      : { label: fee.fee_label }
    // Deduplicated by the resulting LABEL (the business-facing identity),
    // not by which raw field matched — a fee matching via BOTH
    // derived_metric.raw_inputs and required_operational_inputs must
    // still appear only once.
    if (seen.has(consumer.label)) continue
    seen.add(consumer.label)
    out.push(consumer)
  }

  return out
}
