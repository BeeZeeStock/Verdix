import { describe, it, expect } from 'vitest'
import { evaluateInitializationEligibility, type InitializationEvidence } from './initial-commercial-snapshot'

// Step 17H.4B0D4H1B4E3.1 — pure eligibility-decision tests (§32-33). No
// database: gatherInitializationEvidence's I/O is exercised only by the
// opt-in real-Postgres suite (initial-commercial-snapshot-integration.test.ts),
// per this project's established RUN_RLS_INTEGRATION_TESTS convention.

const CLEAN: InitializationEvidence = {
  markerInitializedAt: null,
  anyLineItemExists: false,
  anyPlannedInvoiceExists: false,
  billingCustomerId: null,
  billingPlatform: null,
}

describe('evaluateInitializationEligibility', () => {
  it('is eligible for a genuinely first-extraction job (no evidence of any kind)', () => {
    expect(evaluateInitializationEligibility(CLEAN)).toEqual({ eligible: true })
  })

  it('refuses when the durable marker is already set, regardless of other evidence', () => {
    const result = evaluateInitializationEligibility({ ...CLEAN, markerInitializedAt: '2026-08-20T00:00:00Z' })
    expect(result).toEqual({ eligible: false, reason: 'already_initialized', initializedAt: '2026-08-20T00:00:00Z' })
  })

  it('§3/§17 — refuses solely on existing line_items evidence, even with the marker null', () => {
    const result = evaluateInitializationEligibility({ ...CLEAN, anyLineItemExists: true })
    expect(result).toEqual({ eligible: false, reason: 'ambiguous_legacy_evidence', evidenceReasons: ['existing_line_items'] })
  })

  it('refuses on existing planned_invoices evidence alone', () => {
    const result = evaluateInitializationEligibility({ ...CLEAN, anyPlannedInvoiceExists: true })
    expect(result).toEqual({ eligible: false, reason: 'ambiguous_legacy_evidence', evidenceReasons: ['existing_planned_invoices'] })
  })

  it('refuses on an existing billing_customer_id alone', () => {
    const result = evaluateInitializationEligibility({ ...CLEAN, billingCustomerId: 'cus_123' })
    expect(result).toEqual({ eligible: false, reason: 'ambiguous_legacy_evidence', evidenceReasons: ['existing_billing_customer_id'] })
  })

  it('refuses on an existing billing_platform alone', () => {
    const result = evaluateInitializationEligibility({ ...CLEAN, billingPlatform: 'stripe' })
    expect(result).toEqual({ eligible: false, reason: 'ambiguous_legacy_evidence', evidenceReasons: ['existing_billing_platform'] })
  })

  it('reports every matching evidence reason, not just the first', () => {
    const result = evaluateInitializationEligibility({
      ...CLEAN, anyLineItemExists: true, billingCustomerId: 'cus_123',
    })
    expect(result).toEqual({
      eligible: false, reason: 'ambiguous_legacy_evidence',
      evidenceReasons: ['existing_line_items', 'existing_billing_customer_id'],
    })
  })

  it('§17 — an established, configured job (marker null but every operational signal present) fails closed, never bootstraps', () => {
    const result = evaluateInitializationEligibility({
      markerInitializedAt: null,
      anyLineItemExists: true,
      anyPlannedInvoiceExists: true,
      billingCustomerId: 'cus_established',
      billingPlatform: 'stripe',
    })
    expect(result.eligible).toBe(false)
  })
})
