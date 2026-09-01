import { describe, it, expect } from 'vitest'
import { buildUsageMappingGroups, resolveExistingMappingRow } from './meter-mapping-groups'

const normaliseCycle = (freq: string | null | undefined) => (freq ? freq.toLowerCase() : 'monthly')

describe('buildUsageMappingGroups — Step 17D.2, item E ("one source decision, not three")', () => {
  it('a per-unit fee, an overage tier, and a rolling migration ALL referencing the same canonical key collapse into exactly ONE group', () => {
    const { unitGroups, extractedSemanticKeys } = buildUsageMappingGroups({
      overageTiers: [
        { unit_type: 'payment request', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, semantic_input_key: 'issued_payment_request_count' },
      ],
      additionalRecurringFees: [
        { fee_label: 'Per-request fee', rate_per_unit: 0.38, semantic_input_key: 'issued_payment_request_count' },
      ],
      unsupportedMechanisms: [
        {
          description: 'Rolling volume band migration', execution_status: 'executable',
          rolling_band_migration: { aggregate: { input_key: 'issued_payment_request_count' } },
        },
      ],
      normaliseCycle,
    })

    expect(unitGroups.size).toBe(1)
    expect(unitGroups.has('payment request')).toBe(true)
    expect(extractedSemanticKeys.get('payment request')).toBe('issued_payment_request_count')
  })

  it('a per-unit fee with NO overage tier of its own still gets its own group — never silently invisible', () => {
    const { unitGroups, extractedSemanticKeys } = buildUsageMappingGroups({
      overageTiers: [],
      additionalRecurringFees: [
        { fee_label: 'Success fee', rate_per_unit: 1.7, semantic_input_key: 'completed_payment_count' },
      ],
      unsupportedMechanisms: [],
      normaliseCycle,
    })

    expect(unitGroups.size).toBe(1)
    expect(unitGroups.has('Success fee')).toBe(true)
    expect(extractedSemanticKeys.get('Success fee')).toBe('completed_payment_count')
  })

  it('a rolling migration whose input is not covered by any fee/tier gets its own group', () => {
    const { unitGroups, extractedSemanticKeys } = buildUsageMappingGroups({
      overageTiers: [],
      additionalRecurringFees: [],
      unsupportedMechanisms: [{
        description: 'Rolling volume band migration', execution_status: 'executable',
        rolling_band_migration: { aggregate: { input_key: 'issued_payment_request_count' } },
      }],
      normaliseCycle,
    })

    expect(unitGroups.size).toBe(1)
    expect([...extractedSemanticKeys.values()]).toEqual(['issued_payment_request_count'])
  })

  it('two DIFFERENT canonical keys never collapse into one group', () => {
    const { unitGroups } = buildUsageMappingGroups({
      overageTiers: [
        { unit_type: 'payment request', from_unit: 5001, to_unit: null, rate_per_unit: 0.6, semantic_input_key: 'issued_payment_request_count' },
      ],
      additionalRecurringFees: [
        { fee_label: 'Success fee', rate_per_unit: 1.7, semantic_input_key: 'completed_payment_count' },
      ],
      unsupportedMechanisms: [],
      normaliseCycle,
    })

    expect(unitGroups.size).toBe(2)
  })

  it('a non-executable rolling mechanism is ignored — never surfaced as a mapping requirement', () => {
    const { unitGroups } = buildUsageMappingGroups({
      overageTiers: [],
      additionalRecurringFees: [],
      unsupportedMechanisms: [{
        description: 'Unresolved mechanism', execution_status: 'unsupported',
        rolling_band_migration: null,
      }],
      normaliseCycle,
    })
    expect(unitGroups.size).toBe(0)
  })

  it('a flat (non-per-unit) fee with rate_per_unit unset never synthesizes a group', () => {
    const { unitGroups } = buildUsageMappingGroups({
      overageTiers: [],
      additionalRecurringFees: [{ fee_label: 'Flat platform fee', semantic_input_key: null }],
      unsupportedMechanisms: [],
      normaliseCycle,
    })
    expect(unitGroups.size).toBe(0)
  })

  it('an unrecognized semantic_input_key fails closed — never mints a new execution identity as a group', () => {
    const { unitGroups } = buildUsageMappingGroups({
      overageTiers: [],
      additionalRecurringFees: [{ fee_label: 'Mystery fee', rate_per_unit: 1, semantic_input_key: 'totally_unknown_thing' }],
      unsupportedMechanisms: [],
      normaliseCycle,
    })
    expect(unitGroups.size).toBe(0)
  })
})

// Step 17G.6C — real production regression: "Completed payments" (a flat
// additional_recurring_fee with no overage_tiers entry of its own) showed
// "Not configured" in Commercial Logic & Billing Setup even though its
// meter mapping was genuinely confirmed as manual usage. Root cause,
// traced directly against the real job: buildUsageMappingGroups (above)
// keys a fee-only group by that fee's OWN fee_label ("Per-completed
// payment success fee") when it has no overage tier to inherit a raw
// unit_type from — but the real persisted contract_meter_mappings row was
// written under a DIFFERENT contract_unit_type string ("completed
// payment", a plain human phrase from an earlier code path) for the exact
// same canonical fact (semantic_input_key: 'completed_payment_count' on
// both sides). The route's join used to be a strict contract_unit_type
// string match and silently missed it. This is the fix: fall back to a
// semantic_input_key match — the identical real shape reproduced below.
describe('resolveExistingMappingRow — Step 17G.6C (source-state regression)', () => {
  it('matches by contract_unit_type first, unchanged — the primary key for every metric that already lines up', () => {
    const existing = [{ contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count', confirmed: true }]
    const row = resolveExistingMappingRow('payment request', 'issued_payment_request_count', existing)
    expect(row).toBe(existing[0])
  })

  it('reproduces the real regression: falls back to semantic_input_key when a fee-only group\'s fresh key (its own fee_label) no longer matches the persisted contract_unit_type', () => {
    const existing = [{ contract_unit_type: 'completed payment', semantic_input_key: 'completed_payment_count', confirmed: true, manual_value_configured: true, meter_key: '' }]
    // unitType here is exactly what buildUsageMappingGroups synthesizes for
    // a fee-only group — the fee's own fee_label, not "completed payment".
    const row = resolveExistingMappingRow('Per-completed payment success fee', 'completed_payment_count', existing)
    expect(row).toBe(existing[0])
  })

  it('never matches a genuinely different canonical fact — semantic_input_key equality is required, not inferred', () => {
    const existing = [{ contract_unit_type: 'some other unit type', semantic_input_key: 'issued_payment_request_count' }]
    const row = resolveExistingMappingRow('Per-completed payment success fee', 'completed_payment_count', existing)
    expect(row).toBeUndefined()
  })

  it('returns undefined (never throws) when there is no existing row and no semantic key to fall back on', () => {
    expect(resolveExistingMappingRow('Some new metric', null, [])).toBeUndefined()
    expect(resolveExistingMappingRow('Some new metric', undefined, [])).toBeUndefined()
  })

  it('does not fall back to semantic_input_key when the row has none (a legacy row predating this field)', () => {
    const existing = [{ contract_unit_type: 'legacy unit', semantic_input_key: null }]
    const row = resolveExistingMappingRow('Fresh key', 'some_semantic_key', existing)
    expect(row).toBeUndefined()
  })
})
