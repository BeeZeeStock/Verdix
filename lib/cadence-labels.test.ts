import { describe, it, expect } from 'vitest'
import { cadenceNoun, ruleCadenceLabel, partialPeriodLabel, volumeTierCopy } from './cadence-labels'

describe('volumeTierCopy — Step 16A unit-aware volume-tier copy', () => {
  it('uses the contract\'s actual unit type (SQM), not a hard-coded "transaction"', () => {
    const copy = volumeTierCopy('SQM')
    expect(copy).toBe('The rate corresponding to total monthly SQM volume applies to every SQM in that calendar month; tiers are not progressive.')
    expect(copy).not.toContain('transaction')
  })

  it('still reads correctly for a transaction-priced contract — the fix generalizes, it does not special-case SQM', () => {
    expect(volumeTierCopy('transaction')).toContain('every transaction in that calendar month')
  })

  it('falls back to a generic "unit" noun rather than rendering an empty/undefined unit type', () => {
    expect(volumeTierCopy(null)).toContain('every unit in that calendar month')
    expect(volumeTierCopy(undefined)).toContain('every unit in that calendar month')
    expect(volumeTierCopy('')).toContain('every unit in that calendar month')
  })
})

describe('cadenceNoun / ruleCadenceLabel / partialPeriodLabel — existing shared cadence helpers (sanity coverage)', () => {
  it('maps known cadences and passes through unknown ones', () => {
    expect(cadenceNoun('monthly')).toBe('month')
    expect(cadenceNoun('quarterly')).toBe('quarter')
    expect(cadenceNoun(null)).toBe('period')
  })

  it('prefixes "calendar" only when reset_anchor is calendar', () => {
    expect(ruleCadenceLabel('quarterly', 'calendar')).toBe('calendar quarter')
    expect(ruleCadenceLabel('quarterly', 'contract_start')).toBe('quarter')
  })

  it('builds the partial-period label off the actual cadence noun', () => {
    expect(partialPeriodLabel('quarterly')).toBe('Partial-quarter treatment')
  })
})
