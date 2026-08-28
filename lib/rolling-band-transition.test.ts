import { describe, it, expect } from 'vitest'
import { evaluateRollingBandTransition, resolveTransitionLifecycleStatus, type PersistedRollingBandTransitionLifecycle } from './rolling-band-transition'
import type { RollingWindowPeriodValue } from './rolling-window-aggregate'
import type { FixedFeeBand, RollingBandMigrationConfig, TransitionEffectiveRule } from './types'

const NEXT_BILLING_PERIOD_RULE: TransitionEffectiveRule = { kind: 'next_billing_period', provenance: 'reviewer_policy' }

function lifecycle(overrides: Partial<PersistedRollingBandTransitionLifecycle>): PersistedRollingBandTransitionLifecycle {
  return {
    notice_required: true, notice_status: null, notice_confirmed_at: null,
    effective_rule: null, effective_from: null, status: 'pending_notice',
    ...overrides,
  }
}

const CONFIG: RollingBandMigrationConfig = {
  aggregate: { input_key: 'issued_payment_request_count', window_count: 3, window_unit: 'billing_period', operation: 'mean', require_complete_windows: true },
  trigger_comparator: 'greater_than',
  compared_to: 'contracted_volume',
  notice_required: true,
}

// The real, expanded Remembill band table (Step 17C.2).
const BANDS: FixedFeeBand[] = [
  { from_unit: 1, to_unit: 500, monthly_fee: 500 },
  { from_unit: 501, to_unit: 1500, monthly_fee: 1200 },
  { from_unit: 1501, to_unit: 5000, monthly_fee: 2000 },
  { from_unit: 5001, to_unit: 15000, monthly_fee: 5000 },
  { from_unit: 15001, to_unit: 150000, monthly_fee: 12000 },
  { from_unit: 150001, to_unit: null, monthly_fee: null },
]
const CONTRACTED_VOLUME = 5000

function periods(values: Array<number | null>): RollingWindowPeriodValue[] {
  const months = ['2027-01', '2027-02', '2027-03']
  return values.map((value, i) => ({ period_start: `${months[i]}-01`, period_end: `${months[i]}-28`, value }))
}

describe('evaluateRollingBandTransition — Step 17C.2, section 11', () => {
  it('[4000, 4500, 5000] average 4500 -> no transition (below contracted volume)', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([4000, 4500, 5000]) })
    expect(result).toMatchObject({ status: 'no_transition', rollingAverage: 4500 })
  })

  it('[5000, 5000, 5001] average 5000.333... -> triggers, and (via ceil rounding) selects the 5,001–15,000 band, never staying in 1,501–5,000', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([5000, 5000, 5001]) })
    expect(result.status).toBe('transition_triggered')
    if (result.status !== 'transition_triggered') return
    expect(result.rollingAverage).toBeCloseTo(5000.3333333, 5)
    expect(result.fromBand).toEqual({ from_unit: 1501, to_unit: 5000, monthly_fee: 2000 })
    expect(result.toBand).toEqual({ from_unit: 5001, to_unit: 15000, monthly_fee: 5000 })
  })

  it('[7000, 8000, 9000] average 8000 -> triggers, selects the 5,001–15,000 band -> €5,000/month', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([7000, 8000, 9000]) })
    expect(result.status).toBe('transition_triggered')
    if (result.status !== 'transition_triggered') return
    expect(result.toBand.monthly_fee).toBe(5000)
  })

  it('[20000, 30000, 40000] average 30000 -> triggers, selects the 15,001–150,000 band -> €12,000/month', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([20000, 30000, 40000]) })
    expect(result.status).toBe('transition_triggered')
    if (result.status !== 'transition_triggered') return
    expect(result.toBand.monthly_fee).toBe(12000)
  })

  it('>150,000 average -> triggers, but the proposed band has no numeric price -> transition_triggered_not_executable, price never invented, and the resolved-but-unpriced band is still carried (Step 17C.2a, item 7)', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([160000, 170000, 180000]) })
    expect(result.status).toBe('transition_triggered_not_executable')
    if (result.status !== 'transition_triggered_not_executable') return
    expect(result.reason).toMatch(/Offereras|quote required/)
    expect(result.proposedBand).toEqual({ from_unit: 150001, to_unit: null, monthly_fee: null })
  })
})

describe('evaluateRollingBandTransition — held/invalid cases', () => {
  it('missing one month -> not_ready', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([7000, null, 9000]) })
    expect(result.status).toBe('not_ready')
  })

  it('no contracted volume known -> not_ready', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: null, periodValues: periods([7000, 8000, 9000]) })
    expect(result.status).toBe('not_ready')
  })

  it('the committed volume itself does not resolve to any band -> invalid (a config problem)', () => {
    const gappedBands: FixedFeeBand[] = [{ from_unit: 1, to_unit: 100, monthly_fee: 500 }]
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: gappedBands, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([7000, 8000, 9000]) })
    expect(result.status).toBe('invalid')
  })
})

describe('evaluateRollingBandTransition — no downward transition unless explicitly configured (item 5 / 14)', () => {
  it('a rolling average BELOW the contracted volume never triggers, even though the type could in principle represent "below" as a fact', () => {
    const result = evaluateRollingBandTransition({ config: CONFIG, bands: BANDS, contractedVolume: CONTRACTED_VOLUME, periodValues: periods([1000, 2000, 3000]) })
    expect(result.status).toBe('no_transition')
  })

  it('trigger_comparator has no member other than greater_than — a downward rule is inexpressible in the type, not merely unused (compile-time proof, not a runtime assertion)', () => {
    // @ts-expect-error — 'less_than' is not a valid trigger_comparator value.
    const invalidConfig: RollingBandMigrationConfig = { ...CONFIG, trigger_comparator: 'less_than' }
    expect(invalidConfig).toBeDefined() // this test's real assertion is the ts-expect-error above
  })
})

describe('resolveTransitionLifecycleStatus — Step 17C.2a, items 1/2/7/8', () => {
  const asOf = new Date('2027-06-01T00:00:00')

  it('pricing_required is trusted directly from the stored status, regardless of every other field', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({ status: 'pricing_required', notice_required: false }), asOf)).toBe('pricing_required')
  })

  it('notice required, not yet confirmed -> pending_notice, regardless of any effective_rule/effective_from', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({ notice_status: 'pending', effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-01-01' }), asOf)).toBe('pending_notice')
    expect(resolveTransitionLifecycleStatus(lifecycle({ notice_status: null }), asOf)).toBe('pending_notice')
  })

  it('item 1 — notice confirmed (or not required), but no effective_rule/effective_from resolved yet -> decision_required, never guessed', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-01-01T00:00:00Z', status: 'decision_required',
    }), asOf)).toBe('decision_required')
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_required: false, notice_status: null, status: 'decision_required',
    }), asOf)).toBe('decision_required')
  })

  it('effective_rule resolved, effective_from in the future -> pending_effective_date', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-01-01T00:00:00Z',
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-12-01', status: 'pending_effective_date',
    }), asOf)).toBe('pending_effective_date')
  })

  it('everything resolved, effective_from has arrived (asOf >= effective_from) -> active', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-01-01T00:00:00Z',
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('active')
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-01-01T00:00:00Z',
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-06-01', status: 'pending_effective_date',
    }), asOf)).toBe('active') // exact instant
  })

  it('notice NOT required at all -> skips notice gating, still needs effective_rule resolved', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_required: false, notice_status: null, status: 'decision_required',
    }), asOf)).toBe('decision_required')
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_required: false, notice_status: null,
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('active')
  })

  it('item 2 — activation must PROVE notice_confirmed_at < effective_from; notice confirmed AT OR AFTER the effective date remains pending, not active', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-05-01T00:00:00Z', // confirmed the SAME day it takes effect
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('pending_notice')
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-05-15T00:00:00Z', // confirmed AFTER the effective date
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('pending_notice')
  })

  it('item 2 — notice confirmed comfortably BEFORE the effective date activates normally once asOf arrives', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: '2027-01-01T00:00:00Z',
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('active')
  })

  it('notice required and confirmed, but notice_confirmed_at itself missing (malformed row) -> pending_notice, fails closed', () => {
    expect(resolveTransitionLifecycleStatus(lifecycle({
      notice_status: 'confirmed', notice_confirmed_at: null,
      effective_rule: NEXT_BILLING_PERIOD_RULE, effective_from: '2027-05-01', status: 'pending_effective_date',
    }), asOf)).toBe('pending_notice')
  })
})
