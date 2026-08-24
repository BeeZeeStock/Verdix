// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ParkedInvoicesCard } from './ParkedInvoicesCard'

afterEach(() => cleanup())

const EVENT_GATED_FEE = {
  id:          'planned-1',
  feeId:       '0f56a974-68de-496d-8393-3850450e31d9', // Contract B's real Integration Fee fee_id
  feeLabel:    'Integration Fee',
  currency:    'SEK',
  baseAmount:  90000,
  metricName:  null,
  ratePerUnit: null,
  description: 'One-time integration fee payable upon Customer Acceptance.',
  billabilityCondition: { kind: 'event' as const, event_type: 'customer_acceptance' as const },
  evidence:    null,
  plannedInvoiceStatus: 'parked',
}

const MANUAL_QUANTITY_FEE = {
  id:          'planned-2',
  feeId:       null,
  feeLabel:    'Professional Services',
  currency:    'EUR',
  baseAmount:  0,
  metricName:  'hours',
  ratePerUnit: 150,
  description: 'Ad hoc consulting hours.',
  billabilityCondition: null,
  evidence:    null,
  plannedInvoiceStatus: 'parked',
}

const FIXED_DATE_FEE = {
  id:          'planned-3',
  feeId:       'fee-fixed-date',
  feeLabel:    'Milestone Fee',
  currency:    'EUR',
  baseAmount:  15000,
  metricName:  null,
  ratePerUnit: null,
  description: 'Payable on a fixed contractual date.',
  billabilityCondition: { kind: 'fixed_date' as const, date: '2026-12-01' },
  evidence:    null,
  plannedInvoiceStatus: 'parked',
}

const UNEXPECTED_FIXED_FEE_NO_CONDITION = {
  id:          'planned-4',
  feeId:       null,
  feeLabel:    'Unclassified Setup Fee',
  currency:    'EUR',
  baseAmount:  5000,
  metricName:  null, // no metric — not a genuine quantity/rate fee
  ratePerUnit: null,
  description: 'A fixed fee with no billability condition and no metric.',
  billabilityCondition: null,
  evidence:    null,
  plannedInvoiceStatus: 'parked',
}

function expandRow(feeLabel: string) {
  fireEvent.click(screen.getByText(feeLabel))
}

describe('ParkedInvoicesCard — event-gated fixed one-time fee (Contract B Integration Fee shape)', () => {
  it('renders the fixed amount and the billing condition — no quantity/rate math', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expandRow('Integration Fee')
    // Fixed amount rendered directly from baseAmount — appears at least in
    // the header and the expanded "Amount" panel.
    expect(screen.getAllByText(/SEK\s*90,000/).length).toBeGreaterThan(0)
    expect(screen.getByText('Billing condition')).toBeInTheDocument()
    expect(screen.getByText('Customer acceptance')).toBeInTheDocument()
  })

  it('renders "Record acceptance" for customer_acceptance', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expandRow('Integration Fee')
    expect(screen.getByRole('button', { name: 'Record acceptance' })).toBeInTheDocument()
  })

  it('never renders the manual quantity/rate workflow copy for an event-gated fee', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expandRow('Integration Fee')
    expect(screen.queryByText(/Units? [Dd]elivered/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Rate per/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Confirm delivery.*send invoice/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Each confirmed delivery creates a separate/i)).not.toBeInTheDocument()
  })

  it('the evidence date input starts blank — never prefilled with today', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expandRow('Integration Fee')
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
    expect(dateInput).toBeTruthy()
    expect(dateInput.value).toBe('')
  })

  it('recording evidence calls only the operational-events/attest endpoint, with the stable fee_id as subjectId, and no billing/provider endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expandRow('Integration Fee')

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
    fireEvent.change(dateInput, { target: { value: '2026-09-15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record acceptance' }))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/jobs/job-1/operational-events/attest')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({ subjectId: '0f56a974-68de-496d-8393-3850450e31d9', occurredAt: '2026-09-15' })

    // No provider/billing endpoint touched as a side effect of recording evidence.
    const calledUrls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(calledUrls.some(u => String(u).includes('/parked-invoices'))).toBe(false)
    expect(calledUrls.some(u => String(u).includes('/invoice-scheduler'))).toBe(false)
    expect(calledUrls.some(u => String(u).includes('stripe'))).toBe(false)
    expect(calledUrls.some(u => String(u).includes('remembill'))).toBe(false)

    vi.unstubAllGlobals()
  })

  it('an existing recorded evidence renders the recorded state, not another blank form', () => {
    const recorded = {
      ...EVENT_GATED_FEE,
      evidence: { occurredAt: '2026-08-20T00:00:00.000Z', recordedAt: '2026-08-21T09:00:00.000Z' },
    }
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[recorded]} />)
    expandRow('Integration Fee')

    expect(screen.getAllByText('Customer acceptance recorded').length).toBeGreaterThan(0)
    expect(screen.getByText('Waiting for billing execution')).toBeInTheDocument()
    // No blank date-entry form once evidence is already recorded.
    expect(document.querySelector('input[type="date"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Record acceptance' })).not.toBeInTheDocument()
  })
})

describe('ParkedInvoicesCard — genuinely manual quantity/rate parked fee (legacy behavior preserved)', () => {
  it('still renders the quantity/rate workflow, unaffected by the event branch', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[MANUAL_QUANTITY_FEE]} />)
    expandRow('Professional Services')
    expect(screen.getByText(/Hours delivered/)).toBeInTheDocument()
    expect(screen.getByText(/Rate per hours/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm delivery & send invoice/i })).toBeInTheDocument()
    expect(screen.queryByText('Billing condition')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record acceptance' })).not.toBeInTheDocument()
  })
})

describe('ParkedInvoicesCard — mixed list', () => {
  it('branches structurally per-fee: one event-gated, one manual, in the same card', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE, MANUAL_QUANTITY_FEE]} />)
    expandRow('Integration Fee')
    expandRow('Professional Services')
    expect(screen.getByRole('button', { name: 'Record acceptance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm delivery & send invoice/i })).toBeInTheDocument()
  })
})

describe('ParkedInvoicesCard — card summary copy', () => {
  it('a single event-gated fee (Contract B shape) uses "parked fee requires action", never "service fee"/"manual confirmation"', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE]} />)
    expect(screen.getByText('1 parked fee requires action')).toBeInTheDocument()
    expect(screen.queryByText(/service fee/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/manual confirmation/i)).not.toBeInTheDocument()
  })

  it('pluralizes for more than one parked fee', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[EVENT_GATED_FEE, MANUAL_QUANTITY_FEE]} />)
    expect(screen.getByText('2 parked fees require action')).toBeInTheDocument()
  })
})

describe('ParkedInvoicesCard — hardened branch: no broad "not event" fallback to the manual workflow', () => {
  it('a fixed_date parked fee does NOT fall through to the quantity/rate workflow', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[FIXED_DATE_FEE]} />)
    expandRow('Milestone Fee')
    expect(screen.queryByText(/Units? [Dd]elivered/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Rate per/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm delivery.*send invoice/i })).not.toBeInTheDocument()
    // Also not routed to the event-gated branch (fixed_date !== event).
    expect(screen.queryByRole('button', { name: 'Record acceptance' })).not.toBeInTheDocument()
    expect(screen.queryByText('Billing condition')).not.toBeInTheDocument()
  })

  it('an unexpected fixed fee with no billability condition and no metric does NOT fall through to the quantity/rate workflow', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[UNEXPECTED_FIXED_FEE_NO_CONDITION]} />)
    expandRow('Unclassified Setup Fee')
    expect(screen.queryByText(/Units? [Dd]elivered/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Rate per/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Confirm delivery.*send invoice/i })).not.toBeInTheDocument()
  })

  it('unsupported parked configurations expose no billing action of any kind — fail closed, informational only', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[FIXED_DATE_FEE, UNEXPECTED_FIXED_FEE_NO_CONDITION]} />)
    expandRow('Milestone Fee')
    expandRow('Unclassified Setup Fee')
    // No button anywhere in the card that could trigger a send/confirm/
    // record action for either unsupported row.
    expect(screen.queryByRole('button', { name: /Confirm delivery/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Record/i })).not.toBeInTheDocument()
    expect(document.querySelector('input[type="date"]')).toBeNull()
    expect(document.querySelector('input[type="number"]')).toBeNull()
    expect(screen.getAllByText(/Verdix doesn.t recognize this fee.s billing configuration/).length).toBe(2)
  })

  it('a known manual quantity/rate fee still renders the quantity/rate workflow after hardening', () => {
    render(<ParkedInvoicesCard jobId="job-1" parkedInvoices={[MANUAL_QUANTITY_FEE]} />)
    expandRow('Professional Services')
    expect(screen.getByText(/Hours delivered/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm delivery & send invoice/i })).toBeInTheDocument()
  })
})
