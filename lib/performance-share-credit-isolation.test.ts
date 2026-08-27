import { describe, it, expect } from 'vitest'
import { filterEligibleComponents, type PoolComponent } from './credit-ledger'
import { classifyContractUnitType } from './commercial-component-scope'
import { PERFORMANCE_SHARE_FEE_COMPONENT } from './performance-share-materiality'
import type { CreditApplicationRule } from './types'

// Step 17C.1a, item 5 — proves the performance-share fee's stable
// component identity actually reaches the credit-ledger's own eligibility
// filter correctly, exactly the way app/api/admin/invoice-scheduler/
// route.ts's own pool construction builds it from an OverageLineItem:
//   { key: i.meter_key, amountMinor, componentClass: classifyContractUnitType(i.contractUnitType) }
// lib/performance-share-pull.ts sets contractUnitType to the literal
// PERFORMANCE_SHARE_FEE_COMPONENT constant ('performance_fee') — this test
// exercises that exact same resolution path, not a hand-typed shortcut.
function performanceSharePoolComponent(amountMinor: number): PoolComponent {
  return {
    key: 'performance_share_fee', // meter_key, as set in lib/performance-share-pull.ts
    amountMinor,
    componentClass: classifyContractUnitType(PERFORMANCE_SHARE_FEE_COMPONENT),
  }
}

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

describe('Step 17C.1a, item 5 — the performance-share pool component resolves to a real, registered class', () => {
  it('classifyContractUnitType(PERFORMANCE_SHARE_FEE_COMPONENT) resolves to the performance_fee class, never null', () => {
    expect(classifyContractUnitType(PERFORMANCE_SHARE_FEE_COMPONENT)).toBe('performance_fee')
  })
})

describe('Step 17C.1a, item 5 — credit eligibility isolation for the performance-share component', () => {
  it('a credit eligible for ANOTHER specific component must NOT reduce performance_fee', () => {
    const pool: PoolComponent[] = [performanceSharePoolComponent(355_000)] // €3,550.00
    const rule = applicationRule({ eligible_component_keys: ['transaction_processing'] })
    expect(filterEligibleComponents(pool, rule)).toHaveLength(0)
  })

  it('a credit explicitly eligible for performance_fee MAY reduce it', () => {
    const pool: PoolComponent[] = [performanceSharePoolComponent(355_000)]
    const rule = applicationRule({ eligible_component_keys: [PERFORMANCE_SHARE_FEE_COMPONENT] })
    const matched = filterEligibleComponents(pool, rule)
    expect(matched).toHaveLength(1)
    expect(matched[0].amountMinor).toBe(355_000)
  })

  it('a credit eligible for performance_fee, but with it also excluded, does NOT reduce it', () => {
    const pool: PoolComponent[] = [performanceSharePoolComponent(355_000)]
    const rule = applicationRule({ eligible_component_keys: [PERFORMANCE_SHARE_FEE_COMPONENT], excluded_component_keys: [PERFORMANCE_SHARE_FEE_COMPONENT] })
    expect(filterEligibleComponents(pool, rule)).toHaveLength(0)
  })

  it('a credit with eligible_component_keys: null (unresolved) matches nothing, including performance_fee', () => {
    const pool: PoolComponent[] = [performanceSharePoolComponent(355_000)]
    const rule = applicationRule({ eligible_component_keys: null })
    expect(filterEligibleComponents(pool, rule)).toHaveLength(0)
  })

  it('an "all" scoped credit legitimately includes performance_fee, alongside every other component — this is intended "all remaining payable pool" behavior, not a leak', () => {
    const pool: PoolComponent[] = [
      { key: 'platform_fee', amountMinor: 200_000, componentClass: 'platform_fee' },
      performanceSharePoolComponent(355_000),
    ]
    const rule = applicationRule({ eligible_component_keys: 'all' })
    const matched = filterEligibleComponents(pool, rule)
    expect(matched.map(c => c.key).sort()).toEqual(['performance_share_fee', 'platform_fee'])
  })

  it('a pool item with a genuinely unclassifiable key and no componentClass is unreachable by a specific eligible list — confirms the fail-closed baseline this fix relies on (an unresolved class matches nothing, not everything)', () => {
    const unclassified: PoolComponent = { key: 'some_arbitrary_org_meter_key', amountMinor: 355_000, componentClass: null }
    const rule = applicationRule({ eligible_component_keys: [PERFORMANCE_SHARE_FEE_COMPONENT] })
    expect(filterEligibleComponents([unclassified], rule)).toHaveLength(0)
  })
})
