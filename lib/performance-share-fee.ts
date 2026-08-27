// Step 17C.1 (hardened in 17C.1a) — top-level orchestrator composing the
// generic execution chain (DerivedMetric -> RateSchedule -> PercentageOfBasis)
// with period-aware pilot/waiver materiality gating
// (lib/performance-share-materiality.ts) into a single readiness-gated
// result for one billing period. This is NOT a separate "performance
// billing engine" — it produces a plain amount + trace a caller feeds
// into the SAME OverageLineItem-shaped array/downstream push path every
// other computed-in-arrears charge already uses (see
// lib/performance-share-pull.ts).
import type { PercentageOfBasisConfig } from './types'
import { computePercentageOfBasisFee, type PercentageOfBasisTrace } from './percentage-of-basis-fee'
import {
  performanceShareRequiresConfirmation,
  performanceShareDiscountMultiplierForPeriod,
  type PerformanceShareDiscountLike,
} from './performance-share-materiality'
import { isPartialWindow } from './tariff'

export type PerformanceShareFeeResult =
  | { status: 'ready'; amount: number; trace: PercentageOfBasisTrace; waiverMultiplier: number }
  // Fully waived by a confirmed pilot/waiver discount (waiverMultiplier 0)
  // — amount is 0, but the trace of what WOULD have been charged absent
  // the waiver is preserved for audit, not discarded.
  | { status: 'waived'; amount: 0; trace: PercentageOfBasisTrace; waiverMultiplier: 0 }
  | { status: 'not_ready'; reason: string }
  | { status: 'invalid'; reason: string }

export function computePerformanceShareFee(params: {
  config: PercentageOfBasisConfig
  inputs: Record<string, number | null | undefined>
  discounts: PerformanceShareDiscountLike[] | null | undefined
  // The calculated billing period this fee is FOR — a date RANGE, not a
  // single point, because item 2's period-aware pilot gating needs to
  // know whether the period straddles a pilot/waiver's own dated window,
  // not just whether one representative instant falls inside it.
  periodStart: string
  periodEnd: string
  // Step 17C.1b, item C — when supplied, gates this period against the
  // contract's own real start/end via lib/tariff.ts's isPartialWindow
  // (the SAME primitive the ordinary usage/overage engine already uses to
  // detect a partial window — reused directly, not reimplemented). A
  // terminal-settlement invoice's own period is frequently a truncated
  // final stretch (the contract ends mid-period); a brand-new job's very
  // first period can equally start mid-period. Either shape has no
  // confirmed treatment for applying a MONTHLY percentage formula to a
  // period shorter than a full month — see the readiness gate below.
  contractStartDate?: string | null
  contractEndDate?: string | null
}): PerformanceShareFeeResult {
  const { config, inputs, discounts, periodStart, periodEnd, contractStartDate, contractEndDate } = params
  const periodStartDate = new Date(periodStart + 'T00:00:00')
  const periodEndDate = new Date(periodEnd + 'T00:00:00')

  // Item C — checked before anything else: a partial period (the contract
  // wasn't in effect for this period's full nominal span — most commonly
  // a terminal-settlement final stretch, but symmetrically also a first
  // period starting mid-month) has no confirmed treatment for this
  // MONTHLY percentage-of-basis mechanism. Applying the formula to a
  // truncated period's monetary basis as if it were a full month would
  // silently invent a treatment the contract never states — held instead,
  // exactly like an unresolved pilot scope.
  if (contractStartDate || contractEndDate) {
    const csd = contractStartDate ? new Date(contractStartDate + 'T00:00:00') : null
    const ced = contractEndDate ? new Date(contractEndDate + 'T00:00:00') : null
    if (isPartialWindow({ start: periodStartDate, end: periodEndDate }, csd, ced)) {
      return { status: 'not_ready', reason: 'This period is partial — the contract was not in effect for its full nominal span (e.g. a terminal-settlement final stretch), and there is no confirmed treatment for applying the monthly performance-share formula to a truncated period' }
    }
  }

  // Item 2, period-aware — checked next, before ever attempting the
  // calculation: an unresolved discount/waiver that materially affects
  // this component, AND whose own dated window actually overlaps this
  // period, blocks readiness — regardless of whether the underlying
  // monetary inputs happen to already be available. A period fully
  // outside the pilot's window is never blocked by it, however
  // historically unresolved that pilot's scope question remains. A
  // CONFIRMED waiver whose window only partially covers this period also
  // blocks (straddle) — see performanceShareRequiresConfirmation's own doc.
  const gate = performanceShareRequiresConfirmation(discounts, periodStartDate, periodEndDate)
  if (gate.blocked) {
    return { status: 'not_ready', reason: gate.reasons.join('; ') }
  }

  const calc = computePercentageOfBasisFee(config, inputs)
  if (calc.status !== 'ready') return calc

  // periodStart is a safe representative point for the multiplier check:
  // the gate above already guarantees this period is either fully inside
  // or fully outside any materially-affecting discount's own dated
  // window — never straddling — so checking either endpoint agrees.
  const waiverMultiplier = performanceShareDiscountMultiplierForPeriod(discounts, periodStartDate)
  if (waiverMultiplier === 0) {
    return { status: 'waived', amount: 0, trace: calc.trace, waiverMultiplier: 0 }
  }
  const amount = Math.round(calc.amount * waiverMultiplier * 100) / 100
  return { status: 'ready', amount, trace: calc.trace, waiverMultiplier }
}
