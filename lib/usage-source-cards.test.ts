import { describe, it, expect } from 'vitest'
import { buildUsageSourceCards } from './usage-source-cards'

describe('buildUsageSourceCards — Step 17E, items 6/7/8', () => {
  it('one semantic input -> one source card -> multiple consumers (the exact Remembill acceptance shape)', () => {
    const cards = buildUsageSourceCards({
      mappings: [
        { contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count', meter_key: 'payment_requests_issued', confirmed: true },
      ],
      meters: [{ meter_key: 'payment_requests_issued', display_name: 'Payment Requests Issued' }],
      fees: [
        { fee_label: 'Per-request fee', metric_name: 'issued_payment_request', rate_per_unit: 0.38, semantic_input_key: 'issued_payment_request_count' },
      ],
      tiers: [
        { unit_type: 'payment request', rate_per_unit: 0.6, semantic_input_key: 'issued_payment_request_count' },
      ],
      rollingMechanisms: [
        { execution_status: 'executable', rolling_band_migration: { aggregate: { input_key: 'issued_payment_request_count', window_count: 3 } } },
      ],
    })

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      label: 'Payment Requests Issued',
      sourceName: 'Payment Requests Issued',
      sourceType: 'api_meter',
      status: 'confirmed',
      semanticInputKey: 'issued_payment_request_count',
    })
    expect(cards[0].consumers).toContain('€0.38 per issued payment request')
    expect(cards[0].consumers).toContain('€0.6 overage above contracted volume')
    expect(cards[0].consumers).toContain('3-month rolling volume migration')
  })

  it('two different semantic inputs never merge into one card — completed_payment_count stays separate', () => {
    const cards = buildUsageSourceCards({
      mappings: [
        { contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count', meter_key: 'payment_requests_issued', confirmed: true },
        { contract_unit_type: 'completed payment', semantic_input_key: 'completed_payment_count', meter_key: 'completed_payments', confirmed: true },
      ],
      meters: [
        { meter_key: 'payment_requests_issued', display_name: 'Payment Requests Issued' },
        { meter_key: 'completed_payments', display_name: 'Completed Payments' },
      ],
      fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards).toHaveLength(2)
    expect(cards.map(c => c.semanticInputKey).sort()).toEqual(['completed_payment_count', 'issued_payment_request_count'])
  })

  it('never shows a blank "Meter: " — a no-match confirmed row falls back to the meter_key, never an empty string', () => {
    const cards = buildUsageSourceCards({
      mappings: [{ contract_unit_type: 'payment request', meter_key: 'some_meter_not_in_list', confirmed: true }],
      meters: [], // the confirmed meter_key isn't in the available list — must never blank out
      fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].sourceName).toBe('some_meter_not_in_list')
    expect(cards[0].sourceName).not.toBe('')
  })

  it('manual source renders "Manual usage", not a meter description', () => {
    const cards = buildUsageSourceCards({
      mappings: [{
        contract_unit_type: 'chargeback', meter_key: '', confirmed: true,
        input_classification: 'meter_or_manual_input', manual_value_configured: true,
      }],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards[0].sourceName).toBe('Manual usage')
    expect(cards[0].sourceType).toBe('manual')
  })

  it('derived and persisted_balance classifications never produce a source card', () => {
    const cards = buildUsageSourceCards({
      mappings: [
        { contract_unit_type: 'cumulative annual volume', meter_key: '', confirmed: true, input_classification: 'derived' },
        { contract_unit_type: 'credit balance', meter_key: '', confirmed: true, input_classification: 'persisted_balance' },
      ],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards).toHaveLength(0)
  })

  it('an unresolved semantic key still shows what it feeds via a raw unit_type match on tiers', () => {
    const cards = buildUsageSourceCards({
      mappings: [{ contract_unit_type: 'excess downtime hours', meter_key: 'downtime_meter', confirmed: true }],
      meters: [{ meter_key: 'downtime_meter', display_name: 'Downtime Hours' }],
      fees: [],
      tiers: [{ unit_type: 'excess downtime hours', rate_per_unit: 12 }],
      rollingMechanisms: [],
    })
    expect(cards[0].semanticInputKey).toBeNull()
    expect(cards[0].consumers).toContain('€12 overage above contracted volume')
  })

  it('a not-yet-confirmed row shows status not_confirmed and sourceType unconfirmed, never a fabricated source name', () => {
    const cards = buildUsageSourceCards({
      mappings: [{ contract_unit_type: 'payment request', meter_key: '', confirmed: false }],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards[0]).toMatchObject({ status: 'not_confirmed', sourceType: 'unconfirmed', sourceName: 'Not yet confirmed' })
  })
})
