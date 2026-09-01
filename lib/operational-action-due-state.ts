// Step E9C.1 §1/§2/§3 — the canonical source for "is a component's period-
// end perfmance/usage measurement window actually closed yet" is lib/
// billing-period-card-summary.ts's deriveMeasurementPhase — the SAME
// function Billing Timeline's own category tiles/detail rows already use
// (describeUsageComponentState/describePerformanceComponentState both
// take a `phase` derived from it). Reusing it here, rather than a second
// "if today >= period_end" comparison, is what §5 requires ("do not
// implement... any calendar shortcut" — reuse the existing one) and what
// guarantees Commercial Logic/Dashboard/Timeline can never give
// contradictory due-state answers for the identical period.
//
// The one genuinely NEW piece this module adds beyond the existing
// per-job workspace derivation: distinguishing "zero value rows ever
// recorded" from "a draft row exists" for a closed period — Billing
// Timeline's own PerformanceComponentStatus ('pending_operational_inputs')
// already collapses BOTH into one bucket (confirmed by reading lib/
// operational-input-binding.ts's buildOperationalInputMap: a DRAFT row,
// same as no row at all, is excluded from the map — resolveInputRowAsOf
// requires finalized_at IS NOT NULL). Dashboard/Commercial Logic want the
// finer distinction (§4: "Enter inputs" vs "Finish inputs"), so this
// module adds it on top, never replacing the existing closed/not-closed
// judgment.
import { deriveMeasurementPhase } from '@/lib/billing-period-card-summary'

export type OperationalActionState = 'NOT_DUE' | 'INPUT_REQUIRED' | 'INPUT_DRAFT' | 'READY'

export function classifyOperationalActionState(params: {
  periodStart: string
  periodEnd: string
  requiredKeys: string[]
  finalizedKeys: Set<string>
  draftKeys: Set<string>
  asOf?: Date
}): OperationalActionState {
  // §5 — 'not_started'/'measuring' both mean "not yet due": a still-open
  // measurement window is never a blocker (Billing Timeline's own
  // describePerformanceComponentState treats phase==='not_started'
  // identically — reused judgment, not a new one). No confirmed
  // commercial rule in this codebase makes a performance/usage input due
  // WHILE its own measurement period is still open — arrears is the only
  // model this product implements; if a future rule changes that, this is
  // the one place to extend, not a reason to guess today.
  const phase = deriveMeasurementPhase(params.periodStart, params.periodEnd, params.asOf)
  if (phase !== 'closed') return 'NOT_DUE'

  if (params.requiredKeys.length === 0) return 'READY'
  const allFinalized = params.requiredKeys.every(k => params.finalizedKeys.has(k))
  if (allFinalized) return 'READY'
  const anyDraft = params.requiredKeys.some(k => params.draftKeys.has(k))
  return anyDraft ? 'INPUT_DRAFT' : 'INPUT_REQUIRED'
}

// Step E9C.1 §9 — stable component identity: recurring_fee_id when the
// contract extraction assigned one, falling back to the (mutable)
// feeLabel only for legacy data with no id — the SAME fallback
// convention lib/billing-period-card-summary.ts's buildDeferredItems
// already established for this exact field (Step E9B).
export function componentStableId(recurringFeeId: string | null | undefined, feeLabel: string): string {
  return recurringFeeId ?? feeLabel
}

export interface ClosedPeriod { periodStart: string; periodEnd: string }

// Step E9C.2 §7/§8 — the audited fix: the applicable source period for a
// component is the OLDEST closed period with an unresolved requirement,
// never merely "the most recent closed period" — that would silently
// lose an older unresolved gap the moment a newer period also closes,
// even though the real arrears billing pipeline is still blocked on the
// OLDER one specifically. `periods` must be pre-sorted ascending by the
// caller (both real callers already fetch it that way via `.order(
// 'period_end', { ascending: true })`, reusing the job's own real
// planned_invoices schedule — never reconstructed cadence math). Returns
// null when every closed period is already resolved (or there are none)
// — the component genuinely has no due action, not an error.
export function oldestUnresolvedPeriod(periods: ClosedPeriod[], isResolved: (p: ClosedPeriod) => boolean): ClosedPeriod | null {
  for (const p of periods) {
    if (!isResolved(p)) return p
  }
  return null
}
