import { describe, it, expect } from 'vitest'
import { classifyRequeueEligibility } from './invoice-requeue-eligibility'

describe('classifyRequeueEligibility', () => {
  it('an eligible failed period invoice on Stripe is eligible', () => {
    expect(classifyRequeueEligibility({ status: 'failed', invoiceType: 'period', billingPlatform: 'stripe', vendorInvoiceId: null })).toEqual({ eligible: true })
  })

  it('an eligible failed period invoice on Stripe, even with a vendor reference already set, is eligible — Stripe idempotency covers it', () => {
    expect(classifyRequeueEligibility({ status: 'failed', invoiceType: 'period', billingPlatform: 'stripe', vendorInvoiceId: 'in_123' })).toEqual({ eligible: true })
  })

  it('a non-failed invoice (scheduled/paid/open/sent) is never eligible', () => {
    for (const status of ['scheduled', 'paid', 'open', 'sent', 'processing']) {
      const result = classifyRequeueEligibility({ status, invoiceType: 'period', billingPlatform: 'stripe', vendorInvoiceId: null })
      expect(result.eligible).toBe(false)
    }
  })

  it('a one_time invoice is never eligible — routes to the existing parked/event mechanism instead', () => {
    const result = classifyRequeueEligibility({ status: 'failed', invoiceType: 'one_time', billingPlatform: 'stripe', vendorInvoiceId: null })
    expect(result.eligible).toBe(false)
    if (result.eligible) throw new Error('unreachable')
    expect(result.reason).toContain('parked-invoice')
  })

  it('a Remembill invoice with NO vendor reference yet is eligible', () => {
    expect(classifyRequeueEligibility({ status: 'failed', invoiceType: 'period', billingPlatform: 'remembill', vendorInvoiceId: null })).toEqual({ eligible: true })
  })

  it('a Remembill invoice WITH a vendor reference already set is NOT eligible — ambiguous state, matches the scheduler\'s own existing guard', () => {
    const result = classifyRequeueEligibility({ status: 'failed', invoiceType: 'period', billingPlatform: 'remembill', vendorInvoiceId: 'rb_456' })
    expect(result.eligible).toBe(false)
    if (result.eligible) throw new Error('unreachable')
    expect(result.reason).toContain('rb_456')
    expect(result.reason).toContain('manual reconciliation')
  })

  it('a terminal_settlement invoice follows the same rules as an ordinary period invoice', () => {
    expect(classifyRequeueEligibility({ status: 'failed', invoiceType: 'terminal_settlement', billingPlatform: 'stripe', vendorInvoiceId: null })).toEqual({ eligible: true })
  })

  it('null billingPlatform defaults to stripe rules (matches invoice-scheduler/route.ts\'s own `?? \'stripe\'` default)', () => {
    expect(classifyRequeueEligibility({ status: 'failed', invoiceType: 'period', billingPlatform: null, vendorInvoiceId: 'in_123' })).toEqual({ eligible: true })
  })
})
