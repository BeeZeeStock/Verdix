import { describe, it, expect } from 'vitest'
import { classifyBackfillTerminalSettlementStatus, deriveTerminalSettlementTarget, isTerminalSettlementNeeded } from './terminal-settlement'
import { enumerateCadenceWindows } from './tariff'
import type { ContractTerms } from './types'

// Contract B's real dates: 12-month term, 2026-10-01 → 2027-09-30, monthly
// billing. computeBillingSchedule's own last-generated period is exactly
// { periodStart: 2027-09-01, periodEnd: 2027-09-30 } — reused verbatim here
// rather than re-derived, matching how the real caller (lib/billing-writer.ts)
// passes it in.
const CONTRACT_B_LAST_PERIOD_START = new Date(2027, 8, 1)  // Sep 1, 2027
const CONTRACT_B_LAST_PERIOD_END   = new Date(2027, 8, 30) // Sep 30, 2027

const termsWithUsage: Pick<ContractTerms, 'overage_tiers' | 'service_credits'> = {
  overage_tiers: [{ unit_type: 'Processed Transaction', rate_per_unit: 1.1 }] as ContractTerms['overage_tiers'],
  service_credits: [],
}

describe('isTerminalSettlementNeeded', () => {
  it('true when the contract has overage_tiers', () => {
    expect(isTerminalSettlementNeeded({ overage_tiers: [{}] as ContractTerms['overage_tiers'], service_credits: [] })).toBe(true)
  })
  it('true when the contract has service_credits (even with no overage_tiers)', () => {
    expect(isTerminalSettlementNeeded({ overage_tiers: [], service_credits: [{}] as ContractTerms['service_credits'] })).toBe(true)
  })
  it('false for a pure flat-fee contract — nothing for a terminal row to ever settle', () => {
    expect(isTerminalSettlementNeeded({ overage_tiers: [], service_credits: [] })).toBe(false)
  })
  it('false when both fields are absent entirely (legacy/undefined)', () => {
    expect(isTerminalSettlementNeeded({})).toBe(false)
  })
})

describe('deriveTerminalSettlementTarget — Contract B (A/B/C)', () => {
  it('A/C: settlement target is September, not October — settlementPeriodStart/End are the real final period, triggerDate is the day after', () => {
    const target = deriveTerminalSettlementTarget(CONTRACT_B_LAST_PERIOD_START, CONTRACT_B_LAST_PERIOD_END, termsWithUsage)
    expect(target).toEqual({
      settlementPeriodStart: '2027-09-01',
      settlementPeriodEnd: '2027-09-30',
      triggerDate: '2027-10-01',
    })
  })

  it('B: the function itself carries no base-amount concept at all — the caller (lib/billing-writer.ts) is solely responsible for setting base_amount: 0 on the row it constructs from this target', () => {
    const target = deriveTerminalSettlementTarget(CONTRACT_B_LAST_PERIOD_START, CONTRACT_B_LAST_PERIOD_END, termsWithUsage)
    expect(target).not.toHaveProperty('baseAmount')
    expect(Object.keys(target!)).toEqual(['settlementPeriodStart', 'settlementPeriodEnd', 'triggerDate'])
  })

  it('returns null for a pure flat-fee contract — no terminal row is generated at all', () => {
    const target = deriveTerminalSettlementTarget(CONTRACT_B_LAST_PERIOD_START, CONTRACT_B_LAST_PERIOD_END, { overage_tiers: [], service_credits: [] })
    expect(target).toBeNull()
  })

  it('triggerDate uses calendar-field arithmetic, not raw millisecond addition — DST-safe across a fall-back transition (mirrors lib/tariff.ts\'s established convention)', () => {
    const originalTZ = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // Nov 1 2026 is the real US fall-back transition — a naive
      // +86_400_000ms trigger-date calculation would land on Nov 1 23:00,
      // not Nov 2 00:00. Using a hypothetical contract whose last period
      // ends Oct 31, 2026 (so the day-after trigger crosses into Nov 1 —
      // not itself the transition day, chosen instead to prove the
      // *general* field-based mechanism is used, consistent with every
      // other date-boundary derivation in this codebase; the transition-
      // day-specific proof already lives in lib/tariff.test.ts).
      const target = deriveTerminalSettlementTarget(new Date(2026, 9, 1), new Date(2026, 9, 31), termsWithUsage)
      expect(target?.triggerDate).toBe('2026-11-01')
    } finally {
      // process.env.TZ = undefined does NOT unset the variable — env vars
      // coerce to the string "undefined", which is not a valid IANA zone
      // and silently falls back to UTC, corrupting every later test's
      // local-time date construction in the same process. Found by this
      // exact failure mode (test H below returned an empty windows array
      // after this test ran). Must delete when there was no original value.
      if (originalTZ === undefined) delete process.env.TZ
      else process.env.TZ = originalTZ
    }
  })
})

describe('classifyBackfillTerminalSettlementStatus — historical backfill hold boundary', () => {
  const MIGRATION_DATE = '2026-08-24'

  // Test A: historical terminal backfill → held, not scheduled.
  it('A: trigger date before the migration date → backfill_review (Meridian: trigger 2026-02-01)', () => {
    expect(classifyBackfillTerminalSettlementStatus('2026-02-01', MIGRATION_DATE)).toBe('backfill_review')
  })
  it('A: trigger date before the migration date → backfill_review (Stravito: trigger 2026-04-01)', () => {
    expect(classifyBackfillTerminalSettlementStatus('2026-04-01', MIGRATION_DATE)).toBe('backfill_review')
  })

  // Test B: future terminal backfill → scheduled.
  it('B: trigger date after the migration date → scheduled', () => {
    expect(classifyBackfillTerminalSettlementStatus('2027-10-01', MIGRATION_DATE)).toBe('scheduled')
  })

  it('equality binds to the held side — a trigger date landing exactly on the migration date is backfill_review, not scheduled', () => {
    expect(classifyBackfillTerminalSettlementStatus('2026-08-24', MIGRATION_DATE)).toBe('backfill_review')
  })

  it('one day after the migration date is already scheduled — the boundary is strict, no off-by-one grace window', () => {
    expect(classifyBackfillTerminalSettlementStatus('2026-08-25', MIGRATION_DATE)).toBe('scheduled')
  })

  it('one day before the migration date is backfill_review', () => {
    expect(classifyBackfillTerminalSettlementStatus('2026-08-23', MIGRATION_DATE)).toBe('backfill_review')
  })
})

describe('H: full Contract Year visible to the Annual Rebate engine from just the September settlement scan range', () => {
  it('enumerateCadenceWindows finds the full Oct2026–Sept2027 annual window when scanned with ONLY [settlementPeriodStart, settlementPeriodEnd] (Sept 2027) — because the window\'s END, not its START, is what must fall in the scan range', () => {
    const target = deriveTerminalSettlementTarget(CONTRACT_B_LAST_PERIOD_START, CONTRACT_B_LAST_PERIOD_END, termsWithUsage)
    expect(target).not.toBeNull()
    const anchorDate = new Date(2026, 9, 1) // contract_start_date
    const scanStart = new Date(target!.settlementPeriodStart + 'T00:00:00')
    const scanEnd   = new Date(target!.settlementPeriodEnd + 'T00:00:00')
    const windows = enumerateCadenceWindows(anchorDate, 'annual', scanStart, scanEnd, 'contract_start')
    expect(windows).toHaveLength(1)
    expect(windows[0].start).toEqual(new Date(2026, 9, 1))
    expect(windows[0].end).toEqual(new Date(2027, 8, 30))
  })
})
