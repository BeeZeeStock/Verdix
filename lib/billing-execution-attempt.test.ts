import { describe, it, expect } from 'vitest'
import {
  deriveIdempotencyKey, operationKeyFor, classifyFetchOutcome, classifyStripeFailure,
  canSafelyRetryBillingOperation, STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS,
  classifyPriorAttemptForSupersession,
} from './billing-execution-attempt'

describe('deriveIdempotencyKey (Step 14, item 6 — deterministic, never Date.now()/random)', () => {
  it('same attempt/provider/operation/component always produces the same key', () => {
    const k1 = deriveIdempotencyKey('attempt-1', 'stripe', 'create_invoice', 'period:1:0')
    const k2 = deriveIdempotencyKey('attempt-1', 'stripe', 'create_invoice', 'period:1:0')
    expect(k1).toBe(k2)
  })

  it('a different attempt id produces a different key (attempts are the identity boundary)', () => {
    const k1 = deriveIdempotencyKey('attempt-1', 'stripe', 'create_invoice', 'period:1:0')
    const k2 = deriveIdempotencyKey('attempt-2', 'stripe', 'create_invoice', 'period:1:0')
    expect(k1).not.toBe(k2)
  })

  it('a different component produces a different key within the same attempt', () => {
    const k1 = deriveIdempotencyKey('attempt-1', 'stripe', 'create_invoice_item', 'period:1:0')
    const k2 = deriveIdempotencyKey('attempt-1', 'stripe', 'create_invoice_item', 'period:1:1')
    expect(k1).not.toBe(k2)
  })

  it('omitting componentKey (attempt-scoped operations like customer resolution) is stable and distinct from any componentized key', () => {
    const k1 = deriveIdempotencyKey('attempt-1', 'stripe', 'resolve_customer')
    const k2 = deriveIdempotencyKey('attempt-1', 'stripe', 'resolve_customer')
    expect(k1).toBe(k2)
    expect(k1).not.toContain('undefined')
  })
})

describe('operationKeyFor', () => {
  it('is stable and distinguishes componentized operations', () => {
    expect(operationKeyFor('create_invoice', 'period:1:0')).toBe('create_invoice:period:1:0')
    expect(operationKeyFor('resolve_customer')).toBe('resolve_customer')
  })
})

describe('classifyFetchOutcome (Step 14, item 14 — conservative two-bucket rule)', () => {
  it('a definitive HTTP response (even an error one) is failed_safe', () => {
    expect(classifyFetchOutcome({ requestThrew: false, receivedResponse: true })).toBe('failed_safe')
  })
  it('the request throwing (network error, timeout, abort — no response received) is outcome_uncertain', () => {
    expect(classifyFetchOutcome({ requestThrew: true, receivedResponse: false })).toBe('outcome_uncertain')
  })
})

describe('classifyStripeFailure (Step 14, item 7 — real Stripe SDK error types)', () => {
  it('StripeConnectionError (no response / could not connect) is outcome_uncertain', () => {
    expect(classifyStripeFailure({ type: 'StripeConnectionError' })).toBe('outcome_uncertain')
  })
  it("Stripe's own 5xx (StripeAPIError) is outcome_uncertain — an internal Stripe failure does not prove nothing committed", () => {
    expect(classifyStripeFailure({ type: 'StripeAPIError' })).toBe('outcome_uncertain')
  })
  it('a definitive synchronous rejection (StripeInvalidRequestError) is failed_safe', () => {
    expect(classifyStripeFailure({ type: 'StripeInvalidRequestError' })).toBe('failed_safe')
  })
  it('StripeCardError/StripeAuthenticationError/StripePermissionError/StripeRateLimitError/StripeIdempotencyError are all failed_safe', () => {
    for (const type of ['StripeCardError', 'StripeAuthenticationError', 'StripePermissionError', 'StripeRateLimitError', 'StripeIdempotencyError']) {
      expect(classifyStripeFailure({ type })).toBe('failed_safe')
    }
  })
  it('an unrecognized error type (including a future Stripe SDK error class this code predates) defaults to the SAFER outcome_uncertain, never failed_safe', () => {
    expect(classifyStripeFailure(new Error('something else'))).toBe('outcome_uncertain')
    expect(classifyStripeFailure({ type: 'SomeFutureStripeErrorTypeNotYetKnown' })).toBe('outcome_uncertain')
  })
})

describe('canSafelyRetryBillingOperation (Step 14 final amendment, items 5-9 — time-bounded, never ambient Date.now())', () => {
  const startedAt = '2026-01-01T00:00:00.000Z'
  const withinWindow = new Date(new Date(startedAt).getTime() + (STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS - 1) * 3_600_000)
  const exactlyAtWindow = new Date(new Date(startedAt).getTime() + STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS * 3_600_000)
  const justPastWindow = new Date(new Date(startedAt).getTime() + STRIPE_IDEMPOTENCY_KEY_RETENTION_HOURS * 3_600_000 + 1)
  const wayPastWindow = new Date(new Date(startedAt).getTime() + 25 * 3_600_000)

  it('non-outcome_uncertain statuses are always "safe" (nothing to gate — pending/started/failed_safe may be attempted, succeeded is cached)', () => {
    for (const status of ['pending', 'started', 'succeeded', 'failed_safe'] as const) {
      expect(canSafelyRetryBillingOperation({ status, retryCapability: 'manual_verification_required', startedAt }, wayPastWindow)).toBe(true)
    }
  })

  it('reconcilable and manual_verification_required are NEVER auto-safe for an outcome_uncertain operation, regardless of timing', () => {
    for (const retryCapability of ['reconcilable', 'manual_verification_required'] as const) {
      expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability, startedAt }, withinWindow)).toBe(false)
    }
  })

  it('idempotent_retry within the retention window is safe', () => {
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt }, withinWindow)).toBe(true)
  })

  it('idempotent_retry exactly AT the window boundary is still safe (inclusive)', () => {
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt }, exactlyAtWindow)).toBe(true)
  })

  it('idempotent_retry just PAST the window is no longer safe — degrades, never assumed safe forever (item 8)', () => {
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt }, justPastWindow)).toBe(false)
  })

  it('idempotent_retry well past the window (the 25+ hour crash-recovery scenario, item 10) is unsafe', () => {
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt }, wayPastWindow)).toBe(false)
  })

  it('a missing startedAt defensively refuses (an operation cannot legitimately reach outcome_uncertain without having been started)', () => {
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt: null }, withinWindow)).toBe(false)
  })

  it('a retry must not reset the clock — the anchor is the ORIGINAL startedAt, not "now" or any later retry time (item 9)', () => {
    // Simulates: operation first started at startedAt, then two retries were
    // attempted (at +1h and +10h) without startedAt ever changing (the store
    // layer's own guarantee — verified separately). 25h after the ORIGINAL
    // start must still be unsafe, even though the last retry was only 15h ago.
    const twentyFiveHoursAfterOriginalStart = new Date(new Date(startedAt).getTime() + 25 * 3_600_000)
    expect(canSafelyRetryBillingOperation({ status: 'outcome_uncertain', retryCapability: 'idempotent_retry', startedAt }, twentyFiveHoursAfterOriginalStart)).toBe(false)
  })
})

describe('classifyPriorAttemptForSupersession (Step 14 final financial-state correction — resolved != safe to supersede)', () => {
  it('no operations at all -> safe_to_supersede (nothing was ever attempted)', () => {
    expect(classifyPriorAttemptForSupersession([])).toBe('safe_to_supersede')
  })

  it('every operation failed_safe -> safe_to_supersede (nothing was ever created)', () => {
    expect(classifyPriorAttemptForSupersession(['failed_safe', 'failed_safe'])).toBe('safe_to_supersede')
  })

  it('any operation outcome_uncertain -> unresolved, regardless of the others', () => {
    expect(classifyPriorAttemptForSupersession(['succeeded', 'outcome_uncertain'])).toBe('unresolved')
    expect(classifyPriorAttemptForSupersession(['failed_safe', 'outcome_uncertain'])).toBe('unresolved')
    expect(classifyPriorAttemptForSupersession(['outcome_uncertain'])).toBe('unresolved')
  })

  it('a still-pending/started operation on a nominally-terminal attempt is defensively unresolved', () => {
    expect(classifyPriorAttemptForSupersession(['succeeded', 'pending'])).toBe('unresolved')
    expect(classifyPriorAttemptForSupersession(['started'])).toBe('unresolved')
  })

  it('EVERY operation succeeded -> executed (the financial side effect definitely happened; must recover the job, never create a new attempt)', () => {
    expect(classifyPriorAttemptForSupersession(['succeeded'])).toBe('executed')
    expect(classifyPriorAttemptForSupersession(['succeeded', 'succeeded', 'succeeded'])).toBe('executed')
  })

  it('a genuine mix of succeeded and failed_safe -> partially_executed (real external objects exist; not safe to blindly supersede)', () => {
    expect(classifyPriorAttemptForSupersession(['succeeded', 'failed_safe'])).toBe('partially_executed')
  })

  it('item 6 example — a single reconciled-as-succeeded operation -> executed, not merely "resolved"', () => {
    // Simulates: one operation, originally outcome_uncertain, reconciled
    // via outcome: 'succeeded' -> its status is now 'succeeded'.
    expect(classifyPriorAttemptForSupersession(['succeeded'])).toBe('executed')
  })

  it('item 6 example — a single reconciled-as-not_executed operation -> safe_to_supersede, not "executed"', () => {
    // Reconciled via outcome: 'not_executed' -> status becomes 'failed_safe'.
    expect(classifyPriorAttemptForSupersession(['failed_safe'])).toBe('safe_to_supersede')
  })

  it('item 5 example — create_invoice succeeded, row1 succeeded, row2 reconciled not_executed -> partially_executed, never safe_to_supersede', () => {
    expect(classifyPriorAttemptForSupersession(['succeeded', 'succeeded', 'failed_safe'])).toBe('partially_executed')
  })
})
