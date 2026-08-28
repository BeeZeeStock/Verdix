// Step 17F.6 — stale-schedule safety after the fixed_fee_billing_timing
// typed rule (17F.3/17F.4) was introduced. Before this, the scheduler's own
// due-row selection (`period_start <= today`) was the ONLY due-check for a
// 'period' invoice_type row — that unconditionally assumed the fixed
// component bills at period start, with no reference to the reviewer's
// timing decision at all. A confirmed decision was gated only at the
// review-readiness layer (lib/commercial-rule-status.ts), never at the
// scheduler/execution boundary itself.
//
// This function is the authoritative, per-row scheduling decision for
// 'period' invoice_type rows, called BEFORE any provider (Stripe/Remembill)
// call. Two failure modes it closes:
//   1. Unresolved timing (requires_confirmation: true, including the
//      pre-17F.3-extraction/pre-reconciliation "no rule at all" case is
//      intentionally NOT held here — see the null-handling note below) must
//      never let a fixed-fee invoice go out, even if the row's own
//      period_start has already passed.
//   2. A CONFIRMED bill_at_period_end decision must not fire at
//      period_start just because that's what the row's period_start
//      column says — the authoritative trigger date shifts to period_end.
//
// Deliberately reuses the row's EXISTING period_start/period_end columns —
// no new persisted field, no rewritten history. A row already status='sent'
// never reaches this function (the scheduler's own query excludes it by
// construction); this only ever holds or defers a still-'scheduled' row.
import type { FixedFeeBillingTimingRule } from './types'

export interface FixedFeeSchedulingRow {
  invoice_type: string
  period_start: string
  period_end: string
}

export type FixedFeeSchedulingDecision =
  | { action: 'hold'; reason: string }
  | { action: 'not_yet_due' }
  | { action: 'due' }

export function resolveFixedFeeSchedulingDecision(
  row: FixedFeeSchedulingRow,
  fixedFeeBillingTiming: FixedFeeBillingTimingRule | null | undefined,
  today: string,
): FixedFeeSchedulingDecision {
  // Every other invoice_type (one_time, terminal_settlement) is untouched —
  // this rule only ever governs the recurring fixed component.
  if (row.invoice_type !== 'period') return { action: 'due' }

  // A job whose contract was extracted/reconciled before 17F.3 and has
  // never had reconcile-fixed-fee-timing run has NO rule at all
  // (fixedFeeBillingTiming is null/undefined) — distinct from an explicit
  // unresolved rule. This function does not hold that case: doing so would
  // silently freeze every pre-17F.3 job's billing the moment this code
  // deploys, which is a migration/rollout decision for the reconciliation
  // path (lib/fixed-fee-billing-timing-reconciliation.ts), not something
  // this scheduling function should decide unilaterally. Only a rule that
  // EXISTS and is explicitly still open holds.
  if (fixedFeeBillingTiming?.requires_confirmation) {
    return {
      action: 'hold',
      reason: 'Held: fixed_fee_billing_timing unresolved — reviewer has not confirmed when the fixed recurring fee is invoiced.',
    }
  }

  const dueDate = fixedFeeBillingTiming?.timing === 'bill_at_period_end' ? row.period_end : row.period_start
  return dueDate <= today ? { action: 'due' } : { action: 'not_yet_due' }
}
