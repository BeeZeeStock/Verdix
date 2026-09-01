import { describe, it, expect } from 'vitest'
import { isHeldScheduledInvoice, describeInvoiceHold, describeInvoiceFailure, classifyInvoiceLifecycleState } from './invoice-hold-status'

describe('isHeldScheduledInvoice', () => {
  it('a genuinely held row (scheduled + Held: message) is held', () => {
    expect(isHeldScheduledInvoice({ status: 'scheduled', errorMessage: 'Held: [usage_source] connector timeout' })).toBe(true)
  })
  it('an ordinary not-yet-due scheduled row with no error_message is NOT held — the E9B.1 §5A distinction from a plain future draft', () => {
    expect(isHeldScheduledInvoice({ status: 'scheduled', errorMessage: null })).toBe(false)
  })
  it('a failed row is not "held" — PARKED and FAILED are different states (§11)', () => {
    expect(isHeldScheduledInvoice({ status: 'failed', errorMessage: 'Held: something' })).toBe(false)
  })
  it('a paid row is never held regardless of a stray error_message', () => {
    expect(isHeldScheduledInvoice({ status: 'paid', errorMessage: 'Held: something' })).toBe(false)
  })
})

describe('describeInvoiceHold', () => {
  it('not held — held:false, empty reasons', () => {
    expect(describeInvoiceHold({ status: 'scheduled', errorMessage: null })).toEqual({ held: false, businessReason: '', technicalReason: null })
  })

  it('[usage_source] tag maps to "Usage data required", strips the Held: prefix, preserves raw text as technicalReason', () => {
    const result = describeInvoiceHold({ status: 'scheduled', errorMessage: "Held: [usage_source] connector timeout; manual fallback also not ready: no finalized value on record" })
    expect(result.held).toBe(true)
    expect(result.businessReason).toBe('Usage data required')
    expect(result.technicalReason).toBe('[usage_source] connector timeout; manual fallback also not ready: no finalized value on record')
    // Never leaks the raw technical text as the primary/business copy.
    expect(result.businessReason).not.toContain('connector timeout')
  })

  it('[performance_input] tag maps to "Performance input required"', () => {
    const result = describeInvoiceHold({ status: 'scheduled', errorMessage: 'Held: [performance_input] missing required input: paid_invoice_value' })
    expect(result.businessReason).toBe('Performance input required')
  })

  it('qualified_unit_aggregate provenance (the pre-existing SQM branch, untouched by E9B) maps to "Billing source temporarily unavailable"', () => {
    const result = describeInvoiceHold({
      status: 'scheduled',
      errorMessage: "Held: Cannot bill metric 'sqm' for [2026-09-01, 2026-09-30): quantity source (qualified_unit_aggregate) is not ready — pending confirmation",
    })
    expect(result.businessReason).toBe('Billing source temporarily unavailable')
  })

  it('an untagged/unrecognized reason falls back to a generic, still-honest business phrase — never a misclassification', () => {
    const result = describeInvoiceHold({ status: 'scheduled', errorMessage: 'Held: some future blocker this module has never seen' })
    expect(result.businessReason).toBe('Awaiting a required billing input')
  })
})

describe('describeInvoiceFailure', () => {
  it('not failed — failed:false', () => {
    expect(describeInvoiceFailure({ status: 'scheduled', errorMessage: null })).toEqual({ failed: false, businessReason: '', technicalReason: null })
  })

  it('[currency_mismatch] tag maps to a business-facing currency-mismatch message, raw text kept as technicalReason', () => {
    const result = describeInvoiceFailure({ status: 'failed', errorMessage: "'Performance share' currency problem for job abc123, period 2026-09-01–2026-09-30: [currency_mismatch] input 'paid_invoice_value' was recorded in USD, expected SEK" })
    expect(result.failed).toBe(true)
    expect(result.businessReason).toBe('Currency mismatch')
    expect(result.technicalReason).toContain('abc123')
    expect(result.businessReason).not.toContain('abc123')
  })

  it('[invalid_data] tag maps to a business-facing invalid-data message', () => {
    const result = describeInvoiceFailure({ status: 'failed', errorMessage: "'Performance share' invalid for job abc123, period 2026-09-01–2026-09-30: [invalid_data] derived percentage outside configured band" })
    expect(result.businessReason).toBe('Invalid billing data')
  })

  it('a status=failed row for an unrelated reason (not this module\'s concern) still gets a generic, honest fallback', () => {
    const result = describeInvoiceFailure({ status: 'failed', errorMessage: 'Stripe API returned 500' })
    expect(result.failed).toBe(true)
    expect(result.businessReason).toBe('Operational correction required')
  })
})

describe('classifyInvoiceLifecycleState — §11: PARKED and FAILED are never folded into one bucket', () => {
  it('held row -> parked', () => {
    expect(classifyInvoiceLifecycleState({ status: 'scheduled', errorMessage: 'Held: something' })).toBe('parked')
  })
  it('failed row -> failed, never parked', () => {
    expect(classifyInvoiceLifecycleState({ status: 'failed', errorMessage: 'something' })).toBe('failed')
  })
  it('an ordinary paid/open/draft/not-yet-due-scheduled row -> normal', () => {
    expect(classifyInvoiceLifecycleState({ status: 'paid', errorMessage: null })).toBe('normal')
    expect(classifyInvoiceLifecycleState({ status: 'scheduled', errorMessage: null })).toBe('normal')
  })
})
