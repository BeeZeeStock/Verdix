import { describe, it, expect } from 'vitest'
import { resolveScopeTokenClass, classifyContractUnitType } from './commercial-component-scope'
import { filterEligibleComponents, evaluateCreditEarn, type PoolComponent } from './credit-ledger'
import type { CreditApplicationRule } from './types'

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

// The real Contract B runtime pool, as app/api/admin/invoice-scheduler/
// route.ts constructs it: platform_fee is the hardcoded constant key/class;
// the transaction-processing and chargeback components carry the org's
// OWN arbitrary operational meter_key ('sync', 'sms_sent' — confirmed live
// against job b583f52c-b18b-4620-ab40-52c8d5047d0a's real
// contract_meter_mappings rows) with componentClass resolved from
// contractUnitType, exactly as classifyContractUnitType would produce.
const contractBPool: PoolComponent[] = [
  { key: 'platform_fee', amountMinor: 3_850_000, componentClass: 'platform_fee' }, // SEK 38,500
  { key: 'sync', amountMinor: 4_000_000, componentClass: classifyContractUnitType('Processed Transaction') }, // SEK 40,000 — real meter_key
  { key: 'sms_sent', amountMinor: 185_00, componentClass: classifyContractUnitType('chargeback') }, // SEK 185 — real meter_key
]

describe('resolveScopeTokenClass — eligible_component_keys / excluded_component_keys token normalization', () => {
  // A — platform semantic scope resolves and matches the actual runtime
  // platform_fee component.
  it('resolves both the short pre-existing test token and Contract B\'s real long-form extraction token to the same platform_fee class', () => {
    expect(resolveScopeTokenClass('platform_fee')).toBe('platform_fee')
    expect(resolveScopeTokenClass('platform_subscription_fees')).toBe('platform_fee')
  })

  it('resolves both the short token and Contract B\'s real long-form token to the same transaction_processing class', () => {
    expect(resolveScopeTokenClass('transaction_processing')).toBe('transaction_processing')
    expect(resolveScopeTokenClass('transaction_processing_fees')).toBe('transaction_processing')
  })

  it('resolves both the short token and Contract B\'s real long-form token to the same chargeback class', () => {
    expect(resolveScopeTokenClass('chargeback')).toBe('chargeback')
    expect(resolveScopeTokenClass('chargeback_fees')).toBe('chargeback')
  })

  // I — unknown scope token fails closed (resolves to no class), never
  // accidentally granted eligibility.
  it('an unrecognized token (e.g. "taxes", "previously_applied_credits", or any novel extraction string) resolves to null, never a guessed class', () => {
    expect(resolveScopeTokenClass('taxes')).toBeNull()
    expect(resolveScopeTokenClass('previously_applied_credits')).toBeNull()
    expect(resolveScopeTokenClass('some_future_extraction_token')).toBeNull()
  })
})

describe('classifyContractUnitType — contract_unit_type -> canonical class (never meter_key)', () => {
  // B — the commercial classification depends on the CONTRACT's own
  // description of the meter, never the org's arbitrary operational
  // meter_key naming.
  it('Contract B\'s real contract_unit_type "Processed Transaction" classifies as transaction_processing', () => {
    expect(classifyContractUnitType('Processed Transaction')).toBe('transaction_processing')
  })

  it('Contract B\'s real contract_unit_type "chargeback" classifies as chargeback', () => {
    expect(classifyContractUnitType('chargeback')).toBe('chargeback')
  })

  it('is case/whitespace tolerant (exact-match after normalization, never fuzzy/substring)', () => {
    expect(classifyContractUnitType('  Processed Transactions  ')).toBe('transaction_processing')
  })

  it('an unmapped contract_unit_type resolves to null, not a guess', () => {
    expect(classifyContractUnitType('Widget Assemblies')).toBeNull()
    expect(classifyContractUnitType(null)).toBeNull()
  })
})

describe('filterEligibleComponents against the real Contract B pool (meter_key deliberately arbitrary: sync / sms_sent)', () => {
  // A (continued) — platform semantic scope matches the real platform_fee
  // component regardless of eligible_component_keys' exact wording.
  it('eligible_component_keys ["platform_subscription_fees"] matches the platform_fee pool entry', () => {
    const rule = applicationRule({ eligible_component_keys: ['platform_subscription_fees'] })
    const matched = filterEligibleComponents(contractBPool, rule)
    expect(matched.map(c => c.key)).toEqual(['platform_fee'])
  })

  // B (continued) — transaction-processing semantic scope matches the
  // transaction component EVEN THOUGH its real meter_key is 'sync', not
  // 'transaction_processing'.
  it('eligible_component_keys ["transaction_processing_fees"] matches the "sync"-keyed component via contractUnitType, never the meter_key string', () => {
    const rule = applicationRule({ eligible_component_keys: ['transaction_processing_fees'] })
    const matched = filterEligibleComponents(contractBPool, rule)
    expect(matched.map(c => c.key)).toEqual(['sync'])
  })

  // D — Annual Rebate's real, live confirmed application_rule
  // (job b583f52c, credit_rule_id 4076e59c): eligible_component_keys =
  // ["transaction_processing_fees", "platform_subscription_fees"],
  // excluded = ["chargeback_fees", "one_time_fees", "taxes", "previously_applied_credits"].
  it('Annual Rebate — reaches transaction-processing (sync) + platform_fee, excludes chargeback (sms_sent)', () => {
    const rebateRule = applicationRule({
      eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees'],
      excluded_component_keys: ['chargeback_fees', 'one_time_fees', 'taxes', 'previously_applied_credits'],
    })
    const matched = filterEligibleComponents(contractBPool, rebateRule)
    expect(matched.map(c => c.key).sort()).toEqual(['platform_fee', 'sync'])
  })

  it('Annual Rebate never becomes eligible merely because a component happens to share a similar display string — matching is by resolved class only', () => {
    // A component whose key LOOKS like it could be transaction-related by
    // substring, but was never classified as such by contract_unit_type —
    // must not match.
    const decoyPool: PoolComponent[] = [
      { key: 'transaction_processing_fees_v2', amountMinor: 999_999, componentClass: null },
    ]
    const rebateRule = applicationRule({ eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees'] })
    expect(filterEligibleComponents(decoyPool, rebateRule)).toEqual([])
  })

  // C — Expansion Credit's real, live confirmed application_rule
  // (credit_rule_id 3e4f010c): eligible_component_keys =
  // ["transaction_processing"], excluded = [].
  it('Expansion Credit — reaches only transaction-processing (sync), excludes platform_fee', () => {
    const expansionRule = applicationRule({ eligible_component_keys: ['transaction_processing'], excluded_component_keys: [] })
    const matched = filterEligibleComponents(contractBPool, expansionRule)
    expect(matched.map(c => c.key)).toEqual(['sync'])
  })

  it('Expansion Credit does not reach chargeback or one-time-fee classes either — scope is transaction-processing only', () => {
    const expansionRule = applicationRule({ eligible_component_keys: ['transaction_processing'] })
    const matched = filterEligibleComponents(contractBPool, expansionRule)
    expect(matched.some(c => c.componentClass === 'chargeback')).toBe(false)
    expect(matched.some(c => c.componentClass === 'one_time_fee')).toBe(false)
  })

  // F — unrelated chargeback excluded when not in scope.
  it('a rule scoped only to platform_fee never reaches the chargeback (sms_sent) component', () => {
    const rule = applicationRule({ eligible_component_keys: ['platform_subscription_fees'] })
    const matched = filterEligibleComponents(contractBPool, rule)
    expect(matched.some(c => c.key === 'sms_sent')).toBe(false)
  })

  // G — one-time fee excluded when not in scope. fullComponentPool never
  // actually includes a one-time-fee entry today (invoice-scheduler only
  // builds it for invoice_type === 'period' rows), but the canonical class
  // exists and must correctly exclude a hypothetical one anyway — proven
  // directly here rather than assumed.
  it('a rule scoped to transaction-processing + platform never reaches a one_time_fee-classed component', () => {
    const poolWithOneTimeFee: PoolComponent[] = [
      ...contractBPool,
      { key: 'integration_fee_line', amountMinor: 9_000_000, componentClass: 'one_time_fee' },
    ]
    const rule = applicationRule({ eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees'] })
    const matched = filterEligibleComponents(poolWithOneTimeFee, rule)
    expect(matched.some(c => c.componentClass === 'one_time_fee')).toBe(false)
  })

  it('an explicit excluded_component_keys entry for one-time fees correctly excludes a one_time_fee-classed component under \'all\' scope', () => {
    const poolWithOneTimeFee: PoolComponent[] = [
      ...contractBPool,
      { key: 'integration_fee_line', amountMinor: 9_000_000, componentClass: 'one_time_fee' },
    ]
    const rule = applicationRule({ eligible_component_keys: 'all', excluded_component_keys: ['one_time_fees'] })
    const matched = filterEligibleComponents(poolWithOneTimeFee, rule)
    expect(matched.some(c => c.componentClass === 'one_time_fee')).toBe(false)
    expect(matched.map(c => c.key).sort()).toEqual(['platform_fee', 'sms_sent', 'sync'])
  })

  // H — Service Credit's real, live confirmed application_rule
  // (credit_rule_id a8ef5ec4): eligible_component_keys = 'all', excluded = [].
  // Resolves via the SAME canonical 'all' semantics filterEligibleComponents
  // already had — never a Contract-B-specific hardcoded set.
  it('Service Credit — "all" reaches the entire real pool (platform + transaction-processing + chargeback)', () => {
    const serviceCreditRule = applicationRule({ eligible_component_keys: 'all', excluded_component_keys: [] })
    const matched = filterEligibleComponents(contractBPool, serviceCreditRule)
    expect(matched.map(c => c.key).sort()).toEqual(['platform_fee', 'sms_sent', 'sync'])
  })

  it('"all" still includes a component whose class could not be resolved at all (unclassified != excluded)', () => {
    const poolWithUnclassified: PoolComponent[] = [...contractBPool, { key: 'mystery_fee', amountMinor: 1000, componentClass: null }]
    const serviceCreditRule = applicationRule({ eligible_component_keys: 'all' })
    const matched = filterEligibleComponents(poolWithUnclassified, serviceCreditRule)
    expect(matched.some(c => c.key === 'mystery_fee')).toBe(true)
  })

  // I (continued) — a rule whose ENTIRE eligible_component_keys list is
  // unrecognized tokens fails closed: matches nothing, same as null.
  it('a rule whose eligible_component_keys are entirely unrecognized tokens matches nothing — fails closed, not open', () => {
    const rule = applicationRule({ eligible_component_keys: ['some_unrecognized_token', 'another_unknown_one'] })
    expect(filterEligibleComponents(contractBPool, rule)).toEqual([])
  })

  it('null eligible_component_keys (unresolved application scope) still matches nothing, unchanged from before this resolver', () => {
    const rule = applicationRule({ eligible_component_keys: null })
    expect(filterEligibleComponents(contractBPool, rule)).toEqual([])
  })
})

describe('E — Annual Rebate earning-basis computation is untouched by this resolver', () => {
  // evaluateCreditEarn (the earning engine) takes computedFromAmountMinor
  // as a plain already-computed number — it has no dependency on
  // PoolComponent/CommercialComponentClass/filterEligibleComponents at
  // all, so this module's change cannot have altered it. Proven directly
  // against Contract B's real confirmed earn_rule (credit_rule_id
  // 4076e59c: 3.5% of the basis, >1,800,000 processed transactions/year,
  // no cap) rather than merely asserted.
  it('Annual Rebate\'s 3.5%-of-basis earned amount is computed identically, independent of any component pool/class', () => {
    const evaluation = evaluateCreditEarn({
      earnRule: {
        trigger_metric_key: 'processed_transactions', trigger_quantity: 1_800_000, trigger_comparator: 'gt',
        trigger_window: 'contract_year', consecutive_windows_required: 1, window_anchor: 'contract_start',
        finalization_deadline_days: 30, requires_confirmation: false, confirmation_reason: null,
        quantity_treatment: 'exact',
      },
      measuredTriggerQuantity: 1_900_000, // qualifies (> 1,800,000)
      computedFromAmountMinor: 100_000_000, // SEK 1,000,000 basis — sourced entirely outside this module
      creditValueFlatMinor: null, creditValuePctBp: 350, creditValuePerUnitMinor: null, // 3.5%
      capAmountMinor: null, priorConsecutiveWindowsMet: 0, isOneTime: false, alreadyEarnedOnce: false,
    })
    expect(evaluation.earned).toBe(true)
    expect(evaluation.earnedAmountMinor).toBe(3_500_000) // SEK 35,000 — 3.5% of 1,000,000, unaffected by componentClass concerns
  })
})
