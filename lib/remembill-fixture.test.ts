import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms, REMEMBILL_PERFORMANCE_SHARE_SCHEDULE } from './remembill-fixture'
import { buildLineItems } from './line-items'
import { computeCommittedFixedFees } from './contract-tcv-calc'
import { resolveCommittedFixedFeeValue } from './committed-fixed-fee-resolver'
import { resolveFixedFeeBand } from './fixed-fee-band'
import { computeMetricOverage } from './tariff'
import { formatRenewalNoticePeriod } from './contract-notice-period'
import { detectPII, maskText } from './pii-detector'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17A, item 15 — full regression matrix against the CORRECT extraction
// shape for Remembill_Kundavtal_SV.pdf (NordicFit Test AB / CoAccept AB).
// See lib/remembill-fixture.ts's own header for why this is a synthetic
// ContractTerms fixture, not a raw-PDF/live-AI-extraction test.
// ═══════════════════════════════════════════════════════════════════════════

describe('Remembill fixture — expected first-pass extraction result', () => {
  const terms = buildRemembillFixtureTerms()

  it('customer, currency, term, renewal notice, contracted volume', () => {
    expect(terms.customer_name).toBe('NordicFit Test AB')
    expect(terms.currency).toBe('EUR')
    expect(terms.contract_term_months).toBe(12)
    expect(terms.contract_start_date).toBe('2026-10-01')
    expect(formatRenewalNoticePeriod(terms)).toBe('3 months notice required')
    expect(terms.base_fee_committed_volume).toBe(5000)
  })

  it('fixed platform: selected band 1,501–5,000 -> €2,000/month, full band table preserved', () => {
    const band = resolveFixedFeeBand(terms.base_fee_bands, terms.base_fee_committed_volume)
    expect(band).toEqual({ status: 'resolved', band: { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 } })
    expect(terms.base_monthly_fee).toBe(2000)
  })

  it('request fee: €0.38 / issued request, variable — no fixed committed quantity', () => {
    const fee = terms.additional_recurring_fees!.find(f => f.fee_label === 'Per payment request fee')!
    expect(fee.rate_per_unit).toBe(0.38)
    expect(fee.metric_name).toBe('issued_payment_request')
    expect(fee.amount).toBe(0)
  })

  it('success fee: €1.70 / completed payment, variable — no fixed committed quantity', () => {
    const fee = terms.additional_recurring_fees!.find(f => f.fee_label === 'Success fee per completed payment')!
    expect(fee.rate_per_unit).toBe(1.7)
    expect(fee.metric_name).toBe('completed_payment')
    expect(fee.amount).toBe(0)
  })

  it('excess surcharge: €0.60 / request above 5,000, additive, exact dependency pair', () => {
    const tier = terms.overage_tiers[0]
    expect(tier.rate_per_unit).toBe(0.6)
    expect(tier.from_unit).toBe(5001)
    expect(tier.required_operational_inputs).toEqual(['issued_payment_request_count', 'contracted_volume'])
    const surchargeAt6000 = computeMetricOverage(6000, terms.overage_tiers, terms.included_units!, true).amount
    expect(surchargeAt6000).toBe(600) // 0.60 x 1,000 excess, never 0.60 x 6,000
  })

  it('pilot: 90 days preserved as contract-derived duration; scope is left for review (never preselected here)', () => {
    const pilot = terms.discounts[0]
    expect(pilot.duration_days).toBe(90)
    expect(pilot.duration_months).toBeNull()
    expect(pilot.applies_to).toBe('fixed platform fee') // named scope only — not "entire platform charge"
    expect(pilot.interpretation).toBeUndefined() // no interpretation pre-selected on the bare extracted record
  })

  it('performance mechanism: extracted, derived-rate formula preserved, exact direct dependency only, executable as of Step 17C.1', () => {
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    expect(perf.unresolved_kind).toBeNull()
    expect(perf.amount).toBe(0)
    // Hardening item 5 — the derived rate's OWN formula/raw inputs live in
    // derived_metric; required_operational_inputs holds only this fee's
    // additional direct dependency (never the request/success fees' counts,
    // which belong to THOSE fees, not this one).
    expect(perf.derived_metric).toEqual({
      metric_name: 'value_weighted_payment_rate',
      formula: 'paid_invoice_value / total_invoice_value_of_issued_requests',
      raw_inputs: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
    })
    expect(perf.required_operational_inputs).toEqual(['total_invoice_value_of_issued_requests'])
    expect(perf.description).toMatch(/4\.50%/)
    // Step 17C.1 — the TYPED, executable counterpart alongside derived_metric.
    expect(perf.percentage_of_basis).toEqual({
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
    })
  })

  it('rolling three-month transition: extracted into unsupported_commercial_mechanisms, NOT additional_recurring_fees (it is not a fee)', () => {
    expect(terms.additional_recurring_fees!.some(f => f.fee_label === 'Rolling three-month average repricing transition')).toBe(false)
    const rolling = terms.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')!
    expect(rolling).toBeDefined()
    expect(rolling.execution_status).toBe('executable')
    expect(rolling.source_clause).toContain('tremånaderssnitt')
  })

  it('hardening review item 2 — rolling transition is a VOLUME migration, not a rate recalculation: its ONLY dependency is issued_payment_request_count', () => {
    // Contract: "if the three-month average is above the agreed volume,
    // the operator moves to the corresponding level from the next
    // contract period" — this averages the REQUEST COUNT to decide which
    // base_fee_bands row applies, never the paid/total invoice-value ratio
    // (that ratio belongs solely to the separate value-weighted
    // performance-share mechanism).
    const rolling = terms.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')!
    expect(rolling.required_operational_inputs).toEqual(['issued_payment_request_count'])
  })

  it('hardening review item 2 (regression) — the rolling transition must never acquire the performance fee\'s inputs (paid/total invoice value)', () => {
    const rolling = terms.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')!
    expect(rolling.required_operational_inputs).not.toContain('paid_invoice_value')
    expect(rolling.required_operational_inputs).not.toContain('total_invoice_value_of_issued_requests')
    expect(rolling.required_operational_inputs).not.toContain('completed_payment_count')

    // The two mechanisms stay fully disjoint in their dependencies — the
    // rolling transition's inputs and the performance fee's inputs
    // (required_operational_inputs + derived_metric.raw_inputs combined)
    // never overlap.
    const perf = terms.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')!
    const perfInputs = new Set([
      ...(perf.required_operational_inputs ?? []),
      ...(perf.derived_metric?.raw_inputs ?? []),
    ])
    for (const input of rolling.required_operational_inputs ?? []) {
      expect(perfInputs.has(input)).toBe(false)
    }
  })
})

describe('Remembill fixture — the NO list (item 15)', () => {
  const terms = buildRemembillFixtureTerms()
  const items = buildLineItems(terms, 'EUR')

  it('does NOT produce €2,002.08/month as the fixed platform figure', () => {
    // Hardening item 2 (review pass 4) — computeDiscountMultiplier now
    // correctly applies the pilot waiver unconditionally (the same
    // machinery real invoices use doesn't gate on reviewer-confirmation
    // state, only on the raw discount fields), so the €0 pilot months are
    // no longer billed at all (buildLineItems skips zero-rate periods —
    // see lib/line-items.ts) and the full-rate months form their own row,
    // labelled by period range rather than the single-row "Recurring base
    // fee" name (which only applies when every period shares one rate).
    const base = items.find(i => i.product_name.startsWith('Recurring base fee'))
    expect(base!.unit_price).not.toBeCloseTo(2002.08, 1)
    expect(base!.unit_price).toBe(2000)
  })

  it('does NOT produce quantity 12 on the request/success fee line items', () => {
    const request = items.find(i => i.product_name === 'Per payment request fee')!
    const success = items.find(i => i.product_name === 'Success fee per completed payment')!
    expect(request.quantity).not.toBe(12)
    expect(success.quantity).not.toBe(12)
    expect(request.quantity).toBe(0)
    expect(success.quantity).toBe(0)
  })

  it('does NOT produce €18,024.96 as committed fixed fees under any state tested below', () => {
    const committed = computeCommittedFixedFees(items)
    expect(committed).not.toBeCloseTo(18024.96, 1)
  })

  it('hardening item 1 (review pass 4) — MATERIALITY: the pilot-scope decision is a 100% waiver of the NAMED fixed component, so it does NOT block committed fixed fees on its own, even while unresolved', () => {
    // Pilot scope interpretation is deliberately left unconfirmed
    // (terms.discounts[0].interpretation is undefined) — only the
    // partial-period decision is confirmed below. If materiality worked
    // correctly, that alone is enough to reach 'ready'.
    const confirmedTerms = {
      ...terms,
      base_fee_proration: { ...terms.base_fee_proration!, requires_confirmation: false, prorate_partial_periods: false as const },
    }
    expect(confirmedTerms.discounts[0].interpretation).toBeUndefined() // still unconfirmed
    const confirmedItems = buildLineItems(confirmedTerms, 'EUR')
    const resolution = resolveCommittedFixedFeeValue(confirmedItems, confirmedTerms.discounts, confirmedTerms.base_fee_proration)
    expect(resolution.status).toBe('ready')
    expect(resolution.reasons).toEqual([])
  })

  it('hardening item 1 (review pass 4) — the partial-period decision DOES materially affect committed fixed fees and blocks it until resolved', () => {
    const resolution = resolveCommittedFixedFeeValue(items, terms.discounts, terms.base_fee_proration)
    expect(resolution.status).toBe('unresolved')
    expect(resolution.amount).toBeNull()
    expect(resolution.reasons.some(r => /partial-period/i.test(r))).toBe(true)
    // The pilot-scope reason is correctly ABSENT — materiality excludes an
    // unresolved decision that cannot change this specific figure.
    expect(resolution.reasons.some(r => /pilot/i.test(r))).toBe(false)
  })

  it('review pass 4, item 2 — option "start fixed platform from next full billing period" -> exact amount €18,000, computed by the SAME buildLineItems/computeDiscountMultiplier machinery real invoices use, never €24,000', () => {
    const confirmedTerms = {
      ...terms,
      base_fee_proration: { ...terms.base_fee_proration!, requires_confirmation: false, prorate_partial_periods: false as const },
    }
    const confirmedItems = buildLineItems(confirmedTerms, 'EUR')
    const resolution = resolveCommittedFixedFeeValue(confirmedItems, confirmedTerms.discounts, confirmedTerms.base_fee_proration)
    expect(resolution.status).toBe('ready')
    expect(resolution.amount).toBe(18000) // Oct/Nov/Dec waived, Jan-Sep (9mo) x €2,000
    expect(resolution.amount).not.toBe(24000)
    // Zero-rate pilot months (Oct/Nov/Dec) are correctly skipped entirely
    // by buildLineItems (see lib/line-items.ts) rather than billed — the
    // remaining 9 full-price months form their own row (labelled by period
    // range, since not every period shares the same rate).
    const base = confirmedItems.find(i => i.product_name.startsWith('Recurring base fee'))!
    expect(base.total_amount).toBe(18000)
    expect(base.unit_price).toBe(2000)
    expect(base.quantity).toBe(9)
  })

  it('review pass 4, item 2 — option "prorate fixed platform from pilot expiry" -> the deterministic engine cannot yet compute day-level proration for a contract_start-anchored fee, so status stays unresolved rather than a fabricated amount', () => {
    const confirmedTerms = {
      ...terms,
      base_fee_proration: { ...terms.base_fee_proration!, requires_confirmation: false, prorate_partial_periods: true as const },
    }
    const confirmedItems = buildLineItems(confirmedTerms, 'EUR')
    const resolution = resolveCommittedFixedFeeValue(confirmedItems, confirmedTerms.discounts, confirmedTerms.base_fee_proration)
    expect(resolution.status).toBe('unresolved')
    expect(resolution.amount).toBeNull()
    expect(resolution.reasons.some(r => /day-level proration/i.test(r))).toBe(true)
  })

  it('review pass 4 — €24,000 cannot reappear after the partial-period decision is confirmed, under either the supported or the not-yet-supported option', () => {
    for (const prorate of [false, true]) {
      const confirmedTerms = {
        ...terms,
        base_fee_proration: { ...terms.base_fee_proration!, requires_confirmation: false, prorate_partial_periods: prorate },
      }
      const confirmedItems = buildLineItems(confirmedTerms, 'EUR')
      const resolution = resolveCommittedFixedFeeValue(confirmedItems, confirmedTerms.discounts, confirmedTerms.base_fee_proration)
      expect(resolution.amount).not.toBe(24000)
    }
  })

  it('does NOT silently convert "3 months" notice into "90 days"', () => {
    expect(formatRenewalNoticePeriod(terms)).not.toMatch(/90 days/)
    expect(formatRenewalNoticePeriod(terms)).toBe('3 months notice required')
  })

  it('does NOT detect "mätt värdeviktat" as a PERSON anywhere in the preserved source clauses', () => {
    const allClauseText = [
      ...terms.additional_recurring_fees!.map(f => f.source_clause ?? ''),
      ...(terms.unsupported_commercial_mechanisms ?? []).map(m => m.source_clause ?? ''),
    ].join('\n')
    const { entities } = detectPII(allClauseText)
    expect(entities.filter(e => e.type === 'PERSON')).toHaveLength(0)
  })

  it('does NOT let unsupported_commercial_mechanisms leak into line items, TCV, or committed fixed fees (hardening item 4)', () => {
    // The rolling-transition mechanism has no fee_label/amount/rate of its
    // own — it structurally cannot appear in buildLineItems' output, since
    // that function only ever reads additional_recurring_fees/
    // one_time_fees/base_monthly_fee/overage_tiers, never
    // unsupported_commercial_mechanisms.
    expect(items.some(i => i.product_name.includes('Rolling') || i.product_name.includes('tremånaderssnitt'))).toBe(false)
    expect(terms.unsupported_commercial_mechanisms!.length).toBeGreaterThan(0)
  })
})

describe('Remembill fixture — masking preserves every commercial figure', () => {
  it('masking the full commercial text leaves every rate/threshold/term intact', () => {
    const terms = buildRemembillFixtureTerms()
    const commercialText = [
      'CoAccept AB (Remembill) och NordicFit Test AB har ingått detta avtal.',
      'Avgift per betalningsförfrågan: 0,38 EUR. Framgångsavgift: 1,70 EUR.',
      'Överskjutande förfrågningar utöver avtalad volym: 0,60 EUR.',
      'Resultatandelen är 4,50 % vid full betalningsgrad.',
      'Avtalad volym: 5 000 betalningsförfrågningar per månad.',
      '90 dagars pilot utan plattformsavgift.',
      [
        ...terms.additional_recurring_fees!.map(f => f.source_clause ?? ''),
        ...(terms.unsupported_commercial_mechanisms ?? []).map(m => m.source_clause ?? ''),
      ].join(' '),
      'Resultatandelen baseras på värdeviktad betalgrad. Övergång till tremånaderssnitt för värdeviktad betalgrad.',
    ].join('\n')
    const { tokenMap } = detectPII(commercialText)
    const masked = maskText(commercialText, tokenMap)
    for (const term of ['0,38', '1,70', '0,60', '5 000', '90 dagar', 'värdeviktad betalgrad', 'tremånaderssnitt']) {
      expect(masked).toContain(term)
    }
    expect(masked).not.toContain('CoAccept AB')
    expect(masked).not.toContain('Remembill')
    expect(masked).not.toContain('NordicFit Test AB')
  })
})
