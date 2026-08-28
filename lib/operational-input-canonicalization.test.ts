import { describe, it, expect } from 'vitest'
import { canonicalizeOperationalInputKey, isValidCanonicalKey } from './operational-input-canonicalization'

describe('canonicalizeOperationalInputKey — Step 17C.3a item A, explicit alias registry', () => {
  it('collapses the exact registered Remembill extraction paraphrases to one canonical key', () => {
    expect(canonicalizeOperationalInputKey('total_invoice_value_in_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(canonicalizeOperationalInputKey('total_invoice_value_of_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(canonicalizeOperationalInputKey('total_invoice_value_in_issued_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(canonicalizeOperationalInputKey('total_invoice_value_of_issued_requests')).toBe('total_invoice_value_of_issued_requests')
  })

  it('is a no-op on an already-canonical, non-aliased key', () => {
    expect(canonicalizeOperationalInputKey('paid_invoice_value')).toBe('paid_invoice_value')
    expect(canonicalizeOperationalInputKey('issued_payment_request_count')).toBe('issued_payment_request_count')
  })

  it('normalizes casing/punctuation/whitespace variance syntactically', () => {
    expect(canonicalizeOperationalInputKey('Paid Invoice Value')).toBe('paid_invoice_value')
    expect(canonicalizeOperationalInputKey('  issued_payment_request_count  ')).toBe('issued_payment_request_count')
  })

  describe('collision safety — unregistered keys are NEVER semantically rewritten', () => {
    it('a label containing "for" is passed through syntactically only, never rewritten toward "of"', () => {
      expect(canonicalizeOperationalInputKey('invoice_amount_for_period')).toBe('invoice_amount_for_period')
      expect(canonicalizeOperationalInputKey('discount_for_customer')).toBe('discount_for_customer')
    })

    it('a label containing "in" is passed through syntactically only, never rewritten toward "of"', () => {
      expect(canonicalizeOperationalInputKey('transactions_in_arrears')).toBe('transactions_in_arrears')
      expect(canonicalizeOperationalInputKey('balance_in_credit')).toBe('balance_in_credit')
    })

    it('a label containing "payment_requests" that is NOT one of the four registered aliases stays distinct', () => {
      // "failed" payment requests is a genuinely different quantity from
      // "issued" payment requests — the old heuristic (unigram/bigram
      // rewrite) would have silently collapsed this into the same key as
      // issued_payment_request_count; the explicit registry must not.
      expect(canonicalizeOperationalInputKey('failed_payment_requests_count')).toBe('failed_payment_requests_count')
      expect(canonicalizeOperationalInputKey('total_invoice_value_of_payment_requests')).not.toBe(
        canonicalizeOperationalInputKey('failed_payment_requests_count'),
      )
    })

    it('an unrelated key containing "payment" alone never collides with the issued-requests alias', () => {
      expect(canonicalizeOperationalInputKey('payment_terms')).toBe('payment_terms')
      expect(canonicalizeOperationalInputKey('completed_payment_count')).toBe('completed_payment_count')
      expect(canonicalizeOperationalInputKey('completed_payment_count')).not.toBe('total_invoice_value_of_issued_requests')
    })

    it('two distinct raw labels that are not aliases of each other remain distinct after canonicalization', () => {
      const a = canonicalizeOperationalInputKey('paid_invoice_value')
      const b = canonicalizeOperationalInputKey('total_invoice_value_of_issued_requests')
      const c = canonicalizeOperationalInputKey('issued_payment_request_count')
      expect(new Set([a, b, c]).size).toBe(3)
    })
  })

  it('is idempotent — canonicalizing an already-canonical key changes nothing', () => {
    const once = canonicalizeOperationalInputKey('total_invoice_value_in_payment_requests')
    expect(canonicalizeOperationalInputKey(once)).toBe(once)
  })
})

describe('isValidCanonicalKey', () => {
  it('accepts well-formed snake_case keys', () => {
    expect(isValidCanonicalKey('total_invoice_value_of_issued_requests')).toBe(true)
    expect(isValidCanonicalKey('paid_invoice_value')).toBe(true)
  })

  it('rejects an empty key (e.g. from a blank/punctuation-only raw label)', () => {
    expect(isValidCanonicalKey('')).toBe(false)
    expect(isValidCanonicalKey(canonicalizeOperationalInputKey('   ---   '))).toBe(false)
  })
})
