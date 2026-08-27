import { describe, it, expect } from 'vitest'
import {
  classifyPerformanceShareMateriality,
  discountMateriallyAffectsPerformanceShare,
  classifyPilotPeriodOverlap,
  performanceShareRequiresConfirmation,
  performanceShareDiscountMultiplierForPeriod,
  PERFORMANCE_SHARE_FEE_COMPONENT,
} from './performance-share-materiality'

describe('classifyPerformanceShareMateriality — tri-state, fail-closed on unknown', () => {
  it('affected_components includes performance_fee → definitely_affects', () => {
    expect(classifyPerformanceShareMateriality({ affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT] })).toBe('definitely_affects')
  })

  it('possibly_affected_components includes performance_fee → unknown (a live, unresolved scope question)', () => {
    expect(classifyPerformanceShareMateriality({ affected_components: ['base_recurring_fee'], possibly_affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT] })).toBe('unknown')
  })

  it('typed targeting present but neither array names performance_fee → definitely_does_not_affect', () => {
    expect(classifyPerformanceShareMateriality({ affected_components: ['base_recurring_fee'], possibly_affected_components: [] })).toBe('definitely_does_not_affect')
  })

  it('no typed targeting at all (legacy/pre-typed discount) → unknown, fails closed', () => {
    expect(classifyPerformanceShareMateriality({})).toBe('unknown')
  })
})

describe('classifyPilotPeriodOverlap — the three period/pilot-window relationships', () => {
  const pilotStart = new Date('2026-10-01T00:00:00')
  const pilotEnd = new Date('2026-12-29T00:00:00') // 90-day pilot from 2026-10-01

  it('period fully after the pilot → none', () => {
    expect(classifyPilotPeriodOverlap(pilotStart, pilotEnd, new Date('2027-01-01'), new Date('2027-01-31'))).toBe('none')
  })

  it('period fully before the pilot → none', () => {
    expect(classifyPilotPeriodOverlap(pilotStart, pilotEnd, new Date('2026-09-01'), new Date('2026-09-30'))).toBe('none')
  })

  it('period fully inside the pilot → full', () => {
    expect(classifyPilotPeriodOverlap(pilotStart, pilotEnd, new Date('2026-11-01'), new Date('2026-11-30'))).toBe('full')
  })

  it('period straddling the pilot\'s expiry (starts inside, ends after) → straddle', () => {
    expect(classifyPilotPeriodOverlap(pilotStart, pilotEnd, new Date('2026-12-01'), new Date('2026-12-31'))).toBe('straddle')
  })

  it('period straddling the pilot\'s start (starts before, ends inside) → straddle', () => {
    expect(classifyPilotPeriodOverlap(pilotStart, pilotEnd, new Date('2026-09-15'), new Date('2026-10-15'))).toBe('straddle')
  })
})

describe('performanceShareRequiresConfirmation — item 2, period-aware pilot-scope blocking', () => {
  const unresolvedPilot = [{
    description: 'pilot waiver', affected_components: ['base_recurring_fee'], possibly_affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT],
    start_date: '2026-10-01', duration_days: 90,
  }]

  it('an unconfirmed pilot scope question does NOT block a period fully after the pilot window', () => {
    const result = performanceShareRequiresConfirmation(unresolvedPilot, new Date('2027-03-01'), new Date('2027-03-31'))
    expect(result.blocked).toBe(false)
  })

  it('an unconfirmed pilot scope question DOES block a period fully inside the pilot window', () => {
    const result = performanceShareRequiresConfirmation(unresolvedPilot, new Date('2026-10-15'), new Date('2026-11-14'))
    expect(result.blocked).toBe(true)
    expect(result.reasons[0]).toMatch(/Decision Required/)
  })

  it('an unconfirmed pilot scope question DOES block a period straddling the pilot window', () => {
    const result = performanceShareRequiresConfirmation(unresolvedPilot, new Date('2026-12-01'), new Date('2026-12-31'))
    expect(result.blocked).toBe(true)
  })

  it('a discount that definitely does NOT affect performance_fee never blocks any period', () => {
    const result = performanceShareRequiresConfirmation(
      [{ description: 'base fee only discount', affected_components: ['base_recurring_fee'], possibly_affected_components: [] }],
      new Date('2026-10-15'), new Date('2026-11-14'),
    )
    expect(result.blocked).toBe(false)
  })

  it('no discounts at all never blocks', () => {
    expect(performanceShareRequiresConfirmation(null, new Date('2026-10-15'), new Date('2026-11-14')).blocked).toBe(false)
    expect(performanceShareRequiresConfirmation([], new Date('2026-10-15'), new Date('2026-11-14')).blocked).toBe(false)
  })

  describe('a CONFIRMED waiver (performance_fee waived)', () => {
    const confirmedWaiver = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]

    it('does not block a period fully inside the pilot — the confirmed waiver applies cleanly', () => {
      expect(performanceShareRequiresConfirmation(confirmedWaiver, new Date('2026-10-15'), new Date('2026-11-14')).blocked).toBe(false)
    })

    it('does not block a period fully after the pilot — the waiver is simply not in effect', () => {
      expect(performanceShareRequiresConfirmation(confirmedWaiver, new Date('2027-03-01'), new Date('2027-03-31')).blocked).toBe(false)
    })

    it('DOES block a period straddling the pilot expiry — no confirmed treatment for splitting the monthly basis', () => {
      const result = performanceShareRequiresConfirmation(confirmedWaiver, new Date('2026-12-01'), new Date('2026-12-31'))
      expect(result.blocked).toBe(true)
      expect(result.reasons[0]).toMatch(/expires partway through this period/)
    })
  })

  describe('a CONFIRMED non-waiver ("Fixed platform fee only" — performance_fee NOT affected)', () => {
    const confirmedNotWaived = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee'], possibly_affected_components: [],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]

    it('never blocks, including a period straddling the pilot window — the boundary is irrelevant when performance share was never waived', () => {
      expect(performanceShareRequiresConfirmation(confirmedNotWaived, new Date('2026-12-01'), new Date('2026-12-31')).blocked).toBe(false)
    })
  })
})

describe('performanceShareDiscountMultiplierForPeriod — item 8, pilot interaction', () => {
  const periodInsidePilot = new Date('2026-10-15T00:00:00')
  const periodAfterPilot = new Date('2027-02-01T00:00:00')

  it('"Fixed platform fee only" (performance_fee NOT in affected_components) → multiplier 1, performance share remains active', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee'], possibly_affected_components: [],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]
    expect(performanceShareDiscountMultiplierForPeriod(discounts, periodInsidePilot)).toBe(1)
  })

  it('"Fixed platform fee + performance fee" (performance_fee IS in affected_components) → multiplier 0, performance share waived', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]
    expect(performanceShareDiscountMultiplierForPeriod(discounts, periodInsidePilot)).toBe(0)
  })

  it('a partial (non-100%) confirmed waiver of performance_fee reduces, not zeroes, the multiplier — reuses ordinary discount semantics', () => {
    const discounts = [{
      description: '50% pilot reduction', interpretation: { requires_confirmation: false },
      affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 50, start_date: '2026-10-01', duration_days: 90,
    }]
    expect(performanceShareDiscountMultiplierForPeriod(discounts, periodInsidePilot)).toBe(0.5)
  })

  it('a waiver targeting performance_fee no longer applies once the period is outside its dated window', () => {
    const discounts = [{
      description: 'pilot waiver', interpretation: { requires_confirmation: false },
      affected_components: ['base_recurring_fee', PERFORMANCE_SHARE_FEE_COMPONENT], possibly_affected_components: [],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]
    expect(performanceShareDiscountMultiplierForPeriod(discounts, periodAfterPilot)).toBe(1)
  })

  it('an UNCONFIRMED discount never reduces the multiplier even if its typed scope includes performance_fee — only a confirmed rate can', () => {
    const discounts = [{
      description: 'still pending', affected_components: [PERFORMANCE_SHARE_FEE_COMPONENT],
      discount_pct: 100, start_date: '2026-10-01', duration_days: 90,
    }]
    expect(performanceShareDiscountMultiplierForPeriod(discounts, periodInsidePilot)).toBe(1)
  })
})

describe('discountMateriallyAffectsPerformanceShare — direct unit coverage of the fail-closed boolean', () => {
  it('unknown classification (no typed targeting) fails closed to true (materially affects)', () => {
    expect(discountMateriallyAffectsPerformanceShare({})).toBe(true)
  })
  it('definitely_does_not_affect returns false', () => {
    expect(discountMateriallyAffectsPerformanceShare({ affected_components: ['base_recurring_fee'], possibly_affected_components: [] })).toBe(false)
  })
})
