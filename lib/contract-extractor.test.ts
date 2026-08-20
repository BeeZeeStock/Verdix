import { describe, it, expect } from 'vitest'
import { mergeExtractions, assignServiceCreditRuleIds, applyExtractionSafetyNets } from './contract-extractor'
import type { ContractTerms } from './types'

// Minimal partial fixtures — mergeExtractions only reads a handful of
// top-level array fields plus a few scalars for scoreCompleteness/date
// correction, so the rest of the (large) ContractTerms shape is irrelevant
// here. Same as-cast pattern lib/contract-extractor.ts's own JSON.parse
// result uses.
function chunk(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    escalators: [],
    discounts: [],
    service_credits: [],
    overage_tiers: [],
    one_time_fees: [],
    ...overrides,
  } as ContractTerms
}

describe('mergeExtractions — service_credits (scenario: extraction)', () => {
  it('merges service_credits arrays across chunks and dedupes by description', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
      chunk({ service_credits: [
        { description: 'Availability service credit' } as ContractTerms['service_credits'][number], // duplicate — same chunk seen from another pass
        { description: 'Promotional credit' } as ContractTerms['service_credits'][number],
      ] }),
    ])
    expect(merged.service_credits.map(c => c.description)).toEqual(['Availability service credit', 'Promotional credit'])
  })

  it('assigns a stable credit_rule_id to every merged service credit', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
    ])
    expect(merged.service_credits).toHaveLength(1)
    expect(merged.service_credits[0].credit_rule_id).toBeTruthy()
  })

  it('never populates interpretation at merge time — extraction never marks a credit resolved', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: [{ description: 'Availability service credit' } as ContractTerms['service_credits'][number]] }),
    ])
    expect(merged.service_credits[0].interpretation).toBeUndefined()
  })

  it('handles chunks with no service_credits field at all (predates the field)', () => {
    const merged = mergeExtractions([
      chunk({ service_credits: undefined as unknown as ContractTerms['service_credits'] }),
    ])
    expect(merged.service_credits).toEqual([])
  })
})

describe('assignServiceCreditRuleIds', () => {
  it('backfills an id only for credits missing one, preserving existing ids', () => {
    const result = assignServiceCreditRuleIds([
      { credit_rule_id: 'existing-id', description: 'A' },
      { description: 'B' },
    ])
    expect(result[0].credit_rule_id).toBe('existing-id')
    expect(result[1].credit_rule_id).toBeTruthy()
    expect(result[1].credit_rule_id).not.toBe('existing-id')
  })
})

describe('applyExtractionSafetyNets — single-chunk extraction path (scenario: TEST-PAY-002)', () => {
  // extractContractTerms's single-chunk branch (any contract under ~12,000
  // chars — the common case) used to return extractFromChunk's raw result
  // directly, entirely skipping the id-assignment and ambiguity-flagging
  // safety nets that only ran inside mergeExtractions (the multi-chunk
  // path). A short, clearly-worded contract like TEST-PAY-002 hit this
  // exactly: its three real service_credits (Annual Rebate, Growth Credit,
  // Service Availability Credit) came back with no credit_rule_id at all,
  // making them invisible to lib/commercial-rule-status.ts's workload
  // count (which skips any credit/discount with no id) and to confirm-rule/
  // propose-rule (which need a stable id to address). This is now applied
  // unconditionally in both branches — see applyExtractionSafetyNets.
  it('assigns a credit_rule_id to every service credit even outside mergeExtractions', () => {
    const terms = applyExtractionSafetyNets(chunk({
      service_credits: [
        { description: 'Annual volume rebate', credit_type: 'rebate' },
        { description: 'Growth credit', credit_type: 'conditional_credit' },
        { description: 'Service availability credit', credit_type: 'service_credit' },
      ] as ContractTerms['service_credits'],
    }))
    expect(terms.service_credits).toHaveLength(3)
    for (const c of terms.service_credits) expect(c.credit_rule_id).toBeTruthy()
    // Every id must be distinct — three credits sharing one id would be as
    // broken as having none, since confirm-rule addresses exactly one.
    expect(new Set(terms.service_credits.map(c => c.credit_rule_id)).size).toBe(3)
  })

  it('assigns a discount_rule_id to every discount even outside mergeExtractions', () => {
    const terms = applyExtractionSafetyNets(chunk({
      discounts: [{ description: 'Introductory discount' }] as ContractTerms['discounts'],
    }))
    expect(terms.discounts[0].discount_rule_id).toBeTruthy()
  })

  it('corrects an end date that is not after the start date, using contract_term_months', () => {
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17', contract_end_date: '2026-07-31', contract_term_months: 24,
    } as Partial<ContractTerms>))
    expect(terms.contract_end_date).toBe('2028-08-16')
  })

  // scenario: TEST-PAY-002's real §2 ("SEK 38,500 per month... billed
  // monthly in advance" — no anchor language at all) — the extraction
  // prompt only ever populates base_fee_proration when the contract
  // EXPLICITLY states calendar-boundary billing, so a fee that's simply
  // silent on the question came back with base_fee_proration left null,
  // which downstream code reads as "no partial-period question exists" —
  // silently assuming contract-start anchoring for a question the contract
  // never actually answered.
  it('flags base fee proration as needing confirmation when the contract starts mid-month and states no anchor', () => {
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17', base_monthly_fee: 38_500, base_fee_proration: null,
    } as Partial<ContractTerms>))
    expect(terms.base_fee_proration?.requires_confirmation).toBe(true)
    expect(terms.base_fee_proration?.prorate_partial_periods).toBe('unclear')
  })

  it('does not flag base fee proration when the contract start already falls on a calendar boundary', () => {
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-01', base_monthly_fee: 38_500, base_fee_proration: null,
    } as Partial<ContractTerms>))
    expect(terms.base_fee_proration).toBeNull()
  })

  it('never overwrites a proration already extracted from an explicit contract statement', () => {
    const explicit = { reset_anchor: 'calendar' as const, prorate_partial_periods: true, requires_confirmation: false, confirmation_reason: null, source_clause: 'billed each calendar month' }
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17', base_monthly_fee: 38_500, base_fee_proration: explicit,
    } as Partial<ContractTerms>))
    expect(terms.base_fee_proration).toEqual(explicit)
  })

  it('flags each additional recurring fee missing its own proration the same way', () => {
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17',
      additional_recurring_fees: [{ fee_label: 'Support retainer', amount: 3_100, description: null }],
    } as Partial<ContractTerms>))
    expect(terms.additional_recurring_fees![0].proration?.requires_confirmation).toBe(true)
  })
})
