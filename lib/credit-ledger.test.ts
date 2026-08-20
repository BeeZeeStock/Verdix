import { describe, it, expect } from 'vitest'
import {
  filterEligibleComponents, computeRequestedCreditApplication, consumePool, evaluateCreditEarn,
  type PoolComponent,
} from './credit-ledger'
import type { CreditApplicationRule, CreditEarnRule } from './types'

function applicationRule(overrides: Partial<CreditApplicationRule> = {}): CreditApplicationRule {
  return {
    computed_from_component_keys: null,
    eligible_component_keys: 'all',
    excluded_component_keys: [],
    one_time: false,
    carry_forward: true,
    availability: 'next_period',
    requires_confirmation: false,
    confirmation_reason: null,
    ...overrides,
  }
}

function earnRule(overrides: Partial<CreditEarnRule> = {}): CreditEarnRule {
  return {
    trigger_metric_key: 'transactions',
    trigger_quantity: 300000,
    trigger_comparator: 'gt',
    trigger_window: 'calendar_month',
    consecutive_windows_required: 1,
    window_anchor: 'calendar',
    finalization_deadline_days: null,
    requires_confirmation: false,
    confirmation_reason: null,
    ...overrides,
  }
}

// ── filterEligibleComponents / computeRequestedCreditApplication ─────────
describe('computeRequestedCreditApplication (scenario: TEST-PAY-002)', () => {
  const pool: PoolComponent[] = [
    { key: 'platform_fee', amountMinor: 3_850_000 }, // SEK 38,500
    { key: 'transaction_processing', amountMinor: 4_000_000 }, // SEK 40,000
    { key: 'chargeback', amountMinor: 500_000 },
  ]

  it('Growth Credit — excludes platform fee and chargeback, only draws from transaction-processing', () => {
    const rule = applicationRule({ eligible_component_keys: ['transaction_processing'], excluded_component_keys: ['platform_fee', 'chargeback'], one_time: true, carry_forward: true })
    const { requestedAmountMinor, matchedComponentKeys } = computeRequestedCreditApplication({
      applicationRule: rule, remainingPool: pool, lastKnownBalanceMinor: 11_000_000, // SEK 110,000 balance
    })
    expect(matchedComponentKeys).toEqual(['transaction_processing'])
    expect(requestedAmountMinor).toBe(4_000_000) // capped by eligible pool (40,000), not the larger balance
  })

  it('partial balance consumption — balance smaller than eligible pool caps the request', () => {
    const rule = applicationRule({ eligible_component_keys: ['transaction_processing'] })
    const { requestedAmountMinor } = computeRequestedCreditApplication({
      applicationRule: rule, remainingPool: pool, lastKnownBalanceMinor: 2_500_000, // SEK 25,000
    })
    expect(requestedAmountMinor).toBe(2_500_000)
  })

  it('Service Credit — eligible_component_keys "all" draws from the full pool (future amounts payable)', () => {
    const rule = applicationRule({ eligible_component_keys: 'all' })
    const { requestedAmountMinor, matchedComponentKeys } = computeRequestedCreditApplication({
      applicationRule: rule, remainingPool: pool, lastKnownBalanceMinor: 100_000_000,
    })
    expect(matchedComponentKeys.sort()).toEqual(['chargeback', 'platform_fee', 'transaction_processing'])
    expect(requestedAmountMinor).toBe(3_850_000 + 4_000_000 + 500_000)
  })

  it('Annual Rebate with unresolved application scope (eligible_component_keys: null) requests nothing', () => {
    const rule = applicationRule({ eligible_component_keys: null, requires_confirmation: true })
    const { requestedAmountMinor, matchedComponentKeys } = computeRequestedCreditApplication({
      applicationRule: rule, remainingPool: pool, lastKnownBalanceMinor: 6_200_000,
    })
    expect(requestedAmountMinor).toBe(0)
    expect(matchedComponentKeys).toEqual([])
  })

  it('zero available balance requests zero regardless of eligible pool size', () => {
    const rule = applicationRule({ eligible_component_keys: 'all' })
    const { requestedAmountMinor } = computeRequestedCreditApplication({
      applicationRule: rule, remainingPool: pool, lastKnownBalanceMinor: 0,
    })
    expect(requestedAmountMinor).toBe(0)
  })
})

// ── consumePool — waterfall consumption + breakdown preservation ─────────
describe('consumePool (scenario: TEST-PAY-002 — two credits competing for one eligible pool)', () => {
  it('draws down only the matched components, in pool order, up to the amount', () => {
    const pool: PoolComponent[] = [
      { key: 'platform_fee', amountMinor: 3_850_000 },
      { key: 'transaction_processing', amountMinor: 4_000_000 },
    ]
    const { consumed, remainingPool } = consumePool(pool, ['platform_fee', 'transaction_processing'], 5_000_000)
    expect(consumed).toEqual([
      { key: 'platform_fee', amountMinor: 3_850_000 },
      { key: 'transaction_processing', amountMinor: 1_150_000 },
    ])
    expect(remainingPool).toEqual([
      { key: 'platform_fee', amountMinor: 0 },
      { key: 'transaction_processing', amountMinor: 2_850_000 },
    ])
  })

  it('two credits sequentially — total consumed never exceeds the original pool', () => {
    let pool: PoolComponent[] = [{ key: 'transaction_processing', amountMinor: 5_000_000 }] // SEK 50,000
    // Growth Credit requests 40,000 first (applicationOrder places it first — narrower scope).
    const first = consumePool(pool, ['transaction_processing'], 4_000_000)
    pool = first.remainingPool
    expect(pool).toEqual([{ key: 'transaction_processing', amountMinor: 1_000_000 }])
    // Service Credit's "all" scope now only has 10,000 left to draw from, not the original 50,000.
    const second = consumePool(pool, ['transaction_processing'], 3_000_000)
    expect(second.consumed).toEqual([{ key: 'transaction_processing', amountMinor: 1_000_000 }])
    const totalConsumed = first.consumed[0].amountMinor + second.consumed[0].amountMinor
    expect(totalConsumed).toBe(5_000_000) // never exceeds the original 50,000 pool
  })

  it('a component not in matchedComponentKeys is left untouched', () => {
    const pool: PoolComponent[] = [
      { key: 'platform_fee', amountMinor: 3_850_000 },
      { key: 'transaction_processing', amountMinor: 4_000_000 },
    ]
    const { remainingPool } = consumePool(pool, ['transaction_processing'], 4_000_000)
    expect(remainingPool.find(c => c.key === 'platform_fee')?.amountMinor).toBe(3_850_000)
  })
})

// ── evaluateCreditEarn ─────────────────────────────────────────────────────
describe('evaluateCreditEarn (scenario: TEST-PAY-002)', () => {
  it('Growth Credit — earns only on the 3rd consecutive qualifying month', () => {
    const rule = earnRule({ consecutive_windows_required: 3 })
    const month1 = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 310000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 11_000_000, creditValuePctBp: null, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: true, alreadyEarnedOnce: false,
    })
    expect(month1).toMatchObject({ earned: false, consecutiveWindowsMetAfterThis: 1 })

    const month2 = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 305000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 11_000_000, creditValuePctBp: null, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: month1.consecutiveWindowsMetAfterThis, isOneTime: true, alreadyEarnedOnce: false,
    })
    expect(month2).toMatchObject({ earned: false, consecutiveWindowsMetAfterThis: 2 })

    const month3 = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 320000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 11_000_000, creditValuePctBp: null, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: month2.consecutiveWindowsMetAfterThis, isOneTime: true, alreadyEarnedOnce: false,
    })
    expect(month3).toMatchObject({ earned: true, earnedAmountMinor: 11_000_000, consecutiveWindowsMetAfterThis: 3 })
  })

  it('Growth Credit — a missed month resets the streak to zero', () => {
    const rule = earnRule({ consecutive_windows_required: 3 })
    const missed = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 200000, computedFromAmountMinor: 0, // below 300,000 threshold
      creditValueFlatMinor: 11_000_000, creditValuePctBp: null, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: 2, isOneTime: true, alreadyEarnedOnce: false,
    })
    expect(missed).toMatchObject({ earned: false, consecutiveWindowsMetAfterThis: 0 })
  })

  it('one-time credit cannot be earned twice', () => {
    const rule = earnRule({ consecutive_windows_required: 1 })
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 400000, computedFromAmountMinor: 0,
      creditValueFlatMinor: 11_000_000, creditValuePctBp: null, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: true, alreadyEarnedOnce: true,
    })
    expect(result).toMatchObject({ earned: false, reason: 'One-time credit already earned' })
  })

  it('Service Availability Credit — per-unit rate under the monthly cap', () => {
    const rule = earnRule({ trigger_metric_key: 'excess_unavailability_hours', trigger_quantity: 0, trigger_comparator: 'gt', consecutive_windows_required: 1 })
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 8, computedFromAmountMinor: 0,
      creditValueFlatMinor: null, creditValuePctBp: null, creditValuePerUnitMinor: 550_000, // SEK 5,500/hr in öre
      capAmountMinor: 5_500_000, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result).toMatchObject({ earned: true, earnedAmountMinor: 8 * 550_000 }) // 44,000
  })

  it('Service Availability Credit — capped at SEK 55,000/month even with more excess hours', () => {
    const rule = earnRule({ trigger_metric_key: 'excess_unavailability_hours', trigger_quantity: 0, trigger_comparator: 'gt', consecutive_windows_required: 1 })
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 12, computedFromAmountMinor: 0,
      creditValueFlatMinor: null, creditValuePctBp: null, creditValuePerUnitMinor: 550_000,
      capAmountMinor: 5_500_000, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earnedAmountMinor).toBe(5_500_000) // 66,000 raw, capped to 55,000
  })

  it('Annual Volume Rebate — 5% of paid transaction-processing fees when volume threshold is met', () => {
    const rule = earnRule({ trigger_metric_key: 'transactions', trigger_quantity: 2_000_000, trigger_comparator: 'gt', trigger_window: 'contract_year', window_anchor: 'contract_start', consecutive_windows_required: 1, finalization_deadline_days: 45 })
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 2_150_000, computedFromAmountMinor: 124_000_000, // SEK 1,240,000 paid
      creditValueFlatMinor: null, creditValuePctBp: 500, creditValuePerUnitMinor: null, // 5% = 500bp
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result).toMatchObject({ earned: true, earnedAmountMinor: 6_200_000 }) // SEK 62,000
  })

  it('Annual Volume Rebate — does not qualify below the 2,000,000 transaction threshold', () => {
    const rule = earnRule({ trigger_metric_key: 'transactions', trigger_quantity: 2_000_000, trigger_comparator: 'gt', trigger_window: 'contract_year', window_anchor: 'contract_start', consecutive_windows_required: 1 })
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 1_900_000, computedFromAmountMinor: 124_000_000,
      creditValueFlatMinor: null, creditValuePctBp: 500, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earned).toBe(false)
  })

  it('monetary rounding — a percentage rebate landing on a fractional öre rounds to the nearest whole öre once', () => {
    const rule = earnRule({ trigger_quantity: 0, trigger_comparator: 'gt', consecutive_windows_required: 1 })
    // 333,333 öre * 500bp / 10000 = 16,666.65 -> rounds to 16,667
    const result = evaluateCreditEarn({
      earnRule: rule, measuredTriggerQuantity: 1, computedFromAmountMinor: 333_333,
      creditValueFlatMinor: null, creditValuePctBp: 500, creditValuePerUnitMinor: null,
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(result.earnedAmountMinor).toBe(16_667)
    expect(Number.isInteger(result.earnedAmountMinor)).toBe(true)
  })
})

describe('filterEligibleComponents — unresolved scope never matches anything', () => {
  it('eligible_component_keys: null matches nothing, even against a nonempty pool', () => {
    const pool: PoolComponent[] = [{ key: 'transaction_processing', amountMinor: 1000 }]
    const matched = filterEligibleComponents(pool, applicationRule({ eligible_component_keys: null }))
    expect(matched).toEqual([])
  })
})
