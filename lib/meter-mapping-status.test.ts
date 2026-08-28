import { describe, it, expect } from 'vitest'
import { isMeterMappingResolved, allMeterMappingsResolved } from './meter-mapping-status'

describe('isMeterMappingResolved (scenario: TEST-PAY-002 — meter confirmation contradiction)', () => {
  it('meter: confirmed with a real meter_key is resolved', () => {
    expect(isMeterMappingResolved({ classification: 'meter', confirmed: true, meter_key: 'transactions' })).toBe(true)
  })

  it('meter: confirmed with an empty meter_key is NOT resolved — the exact legacy-row bug', () => {
    expect(isMeterMappingResolved({ classification: 'meter', confirmed: true, meter_key: '' })).toBe(false)
  })

  it('meter: unconfirmed is never resolved regardless of meter_key', () => {
    expect(isMeterMappingResolved({ classification: 'meter', confirmed: false, meter_key: 'transactions' })).toBe(false)
  })

  // Step 17D.2, item C — "Do not make production manual usage dependent on
  // the old meter_or_manual_input keyword classification... weak text
  // classification should not determine whether manual entry is
  // permitted." 'meter' (the default classification for e.g.
  // issued_payment_request_count/completed_payment_count/email_sent) must
  // resolve via manual entry exactly like 'meter_or_manual_input' does —
  // the classification is informational only now, never a resolution gate.
  it('meter: resolved via manual_value_configured even with no meter_key — manual entry is not gated by classification', () => {
    expect(isMeterMappingResolved({ classification: 'meter', confirmed: true, meter_key: '', manual_value_configured: true })).toBe(true)
  })

  it('meter_or_manual_input: resolved via manual_value_configured even with no meter_key', () => {
    expect(isMeterMappingResolved({ classification: 'meter_or_manual_input', confirmed: true, meter_key: '', manual_value_configured: true })).toBe(true)
  })

  it('meter_or_manual_input: unresolved with neither a meter_key nor manual config', () => {
    expect(isMeterMappingResolved({ classification: 'meter_or_manual_input', confirmed: true, meter_key: '', manual_value_configured: false })).toBe(false)
  })

  it('derived and persisted_balance are always resolved — never meter-mapped', () => {
    expect(isMeterMappingResolved({ classification: 'derived', confirmed: false, meter_key: '' })).toBe(true)
    expect(isMeterMappingResolved({ classification: 'persisted_balance', confirmed: false, meter_key: '' })).toBe(true)
  })
})

describe('allMeterMappingsResolved (scenario: TEST-PAY-002 — "All confirmed" must never contradict a per-row "No meter selected")', () => {
  it('false when any row has confirmed:true but an empty meter_key', () => {
    const rows = [
      { classification: 'meter' as const, confirmed: true, meter_key: 'transactions' },
      { classification: 'meter' as const, confirmed: true, meter_key: '' }, // legacy bad row
    ]
    expect(allMeterMappingsResolved(rows)).toBe(false)
  })

  it('true only when every row is genuinely resolved', () => {
    const rows = [
      { classification: 'meter' as const, confirmed: true, meter_key: 'transactions' },
      { classification: 'derived' as const, confirmed: false, meter_key: '' },
    ]
    expect(allMeterMappingsResolved(rows)).toBe(true)
  })

  it('false for an empty list', () => {
    expect(allMeterMappingsResolved([])).toBe(false)
  })
})
