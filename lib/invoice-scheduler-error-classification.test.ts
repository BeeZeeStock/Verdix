import { describe, it, expect } from 'vitest'
import { classifySchedulerCatchOutcome } from './invoice-scheduler-error-classification'
import { QuantitySourceNotReadyError } from './commercial-quantity-source'

// Step E9B.1 §9/§10/§11 — direct tests for the pure decision behind
// app/api/admin/invoice-scheduler/route.ts's per-row catch block. The
// route's own DB update/results.push are mechanical actions on this exact
// decision (see that file's own comment), so proving this classification
// is correct proves the row-level status transition is correct.
//
// What this does NOT (and cannot, without a supabaseServer/Stripe/
// Remembill mocking harness this codebase has no precedent for — see
// lib/usage-pull.test.ts's identical, pre-existing documented limitation)
// directly exercise: that execution_payload is never partially persisted,
// that the invoice writer/Remembill are never called for a row that ends
// up here, and that a retry reuses the same row id without a duplicate
// send. Those are verified by reading the route's actual control flow
// (a throw from computeOverageForPeriod/computePerformanceShareLineItems
// ForPeriod happens strictly BEFORE the execution_payload object is ever
// constructed or any Stripe/Remembill call is made — confirmed line by
// line, not assumed) and reported as such rather than claimed as covered
// by an automated test.
describe('classifySchedulerCatchOutcome', () => {
  it('QuantitySourceNotReadyError -> status stays scheduled, held:true, message prefixed "Held: "', () => {
    const err = new QuantitySourceNotReadyError({
      ready: false, provenance: 'external_usage', metricKey: 'transaction_count',
      periodStart: '2026-09-01', periodEnd: '2026-09-30', reason: '[usage_source] connector timeout',
    })
    const outcome = classifySchedulerCatchOutcome(err)
    expect(outcome.status).toBe('scheduled')
    expect(outcome.held).toBe(true)
    expect(outcome.errorMessage.startsWith('Held: ')).toBe(true)
    expect(outcome.errorMessage).toContain('[usage_source] connector timeout')
  })

  it('a plain Error (e.g. the E9B currency-mismatch/invalid-data throws) -> status becomes failed, held:false, NOT prefixed "Held: "', () => {
    const err = new Error("'Performance share' currency problem for job abc, period 2026-09-01–2026-09-30: [currency_mismatch] input mismatch")
    const outcome = classifySchedulerCatchOutcome(err)
    expect(outcome.status).toBe('failed')
    expect(outcome.held).toBe(false)
    expect(outcome.errorMessage.startsWith('Held: ')).toBe(false)
    expect(outcome.errorMessage).toContain('[currency_mismatch]')
  })

  it('a non-Error thrown value (e.g. a rejected promise with a string/object) still classifies as failed, never held — never silently converted to retryable', () => {
    const outcome = classifySchedulerCatchOutcome('a raw string throw')
    expect(outcome.status).toBe('failed')
    expect(outcome.held).toBe(false)
    expect(outcome.errorMessage).toBe('a raw string throw')
  })

  it('a Supabase/Postgrest-shaped error object (not an Error instance) also classifies as failed, never held', () => {
    const pgError = { message: 'duplicate key value violates unique constraint', code: '23505' }
    const outcome = classifySchedulerCatchOutcome(pgError)
    expect(outcome.status).toBe('failed')
    expect(outcome.held).toBe(false)
  })
})
