import { describe, it, expect } from 'vitest'
import { isHeldHistoricalTerminalSettlement } from './terminal-settlement-guard'

const base = {
  invoice_type: 'terminal_settlement',
  status: 'scheduled',
  created_at: '2026-08-24T15:26:02.064526+00:00',
  period_start: '2026-08-24',
}

describe('isHeldHistoricalTerminalSettlement — scheduler-side defense-in-depth', () => {
  // Historical terminal row → scheduler held even if migration status
  // correction was missed (the row is 'scheduled', not 'backfill_review').
  it('holds a scheduled row whose created_at is after its own period_start (clearly historical — Meridian-shaped)', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, created_at: '2026-08-24T15:26:02.064526+00:00', period_start: '2026-02-01',
    })).toBe(true)
  })

  it('holds a scheduled row whose created_at equals its own period_start (born already-due — equality binds to held)', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, created_at: '2026-08-24T15:26:02.064526+00:00', period_start: '2026-08-24',
    })).toBe(true)
  })

  // Fresh future terminal row → remains executable normally.
  it('does not hold a scheduled row whose period_start is in the future relative to created_at (ordinary freshly-approved contract)', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, created_at: '2026-08-24T15:26:02.064526+00:00', period_start: '2027-10-01',
    })).toBe(false)
  })

  it('does not hold one of the 18 safe backfilled rows even though created_at (backfill time) predates the far-future trigger date', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, created_at: '2026-08-24T15:26:02.064526+00:00', period_start: '2029-01-01',
    })).toBe(false)
  })

  it('never holds a non-terminal_settlement row, regardless of created_at/period_start shape', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, invoice_type: 'period', period_start: '2020-01-01',
    })).toBe(false)
  })

  it('never holds a row not in status=scheduled (e.g. already sent/failed/parked/processing) — mirrors Meridian/Stravito, which never reach this check at all since the scheduled-rows query excludes them', () => {
    for (const status of ['sent', 'failed', 'parked', 'processing', 'backfill_review']) {
      expect(isHeldHistoricalTerminalSettlement({ ...base, status, period_start: '2020-01-01' })).toBe(false)
    }
  })

  it('trusted activation: a set backfill_released_at exempts an otherwise-held row', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, period_start: '2020-01-01', backfill_released_at: '2026-08-25T09:00:00.000Z',
    })).toBe(false)
  })

  it('an explicitly null backfill_released_at is treated the same as absent — still held', () => {
    expect(isHeldHistoricalTerminalSettlement({
      ...base, period_start: '2020-01-01', backfill_released_at: null,
    })).toBe(true)
  })
})
