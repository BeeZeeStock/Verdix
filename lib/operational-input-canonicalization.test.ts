import { describe, it, expect } from 'vitest'
import { canonicalizeOperationalInputKey, isValidCanonicalKey, resolveRecognizedOperationalInputKey } from './operational-input-canonicalization'

describe('canonicalizeOperationalInputKey — Step 17C.3a item A, explicit alias registry', () => {
  it('collapses the registered Remembill extraction paraphrases to one canonical key, including the 17C.3c addition', () => {
    expect(canonicalizeOperationalInputKey('total_invoice_value_in_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(canonicalizeOperationalInputKey('total_invoice_value_of_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(canonicalizeOperationalInputKey('total_invoice_value_in_issued_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    // Step 17C.3c — the paraphrase observed in the live 2026-08-28 extraction.
    expect(canonicalizeOperationalInputKey('total_invoice_value_of_issued_payment_requests')).toBe('total_invoice_value_of_issued_requests')
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

describe('resolveRecognizedOperationalInputKey — Step 17C.3c, item 2 (execution-authoritative resolution, fails closed)', () => {
  it('the live-observed 17C.3c paraphrase resolves to the canonical execution key', () => {
    expect(resolveRecognizedOperationalInputKey('total_invoice_value_of_issued_payment_requests')).toBe('total_invoice_value_of_issued_requests')
  })

  it('every previously-registered alias still resolves to the canonical execution key', () => {
    expect(resolveRecognizedOperationalInputKey('total_invoice_value_in_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(resolveRecognizedOperationalInputKey('total_invoice_value_of_payment_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(resolveRecognizedOperationalInputKey('total_invoice_value_in_issued_payment_requests')).toBe('total_invoice_value_of_issued_requests')
  })

  it('the exact canonical key itself resolves unchanged', () => {
    expect(resolveRecognizedOperationalInputKey('total_invoice_value_of_issued_requests')).toBe('total_invoice_value_of_issued_requests')
    expect(resolveRecognizedOperationalInputKey('paid_invoice_value')).toBe('paid_invoice_value')
    expect(resolveRecognizedOperationalInputKey('issued_payment_request_count')).toBe('issued_payment_request_count')
  })

  it('casing/punctuation/whitespace variance on a recognized key still resolves', () => {
    expect(resolveRecognizedOperationalInputKey('Total Invoice Value Of Issued Requests')).toBe('total_invoice_value_of_issued_requests')
    expect(resolveRecognizedOperationalInputKey('  paid_invoice_value  ')).toBe('paid_invoice_value')
  })

  it('an UNKNOWN new paraphrase (not registered, not the canonical spelling) fails closed — null, never a freshly-minted identity', () => {
    // This is the exact class of gap 17C.3c hardens against: a genuinely
    // new paraphrase a future live extraction might produce, not yet
    // observed/registered. canonicalizeOperationalInputKey would happily
    // slugify this into a brand new "identity" — resolveRecognized must
    // refuse.
    expect(resolveRecognizedOperationalInputKey('sum_of_invoiced_amounts_for_issued_requests')).toBeNull()
    expect(resolveRecognizedOperationalInputKey('total_billed_value_of_payment_attempts')).toBeNull()
  })

  it('an unrelated, genuinely different concept never resolves merely by sharing words with a recognized key', () => {
    expect(resolveRecognizedOperationalInputKey('failed_payment_requests_count')).toBeNull()
    expect(resolveRecognizedOperationalInputKey('payment_terms')).toBeNull()
  })

  it('blank/empty labels resolve to null, not an empty-string identity', () => {
    expect(resolveRecognizedOperationalInputKey('')).toBeNull()
    expect(resolveRecognizedOperationalInputKey('   ---   ')).toBeNull()
  })

  it('every recognized paraphrase for the same concept resolves to the SAME key — proving saved operational period data under the canonical key is reused across paraphrases, never fragmented into separate identities', () => {
    const paraphrases = [
      'total_invoice_value_in_payment_requests',
      'total_invoice_value_of_payment_requests',
      'total_invoice_value_in_issued_payment_requests',
      'total_invoice_value_of_issued_payment_requests',
      'total_invoice_value_of_issued_requests',
      'Total Invoice Value Of Issued Requests', // casing variance from a fresh extraction pass
    ]
    const resolved = paraphrases.map(resolveRecognizedOperationalInputKey)
    expect(resolved.every(k => k === 'total_invoice_value_of_issued_requests')).toBe(true)
    // A single set — not one entry per paraphrase — is exactly what makes
    // an operational_input_period_values row saved under
    // 'total_invoice_value_of_issued_requests' visible regardless of which
    // of these paraphrases a given extraction pass happened to produce.
    expect(new Set(resolved).size).toBe(1)
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
