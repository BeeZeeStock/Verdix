import { describe, it, expect } from 'vitest'
import {
  stripeInvoiceIdempotencyKey, stripeBaseItemIdempotencyKey, stripeOverageItemIdempotencyKey,
  stripeCreditItemIdempotencyKey, stripeFinalizeIdempotencyKey, remembillInvoiceIdempotencyKey,
} from './invoice-scheduler-idempotency'

// Point 5/10 — "prove: original execution, recovered execution use the
// same provider-level identity for the same planned row/operation." A
// "recovered execution" is, from these functions' point of view, simply a
// second call with the identical arguments (row.id and other durable
// identifiers never change across a crash/reclaim) — so proving these are
// pure and deterministic IS the proof.
const ROW_ID = 'planned-invoice-abc123'

describe('Stripe/Remembill idempotency key derivation — stability across recovery', () => {
  it('stripeInvoiceIdempotencyKey is deterministic — same row.id always derives the same key', () => {
    const first = stripeInvoiceIdempotencyKey(ROW_ID)
    const second = stripeInvoiceIdempotencyKey(ROW_ID) // simulates a later, independent (recovered) call
    expect(first).toBe(second)
    expect(first).toBe('verdix-sched-planned-invoice-abc123')
  })

  it('stripeBaseItemIdempotencyKey is deterministic and distinct from the invoice-creation key', () => {
    const key = stripeBaseItemIdempotencyKey(ROW_ID)
    expect(key).toBe(stripeBaseItemIdempotencyKey(ROW_ID))
    expect(key).not.toBe(stripeInvoiceIdempotencyKey(ROW_ID))
  })

  it('stripeOverageItemIdempotencyKey is deterministic given the same meter_key + windowStart', () => {
    const first = stripeOverageItemIdempotencyKey(ROW_ID, 'sync', '2026-10-01', 0)
    const second = stripeOverageItemIdempotencyKey(ROW_ID, 'sync', '2026-10-01', 0)
    expect(first).toBe(second)
  })

  it('two different windows of the SAME meter within one invoice derive distinct keys', () => {
    const windowA = stripeOverageItemIdempotencyKey(ROW_ID, 'sync', '2026-10-01', 0)
    const windowB = stripeOverageItemIdempotencyKey(ROW_ID, 'sync', '2026-11-01', 1)
    expect(windowA).not.toBe(windowB)
  })

  it('falls back to the array index when windowStart is absent (legacy client_pull path), still deterministic', () => {
    const first = stripeOverageItemIdempotencyKey(ROW_ID, 'usage', undefined, 0)
    const second = stripeOverageItemIdempotencyKey(ROW_ID, 'usage', undefined, 0)
    expect(first).toBe(second)
    expect(first).toContain('-0')
  })

  it('stripeCreditItemIdempotencyKey is deterministic given the same credit_rule_id — unchanged pre-existing convention', () => {
    const key = stripeCreditItemIdempotencyKey(ROW_ID, 'credit-4076e59c')
    expect(key).toBe(stripeCreditItemIdempotencyKey(ROW_ID, 'credit-4076e59c'))
    expect(key).toBe('verdix-credit-planned-invoice-abc123-credit-4076e59c')
  })

  it('stripeFinalizeIdempotencyKey is deterministic and distinct from every other Stripe key for this row', () => {
    const finalizeKey = stripeFinalizeIdempotencyKey(ROW_ID)
    expect(finalizeKey).toBe(stripeFinalizeIdempotencyKey(ROW_ID))
    const others = [
      stripeInvoiceIdempotencyKey(ROW_ID),
      stripeBaseItemIdempotencyKey(ROW_ID),
      stripeOverageItemIdempotencyKey(ROW_ID, 'sync', '2026-10-01', 0),
    ]
    expect(others).not.toContain(finalizeKey)
  })

  it('remembillInvoiceIdempotencyKey is deterministic, matching the pre-existing convention', () => {
    expect(remembillInvoiceIdempotencyKey(ROW_ID)).toBe('verdix-sched-planned-invoice-abc123')
    expect(remembillInvoiceIdempotencyKey(ROW_ID)).toBe(remembillInvoiceIdempotencyKey(ROW_ID))
  })

  it('different rows always derive different keys for the same operation — no accidental cross-row collision', () => {
    expect(stripeInvoiceIdempotencyKey('row-1')).not.toBe(stripeInvoiceIdempotencyKey('row-2'))
    expect(stripeFinalizeIdempotencyKey('row-1')).not.toBe(stripeFinalizeIdempotencyKey('row-2'))
  })
})
