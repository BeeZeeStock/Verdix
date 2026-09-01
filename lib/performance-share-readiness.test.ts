import { describe, it, expect } from 'vitest'
import { classifyCurrencyProblem, classifyPerformanceShareResultStatus } from './performance-share-readiness'

// Step E9B.1 §9 — direct tests for the pure decision logic behind lib/
// performance-share-pull.ts's real-billing throw sites (the E9B fix, and
// the E9B.1 §8 correction of the 'invalid' branch that was incompletely
// converted). Extracted for the same "no supabaseServer-mocking
// convention" reason as usage-source-readiness.test.ts.
describe('classifyCurrencyProblem', () => {
  it('is always blocked and non-retryable, tagged [currency_mismatch]', () => {
    const outcome = classifyCurrencyProblem("input 'paid_invoice_value' was recorded in USD, expected SEK")
    expect(outcome).toEqual({
      blocked: true, retryable: false,
      reason: "[currency_mismatch] input 'paid_invoice_value' was recorded in USD, expected SEK",
    })
  })
})

describe('classifyPerformanceShareResultStatus', () => {
  it('ready — never blocks', () => {
    expect(classifyPerformanceShareResultStatus('ready')).toEqual({ blocked: false })
  })

  it('waived — never blocks (a genuinely waived/not-applicable fee)', () => {
    expect(classifyPerformanceShareResultStatus('waived')).toEqual({ blocked: false })
  })

  it('not_ready (required manual input missing) — blocked AND retryable, tagged [performance_input]', () => {
    const outcome = classifyPerformanceShareResultStatus('not_ready', 'missing required input: paid_invoice_value')
    expect(outcome).toEqual({
      blocked: true, retryable: true,
      reason: '[performance_input] missing required input: paid_invoice_value',
    })
  })

  it('not_ready from a draft/not-final input reads identically to a missing one — both are the SAME retryable blocker, not a distinct category', () => {
    // computePerformanceShareFee/buildOperationalInputMap never distinguish
    // "draft, not yet finalized" from "nothing recorded at all" — both
    // simply fail the same `inputMap[k] != null` gate upstream (see
    // lib/operational-input-binding.ts's finalized_at requirement) and
    // arrive here as the identical 'not_ready' status — confirmed by
    // reading, not assumed. There is deliberately no separate "draft"
    // category to test differently.
    const outcome = classifyPerformanceShareResultStatus('not_ready', 'missing required input: paid_invoice_value')
    expect(outcome.blocked).toBe(true)
    if (!outcome.blocked) throw new Error('unreachable')
    expect(outcome.retryable).toBe(true)
  })

  it('invalid — blocked and NOT retryable, tagged [invalid_data] (the E9B.1 §8 correction)', () => {
    const outcome = classifyPerformanceShareResultStatus('invalid', 'derived percentage outside configured band')
    expect(outcome).toEqual({
      blocked: true, retryable: false,
      reason: '[invalid_data] derived percentage outside configured band',
    })
  })
})
