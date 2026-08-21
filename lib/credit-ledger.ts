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

// Deterministic evaluation of CreditEarnRule.trigger_comparator against the
// (already quantity-treated) measured value — comparators are never
// inferred from the metric name or clause wording; they come from the
// normalized rule as confirmed. Exhaustive over the full comparator
// vocabulary (Step 1.5 — was gt/gte only), so a native "below threshold"
// rule (availability < 99.5) evaluates directly rather than requiring a
// caller to invert the metric into its logical complement.
function compareThreshold(measured: number, threshold: number, comparator: CreditEarnRule['trigger_comparator']): boolean {
  switch (comparator) {
    case 'gt':  return measured >  threshold
    case 'gte': return measured >= threshold
    case 'lt':  return measured <  threshold
    case 'lte': return measured <= threshold
    case 'eq':  return measured === threshold
  }
}

// Applies CreditEarnRule.quantity_treatment (Step 1.5) to a raw measured
// quantity — 'exact' (or the field simply absent, which is every rule that
// predates this field) returns the value verbatim, preserving prior
// behavior byte-for-byte. 'complete_units' floors a POSITIVE quantity down
// to the nearest whole unit ("SEK 5,500 per complete hour": 2.99 measured
// hours qualifies as 2). Zero and negative values are never floored —
// flooring a negative number moves it further from zero, which is never
// the intent of "complete units", and the final Math.max(0, ...) guard in
// evaluateCreditEarn already prevents a negative/zero quantity from ever
// producing a positive credit regardless of treatment.
function applyQuantityTreatment(measured: number, treatment: CreditEarnRule['quantity_treatment']): number {
  if (treatment === 'complete_units' && measured > 0) return Math.floor(measured)
  return measured
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
  /** e.g. Service Credit's per-hour rate — multiplied by the (quantity-treated) qualifying quantity. */
  creditValuePerUnitMinor: number | null
  capAmountMinor: number | null
  priorConsecutiveWindowsMet: number
  isOneTime: boolean
  alreadyEarnedOnce: boolean
}): CreditEarnEvaluation {
  // Quantity treatment is applied ONCE, inside this deterministic engine —
  // never left to individual callers to remember (Step 1.5) — and the
  // resulting qualifyingQuantity is what BOTH the threshold comparison and
  // the per-unit amount calculation use, so a "complete hour" clause is
  // floored consistently for both "did this qualify" and "how much".
  const qualifyingQuantity = applyQuantityTreatment(params.measuredTriggerQuantity, params.earnRule.quantity_treatment)
  const threshold = params.earnRule.trigger_quantity ?? 0
  const thresholdMet = compareThreshold(qualifyingQuantity, threshold, params.earnRule.trigger_comparator)

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
    amount = Math.round(params.creditValuePerUnitMinor * qualifyingQuantity)
  } else {
    amount = params.creditValueFlatMinor ?? 0
  }
  if (params.capAmountMinor != null) amount = Math.min(amount, params.capAmountMinor)

  return { earned: true, earnedAmountMinor: Math.max(0, amount), reason: 'Threshold met', consecutiveWindowsMetAfterThis }
}
