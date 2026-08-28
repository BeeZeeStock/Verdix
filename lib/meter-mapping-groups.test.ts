import { describe, it, expect } from 'vitest'
import { buildUsageMappingGroups } from './meter-mapping-groups'

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
