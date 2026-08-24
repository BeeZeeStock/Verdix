// Terminal settlement — closes the billing-completeness gap where a
// finite-term contract's FINAL service period has no next advance-period
// row to trigger its own arrears usage/minimum/chargeback settlement (the
// existing scheduler model settles period N's arrears as a side effect of
// processing period N+1's row — see app/api/admin/invoice-scheduler/
// route.ts's backward-scan). Contract B (12-month term, ending 2027-09-30)
// is the concrete case this was found against: September 2027's usage,
// SEK 65,000 minimum floor, chargebacks, and the Annual Rebate's full
// Contract-Year window would otherwise never be computed or invoiced.
//
// Deliberately NOT a manufactured extra subscription period — see
// isTerminalSettlementNeeded/deriveTerminalSettlementTarget's own
// comments. The settlement TARGET (what's being settled — the contract's
// real last service period) is kept structurally distinct from the
// settlement TRIGGER (when this row becomes due — the day after that
// period closes), so the scheduler never has to infer the target via a
// backward "previous period" lookup for this row the way ordinary period
// rows do.
import type { ContractTerms } from './types'

export interface TerminalSettlementTarget {
  // The contract's real final service period — reused verbatim from
  // whatever computeBillingSchedule (lib/billing-writer.ts) already
  // computed as the last period, never re-derived independently. This is
  // the deterministic identity a terminal_settlement row's own
  // settlement_period_start/settlement_period_end columns persist.
  settlementPeriodStart: string // YYYY-MM-DD
  settlementPeriodEnd: string   // YYYY-MM-DD
  // The day after settlementPeriodEnd — when this row becomes due. Never
  // represented as a new subscription period of its own; this is purely
  // the trigger date the scheduler's existing due-row query
  // (.lte('period_start', today)) uses, reusing the exact same
  // eligibility mechanism every other row already relies on.
  triggerDate: string // YYYY-MM-DD
}

// Only contracts with something that could still need post-term
// settlement (usage-based components, or credits/rebates that finalize
// against a real Contract-Year/settlement window) get a terminal_settlement
// row at all — a pure flat-fee contract with neither has nothing for this
// row to ever compute, and generating one would only ever produce an
// empty, pointless invoice.
export function isTerminalSettlementNeeded(
  terms: Partial<Pick<ContractTerms, 'overage_tiers' | 'service_credits'>>,
): boolean {
  return (terms.overage_tiers?.length ?? 0) > 0 || (terms.service_credits?.length ?? 0) > 0
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// lastPeriodStart/lastPeriodEnd are the LAST entry from
// computeBillingSchedule(terms)'s own output — the caller passes them in
// rather than this function re-deriving contract dates itself, so there is
// only ever one place that decides what the contract's final period is.
// triggerDate is computed via calendar-FIELD arithmetic (matching this
// codebase's established DST-safe convention — see lib/tariff.ts's
// enumerateCadenceWindows/isBillingWindowClosed — never raw millisecond
// addition), so a DST fall-back/spring-forward transition landing on the
// contract's own boundary can never skew the trigger date.
export function deriveTerminalSettlementTarget(
  lastPeriodStart: Date,
  lastPeriodEnd: Date,
  terms: Partial<Pick<ContractTerms, 'overage_tiers' | 'service_credits'>>,
): TerminalSettlementTarget | null {
  if (!isTerminalSettlementNeeded(terms)) return null
  const trigger = new Date(lastPeriodEnd.getFullYear(), lastPeriodEnd.getMonth(), lastPeriodEnd.getDate() + 1)
  return {
    settlementPeriodStart: fmtDate(lastPeriodStart),
    settlementPeriodEnd: fmtDate(lastPeriodEnd),
    triggerDate: fmtDate(trigger),
  }
}
