import { describe, it, expect } from 'vitest'
import {
  resolveOneTimeLineItemAssociation, resolveParkedOneTimeFeeRowFields, resolveScheduledOneTimeFeeRowFields,
  ONE_TIME_ASSOCIATION_BLOCKED_REASON, ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON, type OneTimeLineItemCandidate,
} from './one-time-line-item-resolution'

function item(overrides: Partial<OneTimeLineItemCandidate> = {}): OneTimeLineItemCandidate {
  return { id: 'li-1', product_name: 'Setup Fee', billing_period: 'one_time', unit_price: 4800, total_amount: 4800, quantity: 1, fee_id: null, ...overrides }
}

const targetA = { feeId: 'A', feeLabel: 'Setup Fee' }
const targetNull = { feeId: null, feeLabel: 'Setup Fee' }

describe('resolveOneTimeLineItemAssociation — Step 17H.4B0D4B0B (ID-first resolver matrix)', () => {
  it('1. target A + exactly one A -> matched', () => {
    const row = item({ id: 'li-1', fee_id: 'A' })
    expect(resolveOneTimeLineItemAssociation(targetA, [row])).toEqual({ status: 'matched', item: row })
  })

  it('2. target A + multiple A -> ambiguous', () => {
    const a1 = item({ id: 'li-1', fee_id: 'A' })
    const a2 = item({ id: 'li-2', fee_id: 'A' })
    const result = resolveOneTimeLineItemAssociation(targetA, [a1, a2])
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') expect(result.candidates).toEqual([a1, a2])
  })

  it('3. target A + one A + one matching-label NULL -> ambiguous (unidentified legacy row could be the same fee)', () => {
    const a = item({ id: 'li-1', fee_id: 'A', product_name: 'Setup Fee' })
    const legacyNull = item({ id: 'li-2', fee_id: null, product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetA, [a, legacyNull])
    expect(result.status).toBe('ambiguous')
  })

  it('4. target A + one A + non-null B same label (no NULL rows) -> matched A, B never overrides a positive match', () => {
    const a = item({ id: 'li-1', fee_id: 'A', product_name: 'Setup Fee' })
    const b = item({ id: 'li-2', fee_id: 'B', product_name: 'Setup Fee' })
    expect(resolveOneTimeLineItemAssociation(targetA, [a, b])).toEqual({ status: 'matched', item: a })
  })

  it('5. target A + no A + one matching-label NULL -> legacy fallback match', () => {
    const legacyNull = item({ id: 'li-1', fee_id: null, product_name: 'Setup Fee' })
    expect(resolveOneTimeLineItemAssociation(targetA, [legacyNull])).toEqual({ status: 'matched', item: legacyNull })
  })

  it('6. target A + no A + multiple matching-label NULL -> ambiguous', () => {
    const n1 = item({ id: 'li-1', fee_id: null, product_name: 'Setup Fee' })
    const n2 = item({ id: 'li-2', fee_id: null, product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetA, [n1, n2])
    expect(result.status).toBe('ambiguous')
  })

  it('7. target A + no A + matching-label B (non-null, != A) -> integrity_conflict, never falls back to label', () => {
    const b = item({ id: 'li-1', fee_id: 'B', product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetA, [b])
    expect(result.status).toBe('integrity_conflict')
    if (result.status === 'integrity_conflict') expect(result.candidates).toEqual([b])
  })

  it('8. target A + no A + a NULL row AND a conflicting B row, same label -> integrity_conflict (conflict wins over the NULL fallback)', () => {
    const n = item({ id: 'li-1', fee_id: null, product_name: 'Setup Fee' })
    const b = item({ id: 'li-2', fee_id: 'B', product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetA, [n, b])
    expect(result.status).toBe('integrity_conflict')
  })

  it('9. target A + no relevant rows at all -> missing', () => {
    expect(resolveOneTimeLineItemAssociation(targetA, [])).toEqual({ status: 'missing' })
    expect(resolveOneTimeLineItemAssociation(targetA, [item({ product_name: 'Unrelated Fee', fee_id: null })])).toEqual({ status: 'missing' })
  })

  it('10. target NULL + one matching-label NULL -> matched (legacy fallback, both sides unidentified)', () => {
    const row = item({ id: 'li-1', fee_id: null, product_name: 'Setup Fee' })
    expect(resolveOneTimeLineItemAssociation(targetNull, [row])).toEqual({ status: 'matched', item: row })
  })

  it('11. target NULL + multiple matching-label rows -> ambiguous', () => {
    const r1 = item({ id: 'li-1', fee_id: null, product_name: 'Setup Fee' })
    const r2 = item({ id: 'li-2', fee_id: 'X', product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetNull, [r1, r2])
    expect(result.status).toBe('ambiguous')
  })

  it('12. target NULL + one matching-label IDENTIFIED row -> integrity_conflict (current fee has no identity to verify against)', () => {
    const identified = item({ id: 'li-1', fee_id: 'X', product_name: 'Setup Fee' })
    const result = resolveOneTimeLineItemAssociation(targetNull, [identified])
    expect(result.status).toBe('integrity_conflict')
  })

  it('13. positive ID match despite label mismatch -> matched (label independence once both sides have identity)', () => {
    const row = item({ id: 'li-1', fee_id: 'A', product_name: 'Deployment setup' }) // different label entirely
    expect(resolveOneTimeLineItemAssociation({ feeId: 'A', feeLabel: 'Implementation fee' }, [row])).toEqual({ status: 'matched', item: row })
  })

  it('14. two A rows with DIFFERENT labels -> still ambiguous by ID alone', () => {
    const a1 = item({ id: 'li-1', fee_id: 'A', product_name: 'Label One' })
    const a2 = item({ id: 'li-2', fee_id: 'A', product_name: 'Label Two' })
    const result = resolveOneTimeLineItemAssociation(targetA, [a1, a2])
    expect(result.status).toBe('ambiguous')
  })

  it('15. unrelated identified rows with different labels and different fee_id are simply ignored', () => {
    const unrelated = item({ id: 'li-1', fee_id: 'Z', product_name: 'Totally Unrelated Fee' })
    const match = item({ id: 'li-2', fee_id: 'A', product_name: 'Setup Fee' })
    expect(resolveOneTimeLineItemAssociation(targetA, [unrelated, match])).toEqual({ status: 'matched', item: match })
  })

  it('16. a non-one-time row carrying the target fee_id is never a candidate', () => {
    const nonOneTime = item({ id: 'li-1', fee_id: 'A', billing_period: 'monthly' })
    expect(resolveOneTimeLineItemAssociation(targetA, [nonOneTime])).toEqual({ status: 'missing' })
  })

  it('zero candidates is missing, not an error (legacy label-only case, unchanged)', () => {
    expect(resolveOneTimeLineItemAssociation(targetNull, [])).toEqual({ status: 'missing' })
  })

  it('candidate array order never changes the outcome', () => {
    const a1 = item({ id: 'li-1', fee_id: 'A' })
    const a2 = item({ id: 'li-2', fee_id: 'A' })
    expect(resolveOneTimeLineItemAssociation(targetA, [a1, a2]).status).toBe('ambiguous')
    expect(resolveOneTimeLineItemAssociation(targetA, [a2, a1]).status).toBe('ambiguous')
  })
})

describe('resolveOneTimeLineItemAssociation — Step 17H.4B0D4B0B regression scenarios (pre-D4 execute duplication defense-in-depth)', () => {
  it('modernized-legacy transitional duplicate: old NULL row + new A row, same label, target A -> AMBIGUOUS, never silently picks the modern row', () => {
    const oldLegacy = item({ id: 'li-old', fee_id: null, product_name: 'Setup fee' })
    const newModern = item({ id: 'li-new', fee_id: 'A', product_name: 'Setup fee' })
    const result = resolveOneTimeLineItemAssociation({ feeId: 'A', feeLabel: 'Setup fee' }, [oldLegacy, newModern])
    expect(result.status).toBe('ambiguous')
  })

  it('re-execution duplicate-ID: two rows both fee_id=A (unconditional insert duplicated the row) -> AMBIGUOUS, never first-match', () => {
    const a1 = item({ id: 'li-1', fee_id: 'A' })
    const a2 = item({ id: 'li-2', fee_id: 'A' })
    const result = resolveOneTimeLineItemAssociation({ feeId: 'A', feeLabel: 'Setup Fee' }, [a1, a2])
    expect(result.status).toBe('ambiguous')
  })

  it('identity-not-preserved transition: old row fee_id=A, current contract fee_id=B, no B row yet -> INTEGRITY CONFLICT, never falls back to old A by text', () => {
    const oldA = item({ id: 'li-old', fee_id: 'A', product_name: 'Setup fee' })
    const result = resolveOneTimeLineItemAssociation({ feeId: 'B', feeLabel: 'Setup fee' }, [oldA])
    expect(result.status).toBe('integrity_conflict')
  })

  it('positive B match alongside stale A, same label, no NULL rows -> MATCH B; the runtime resolver never guesses A and B are the same rule', () => {
    const rowB = item({ id: 'li-b', fee_id: 'B', product_name: 'Setup fee' })
    const rowA = item({ id: 'li-a', fee_id: 'A', product_name: 'Setup fee' })
    const result = resolveOneTimeLineItemAssociation({ feeId: 'B', feeLabel: 'Setup fee' }, [rowB, rowA])
    expect(result).toEqual({ status: 'matched', item: rowB })
  })
})

describe('resolveParkedOneTimeFeeRowFields — event-gated/manual-trigger parked rows', () => {
  it('matched by id: uses the line item unit_price and id, label mismatch does not matter', () => {
    const result = resolveParkedOneTimeFeeRowFields({
      feeId: 'A', feeLabel: 'Setup Fee', fallbackRatePerUnit: null,
      lineItems: [item({ fee_id: 'A', product_name: 'Different label', unit_price: 4800 })],
    })
    expect(result).toEqual({ status: 'ok', lineItemId: 'li-1', unitPrice: 4800 })
  })

  it('matched by legacy label fallback: unchanged behavior for the 41 legacy NULL rows', () => {
    const result = resolveParkedOneTimeFeeRowFields({
      feeId: null, feeLabel: 'Setup Fee', fallbackRatePerUnit: null, lineItems: [item({ fee_id: null, unit_price: 4800 })],
    })
    expect(result).toEqual({ status: 'ok', lineItemId: 'li-1', unitPrice: 4800 })
  })

  it('missing: falls back to the fee\'s own rate_per_unit — base_amount is contract_terms-authoritative regardless', () => {
    const result = resolveParkedOneTimeFeeRowFields({ feeId: null, feeLabel: 'Setup Fee', fallbackRatePerUnit: 99, lineItems: [] })
    expect(result).toEqual({ status: 'ok', lineItemId: null, unitPrice: 99 })
  })

  it('ambiguous: blocked, never guesses a unit_price or line_item_id', () => {
    const result = resolveParkedOneTimeFeeRowFields({
      feeId: 'A', feeLabel: 'Setup Fee', fallbackRatePerUnit: null,
      lineItems: [item({ id: 'li-1', fee_id: 'A' }), item({ id: 'li-2', fee_id: 'A' })],
    })
    expect(result).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON })
  })

  it('integrity_conflict: blocked with the distinct conflict message', () => {
    const result = resolveParkedOneTimeFeeRowFields({
      feeId: 'B', feeLabel: 'Setup Fee', fallbackRatePerUnit: null,
      lineItems: [item({ id: 'li-1', fee_id: 'A' })],
    })
    expect(result).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON })
  })
})

describe('resolveScheduledOneTimeFeeRowFields — not-yet-due scheduled rows', () => {
  it('matched with a real breakdown: uses the line item total_amount/quantity/unit_price', () => {
    const result = resolveScheduledOneTimeFeeRowFields({
      feeId: 'A', feeLabel: 'Setup Fee', fallbackAmount: 5000,
      lineItems: [item({ fee_id: 'A', total_amount: 4800, quantity: 2, unit_price: 2400 })],
    })
    expect(result).toEqual({ status: 'ok', baseAmount: 4800, lineItemId: 'li-1', quantity: 2, unitPrice: 2400 })
  })

  it('matched with no real breakdown (quantity/unit_price 0): total_amount still wins, quantity/unitPrice stay null', () => {
    const result = resolveScheduledOneTimeFeeRowFields({
      feeId: 'A', feeLabel: 'Setup Fee', fallbackAmount: 5000,
      lineItems: [item({ fee_id: 'A', total_amount: 4800, quantity: 0, unit_price: 0 })],
    })
    expect(result).toEqual({ status: 'ok', baseAmount: 4800, lineItemId: 'li-1', quantity: null, unitPrice: null })
  })

  it('missing: falls back to the fee amount, never blocks a valid invoice for a missing association', () => {
    const result = resolveScheduledOneTimeFeeRowFields({ feeId: null, feeLabel: 'Setup Fee', fallbackAmount: 5000, lineItems: [] })
    expect(result).toEqual({ status: 'ok', baseAmount: 5000, lineItemId: null, quantity: null, unitPrice: null })
  })

  it('ambiguous: blocked — the line item total_amount could become the charged amount, so it is never guessed', () => {
    const result = resolveScheduledOneTimeFeeRowFields({
      feeId: 'A', feeLabel: 'Setup Fee', fallbackAmount: 5000,
      lineItems: [item({ id: 'li-1', fee_id: 'A', total_amount: 4800 }), item({ id: 'li-2', fee_id: 'A', total_amount: 6000 })],
    })
    expect(result).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON })
  })

  it('integrity_conflict: blocked, never lets a contradictory identified row\'s total_amount become the charge', () => {
    const result = resolveScheduledOneTimeFeeRowFields({
      feeId: 'B', feeLabel: 'Setup Fee', fallbackAmount: 5000,
      lineItems: [item({ id: 'li-1', fee_id: 'A', total_amount: 9999 })],
    })
    expect(result).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON })
  })

  it('candidate array order never changes the outcome for the ambiguous case', () => {
    const a = item({ id: 'li-1', fee_id: 'A', total_amount: 4800 })
    const b = item({ id: 'li-2', fee_id: 'A', total_amount: 6000 })
    const forward = resolveScheduledOneTimeFeeRowFields({ feeId: 'A', feeLabel: 'Setup Fee', fallbackAmount: 5000, lineItems: [a, b] })
    const reversed = resolveScheduledOneTimeFeeRowFields({ feeId: 'A', feeLabel: 'Setup Fee', fallbackAmount: 5000, lineItems: [b, a] })
    expect(forward).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON })
    expect(reversed).toEqual({ status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON })
  })
})
