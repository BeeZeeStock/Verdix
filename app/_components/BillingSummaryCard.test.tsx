// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { BillingSummaryCard } from './BillingSummaryCard'

// Fixtures throughout this file fix their period dates to August 2026 and
// rely on deriveMeasurementPhase's real-clock default (lib/billing-period-
// card-summary.ts) reading that period as still open ("measuring") — true
// only while the real system date is inside it. Pinning "now" to a fixed
// point safely inside every such fixture's window (and safely before the
// few tests that deliberately use a FUTURE period to exercise "not
// started") keeps this file's outcomes independent of the day it happens
// to run, rather than silently flaking once the calendar turns the page.
// toFake: ['Date'] only — setTimeout/setInterval stay real so
// @testing-library's own waitFor polling keeps working (faking every timer
// would freeze it, since fake timers never auto-advance on their own).
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z')) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const BASE_SUBSCRIPTION = {
  id: 'cust-1', status: 'active', interval: 'month', intervalCount: 1,
  currentPeriodStart: '2026-08-01', currentPeriodEnd: '2026-08-31',
  cancelAtPeriodEnd: false, isTest: false, dashboardUrl: 'https://example.invalid/dash',
}

const EVENT_GATED_AWAITING = {
  id: 'planned-1', feeId: 'fee-1', feeLabel: 'Integration Fee', currency: 'SEK', baseAmount: 90000,
  metricName: null, ratePerUnit: null, description: 'Payable on customer acceptance.',
  billabilityCondition: { kind: 'event' as const, event_type: 'customer_acceptance' as const },
  evidence: null, plannedInvoiceStatus: 'parked',
}

const EVENT_GATED_EVIDENCE_RECORDED = {
  id: 'planned-2', feeId: 'fee-2', feeLabel: 'Delivery Fee', currency: 'SEK', baseAmount: 40000,
  metricName: null, ratePerUnit: null, description: 'Payable on delivery.',
  billabilityCondition: { kind: 'event' as const, event_type: 'delivery' as const },
  evidence: { occurredAt: '2026-08-20T00:00:00.000Z', recordedAt: '2026-08-21T09:00:00.000Z' },
  plannedInvoiceStatus: 'parked',
}

const MANUAL_TEMPLATE = {
  id: 'planned-3', feeId: null, feeLabel: 'Professional Services', currency: 'EUR', baseAmount: 0,
  metricName: 'hours', ratePerUnit: 150, description: 'Ad hoc consulting hours.',
  billabilityCondition: null, evidence: null, plannedInvoiceStatus: 'parked',
}

const UNSUPPORTED = {
  id: 'planned-4', feeId: null, feeLabel: 'Unclassified Setup Fee', currency: 'EUR', baseAmount: 5000,
  metricName: null, ratePerUnit: null, description: null,
  billabilityCondition: null, evidence: null, plannedInvoiceStatus: 'parked',
}

function mockSummary(overrides: Record<string, unknown> = {}, opts: {
  consumptionPeriods?: unknown[]
  performanceShareFees?: unknown[]
  // Step 17H.2B.2 — /measurement-summary is the pricing-free route Refresh
  // now calls instead of /consumption-summary. Defaults to no periods (a
  // no-op merge) so existing mount-time-only tests are unaffected; tests
  // that specifically exercise Refresh's measurement merge pass this.
  measurementPeriods?: unknown[]
  // Step 17H.4B0D4H1B4E2.3 — the new cross-period "Rolling-band evaluation"
  // section's own GET /rolling-band-transitions fetch. Defaults to empty
  // (no evaluations/transitions) so existing tests that don't opt in are
  // unaffected.
  rollingBandEvaluations?: unknown[]
  rollingBandTransitions?: unknown[]
} = {}) {
  const summary = {
    subscription: BASE_SUBSCRIPTION,
    invoices: [], annualDraftInvoices: [], oneTimeInvoices: [],
    commercialRuleEvents: [], parkedInvoices: [],
    paymentSchedule: null, oneTimeFees: [], contractStart: null,
    currency: 'SEK', paymentTermsDays: null, computedInvoices: [],
    billingPlatform: 'remembill', hasOverageTerms: false, overageMeterTypes: [],
    fixedFeeBillingTiming: null,
    ...overrides,
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/vat-config')) {
      return { ok: true, json: async () => ({ treatment: { mode: 'not_configured', ratePct: null } }) }
    }
    if (u.includes('/measurement-summary')) {
      return { ok: true, json: async () => ({ periods: opts.measurementPeriods ?? [] }) }
    }
    if (u.includes('/consumption-summary')) {
      return { ok: true, json: async () => ({ periods: opts.consumptionPeriods ?? [] }) }
    }
    if (u.includes('/performance-share')) {
      return { ok: true, json: async () => ({ fees: opts.performanceShareFees ?? [] }) }
    }
    if (u.includes('/rolling-band-transitions')) {
      return { ok: true, json: async () => ({ evaluations: opts.rollingBandEvaluations ?? [], transitions: opts.rollingBandTransitions ?? [] }) }
    }
    return { ok: true, json: async () => summary }
  }) as unknown as typeof fetch)
}

describe('BillingSummaryCard — parked-invoice timeline ingestion (Step 17H.2A items 7-14)', () => {
  it('renders a "Parked · conditional" grouping distinct from Invoice history / Planned schedule', async () => {
    mockSummary({ parkedInvoices: [EVENT_GATED_AWAITING] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Parked · conditional')).toBeInTheDocument())
    expect(screen.getByText('Integration Fee')).toBeInTheDocument()
  })

  it('an event-gated fee with no evidence shows "Awaiting condition" and the waiting label — never a fabricated date', async () => {
    mockSummary({ parkedInvoices: [EVENT_GATED_AWAITING] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Integration Fee')).toBeInTheDocument())
    expect(screen.getByText('Awaiting condition')).toBeInTheDocument()
    expect(screen.getByText('Waiting for customer acceptance')).toBeInTheDocument()
    expect(screen.queryByText(/Pending decision/)).not.toBeInTheDocument()
  })

  it('an event-gated fee with evidence recorded shows "Evidence recorded" and names the real stored event type, not a generic placeholder', async () => {
    mockSummary({ parkedInvoices: [EVENT_GATED_EVIDENCE_RECORDED] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Delivery Fee')).toBeInTheDocument())
    expect(screen.getByText('Evidence recorded')).toBeInTheDocument()
    expect(screen.getByText('Delivery recorded · awaiting billing execution')).toBeInTheDocument()
    // Never implies the invoice has already been sent.
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument()
  })

  it('expanding an evidence-recorded entry shows the real occurred date, sourced from the actual evidence row', async () => {
    mockSummary({ parkedInvoices: [EVENT_GATED_EVIDENCE_RECORDED] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Delivery Fee')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Delivery Fee'))
    expect(screen.getByText(/Delivery recorded on/)).toBeInTheDocument()
    expect(screen.getByText(/20 Aug 2026/)).toBeInTheDocument()
  })

  it('a manual quantity/rate template renders as a reusable template, never as an already-due invoice — shows rate/unit, not a fabricated total', async () => {
    mockSummary({ parkedInvoices: [MANUAL_TEMPLATE] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Professional Services')).toBeInTheDocument())
    expect(screen.getByText('Reusable template')).toBeInTheDocument()
    expect(screen.getByText(/Reusable delivery template/)).toBeInTheDocument()
    expect(screen.getByText(/150.*hours|hours.*150/)).toBeInTheDocument()
  })

  it('an unrecognized parked shape fails closed — informational only, distinct status', async () => {
    mockSummary({ parkedInvoices: [UNSUPPORTED] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Unclassified Setup Fee')).toBeInTheDocument())
    expect(screen.getByText('Unrecognized')).toBeInTheDocument()
  })

  it('mixed list: each parked fee classified independently by its own structural shape, all under the same grouping', async () => {
    mockSummary({ parkedInvoices: [EVENT_GATED_AWAITING, EVENT_GATED_EVIDENCE_RECORDED, MANUAL_TEMPLATE, UNSUPPORTED] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getAllByText('Parked · conditional')).toHaveLength(1))
    expect(screen.getByText('Awaiting condition')).toBeInTheDocument()
    expect(screen.getByText('Evidence recorded')).toBeInTheDocument()
    expect(screen.getByText('Reusable template')).toBeInTheDocument()
    expect(screen.getByText('Unrecognized')).toBeInTheDocument()
  })

  it('no parked invoices at all -> no "Parked · conditional" section rendered', async () => {
    mockSummary({
      parkedInvoices: [],
      invoices: [{ id: 'inv-1', number: null, status: 'sent', amount: 1000, currency: 'SEK', dueDate: null, created: '2026-08-01T00:00:00.000Z', periodEnd: '2026-08-31', pdfUrl: null, hostedUrl: null, feeLabel: null, yearNum: 1, scheduledDate: '2026-08-01', baseAmount: 1000, overageLineItems: [], overageTotal: 0 }],
    })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Invoice history')).toBeInTheDocument())
    expect(screen.queryByText('Parked · conditional')).not.toBeInTheDocument()
  })
})

describe('BillingSummaryCard — Manual Invoice origin badge (Step 17H.2A item 18)', () => {
  it('a one-time invoice created via Manual Invoice (the exact persisted fee_label) shows a "Manual" badge', async () => {
    mockSummary({
      oneTimeInvoices: [{
        id: 'inv-manual', number: null, status: 'sent', amount: 500, currency: 'EUR', dueDate: null,
        created: '2026-08-25T00:00:00.000Z', periodEnd: '2026-08-25', pdfUrl: null, hostedUrl: null,
        feeLabel: 'Manual verification invoice', yearNum: null, scheduledDate: '2026-08-25',
        baseAmount: 500, overageLineItems: [], overageTotal: 0,
      }],
    })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Manual verification invoice')).toBeInTheDocument())
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })

  it('a genuine contract-derived one-time fee never shows the "Manual" badge', async () => {
    mockSummary({
      oneTimeInvoices: [{
        id: 'inv-contract', number: null, status: 'sent', amount: 900, currency: 'EUR', dueDate: null,
        created: '2026-08-25T00:00:00.000Z', periodEnd: '2026-08-25', pdfUrl: null, hostedUrl: null,
        feeLabel: 'Onboarding Fee', yearNum: null, scheduledDate: '2026-08-25',
        baseAmount: 900, overageLineItems: [], overageTotal: 0,
      }],
    })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Onboarding Fee')).toBeInTheDocument())
    expect(screen.queryByText('Manual')).not.toBeInTheDocument()
  })
})

// Step 17H.2B — enriched recurring-period timeline entries.
const PERIOD_TERMS = {
  contract_start_date: '2026-08-01', currency: 'SEK', base_monthly_fee: 5000,
  discounts: [], escalators: [],
  overage_tiers: [{ tier_label: 'API calls', unit_type: 'api_calls', rate_per_unit: 0.1, semantic_input_key: 'api_calls' }],
  fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false },
}
const PERIOD_USAGE_SOURCE_CARDS = [
  { key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'Metering API', sourceType: 'api_meter' as const, status: 'confirmed' as const, consumers: [] },
]
const PERIOD_INVOICE = {
  id: 'inv-period-1', number: null, status: 'draft', amount: 5000, currency: 'SEK', dueDate: null,
  created: '2026-08-01T00:00:00.000Z', periodEnd: '2026-08-31', pdfUrl: null, hostedUrl: null,
  feeLabel: null, yearNum: 1, scheduledDate: '2026-08-01',
  baseAmount: 5000, overageLineItems: [], overageTotal: 0,
}

describe('BillingSummaryCard — enriched recurring-period entries (Step 17H.2B)', () => {
  it('a genuine period entry, expanded, shows the Period execution section with fixed/usage joined from the shared model', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    // Step E8.2 §2/§3 — calculation basis & sources is collapsed by
    // default; expanding it now shows the compact COMPONENT/BASIS/SOURCE/
    // STATE table, not the old "Consumption / usage" narrative block.
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.queryByText('Consumption / usage')).not.toBeInTheDocument()
    // Step 17H.4B0D4H1B4E8 §19 — a still-open ('live_not_final') usage
    // component legitimately appears twice now: once in the calculation-
    // basis detail (how it's measured), once in the Deferred-to-next-
    // invoice section (where the resulting charge will land).
    expect(screen.getAllByText('API calls').length).toBeGreaterThan(0)
    // Step E8.2 §5 — an OPEN ('current') window is a "Measuring" state
    // (agreeing with the tile's own aggregate wording), quantity shown as
    // secondary detail — never a rate multiplication/monetary amount
    // (that would present a live observation as though it were a
    // calculated charge), and never the old "Live · not finalized" prose.
    expect(screen.getByText('Measuring')).toBeInTheDocument()
    expect(screen.getByText('500 to date')).toBeInTheDocument()
    expect(screen.queryByText(/Live · not finalized/)).not.toBeInTheDocument()
    expect(screen.queryByText(/×/)).not.toBeInTheDocument()
    // Step 17H.4B0D4H1B4E8 §19-21 — a live/not-yet-final usage component
    // is genuinely deferred (only its calculation basis is known this
    // period, not the resulting charge); with only one period entry on
    // this timeline, there is no real next invoice to name, so no
    // destination badge renders in the section heading.
    // Step 17H.4B0D4H1B4E8.1 §9/§10 — the row itself states only its own
    // timing, never a repeated "→ destination" arrow (that lives in the
    // section heading alone, when a real destination is known).
    expect(screen.getByText('Deferred to next invoice')).toBeInTheDocument()
    expect(screen.getByText('Calculated after period close')).toBeInTheDocument()
    // Step 17H.4B0D4H1B4E8 §16 — Invoice Projection must never carry a
    // usage/overage pseudo-line for an amount that isn't measured yet.
    expect(screen.queryByText('Will be calculated at the end of the billing cycle')).not.toBeInTheDocument()
  })

  it('Step 17H.4B0D4H1B4E8.1 §2-4 — the period header amount is explicitly labeled: it is the SAME value the Invoice Projection table\'s own Net row shows, never an ambiguous standalone figure', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    // A draft/upcoming entry — not yet real, so "projected".
    expect(screen.getByText('Net projected')).toBeInTheDocument()
  })

  it('Step 17H.4B0D4H1B4E8.1 §15-17 — the Invoice Projection line names the commercial charge, not just the bare period label', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText(/Platform fee · Aug 2026/)).toBeInTheDocument())
    expect(screen.queryByText('Aug 2026', { selector: 'td' })).not.toBeInTheDocument()
  })

  it('without terms/usageSourceCards props, no Period execution section renders — graceful degradation, no crash', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    expect(screen.queryByText('See calculation basis & sources')).not.toBeInTheDocument()
  })

  it('a one-time entry never receives the period-execution section, even with terms/usageSourceCards present (item 4: no fake periods for event-driven invoices)', async () => {
    mockSummary({
      oneTimeInvoices: [{
        id: 'inv-onetime', number: null, status: 'sent', amount: 900, currency: 'SEK', dueDate: null,
        created: '2026-08-25T00:00:00.000Z', periodEnd: '2026-08-25', pdfUrl: null, hostedUrl: null,
        feeLabel: 'Onboarding Fee', yearNum: null, scheduledDate: '2026-08-25',
        baseAmount: 900, overageLineItems: [], overageTotal: 0,
      }],
    })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Onboarding Fee')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Onboarding Fee'))
    expect(screen.queryByText('See calculation basis & sources')).not.toBeInTheDocument()
  })

  it('a fully computed period (no unresolved dependencies) shows readiness "Ready to invoice" and a real Final total, matching PERIOD_READINESS_LABEL wording', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      // status: 'pending' — closed but not yet invoiced, a genuine
      // authoritative measurement (Step 17H.2B.2: only a closed window can
      // ever produce a real Final total).
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('Ready to invoice')).toBeInTheDocument())
    // Step E8.2 §3/§6 — the numeric fixed/variable/performance breakdown
    // lives inside the collapsed calculation-basis detail table now; the
    // old bottom "Known fixed / Variable charges / Performance / Invoice
    // total" summary block is gone entirely (the tiles are the one
    // authoritative category summary).
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // "Known fixed" is now the category tile's own headline label only —
    // the detail table's STATE column says "Known" for a resolved, non-
    // waived fixed fee, a different (non-duplicating) word.
    expect(screen.getByText('Known fixed')).toBeInTheDocument()
    expect(screen.getByText('Known')).toBeInTheDocument()
    expect(screen.queryByText('Variable charges')).not.toBeInTheDocument()
    expect(screen.queryByText('Invoice total')).not.toBeInTheDocument()
    expect(screen.queryByText('Known amount')).not.toBeInTheDocument()
    expect(screen.queryByText('Final total')).not.toBeInTheDocument()
    expect(screen.queryByText('TBD')).not.toBeInTheDocument()
    // A closed ('pending') consumption period produces a genuinely
    // computed usage component — the table's STATE column says "Final",
    // matching the tile's own aggregate wording, with the real measured
    // amount as secondary detail. No combined fixed+usage total renders
    // anywhere now that the bottom summary is removed.
    expect(screen.getByText('Final')).toBeInTheDocument()
    expect(screen.getByText(/SEK\s*50\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/SEK\s*5,050\.00/)).not.toBeInTheDocument()
    // Step 17H.4B0D4H1B4E8 §21 — every component is already computed/
    // final this period; nothing is deferred, so the section is omitted
    // entirely rather than rendering an empty "Deferred to next invoice / None".
    expect(screen.queryByText('Deferred to next invoice')).not.toBeInTheDocument()
  })

  it('an unconfigured usage source shows "No confirmed usage source" and readiness "Parked" — never a fabricated amount', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={[]} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getAllByText('Parked').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Step E8.2 §5 — one shared state vocabulary drives both the tile and
    // the detail table; an unconfigured source reads "Awaiting source" in
    // both places now, not a standalone prose sentence.
    expect(screen.getAllByText('Awaiting source').length).toBeGreaterThan(0)
  })
})

// Step E8.2 — disclosure cleanup: legacy Period Execution presentation
// replaced by one compact table; state consistency; deferred-performance
// wording matches actual (traced) destination semantics.
describe('BillingSummaryCard — calculation-basis disclosure cleanup (Step E8.2)', () => {
  it('§11 — the disclosure stays collapsed by default, even for a period with real execution detail to show', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    // Not yet expanded — the table itself must not be in the document.
    expect(screen.queryByText('Component')).not.toBeInTheDocument()
    expect(screen.queryByText('Basis')).not.toBeInTheDocument()
  })

  it('§3 — the expanded detail table\'s own column headers are exactly Component/Basis/Source/State', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('Component')).toBeInTheDocument()
    expect(screen.getByText('Basis')).toBeInTheDocument()
    expect(screen.getByText('Source')).toBeInTheDocument()
    expect(screen.getByText('State')).toBeInTheDocument()
  })

  it('§1/§4/§5 — a raw, test-shaped source key never appears as the row\'s PRIMARY text; the contract measure/business metric leads, with the raw configured identity still available as muted secondary detail (never hidden)', async () => {
    const rawKeyCards = [{ key: 'api_calls', contractUnitType: 'api_calls', semanticInputKey: 'api_calls', label: 'API calls', sourceName: 'e36_test_issued_payment_request_count_60', sourceType: 'api_meter' as const, status: 'confirmed' as const, consumers: [] }]
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={rawKeyCards as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // The contract measure (humanized semantic key) is the PRIMARY line —
    // never the raw configured meter identity.
    expect(screen.getByText('Api calls')).toBeInTheDocument()
    // The raw configured identity is still there, verbatim, as muted
    // secondary technical detail — never suppressed (§1: don't hide a
    // source mismatch).
    expect(screen.getByText('e36_test_issued_payment_request_count_60')).toBeInTheDocument()
    expect(screen.getByText('API METER')).toBeInTheDocument()
  })

  it('§6 — the Usage tile and the detail table row agree on state ("Awaiting source" in both, never a tile/table contradiction)', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={[]} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    // The tile (visible even before expanding) already reads "Awaiting source".
    expect(screen.getAllByText('Awaiting source').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Once expanded, the table row uses the identical word — never "Pending decision"/"No confirmed usage source"/any other phrasing.
    expect(screen.getAllByText('Awaiting source').length).toBeGreaterThanOrEqual(2)
  })

  it('§8 — usage-only deferred: the sentence promises a firm destination, since a usage measurement WILL close regardless of anything else', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE, { ...PERIOD_INVOICE, id: 'inv-period-2', scheduledDate: '2026-09-01', periodEnd: '2026-09-30', created: '2026-09-01T00:00:00.000Z' }] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText(/Usage from this window will bill on the/)).toBeInTheDocument())
    expect(screen.queryByText(/isn.t fixed yet/)).not.toBeInTheDocument()
  })

  it('§8 — a performance component blocked on operational inputs is never promised a firm destination — its own state reads "Awaiting input", never a guaranteed "will bill" claim', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'not_ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', missingKeys: ['successful_payments_value'] }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    // Never claims performance "will bill" on a specific invoice.
    expect(screen.queryByText(/performance.*will bill/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getAllByText('Awaiting input').length).toBeGreaterThan(0)
  })
})

// Step E8.3 — final Timeline polish: business-vs-technical source
// hierarchy, contract-source empty-value fix, and the actionable
// Performance -> Billing Operations navigation CTA.
describe('BillingSummaryCard — Timeline final polish (Step E8.3)', () => {
  // Step E8.3.1 §2/§9 (supersedes the earlier E8.3 version of this test —
  // a RESOLVED fixed_fee_billing_timing can only ever become resolved via
  // an explicit reviewer decision, so it is REVIEWER CONFIRMED provenance,
  // never presented as though a nearby contract clause established it).
  it('§2/§9 — a genuinely UNRESOLVED fixed fee with a compact clause reference shows CONTRACT CLAUSE with the reference itself', async () => {
    const termsUnresolvedCompact = { ...PERIOD_TERMS, fixed_fee_billing_timing: { timing: 'unclear' as const, requires_confirmation: true, source_clause: 'Main agreement §4.1' } }
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={termsUnresolvedCompact as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('CONTRACT CLAUSE')).toBeInTheDocument()
    expect(screen.getByText('Main agreement §4.1')).toBeInTheDocument()
  })

  it('§2/§9 — a genuinely UNRESOLVED fixed fee with no clause reference falls back to a truthful "CONTRACT / Contract source" label, never a fabricated clause', async () => {
    const termsUnresolvedNoClause = { ...PERIOD_TERMS, fixed_fee_billing_timing: { timing: 'unclear' as const, requires_confirmation: true } }
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={termsUnresolvedNoClause as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('CONTRACT')).toBeInTheDocument()
    expect(screen.getByText('Contract source')).toBeInTheDocument()
    expect(screen.queryByText(/^§/)).not.toBeInTheDocument()
  })

  it('§1/§2 — a RESOLVED fixed fee reads REVIEWER CONFIRMED, not a nearby contract clause that discusses something else — the reported bug', async () => {
    // The exact reported shape: Basis says "period start" while the only
    // available clause text discusses arrears — a genuine mismatch that
    // must never be presented as if the clause established the timing.
    const termsResolvedMisleadingClause = {
      ...PERIOD_TERMS,
      fixed_fee_billing_timing: {
        timing: 'bill_at_period_start' as const, requires_confirmation: false,
        source_clause: 'Fees for the Services are invoiced in arrears within thirty (30) days following the end of each calendar month, unless otherwise agreed in writing by both parties.',
      },
    }
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={termsResolvedMisleadingClause as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('Invoiced in advance, at period start')).toBeInTheDocument()
    expect(screen.getByText('REVIEWER CONFIRMED')).toBeInTheDocument()
    expect(screen.getByText('Confirmed configuration')).toBeInTheDocument()
    // The misleading arrears sentence never appears as primary SOURCE text.
    expect(screen.queryByText(/arrears/)).not.toBeInTheDocument()
    // ...but it remains accessible as clearly-separate contract context.
    expect(screen.getByText('Contract context:')).toBeInTheDocument()
  })

  it('§1/§2 — a RESOLVED fixed fee with no clause at all reads REVIEWER CONFIRMED with no dangling "Contract context" line', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('REVIEWER CONFIRMED')).toBeInTheDocument()
    expect(screen.getByText('Confirmed configuration')).toBeInTheDocument()
    expect(screen.queryByText('Contract context:')).not.toBeInTheDocument()
  })

  it('§4/§5 — Performance CTA is ABSENT while the state is genuinely "Not started"', async () => {
    const futureInvoice = { ...PERIOD_INVOICE, id: 'inv-future', scheduledDate: '2026-12-01', periodEnd: '2026-12-31', created: '2026-12-01T00:00:00.000Z' }
    mockSummary({ invoices: [futureInvoice] }, { performanceShareFees: [] })
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Dec 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Dec 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getAllByText('Not started').length).toBeGreaterThan(0)
    expect(screen.queryByText('Enter performance inputs →')).not.toBeInTheDocument()
  })

  it('§4/§5/§7 — Performance CTA is PRESENT, visible without hovering, and keyboard/touch accessible, when the state is genuinely "Awaiting input"', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'not_ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', missingKeys: ['successful_payments_value'] }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} onNavigateToOperationalInputs={() => {}} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    const cta = screen.getByText('Enter performance inputs →')
    // A real <button> — keyboard/touch accessible and visible without
    // hover by construction, matching SourceClauseLink's own CTA styling.
    expect(cta.tagName).toBe('BUTTON')
    expect(cta).toBeVisible()
  })

  it('§4/§6 — clicking the CTA calls the caller-provided navigation callback (the same plumbing shape as MeterMappingPanel\'s onNavigateToOperationalInputs) — never an invented second persistence path', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'not_ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', missingKeys: ['successful_payments_value'] }] },
    )
    const onNavigate = vi.fn()
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} onNavigateToOperationalInputs={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    fireEvent.click(screen.getByText('Enter performance inputs →'))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('§5 — Timeline never renders manual entry controls (date/value inputs, Save draft, Mark final) even for a genuinely blocked performance fee', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'not_ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', missingKeys: ['successful_payments_value'] }] },
    )
    const { container } = render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.queryByText('Save draft')).not.toBeInTheDocument()
    expect(screen.queryByText('Mark final')).not.toBeInTheDocument()
    expect(container.querySelectorAll('input').length).toBe(0)
  })

  it('§8 — Invoice Projection and the Deferred section are unaffected by the source-hierarchy/CTA changes', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50 }], overageTotal: 50 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText(/Platform fee · Aug 2026/)).toBeInTheDocument())
    expect(screen.getByText('Deferred to next invoice')).toBeInTheDocument()
  })
})

// Step 17H.2B.1 — Refresh semantics: measurement-preview only, never a
// billing calculation/finalization.
describe('BillingSummaryCard — Refresh refreshes live measurement, never finalizes it (Step 17H.2B.1)', () => {
  it('an active period with a live meter source shows "Consumption to date" as Live · not finalized — never presented as a final charge', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 3426, amount: 342.6, metric_source: 'meter_pull' }], overageTotal: 342.6 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Step E8.2 §5 — an open window reads "Measuring" (the same shared
    // state vocabulary the tile itself uses), with the raw reading shown
    // as secondary "N to date" detail — never a standalone "Live · not
    // finalized" prose sentence, and never a computed monetary charge.
    await waitFor(() => expect(screen.getByText('Measuring')).toBeInTheDocument())
    expect(screen.getByText('3,426 to date')).toBeInTheDocument()
    expect(screen.queryByText(/Live · not finalized/)).not.toBeInTheDocument()
    expect(screen.queryByText('Final measured quantity')).not.toBeInTheDocument()
    // Never presents the live observation as a calculated monetary charge.
    expect(screen.queryByText(/×/)).not.toBeInTheDocument()
  })

  it('a closed period with the same shape shows "Final measured quantity", never "Live"', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'pending', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 3426, amount: 342.6, metric_source: 'meter_pull' }], overageTotal: 342.6 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Step E8.2 §5 — a closed, genuinely computed reading reads "Final",
    // agreeing with the tile's own wording; never "Live" once closed.
    await waitFor(() => expect(screen.getByText('Final')).toBeInTheDocument())
    expect(screen.queryByText(/Live · not finalized/)).not.toBeInTheDocument()
    expect(screen.queryByText('Measuring')).not.toBeInTheDocument()
  })

  it('a manual source with an active-period reading is distinguished from a meter by its SOURCE badge, not a dedicated state phrase', async () => {
    const manualTerms = { ...PERIOD_TERMS, overage_tiers: [{ tier_label: 'Seats', unit_type: 'seats', rate_per_unit: 20, semantic_input_key: 'seats' }] }
    const manualSourceCards = [{ key: 'seats', contractUnitType: 'seats', semanticInputKey: 'seats', label: 'Seats', sourceName: 'Manual entry', sourceType: 'manual', status: 'confirmed', consumers: [] }]
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      { consumptionPeriods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'seats', rate_per_unit: 20, total_units: 12, amount: 240, metric_source: 'manual_entry' }], overageTotal: 240 }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={manualTerms as never} usageSourceCards={manualSourceCards as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Step E8.2 §4/§5 — the SOURCE column is where manual-vs-meter is
    // conveyed now ("MANUAL INPUT" · "Manual entry"), never a raw key as
    // primary text; the STATE column uses the same shared vocabulary as
    // any other in-progress reading ("Measuring" · "12 to date").
    expect(screen.getByText('MANUAL INPUT')).toBeInTheDocument()
    expect(screen.getByText('Manual entry')).toBeInTheDocument()
    expect(screen.getByText('Measuring')).toBeInTheDocument()
    expect(screen.getByText('12 to date')).toBeInTheDocument()
  })

  it('a manual source with no recorded value yet is still identified as manual via its SOURCE badge', async () => {
    const manualTerms = { ...PERIOD_TERMS, overage_tiers: [{ tier_label: 'Seats', unit_type: 'seats', rate_per_unit: 20, semantic_input_key: 'seats' }] }
    const manualSourceCards = [{ key: 'seats', contractUnitType: 'seats', semanticInputKey: 'seats', label: 'Seats', sourceName: 'Manual entry', sourceType: 'manual', status: 'confirmed', consumers: [] }]
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={manualTerms as never} usageSourceCards={manualSourceCards as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    expect(screen.getByText('MANUAL INPUT')).toBeInTheDocument()
    expect(screen.getByText('Manual entry')).toBeInTheDocument()
  })

  it('clicking Refresh re-fetches measurement-summary (pricing-free) and performance-share, not just billing-summary — and never consumption-summary again', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] }, { consumptionPeriods: [] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore))

    const urlsAfterRefresh = fetchMock.mock.calls.slice(callsBefore).map((c: unknown[]) => String(c[0]))
    // Step 17H.2B.2 items 2-5 — Refresh must reach the pricing-free
    // measurement-only route, never the pricing-performing consumption-
    // summary route (which the initial mount load alone still uses).
    expect(urlsAfterRefresh.some(u => u.includes('/measurement-summary'))).toBe(true)
    expect(urlsAfterRefresh.some(u => u.includes('/consumption-summary'))).toBe(false)
    expect(urlsAfterRefresh.some(u => u.includes('/performance-share'))).toBe(true)
    expect(urlsAfterRefresh.some(u => u.includes('/billing-summary'))).toBe(true)
  })

  it('Refresh never calls the invoice writer/scheduler/finalize endpoints — only the existing read-only GETs', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(2))

    const allCalls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    const allUrls = allCalls.map((c: unknown[]) => String(c[0]))
    expect(allUrls.some(u => u.includes('invoice-scheduler'))).toBe(false)
    expect(allUrls.some(u => u.includes('rebuild-schedule'))).toBe(false)
    expect(allUrls.some(u => u.includes('/execute'))).toBe(false)
    // Every call made is a GET (no method specified defaults to GET; none pass method: 'POST').
    for (const call of allCalls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.method ?? 'GET').toBe('GET')
    }
  })

  it('a failed measurement refresh keeps the last known values and shows a failure notice — never zeroes or finalizes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/vat-config')) return { ok: true, json: async () => ({ treatment: { mode: 'not_configured', ratePct: null } }) }
      // Mount-time load only — succeeds once, giving the initial 'current'
      // period reading. Refresh never calls this route again (item 2-5),
      // so this always returning success is not what's under test here.
      if (u.includes('/consumption-summary')) {
        return { ok: true, json: async () => ({ periods: [{ periodStart: '2026-08-01', periodEnd: '2026-08-31', status: 'current', overageItems: [{ meter_key: 'api_calls', rate_per_unit: 0.1, total_units: 500, amount: 50, metric_source: 'meter_pull' }], overageTotal: 50 }] }) }
      }
      // Refresh's pricing-free route — fails on every call, so clicking
      // Refresh always hits this failure path.
      if (u.includes('/measurement-summary')) throw new Error('network down')
      if (u.includes('/performance-share')) return { ok: true, json: async () => ({ fees: [] }) }
      return {
        ok: true,
        json: async () => ({
          subscription: BASE_SUBSCRIPTION, invoices: [PERIOD_INVOICE], annualDraftInvoices: [], oneTimeInvoices: [],
          commercialRuleEvents: [], parkedInvoices: [], paymentSchedule: null, oneTimeFees: [], contractStart: null,
          currency: 'SEK', paymentTermsDays: null, computedInvoices: [], billingPlatform: 'remembill',
          hasOverageTerms: false, overageMeterTypes: [], fixedFeeBillingTiming: null,
        }),
      }
    }) as unknown as typeof fetch)

    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    await waitFor(() => expect(screen.getByText('500 to date')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Refresh'))
    await waitFor(() => expect(screen.getByText(/Couldn.t refresh live measurement data/)).toBeInTheDocument())
    // The last known reading is still shown, not zeroed.
    expect(screen.getByText('500 to date')).toBeInTheDocument()
  })
})

// Step 17H.2C items 17-19 — stale "Billing Periods" copy removed, provider
// wording made dynamic rather than hardcoded to exactly two options.
describe('BillingSummaryCard — copy after Billing Periods removal (Step 17H.2C)', () => {
  it('never references the removed "Billing Periods" surface anywhere in the timeline', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    expect(screen.queryByText(/Billing Periods/)).not.toBeInTheDocument()
    expect(screen.getByText(/Expand a period below for fixed\/usage\/performance execution detail/)).toBeInTheDocument()
  })

  it('the outer header\'s provider-sync subtitle names the actual configured provider dynamically, not a hardcoded Stripe/Remembill assumption', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE], billingPlatform: 'chargebee' })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    expect(screen.getByText(/Verdix coordinates billing execution with Chargebee/)).toBeInTheDocument()
  })

  it('the card keeps a generic, consolidated-role subtitle describing period execution, conditional obligations, and issued invoice history', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText(/Planned billing events, period execution, conditional obligations, and issued invoice history/)).toBeInTheDocument())
  })

  it('exactly one "Billing Timeline" heading on the page — Step 17H.4B0D4H1B4E2.4 §18: no competing Billing Setup / Billing Execution / Billing Timeline hierarchy', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Billing Timeline')).toBeInTheDocument())
    expect(screen.queryByText('Billing setup')).not.toBeInTheDocument()
    expect(screen.queryByText('Billing execution')).not.toBeInTheDocument()
    expect(screen.getAllByText(/^Billing Timeline$/i)).toHaveLength(1)
  })
})

// Step 17H.4B0D4H1B4E2.3 §19 — Performance execution now lives inside
// Billing Timeline's own per-period detail, not a separate top-level page
// section.
const PERFORMANCE_TERMS = {
  ...PERIOD_TERMS,
  additional_recurring_fees: [{
    fee_label: 'Payment success fee',
    percentage_of_basis: {
      derived_metric: { metric_key: 'success_rate', numerator_input_key: 'successful_payments_value', denominator_input_key: 'total_payments_value' },
      rate_schedule: { bands: [{ from: 0, to: null, rate_pct: 5 }] },
      basis_input_key: 'total_payments_value',
    },
  }],
}

describe('BillingSummaryCard — Performance execution inside Billing Timeline (Step 17H.4B0D4H1B4E2.3)', () => {
  it('a computed performance-share result for this exact period renders its input values, rate, and amount inside Period execution', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      {
        performanceShareFees: [{
          feeLabel: 'Payment success fee', status: 'ready', periodStart: '2026-08-01', periodEnd: '2026-08-31',
          currency: 'SEK', numeratorKey: 'successful_payments_value', numeratorValue: 9500,
          denominatorKey: 'total_payments_value', denominatorValue: 10000,
          derivedPct: 95, selectedRatePct: 5, amount: 475,
        }],
      },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    // Step E8.2 §2/§3 — the old "Performance / outcome" heading and its
    // mechanism prose are gone; the same facts live as one compact detail
    // row (component / basis / source / state) in the shared table.
    await waitFor(() => expect(screen.getByText('Payment success fee')).toBeInTheDocument())
    expect(screen.queryByText('Performance / outcome')).not.toBeInTheDocument()
    expect(screen.getByText(/Successful payments value/)).toBeInTheDocument()
    expect(screen.getByText(/Total payments value/)).toBeInTheDocument()
    expect(screen.getByText(/95\.00%.*5\.00%/)).toBeInTheDocument()
    // Step 17H.4B0D4H1B4E2.4 — the same computed amount now legitimately
    // appears twice: once as the performance fee's own line, once again
    // as the period-value "Performance" summary line below it.
    expect(screen.getAllByText(/SEK\s*475\.00/).length).toBeGreaterThanOrEqual(1)
    // Never restates the contractual definition (charge basis, rate-
    // selection rule) — that stays exclusively in Commercial Logic.
    expect(screen.queryByText('Charge basis')).not.toBeInTheDocument()
    expect(screen.queryByText('Rate selection')).not.toBeInTheDocument()
  })

  it('no evaluated performance data at all — no standalone top-level "Performance share" section anywhere on the page', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] }, { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'not_started', contractStartDate: '2026-08-01' }] })
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    expect(screen.queryByText('Performance share')).not.toBeInTheDocument()
  })
})

// Step 17H.4B0D4H1B4E2.4 §7/24 — component-specific timing: one component's
// unresolved timing decision must not be presented as though it blocked
// every component.
describe('BillingSummaryCard — component-specific invoice timing (Step 17H.4B0D4H1B4E2.4)', () => {
  it('an unresolved performance-fee timing decision shows on that fee specifically, and never overwrites the collapsed row\'s fixed-fee-only label', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE], fixedFeeBillingTiming: { timing: 'bill_at_period_start', requires_confirmation: false } },
      { performanceShareFees: [{ feeLabel: 'Payment success fee', status: 'ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', amount: 100, variableInvoiceTimingUnresolved: true }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    // Fixed timing IS resolved, so the collapsed row shows a real date, not "Decision required".
    expect(screen.queryByText('Fixed-fee invoice timing')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    await waitFor(() => expect(screen.getByText('Invoice timing: Decision required')).toBeInTheDocument())
  })

  // Step 17H.4B0D4H1B4E5.2 §7 — a reviewer-confirmed but non-executable
  // timing (invoice_at_period_end — lib/rule-interpretation.ts's
  // isVariableInvoiceTimingConfirmed) must read differently from "nothing
  // chosen yet": both are variableInvoiceTimingUnresolved:true (correctly
  // still held from real billing either way), but they are not the same
  // reviewer-facing fact.
  it('a CONFIRMED but non-executable performance-fee timing (invoice_at_period_end) reads distinctly from an unresolved one', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE], fixedFeeBillingTiming: { timing: 'bill_at_period_start', requires_confirmation: false } },
      { performanceShareFees: [{
        feeLabel: 'Payment success fee', status: 'ready', periodStart: '2026-08-01', periodEnd: '2026-08-31', currency: 'SEK', amount: 100,
        variableInvoiceTimingUnresolved: true, variableInvoiceTiming: 'invoice_at_period_end',
      }] },
    )
    render(<BillingSummaryCard jobId="job-1" terms={PERFORMANCE_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Aug 2026'))
    await waitFor(() => expect(screen.getByText('See calculation basis & sources')).toBeInTheDocument())
    fireEvent.click(screen.getByText('See calculation basis & sources'))
    await waitFor(() => expect(screen.getByText('Invoice timing: Confirmed for period end — awaiting execution support')).toBeInTheDocument())
    expect(screen.queryByText('Invoice timing: Decision required')).not.toBeInTheDocument()
  })

  it('an unresolved fixed-fee timing decision names the fixed component specifically, not a generic "Pending decision"', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE], fixedFeeBillingTiming: { timing: 'unclear', requires_confirmation: true } })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Fixed-fee invoice timing')).toBeInTheDocument())
    expect(screen.queryByText(/^Pending decision$/)).not.toBeInTheDocument()
  })
})

// Step 17H.4B0D4H1B4E2.3 §19 — Rolling-band evaluation now lives as a
// cross-period section inside Billing Timeline, never a separate top-level
// page section.
const ROLLING_BAND_TERMS = {
  ...PERIOD_TERMS,
  unsupported_commercial_mechanisms: [{
    kind: 'rolling_volume_band_migration', description: 'x', execution_status: 'executable',
    rolling_band_migration: {
      aggregate: { input_key: 'issued_requests', window_count: 3, window_unit: 'billing_period', operation: 'mean', require_complete_windows: true },
      trigger_comparator: 'greater_than', compared_to: 'contracted_volume', notice_required: false,
    },
  }],
}

describe('BillingSummaryCard — Rolling-band evaluation inside Billing Timeline (Step 17H.4B0D4H1B4E2.3)', () => {
  it('renders a "Rolling-band evaluation" section inside this card, showing 0-of-N periods before the contract has started, and never the misleading "Monitoring" label at that point (Step 17H.4B0D4H1B4E2.4 §16)', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE], contractStart: '2099-01-01' })
    render(<BillingSummaryCard jobId="job-1" terms={{ ...ROLLING_BAND_TERMS, contract_start_date: '2099-01-01' } as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    // The preStart text ("0 of N...") doesn't depend on the child's own
    // fetch resolving (it's true from the very first render), but the
    // badge label DOES — it reads 'Checking…' until data resolves. Wait
    // for the badge specifically so this assertion can't race ahead of it.
    await waitFor(() => expect(screen.getByText('Not started')).toBeInTheDocument())
    expect(screen.getByText(/0 of 3 completed billing periods available/)).toBeInTheDocument()
    expect(screen.queryByText('Monitoring')).not.toBeInTheDocument()
  })

  it('a triggered transition shows current/proposed band, and the contractual rule text is never restated here', async () => {
    mockSummary(
      { invoices: [PERIOD_INVOICE] },
      {
        rollingBandTransitions: [{
          id: 't1', trigger_metric: 'issued_requests', trigger_value: 12000,
          from_band: { from_unit: 0, to_unit: 10000, monthly_fee: 2000 },
          to_band: { from_unit: 10001, to_unit: null, monthly_fee: 3000 },
          notice_required: false, notice_status: null, notice_confirmed_at: null,
          effective_rule: null, effective_from: null, volume_transition_rule: null,
          status: 'decision_required', lifecycle_status: 'decision_required',
        }],
      },
    )
    render(<BillingSummaryCard jobId="job-1" terms={ROLLING_BAND_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    // The child RollingBandMigrationCard runs its own internal fetch —
    // wait for ITS async result (the summary line), not just the parent
    // section heading, which renders synchronously from `terms` alone.
    await waitFor(() => expect(screen.getByText(/Average 12,000/)).toBeInTheDocument())
    // The contractual rule (measurement window, trigger, effect, source)
    // lives exclusively in Commercial Logic & Billing Setup — never
    // restated inside this runtime card.
    expect(screen.queryByText(/Evaluated from the last/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Only ever moves the future base-fee band/)).not.toBeInTheDocument()
  })

  it('no executable rolling-band mechanism at all -> no "Rolling-band evaluation" section renders', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    render(<BillingSummaryCard jobId="job-1" terms={PERIOD_TERMS as never} usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never} />)
    await waitFor(() => expect(screen.getByText('Aug 2026')).toBeInTheDocument())
    expect(screen.queryByText('Rolling-band evaluation')).not.toBeInTheDocument()
  })

  it('when a source clause exists and onViewSource is passed through, offers a "View source clause" link — never the full clause text inline (Step 17H.4B0D4H1B4E2.4 §17)', async () => {
    mockSummary({ invoices: [PERIOD_INVOICE] })
    const onViewSource = vi.fn()
    render(
      <BillingSummaryCard
        jobId="job-1"
        terms={{ ...ROLLING_BAND_TERMS, unsupported_commercial_mechanisms: [{ ...ROLLING_BAND_TERMS.unsupported_commercial_mechanisms[0], source_clause: 'The contracted volume shall be reviewed quarterly.', source_sections: [{ exact_source_heading: 'Volume review' }] }] } as never}
        usageSourceCards={PERIOD_USAGE_SOURCE_CARDS as never}
        onViewSource={onViewSource}
      />,
    )
    await waitFor(() => expect(screen.getByText('Rolling-band evaluation')).toBeInTheDocument())
    const link = await screen.findByText('View source clause ↗')
    expect(screen.queryByText(/reviewed quarterly/)).not.toBeInTheDocument()
    fireEvent.click(link)
    expect(onViewSource).toHaveBeenCalled()
  })
})
