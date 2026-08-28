import { describe, it, expect } from 'vitest'
import { planSemanticInputKeyReconciliation, applySemanticInputKeyReconciliation, planMeterMappingSemanticKeyReconciliation } from './semantic-input-key-reconciliation'

describe('planSemanticInputKeyReconciliation — Step 17F.1, item 1', () => {
  it('the real Remembill job shape: resolves all three missing keys from metric_name/unit_type, none guessed from fee_label', () => {
    const plan = planSemanticInputKeyReconciliation({
      fees: [
        { fee_label: 'Per-issued payment request fee', metric_name: 'issued_payment_request', semantic_input_key: null },
        { fee_label: 'Per-completed payment success fee', metric_name: 'completed_payment', semantic_input_key: null },
        { fee_label: 'Performance share (resultatdel) — value-weighted payment rate', metric_name: null, semantic_input_key: null },
      ],
      tiers: [
        { unit_type: 'payment request', semantic_input_key: null },
      ],
    })
    expect(plan.feeUpdates).toEqual([
      { index: 0, fee_label: 'Per-issued payment request fee', semantic_input_key: 'issued_payment_request_count' },
      { index: 1, fee_label: 'Per-completed payment success fee', semantic_input_key: 'completed_payment_count' },
    ])
    expect(plan.tierUpdates).toEqual([{ index: 0, unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count' }])
  })

  it('never touches a fee/tier that already has a semantic_input_key', () => {
    const plan = planSemanticInputKeyReconciliation({
      fees: [{ fee_label: 'X', metric_name: 'issued_payment_request', semantic_input_key: 'already_set' }],
      tiers: [{ unit_type: 'payment request', semantic_input_key: 'already_set' }],
    })
    expect(plan.feeUpdates).toEqual([])
    expect(plan.tierUpdates).toEqual([])
  })

  it('never guesses from fee_label — a fee with no metric_name and an unresolvable label is left untouched', () => {
    const plan = planSemanticInputKeyReconciliation({
      fees: [{ fee_label: 'Per-issued payment request fee', metric_name: null, semantic_input_key: null }],
      tiers: [],
    })
    expect(plan.feeUpdates).toEqual([])
  })

  it('a metric_name/unit_type that does not resolve via the strict registry is left untouched, never a guess', () => {
    const plan = planSemanticInputKeyReconciliation({
      fees: [{ fee_label: 'Support retainer', metric_name: 'support_ticket', semantic_input_key: null }],
      tiers: [{ unit_type: 'active seats', semantic_input_key: null }],
    })
    expect(plan.feeUpdates).toEqual([])
    expect(plan.tierUpdates).toEqual([])
  })
})

describe('applySemanticInputKeyReconciliation', () => {
  it('applies the plan positionally without mutating the input arrays', () => {
    const fees = [{ fee_label: 'A', metric_name: 'issued_payment_request', semantic_input_key: null }]
    const tiers = [{ unit_type: 'payment request', semantic_input_key: null }]
    const plan = planSemanticInputKeyReconciliation({ fees, tiers })
    const result = applySemanticInputKeyReconciliation({ fees, tiers, plan })
    expect(result.fees[0].semantic_input_key).toBe('issued_payment_request_count')
    expect(result.tiers[0].semantic_input_key).toBe('issued_payment_request_count')
    // Originals untouched.
    expect(fees[0].semantic_input_key).toBeNull()
    expect(tiers[0].semantic_input_key).toBeNull()
  })

  it('an empty plan returns arrays equal in content to the input (unresolved entries untouched)', () => {
    const fees = [{ fee_label: 'A', metric_name: 'support_ticket', semantic_input_key: null }]
    const tiers: never[] = []
    const plan = planSemanticInputKeyReconciliation({ fees, tiers })
    const result = applySemanticInputKeyReconciliation({ fees, tiers, plan })
    expect(result.fees).toEqual(fees)
  })
})

describe('planMeterMappingSemanticKeyReconciliation — Step 17F.1, item 3 (contract_meter_mappings is a separate storage location)', () => {
  it('resolves the real Remembill contract_meter_mappings row from its own contract_unit_type', () => {
    const plan = planMeterMappingSemanticKeyReconciliation({
      mappings: [{ contract_unit_type: 'payment request', semantic_input_key: null }],
    })
    expect(plan.mappingUpdates).toEqual([{ contract_unit_type: 'payment request', semantic_input_key: 'issued_payment_request_count' }])
  })

  it('never touches a mapping row that already has a semantic_input_key', () => {
    const plan = planMeterMappingSemanticKeyReconciliation({
      mappings: [{ contract_unit_type: 'payment request', semantic_input_key: 'already_set' }],
    })
    expect(plan.mappingUpdates).toEqual([])
  })

  it('an unresolvable contract_unit_type is left untouched, never a guess', () => {
    const plan = planMeterMappingSemanticKeyReconciliation({
      mappings: [{ contract_unit_type: 'active seats', semantic_input_key: null }],
    })
    expect(plan.mappingUpdates).toEqual([])
  })
})
