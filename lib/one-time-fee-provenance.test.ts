import { describe, it, expect } from 'vitest'
import { isOneTimeFeeAmountExplicitlyGrounded, deriveOneTimeFeeAmountProvenance, parseAmountCandidates, findExplicitAmounts } from './one-time-fee-provenance'
import { buildOneTimeFeeConfirmation, OneTimeFeeValueMutationRejectedError } from './one-time-fee'
import type { OneTimeFee } from './types'

describe('deriveOneTimeFeeAmountProvenance — Contract B acceptance case', () => {
  it('mints contract_derived for the exact Contract B launch-fee clause', () => {
    const fee = {
      amount: 20000,
      source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.',
    }
    expect(deriveOneTimeFeeAmountProvenance(fee, 'SEK')).toBe('contract_derived')
    expect(isOneTimeFeeAmountExplicitlyGrounded(fee, 'SEK')).toBe(true)
  })
})

// End-to-end, item 8's remaining three cases — chains the extraction-time
// grounding helper directly into the confirmation-time function, rather
// than each module's own tests hardcoding the other's output. Proves the
// two stay correctly composed: provenance is minted once, at extraction,
// and confirmation only ever acknowledges or preserves it.
describe('extraction grounding + confirmation, composed end to end', () => {
  function groundedFee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
    return {
      fee_label: 'Launch Fee',
      amount: 20000,
      due_date: '2026-10-01',
      description: 'One-time launch fee billable on the Effective Date',
      source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.',
      amount_provenance: deriveOneTimeFeeAmountProvenance(
        { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 20,000, billable on the Effective Date.' },
        'SEK',
      ),
      ...overrides,
    }
  }

  it('explicit grounded amount + reviewer confirms -> remains contract_derived, never reviewer_policy', () => {
    const fresh = groundedFee()
    expect(fresh.amount_provenance).toBe('contract_derived') // sanity: extraction actually grounded it
    const confirmed = buildOneTimeFeeConfirmation(fresh, { confirmAmount: true })
    expect(confirmed.amount_provenance).toBe('contract_derived')
    expect(confirmed.amount).toBe(20000)
  })

  it('unresolved amount (extraction could not ground it) + reviewer confirms/supplies -> reviewer_policy', () => {
    const unresolved = groundedFee({
      source_clause: 'Launch fee to be agreed.',
      amount_provenance: deriveOneTimeFeeAmountProvenance({ amount: 20000, source_clause: 'Launch fee to be agreed.' }, 'SEK'),
    })
    expect(unresolved.amount_provenance).toBeNull() // sanity: extraction genuinely could not ground it
    const confirmed = buildOneTimeFeeConfirmation(unresolved, { confirmAmount: true })
    expect(confirmed.amount_provenance).toBe('reviewer_policy')
  })

  it('existing contract_derived amount + a changed submitted amount -> existing guard still rejects, never silently downgraded', () => {
    const fresh = groundedFee()
    expect(() => buildOneTimeFeeConfirmation(fresh, { amount: 25000, confirmAmount: true }))
      .toThrow(OneTimeFeeValueMutationRejectedError)
  })
})

describe('isOneTimeFeeAmountExplicitlyGrounded — required regression cases (item 8)', () => {
  it('explicit SEK amount matches -> contract_derived', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.' }, 'SEK',
    )).toBe(true)
  })

  it('formatted equivalent amount (space-grouped) matches -> contract_derived', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Launch fee: SEK 20 000, due at contract start.' }, 'SEK',
    )).toBe(true)
  })

  it('currency-suffixed formatting also matches -> contract_derived', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'A one-time fee of 20,000 SEK applies.' }, 'SEK',
    )).toBe(true)
  })

  it('source amount differs from extracted amount -> null (not grounded)', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 25,000.' }, 'SEK',
    )).toBe(false)
  })

  it('no explicit amount stated ("to be agreed") -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Launch fee to be agreed.' }, 'SEK',
    )).toBe(false)
  })

  it('range / alternative amount -> null, even though one end happens to match', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Launch fee between SEK 15,000 and SEK 25,000.' }, 'SEK',
    )).toBe(false)
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 15000, source_clause: 'Launch fee between SEK 15,000 and SEK 25,000.' }, 'SEK',
    )).toBe(false)
  })

  it('conflicting restatement of the same fee -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'The launch fee is SEK 20,000. Note: the launch fee was previously quoted at SEK 18,000.' }, 'SEK',
    )).toBe(false)
  })

  it('currency mismatch (clause states EUR, agreement is SEK) -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of EUR 20,000.' }, 'SEK',
    )).toBe(false)
  })

  it('no source_clause at all -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded({ amount: 20000, source_clause: null }, 'SEK')).toBe(false)
    expect(isOneTimeFeeAmountExplicitlyGrounded({ amount: 20000 }, 'SEK')).toBe(false)
  })

  it('blank source_clause -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded({ amount: 20000, source_clause: '   ' }, 'SEK')).toBe(false)
  })

  it('no agreement currency known -> null (never guesses a currency)', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.' }, null,
    )).toBe(false)
  })

  it('zero/negative amount is never grounded', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 0, source_clause: 'Customer will pay a one-time launch fee of SEK 0.' }, 'SEK',
    )).toBe(false)
  })

  it('a bare number with no currency marker is never treated as an explicit monetary amount', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'The launch fee is 20,000, payable at signing.' }, 'SEK',
    )).toBe(false)
  })

  it('the same amount restated twice in-clause is still grounded (not treated as conflicting)', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'The launch fee (SEK 20,000) is due at signing. This SEK 20,000 fee is non-refundable.' }, 'SEK',
    )).toBe(true)
  })

  it('a currency symbol resolves correctly', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 5000, source_clause: 'A one-time onboarding fee of $5,000 applies.' }, 'USD',
    )).toBe(true)
  })
})

// Final amendment — a currency-tagged token must itself have exactly one
// plausible normalized reading before it can ground anything. Matching
// merely because the extracted amount happens to be A member of an
// ambiguous candidate set is not deterministic grounding.
describe('isOneTimeFeeAmountExplicitlyGrounded — ambiguous number formatting fails closed (final amendment)', () => {
  it('unambiguous thousands separator -> contract_derived', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 20,000.' }, 'SEK',
    )).toBe(true)
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'Customer will pay a one-time launch fee of SEK 20 000.' }, 'SEK',
    )).toBe(true)
  })

  it('ambiguous decimal/thousands representation ("20,50") -> null, regardless of which candidate is asked for', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 2050, source_clause: 'Launch fee: SEK 20,50.' }, 'SEK',
    )).toBe(false)
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20.5, source_clause: 'Launch fee: SEK 20,50.' }, 'SEK',
    )).toBe(false)
  })

  it('extracted value happens to equal ONE candidate of an ambiguous token -> still null, not a coincidental match', () => {
    // parseAmountCandidates('20,50') === [2050, 20.5] — 2050 is genuinely
    // one of the plausible readings, but the token itself is still
    // ambiguous, so this must not ground.
    expect(parseAmountCandidates('20,50')).toContain(2050)
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 2050, source_clause: 'A one-time fee of SEK 20,50 applies.' }, 'SEK',
    )).toBe(false)
  })

  it('multiple identical UNAMBIGUOUS amounts in the same clause remain allowed', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'The launch fee (SEK 20,000) is due at signing. This SEK 20,000 fee is non-refundable.' }, 'SEK',
    )).toBe(true)
  })

  it('one matching unambiguous amount + one conflicting unambiguous amount -> null', () => {
    expect(isOneTimeFeeAmountExplicitlyGrounded(
      { amount: 20000, source_clause: 'The launch fee is SEK 20,000. Note: the launch fee was previously quoted at SEK 18,000.' }, 'SEK',
    )).toBe(false)
  })
})

describe('parseAmountCandidates — normalization', () => {
  it('thousands-grouped by comma, space, or dot all normalize to the same integer', () => {
    expect(parseAmountCandidates('20,000')).toContain(20000)
    expect(parseAmountCandidates('20 000')).toContain(20000)
    expect(parseAmountCandidates('20.000')).toContain(20000)
    expect(parseAmountCandidates('20000')).toContain(20000)
  })

  it('a plausible decimal remainder is offered as a candidate alongside the thousands reading', () => {
    expect(parseAmountCandidates('20,50')).toEqual(expect.arrayContaining([2050, 20.5]))
  })
})

describe('findExplicitAmounts', () => {
  it('finds both currency-before and currency-after orderings', () => {
    const before = findExplicitAmounts('SEK 20,000 is due.', 'SEK')
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ currencyToken: 'SEK', numberRaw: '20,000' })

    const after = findExplicitAmounts('20,000 SEK is due.', 'SEK')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ currencyToken: 'SEK', numberRaw: '20,000' })
  })

  it('finds multiple distinct amounts in a range clause', () => {
    const matches = findExplicitAmounts('Between SEK 15,000 and SEK 25,000.', 'SEK')
    expect(matches).toHaveLength(2)
  })
})
