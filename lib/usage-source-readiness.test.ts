import { describe, it, expect } from 'vitest'
import { classifyUsageSourceOutcome } from './usage-source-readiness'

// Step E9B.1 §9 — direct tests for the pure decision logic behind lib/
// usage-pull.ts's real-billing throw sites (the E9B fix). Extracted
// specifically because this codebase has no vi.mock('@/lib/supabase')
// convention (confirmed by grep) to test computeOverageForPeriod itself
// directly — see that function's own test file for the established
// precedent of documenting this limitation rather than inventing a new
// mocking pattern.
describe('classifyUsageSourceOutcome — manual fallback attempted', () => {
  it('manual fallback ready (including a genuine zero quantity) — success, never blocking', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'no meter_key configured',
      manualResolved: { ready: true, quantity: 0, source: 'manual' },
      isRealBilling: true,
    })
    expect(outcome).toEqual({ ready: true, quantity: 0 })
  })

  it('manual fallback ready with a nonzero quantity — success', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'no meter_key configured',
      manualResolved: { ready: true, quantity: 42, source: 'manual' },
      isRealBilling: true,
    })
    expect(outcome).toEqual({ ready: true, quantity: 42 })
  })

  it('manual fallback required but not finalized, real billing — blocking, tagged [usage_source]', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'no meter_key configured',
      manualResolved: { ready: false, reason: 'no finalized value on record' },
      isRealBilling: true,
    })
    expect(outcome.ready).toBe(false)
    if (outcome.ready) throw new Error('unreachable')
    expect(outcome.blocking).toBe(true)
    expect(outcome.reason).toContain('[usage_source]')
    expect(outcome.reason).toContain('manual fallback also not ready')
    expect(outcome.reason).toContain('no finalized value on record')
  })

  it('manual fallback not ready, PREVIEW (not real billing) — never blocking, preserves prior skip-and-log behavior', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'no meter_key configured',
      manualResolved: { ready: false, reason: 'no finalized value on record' },
      isRealBilling: false,
    })
    expect(outcome.ready).toBe(false)
    if (outcome.ready) throw new Error('unreachable')
    expect(outcome.blocking).toBe(false)
  })
})

describe('classifyUsageSourceOutcome — no manual fallback attempted (a real meter_key was configured)', () => {
  it('real meter configured, pull not ready, real billing — blocking, tagged [usage_source]', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'connector timeout',
      manualResolved: null,
      isRealBilling: true,
    })
    expect(outcome.ready).toBe(false)
    expect(outcome.blocking).toBe(true)
    expect(outcome.reason).toBe('[usage_source] connector timeout')
  })

  it('real meter configured, pull not ready, preview — never blocking', () => {
    const outcome = classifyUsageSourceOutcome({
      pullReason: 'connector timeout',
      manualResolved: null,
      isRealBilling: false,
    })
    expect(outcome.ready).toBe(false)
    expect(outcome.blocking).toBe(false)
  })
})
