import { describe, it, expect } from 'vitest'
import { computeContractValueModel, type ContractValueInputs } from './contract-value'
import { computeBaseTcv, type BaseTcvItem } from './contract-tcv-calc'

function item(overrides: Partial<BaseTcvItem> = {}): BaseTcvItem {
  return {
    product_name: 'Base subscription',
    applied_rule: null,
    total_amount: 7500,
    billing_period: 'monthly',
    ...overrides,
  }
}

function inputs(overrides: Partial<ContractValueInputs> = {}): ContractValueInputs {
  return {
    items: [item()],
    metrics: [],
    contractStartDate: '2026-08-17',
    contractEndDate: '2027-08-16',
    billedToDate: 0,
    ...overrides,
  }
}

describe('computeContractValueModel — consistency with computeBaseTcv', () => {
  it('fixedFees always equals computeBaseTcv(items), never a separately-derived figure', () => {
    const items = [item({ total_amount: 12000 }), item({ total_amount: 5000, billing_period: 'one_time', product_name: 'Onboarding' })]
    const model = computeContractValueModel(inputs({ items }))
    expect(model.fixedFees).toBe(computeBaseTcv(items))
  })
})

describe('computeContractValueModel — minimum commitments summed across every cadence window in the term', () => {
  it('a quarterly 5,000 minimum over a 12-month term sums to 20,000, not one quarter (regression: prior under-count bug)', () => {
    // Quarter-aligned term (1 Jan – 31 Dec) spans exactly 4 calendar
    // quarters, isolating the "sum every window" behavior from partial-edge
    // proration (covered separately below).
    const model = computeContractValueModel(inputs({
      contractStartDate: '2026-01-01',
      contractEndDate: '2026-12-31',
      metrics: [{
        measurement_period: 'quarterly',
        reset_anchor: 'calendar',
        minimum_commitment: { amount: 5000, prorate_partial_periods: false, requires_confirmation: false },
      }],
    }))
    expect(model.minimumCommitments).toBe(20000)
    expect(model.committedContractValue).toBe(model.fixedFees + 20000)
  })

  it('never guesses a total while any metric\'s minimum-commitment interpretation is unresolved', () => {
    const model = computeContractValueModel(inputs({
      metrics: [{
        measurement_period: 'quarterly',
        reset_anchor: 'calendar',
        minimum_commitment: { amount: 5000, prorate_partial_periods: false, requires_confirmation: true },
      }],
    }))
    expect(model.minimumCommitments).toBeNull()
    expect(model.committedContractValue).toBeNull()
    expect(model.unbilledCommitments).toBeNull()
    expect(model.projectedContractValue).toBeNull()
    expect(model.pendingReason).toBe('Pending minimum-commitment interpretation')
  })

  it('never guesses a total while partial-period treatment is "unclear"', () => {
    const model = computeContractValueModel(inputs({
      metrics: [{
        measurement_period: 'quarterly',
        reset_anchor: 'calendar',
        minimum_commitment: { amount: 5000, prorate_partial_periods: 'unclear', requires_confirmation: false },
      }],
    }))
    expect(model.minimumCommitments).toBeNull()
    expect(model.pendingReason).toBe('Pending partial-period interpretation')
  })
})

// Agreement A final amendment, item 2 — a fee still conditional on an
// unsigned future Change Order must never inflate fixedFees/
// committedContractValue, must be visible separately via
// conditionalFixedFees, and fixedRecurringValue must stay correct (not go
// negative) despite oneTimeFees and fixedFees both excluding it in lockstep.
describe('computeContractValueModel — Change-Order-conditional fees (Agreement A, item 2)', () => {
  it('fixedFees/committedContractValue exclude the conditional fee; conditionalFixedFees/potentialFixedFees surface it separately', () => {
    const items = [
      item({ total_amount: 1008000, product_name: 'Base subscription' }),
      item({ total_amount: 190000, product_name: 'Implementation fee', billing_period: 'one_time' }),
      item({
        total_amount: 60000, product_name: 'ERP connector', billing_period: 'one_time',
        commitmentStatus: 'conditional_future_agreement',
      }),
    ]
    const model = computeContractValueModel(inputs({ items }))
    expect(model.fixedFees).toBe(1198000)
    expect(model.conditionalFixedFees).toBe(60000)
    expect(model.potentialFixedFees).toBe(1258000)
    // Do not call 1,258,000 committed contract value while the Change Order is unsigned.
    expect(model.committedContractValue).toBe(1198000)
  })

  it('fixedRecurringValue stays correct (never negative) even though a conditional one-time fee is excluded from both fixedFees and oneTimeFees', () => {
    const items = [
      item({ total_amount: 1008000, product_name: 'Base subscription' }),
      item({
        total_amount: 60000, product_name: 'ERP connector', billing_period: 'one_time',
        commitmentStatus: 'conditional_future_agreement',
      }),
    ]
    const model = computeContractValueModel(inputs({ items }))
    expect(model.fixedRecurringValue).toBe(1008000)
  })
})

describe('computeContractValueModel — committed-fixed-fee readiness (hardening item 3, review pass 2)', () => {
  it('an unconfirmed, day-stated discount with no clean effective period makes committedContractValue/unbilledCommitments/projectedContractValue all null — never the raw fixedFees number', () => {
    const model = computeContractValueModel(inputs({
      // Hardening item 1 (review pass 6) — affected_components is now the
      // sole authority for materiality; applies_to alone no longer blocks.
      discounts: [{ interpretation: undefined, description: '90-day pilot', applies_to: 'fixed platform fee', affected_components: ['base_recurring_fee'] }],
    }))
    expect(model.committedFixedFeesResolution.status).toBe('unresolved')
    expect(model.committedFixedFeesResolution.amount).toBeNull()
    expect(model.committedContractValue).toBeNull()
    expect(model.unbilledCommitments === null || model.unbilledCommitments === 0).toBe(true)
    expect(model.projectedContractValue).toBeNull()
    expect(model.pendingReason).toMatch(/pilot/i)
    // fixedFees itself stays a raw number (internal/legacy field, unchanged) —
    // committedFixedFeesResolution is what callers must check before
    // presenting a "committed fixed fees" figure to a user.
    expect(model.fixedFees).toBe(computeBaseTcv(inputs().items))
  })

  it('a confirmed discount (interpretation present, requires_confirmation false) does not block committedContractValue', () => {
    const model = computeContractValueModel(inputs({
      discounts: [{
        interpretation: { requires_confirmation: false },
        description: 'Confirmed 10% intro discount', applies_to: 'base fee',
      }],
    }))
    expect(model.committedFixedFeesResolution.status).toBe('ready')
    expect(model.committedContractValue).not.toBeNull()
  })

  it('no discounts at all is always ready (backward compatible — every pre-existing caller passes no discounts field)', () => {
    const model = computeContractValueModel(inputs())
    expect(model.committedFixedFeesResolution.status).toBe('ready')
    expect(model.committedFixedFeesResolution.amount).toBe(model.fixedFees)
  })

  it('review pass 3, item 1 — discount scope resolved but base_fee_proration still unresolved -> STILL null (two separate decisions)', () => {
    const model = computeContractValueModel(inputs({
      discounts: [{ interpretation: { requires_confirmation: false }, description: 'Pilot waiver', applies_to: 'fixed platform fee' }],
      baseFeeProration: { requires_confirmation: true },
    }))
    expect(model.committedFixedFeesResolution.status).toBe('unresolved')
    expect(model.committedContractValue).toBeNull()
    expect(model.pendingReason).toMatch(/partial-period/i)
  })

  it('review pass 3, item 1 — both discount scope AND base_fee_proration resolved -> ready, real committedContractValue', () => {
    const model = computeContractValueModel(inputs({
      discounts: [{ interpretation: { requires_confirmation: false }, description: 'Pilot waiver', applies_to: 'fixed platform fee' }],
      baseFeeProration: { requires_confirmation: false },
    }))
    expect(model.committedFixedFeesResolution.status).toBe('ready')
    expect(model.committedContractValue).not.toBeNull()
  })
})

describe('computeContractValueModel — cross-screen consistency (regression: 104,375 vs 126,375 divergence)', () => {
  it('two independent call sites given the same inputs produce identical output', () => {
    const sharedInputs = inputs({
      items: [item({ total_amount: 102375 })],
      metrics: [{
        measurement_period: 'monthly',
        reset_anchor: 'contract_start',
        minimum_commitment: { amount: 2000, prorate_partial_periods: false, requires_confirmation: false },
      }],
    })
    // Simulates two "screens" (e.g. Configure page header stats vs Graphical
    // View) each calling the shared function independently — they can only
    // ever disagree if given different inputs, which is then a visible,
    // intentional choice rather than silent drift.
    const screenA = computeContractValueModel(sharedInputs)
    const screenB = computeContractValueModel({ ...sharedInputs })
    expect(screenA).toEqual(screenB)
  })
})
