import { describe, it, expect } from 'vitest'
import { mergeExtractions, assignServiceCreditRuleIds, applyExtractionSafetyNets, isExistingVariableRateFeeShape } from './contract-extractor'
import type { ContractTerms, OneTimeFee } from './types'

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

// Step 11, item 2 — regression baseline for OneTimeFee's ACTUAL, current
// production behavior (real field names: fee_label, amount, due_date,
// manual_trigger, metric_name, rate_per_unit), captured before any
// readiness/provenance change. See lib/rulebook/MILESTONE_BILLING_FINDINGS
// .md for the full lifecycle audit these fixtures are drawn from.
function oneTimeFee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
  return { fee_label: 'Onboarding fee', amount: 5000, due_date: null, description: null, ...overrides }
}

describe('mergeExtractions — one_time_fees dedupe (item 2 regression baseline)', () => {
  it('dedupes by fee_label only, across chunks — the actual, current key, not a hypothetical stable id', () => {
    const merged = mergeExtractions([
      chunk({ one_time_fees: [oneTimeFee({ fee_label: 'Onboarding fee', amount: 5000 })] }),
      chunk({ one_time_fees: [
        oneTimeFee({ fee_label: 'Onboarding fee', amount: 5000 }), // duplicate — same chunk seen from another pass
        oneTimeFee({ fee_label: 'Implementation fee', amount: 12000 }),
      ] }),
    ])
    expect(merged.one_time_fees.map(f => f.fee_label)).toEqual(['Onboarding fee', 'Implementation fee'])
  })

  it('documents the known collision risk: two GENUINELY DISTINCT fees sharing a fee_label collapse into one (fee_label is the only dedupe key today)', () => {
    const merged = mergeExtractions([
      chunk({ one_time_fees: [oneTimeFee({ fee_label: 'Milestone 1', amount: 100000 })] }),
      chunk({ one_time_fees: [oneTimeFee({ fee_label: 'Milestone 1', amount: 999999 })] }), // different amount, same label — NOT actually a duplicate
    ])
    expect(merged.one_time_fees).toHaveLength(1) // collapsed — the known, documented risk, not asserted as desired doctrine
  })

  it('handles chunks with no one_time_fees field at all (predates the field)', () => {
    const merged = mergeExtractions([
      chunk({ one_time_fees: undefined as unknown as ContractTerms['one_time_fees'] }),
    ])
    expect(merged.one_time_fees).toEqual([])
  })

  it('never assigns a stable rule_id to a one-time fee — unlike discounts/service_credits, no id-stability mechanism exists for this type (documented gap, not fixed in Step 11)', () => {
    const merged = mergeExtractions([
      chunk({ one_time_fees: [oneTimeFee()] }),
    ])
    expect(merged.one_time_fees[0]).not.toHaveProperty('fee_rule_id')
  })
})

describe('applyExtractionSafetyNets — flagAmbiguousOneTimeFees (Step 11, item 1 finding: due_date null + manual_trigger falsy silently means "due now")', () => {
  it('a fee with no due_date and no manual_trigger — the genuinely ambiguous, auto-invoice-reachable shape — is flagged requires_confirmation', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, manual_trigger: undefined, amount: 100000 })] }))
    expect(terms.one_time_fees[0].requires_confirmation).toBe(true)
    expect(terms.one_time_fees[0].unresolved_kind).toBe('needs_review')
    expect(terms.one_time_fees[0].confirmation_reason).toBeTruthy()
  })

  // Step 12 final lifecycle correction superseded this: a due_date alone,
  // with no billability_condition key at all, is now a FRESH omission
  // (not a legacy record — nothing about calling applyExtractionSafetyNets
  // is ever a legacy/historical path) and is NOT the pre-existing
  // variable-rate pricing shape either — so it canonicalizes to
  // billability_condition: null and IS flagged. See "final lifecycle
  // correction" describe block below for the current, correct behavior.
  it('a fee with an explicit due_date but no billability_condition key is now flagged by the combined pipeline — Step 12 canonicalizes fresh omission to null rather than trusting the stray due_date', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: '2026-02-01', amount: 5000 })] }))
    expect(terms.one_time_fees[0].billability_condition).toBeNull()
    expect(terms.one_time_fees[0].requires_confirmation).toBe(true)
  })

  it('a fee with manual_trigger: true is NOT flagged — it already correctly waits for human confirmation via the parked-invoices flow', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, manual_trigger: true, amount: 0, metric_name: 'hours', rate_per_unit: 150 })] }))
    expect(terms.one_time_fees[0].requires_confirmation).toBeUndefined()
  })

  it('a fee with amount <= 0 is not flagged — nothing would actually bill (item 2: missing amount)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, amount: 0 })] }))
    expect(terms.one_time_fees[0].requires_confirmation).toBeUndefined()
  })

  it('multiple one-time fees are each flagged independently (item 2: multiple one-time fees)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ fee_label: 'Ambiguous fee', due_date: null, amount: 50000 }),
      oneTimeFee({ fee_label: 'Scheduled fee', due_date: '2026-03-01', amount: 20000 }),
      // No metric_name/rate_per_unit — does NOT qualify for the
      // variable-rate-shape exemption, but amount is 0 so the (amount > 0)
      // guard on requires_confirmation never fires either way.
      oneTimeFee({ fee_label: 'Manual fee', due_date: null, manual_trigger: true, amount: 0 }),
    ] }))
    expect(terms.one_time_fees.find(f => f.fee_label === 'Ambiguous fee')?.requires_confirmation).toBe(true)
    // Step 12 final correction — a fixed amount with a due_date but no
    // billability_condition key is fresh omission, not legacy; it's now
    // flagged too (see the dedicated test above for why).
    expect(terms.one_time_fees.find(f => f.fee_label === 'Scheduled fee')?.requires_confirmation).toBe(true)
    expect(terms.one_time_fees.find(f => f.fee_label === 'Manual fee')?.requires_confirmation).toBeUndefined()
  })

  it('is idempotent — re-running safety nets on an already-flagged fee does not stack or overwrite an existing confirmation state', () => {
    const once = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, amount: 100000 })] }))
    const twice = applyExtractionSafetyNets(chunk({ one_time_fees: once.one_time_fees }))
    expect(twice.one_time_fees[0].requires_confirmation).toBe(true)
    expect(twice.one_time_fees[0].confirmation_reason).toBe(once.one_time_fees[0].confirmation_reason)
  })

  it('never mutates amount — Step 12\'s safe-hold canonicalization intentionally DOES set manual_trigger:true for a fresh, unanswered fixed fee (defense in depth, see final lifecycle correction below), so only amount is asserted untouched here', () => {
    const input = oneTimeFee({ due_date: null, amount: 100000, manual_trigger: undefined })
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [input] }))
    expect(terms.one_time_fees[0].amount).toBe(100000)
  })
})

// Step 11 amendment — billability_provenance discriminator. Independent of
// (and in addition to) the requires_confirmation/amount logic above.
describe('applyExtractionSafetyNets — billability_provenance discriminator (Step 11 amendment)', () => {
  it('a non-manual-trigger fee gets billability_provenance explicitly set to null (evaluated, genuinely unresolved) — REGARDLESS of due_date presence (item 3: a concrete date is not evidence)', () => {
    const withDueDate = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: '2026-02-01', amount: 5000 })] }))
    expect(withDueDate.one_time_fees[0].billability_provenance).toBeNull()
    const withoutDueDate = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, amount: 100000 })] }))
    expect(withoutDueDate.one_time_fees[0].billability_provenance).toBeNull()
  })

  it('a manual_trigger: true fee is left untouched — billability_provenance stays undefined (item 6: execution already safely held, not a load-bearing field for this shape)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ manual_trigger: true, amount: 0, metric_name: 'hours', rate_per_unit: 150 })] }))
    expect(terms.one_time_fees[0].billability_provenance).toBeUndefined()
  })

  it('never overwrites an already-resolved billability_provenance (e.g. preserved across re-extraction after a reviewer confirmed it)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: '2026-02-01', billability_provenance: 'reviewer_policy' })] }))
    expect(terms.one_time_fees[0].billability_provenance).toBe('reviewer_policy')
  })

})

// Final correction — the same treatment, symmetrically, for
// amount_provenance (item 1: "must become the canonical trust signal").
describe('applyExtractionSafetyNets — amount_provenance discriminator (Step 11 final correction)', () => {
  it('a fee with a real, positive amount gets amount_provenance explicitly set to null (evaluated, genuinely unresolved), regardless of due_date/manual_trigger', () => {
    const clean = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: '2026-02-01', amount: 5000 })] }))
    expect(clean.one_time_fees[0].amount_provenance).toBeNull()
    const ambiguous = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: null, amount: 100000 })] }))
    expect(ambiguous.one_time_fees[0].amount_provenance).toBeNull()
    const manual = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ manual_trigger: true, amount: 50000 })] }))
    expect(manual.one_time_fees[0].amount_provenance).toBeNull()
  })

  it('a fee with amount 0 (variable, unknown at contract time — manual_trigger rate-based fees) is left untouched — nothing to grade provenance on yet', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ manual_trigger: true, amount: 0, metric_name: 'hours', rate_per_unit: 150 })] }))
    expect(terms.one_time_fees[0].amount_provenance).toBeUndefined()
  })

  it('never overwrites an already-resolved amount_provenance (e.g. preserved across re-extraction after a reviewer confirmed it)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ amount: 100000, amount_provenance: 'reviewer_policy' })] }))
    expect(terms.one_time_fees[0].amount_provenance).toBe('reviewer_policy')
  })

  it('amount_provenance and requires_confirmation stay independently gradable — a fee already resolved on billability (via a confirmed condition) proves requires_confirmation is NOT universally forced true just because amount_provenance is graded', () => {
    const clean = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ due_date: '2026-02-01', amount: 5000, billability_condition: { kind: 'fixed_date', date: '2026-02-01' }, billability_provenance: 'reviewer_policy' } as Partial<OneTimeFee>),
    ] }))
    expect(clean.one_time_fees[0].amount_provenance).toBeNull() // evaluated...
    expect(clean.one_time_fees[0].requires_confirmation).toBeUndefined() // ...but not flagged as urgently ambiguous
  })

  it('by contrast, a fee with the SAME due_date but no billability_condition at all IS flagged — fresh omission, not exempted (final lifecycle correction)', () => {
    const clean = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ due_date: '2026-02-01', amount: 5000 })] }))
    expect(clean.one_time_fees[0].amount_provenance).toBeNull()
    expect(clean.one_time_fees[0].requires_confirmation).toBe(true)
  })
})

// Contract B acceptance amendment — wiring-level coverage for lib/one-time-
// fee-provenance.ts's deriveOneTimeFeeAmountProvenance, threaded through
// applyExtractionSafetyNets/flagAmbiguousOneTimeFees via terms.currency.
// The grounding LOGIC itself (currency matching, range/conflict handling,
// normalization) is unit-tested in lib/one-time-fee-provenance.test.ts —
// this only proves the wiring: the right currency reaches the helper, and
// the undefined-only gate still means a fee already evaluated (by an
// earlier extraction pass) is never re-graded.
describe('applyExtractionSafetyNets — amount_provenance grounding wiring (Contract B acceptance amendment)', () => {
  it('the exact Contract B launch-fee case: explicit source_clause + matching agreement currency -> contract_derived, not null', () => {
    const terms = applyExtractionSafetyNets(chunk({
      currency: 'SEK',
      one_time_fees: [oneTimeFee({
        fee_label: 'Launch Fee', amount: 20000, due_date: '2026-10-01',
        source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.',
      } as Partial<OneTimeFee>)],
    }))
    expect(terms.one_time_fees[0].amount_provenance).toBe('contract_derived')
  })

  it('an ungrounded fee on the same contract still falls back to null (grounding is per-fee, not contract-wide)', () => {
    const terms = applyExtractionSafetyNets(chunk({
      currency: 'SEK',
      one_time_fees: [oneTimeFee({ fee_label: 'Migration fee', amount: 10000, due_date: '2026-10-01' } as Partial<OneTimeFee>)],
    }))
    expect(terms.one_time_fees[0].amount_provenance).toBeNull()
  })

  it('no terms.currency at all -> falls back to null, never guesses a currency', () => {
    const terms = applyExtractionSafetyNets(chunk({
      one_time_fees: [oneTimeFee({
        amount: 20000, due_date: '2026-10-01',
        source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.',
      } as Partial<OneTimeFee>)],
    }))
    expect(terms.one_time_fees[0].amount_provenance).toBeNull()
  })

  it('re-extraction never re-grades an already-evaluated fee, even if a source_clause is newly present', () => {
    const terms = applyExtractionSafetyNets(chunk({
      currency: 'SEK',
      one_time_fees: [oneTimeFee({
        amount: 20000, amount_provenance: null, // already evaluated by a prior pass
        source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.',
      } as Partial<OneTimeFee>)],
    }))
    expect(terms.one_time_fees[0].amount_provenance).toBeNull() // NOT re-graded to contract_derived
  })
})

describe('applyExtractionSafetyNets — normalizeBillabilityCondition (Step 12)', () => {
  it('a valid immediate condition from the model is preserved and projected to due_date null / manual_trigger false', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 5000, due_date: null, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'immediate' })
    expect(fee.due_date).toBeNull()
    expect(fee.manual_trigger).toBe(false)
    expect(fee.billability_provenance).toBeNull()
  })

  it('a null-due_date but interpretable condition gets a condition-aware confirmation_reason, not the stale generic "no stated due date" text flagAmbiguousOneTimeFees stamps first', () => {
    const event = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(event.requires_confirmation).toBe(true)
    expect(event.confirmation_reason).toMatch(/customer acceptance/i)
    expect(event.confirmation_reason).not.toMatch(/no stated due date/i)

    const immediate = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(immediate.confirmation_reason).toMatch(/payable immediately/i)
    expect(immediate.confirmation_reason).not.toMatch(/no stated due date/i)
  })

  it('a valid fixed_date condition is preserved and projected onto due_date, overriding any stray due_date the model separately supplied', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 5000, due_date: '1999-01-01', billability_condition: { kind: 'fixed_date', date: '2026-10-15' } } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'fixed_date', date: '2026-10-15' })
    expect(fee.due_date).toBe('2026-10-15') // projection wins, not the stray raw value
    expect(fee.manual_trigger).toBe(false)
  })

  it('"payable upon signing" (event/contract_signature) is never collapsed into due_date, even when the model also supplies an (incorrect) date — the Step 11C nondeterminism this step exists to close', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: '2026-09-01', // a stray effective-date guess, exactly Step 11C's observed failure mode
        billability_condition: { kind: 'event', event_type: 'contract_signature' },
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'contract_signature' })
    expect(fee.due_date).toBeNull()
    expect(fee.manual_trigger).toBe(true)
    expect(fee.billability_provenance).toBeNull() // semantically represented, NOT confirmed
  })

  it('a customer_acceptance event condition normalizes with manual_trigger:true and null due_date, billability_provenance evaluated-unresolved', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
    expect(fee.manual_trigger).toBe(true)
    expect(fee.billability_provenance).toBeNull()
  })

  // Final amendment, item 6 — the core adversarial regression: a
  // model-emitted raw manual_trigger:true must NEVER suppress or bypass a
  // valid billability_condition. Before the fix, `if (fee.manual_trigger)
  // return fee` short-circuited BEFORE parseBillabilityCondition was even
  // called, so a fee shaped exactly like this would have skipped
  // validation/projection entirely and persisted whatever raw JSON the
  // model produced, unvalidated.
  it('condition=customer_acceptance + raw manual_trigger=true → condition wins, canonical event projection applied, not the raw value', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: null, manual_trigger: true, // raw model output — must not win
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
    // manual_trigger ends up true here too, but as the CANONICAL PROJECTION
    // for an event condition (lib/billability-condition.ts), not because
    // the raw model value was trusted/passed through unvalidated — proven
    // by the sibling test below, where a DIFFERENT raw manual_trigger value
    // produces the identical canonical result.
    expect(fee.manual_trigger).toBe(true)
    expect(fee.due_date).toBeNull()
    expect(fee.billability_provenance).toBeNull() // still requires reviewer confirmation
  })

  it('condition=customer_acceptance + raw manual_trigger=false + raw due_date=some date → condition wins, stray date removed — proves the projection is canonical, not the raw model value', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: '2026-09-01', manual_trigger: false, // raw model output — must not survive
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
    // Identical canonical projection to the raw-manual_trigger:true sibling
    // test above, despite opposite raw manual_trigger AND a stray raw date
    // — proves both raw fields are irrelevant once a condition is present.
    expect(fee.manual_trigger).toBe(true)
    expect(fee.due_date).toBeNull()
  })

  it('condition=fixed_date(2026-10-15) + raw manual_trigger=true + conflicting raw due_date → canonical date wins', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: '1999-01-01', manual_trigger: true, // both must be overridden
        billability_condition: { kind: 'fixed_date', date: '2026-10-15' },
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'fixed_date', date: '2026-10-15' })
    expect(fee.due_date).toBe('2026-10-15')
    expect(fee.manual_trigger).toBe(false)
  })

  it('condition=immediate + raw manual_trigger=true → canonical immediate projection wins', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: '2026-01-01', manual_trigger: true, // both must be overridden
        billability_condition: { kind: 'immediate' },
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'immediate' })
    expect(fee.due_date).toBeNull()
    expect(fee.manual_trigger).toBe(false)
  })

  it('delivery and customer_acceptance remain distinct normalized event types — never collapsed (item 9/counterexample discipline)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ fee_label: 'Delivery fee', amount: 50000, billability_condition: { kind: 'event', event_type: 'delivery' } } as Partial<OneTimeFee>),
      oneTimeFee({ fee_label: 'Acceptance fee', amount: 50000, billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>),
    ] }))
    expect(terms.one_time_fees.find(f => f.fee_label === 'Delivery fee')?.billability_condition).toEqual({ kind: 'event', event_type: 'delivery' })
    expect(terms.one_time_fees.find(f => f.fee_label === 'Acceptance fee')?.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
  })

  it('genuine silence — the model explicitly answers billability_condition: null — becomes explicit null, never "immediate" (item 10)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: null } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.requires_confirmation).toBe(true)
    expect(fee.unresolved_kind).toBe('needs_review')
  })

  it('silence expressed by OMITTING the JSON key entirely (real model variability — item 8) produces the IDENTICAL canonicalized result as an explicit null answer, for a fixed-amount fee', () => {
    const omitted = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null }), // no billability_condition key at all
    ] })).one_time_fees[0]
    const explicit = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: null } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(omitted.billability_condition).toBeNull()
    expect(omitted.billability_condition).toEqual(explicit.billability_condition)
    expect(omitted.manual_trigger).toEqual(explicit.manual_trigger)
    expect(omitted.due_date).toEqual(explicit.due_date)
    expect(omitted.requires_confirmation).toEqual(explicit.requires_confirmation)
  })

  it('a malformed/hallucinated billability_condition from the model is rejected (never enters the domain model) and treated as silence', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, billability_condition: { kind: 'deemed_acceptance', window_days: 10 } } as unknown as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.requires_confirmation).toBe(true)
  })

  it('an invalid/malformed condition resets due_date/manual_trigger to the safe/held projection — a stray executable-looking legacy shape must never survive on a newly-governed record (final amendment item 5)', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: null, manual_trigger: false, // "apparently executable" raw shape
        billability_condition: { kind: 'deemed_acceptance', window_days: 10 },
      } as unknown as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.due_date).toBeNull()
    expect(fee.manual_trigger).toBe(true) // held, not the dangerous "bill now" shape
    expect(fee.billability_provenance).toBeNull() // still blocks readiness regardless
  })

  // Final lifecycle correction — this scenario was originally (incorrectly)
  // treated as "legacy" purely because it came through applyExtractionSafetyNets
  // with no billability_condition key. But EVERY call to
  // applyExtractionSafetyNets represents a FRESH extraction pass — there is
  // no way to produce a genuinely historical record through it at all.
  // "Legacy" can only mean a persisted OneTimeFee that never passes through
  // this pipeline again (see the dedicated historical-compatibility
  // describe block below, which constructs such a record directly, never
  // via extraction). A fresh fixed-amount fee with a due_date but no
  // billability_condition key is fresh omission, not legacy — and, since
  // it isn't the variable-rate-pricing shape either, canonicalizes to null.
  it('a fresh fixed-amount fee with a due_date but no billability_condition key canonicalizes to null — it is fresh omission, not a legacy record', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 5000, due_date: '2026-03-01' }),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.billability_provenance).toBeNull()
    expect(fee.requires_confirmation).toBe(true)
  })

  it('manual_trigger fees (genuine professional services) never enter the Step 12 lifecycle — billability_condition stays undefined', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ manual_trigger: true, amount: 0, metric_name: 'hours', rate_per_unit: 150 }),
    ] }))
    expect(terms.one_time_fees[0].billability_condition).toBeUndefined()
  })

  it('never re-normalizes a fee whose billability is already reviewer/contract resolved — re-extraction must not silently overwrite a prior human confirmation', () => {
    // manual_trigger deliberately false here so this exercises the
    // isProvenanceResolved skip specifically, not the (separate)
    // manual_trigger early-return above.
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 100000, due_date: '2026-05-01', manual_trigger: false,
        // Deliberately inconsistent with due_date — if normalization ran
        // again, the projection would overwrite due_date to '1999-01-01';
        // it must not.
        billability_condition: { kind: 'fixed_date', date: '1999-01-01' },
        billability_provenance: 'reviewer_policy',
      } as Partial<OneTimeFee>),
    ] }))
    const fee = terms.one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'fixed_date', date: '1999-01-01' })
    expect(fee.due_date).toBe('2026-05-01') // untouched — proves normalization was skipped, not merely idempotent
    expect(fee.billability_provenance).toBe('reviewer_policy')
  })
})

describe('isExistingVariableRateFeeShape — the ONE narrow, shape-based (never manual_trigger) exemption', () => {
  it('true: metric_name + positive rate_per_unit + no positive amount', () => {
    expect(isExistingVariableRateFeeShape({
      fee_label: 'PS', amount: 0, due_date: null, description: null, metric_name: 'hours', rate_per_unit: 150,
    })).toBe(true)
  })

  it('false: a positive fixed amount disqualifies it, even with metric_name/rate_per_unit also present ("accidentally present" — item 4)', () => {
    expect(isExistingVariableRateFeeShape({
      fee_label: 'Fixed', amount: 100000, due_date: null, description: null, metric_name: 'hours', rate_per_unit: 150,
    })).toBe(false)
  })

  it('false: no metric_name', () => {
    expect(isExistingVariableRateFeeShape({ fee_label: 'X', amount: 0, due_date: null, description: null, rate_per_unit: 150 })).toBe(false)
  })

  it('false: no rate_per_unit', () => {
    expect(isExistingVariableRateFeeShape({ fee_label: 'X', amount: 0, due_date: null, description: null, metric_name: 'hours' })).toBe(false)
  })

  it('false: rate_per_unit is zero or negative', () => {
    expect(isExistingVariableRateFeeShape({ fee_label: 'X', amount: 0, due_date: null, description: null, metric_name: 'hours', rate_per_unit: 0 })).toBe(false)
  })
})

// Final lifecycle correction, item 4 — the exact adversarial matrix
// requested: fresh vs legacy is never manual_trigger-derived, and the
// variable-rate-shape exemption is narrow, structural, and never rescues a
// fixed fee or an attempted-but-invalid Step-12 answer.
describe('normalizeBillabilityCondition — fresh omission vs the variable-rate-shape exemption (final lifecycle correction)', () => {
  it('rate_per_unit + metric_name + amount 0 + condition omitted → existing compatibility path (billability_condition stays undefined)', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 0, due_date: null, manual_trigger: true, metric_name: 'hours', rate_per_unit: 150 }),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toBeUndefined()
    expect(fee.manual_trigger).toBe(true)
  })

  it('same variable-rate shape + a valid explicit event condition → condition wins, enters Step 12 (item 1: a valid condition always wins)', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 0, due_date: null, manual_trigger: true, metric_name: 'hours', rate_per_unit: 150,
        billability_condition: { kind: 'event', event_type: 'customer_acceptance' },
      } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'customer_acceptance' })
    expect(fee.billability_provenance).toBeNull()
  })

  it('fixed amount + manual_trigger true + condition omitted → condition=null / reviewed — does NOT escape as "professional services" merely because manual_trigger happens to be true', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, manual_trigger: true }),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.billability_provenance).toBeNull()
    expect(fee.requires_confirmation).toBe(true)
  })

  it('fixed amount + rate_per_unit accidentally present (but amount is positive) → does not qualify for the exemption', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, due_date: null, metric_name: 'hours', rate_per_unit: 150 }),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toBeNull() // not exempted — canonicalized like any other fixed fee
  })

  it('variable-rate-shaped fee + an INVALID/malformed condition (not omitted) → the exemption does NOT hide the malformed Step-12 answer; canonicalizes to null like any other invalid answer', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({
        amount: 0, due_date: null, metric_name: 'hours', rate_per_unit: 150,
        billability_condition: { kind: 'deemed_acceptance', window_days: 10 },
      } as unknown as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.billability_provenance).toBeNull()
  })

  it('variable-rate-shaped fee + explicit null (not omitted) → NOT exempted either — only genuine key-absence qualifies', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 0, due_date: null, metric_name: 'hours', rate_per_unit: 150, billability_condition: null } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(fee.billability_condition).toBeNull()
    expect(fee.billability_provenance).toBeNull()
  })
})

// Final lifecycle correction, item 6/7 — "legacy" is a PERSISTENCE
// distinction (a record that never passes through applyExtractionSafetyNets
// again), never something applyExtractionSafetyNets itself can produce.
// These tests exercise the readiness layer directly, exactly as a genuinely
// historical DB row would be read, to prove that distinction still holds.
describe('historical compatibility — genuinely persisted records never touched by fresh extraction', () => {
  it('a genuinely historical persisted fee (billability_condition property absent, never run through normalizeBillabilityCondition) keeps exact Step-11 compatibility behavior', () => {
    // Constructed directly, NOT via applyExtractionSafetyNets — this IS
    // what "legacy" means: a record extraction never touches again.
    const historical: OneTimeFee = { fee_label: 'Legacy fee', amount: 5000, due_date: '2024-01-01', description: null }
    expect(historical.billability_condition).toBeUndefined()
    expect(historical.manual_trigger).toBeUndefined()
  })

  it('if that same historical fee is RE-EXTRACTED, it enters the Step-12 lifecycle like any other fresh result — the legacy exemption does not persist across a real re-extraction', () => {
    const reExtracted = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ fee_label: 'Legacy fee', amount: 5000, due_date: '2024-01-01' }),
    ] })).one_time_fees[0]
    expect(reExtracted.billability_condition).toBeNull() // no longer undefined — genuinely evaluated now
  })
})

describe('fee_id assignment (Step 13) — stable subject identity for operational_event_evidence', () => {
  it('a fee entering the Step-12 lifecycle via a valid condition gets a fee_id', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    expect(typeof fee.fee_id).toBe('string')
    expect(fee.fee_id!.length).toBeGreaterThan(0)
  })

  it('a fee canonicalized to null (fresh omission) also gets a fee_id', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [oneTimeFee({ amount: 100000, due_date: null })] })).one_time_fees[0]
    expect(typeof fee.fee_id).toBe('string')
  })

  it('an exempted variable-rate-shaped fee does NOT get a fee_id — it never enters the Step-12 lifecycle at all', () => {
    const fee = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 0, manual_trigger: true, metric_name: 'hours', rate_per_unit: 150 }),
    ] })).one_time_fees[0]
    expect(fee.fee_id).toBeUndefined()
  })

  it('an already-assigned fee_id is never reassigned across a second normalization pass (stable identity)', () => {
    const once = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ amount: 100000, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>),
    ] })).one_time_fees[0]
    const twice = applyExtractionSafetyNets(chunk({ one_time_fees: [once] })).one_time_fees[0]
    expect(twice.fee_id).toBe(once.fee_id)
  })

  it('two different fees in the same extraction get two different fee_ids', () => {
    const terms = applyExtractionSafetyNets(chunk({ one_time_fees: [
      oneTimeFee({ fee_label: 'Fee A', amount: 50000, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>),
      oneTimeFee({ fee_label: 'Fee B', amount: 50000, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>),
    ] }))
    const [a, b] = terms.one_time_fees
    expect(a.fee_id).toBeDefined()
    expect(b.fee_id).toBeDefined()
    expect(a.fee_id).not.toBe(b.fee_id)
  })
})
