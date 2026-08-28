import { describe, it, expect } from 'vitest'
import { describeOperationalInputConsumers } from './operational-input-usage-display'

describe('describeOperationalInputConsumers — Step 17E.3, item 2', () => {
  const performanceShareFee = {
    fee_label: 'Performance share (resultatdel) — value-weighted payment rate',
    percentage_of_basis: {
      derived_metric: { metric_key: 'value_weighted_payment_rate', numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests' },
      basis_input_key: 'total_invoice_value_of_issued_requests',
    },
    derived_metric: { raw_inputs: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'] },
    required_operational_inputs: ['total_invoice_value_of_issued_requests'],
  }

  it('a percentage_of_basis fee shows the generic business label "Performance share", never the raw fee_label or internal field names', () => {
    const result = describeOperationalInputConsumers({ inputKey: 'paid_invoice_value', fees: [performanceShareFee] })
    expect(result).toEqual([{ label: 'Performance share', detail: 'Used to calculate the value-weighted payment rate' }])
    expect(JSON.stringify(result)).not.toContain('additional_recurring_fees')
    expect(JSON.stringify(result)).not.toContain('derived_metric')
  })

  it('an input referenced via BOTH derived_metric.raw_inputs AND required_operational_inputs for the SAME fee is deduplicated to one consumer entry', () => {
    // total_invoice_value_of_issued_requests matches via raw_inputs,
    // basis_input_key, AND required_operational_inputs on the SAME fee —
    // must still produce exactly one entry, not three.
    const result = describeOperationalInputConsumers({ inputKey: 'total_invoice_value_of_issued_requests', fees: [performanceShareFee] })
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Performance share')
  })

  it('a plain per-unit fee with no percentage_of_basis falls back to its own fee_label, no synthetic detail', () => {
    const result = describeOperationalInputConsumers({
      inputKey: 'issued_payment_request_count',
      fees: [{ fee_label: 'Per-issued payment request fee', required_operational_inputs: ['issued_payment_request_count'] }],
    })
    expect(result).toEqual([{ label: 'Per-issued payment request fee' }])
  })

  it('a fee that does not reference the input at all is excluded', () => {
    const result = describeOperationalInputConsumers({
      inputKey: 'completed_payment_count',
      fees: [performanceShareFee],
    })
    expect(result).toEqual([])
  })

  it('two DIFFERENT fees referencing the same input both appear, each deduplicated independently', () => {
    const secondFee = { fee_label: 'Chargeback fee', required_operational_inputs: ['paid_invoice_value'] }
    const result = describeOperationalInputConsumers({ inputKey: 'paid_invoice_value', fees: [performanceShareFee, secondFee] })
    expect(result.map(r => r.label)).toEqual(['Performance share', 'Chargeback fee'])
  })
})
