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

  // Regression: flagAmbiguousBaseFeeProration is a purely structural check
  // (day-of-month) with no clause-level reasoning of its own, so it used to
  // hardcode source_clause: null unconditionally — even though the real §2
  // text was available via field_sources.base_monthly_fee (a section
  // heading the model already extracts) plus the raw contract text. That
  // null then flowed into propose-rule's prompt as "(not captured)", which
  // the model echoed back verbatim in its reasoning — a real, user-visible
  // contradiction next to the page's own "Contract §2 — View source clause"
  // link, which proves the clause WAS located. Verified against
  // TEST-PAY-002's actual signed PDF text.
  it('populates source_clause with the real §2 text when contractText and a matching field_sources heading are both available', () => {
    const contractText = [
      '1. Services',
      '',
      'FluxPay will provide access to its platform.',
      '',
      '2. Platform Fee',
      '',
      'Customer will pay a fixed platform fee of:',
      '',
      'SEK 38,500 per month',
      '',
      'The platform fee is billed monthly in advance.',
      '',
      '3. Transaction Processing Fees',
      '',
      'For each calendar month, the applicable rate will be determined by volume.',
    ].join('\n')
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17', base_monthly_fee: 38_500, base_fee_proration: null,
      field_sources: { base_monthly_fee: '2. Platform Fee' },
    } as Partial<ContractTerms>), contractText)
    expect(terms.base_fee_proration?.source_clause).toContain('SEK 38,500 per month')
    expect(terms.base_fee_proration?.source_clause).toContain('billed monthly in advance')
    // Must not bleed into the next section.
    expect(terms.base_fee_proration?.source_clause).not.toContain('Transaction Processing')
  })

  it('leaves source_clause null (not a fabricated guess) when contractText is unavailable or the heading cannot be located', () => {
    const terms = applyExtractionSafetyNets(chunk({
      contract_start_date: '2026-08-17', base_monthly_fee: 38_500, base_fee_proration: null,
      field_sources: { base_monthly_fee: '2. Platform Fee' },
    } as Partial<ContractTerms>), 'Some contract text with no matching heading at all.')
    expect(terms.base_fee_proration?.source_clause).toBeNull()
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

// Regression fixture — TEST-PAY-002's actual signed PDF, Sections 6–8,
// transcribed verbatim (not extraction output). Reproduces the real failure:
// an initial extraction pass can plausibly paraphrase the Annual Rebate's
// clause down to just its trigger/rate/timing sentences, dropping the
// application-scope/exclusion sentences that sit between them in the source
// document — exactly what happened on TEST-PAY-002's first live run.
// applyExtractionSafetyNets' deterministic preserveExclusionLanguage
// backstop must recover them from the raw contract text regardless of
// whether the model noticed.
const TEST_PAY_002_SECTIONS_6_TO_8 = `6. Annual Volume Rebate

If Customer processes more than:

2,000,000 Transactions during a Contract Year

Customer will be entitled to a rebate equal to:

5% of the transaction-processing fees paid for that Contract Year.

For purposes of this clause, the rebate applies only to transaction-processing fees under Section 3.

The rebate does not apply to:
• platform fees;
• chargeback fees;
• other fees or charges.

Any rebate earned will be calculated after the end of the applicable Contract Year and credited to Customer within:

45 days after Contract Year-end.

A "Contract Year" means each consecutive 12-month period beginning on the Effective Date or an anniversary of the Effective Date.

For clarity, the first Contract Year runs from:

17 August 2026 through 16 August 2027.

7. Growth Credit

Customer will earn a one-time:

SEK 110,000 Growth Credit

if Customer processes more than:

300,000 Transactions in each of three consecutive calendar months.

The Growth Credit becomes earned only after the third qualifying consecutive calendar month has been completed.

The Growth Credit:
• may be applied only against future transaction-processing fees;
• may not be applied against platform fees;
• may not be applied against chargeback fees;
• will not be paid in cash.

If the amount of transaction-processing fees in the first billing period following the credit becoming available is less than the remaining Growth Credit, the unused portion will carry forward and may be applied against future transaction-processing fees until fully used.

8. Service Availability Credit

If FluxPay fails to meet the applicable service-availability commitment, Customer will be entitled to:

SEK 5,500 for each complete hour of excess service unavailability

during the applicable calendar month.

Only complete excess-unavailability hours qualify for this credit.

The total service credit for any calendar month is capped at:

SEK 55,000

Service credits will be applied against future amounts payable under this Agreement.

A service credit does not reduce the number of Transactions used to determine the applicable transaction-processing tier.`

describe('applyExtractionSafetyNets — preserveExclusionLanguage backstop (TEST-PAY-002 Section 6 regression)', () => {
  it('recovers the Annual Rebate exclusion sentences the model dropped, without touching Growth Credit or Service Credit', () => {
    const terms = applyExtractionSafetyNets(chunk({
      service_credits: [
        {
          credit_type: 'rebate',
          description: 'Annual volume rebate: 5% of transaction-processing fees paid for the Contract Year if more than 2,000,000 Transactions are processed in that year',
          // Exactly the real, observed failure: the model merged the
          // trigger/rate/timing sentences and skipped the two
          // application-scope/exclusion sentences that sit between them.
          source_clause: 'If Customer processes more than 2,000,000 Transactions during a Contract Year, Customer will be entitled to a rebate equal to 5% of the transaction-processing fees paid for that Contract Year. Any rebate earned will be calculated after the end of the applicable Contract Year and credited to Customer within 45 days after Contract Year-end.',
          stated_pct: 5, stated_amount: null,
        },
        {
          credit_type: 'conditional_credit',
          description: 'One-time SEK 110,000 Growth Credit earned if Customer processes more than 300,000 Transactions in each of three consecutive calendar months; applicable against future transaction-processing fees only',
          // Verbatim, matching the raw text's own bulleted formatting —
          // this credit's clause was ALREADY completely captured (unlike
          // the Rebate above); the dedup check must recognize that and
          // leave it untouched, not duplicate it.
          source_clause: 'Customer will earn a one-time SEK 110,000 Growth Credit if Customer processes more than 300,000 Transactions in each of three consecutive calendar months. The Growth Credit becomes earned only after the third qualifying consecutive calendar month has been completed. The Growth Credit: • may be applied only against future transaction-processing fees; • may not be applied against platform fees; • may not be applied against chargeback fees; • will not be paid in cash.',
          stated_amount: 110_000, stated_pct: null,
        },
        {
          credit_type: 'service_credit',
          description: 'SEK 5,500 per complete hour of excess service unavailability in a calendar month, capped at SEK 55,000 per calendar month; applied against future amounts payable',
          source_clause: 'If FluxPay fails to meet the applicable service-availability commitment, Customer will be entitled to SEK 5,500 for each complete hour of excess service unavailability during the applicable calendar month. The total service credit for any calendar month is capped at SEK 55,000. Service credits will be applied against future amounts payable under this Agreement.',
          stated_amount: 5_500, stated_pct: null,
        },
      ] as unknown as ContractTerms['service_credits'],
    }), TEST_PAY_002_SECTIONS_6_TO_8)

    const rebate = terms.service_credits.find(c => c.credit_type === 'rebate')!
    expect(rebate.source_clause).toContain('the rebate applies only to transaction-processing fees under Section 3')
    expect(rebate.source_clause).toContain('The rebate does not apply to')
    expect(rebate.source_clause).toContain('platform fees')
    expect(rebate.source_clause).toContain('chargeback fees')
    // Original sentences must still be present too — this appends, never replaces.
    expect(rebate.source_clause).toContain('5% of the transaction-processing fees paid for that Contract Year')

    // Growth Credit and Service Credit already had complete clauses in this
    // fixture — must be left untouched, not have their own text duplicated
    // by a false-positive match against a neighbouring anchor's window.
    const growth = terms.service_credits.find(c => c.credit_type === 'conditional_credit')!
    const growthExclusionCount = (growth.source_clause!.match(/may not be applied against platform fees/g) ?? []).length
    expect(growthExclusionCount).toBe(1)

    const serviceCredit = terms.service_credits.find(c => c.credit_type === 'service_credit')!
    expect(serviceCredit.source_clause).toContain('applied against future amounts payable under this Agreement')
    const serviceCreditOccurrences = (serviceCredit.source_clause!.match(/applied against future amounts payable/g) ?? []).length
    expect(serviceCreditOccurrences).toBe(1)
  })

  it('is a no-op when contractText is omitted (multi-chunk merge path) — never throws, never mutates', () => {
    const terms = applyExtractionSafetyNets(chunk({
      service_credits: [
        { credit_type: 'rebate', description: '2,000,000 Transactions rebate', source_clause: 'Truncated clause.', stated_pct: 5, stated_amount: null } as unknown as ContractTerms['service_credits'][number],
      ],
    }))
    expect(terms.service_credits[0].source_clause).toBe('Truncated clause.')
  })

  // Real duplication bug observed on a genuine live extraction run (not a
  // fixture): the model captured Growth Credit's exclusion list completely
  // on its own, but re-flowed it into prose WITHOUT the raw text's bullet
  // markers ("The Growth Credit: may be applied only against... may not be
  // applied against platform fees..." vs the raw "• may be applied only
  // against...\n• may not be applied against platform fees..."). A literal
  // substring dedup check saw these as different text and appended a
  // redundant duplicate. The dedup must recognize this as already-present
  // regardless of bullet formatting.
  it('does not duplicate an exclusion list the model already captured completely, just without the raw text\'s bullet markers', () => {
    const contractText = `7. Growth Credit

Customer will earn a one-time SEK 110,000 Growth Credit if Customer processes more than 300,000 Transactions in each of three consecutive calendar months.

The Growth Credit:
• may be applied only against future transaction-processing fees;
• may not be applied against platform fees;
• may not be applied against chargeback fees;
• will not be paid in cash.

8. Service Availability Credit`

    const terms = applyExtractionSafetyNets(chunk({
      service_credits: [{
        credit_type: 'conditional_credit',
        description: 'One-time SEK 110,000 Growth Credit',
        // Model's own prose — semantically complete, no bullet markers,
        // slightly different wording order than the raw text.
        source_clause: 'Customer will earn a one-time SEK 110,000 Growth Credit if Customer processes more than 300,000 Transactions in each of three consecutive calendar months. The Growth Credit: may be applied only against future transaction-processing fees; may not be applied against platform fees; may not be applied against chargeback fees; will not be paid in cash.',
        stated_amount: 110_000, stated_pct: null,
      } as unknown as ContractTerms['service_credits'][number]],
    }), contractText)

    const clause = terms.service_credits[0].source_clause!
    const occurrences = (clause.match(/may not be applied against platform fees/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
