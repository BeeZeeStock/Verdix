import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { mergeExtractions } from './contract-extractor'
import { buildLineItems } from './line-items'
import { detectPII, maskText, restoreTokensInObject } from './pii-detector'
import { formatRenewalNoticePeriod } from './contract-notice-period'
import { collectOperationalDataInputs } from './operational-data-inputs'
import { discountHasUnresolvedComponentScope, baseFeeHasExpiringWaiver } from './rule-interpretation'
import type { ContractTerms } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17B0.1 — fresh Remembill acceptance corrections, found during a real
// re-upload/re-extraction of the actual PDF through the 17B0 pipeline. Root
// cause for items 1/4/5/6/7 traced to mergeExtractions (see its own comment):
// for a multi-chunk contract, every field NOT explicitly re-merged came only
// from whichever single chunk scored highest on scoreCompleteness's narrow
// criteria — silently discarding the same field's real value when it was
// actually extracted from a DIFFERENT chunk.
// ═══════════════════════════════════════════════════════════════════════════

function minimalTerms(overrides: Partial<ContractTerms>): ContractTerms {
  return {
    contract_id: null, crm_id: null, customer_name: null, customer_address: null,
    billing_contact: null, vendor_name: null, vendor_address: null, order_date: null,
    contract_start_date: null, contract_end_date: null, contract_term_months: null,
    auto_renews: null, renewal_notice_days: null, renewal_notice_months: null,
    customer_email: null, customer_org_number: null, renewal_term_months: null,
    currency: 'EUR', base_monthly_fee: null, base_annual_fee: null,
    base_fee_bands: null, base_fee_committed_volume: null, base_fee_proration: null,
    billing_frequency: null, payment_terms_days: null, payment_terms_text: null,
    included_units: null, included_unit_type: null, year_pricing: null, ramp_schedule: null,
    escalators: [], discounts: [], service_credits: [], overage_tiers: [],
    additional_recurring_fees: [], one_time_fees: [], unsupported_commercial_mechanisms: [],
    field_sources: {}, extraction_confidence: 'medium', extraction_notes: null, number_format: 'dot',
    ...overrides,
  }
}

describe('17B0.1 item 1/4/5/6/7 — mergeExtractions no longer drops a field to a losing chunk', () => {
  it('a scalar field extracted only in a non-"best" chunk survives into the merged result', () => {
    // Chunk A scores highest (has customer_name/base fee/dates/currency) but
    // never saw the org-number/renewal-notice section. Chunk B has those,
    // but scores lower (no base fee table in its own local text).
    const chunkA = minimalTerms({
      customer_name: 'NordicFit Test AB', base_monthly_fee: 2000, contract_start_date: '2026-10-01',
      contract_term_months: 12, discounts: [], overage_tiers: [{ tier_label: 'x', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, unit_type: 'payment request' }],
    })
    const chunkB = minimalTerms({
      customer_org_number: '559999-1234', renewal_notice_months: 3,
    })
    const merged = mergeExtractions([chunkA, chunkB])
    expect(merged.customer_org_number).toBe('559999-1234')
    expect(merged.renewal_notice_months).toBe(3)
  })

  it('base_fee_proration extracted only in a non-"best" chunk survives into the merged result', () => {
    const chunkA = minimalTerms({
      customer_name: 'NordicFit Test AB', base_monthly_fee: 2000, contract_start_date: '2026-10-01',
      contract_term_months: 12, discounts: [{
        discount_pct: 100, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: 90,
        applies_to: 'fixed platform fee', description: '90-day pilot',
        affected_components: ['base_recurring_fee'], possibly_affected_components: ['performance_fee'],
      }], overage_tiers: [],
    })
    const chunkB = minimalTerms({
      base_fee_proration: {
        reset_anchor: 'contract_start', prorate_partial_periods: 'unclear',
        requires_confirmation: true, confirmation_reason: 'waiver expires mid-cycle', source_clause: 'x',
      },
    })
    const merged = mergeExtractions([chunkA, chunkB])
    expect(merged.base_fee_proration?.requires_confirmation).toBe(true)
  })

  it('unsupported_commercial_mechanisms and additional_recurring_fees from every chunk are all preserved, not just the "best" chunk\'s', () => {
    const chunkA = minimalTerms({
      customer_name: 'NordicFit Test AB', base_monthly_fee: 2000, contract_start_date: '2026-10-01',
      contract_term_months: 12,
      additional_recurring_fees: [
        { fee_label: 'Per payment request fee', amount: 0, description: 'EUR 0.38 per issued request', metric_name: 'issued_payment_request', rate_per_unit: 0.38, required_operational_inputs: ['issued_payment_request_count'] },
      ],
    })
    const chunkB = minimalTerms({
      additional_recurring_fees: [
        { fee_label: 'Performance share (value-weighted payment rate)', amount: 0, description: 'variable performance share', unresolved_kind: 'unsupported_semantics', required_operational_inputs: ['total_invoice_value_for_issued_requests'] },
      ],
      unsupported_commercial_mechanisms: [
        { kind: 'rolling_volume_pricing_transition', description: 'volume band migration', required_operational_inputs: ['issued_payment_request_count'], execution_status: 'unsupported' },
      ],
    })
    const merged = mergeExtractions([chunkA, chunkB])
    expect(merged.additional_recurring_fees?.map(f => f.fee_label)).toEqual([
      'Per payment request fee', 'Performance share (value-weighted payment rate)',
    ])
    expect(merged.unsupported_commercial_mechanisms).toHaveLength(1)
    expect(merged.unsupported_commercial_mechanisms![0].kind).toBe('rolling_volume_pricing_transition')
  })

  it('a single-chunk contract (the common case) is completely unaffected — no regression', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    expect(merged.customer_org_number).toBe(terms.customer_org_number)
    expect(merged.renewal_notice_months).toBe(terms.renewal_notice_months)
    expect(merged.unsupported_commercial_mechanisms).toEqual(terms.unsupported_commercial_mechanisms)
  })
})

describe('17B0.1 item 1 — deterministic waiver-expiry safety net (extraction never silently omits base_fee_proration)', () => {
  it('a 90-day pilot from 2026-10-01 (expires 2026-12-30, not a clean month boundary) gets flagged even when the model produced nothing at all', () => {
    const terms = minimalTerms({
      contract_start_date: '2026-10-01', base_monthly_fee: 2000,
      discounts: [{
        discount_pct: 100, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: 90,
        applies_to: 'fixed platform fee', description: '90-day pilot with no fixed platform fee.',
        affected_components: ['base_recurring_fee'], possibly_affected_components: ['performance_fee'],
      }],
    })
    const merged = mergeExtractions([terms])
    expect(merged.base_fee_proration).not.toBeNull()
    expect(merged.base_fee_proration?.requires_confirmation).toBe(true)
    expect(merged.base_fee_proration?.confirmation_reason).toContain('2026-12-30')
  })

  it('a waiver whose expiry DOES land on a clean month boundary is correctly left unflagged by this safety net', () => {
    // 92 days from 2026-10-01 = 2027-01-01, exactly a clean boundary.
    const terms = minimalTerms({
      contract_start_date: '2026-10-01', base_monthly_fee: 2000,
      discounts: [{
        discount_pct: 100, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: 92,
        applies_to: 'fixed platform fee', description: '92-day pilot',
        affected_components: ['base_recurring_fee'], possibly_affected_components: null,
      }],
    })
    const merged = mergeExtractions([terms])
    expect(merged.base_fee_proration).toBeNull()
  })

  it('never overrides an already-populated base_fee_proration, even an unconfirmed one the model reasoned about itself', () => {
    const terms = minimalTerms({
      contract_start_date: '2026-10-01', base_monthly_fee: 2000,
      base_fee_proration: {
        reset_anchor: 'contract_start', prorate_partial_periods: false,
        requires_confirmation: false, confirmation_reason: null, source_clause: 'explicit contract text',
      },
      discounts: [{
        discount_pct: 100, discount_amount: null, discount_type: 'introductory',
        start_date: '2026-10-01', end_date: null, duration_months: null, duration_days: 90,
        applies_to: 'fixed platform fee', description: '90-day pilot',
        affected_components: ['base_recurring_fee'], possibly_affected_components: null,
      }],
    })
    const merged = mergeExtractions([terms])
    expect(merged.base_fee_proration?.requires_confirmation).toBe(false) // untouched
    expect(merged.base_fee_proration?.source_clause).toBe('explicit contract text')
  })

  it('end-to-end: the fresh (unconfirmed) Remembill shape still refuses to materialize Qty 9 / €18,000', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    const items = buildLineItems(merged, 'EUR')
    const base = items.find(i => i.product_name.startsWith('Recurring base fee'))!
    expect(base.product_name).toBe('Recurring base fee — partial-period treatment unresolved')
    expect(base.quantity).not.toBe(9)
    expect(base.total_amount).not.toBe(18000)
  })
})

describe('17B0.1 item 2 — pilot component scope stays bounded to the actual hybrid charge', () => {
  it('the correct target shape has only performance_fee possibly-affected, never the request/success fees', () => {
    const terms = buildRemembillFixtureTerms()
    const pilot = terms.discounts[0]
    expect(pilot.possibly_affected_components).toEqual(['performance_fee'])
    expect(pilot.possibly_affected_components).not.toContain('issued_payment_request')
    expect(pilot.possibly_affected_components).not.toContain('completed_payment')
    expect(discountHasUnresolvedComponentScope(pilot)).toBe(true)
  })
})

describe('17B0.1 item 5 — full masked -> extract -> restore pipeline for customer_org_number (not just a unit test of restoreTokensInObject)', () => {
  it('a real org number in raw text survives detection, masking, simulated extraction, and restoration intact', () => {
    const contractText = [
      'CoAccept AB och NordicFit Test AB har ingått detta avtal.',
      'Kundens organisationsnummer: 559999-1234.',
    ].join('\n')

    // Real detection + masking (no live AI call — same discipline as every
    // other test in this suite).
    const { tokenMap, reverseMap } = detectPII(contractText)
    const masked = maskText(contractText, tokenMap)
    expect(masked).not.toContain('559999-1234')
    const orgToken = [...tokenMap.entries()].find(([value]) => value === '559999-1234')?.[1]
    expect(orgToken).toBeDefined()
    expect(masked).toContain(orgToken!)

    // Simulated extraction: a compliant model (per the PII_MASK_NOTE / this
    // field's own prompt instruction) copies the token verbatim into
    // customer_org_number, exactly as it appears in the masked text it saw.
    const rawTerms = minimalTerms({ customer_org_number: orgToken })

    // Real restoration.
    const restored = restoreTokensInObject(rawTerms, reverseMap)
    expect(restored.customer_org_number).toBe('559999-1234')
  })
})

describe('17B0.1 item 6 — renewal notice preserved as months end to end', () => {
  it('a single-chunk extraction never shows anything but "3 months notice required"', () => {
    const terms = buildRemembillFixtureTerms()
    const merged = mergeExtractions([terms])
    expect(formatRenewalNoticePeriod(merged)).toBe('3 months notice required')
    expect(formatRenewalNoticePeriod(merged)).not.toMatch(/90 days/)
  })
})

describe('17B0.1 item 7 — full fresh-output acceptance regression for the Remembill fixture', () => {
  const terms = buildRemembillFixtureTerms()
  const merged = mergeExtractions([terms])

  it('1. committed fixed fees stay unresolved; fixed line item shows €2,000/month with treatment pending, never Qty 9 / €18,000', () => {
    expect(merged.base_fee_proration?.requires_confirmation).toBe(true)
    const items = buildLineItems(merged, 'EUR')
    const base = items.find(i => i.product_name.startsWith('Recurring base fee'))!
    expect(base.unit_price).toBe(2000)
    expect(base.quantity).toBe(0)
    expect(base.total_amount).toBe(0)
  })

  it('2. pilot scope is bounded to base_recurring_fee (definite) + performance_fee (possible) only', () => {
    const pilot = merged.discounts[0]
    expect(pilot.affected_components).toEqual(['base_recurring_fee'])
    expect(pilot.possibly_affected_components).toEqual(['performance_fee'])
  })

  it('4. the rolling three-month volume transition is present and still unsupported; the performance share fee is present with real execution config (Step 17C.1)', () => {
    const perf = merged.additional_recurring_fees!.find(f => f.fee_label === 'Performance share (value-weighted payment rate)')
    expect(perf?.unresolved_kind).toBeNull()
    expect(perf?.percentage_of_basis).toBeTruthy()
    const rolling = merged.unsupported_commercial_mechanisms!.find(m => m.kind === 'rolling_volume_pricing_transition')
    expect(rolling).toBeDefined()
    expect(rolling!.execution_status).toBe('unsupported')
    expect(rolling!.required_operational_inputs).toEqual(['issued_payment_request_count'])
  })

  it('5. customer org / reg number resolves to 559999-1234', () => {
    expect(merged.customer_org_number).toBe('559999-1234')
  })

  it('6. renewal notice is "3 months"', () => {
    expect(formatRenewalNoticePeriod(merged)).toBe('3 months notice required')
  })

  it('7. all four operational data inputs are collected and correctly classified — never silently dropped', () => {
    const inputs = collectOperationalDataInputs(merged)
    const byKey = new Map(inputs.map(i => [i.key, i]))
    expect(byKey.has('issued_payment_request_count')).toBe(true)
    expect(byKey.has('completed_payment_count')).toBe(true)
    expect(byKey.has('paid_invoice_value')).toBe(true)
    expect(byKey.has('total_invoice_value_of_issued_requests')).toBe(true)
    expect(byKey.get('issued_payment_request_count')?.kind).toBe('countable')
    expect(byKey.get('completed_payment_count')?.kind).toBe('countable')
    expect(byKey.get('paid_invoice_value')?.kind).toBe('monetary')
    expect(byKey.get('total_invoice_value_of_issued_requests')?.kind).toBe('monetary')
  })

  it('C. the base fee proration question is structurally recognized as waiver-expiry, not a generic calendar question', () => {
    expect(baseFeeHasExpiringWaiver(merged.discounts)).toBe(true)
  })
})
