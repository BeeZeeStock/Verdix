import { describe, it, expect } from 'vitest'
import {
  computeBaseTcv,
  computeCommittedContractValue,
  contractLifecycleStatus,
  isEscalatorItem,
  type BaseTcvItem,
} from './contract-tcv-calc'

function item(overrides: Partial<BaseTcvItem> = {}): BaseTcvItem {
  return {
    product_name: 'Base subscription',
    applied_rule: null,
    total_amount: 1000,
    billing_period: 'monthly',
    ...overrides,
  }
}

describe('computeBaseTcv (Fixed fees)', () => {
  it('fixed-only contract: sums every non-escalator line item', () => {
    const items = [item({ total_amount: 1000 }), item({ total_amount: 2000, product_name: 'Support' })]
    expect(computeBaseTcv(items)).toBe(3000)
  })

  it('fixed + one-time: one-time fee rows contribute like any other row', () => {
    const items = [
      item({ total_amount: 12000 }),
      item({ total_amount: 5000, product_name: 'Onboarding', billing_period: 'one_time' }),
    ]
    expect(computeBaseTcv(items)).toBe(17000)
  })

  it('excludes escalator rows from the total', () => {
    const items = [
      item({ total_amount: 12000 }),
      item({ total_amount: 500, product_name: 'CPI escalator', applied_rule: 'escalator' }),
    ]
    expect(computeBaseTcv(items)).toBe(12000)
  })

  it('tiered-no-minimum: usage tier rows with total_amount = 0 contribute nothing extra', () => {
    const items = [
      item({ total_amount: 12000 }),
      item({ total_amount: 0, product_name: 'API overage' }),
    ]
    expect(computeBaseTcv(items)).toBe(12000)
  })
})

describe('isEscalatorItem', () => {
  it('detects escalator rows by applied_rule or product name', () => {
    expect(isEscalatorItem('Anything', 'escalator')).toBe(true)
    expect(isEscalatorItem('CPI adjustment', null)).toBe(true)
    expect(isEscalatorItem('Base subscription', null)).toBe(false)
  })
})

describe('computeCommittedContractValue', () => {
  it('excludes unconfirmed minimum commitments — never silently included', () => {
    const items = [item({ total_amount: 12000 })]
    const minimums = [{ amount: 5000, requires_confirmation: true }]
    // The SEK 5,000-style ambiguous minimum must not appear in the total
    // until a reviewer confirms it — this is the core guarantee the spec
    // requires: never silently inferred.
    expect(computeCommittedContractValue(items, minimums)).toBe(12000)
  })

  it('includes a confirmed minimum commitment once resolved', () => {
    const items = [item({ total_amount: 12000 })]
    const minimums = [{ amount: 5000, requires_confirmation: false }]
    expect(computeCommittedContractValue(items, minimums)).toBe(17000)
  })

  it('sums multiple confirmed minimums across metrics while still excluding unconfirmed ones', () => {
    const items = [item({ total_amount: 12000 })]
    const minimums = [
      { amount: 5000, requires_confirmation: false },
      { amount: 3000, requires_confirmation: true },
      { amount: 1000, requires_confirmation: false },
    ]
    expect(computeCommittedContractValue(items, minimums)).toBe(18000) // 12000 + 5000 + 1000
  })
})

describe('contractLifecycleStatus', () => {
  const today = new Date(2026, 7, 15) // 15 Aug 2026

  it('upcoming: start date is in the future', () => {
    expect(contractLifecycleStatus('2026-09-01', '2027-09-01', today)).toBe('upcoming')
  })

  it('active: today falls within the contract window', () => {
    expect(contractLifecycleStatus('2026-01-01', '2027-01-01', today)).toBe('active')
  })

  it('completed: end date has passed — this is when Billed to date becomes Realised TCV', () => {
    expect(contractLifecycleStatus('2024-01-01', '2025-01-01', today)).toBe('completed')
  })

  it('no_dates: missing either date', () => {
    expect(contractLifecycleStatus(null, '2027-01-01', today)).toBe('no_dates')
    expect(contractLifecycleStatus('2026-01-01', null, today)).toBe('no_dates')
  })
})
