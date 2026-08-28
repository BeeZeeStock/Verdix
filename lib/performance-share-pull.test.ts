import { describe, it, expect } from 'vitest'
import { isVariableInvoiceTimingConfirmed } from './performance-share-pull'
import type { VariableInvoiceTimingRule } from './types'

describe('isVariableInvoiceTimingConfirmed — Step 17F.3, item 6 (renamed from isArrearsSettlementTimingConfirmed)', () => {
  it('null/undefined (never attached — should not occur post-compile, but defensive) is never confirmed', () => {
    expect(isVariableInvoiceTimingConfirmed(null)).toBe(false)
    expect(isVariableInvoiceTimingConfirmed(undefined)).toBe(false)
  })

  it('the default, unresolved rule the compiler attaches is never confirmed', () => {
    const rule: VariableInvoiceTimingRule = { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'not stated' }
    expect(isVariableInvoiceTimingConfirmed(rule)).toBe(false)
  })

  it('a reviewer-confirmed invoice_at_next_period_start rule is confirmed', () => {
    const rule: VariableInvoiceTimingRule = { timing: 'invoice_at_next_period_start', requires_confirmation: false }
    expect(isVariableInvoiceTimingConfirmed(rule)).toBe(true)
  })

  it('requires_confirmation true with timing already set to invoice_at_next_period_start (e.g. mid-review) is still NOT confirmed', () => {
    const rule: VariableInvoiceTimingRule = { timing: 'invoice_at_next_period_start', requires_confirmation: true }
    expect(isVariableInvoiceTimingConfirmed(rule)).toBe(false)
  })

  it('requires_confirmation false but timing somehow still "unclear" is NOT treated as authorization', () => {
    const rule: VariableInvoiceTimingRule = { timing: 'unclear', requires_confirmation: false }
    expect(isVariableInvoiceTimingConfirmed(rule)).toBe(false)
  })

  // Step 17F.3, item 6 — invoice_at_period_end is a resolvable VALUE (a
  // contract can state this arrangement) but the execution engine has no
  // distinct path for it yet — must be held exactly like an unresolved
  // rule, never silently executed on the next-period-start cycle.
  it('a reviewer-confirmed invoice_at_period_end rule is NOT authorized — no execution path exists for it yet', () => {
    const rule: VariableInvoiceTimingRule = { timing: 'invoice_at_period_end', requires_confirmation: false }
    expect(isVariableInvoiceTimingConfirmed(rule)).toBe(false)
  })
})
