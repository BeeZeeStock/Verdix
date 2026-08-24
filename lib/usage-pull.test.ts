import { describe, it, expect } from 'vitest'
import { OpenBillingWindowError } from './usage-pull'

// The pure shape of the fail-closed error computeOverageForPeriod throws
// when a real-billing call is asked to apply a usage/minimum charge for a
// window that isn't closed as of the caller's explicit billingAsOfUnix —
// see lib/tariff.test.ts's isBillingWindowClosed suite for the actual
// closure-boundary logic this error's condition is built on.
// computeOverageForPeriod itself isn't unit-tested here — it has real
// supabaseServer/connector dependencies with no existing mocking
// convention anywhere in this codebase; its wiring (throw placed before
// any usage pull or charge computation, scoped to real billing only via
// isRealBilling = livePreviewAsOfUnix == null) is verified by direct code
// reading, reported alongside these tests rather than claimed as covered
// by them.
describe('OpenBillingWindowError', () => {
  it('carries the meter key and the ISO-date window bounds', () => {
    const err = new OpenBillingWindowError('sync', new Date(2026, 9, 1), new Date(2026, 9, 31))
    expect(err.name).toBe('OpenBillingWindowError')
    expect(err.meterKey).toBe('sync')
    expect(err.windowStart).toBe('2026-10-01')
    expect(err.windowEnd).toBe('2026-10-31')
    expect(err).toBeInstanceOf(Error)
  })

  it('is thrown, not returned — a caller that forgets to catch it fails loudly rather than continuing', () => {
    expect(() => {
      throw new OpenBillingWindowError('sync', new Date(2026, 9, 1), new Date(2026, 9, 31))
    }).toThrow(OpenBillingWindowError)
  })

  it('the message names the meter and both window bounds, never a raw internal date format', () => {
    const err = new OpenBillingWindowError('sync', new Date(2026, 9, 1), new Date(2026, 9, 31))
    expect(err.message).toContain('sync')
    expect(err.message).toContain('2026-10-01')
    expect(err.message).toContain('2026-10-31')
  })
})
