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

  // Step 17F, item 2 — the reported state/UI bug: a legacy
  // contract_meter_mappings row can carry confirmed:true with an empty
  // meter_key (written before isMeterMappingResolved's invariant existed —
  // see lib/meter-mapping-status.ts's own header). Trusting the raw
  // `confirmed` flag directly produced "Status: Confirmed" next to
  // "Source: Not yet confirmed" simultaneously — a genuine contradiction,
  // never allowed to render again.
  it('confirmed:true with no meter_key and no manual value never renders status "confirmed" — never Confirmed next to "Not yet confirmed"', () => {
    const cards = buildUsageSourceCards({
      mappings: [{ contract_unit_type: 'payment request', meter_key: '', confirmed: true }],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards[0].status).toBe('not_confirmed')
    expect(cards[0].sourceName).toBe('Not yet confirmed')
  })

  // Step 17F, item 2 — found via the real-data acceptance walkthrough
  // against job a4459e99 (Remembill/NordicFit): its stored
  // contract_meter_mappings row is confirmed via manual entry but
  // classified 'meter' (not 'meter_or_manual_input' — classification is
  // only ever a text-matching guess, never a gate on validity, per
  // lib/meter-mapping-status.ts's own header). Previously sourceName fell
  // through to "Not yet confirmed" for this exact shape while status
  // correctly said "confirmed" — the same class of contradiction as the
  // test above, just reachable via a different real data combination.
  it('a manually-entered row classified "meter" (not "meter_or_manual_input") still shows "Manual usage", never "Not yet confirmed"', () => {
    const cards = buildUsageSourceCards({
      mappings: [{
        contract_unit_type: 'payment request', meter_key: '', confirmed: true,
        input_classification: 'meter', manual_value_configured: true,
      }],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards[0].status).toBe('confirmed')
    expect(cards[0].sourceName).toBe('Manual usage')
    expect(cards[0].sourceType).toBe('manual')
  })

  it('confirmed:true with a manual value configured (meter_or_manual_input) correctly resolves to confirmed', () => {
    const cards = buildUsageSourceCards({
      mappings: [{
        contract_unit_type: 'chargeback', meter_key: '', confirmed: true,
        input_classification: 'meter_or_manual_input', manual_value_configured: true,
      }],
      meters: [], fees: [], tiers: [], rollingMechanisms: [],
    })
    expect(cards[0].status).toBe('confirmed')
    expect(cards[0].sourceName).toBe('Manual usage')
  })

  it('Step 17F, item 2 acceptance shape — issued_payment_request_count and completed_payment_count both appear as separate confirmed cards, with no chargingGroups-only scoping applied by the lib itself', () => {
    const cards = buildUsageSourceCards({
      mappings: [
        { contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count', meter_key: 'payment_requests_issued', confirmed: true },
        // completed_payment_count has NO overage tier of its own — only a
        // flat per-unit fee — this is exactly the metric that a
        // tier-scoped filter (chargingGroups.keys()) previously dropped.
        { contract_unit_type: 'completed payment', semantic_input_key: 'completed_payment_count', meter_key: 'completed_payments', confirmed: true },
      ],
      meters: [
        { meter_key: 'payment_requests_issued', display_name: 'Payment Requests Issued' },
        { meter_key: 'completed_payments', display_name: 'Completed Payments' },
      ],
      fees: [
        { fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request', rate_per_unit: 0.38, semantic_input_key: 'issued_payment_request_count' },
        { fee_label: 'Per-completed payment success fee', metric_name: 'completed_payment', rate_per_unit: 1.70, semantic_input_key: 'completed_payment_count' },
      ],
      tiers: [
        { unit_type: 'payment request', rate_per_unit: 0.6, semantic_input_key: 'issued_payment_request_count' },
      ],
      rollingMechanisms: [
        { execution_status: 'executable', rolling_band_migration: { aggregate: { input_key: 'issued_payment_request_count', window_count: 3 } } },
      ],
    })
    expect(cards).toHaveLength(2)
    const issued = cards.find(c => c.semanticInputKey === 'issued_payment_request_count')!
    const completed = cards.find(c => c.semanticInputKey === 'completed_payment_count')!
    expect(issued.sourceName).toBe('Payment Requests Issued')
    expect(issued.status).toBe('confirmed')
    expect(issued.consumers).toContain('€0.38 per issued payment request')
    expect(issued.consumers).toContain('€0.6 overage above contracted volume')
    expect(issued.consumers).toContain('3-month rolling volume migration')
    expect(completed.sourceName).toBe('Completed Payments')
    expect(completed.status).toBe('confirmed')
    expect(completed.consumers).toContain('€1.7 per completed payment')
    // No chargingGroups-only scoping: completed_payment_count has no
    // overage tier of its own — only a flat per-unit fee — and it still
    // appears as its own confirmed card, matching item 2's exact
    // acceptance requirement.
  })
})
