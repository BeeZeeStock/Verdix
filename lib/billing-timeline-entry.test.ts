import { describe, it, expect } from 'vitest'
import { buildParkedTimelineEntry, type ParkedInvoiceSummary } from './billing-timeline-entry'

function pi(overrides: Partial<ParkedInvoiceSummary> = {}): ParkedInvoiceSummary {
  return {
    id: 'planned-1', feeId: null, feeLabel: 'Test Fee', currency: 'SEK', baseAmount: 1000,
    metricName: null, ratePerUnit: null, description: null,
    billabilityCondition: null, evidence: null, plannedInvoiceStatus: 'parked',
    ...overrides,
  }
}

describe('buildParkedTimelineEntry — Step 17H.2A item 20 (display adapter)', () => {
  it('event-gated, no evidence -> awaiting_condition, never fabricates a date', () => {
    const entry = buildParkedTimelineEntry(pi({
      feeId: 'fee-1', billabilityCondition: { kind: 'event', event_type: 'customer_acceptance' },
    }))
    expect(entry.kind).toBe('parked_conditional_obligation')
    expect(entry.lifecycleState).toBe('awaiting_condition')
    expect(entry.iconStatusKey).toBe('parked_awaiting_evidence')
    expect(entry.orderingDate).toBeNull()
    expect(entry.secondaryText).toBe('Waiting for customer acceptance')
    expect(entry.amount).toEqual({ kind: 'fixed', amount: 1000, currency: 'SEK' })
  })

  it('event-gated, evidence recorded -> condition_confirmed_awaiting_execution, names the real stored event type', () => {
    const entry = buildParkedTimelineEntry(pi({
      feeId: 'fee-2', billabilityCondition: { kind: 'event', event_type: 'delivery' },
      evidence: { occurredAt: '2026-08-20T00:00:00.000Z', recordedAt: '2026-08-21T09:00:00.000Z' },
    }))
    expect(entry.lifecycleState).toBe('condition_confirmed_awaiting_execution')
    expect(entry.iconStatusKey).toBe('parked_evidence_recorded')
    expect(entry.secondaryText).toBe('Delivery recorded · awaiting billing execution')
    expect(entry.detail).toEqual({
      kind: 'event_gated', eventType: 'delivery',
      evidence: { occurredAt: '2026-08-20T00:00:00.000Z', recordedAt: '2026-08-21T09:00:00.000Z' },
    })
  })

  it('manual quantity/rate template (no condition, has a metric) -> reusable_template, amount is rate_per_unit, never a fabricated total', () => {
    const entry = buildParkedTimelineEntry(pi({
      billabilityCondition: null, metricName: 'hours', ratePerUnit: 150, baseAmount: 0,
    }))
    expect(entry.kind).toBe('parked_reusable_template')
    expect(entry.lifecycleState).toBe('reusable_template')
    expect(entry.amount).toEqual({ kind: 'rate_per_unit', ratePerUnit: 150, currency: 'SEK', unitLabel: 'hours' })
    expect(entry.secondaryText).toBe('Reusable delivery template — confirm each delivery to invoice')
  })

  it('fixed_date condition (neither event-gated nor the manual-template shape) fails closed as unsupported', () => {
    const entry = buildParkedTimelineEntry(pi({ billabilityCondition: { kind: 'fixed_date', date: '2026-12-01' } }))
    expect(entry.kind).toBe('parked_unsupported')
    expect(entry.lifecycleState).toBe('unsupported')
    expect(entry.detail).toEqual({ kind: 'unsupported' })
  })

  it('a fixed fee with no condition and no metric (neither known shape) fails closed as unsupported, not silently routed to the manual-template branch', () => {
    const entry = buildParkedTimelineEntry(pi({ billabilityCondition: null, metricName: null }))
    expect(entry.kind).toBe('parked_unsupported')
  })

  it('displayKey is always the planned_invoices row id, stable across every branch', () => {
    expect(buildParkedTimelineEntry(pi({ id: 'row-a' })).displayKey).toBe('row-a')
    expect(buildParkedTimelineEntry(pi({ id: 'row-b', billabilityCondition: { kind: 'event', event_type: 'delivery' } })).displayKey).toBe('row-b')
  })

  it('no entry ever carries actions from this adapter — evidence/delivery confirmation stays on ParkedInvoicesCard', () => {
    expect(buildParkedTimelineEntry(pi()).actions).toEqual([])
    expect(buildParkedTimelineEntry(pi({ billabilityCondition: { kind: 'event', event_type: 'customer_acceptance' } })).actions).toEqual([])
  })
})
