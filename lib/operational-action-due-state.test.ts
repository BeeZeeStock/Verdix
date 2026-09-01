import { describe, it, expect } from 'vitest'
import { classifyOperationalActionState, componentStableId, oldestUnresolvedPeriod, type ClosedPeriod } from './operational-action-due-state'

const ASOF = new Date('2026-09-15T12:00:00.000Z')

describe('classifyOperationalActionState', () => {
  it('a future/not-yet-started period is NOT_DUE, even with zero rows', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-10-01', periodEnd: '2026-10-31',
      requiredKeys: ['paid_invoice_value'], finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('NOT_DUE')
  })

  it('an ACTIVE (still-measuring, not yet closed) period is NOT_DUE, even with zero rows — never a premature blocker (§5)', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      requiredKeys: ['paid_invoice_value'], finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('NOT_DUE')
  })

  it('§3 — a CLOSED period with ZERO value rows at all -> INPUT_REQUIRED (the core E9C.1 gap)', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
      finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('INPUT_REQUIRED')
  })

  it('§4 — a CLOSED period with ONE of two required fields saved as draft -> INPUT_DRAFT, not INPUT_REQUIRED', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
      finalizedKeys: new Set(), draftKeys: new Set(['paid_invoice_value']), asOf: ASOF,
    })
    expect(state).toBe('INPUT_DRAFT')
  })

  it('§4 — ALL required fields saved as draft (none finalized) -> still INPUT_DRAFT, not READY', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
      finalizedKeys: new Set(), draftKeys: new Set(['paid_invoice_value', 'total_invoice_value_of_issued_requests']), asOf: ASOF,
    })
    expect(state).toBe('INPUT_DRAFT')
  })

  it('all required fields finalized -> READY, action disappears', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: ['paid_invoice_value', 'total_invoice_value_of_issued_requests'],
      finalizedKeys: new Set(['paid_invoice_value', 'total_invoice_value_of_issued_requests']),
      draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('READY')
  })

  it('a mix — one finalized, one still draft -> INPUT_DRAFT (not fully ready)', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: ['a', 'b'],
      finalizedKeys: new Set(['a']), draftKeys: new Set(['b']), asOf: ASOF,
    })
    expect(state).toBe('INPUT_DRAFT')
  })

  it('no required keys at all (a waived/non-applicable component should never even be checked, but defensively) -> READY', () => {
    const state = classifyOperationalActionState({
      periodStart: '2026-08-01', periodEnd: '2026-08-31',
      requiredKeys: [], finalizedKeys: new Set(), draftKeys: new Set(), asOf: ASOF,
    })
    expect(state).toBe('READY')
  })
})

describe('componentStableId', () => {
  it('prefers recurring_fee_id when present', () => {
    expect(componentStableId('rf_abc', 'Performance share')).toBe('rf_abc')
  })
  it('falls back to feeLabel for legacy data with no stable id', () => {
    expect(componentStableId(null, 'Performance share')).toBe('Performance share')
    expect(componentStableId(undefined, 'Performance share')).toBe('Performance share')
  })
})

// Step E9C.2 §6/§7/§8 — the audited fix for a real correctness gap: using
// only "the most recent closed period" can silently lose an OLDER
// unresolved requirement once a newer period also closes, even though
// the real arrears billing pipeline is still blocked on the older one.
describe('oldestUnresolvedPeriod', () => {
  const OCT: ClosedPeriod = { periodStart: '2026-10-01', periodEnd: '2026-10-31' }
  const NOV: ClosedPeriod = { periodStart: '2026-11-01', periodEnd: '2026-11-30' }
  const DEC: ClosedPeriod = { periodStart: '2026-12-01', periodEnd: '2026-12-31' }

  it('normal case — a single closed, unresolved period is returned', () => {
    expect(oldestUnresolvedPeriod([OCT], () => false)).toEqual(OCT)
  })

  it('§7 — Oct AND Nov both unresolved: Oct (the OLDEST) is returned, never silently replaced by Nov', () => {
    const resolved = new Set<string>() // nothing resolved
    const result = oldestUnresolvedPeriod([OCT, NOV], p => resolved.has(p.periodStart))
    expect(result).toEqual(OCT)
  })

  it('§7 — Oct resolved, Nov still unresolved: Nov is correctly returned (the gap advances once the older one is fixed)', () => {
    const resolved = new Set([OCT.periodStart])
    const result = oldestUnresolvedPeriod([OCT, NOV], p => resolved.has(p.periodStart))
    expect(result).toEqual(NOV)
  })

  it('§7 — an older unresolved period is NOT lost merely because a newer period also closed (Oct unresolved, Nov unresolved, Dec unresolved -> still Oct)', () => {
    const result = oldestUnresolvedPeriod([OCT, NOV, DEC], () => false)
    expect(result).toEqual(OCT)
  })

  it('all periods resolved -> null (genuinely no due action, not an error)', () => {
    const result = oldestUnresolvedPeriod([OCT, NOV], () => true)
    expect(result).toBeNull()
  })

  it('no closed periods at all -> null', () => {
    expect(oldestUnresolvedPeriod([], () => false)).toBeNull()
  })
})
