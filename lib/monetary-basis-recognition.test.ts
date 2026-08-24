import { describe, it, expect } from 'vitest'
import { deriveMonetaryBasisRecognition, resolveMonetaryBasisRecognition } from './monetary-basis-recognition'

describe('deriveMonetaryBasisRecognition', () => {
  it('explicit "actually paid" -> paid / contract_derived (Contract B\'s real basis_component)', () => {
    const result = deriveMonetaryBasisRecognition({
      basisComponent: 'transaction-processing fees actually paid for that Contract Year',
      sourceClause: null,
    })
    expect(result).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('proves a fresh Contract-B-style extraction obtains the structured field without requiring the migration — using the credit\'s real, live source_clause', () => {
    const result = deriveMonetaryBasisRecognition({
      basisComponent: 'transaction-processing fees actually paid for that Contract Year',
      sourceClause: 'If Customer records more than 1,800,000 Processed Transactions during a Contract Year, Customer earns a rebate equal to 3.5% of the transaction-processing fees actually paid for that Contract Year. Platform subscription fees, chargeback fees, one-time fees, taxes, and previously applied credits are excluded from the rebate basis. Supplier will calculate the rebate within 30 days after the end of the Contract Year and issue the earned amount as a credit. The rebate credit may be applied against transaction-processing fees and platform subscription fees on invoices issued after the rebate is calculated.',
    })
    expect(result).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('bare "paid" (no qualifying language) is still sufficient — explicitly authorized as one of the three example phrases', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees paid by Customer', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('"payment received" -> paid / contract_derived', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'transaction fees for which payment received in the Contract Year', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('"invoiced fees" -> NOT paid (unclear/null) — invoiced is a commercially different concept', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'invoiced transaction-processing fees', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })

  it('"amounts payable" -> NOT paid — payable never counts as evidence of payment having occurred', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'amounts payable for transaction processing', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })

  it('generic "10% of that month\'s platform fee" -> unclear, not paid — the exact underspecified fixture scenario', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'platform_fee', sourceClause: '10% of that month\'s platform fee' }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })

  it('none of the excluded words (fee/amount/charged/invoiced/billed/payable/due) alone ever trigger paid', () => {
    for (const word of ['fee', 'amount', 'charged', 'invoiced', 'billed', 'payable', 'due']) {
      expect(deriveMonetaryBasisRecognition({ basisComponent: `transaction-processing ${word}`, sourceClause: null }))
        .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
    }
  })

  it('both fields absent -> unclear, not a crash', () => {
    expect(deriveMonetaryBasisRecognition({})).toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })

  // 2026-08-30 provenance-locality amendment — superseded behavior: a
  // marker in source_clause no longer rescues a PRESENT-but-inconclusive
  // basis_component. Once basis_component is non-empty, it is the sole
  // evidence consulted — see the "provenance-locality amendment" describe
  // block below for the full set of cases this changed.
  it('basis_component present but inconclusive is NOT rescued by a marker elsewhere in source_clause', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'platform_fee', sourceClause: 'the platform fee actually paid each month' }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
})

// 2026-08-30 follow-up audit, Part 4 — marker locality/negation. A bare
// \bpaid\b match is not sufficient on its own; the source can explicitly
// negate payment having occurred, and the matcher must not mint
// contract_derived on a negated occurrence.
describe('deriveMonetaryBasisRecognition — negation and locality', () => {
  it('"fees actually paid" -> paid (positive control)', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees actually paid', sourceClause: null }).monetary_basis_recognition).toBe('paid')
  })
  it('"payment received for the fees" -> paid (positive control)', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'payment received for the fees', sourceClause: null }).monetary_basis_recognition).toBe('paid')
  })
  it('"fees not paid" -> NOT paid — negated occurrence must never mint contract_derived', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees not paid', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('"fees unpaid at year end" -> NOT paid', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees unpaid at year end', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('"fees payable" -> NOT paid', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees payable', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('"fees due" -> NOT paid', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees due', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('a wider negation phrasing ("fees that have not been paid") is also rejected — within the lookback window, not just adjacent', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees that have not been paid', sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('an n\'t contraction negation ("fees that weren\'t paid") is rejected', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: "fees that weren't paid", sourceClause: null }))
      .toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
  it('a later, genuinely unnegated occurrence still counts even after an earlier negated one in the same text', () => {
    expect(deriveMonetaryBasisRecognition({ basisComponent: 'fees not paid in the prior period are excluded; only fees actually paid count', sourceClause: null }).monetary_basis_recognition)
      .toBe('paid')
  })
  it('locality: basis_component alone (no source_clause) is already sufficient evidence on its own when it has no marker', () => {
    const basisComponentOnly = deriveMonetaryBasisRecognition({ basisComponent: 'platform_fee', sourceClause: null })
    expect(basisComponentOnly.monetary_basis_recognition).toBeNull()
  })
})

// 2026-08-30 provenance-locality amendment (final fail-closed tightening)
// — basis_component, when non-empty, is now the SOLE evidence consulted.
// source_clause is a fallback ONLY when basis_component is absent/empty.
// This intentionally prefers false-negative/unresolved over a false-
// positive contract_derived minted from evidence that isn't actually about
// this specific basis.
describe('deriveMonetaryBasisRecognition — provenance-locality amendment', () => {
  it('basis_component = "transaction-processing fees actually paid..." -> paid (evidence local to basis_component itself)', () => {
    expect(deriveMonetaryBasisRecognition({
      basisComponent: 'transaction-processing fees actually paid for that Contract Year', sourceClause: null,
    })).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('basis_component = "transaction-processing fees" (inconclusive) + source_clause contains unrelated "payment received" -> unresolved, never rescued by source_clause', () => {
    expect(deriveMonetaryBasisRecognition({
      basisComponent: 'transaction-processing fees',
      sourceClause: 'Late invoices accrue interest at 1.5% per month. Separately, payment received for onboarding services is non-refundable.',
    })).toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })

  it('basis_component absent + source_clause = "...fees actually paid..." -> paid (fallback only applies when basis_component itself is absent/empty)', () => {
    expect(deriveMonetaryBasisRecognition({
      basisComponent: null,
      sourceClause: 'Customer earns a rebate equal to 3.5% of the transaction-processing fees actually paid for that Contract Year.',
    })).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('basis_component = "fees not paid" (negated) + source_clause elsewhere says "payment received" -> unresolved, negation is not overridden by an unrelated fallback', () => {
    expect(deriveMonetaryBasisRecognition({
      basisComponent: 'fees not paid',
      sourceClause: 'Payment received under a separate onboarding agreement is treated independently.',
    })).toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
})

describe('resolveMonetaryBasisRecognition — the confirm-rule integration point', () => {
  it('a fresh credit with an "actually paid" clause and no existing value derives paid/contract_derived', () => {
    const result = resolveMonetaryBasisRecognition(null, {
      basisComponent: 'transaction-processing fees actually paid for that Contract Year', sourceClause: null,
    })
    expect(result).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('existing source-derived recognition is NEVER overwritten, even if the (re-)submitted text would derive differently', () => {
    const existing = { monetary_basis_recognition: 'paid' as const, monetary_basis_recognition_provenance: 'contract_derived' as const }
    // Even a submission whose basis_component/source_clause would, on its
    // own, derive to unclear must not downgrade an already-resolved fact.
    const result = resolveMonetaryBasisRecognition(existing, { basisComponent: 'platform_fee', sourceClause: 'invoiced amount' })
    expect(result).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('reviewer resolves paid-basis-finalization policy -> monetary-basis provenance remains contract_derived, untouched by an unrelated confirm', () => {
    // Simulates exactly what PaidBasisFinalizationCard submits: the credit's
    // FULL existing interpretation spread unchanged, with only earn_rule
    // touched — monetary_basis_recognition/_provenance pass through as
    // "existing" here, already resolved from a prior confirm.
    const existing = { monetary_basis_recognition: 'paid' as const, monetary_basis_recognition_provenance: 'contract_derived' as const }
    const result = resolveMonetaryBasisRecognition(existing, {
      basisComponent: 'transaction-processing fees actually paid for that Contract Year',
      sourceClause: null,
    })
    expect(result.monetary_basis_recognition).toBe('paid')
    expect(result.monetary_basis_recognition_provenance).toBe('contract_derived')
  })

  it('unresolved existing state (never derived before) falls through to fresh derivation', () => {
    const result = resolveMonetaryBasisRecognition(
      { monetary_basis_recognition: null, monetary_basis_recognition_provenance: null },
      { basisComponent: 'transaction-processing fees actually paid for that Contract Year', sourceClause: null },
    )
    expect(result).toEqual({ monetary_basis_recognition: 'paid', monetary_basis_recognition_provenance: 'contract_derived' })
  })

  it('an underspecified generic fixture with no existing value stays unclear across repeated confirms', () => {
    const result = resolveMonetaryBasisRecognition(null, { basisComponent: 'platform_fee', sourceClause: '10% of that month\'s platform fee' })
    expect(result).toEqual({ monetary_basis_recognition: null, monetary_basis_recognition_provenance: null })
  })
})
