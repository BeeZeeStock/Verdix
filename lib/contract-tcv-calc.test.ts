import { describe, it, expect } from 'vitest'
import {
  computeBaseTcv,
  computeCommittedFixedFees,
  computeConditionalFixedFees,
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

// Agreement A final amendment, item 2 — Recurring platform fees 1,008,000 +
// Unconditional one-time fees 190,000 = Committed fixed fees 1,198,000;
// Conditional Change Order 60,000; Potential fixed fees incl. CO 1,258,000.
describe('computeCommittedFixedFees / computeConditionalFixedFees (Agreement A, item 2)', () => {
  const recurring = item({ total_amount: 1008000, product_name: 'Base subscription' })
  const unconditionalOneTime = item({ total_amount: 190000, product_name: 'Implementation fee', billing_period: 'one_time' })
  const conditionalOneTime = item({
    total_amount: 60000, product_name: 'ERP connector', billing_period: 'one_time',
    commitmentStatus: 'conditional_future_agreement',
  })
  const items = [recurring, unconditionalOneTime, conditionalOneTime]

  it('committed fixed fees excludes the Change-Order-conditional fee: 1,198,000', () => {
    expect(computeCommittedFixedFees(items)).toBe(1198000)
  })

  it('conditional fixed fees is exactly the excluded fee: 60,000', () => {
    expect(computeConditionalFixedFees(items)).toBe(60000)
  })

  it('committed + conditional always equals the potential total (computeBaseTcv) — the two are a partition, never independently drifting', () => {
    expect(computeCommittedFixedFees(items) + computeConditionalFixedFees(items)).toBe(computeBaseTcv(items))
    expect(computeBaseTcv(items)).toBe(1258000)
  })

  it('an item with no commitmentStatus at all defaults to committed — every pre-existing caller keeps its exact prior total', () => {
    const legacyItems = [item({ total_amount: 12000 }), item({ total_amount: 5000, billing_period: 'one_time' })]
    expect(computeCommittedFixedFees(legacyItems)).toBe(computeBaseTcv(legacyItems))
    expect(computeConditionalFixedFees(legacyItems)).toBe(0)
  })

  it('escalator rows are excluded from both, exactly like computeBaseTcv', () => {
    const withEscalator = [...items, item({ total_amount: 500, product_name: 'CPI escalator', applied_rule: 'escalator' })]
    expect(computeCommittedFixedFees(withEscalator)).toBe(1198000)
    expect(computeConditionalFixedFees(withEscalator)).toBe(60000)
  })
})

// Agreement A final amendment (post-review correction) — the construction
// boundary (app/(dashboard)/configure/[id]/page.tsx and
// lib/contract-tcv.ts's getContractSummaries) builds each one-time fee's
// BaseTcvItem entry DIRECTLY from its own OneTimeFee (fee_id, amount,
// billability_condition), one entry per fee, never joining/grouping by
// product_name === fee_label — display labels are not stable commercial
// identity (that's exactly why OneTimeFee.fee_id exists, Step 13). This
// test proves the property that construction relies on: these aggregation
// functions operate purely per-array-element and never key, group, or
// dedupe by product_name — two fees sharing an identical label with
// different commitment status are never collapsed or cross-contaminated.
describe('computeCommittedFixedFees / computeConditionalFixedFees — never key/group by product_name (Agreement A final amendment, item 2 correction)', () => {
  it('two one-time fees with the SAME display label but different commitment status are classified and summed independently, never merged', () => {
    const items: BaseTcvItem[] = [
      item({ product_name: 'Implementation fee', total_amount: 150000, billing_period: 'one_time', commitmentStatus: 'committed' }),
      item({ product_name: 'Implementation fee', total_amount: 60000, billing_period: 'one_time', commitmentStatus: 'conditional_future_agreement' }),
    ]
    // If these were ever collapsed/matched by label, either the committed
    // fee could pick up the conditional one's status (or vice versa), or
    // one could be silently dropped — none of that happens here.
    expect(computeCommittedFixedFees(items)).toBe(150000)
    expect(computeConditionalFixedFees(items)).toBe(60000)
    expect(items).toHaveLength(2) // both entries genuinely distinct, not deduped
  })

  it('three same-labeled fees (mixed status) sum correctly regardless of order', () => {
    const items: BaseTcvItem[] = [
      item({ product_name: 'Setup fee', total_amount: 10000, billing_period: 'one_time', commitmentStatus: 'conditional_future_agreement' }),
      item({ product_name: 'Setup fee', total_amount: 20000, billing_period: 'one_time', commitmentStatus: 'committed' }),
      item({ product_name: 'Setup fee', total_amount: 5000, billing_period: 'one_time', commitmentStatus: 'conditional_future_agreement' }),
    ]
    expect(computeCommittedFixedFees(items)).toBe(20000)
    expect(computeConditionalFixedFees(items)).toBe(15000)
  })
})

describe('computeCommittedContractValue — never includes a Change-Order-conditional fee (item 2)', () => {
  it('a conditional fee is excluded from committed contract value even with confirmed minimum commitments added on top', () => {
    const items = [
      item({ total_amount: 1198000, product_name: 'Recurring + unconditional one-time' }),
      item({ total_amount: 60000, product_name: 'ERP connector', billing_period: 'one_time', commitmentStatus: 'conditional_future_agreement' }),
    ]
    const minimums = [{ amount: 10000, requires_confirmation: false }]
    // 1,198,000 + 10,000 confirmed minimum — the 60,000 conditional fee never enters.
    expect(computeCommittedContractValue(items, minimums)).toBe(1208000)
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
