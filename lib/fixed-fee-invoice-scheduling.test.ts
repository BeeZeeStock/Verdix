import { describe, it, expect } from 'vitest'
import { resolveFixedFeeSchedulingDecision } from './fixed-fee-invoice-scheduling'
import type { FixedFeeBillingTimingRule } from './types'

const periodRow = { invoice_type: 'period', period_start: '2027-01-01', period_end: '2027-01-31' }
const unresolved: FixedFeeBillingTimingRule = { timing: 'unclear', requires_confirmation: true, confirmation_reason: 'x', source_clause: null }
const confirmedStart: FixedFeeBillingTimingRule = { timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'x' }
const confirmedEnd: FixedFeeBillingTimingRule = { timing: 'bill_at_period_end', requires_confirmation: false, confirmation_reason: null, source_clause: 'x' }

describe('resolveFixedFeeSchedulingDecision — Step 17F.6 scheduler-side fail-closed gate', () => {
  it('unresolved timing holds even though period_start has already passed', () => {
    const decision = resolveFixedFeeSchedulingDecision(periodRow, unresolved, '2027-02-01')
    expect(decision.action).toBe('hold')
  })

  it('no rule at all (pre-17F.3 job, never reconciled) is NOT held — falls back to the pre-existing period_start default', () => {
    const decision = resolveFixedFeeSchedulingDecision(periodRow, null, '2027-01-15')
    expect(decision.action).toBe('due')
  })

  it('confirmed bill_at_period_start is due once period_start has passed, same as the old default', () => {
    const decision = resolveFixedFeeSchedulingDecision(periodRow, confirmedStart, '2027-01-15')
    expect(decision.action).toBe('due')
  })

  it('confirmed bill_at_period_end is NOT due at period_start — waits for period_end', () => {
    const decision = resolveFixedFeeSchedulingDecision(periodRow, confirmedEnd, '2027-01-15')
    expect(decision.action).toBe('not_yet_due')
  })

  it('confirmed bill_at_period_end becomes due once period_end has passed', () => {
    const decision = resolveFixedFeeSchedulingDecision(periodRow, confirmedEnd, '2027-02-01')
    expect(decision.action).toBe('due')
  })

  it('non-period invoice types (one_time, terminal_settlement) are never touched by this rule', () => {
    const oneTime = resolveFixedFeeSchedulingDecision({ invoice_type: 'one_time', period_start: '2027-01-01', period_end: '2027-01-01' }, unresolved, '2026-01-01')
    expect(oneTime.action).toBe('due')
    const terminal = resolveFixedFeeSchedulingDecision({ invoice_type: 'terminal_settlement', period_start: '2027-01-01', period_end: '2027-01-01' }, unresolved, '2026-01-01')
    expect(terminal.action).toBe('due')
  })
})
