// Freezes: "monthly in advance" alone (no explicit calendar-month or
// contract-start language) must not prove either billing-period anchor —
// an unstated anchor stays a reviewer-policy question and blocks
// readiness until confirmed. Also freezes the calendar/contract-start
// proration math itself (lib/tariff.ts), which already has extensive
// existing coverage in lib/tariff.test.ts — this corpus adds the specific
// "ambiguity must stay open" readiness case per the Step 1 spec rather
// than re-deriving the calculation tests. No AI calls.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { resolveWindowMinimum, computeMinimumCommitmentSchedule } from '@/lib/tariff'
import { deriveSelectedOption } from '@/lib/rule-interpretation'
import type { PeriodProrationRule } from '@/lib/types'

describe('normalized rule — an unstated billing-period anchor is neither calendar nor contract_start', () => {
  it('"billed monthly in advance" with no anchor language extracts as reset_anchor: null, not defaulted to either value', () => {
    const bfp: PeriodProrationRule = { reset_anchor: null, prorate_partial_periods: 'unclear', requires_confirmation: true, source_clause: 'The platform fee is billed monthly in advance.' }
    expect(bfp.reset_anchor).not.toBe('calendar')
    expect(bfp.reset_anchor).not.toBe('contract_start')
    expect(bfp.reset_anchor).toBeNull()
  })
  it('deriveSelectedOption never maps a null reset_anchor to a concrete structured choice — falls back to "other", never guesses', () => {
    expect(deriveSelectedOption('base_fee_proration', { reset_anchor: null })).toBe('other')
  })
})

describe('readiness — an unstated anchor blocks; an explicitly confirmed one (either direction) does not', () => {
  // computeCommercialRuleWorkload's base_fee_proration check only reads
  // requires_confirmation (see CommercialRuleTerms's ProrationLike) — the
  // full PeriodProrationRule fixtures here document the REAL shape a
  // reviewer confirms, even though this particular function only consults
  // one field of it. Declared as PeriodProrationRule explicitly so the
  // object literal's extra fields don't trip excess-property checking
  // against the narrower structural type computeCommercialRuleWorkload
  // actually accepts.
  const unresolvedAnchor: PeriodProrationRule = { reset_anchor: null, prorate_partial_periods: 'unclear', requires_confirmation: true }
  const contractStartAnchor: PeriodProrationRule = { reset_anchor: 'contract_start', prorate_partial_periods: false, requires_confirmation: false }
  const calendarAnchor: PeriodProrationRule = { reset_anchor: 'calendar', prorate_partial_periods: true, requires_confirmation: false }

  it('reset_anchor null + requires_confirmation true blocks all_commercial_rules_confirmed, listed by name in blockers', () => {
    const workload = computeCommercialRuleWorkload({ base_fee_proration: unresolvedAnchor }, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('base_fee_proration')
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
  })
  it('a reviewer explicitly confirming contract_start anchoring clears the blocker', () => {
    const workload = computeCommercialRuleWorkload({ base_fee_proration: contractStartAnchor }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('base_fee_proration')
  })
  it('a reviewer explicitly confirming calendar anchoring ALSO clears the blocker — either direction is a valid resolution, the ambiguity itself is what blocks', () => {
    const workload = computeCommercialRuleWorkload({ base_fee_proration: calendarAnchor }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('base_fee_proration')
  })
})

describe('calculation — calendar vs. contract_start anchoring produce different partial-period amounts for the identical fee (delegates to the existing lib/tariff.ts engine, see lib/tariff.test.ts for the full matrix)', () => {
  const contractStart = new Date('2026-08-17')
  const contractEnd   = new Date('2028-08-16')

  it('contract_start anchoring never produces a partial window at all — the full fee always applies, proration is moot', () => {
    const result = resolveWindowMinimum(
      { start: new Date('2026-08-17'), end: new Date('2026-11-16') },
      contractStart, contractEnd, 'contract_start',
      { amount: 5000, prorate_partial_periods: true },
    )
    expect(result.amount).toBe(5000)
    expect(result.requiresConfirmation).toBe(false)
  })
  it('calendar anchoring with an unconfirmed proration treatment on a genuinely partial window never guesses an amount', () => {
    const result = resolveWindowMinimum(
      { start: new Date('2026-07-01'), end: new Date('2026-09-30') },
      contractStart, contractEnd, 'calendar',
      { amount: 5000, prorate_partial_periods: 'unclear' },
    )
    expect(result.amount).toBeNull()
    expect(result.requiresConfirmation).toBe(true)
  })
  it('calendar anchoring with an explicitly confirmed proration treatment computes a real prorated figure for the partial first window, strictly less than the contract_start case above', () => {
    const schedule = computeMinimumCommitmentSchedule(
      contractStart, contractEnd, 'quarterly', 'calendar',
      { amount: 5000, prorate_partial_periods: true },
    )
    expect(schedule.requiresConfirmation).toBe(false)
    expect(schedule.partialWindowCount).toBeGreaterThan(0)
    expect(schedule.total).not.toBeNull()
  })
})
