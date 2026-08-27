import { describe, it, expect } from 'vitest'
import { describeDiscountComponentScope } from './rule-interpretation'
import { collectOperationalDataInputs } from './operational-data-inputs'
import { buildRemembillFixtureTerms } from './remembill-fixture'

// ═══════════════════════════════════════════════════════════════════════════
// Corrections pass (post-17B0.4) — two fixes:
// A. The user-facing discount summary must be rendered deterministically
//    from affected_components/possibly_affected_components, never from
//    applies_to/description/source-clause prose.
// B. collectOperationalDataInputs() must never emit a derived_metric's own
//    name as a raw operational input, and derived metrics must be
//    reportable as their own, separate list.
// ═══════════════════════════════════════════════════════════════════════════

describe('Corrections A — deterministic discount component-scope summary', () => {
  it('definite + possible component (the exact worked example) renders both sentences', () => {
    const summary = describeDiscountComponentScope({
      affected_components: ['base_recurring_fee'],
      possibly_affected_components: ['performance_fee'],
      discount_pct: 100,
    })
    expect(summary).toBe(
      'The fixed platform fee is waived. Whether the performance-share component is also waived is not explicit.',
    )
  })

  it('never derives its text from applies_to/description — those are ignored entirely even when populated', () => {
    const summary = describeDiscountComponentScope({
      affected_components: ['base_recurring_fee'],
      possibly_affected_components: null,
      discount_pct: 100,
    } as never)
    expect(summary).toBe('The fixed platform fee is waived.')
    expect(summary).not.toMatch(/applies_to|description/i)
  })

  it('reviewer confirmation resolving the open question to "covers both" updates the summary automatically — single sentence, no more "not explicit"', () => {
    // Simulates resolveConfirmedDiscountComponents moving the possibly-
    // affected component into affected_components once a reviewer confirms
    // it — the summary is a pure function of the CURRENT typed state, so
    // calling it again with the post-confirmation shape is exactly what a
    // re-render after onRefresh does.
    const resolvedBoth = describeDiscountComponentScope({
      affected_components: ['base_recurring_fee', 'performance_fee'],
      possibly_affected_components: [],
      discount_pct: 100,
    })
    expect(resolvedBoth).toBe('The fixed platform fee and performance-share component are waived.')
  })

  it('reviewer confirmation resolving to "fixed fee only" drops the open-question sentence entirely', () => {
    const resolvedNarrow = describeDiscountComponentScope({
      affected_components: ['base_recurring_fee'],
      possibly_affected_components: [],
      discount_pct: 100,
    })
    expect(resolvedNarrow).toBe('The fixed platform fee is waived.')
  })

  it('a partial (non-100%) discount reads "discounted", not "waived"', () => {
    const summary = describeDiscountComponentScope({
      affected_components: ['base_recurring_fee'],
      possibly_affected_components: null,
      discount_pct: 20,
    })
    expect(summary).toBe('The fixed platform fee is discounted.')
  })

  it('no typed component data at all (both arrays null) returns null — caller falls back, this function never invents scope', () => {
    expect(describeDiscountComponentScope({ affected_components: null, possibly_affected_components: null })).toBeNull()
    expect(describeDiscountComponentScope(null)).toBeNull()
    expect(describeDiscountComponentScope(undefined)).toBeNull()
  })

  it('an unrecognized component key still renders (space-separated fallback), never throws', () => {
    const summary = describeDiscountComponentScope({
      affected_components: ['some_future_component'],
      possibly_affected_components: null,
      discount_pct: 100,
    })
    expect(summary).toBe('The some future component is waived.')
  })
})

describe('Corrections B — derived_metric never leaks into operational inputs; derived metrics are separately reportable', () => {
  it('Remembill: the derived metric name (value_weighted_payment_rate) never appears as an operational input key', () => {
    const terms = buildRemembillFixtureTerms()
    const inputs = collectOperationalDataInputs(terms)
    expect(inputs.some(i => i.key === 'value_weighted_payment_rate')).toBe(false)
  })

  it('Remembill: the four real operational inputs from the fee-level dependencies are present, exactly as specified', () => {
    const terms = buildRemembillFixtureTerms()
    const inputs = collectOperationalDataInputs(terms)
    const keys = inputs.map(i => i.key)
    expect(keys).toEqual(expect.arrayContaining([
      'completed_payment_count',
      'issued_payment_request_count',
      'paid_invoice_value',
      'total_invoice_value_of_issued_requests',
    ]))
  })

  it('a derived_metric.raw_inputs entry that happens to collide with another fee\'s derived_metric.metric_name is still excluded from operational inputs', () => {
    const terms = {
      additional_recurring_fees: [
        {
          fee_label: 'Fee A',
          required_operational_inputs: ['some_metric', 'real_raw_input'],
          derived_metric: { metric_name: 'some_metric', formula: 'x', raw_inputs: ['real_raw_input'] },
        },
      ],
    }
    const inputs = collectOperationalDataInputs(terms)
    const keys = inputs.map(i => i.key)
    expect(keys).not.toContain('some_metric')
    expect(keys).toContain('real_raw_input')
  })
})

describe('Corrections B — collectDerivedMetrics() surfaces derived metrics as their own list', () => {
  it('Remembill: exactly one derived metric, with the exact formula and raw inputs', async () => {
    const { collectDerivedMetrics } = await import('./operational-data-inputs')
    const terms = buildRemembillFixtureTerms()
    const derived = collectDerivedMetrics(terms)
    expect(derived).toHaveLength(1)
    expect(derived[0]).toMatchObject({
      metric_name: 'value_weighted_payment_rate',
      formula: 'paid_invoice_value / total_invoice_value_of_issued_requests',
      raw_inputs: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
    })
  })

  it('the performance fee still carries its own monetary charge-basis dependency (total_invoice_value_of_issued_requests) as a required_operational_inputs entry, independent of the derived metric', () => {
    const terms = buildRemembillFixtureTerms()
    const perf = terms.additional_recurring_fees!.find(f => f.derived_metric)!
    expect(perf.required_operational_inputs).toEqual(['total_invoice_value_of_issued_requests'])
  })

  it('no additional_recurring_fees at all yields an empty derived-metrics list, never throws', async () => {
    const { collectDerivedMetrics } = await import('./operational-data-inputs')
    expect(collectDerivedMetrics({})).toEqual([])
    expect(collectDerivedMetrics({ additional_recurring_fees: null })).toEqual([])
  })
})
