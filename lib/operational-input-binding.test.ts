import { describe, it, expect } from 'vitest'
import {
  buildOperationalInputMap,
  hasAnyBindingActivity,
  resolveInputValueAsOf,
  resolveInputRowAsOf,
  findMonetaryCurrencyProblem,
  type OperationalInputPeriodValueRow,
} from './operational-input-binding'

function row(overrides: Partial<OperationalInputPeriodValueRow>): OperationalInputPeriodValueRow {
  return {
    id: 'id-1',
    input_key: 'paid_invoice_value',
    period_start: '2027-01-01',
    period_end: '2027-01-31',
    value: 80_000,
    currency: null,
    recorded_at: '2027-02-01T00:00:00Z',
    finalized_at: '2027-02-01T00:00:00Z',
    status: 'active',
    revoked_at: null,
    ...overrides,
  }
}

describe('resolveInputValueAsOf — draft/final and asOf semantics', () => {
  it('resolves a finalized row recorded before asOf', () => {
    const rows = [row({ recorded_at: '2027-02-01T00:00:00Z', finalized_at: '2027-02-01T00:00:00Z', value: 80_000 })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')).toBe(80_000)
  })

  it('a draft (finalized_at null) is never resolved, at any asOf — only final values may execute billing', () => {
    const rows = [row({ finalized_at: null })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')).toBeNull()
  })

  it('a row not yet recorded as of the requested instant is not resolved', () => {
    const rows = [row({ recorded_at: '2027-02-01T00:00:00Z', finalized_at: '2027-02-01T00:00:00Z' })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-01-15T00:00:00Z')).toBeNull()
  })

  it('a revoked row is not resolved once asOf is at/after its revocation', () => {
    const rows = [row({ status: 'revoked', revoked_at: '2027-02-10T00:00:00Z' })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')).toBeNull()
  })

  it('a revoked row IS still resolved for an asOf before its revocation — replaying the past', () => {
    const rows = [row({ status: 'revoked', revoked_at: '2027-02-10T00:00:00Z', value: 80_000 })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-02-05T00:00:00Z')).toBe(80_000)
  })

  it('rows for a different period are never matched', () => {
    const rows = [row({ period_start: '2027-02-01', period_end: '2027-02-28' })]
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')).toBeNull()
  })
})

describe('resolveInputValueAsOf — the exact historical replay scenario', () => {
  // original final value, correction later, current calculation uses
  // correction, historical asOf before correction reproduces original.
  const original = row({ id: 'v1', value: 80_000, recorded_at: '2027-02-01T00:00:00Z', finalized_at: '2027-02-01T00:00:00Z', status: 'revoked', revoked_at: '2027-02-10T00:00:00Z' })
  const corrected = row({ id: 'v2', value: 82_500, recorded_at: '2027-02-10T00:00:00Z', finalized_at: '2027-02-10T00:00:00Z', status: 'active', revoked_at: null })
  const rows = [original, corrected]

  it('a "current" calculation (asOf now/after the correction) uses the corrected value', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-06-01T00:00:00Z')).toBe(82_500)
  })

  it('a historical asOf BEFORE the correction reproduces the ORIGINAL value, unaffected by the later correction', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-02-05T00:00:00Z')).toBe(80_000)
  })

  it('an asOf exactly at the revocation instant sees the corrected value, not the original (revoked_at is the exclusive boundary)', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-02-10T00:00:00Z')).toBe(82_500)
  })

  it('an asOf before the original was even recorded resolves nothing', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-01-15T00:00:00Z')).toBeNull()
  })
})

describe('Step 17C.1b, item B — a value finalized AFTER T is invisible at asOf T', () => {
  // The precise scenario the task asks for: a value that will EVENTUALLY
  // be finalized (recorded_at/finalized_at both later than T) must not be
  // visible to a replay whose asOf is T, even though at the real "now"
  // (after finalization) it's the correct, current fact.
  const finalizedLater = row({
    id: 'v1', value: 91_000,
    recorded_at: '2027-02-20T00:00:00Z', finalized_at: '2027-02-20T00:00:00Z',
  })
  const rows = [finalizedLater]
  const T = '2027-02-10T00:00:00Z' // strictly before recorded_at/finalized_at

  it('is invisible (null) at asOf T, strictly before it was finalized', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', T)).toBeNull()
  })

  it('becomes visible at asOf exactly its own finalized_at instant', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-02-20T00:00:00Z')).toBe(91_000)
  })

  it('is visible for any later asOf, including "now"', () => {
    expect(resolveInputValueAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-12-31T00:00:00Z')).toBe(91_000)
  })

  it('a row finalized after asOf but with recorded_at somehow earlier is STILL invisible — finalized_at is checked explicitly, not inferred from recorded_at alone (defense in depth per item B)', () => {
    // Deliberately constructs the shape the explicit finalized_at <= asOf
    // check exists to catch even though "mark final" never actually
    // produces it today (recorded_at === finalized_at by construction) —
    // this proves the check is real, not merely implied by recorded_at.
    const oddRow = row({ recorded_at: '2027-01-05T00:00:00Z', finalized_at: '2027-02-20T00:00:00Z' })
    expect(resolveInputValueAsOf([oddRow], 'paid_invoice_value', '2027-01-01', '2027-01-31', T)).toBeNull()
  })
})

describe('resolveInputRowAsOf — full row access (needed for currency checks)', () => {
  it('returns the whole resolved row, not just its value', () => {
    const rows = [row({ currency: 'SEK' })]
    const resolved = resolveInputRowAsOf(rows, 'paid_invoice_value', '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')
    expect(resolved?.currency).toBe('SEK')
  })
})

describe('buildOperationalInputMap', () => {
  it('shapes final rows for the requested period into a plain input map, using the resolved (draft-excluded) value', () => {
    const rows = [
      row({ input_key: 'paid_invoice_value', value: 80_000 }),
      row({ input_key: 'total_invoice_value_of_issued_requests', value: 100_000 }),
    ]
    const map = buildOperationalInputMap(rows, '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')
    expect(map).toEqual({ paid_invoice_value: 80_000, total_invoice_value_of_issued_requests: 100_000 })
  })

  it('a draft row is treated as absent (null), never a provisional figure', () => {
    const rows = [row({ input_key: 'paid_invoice_value', finalized_at: null })]
    const map = buildOperationalInputMap(rows, '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z')
    expect(map.paid_invoice_value).toBeNull()
  })

  it('defaults asOf to "now" when omitted', () => {
    const rows = [row({ input_key: 'paid_invoice_value', recorded_at: '2020-01-01T00:00:00Z', finalized_at: '2020-01-01T00:00:00Z' })]
    const map = buildOperationalInputMap(rows, '2027-01-01', '2027-01-31')
    expect(map.paid_invoice_value).toBe(80_000)
  })
})

describe('findMonetaryCurrencyProblem — Step 17C.1b, item B', () => {
  it('null when a resolved monetary row has a matching currency (case-insensitively)', () => {
    const rows = [row({ input_key: 'paid_invoice_value', currency: 'eur' })]
    expect(findMonetaryCurrencyProblem(rows, ['paid_invoice_value'], '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z', 'EUR')).toBeNull()
  })

  it('"missing" when a resolved monetary row has NO currency set — fails closed rather than assuming it matches', () => {
    const rows = [row({ input_key: 'paid_invoice_value', currency: null })]
    const result = findMonetaryCurrencyProblem(rows, ['paid_invoice_value'], '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z', 'EUR')
    expect(result).toEqual({ input_key: 'paid_invoice_value', problem: 'missing', rowCurrency: null })
  })

  it('"mismatch" when the stored currency genuinely disagrees', () => {
    const rows = [row({ input_key: 'paid_invoice_value', currency: 'SEK' })]
    const result = findMonetaryCurrencyProblem(rows, ['paid_invoice_value'], '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z', 'EUR')
    expect(result).toEqual({ input_key: 'paid_invoice_value', problem: 'mismatch', rowCurrency: 'SEK' })
  })

  it('null when the input has no resolved row at all — that\'s the ordinary "missing input" case, not a currency problem', () => {
    expect(findMonetaryCurrencyProblem([], ['paid_invoice_value'], '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z', 'EUR')).toBeNull()
  })

  it('a countable input\'s currency: null is never even checked — the caller only ever passes monetary-classified keys, and this function trusts that', () => {
    // total_invoice_value_of_issued_requests is monetary by naming
    // convention; a genuinely countable key (e.g. issued_payment_request_count)
    // simply never appears in the monetaryInputKeys list a caller builds
    // via lib/operational-data-inputs.ts's isMonetaryOperationalInput —
    // this test documents that this function itself has no opinion once a
    // key isn't in the list at all.
    const rows = [row({ input_key: 'issued_payment_request_count', currency: null })]
    expect(findMonetaryCurrencyProblem(rows, [], '2027-01-01', '2027-01-31', '2027-03-01T00:00:00Z', 'EUR')).toBeNull()
  })
})

describe('hasAnyBindingActivity', () => {
  it('true only when every required input key has at least one row, of any period/finality', () => {
    const rows = [row({ input_key: 'paid_invoice_value' }), row({ input_key: 'total_invoice_value_of_issued_requests' })]
    expect(hasAnyBindingActivity(rows, ['paid_invoice_value', 'total_invoice_value_of_issued_requests'])).toBe(true)
  })

  it('false when a required key has never had any row at all', () => {
    const rows = [row({ input_key: 'paid_invoice_value' })]
    expect(hasAnyBindingActivity(rows, ['paid_invoice_value', 'some_other_input'])).toBe(false)
  })

  it('false for an empty rows list with any required key', () => {
    expect(hasAnyBindingActivity([], ['paid_invoice_value'])).toBe(false)
  })
})
