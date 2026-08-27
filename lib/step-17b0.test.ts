import { describe, it, expect } from 'vitest'
import { buildRemembillFixtureTerms } from './remembill-fixture'
import { buildLineItems } from './line-items'
import { restoreTokensInObject } from './pii-detector'
import {
  withAppendixContext,
  getComponentScopeOptions,
  discountHasUnresolvedComponentScope,
  baseFeeHasExpiringWaiver,
  getWaiverExpiryFeeProrationOptions,
  optionsForRuleType,
} from './rule-interpretation'
import { collectOperationalDataInputs } from './operational-data-inputs'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17B0 — full acceptance regression against the actual Remembill
// fixture (lib/remembill-fixture.ts), one describe block per lettered item.
// ═══════════════════════════════════════════════════════════════════════════

describe('17B0 item A — bounded appendix-context assembly', () => {
  it('appends a related clause that shares the same Bilaga marker, labeled by its own source', () => {
    const primary = 'The fee follows the schedule set out in Bilaga 1.'
    const result = withAppendixContext(primary, [
      { label: 'additional_recurring_fees[0].source_clause', text: 'Bilaga 1 states the platform fee table by committed volume.' },
      { label: 'discounts[0].description', text: 'A 90-day pilot waiver applies to the fixed fee.' },
    ])
    expect(result).toContain(primary)
    expect(result).toContain('Bilaga 1 states the platform fee table')
    expect(result).toContain('[additional_recurring_fees[0].source_clause]')
    // The unrelated clause (no Bilaga reference) is never pulled in — bounded, not blind.
    expect(result).not.toContain('90-day pilot waiver')
  })

  it('returns the clause unchanged when it has no appendix/exhibit reference at all', () => {
    const primary = 'A flat monthly fee of EUR 2,000 applies.'
    const result = withAppendixContext(primary, [{ label: 'x', text: 'Bilaga 1 has irrelevant contents.' }])
    expect(result).toBe(primary)
  })

  it('returns the clause unchanged when nothing else references the same appendix', () => {
    const primary = 'See Bilaga 2 for the fee schedule.'
    const result = withAppendixContext(primary, [{ label: 'x', text: 'This mentions Bilaga 1, a different appendix.' }])
    expect(result).toBe(primary)
  })

  it('passes through a null clause unchanged', () => {
    expect(withAppendixContext(null, [{ label: 'x', text: 'Bilaga 1 content' }])).toBeNull()
  })
})

describe('17B0 item B — pilot waiver decision options are scope-bounded, not tier options', () => {
  const terms = buildRemembillFixtureTerms()
  const pilot = terms.discounts[0]

  it('the fixture pilot waiver has a genuinely open component-scope question', () => {
    expect(discountHasUnresolvedComponentScope(pilot)).toBe(true)
    expect(pilot.affected_components).toEqual(['base_recurring_fee'])
    expect(pilot.possibly_affected_components).toEqual(['performance_fee'])
  })

  it('optionsForRuleType generates bounded scope options from the typed components, never graduated/volume/block', () => {
    const options = optionsForRuleType('discount', undefined, null, false, {
      affectedComponents: pilot.affected_components,
      possiblyAffectedComponents: pilot.possibly_affected_components,
    })
    const ids = options.map(o => o.id)
    expect(ids).toEqual(['affected_only', 'affected_plus_possible', 'other'])
    expect(ids).not.toContain('graduated')
    expect(ids).not.toContain('volume')
    expect(ids).not.toContain('block')
  })

  it('option labels are generated from the actual typed component keys, not hardcoded strings', () => {
    const [affectedOnly, affectedPlusPossible] = getComponentScopeOptions(pilot.affected_components, pilot.possibly_affected_components)
    expect(affectedOnly.label).toBe('Fixed platform fee only')
    expect(affectedOnly.description).toContain('fixed platform fee')
    expect(affectedOnly.description).toContain('performance fee')
    expect(affectedPlusPossible.label).toBe('Fixed platform fee + performance fee')
  })

  it('a discount with no open scope question still gets the ordinary tier-mechanics options (unaffected regression)', () => {
    const options = optionsForRuleType('discount', undefined, null, false, { affectedComponents: null, possiblyAffectedComponents: null })
    expect(options.map(o => o.id)).toEqual(['graduated', 'volume', 'block', 'other'])
  })
})

describe('17B0 item C — partial-period options for a waiver expiring mid-cycle, not a generic calendar-anchor question', () => {
  const terms = buildRemembillFixtureTerms()

  it('the fixture base fee proration is structurally recognized as a waiver-expiry trigger', () => {
    expect(baseFeeHasExpiringWaiver(terms.discounts)).toBe(true)
  })

  it('a base fee with no expiring waiver is NOT flagged (unaffected regression)', () => {
    expect(baseFeeHasExpiringWaiver([])).toBe(false)
    expect(baseFeeHasExpiringWaiver(terms.discounts, 'usage_fee')).toBe(false) // component key this discount never touches
  })

  it('waiver-expiry options ask about the waiver, never a generic calendar-anchor question', () => {
    const options = getWaiverExpiryFeeProrationOptions('fixed platform fee')
    const ids = options.map(o => o.id)
    expect(ids).toEqual(['prorate_from_expiry', 'start_next_full_period', 'other'])
    expect(ids).not.toContain('contract_month')
    expect(ids).not.toContain('calendar_full')
    expect(ids).not.toContain('calendar_prorate_days')
    expect(options[0].label).toBe('Prorate fixed platform fee from waiver expiry')
    expect(options[1].label).toBe('Start fixed platform fee from next full billing period')
  })

  it('optionsForRuleType swaps in the waiver-expiry set when the structural signal is true', () => {
    const options = optionsForRuleType('base_fee_proration', 'month', 'the 1st', true)
    expect(options.map(o => o.id)).toEqual(['prorate_from_expiry', 'start_next_full_period', 'other'])
  })

  it('optionsForRuleType keeps the ordinary calendar-anchor set when waiverExpiry is false (unaffected regression)', () => {
    const options = optionsForRuleType('base_fee_proration', 'month', 'the 1st', false)
    expect(options.map(o => o.id)).toContain('calendar_full')
  })
})

describe('17B0 item D — an unresolved base_fee_proration never materializes a concrete multi-period schedule', () => {
  it('the default (unconfirmed) Remembill fixture produces an unresolved marker row, never Qty 9 / €18,000', () => {
    const terms = buildRemembillFixtureTerms()
    expect(terms.base_fee_proration?.requires_confirmation).toBe(true)
    const items = buildLineItems(terms, 'EUR')
    const baseRows = items.filter(i => i.product_name.startsWith('Recurring base fee'))
    expect(baseRows).toHaveLength(1)
    const base = baseRows[0]
    expect(base.product_name).toBe('Recurring base fee — partial-period treatment unresolved')
    expect(base.quantity).toBe(0)
    expect(base.total_amount).toBe(0)
    // The flat committed rate is still preserved, per the explicit request.
    expect(base.unit_price).toBe(2000)
    expect(base.confidence_score).toBeLessThan(0.95) // participates in needsReview gating
  })

  it('once confirmed, buildLineItems resumes producing the real, concrete schedule (unaffected regression — see remembill-fixture.test.ts review pass 4)', () => {
    const terms = buildRemembillFixtureTerms()
    const confirmedTerms = { ...terms, base_fee_proration: { ...terms.base_fee_proration!, requires_confirmation: false, prorate_partial_periods: false as const } }
    const items = buildLineItems(confirmedTerms, 'EUR')
    const base = items.find(i => i.product_name.startsWith('Recurring base fee'))!
    expect(base.product_name).not.toContain('unresolved')
    expect(base.quantity).toBe(9)
    expect(base.total_amount).toBe(18000)
  })
})

describe('17B0 item E — overage threshold is never mislabeled "from unit 1"', () => {
  it('the contracted-volume-5000 excess tier starts at 5,001, additive on top of the base fee', () => {
    const terms = buildRemembillFixtureTerms()
    const tier = terms.overage_tiers[0]
    expect(tier.from_unit).toBe(5001)
    expect(tier.to_unit).toBeNull()
    expect(tier.rate_per_unit).toBe(0.6)
    // The human-facing label a UI would construct from this data can only
    // ever read "From unit 5,001+" — from_unit is never 1 for this shape.
    const label = `From unit ${tier.from_unit!.toLocaleString()}${tier.to_unit != null ? ` to ${tier.to_unit}` : '+'}`
    expect(label).toBe('From unit 5,001+')
    expect(label).not.toContain('From unit 1')
  })
})

describe('17B0 item F — unsupported mechanisms are extracted and never silently droppable', () => {
  const terms = buildRemembillFixtureTerms()

  it('the performance fee and rolling volume transition are present and correctly shaped for the review card filter', () => {
    const unsupportedFees = (terms.additional_recurring_fees ?? []).filter(f => f.unresolved_kind === 'unsupported_semantics')
    expect(unsupportedFees).toHaveLength(1)
    expect(unsupportedFees[0].fee_label).toBe('Performance share (value-weighted payment rate)')

    const unsupportedMechanisms = terms.unsupported_commercial_mechanisms ?? []
    expect(unsupportedMechanisms).toHaveLength(1)
    expect(unsupportedMechanisms[0].kind).toBe('rolling_volume_pricing_transition')
    expect(unsupportedMechanisms[0].execution_status).toBe('unsupported')
  })

  it('both unsupported items carry a source_clause and required_operational_inputs — nothing to render is ever missing', () => {
    const perf = terms.additional_recurring_fees!.find(f => f.unresolved_kind === 'unsupported_semantics')!
    expect(perf.source_clause).toBeTruthy()
    expect(perf.required_operational_inputs?.length).toBeGreaterThan(0)

    const rolling = terms.unsupported_commercial_mechanisms![0]
    expect(rolling.source_clause).toBeTruthy()
    expect(rolling.required_operational_inputs?.length).toBeGreaterThan(0)
  })
})

describe('17B0 item G — every operational dependency is surfaced, monetary inputs never forced into fake meters', () => {
  it('collects all four Remembill operational inputs, correctly classified', () => {
    const terms = buildRemembillFixtureTerms()
    const inputs = collectOperationalDataInputs(terms)
    const byKey = new Map(inputs.map(i => [i.key, i]))

    expect(byKey.get('issued_payment_request_count')?.kind).toBe('countable')
    expect(byKey.get('completed_payment_count')?.kind).toBe('countable')
    expect(byKey.get('total_invoice_value_for_issued_requests')?.kind).toBe('monetary')
    expect(byKey.get('paid_invoice_value_for_issued_requests')?.kind).toBe('monetary')
  })

  it('paid_invoice_value_for_issued_requests (only in derived_metric.raw_inputs) is still collected, not dropped', () => {
    const terms = buildRemembillFixtureTerms()
    const inputs = collectOperationalDataInputs(terms)
    const paidValue = inputs.find(i => i.key === 'paid_invoice_value_for_issued_requests')
    expect(paidValue).toBeDefined()
    expect(paidValue!.sources.some(s => s.includes('derived_metric'))).toBe(true)
  })

  it('every input records which fee/tier/mechanism it came from', () => {
    const terms = buildRemembillFixtureTerms()
    const inputs = collectOperationalDataInputs(terms)
    for (const input of inputs) {
      expect(input.sources.length).toBeGreaterThan(0)
    }
  })

  it('a purely countable contract produces no monetary inputs (unaffected regression)', () => {
    const inputs = collectOperationalDataInputs({
      overage_tiers: [{ unit_type: 'API call', tier_label: 'Calls', required_operational_inputs: ['api_call_count'] }],
    })
    expect(inputs).toEqual([{ key: 'api_call_count', kind: 'countable', sources: ['overage_tiers: Calls'] }])
  })
})

describe('17B0 item H — PII token restoration covers a plain top-level scalar field (customer_org_number)', () => {
  it('restores a masked organization identifier back into customer_org_number', () => {
    const reverseMap = new Map([['[ORGANIZATION_IDENTIFIER_1]', '559999-1234']])
    const masked = { customer_org_number: '[ORGANIZATION_IDENTIFIER_1]', customer_name: 'NordicFit Test AB' }
    const restored = restoreTokensInObject(masked, reverseMap)
    expect(restored.customer_org_number).toBe('559999-1234')
  })

  it('leaves an already-unmasked or null customer_org_number untouched', () => {
    const reverseMap = new Map([['[ORGANIZATION_IDENTIFIER_1]', '559999-1234']])
    expect(restoreTokensInObject({ customer_org_number: null }, reverseMap).customer_org_number).toBeNull()
    expect(restoreTokensInObject({ customer_org_number: '556677-8899' }, reverseMap).customer_org_number).toBe('556677-8899')
  })
})

describe('17B0 item I — renewal notice stays "3 months", never normalized to 90 days (see remembill-fixture.test.ts for the primary assertion)', () => {
  it('the fixture states months, not a day count, and the two units are never conflated', () => {
    const terms = buildRemembillFixtureTerms()
    expect(terms.renewal_notice_months).toBe(3)
    expect(terms.renewal_notice_days).toBeNull()
  })
})
