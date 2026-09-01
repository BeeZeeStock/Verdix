import { describe, it, expect } from 'vitest'
import { isGenuinelyIssuedInvoice, isManualOriginInvoice, MANUAL_INVOICE_FEE_LABEL } from './invoice-history-classification'

describe('isGenuinelyIssuedInvoice — Step 17F.9, item 1', () => {
  it('paid, failed, open, and sent are genuine invoice history', () => {
    expect(isGenuinelyIssuedInvoice('paid')).toBe(true)
    expect(isGenuinelyIssuedInvoice('failed')).toBe(true)
    expect(isGenuinelyIssuedInvoice('open')).toBe(true)
    expect(isGenuinelyIssuedInvoice('sent')).toBe(true)
  })

  // The exact real risk this predicate closes: a row held by the
  // fixed-fee-timing scheduler gate (lib/fixed-fee-invoice-scheduling.ts)
  // stays status='scheduled' -> mapped to 'draft' by billing-summary's own
  // mapPlanned -- indefinitely, even once its planned date has passed.
  // Classification must never promote it into "Invoice history" just
  // because a calendar date happened to pass.
  it('draft (a held/scheduled row with no provider object) is never invoice history, regardless of how overdue its date is', () => {
    expect(isGenuinelyIssuedInvoice('draft')).toBe(false)
  })

  it('scheduled (a raw not-yet-mapped status) and other/unknown values are not invoice history', () => {
    expect(isGenuinelyIssuedInvoice('scheduled')).toBe(false)
    expect(isGenuinelyIssuedInvoice('pending')).toBe(false)
    expect(isGenuinelyIssuedInvoice(null)).toBe(false)
    expect(isGenuinelyIssuedInvoice(undefined)).toBe(false)
  })
})

describe('isManualOriginInvoice — Step 17H.2A item 18', () => {
  it('matches exactly the literal app/api/jobs/[id]/manual-invoice/route.ts writes', () => {
    expect(isManualOriginInvoice(MANUAL_INVOICE_FEE_LABEL)).toBe(true)
    expect(isManualOriginInvoice('Manual verification invoice')).toBe(true)
  })

  it('a contract-derived one-time fee with a different label is never flagged manual', () => {
    expect(isManualOriginInvoice('Integration Fee')).toBe(false)
    expect(isManualOriginInvoice('Onboarding')).toBe(false)
  })

  it('null/undefined feeLabel is never flagged manual', () => {
    expect(isManualOriginInvoice(null)).toBe(false)
    expect(isManualOriginInvoice(undefined)).toBe(false)
  })
})
