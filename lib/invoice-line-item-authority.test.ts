import { describe, it, expect } from 'vitest'
import { resolveLineItemAuthorityState } from './invoice-line-item-authority'

// Step E9B.1 §12 — the complete authority rule, tested exhaustively
// against every case the task explicitly requires proof for.
describe('resolveLineItemAuthorityState', () => {
  it('a future scheduled/unprocessed invoice, no persisted variable lines -> provisional_preview (a carry-forward projection is allowed)', () => {
    const state = resolveLineItemAuthorityState({ hasRealLineItems: false, isFailed: false, isPast: false })
    expect(state).toBe('provisional_preview')
  })

  it('a held (PARKED) scheduled invoice -> provisional_preview (ready + blocker representation) — held rows share isPast:false with any other not-yet-issued entry', () => {
    // isHeld only affects effectiveStatus/display copy, never isPast (see
    // BillingSummaryCard.tsx's own isHeld comment) — a held row is
    // structurally identical to any other not-yet-due draft for THIS
    // predicate's purposes, which is exactly why it correctly reuses the
    // same provisional preview (real ready amounts + unresolved-as-state,
    // never a fake number) rather than a fifth, redundant state.
    const state = resolveLineItemAuthorityState({ hasRealLineItems: false, isFailed: false, isPast: false })
    expect(state).toBe('provisional_preview')
  })

  it('a processed/issued invoice with legitimate ZERO variable lines -> confirmed_zero, never falls back to a speculative preview', () => {
    const state = resolveLineItemAuthorityState({ hasRealLineItems: false, isFailed: false, isPast: true })
    expect(state).toBe('confirmed_zero')
  })

  it('a sent/paid historical invoice with REAL persisted lines -> authoritative, regardless of isPast/isFailed', () => {
    expect(resolveLineItemAuthorityState({ hasRealLineItems: true, isFailed: false, isPast: true })).toBe('authoritative')
    // Even a row somehow flagged failed with real lines already persisted
    // still shows those real lines — hasRealLineItems wins outright, the
    // one case allowed to short-circuit everything else.
    expect(resolveLineItemAuthorityState({ hasRealLineItems: true, isFailed: true, isPast: true })).toBe('authoritative')
  })

  it('a failed invoice -> failed_unknown, never claims zero variable usage', () => {
    const state = resolveLineItemAuthorityState({ hasRealLineItems: false, isFailed: true, isPast: true })
    expect(state).toBe('failed_unknown')
    expect(state).not.toBe('confirmed_zero')
  })

  it('failed takes priority over isPast when both are true and there are no real lines — a failed invoice is never mistaken for a cleanly-processed zero', () => {
    const state = resolveLineItemAuthorityState({ hasRealLineItems: false, isFailed: true, isPast: true })
    expect(state).toBe('failed_unknown')
  })

  it('the four states are mutually exclusive for every combination of the three inputs', () => {
    const seen = new Set<string>()
    for (const hasRealLineItems of [true, false]) {
      for (const isFailed of [true, false]) {
        for (const isPast of [true, false]) {
          seen.add(resolveLineItemAuthorityState({ hasRealLineItems, isFailed, isPast }))
        }
      }
    }
    // Exactly the 4 declared states appear across all 8 input combinations
    // — no combination produces an undefined/fifth outcome.
    expect(seen).toEqual(new Set(['authoritative', 'failed_unknown', 'confirmed_zero', 'provisional_preview']))
  })
})
