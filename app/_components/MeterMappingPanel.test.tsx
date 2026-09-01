// @vitest-environment jsdom
// Step 17H.4B0D4H1B4E6.1 — ReviewPanel refocus. These tests cover
// MeterMappingPanel's operational-data-inputs summary (§3/§4/§6/§23/§24),
// derived-metrics compaction (§7/§8), and the four required mapping-state
// cases (§6, §31): (A) no meters + no confirmed mappings, (B) meters
// available + unresolved mapping, (C) all mappings confirmed, (D) a
// confirmed historical mapping whose meter is no longer in the current
// available-meters list ("Configured source unavailable").
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MeterMappingPanel } from './MeterMappingPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mockMappings(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
}

const noop = () => {}

describe('MeterMappingPanel — operational data inputs (§3/§4/§6/§23/§24)', () => {
  it('does not render the full manual-entry form (date range, value, currency, Save draft, Mark final)', async () => {
    mockMappings({
      suggestions: [],
      available_meters: [],
      operational_data_inputs: [{ key: 'paid_invoice_value', kind: 'monetary', sources: ['overage_tiers: Total invoice value of issued requests'] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} contractStartDate="2026-10-01" />)
    await waitFor(() => expect(screen.getByText('Paid invoice value')).toBeInTheDocument())
    expect(screen.queryByText('Save draft')).not.toBeInTheDocument()
    expect(screen.queryByText('Mark final')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/period start/i)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Value')).not.toBeInTheDocument()
  })

  it('shows a humanized business label as primary text, not the raw key', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'total_invoice_value_of_issued_requests', kind: 'monetary', sources: [] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText('Total invoice value of issued requests')).toBeInTheDocument())
  })

  it('developer-oriented explanatory copy is gone', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'paid_invoice_value', kind: 'monetary', sources: [] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText('Operational data inputs')).toBeInTheDocument())
    expect(screen.queryByText(/billing-meter-shaped/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/real usage events/i)).not.toBeInTheDocument()
  })

  it('billing not yet started: reads "required once billing begins on {date}", not an immediate failure', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'paid_invoice_value', kind: 'monetary', sources: [] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} contractStartDate="2099-01-01" />)
    await waitFor(() => expect(screen.getByText(/required once billing begins on 1 January 2099/)).toBeInTheDocument())
  })

  it('billing already started: reads "entered each billing period"', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'paid_invoice_value', kind: 'monetary', sources: [] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} contractStartDate="2020-01-01" />)
    await waitFor(() => expect(screen.getByText(/entered each billing period/)).toBeInTheDocument())
  })

  it('"Manage in Billing Operations" deep-links out — clicking it calls the navigate callback, not an inline form', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'paid_invoice_value', kind: 'monetary', sources: [] }],
      derived_metrics: [],
    })
    const onNavigate = vi.fn()
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} onNavigateToOperationalInputs={onNavigate} />)
    await waitFor(() => expect(screen.getByText('Manage in Billing Operations →')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Manage in Billing Operations →'))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('a purely countable input (no monetary inputs) shows no Billing Operations link — nothing to manage there', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [{ key: 'chargeback_count', kind: 'countable', sources: [] }],
      derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} onNavigateToOperationalInputs={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Chargeback count')).toBeInTheDocument())
    expect(screen.queryByText('Manage in Billing Operations →')).not.toBeInTheDocument()
  })
})

describe('MeterMappingPanel — derived metrics (§7/§8)', () => {
  it('compact summary: humanized name shown, no raw formula as primary copy', async () => {
    mockMappings({
      suggestions: [], available_meters: [],
      operational_data_inputs: [],
      derived_metrics: [{ metric_name: 'value_weighted_payment_rate', formula: 'paid_invoice_value / total_invoice_value', raw_inputs: [], source: 'x' }],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText('Value weighted payment rate')).toBeInTheDocument())
    expect(screen.getByText('Performance calculation configured')).toBeInTheDocument()
  })
})

describe('MeterMappingPanel — usage-mapping state cases (§6, §31)', () => {
  it('Case A: no meters + no confirmed mappings shows the registration warning', async () => {
    mockMappings({
      suggestions: [{ contract_unit_type: 'API calls', meter_key: '', confidence: 0.1, confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' }],
      available_meters: [],
      operational_data_inputs: [], derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText('No billing meters registered')).toBeInTheDocument())
  })

  it('Case B: meters available + an unresolved mapping shows the picker, not an "all confirmed" claim', async () => {
    mockMappings({
      suggestions: [{ contract_unit_type: 'API calls', meter_key: '', confidence: 0.1, confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' }],
      available_meters: [{ meter_key: 'api_calls', display_name: 'API Calls', unit_label: 'call' }],
      operational_data_inputs: [], derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText('API Calls')).toBeInTheDocument())
    expect(screen.queryByText(/confirmed$/)).not.toBeInTheDocument()
  })

  it('Case C: all mappings confirmed shows "N of N confirmed" and collapses the full cards by default', async () => {
    mockMappings({
      suggestions: [
        { contract_unit_type: 'API calls', meter_key: 'api_calls', confidence: 0.9, confirmed: true, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' },
        { contract_unit_type: 'Seats', meter_key: 'seats', confidence: 0.9, confirmed: true, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' },
      ],
      available_meters: [
        { meter_key: 'api_calls', display_name: 'API Calls', unit_label: 'call' },
        { meter_key: 'seats', display_name: 'Seats', unit_label: 'seat' },
      ],
      operational_data_inputs: [], derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText(/2 of 2 confirmed/)).toBeInTheDocument())
    // Collapsed by default once fully confirmed — the per-metric "Mapped to…" row is not shown.
    await waitFor(() => expect(screen.queryAllByText(/Mapped to/).length).toBe(0))
  })

  it('Case D: a confirmed mapping whose meter is no longer registered shows a distinct "Configured source unavailable" state, never a plain confirmed match', async () => {
    mockMappings({
      suggestions: [
        { contract_unit_type: 'API calls', meter_key: 'retired_meter', confidence: 0.9, confirmed: true, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' },
        // A second, unconfirmed row keeps allConfirmed false so the panel
        // doesn't auto-collapse mid-assertion — isolates the Case D bug
        // from the (separate, correct) auto-collapse-once-fully-confirmed
        // behavior, which would otherwise hide this row a moment later.
        { contract_unit_type: 'Seats', meter_key: '', confidence: 0.5, confirmed: false, included_units: 0, overage_tiers: [], billing_cycle: 'monthly' },
      ],
      // Meters ARE registered — just not the one this row was confirmed
      // against, isolating the actual bug (matchedMeter undefined) from the
      // separate "meters.length === 0" registration-prompt case.
      available_meters: [{ meter_key: 'other_meter', display_name: 'Other Meter', unit_label: 'unit' }],
      operational_data_inputs: [], derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText(/Configured source unavailable/)).toBeInTheDocument())
    expect(screen.getByText(/"retired_meter" is no longer registered/)).toBeInTheDocument()
    // Case D must never be conflated with "no mappings exist" — the empty-meters
    // registration warning is about a DIFFERENT condition (nothing confirmed
    // yet) and must not also render here.
    expect(screen.queryByText('No billing meters registered')).not.toBeInTheDocument()
  })

  it('no contradictory state: every suggestion resolved via derived/persisted_balance (never meter-mapped) with zero registered meters shows "confirmed", never the meter-registration warning', async () => {
    mockMappings({
      suggestions: [
        { contract_unit_type: 'Credit balance', meter_key: '', confidence: 1, confirmed: true, included_units: 0, overage_tiers: [], billing_cycle: 'monthly', input_classification: 'persisted_balance' },
      ],
      available_meters: [],
      operational_data_inputs: [], derived_metrics: [],
    })
    render(<MeterMappingPanel jobId="j1" onConfirmedChange={noop} />)
    await waitFor(() => expect(screen.getByText(/1 of 1 confirmed/)).toBeInTheDocument())
    expect(screen.queryByText('No billing meters registered')).not.toBeInTheDocument()
  })
})
