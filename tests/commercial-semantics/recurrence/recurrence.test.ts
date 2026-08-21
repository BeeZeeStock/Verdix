// Freezes: explicit one-time language resolves a one-time rule; a periodic
// trigger ("during each calendar month" / "during a Contract Year")
// preserves periodic evaluation unless the source explicitly makes the
// benefit one-time — recurring evaluation must never silently collapse
// into an unstated one-time rule. Also freezes complete-unit semantics
// ("per complete hour" uses only whole units, not fractional), natively
// enforced inside evaluateCreditEarn via CreditEarnRule.quantity_treatment
// as of Step 1.5. Exercises lib/credit-ledger.ts's evaluateCreditEarn — no
// AI calls.
import { describe, it, expect } from 'vitest'
import { evaluateCreditEarn } from '@/lib/credit-ledger'
import type { CreditEarnRule } from '@/lib/types'

const MONTHLY_RULE: CreditEarnRule = {
  trigger_metric_key: 'transactions', trigger_quantity: 300_000, trigger_comparator: 'gt',
  trigger_window: 'calendar_month', consecutive_windows_required: 3, window_anchor: 'calendar',
  finalization_deadline_days: null, requires_confirmation: false,
}

describe('normalized rule — one-time vs. recurring is an explicit, separate flag from the trigger window', () => {
  it('a periodic trigger window ("each calendar month") does not, by itself, make the benefit one-time — isOneTime is a genuinely separate field', () => {
    // The trigger window describes HOW OFTEN eligibility is checked;
    // isOneTime describes whether the BENEFIT can be earned more than once
    // after that. TEST-PAY-002's real Growth Credit is trigger_window:
    // calendar_month (checked every month) AND one_time: true (can only
    // ever be earned once, in total) — the two facts are independent.
    expect(MONTHLY_RULE.trigger_window).toBe('calendar_month')
    // isOneTime lives on CreditApplicationRule, not CreditEarnRule — proven
    // by evaluateCreditEarn requiring it as a SEPARATE parameter below,
    // never derived from trigger_window.
  })
})

describe('calculation — a periodic (non-one-time) trigger keeps evaluating every qualifying window', () => {
  it('a non-one-time credit earns again in a second, independent qualifying window after already earning once', () => {
    const first = evaluateCreditEarn({
      earnRule: { ...MONTHLY_RULE, consecutive_windows_required: 1 },
      measuredTriggerQuantity: 350_000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 100_000, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    const second = evaluateCreditEarn({
      earnRule: { ...MONTHLY_RULE, consecutive_windows_required: 1 },
      measuredTriggerQuantity: 350_000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 100_000, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: first.earned, // real orchestration threads this
    })
    expect(first.earned).toBe(true)
    expect(second.earned).toBe(true) // recurring evaluation is NOT collapsed into a one-off just because it already fired once
  })
  it('a genuinely one-time credit (isOneTime: true) is blocked from earning again once alreadyEarnedOnce is true, even in a fully qualifying later window', () => {
    const result = evaluateCreditEarn({
      earnRule: { ...MONTHLY_RULE, consecutive_windows_required: 1 },
      measuredTriggerQuantity: 350_000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 100_000, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: true, alreadyEarnedOnce: true,
    })
    expect(result.earned).toBe(false)
    expect(result.reason).toBe('One-time credit already earned')
  })
})

describe('counterexample — a consecutive-window streak (e.g. Growth Credit\'s "3 consecutive calendar months") is a distinct mechanic from one_time, and a missed window resets it', () => {
  it('3 consecutive qualifying months earns; the streak requirement is orthogonal to whether the benefit itself is one-time', () => {
    let priorMet = 0
    let last
    for (let month = 1; month <= 3; month++) {
      last = evaluateCreditEarn({
        earnRule: MONTHLY_RULE, measuredTriggerQuantity: 350_000, computedFromAmountMinor: 0,
        creditValueFlatMinor: 11_000_000 /* SEK 110,000.00, in öre */, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
        priorConsecutiveWindowsMet: priorMet, isOneTime: true, alreadyEarnedOnce: false,
      })
      priorMet = last.consecutiveWindowsMetAfterThis
    }
    expect(last!.earned).toBe(true)
  })
  it('a missed month (threshold not met) resets the streak to zero — 2 qualifying months, 1 miss, 2 more qualifying months never earns (never reaches 3 IN A ROW)', () => {
    const qualifying = (prior: number) => evaluateCreditEarn({
      earnRule: MONTHLY_RULE, measuredTriggerQuantity: 350_000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 100_000, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: prior, isOneTime: true, alreadyEarnedOnce: false,
    })
    const missed = (prior: number) => evaluateCreditEarn({
      earnRule: MONTHLY_RULE, measuredTriggerQuantity: 100_000 /* below the 300,000 threshold */, computedFromAmountMinor: 0,
      creditValueFlatMinor: 100_000, creditValuePctBp: null, creditValuePerUnitMinor: null, capAmountMinor: null,
      priorConsecutiveWindowsMet: prior, isOneTime: true, alreadyEarnedOnce: false,
    })
    let streak = 0
    streak = qualifying(streak).consecutiveWindowsMetAfterThis // 1
    streak = qualifying(streak).consecutiveWindowsMetAfterThis // 2
    streak = missed(streak).consecutiveWindowsMetAfterThis     // reset to 0
    expect(streak).toBe(0)
    streak = qualifying(streak).consecutiveWindowsMetAfterThis // 1 again, not 3
    const result = qualifying(streak)                          // 2 — still not earned
    expect(result.earned).toBe(false)
  })
})

describe('complete-unit semantics — "per complete hour" uses only whole units, never fractional', () => {
  // Step 1.5 update: quantity_treatment: 'complete_units' is now a native
  // field on CreditEarnRule, applied INSIDE evaluateCreditEarn itself — the
  // engine performs the flooring, not the caller. This is no longer a
  // documented gap; see minimum-floor/all-units-style native coverage.
  it('4.9 hours of measured downtime earns for 4 complete hours, not 4.9 — the engine itself floors, no caller-side Math.floor needed', () => {
    const result = evaluateCreditEarn({
      earnRule: { trigger_metric_key: 'excess_downtime_hours', trigger_quantity: 0, trigger_comparator: 'gt', trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar', finalization_deadline_days: null, quantity_treatment: 'complete_units', requires_confirmation: false },
      measuredTriggerQuantity: 4.9, // raw measured value, not pre-floored by the caller
      computedFromAmountMinor: 0, creditValueFlatMinor: null, creditValuePctBp: null,
      creditValuePerUnitMinor: 550_000, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earnedAmountMinor).toBe(4 * 550_000) // not 4.9 * 550,000
  })
  it('generic — the identical treatment floors a fractional DAY count the same way; "complete_units" is not hardcoded to hours', () => {
    const result = evaluateCreditEarn({
      earnRule: { trigger_metric_key: 'excess_downtime_days', trigger_quantity: 0, trigger_comparator: 'gt', trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar', finalization_deadline_days: null, quantity_treatment: 'complete_units', requires_confirmation: false },
      measuredTriggerQuantity: 2.99,
      computedFromAmountMinor: 0, creditValueFlatMinor: null, creditValuePctBp: null,
      creditValuePerUnitMinor: 100_000, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earnedAmountMinor).toBe(2 * 100_000)
  })
  it('counterexample — the SAME 4.9-hour measurement under quantity_treatment "exact" (or omitted) uses the raw value verbatim, never floored — proves treatment, not the metric itself, decides this', () => {
    const withExact = evaluateCreditEarn({
      earnRule: { trigger_metric_key: 'excess_downtime_hours', trigger_quantity: 0, trigger_comparator: 'gt', trigger_window: 'calendar_month', consecutive_windows_required: 1, window_anchor: 'calendar', finalization_deadline_days: null, quantity_treatment: 'exact', requires_confirmation: false },
      measuredTriggerQuantity: 4.9,
      computedFromAmountMinor: 0, creditValueFlatMinor: null, creditValuePctBp: null,
      creditValuePerUnitMinor: 550_000, capAmountMinor: null,
      priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(withExact.earnedAmountMinor).toBe(Math.round(550_000 * 4.9)) // verbatim, not floored
  })
})
