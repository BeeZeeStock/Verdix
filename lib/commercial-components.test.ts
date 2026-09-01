import { describe, it, expect } from 'vitest'
import { buildCommercialComponents, humanizeKey, type CommercialComponentsTerms } from './commercial-components'

describe('buildCommercialComponents — Step 17G.4A', () => {
  it('returns nothing for undefined terms', () => {
    expect(buildCommercialComponents(undefined, 'EUR')).toEqual([])
  })

  it('returns nothing for a contract with no fixed/usage/performance pricing at all', () => {
    expect(buildCommercialComponents({}, 'EUR')).toEqual([])
  })

  it('fixed-only agreement: one Platform subscription component, no usage/performance components', () => {
    const terms: CommercialComponentsTerms = { base_monthly_fee: 10000, billing_frequency: 'monthly' }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components).toHaveLength(1)
    expect(components[0].title).toBe('Platform subscription')
    expect(components[0].pricingModel).toBe('fixed')
    expect(components[0].summaryLines).toEqual(['€10,000.00/month'])
    expect(components[0].bandTable).toBeUndefined()
    // A fixed fee with no fixed_fee_billing_timing rule at all is
    // genuinely unresolved (never defaulted) — correctly flagged.
    expect(components[0].hasUnresolvedDecision).toBe(true)
  })

  it('fixed + usage agreement (no performance): two components', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      additional_recurring_fees: [{ fee_label: 'API calls', rate_per_unit: 0.01, metric_name: 'api_call' }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components.map(c => c.pricingModel)).toEqual(['fixed', 'usage'])
    expect(components[1].title).toBe('API calls')
    expect(components[1].summaryLines[0]).toContain('api call')
    expect(components[1].detail.find(d => d.label === 'Charging rule')?.value).toBe('Charge each api call')
  })

  it('usage-only agreement (no fixed fee): only a usage component', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{ fee_label: 'Seats', rate_per_unit: 5, metric_name: 'seat' }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components).toHaveLength(1)
    expect(components[0].pricingModel).toBe('usage')
  })

  it('the real Remembill shape: fixed + usage + performance, with the usage fee\'s matching overage tier merged in', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 2000,
      billing_frequency: 'monthly',
      base_fee_bands: [
        { from_unit: 0, to_unit: 500, monthly_fee: 250 },
        { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 },
      ] as CommercialComponentsTerms['base_fee_bands'],
      base_fee_committed_volume: 5000,
      base_fee_proration: { prorate_partial_periods: false, requires_confirmation: false },
      fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true },
      discounts: [{ discount_pct: 100, duration_days: 90, affected_components: ['base_recurring_fee'] }],
      unsupported_commercial_mechanisms: [{ execution_status: 'executable', rolling_band_migration: {} }],
      additional_recurring_fees: [
        { fee_label: 'Per-issued payment request fee', rate_per_unit: 0.38, metric_name: 'issued_payment_request', semantic_input_key: 'issued_payment_request_count' },
        { fee_label: 'Per-completed payment success fee', rate_per_unit: 1.70, metric_name: 'completed_payment', semantic_input_key: 'completed_payment_count' },
        {
          fee_label: 'Performance share', metric_name: 'value_weighted_payment_rate',
          percentage_of_basis: {
            derived_metric: { metric_key: 'value_weighted_payment_rate', numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests' },
            rate_schedule: { bands: [{ from: 0, to: 5, rate_pct: 0 }, { from: 5, to: null, rate_pct: 4.5 }] },
            basis_input_key: 'total_invoice_value_of_issued_requests',
          },
          variable_invoice_timing: { timing: 'unclear', requires_confirmation: true },
        },
      ],
      overage_tiers: [{ tier_label: 'Overage', unit_type: 'issued_payment_request', from_unit: 5001, rate_per_unit: 0.60, semantic_input_key: 'issued_payment_request_count' }],
    }
    const components = buildCommercialComponents(terms, 'SEK')
    expect(components.map(c => c.title)).toEqual([
      'Platform subscription', 'Per-issued payment request fee', 'Per-completed payment success fee', 'Performance share',
    ])

    const fixed = components[0]
    // Intl.NumberFormat inserts a non-breaking space around SEK — matched
    // by regex rather than a literal string to avoid a whitespace-byte
    // mismatch unrelated to the actual logic under test.
    expect(fixed.summaryLines[0]).toMatch(/SEK\s*2,000\.00\/month/)
    expect(fixed.pricingModelLabel).toBe('Fixed recurring + volume-band pricing')
    expect(fixed.bandTable).toHaveLength(2)
    expect(fixed.bandResolution).toEqual({ status: 'resolved', band: { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 } })
    expect(fixed.detail.find(d => d.label === 'Contracted volume')?.value).toBe('5,000')
    expect(fixed.detail.find(d => d.label === 'Selected band')?.value).toBe('1,501–5,000')
    // Step 17H.3D1 — the old "Pilot"/"Discount" summary facts were
    // removed from buildFixedComponent: Commercial Logic's dedicated
    // discount migration now explains the same rule once (type, value,
    // applicability, period, interpretation, source, provenance, edit —
    // see lib/discount-commercial-logic.ts), so this pure component
    // builder no longer duplicates it.
    expect(fixed.detail.find(d => d.label === 'Pilot')).toBeUndefined()
    expect(fixed.detail.find(d => d.label === 'Discount')).toBeUndefined()
    expect(fixed.detail.find(d => d.label === 'Partial-period treatment')?.value).toBe('Start fixed fee from next full billing period')
    // Step 17G.6G — reverted 17G.6F's pilot-embedding: a platform-generic
    // question, identical regardless of whether a pilot exists on this
    // contract (the pilot stays its own separate "Pilot" fact, asserted
    // above).
    expect(fixed.detail.find(d => d.label === 'Recurring fixed-fee timing')).toEqual({
      label: 'Recurring fixed-fee timing', value: 'Decision required', decisionRequired: true,
      helperText: 'When should the recurring fixed fee be invoiced?',
    })
    expect(fixed.detail.find(d => d.label === 'Volume adjustment')?.value).toContain('rolling-volume rule')
    expect(fixed.hasUnresolvedDecision).toBe(true)

    const paymentRequests = components[1]
    expect(paymentRequests.summaryLines[0]).toMatch(/SEK\s*0\.38 \/ issued payment request/)
    expect(paymentRequests.summaryLines[1]).toMatch(/SEK\s*0\.6 \/ issued payment request above 5,000/)
    // Step 17G.5A/17G.6A — the commercial LOGIC facts (Commercial Logic &
    // Billing Setup reuses this same detail array).
    expect(paymentRequests.detail.find(d => d.label === 'Charging rule')?.value).toBe('Charge each issued payment request')
    expect(paymentRequests.detail.find(d => d.label === 'Overage rule')?.value).toBe('Additional charge applies above the contracted threshold of 5,000')
    expect(paymentRequests.detail.find(d => d.label === 'Measurement')?.value).toMatch(/measured for the billing period/)
    // Step 17G.6F, item 3 — "Current billing treatment" -> "Billing
    // treatment" (that label is reserved for a genuine reviewer-gated
    // decision, e.g. Performance Share's own) and never provenance-
    // badged (see page.tsx's isTimingFact check) — a flat usage/overage
    // charge has no typed decision field governing when it's invoiced at
    // all, only unconditional scheduler behavior.
    const billingTreatment = paymentRequests.detail.find(d => d.label === 'Billing treatment')
    expect(billingTreatment?.value).toBe('Prior-period usage is added to the next billing-cycle invoice.')
    expect(billingTreatment?.decisionRequired).toBeFalsy()
    expect(paymentRequests.detail.find(d => d.label === 'Current billing treatment')).toBeUndefined()
    expect(paymentRequests.detail.find(d => d.label === 'Invoice timing')).toBeUndefined()
    // Step 17G.6F, items 3/4 — the new cross-component dependency fact:
    // this fixture's fixed_fee_billing_timing is genuinely unresolved, so
    // this usage component (whose own logic/source are otherwise fully
    // resolved) reads as blocked by that UPSTREAM decision, with the
    // exact supporting sentence requested.
    const invoiceStatus = paymentRequests.detail.find(d => d.label === 'Invoice status')
    expect(invoiceStatus?.value).toBe('Blocked by upstream decision')
    // Step 17G.6G, item 6 — never presumes a specific eventual invoice
    // composition ("combined") — only that finalization is blocked.
    expect(invoiceStatus?.helperText).toBe('Recurring fixed-fee timing must be resolved before invoice finalization.')
    // Step 17G.6D — this fixture's fixed_fee_billing_timing is genuinely
    // unresolved (requires_confirmation: true), so the composition fact
    // must NOT assert what the combined invoice will contain — it must
    // say the decision is pending instead. Matches the real Remembill
    // job's actual current state exactly.
    const invoiceComposition = paymentRequests.detail.find(d => d.label === 'Invoice composition')
    expect(invoiceComposition?.value).toMatch(/pending recurring fixed-fee timing decision/i)
    expect(invoiceComposition?.value).not.toMatch(/never/i)

    const completedPayments = components[2]
    expect(completedPayments.summaryLines[0]).toMatch(/SEK\s*1\.7 \/ completed payment/)
    // No overage tier matches this fee, so no "Overage rule" fact.
    expect(completedPayments.detail.find(d => d.label === 'Charging rule')?.value).toBe('Charge each completed payment')
    expect(completedPayments.detail.find(d => d.label === 'Overage rule')).toBeUndefined()
    expect(completedPayments.detail.find(d => d.label === 'Measurement')?.value).toMatch(/measured for the billing period/)

    const performance = components[3]
    expect(performance.pricingModel).toBe('performance')
    // Never a false "SEK 0" unit price (item 10).
    expect(performance.summaryLines.join(' ')).not.toMatch(/SEK\s*0/)
    expect(performance.detail.find(d => d.label === 'Performance measure')?.value).toBe('Value weighted payment rate')
    expect(performance.detail.find(d => d.label === 'Calculation')?.value).toBe('Paid invoice value ÷ Total invoice value of issued requests')
    // Step 17G.6E, item 10 — capitalized like every other humanized value.
    expect(performance.detail.find(d => d.label === 'Charge basis')?.value).toBe('Total invoice value of issued requests')
    expect(performance.detail.find(d => d.label === 'Rate selection')?.value).toBe('Contractual rate schedule')
    expect(performance.detail.find(d => d.label === 'Measurement')?.value).toBe('Calculated after the billing period closes.')
    // Step 17G.6G — reverted 17G.6F's "Performance-share invoice timing"
    // relabel: generic "Invoice timing," generic question — reusable for
    // any performance/outcome-based mechanism, not just one literally
    // named "performance share."
    expect(performance.detail.find(d => d.label === 'Invoice timing')).toEqual({
      label: 'Invoice timing', value: 'Decision required', decisionRequired: true,
      helperText: 'When should the calculated variable charge be invoiced?',
    })
    // Step 17G.6A, item 5 — required inputs, deduplicated (basis_input_key
    // here is the SAME key as denominator_input_key — must appear once).
    const requiredInputLabels = performance.detail.filter(d => d.value === 'Source: Manual operational input').map(d => d.label)
    expect(requiredInputLabels).toEqual(['Paid invoice value', 'Total invoice value of issued requests'])
    // Step 17G.6F, item 5 — "Used to calculate" -> "Calculation flow": the
    // full step-by-step chain, one step per line.
    const calculationFlow = performance.detail.find(d => d.label === 'Calculation flow')
    expect(calculationFlow?.value).toBe([
      'Paid invoice value',
      '÷ Total invoice value of issued requests',
      '→ Value weighted payment rate',
      '→ Applicable contractual rate',
      '→ Performance-share charge',
    ].join('\n'))
    expect(performance.detail.find(d => d.label === 'Used to calculate')).toBeUndefined()
    expect(performance.rateSchedule).toHaveLength(2)
    expect(performance.hasUnresolvedDecision).toBe(true)
  })

  it('outcome/performance-only agreement (no fixed, no usage): only a performance component', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Outcome fee',
        percentage_of_basis: {
          derived_metric: { metric_key: 'conversion_rate', numerator_input_key: 'a', denominator_input_key: 'b' },
          rate_schedule: { bands: [{ from: 0, to: null, rate_pct: 10 }] },
          basis_input_key: 'a',
        },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components).toHaveLength(1)
    expect(components[0].pricingModel).toBe('performance')
    // Step 17H.3C2 — rateSchedule/the "Rate selection" detail row must
    // populate generically from percentage_of_basis, never from title-text
    // matching against a specific fee_label like "Performance share." This
    // fixture is deliberately named "Outcome fee" to prove exactly that.
    expect(components[0].rateSchedule).toEqual([{ from: 0, to: null, rate_pct: 10 }])
    expect(components[0].detail.find(d => d.label === 'Rate selection')?.value).toBe('Contractual rate schedule')
  })

  it('fixed and usage components never carry a rateSchedule — only a percentage_of_basis fee does', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      additional_recurring_fees: [{ fee_label: 'API calls', rate_per_unit: 0.01, metric_name: 'api_call' }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components.map(c => c.pricingModel)).toEqual(['fixed', 'usage'])
    expect(components[0].rateSchedule).toBeUndefined()
    expect(components[1].rateSchedule).toBeUndefined()
  })

  it('a fixed fee with no discount/proration/billing-timing/rolling-band still resolves safely — Recurring fixed-fee timing correctly still Decision required when the field is simply absent', () => {
    const terms: CommercialComponentsTerms = { base_monthly_fee: 500 }
    const components = buildCommercialComponents(terms, 'EUR')
    // Step 17G.6G — same generic question regardless of pilot presence.
    expect(components[0].detail.find(d => d.label === 'Recurring fixed-fee timing')).toEqual({
      label: 'Recurring fixed-fee timing', value: 'Decision required', decisionRequired: true,
      helperText: 'When should the recurring fixed fee be invoiced?',
    })
    expect(components[0].detail.find(d => d.label === 'Pilot')).toBeUndefined()
    expect(components[0].detail.find(d => d.label === 'Volume adjustment')).toBeUndefined()
    expect(components[0].bandTable).toBeUndefined()
  })

  it('a confirmed (non-unresolved) fixed_fee_billing_timing never shows "Decision required"', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 500,
      fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false },
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const billingTiming = components[0].detail.find(d => d.label === 'Recurring fixed-fee timing')
    expect(billingTiming?.value).toBe('Invoiced at the beginning of each billing period')
    expect(billingTiming?.decisionRequired).toBeFalsy()
    expect(components[0].hasUnresolvedDecision).toBe(false)
  })

  // Step 17H.3C1 — a band-resolution failure previously made the
  // "Selected band" row disappear entirely from `detail` (it was only
  // ever pushed when bandResolution.status === 'resolved'), silently
  // hiding the only visible signal a band-selection failure had. Both
  // failure modes the resolver actually reports must now surface, using
  // its own reason text verbatim — never a second, invented vocabulary.
  it('committed volume outside every band: "Selected band" row shows the resolver\'s own reason, never disappears', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 2000,
      base_fee_bands: [
        { from_unit: 0, to_unit: 500, monthly_fee: 250 },
        { from_unit: 501, to_unit: 5000, monthly_fee: 2000 },
      ] as CommercialComponentsTerms['base_fee_bands'],
      base_fee_committed_volume: 15000,
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components[0]
    expect(fixed.bandResolution).toEqual({ status: 'no_match', reason: 'committed volume 15000 falls outside every band in the table' })
    const selectedBand = fixed.detail.find(d => d.label === 'Selected band')
    expect(selectedBand?.value).toBe('⚠ Pricing band unresolved — committed volume 15000 falls outside every band in the table')
    // Contracted volume itself is a known, factual value — still shown
    // even though it couldn't be resolved to a band.
    expect(fixed.detail.find(d => d.label === 'Contracted volume')?.value).toBe('15,000')
    // The full contractual schedule remains available for inspection
    // regardless of resolution outcome (item 10) — bandTable is never
    // cleared just because resolution failed.
    expect(fixed.bandTable).toHaveLength(2)
  })

  it('band table present but no committed volume known: "Selected band" row surfaces the missing-input reason, never disappears', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 2000,
      base_fee_bands: [{ from_unit: 0, to_unit: null, monthly_fee: 2000 }] as CommercialComponentsTerms['base_fee_bands'],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components[0]
    expect(fixed.bandResolution).toEqual({ status: 'no_match', reason: 'no committed volume is known to select a band with' })
    expect(fixed.detail.find(d => d.label === 'Selected band')?.value).toBe('⚠ Pricing band unresolved — no committed volume is known to select a band with')
    // No committed volume known — the "Contracted volume" row correctly
    // never appears at all (never a fabricated "—" value where the fact
    // is genuinely absent).
    expect(fixed.detail.find(d => d.label === 'Contracted volume')).toBeUndefined()
  })
})

describe('buildUsageComponents Invoice composition — Step 17G.6D (items 21-26)', () => {
  const usageFee: CommercialComponentsTerms['additional_recurring_fees'] = [
    { fee_label: 'Per-widget fee', rate_per_unit: 1, metric_name: 'widget' },
  ]

  it('no fixed fee at all: Invoice composition AND Invoice status are both omitted — nothing to combine with, nothing upstream to be blocked by', () => {
    const terms: CommercialComponentsTerms = { additional_recurring_fees: usageFee }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components[0].detail.find(d => d.label === 'Invoice composition')).toBeUndefined()
    expect(components[0].detail.find(d => d.label === 'Invoice status')).toBeUndefined()
  })

  it('Step 17G.6F, item 9 — a component can be Billing logic ready while its Invoice status is Blocked by upstream decision at the same time', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 100, additional_recurring_fees: usageFee,
      fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true },
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const usage = components.find(c => c.pricingModel === 'usage')!
    // The usage component's OWN logic has no unresolved decision of its
    // own (hasUnresolvedDecision reflects only this component's rows).
    expect(usage.hasUnresolvedDecision).toBe(false)
    expect(usage.detail.find(d => d.label === 'Invoice status')?.value).toBe('Blocked by upstream decision')
  })

  it('resolved fixed timing (either value): Invoice status reads Ready for invoice, with no helper text', () => {
    for (const timing of ['bill_at_period_start', 'bill_at_period_end'] as const) {
      const terms: CommercialComponentsTerms = {
        base_monthly_fee: 100, additional_recurring_fees: usageFee,
        fixed_fee_billing_timing: { timing, requires_confirmation: false },
      }
      const components = buildCommercialComponents(terms, 'EUR')
      const invoiceStatus = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice status')
      expect(invoiceStatus?.value).toBe('Ready for invoice')
      expect(invoiceStatus?.helperText).toBeUndefined()
    }
  })

  it('fixed fee present, no fixed_fee_billing_timing rule at all: pending, not asserted', () => {
    const terms: CommercialComponentsTerms = { base_monthly_fee: 100, additional_recurring_fees: usageFee }
    const components = buildCommercialComponents(terms, 'EUR')
    const composition = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice composition')
    expect(composition?.value).toMatch(/pending recurring fixed-fee timing decision/i)
  })

  it('fixed fee present, fixed_fee_billing_timing unresolved: pending, mentions transmission is held, and — item 5 — says NOTHING about eventual invoice content', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 100, additional_recurring_fees: usageFee,
      fixed_fee_billing_timing: { timing: 'unclear', requires_confirmation: true },
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const composition = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice composition')
    expect(composition?.value).toBe('Pending recurring fixed-fee timing decision. Invoice transmission remains on hold until this decision is resolved.')
    expect(composition?.value).not.toMatch(/carries|contains|combined/i)
  })

  it('resolved bill_at_period_start: states the combination as current fact, exact wording', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 100, additional_recurring_fees: usageFee,
      fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false },
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const composition = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice composition')
    expect(composition?.value).toBe('Prior-period usage is combined with the current period’s recurring fixed fee.')
  })

  it('resolved bill_at_period_end: re-verified independently (not assumed identical) — same combination, worded for the later release date', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 100, additional_recurring_fees: usageFee,
      fixed_fee_billing_timing: { timing: 'bill_at_period_end', requires_confirmation: false },
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const composition = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice composition')
    expect(composition?.value).toBe('Prior-period usage is combined with the current period’s recurring fixed fee, invoiced at the end of that period.')
    expect(composition?.value).not.toBe('Prior-period usage is combined with the current period’s recurring fixed fee.')
  })

  it('never phrases the composition fact as an eternal guarantee ("never") or contractual truth, in any state', () => {
    const cases: CommercialComponentsTerms[] = [
      { base_monthly_fee: 100, additional_recurring_fees: usageFee },
      { base_monthly_fee: 100, additional_recurring_fees: usageFee, fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false } },
      { base_monthly_fee: 100, additional_recurring_fees: usageFee, fixed_fee_billing_timing: { timing: 'bill_at_period_end', requires_confirmation: false } },
    ]
    for (const terms of cases) {
      const components = buildCommercialComponents(terms, 'EUR')
      const composition = components.find(c => c.pricingModel === 'usage')!.detail.find(d => d.label === 'Invoice composition')
      expect(composition?.value).not.toMatch(/\bnever\b/i)
      expect(composition?.value).not.toMatch(/contractual (commitment|truth)/i)
    }
  })
})

// Step 17H.4B0D4H1B4E2.2 §19 — required-inputs grouping, generic across
// arbitrary contract shapes (no fixture-specific keys/labels).
describe('operational-input required-inputs grouping — Step 17H.4B0D4H1B4E2.2', () => {
  it('a usage fee\'s own required input AND its matched tier\'s required input group onto the SAME component, deduplicated', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Widget usage', rate_per_unit: 2, metric_name: 'widget', semantic_input_key: 'widget_count',
        required_operational_inputs: ['some_running_balance'],
      }],
      overage_tiers: [{
        tier_label: 'Widget overage', unit_type: 'widget', semantic_input_key: 'widget_count', rate_per_unit: 3, from_unit: 100,
        required_operational_inputs: ['some_running_balance', 'contract_year_start_reading'],
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const usage = components.find(c => c.pricingModel === 'usage')!
    const inputRows = usage.detail.filter(d => d.value === 'Source: Manual operational input')
    // deduplicated: 'some_running_balance' appears on both sides but only
    // once as a row; 'contract_year_start_reading' appears once.
    expect(inputRows).toHaveLength(2)
    expect(inputRows.map(r => r.label).sort()).toEqual(['Contract year start reading', 'Some running balance'].sort())
    expect(usage.consumedOperationalInputKeys?.sort()).toEqual(['contract_year_start_reading', 'some_running_balance'])
  })

  it('business label (humanized) leads; the technical key never leaks into the row label directly', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{ fee_label: 'Metered fee', rate_per_unit: 1, metric_name: 'unit', required_operational_inputs: ['arbitrary_raw_key_123'] }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const row = components[0].detail.find(d => d.value === 'Source: Manual operational input')!
    expect(row.label).toBe(humanizeKey('arbitrary_raw_key_123'))
    expect(row.label).not.toBe('arbitrary_raw_key_123')
  })

  it('two DIFFERENT usage fees each get their own required-input row on their own component — never merged into one owner', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [
        { fee_label: 'Fee A', rate_per_unit: 1, metric_name: 'a', required_operational_inputs: ['fee_a_input'] },
        { fee_label: 'Fee B', rate_per_unit: 1, metric_name: 'b', required_operational_inputs: ['fee_b_input'] },
      ],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const a = components.find(c => c.title === 'Fee A')!
    const b = components.find(c => c.title === 'Fee B')!
    expect(a.consumedOperationalInputKeys).toEqual(['fee_a_input'])
    expect(b.consumedOperationalInputKeys).toEqual(['fee_b_input'])
  })

  it('a percentage_of_basis fee\'s numerator/denominator/basis inputs are reported as consumed (already surfaced as "Required inputs" rows)', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Performance fee',
        percentage_of_basis: {
          derived_metric: { metric_key: 'success_rate', numerator_input_key: 'successful_count', denominator_input_key: 'total_count' },
          rate_schedule: { bands: [{ from: 0, to: null, rate_pct: 5 }] },
          basis_input_key: 'total_count',
        },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const perf = components.find(c => c.pricingModel === 'performance')!
    expect(perf.consumedOperationalInputKeys?.sort()).toEqual(['successful_count', 'total_count'])
  })

  it('a rolling-band migration\'s own required operational input is reported as consumed by the fixed component, even though it has no separate "Required inputs" row (already stated in "Volume adjustment")', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      unsupported_commercial_mechanisms: [{
        execution_status: 'executable',
        required_operational_inputs: ['measured_volume_metric'],
        rolling_band_migration: { aggregate: { input_key: 'measured_volume_metric', window_count: 3 } },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components.find(c => c.pricingModel === 'fixed')!
    expect(fixed.consumedOperationalInputKeys).toContain('measured_volume_metric')
    expect(fixed.detail.some(d => d.value === 'Source: Manual operational input')).toBe(false)
  })

  it('Step 17H.4B0D4H1B4E7.1 §11/§12 — the "Volume adjustment" row (the collapsed-section default summary) states the commercial EFFECT concisely, not the measurement mechanics; the mechanics move to a separate, still-grouped "Volume adjustment measurement" row', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      unsupported_commercial_mechanisms: [{
        execution_status: 'executable',
        required_operational_inputs: ['measured_volume_metric'],
        rolling_band_migration: { aggregate: { input_key: 'measured_volume_metric', window_count: 3 } },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components.find(c => c.pricingModel === 'fixed')!
    expect(fixed.detail.find(d => d.label === 'Volume adjustment')?.value).toBe('Rolling 3-period average determines future pricing band')
    expect(fixed.detail.find(d => d.label === 'Volume adjustment measurement')?.value)
      .toBe('Measured using measured volume metric, evaluated as a rolling average over the last 3 completed billing periods.')
  })

  it('no window_count known — the concise summary falls back to the existing generic sentence, no measurement row added', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      unsupported_commercial_mechanisms: [{
        execution_status: 'executable',
        rolling_band_migration: {},
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components.find(c => c.pricingModel === 'fixed')!
    expect(fixed.detail.find(d => d.label === 'Volume adjustment')?.value).toContain('rolling-volume rule')
    expect(fixed.detail.find(d => d.label === 'Volume adjustment measurement')).toBeUndefined()
  })

  it('an unresolved (non-executable) mechanism\'s required input is NOT marked consumed — it has no real owning component yet', () => {
    const terms: CommercialComponentsTerms = {
      base_monthly_fee: 1000,
      unsupported_commercial_mechanisms: [{
        execution_status: 'unsupported',
        required_operational_inputs: ['unrelated_metric'],
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const fixed = components.find(c => c.pricingModel === 'fixed')!
    expect(fixed.consumedOperationalInputKeys ?? []).not.toContain('unrelated_metric')
  })
})

// Step 17H.4B0D4H1B4E2.5 §9-13/37 — a flat per-unit fee whose RATE is
// itself a derived metric (distinct from percentage_of_basis — still a
// plain usage charge, never reclassified as Performance) owns its
// derived_metric.raw_inputs via a typed relationship, never a label guess.
describe('derived-metric input ownership on usage fees — Step 17H.4B0D4H1B4E2.5', () => {
  it('a usage fee\'s derived_metric.raw_inputs are attributed to THAT fee, not orphaned', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Derived-rate fee', rate_per_unit: 1.7, metric_name: 'completed_payment',
        derived_metric: { metric_name: 'value_weighted_rate', formula: 'raw_input_a / raw_input_b', raw_inputs: ['raw_input_a', 'raw_input_b'] },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const usage = components.find(c => c.pricingModel === 'usage')!
    expect(usage.consumedOperationalInputKeys?.sort()).toEqual(['raw_input_a', 'raw_input_b'])
    const rows = usage.detail.filter(d => d.value === 'Source: Manual operational input')
    expect(rows.map(r => r.label).sort()).toEqual([humanizeKey('raw_input_a'), humanizeKey('raw_input_b')].sort())
  })

  it('the derived-metric fee still classifies as usage (Variable), never Performance — percentage_of_basis is a genuinely different mechanism', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Derived-rate fee', rate_per_unit: 1.7, metric_name: 'completed_payment',
        derived_metric: { metric_name: 'value_weighted_rate', formula: 'x / y', raw_inputs: ['x', 'y'] },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components).toHaveLength(1)
    expect(components[0].pricingModel).toBe('usage')
  })

  it('surfaces the derived_metric formula as a "Rate calculation" row, read straight off the typed field', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{
        fee_label: 'Derived-rate fee', rate_per_unit: 1.7, metric_name: 'completed_payment',
        derived_metric: { metric_name: 'value_weighted_rate', formula: 'paid_invoice_value / total_invoice_value', raw_inputs: ['paid_invoice_value', 'total_invoice_value'] },
      }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    const calc = components[0].detail.find(d => d.label === 'Rate calculation')
    expect(calc?.value).toBe('paid_invoice_value / total_invoice_value')
  })

  it('a plain usage fee with no derived_metric shows no "Rate calculation" row', () => {
    const terms: CommercialComponentsTerms = {
      additional_recurring_fees: [{ fee_label: 'Plain fee', rate_per_unit: 1, metric_name: 'unit' }],
    }
    const components = buildCommercialComponents(terms, 'EUR')
    expect(components[0].detail.some(d => d.label === 'Rate calculation')).toBe(false)
  })
})

// Step 17H.4B0D4H1B4E5.2 — the live-reproduced "dangerous state" this pass
// fixes: requires_confirmation:false used to read as fully resolved
// ('Invoiced at period end', decisionRequired:false) even for
// invoice_at_period_end, which has no execution path
// (lib/rule-interpretation.ts's isVariableInvoiceTimingConfirmed). This
// must get its own honest third state, distinct from both a genuinely
// resolved decision and an untouched one.
describe('buildPerformanceComponents — Invoice timing execution-awareness (Step 17H.4B0D4H1B4E5.2)', () => {
  function performanceTerms(variableInvoiceTiming: { timing: 'invoice_at_next_period_start' | 'invoice_at_period_end' | 'unclear'; requires_confirmation: boolean } | null): CommercialComponentsTerms {
    return {
      additional_recurring_fees: [{
        fee_label: 'Performance share', metric_name: 'value_weighted_payment_rate',
        percentage_of_basis: {
          derived_metric: { metric_key: 'value_weighted_payment_rate', numerator_input_key: 'paid_invoice_value', denominator_input_key: 'total_invoice_value_of_issued_requests' },
          rate_schedule: { bands: [{ from: 0, to: null, rate_pct: 4.5 }] },
          basis_input_key: 'total_invoice_value_of_issued_requests',
        },
        variable_invoice_timing: variableInvoiceTiming ?? undefined,
      }],
    }
  }

  it('the ONE executable value (invoice_at_next_period_start, confirmed) is fully resolved — no decision required', () => {
    const components = buildCommercialComponents(performanceTerms({ timing: 'invoice_at_next_period_start', requires_confirmation: false }), 'SEK')
    expect(components[0].detail.find(d => d.label === 'Invoice timing')).toEqual({
      label: 'Invoice timing', value: 'Invoiced at start of next period', decisionRequired: false, helperText: undefined,
    })
    expect(components[0].hasUnresolvedDecision).toBe(false)
  })

  it('CONFIRMED (requires_confirmation:false) but to the non-executable invoice_at_period_end value: a distinct "needs configuration" state, still flagged as a decision requiring attention', () => {
    const components = buildCommercialComponents(performanceTerms({ timing: 'invoice_at_period_end', requires_confirmation: false }), 'SEK')
    const row = components[0].detail.find(d => d.label === 'Invoice timing')
    expect(row?.decisionRequired).toBe(true)
    expect(row?.value).toBe('Invoiced at period end — needs configuration')
    // Never the generic "Decision required" — this reads differently from
    // "nothing chosen yet" (next test), since the reviewer DID decide.
    expect(row?.value).not.toBe('Decision required')
    expect(row?.helperText).toMatch(/execution path/i)
    expect(components[0].hasUnresolvedDecision).toBe(true)
  })

  it('never confirmed at all (requires_confirmation:true): the ordinary "Decision required" state, unchanged', () => {
    const components = buildCommercialComponents(performanceTerms({ timing: 'unclear', requires_confirmation: true }), 'SEK')
    expect(components[0].detail.find(d => d.label === 'Invoice timing')).toEqual({
      label: 'Invoice timing', value: 'Decision required', decisionRequired: true,
      helperText: 'When should the calculated variable charge be invoiced?',
    })
  })

  it('absent entirely (no rule attached at all): also the ordinary "Decision required" state', () => {
    const components = buildCommercialComponents(performanceTerms(null), 'SEK')
    expect(components[0].detail.find(d => d.label === 'Invoice timing')).toEqual({
      label: 'Invoice timing', value: 'Decision required', decisionRequired: true,
      helperText: 'When should the calculated variable charge be invoiced?',
    })
  })
})
