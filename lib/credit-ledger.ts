import type { CreditApplicationRule, CreditEarnRule } from './types'

export interface PoolComponent {
  key: string
  amountMinor: number
}

// What a credit's application_rule actually matches against a component
// pool — 'all' minus excluded, a concrete list minus excluded, or nothing
// when eligible_component_keys is null (unresolved, never assumed).
export function filterEligibleComponents(components: PoolComponent[], rule: CreditApplicationRule): PoolComponent[] {
  if (rule.eligible_component_keys === null) return []
  const excluded = new Set(rule.excluded_component_keys)
  if (rule.eligible_component_keys === 'all') {
    return components.filter(c => !excluded.has(c.key) && c.amountMinor > 0)
  }
  const eligible = new Set(rule.eligible_component_keys)
  return components.filter(c => eligible.has(c.key) && !excluded.has(c.key) && c.amountMinor > 0)
}

// Computes ONE credit's requested amount against the CURRENT remaining
// component pool — deliberately not a batch/all-credits-at-once function.
// The orchestration layer calls this once per credit, in confirmed
// applicationOrder, threading each reservation's REAL returned amount back
// in before computing the next credit's request — never precomputing a
// whole waterfall from a single balance snapshot that could go stale
// mid-loop once cross-invoice concurrency is real. lastKnownBalanceMinor is
// a best-effort cap only; the credit_ledger_entries RPC is the sole source
// of truth for the real, current, concurrency-safe balance.
export function computeRequestedCreditApplication(params: {
  applicationRule: CreditApplicationRule
  remainingPool: PoolComponent[]
  lastKnownBalanceMinor: number
}): { requestedAmountMinor: number; matchedComponentKeys: string[] } {
  if (params.applicationRule.requires_confirmation) {
    return { requestedAmountMinor: 0, matchedComponentKeys: [] }
  }
  const matched = filterEligibleComponents(params.remainingPool, params.applicationRule)
  const eligiblePoolMinor = matched.reduce((sum, c) => sum + c.amountMinor, 0)
  const requestedAmountMinor = Math.max(0, Math.min(eligiblePoolMinor, params.lastKnownBalanceMinor))
  return { requestedAmountMinor, matchedComponentKeys: matched.map(c => c.key) }
}

// Draws `amountMinor` down from `pool` across `matchedComponentKeys`, in the
// pool's own order, returning the exact per-component breakdown consumed
// (preserved on the ledger row's `details` for evidence) and the pool state
// for the next credit in applicationOrder to see.
export function consumePool(
  pool: PoolComponent[], matchedComponentKeys: string[], amountMinor: number,
): { consumed: PoolComponent[]; remainingPool: PoolComponent[] } {
  const matchedSet = new Set(matchedComponentKeys)
  let remaining = amountMinor
  const consumed: PoolComponent[] = []
  const remainingPool = pool.map(c => {
    if (remaining <= 0 || !matchedSet.has(c.key)) return c
    const take = Math.min(c.amountMinor, remaining)
    remaining -= take
    if (take > 0) consumed.push({ key: c.key, amountMinor: take })
    return { key: c.key, amountMinor: c.amountMinor - take }
  })
  return { consumed, remainingPool }
}

export interface CreditEarnEvaluation {
  earned: boolean
  earnedAmountMinor: number
  reason: string
  /** Caller persists this into the next window's trigger_check.details so
   *  the streak can be picked back up on the following evaluation. */
  consecutiveWindowsMetAfterThis: number
}

// Single evaluator for all three TEST-PAY-002 credit shapes — a threshold
// (optionally requiring N consecutive windows), an earned amount computed as
// a flat value, a percentage of some basis, or a per-unit rate. One function,
// not one per credit type, because the earning MECHANICS (threshold + streak
// tracking + one-time guard) are identical; only which amount formula
// applies differs, and that's just which of the three optional value
// parameters is non-null.
export function evaluateCreditEarn(params: {
  earnRule: CreditEarnRule
  measuredTriggerQuantity: number
  /** This window's total for computed_from_component_keys — only used when creditValuePctBp is set. */
  computedFromAmountMinor: number
  creditValueFlatMinor: number | null
  /** Basis points, 500 = 5% — avoids float percentage math. */
  creditValuePctBp: number | null
  /** e.g. Service Credit's per-hour rate — multiplied by measuredTriggerQuantity. */
  creditValuePerUnitMinor: number | null
  capAmountMinor: number | null
  priorConsecutiveWindowsMet: number
  isOneTime: boolean
  alreadyEarnedOnce: boolean
}): CreditEarnEvaluation {
  const threshold = params.earnRule.trigger_quantity ?? 0
  const thresholdMet = params.earnRule.trigger_comparator === 'gt'
    ? params.measuredTriggerQuantity > threshold
    : params.measuredTriggerQuantity >= threshold

  if (!thresholdMet) {
    return { earned: false, earnedAmountMinor: 0, reason: 'Threshold not met this window', consecutiveWindowsMetAfterThis: 0 }
  }

  const consecutiveWindowsMetAfterThis = params.priorConsecutiveWindowsMet + 1
  const required = params.earnRule.consecutive_windows_required || 1
  if (consecutiveWindowsMetAfterThis < required) {
    return {
      earned: false, earnedAmountMinor: 0,
      reason: `Threshold met but only ${consecutiveWindowsMetAfterThis}/${required} consecutive windows so far`,
      consecutiveWindowsMetAfterThis,
    }
  }

  if (params.isOneTime && params.alreadyEarnedOnce) {
    return { earned: false, earnedAmountMinor: 0, reason: 'One-time credit already earned', consecutiveWindowsMetAfterThis }
  }

  let amount: number
  if (params.creditValuePctBp != null) {
    amount = Math.round(params.computedFromAmountMinor * params.creditValuePctBp / 10000)
  } else if (params.creditValuePerUnitMinor != null) {
    amount = Math.round(params.creditValuePerUnitMinor * params.measuredTriggerQuantity)
  } else {
    amount = params.creditValueFlatMinor ?? 0
  }
  if (params.capAmountMinor != null) amount = Math.min(amount, params.capAmountMinor)

  return { earned: true, earnedAmountMinor: Math.max(0, amount), reason: 'Threshold met', consecutiveWindowsMetAfterThis }
}
