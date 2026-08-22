// Step 12, item 24 — required end-to-end scenario coverage for
// BillabilityCondition. Same technique Steps 10/11 established: hand-
// constructed (or applyExtractionSafetyNets-normalized) OneTimeFee-shaped
// fixtures run through the REAL computeCommercialRuleWorkload/
// buildOneTimeFeeConfirmation/isOneTimeFeeUnresolved production functions —
// no mocks of Verdix's own logic. approve/route.ts itself can't be
// unit-tested (next-auth import failure under vitest — established
// constraint), so the Approve-boundary assertions mirror its exact gate
// condition verbatim, same as tests/commercial-semantics/milestone-billing/
// approve-gate-cannot-bypass-blockers.test.ts.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload, type CommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { buildOneTimeFeeConfirmation } from '@/lib/one-time-fee'
import { applyExtractionSafetyNets } from '@/lib/contract-extractor'
import type { OneTimeFee, ContractTerms } from '@/lib/types'

function approveWouldBlock(workload: CommercialRuleWorkload): boolean {
  if (workload.executionBlockers.length > 0) return true
  if (workload.totalToConfirm > 0 || workload.interactionsToConfirm > 0) return true
  if (!workload.vat.configured) return true
  return false
}

function extractOne(fee: Partial<OneTimeFee>): OneTimeFee {
  const terms = applyExtractionSafetyNets({
    escalators: [], discounts: [], service_credits: [], overage_tiers: [],
    one_time_fees: [{ fee_label: 'Fee', amount: 100000, due_date: null, description: null, ...fee }],
  } as unknown as ContractTerms)
  return terms.one_time_fees![0]
}

describe('Scenario 1 — fixed date: interpreted, reviewer-confirmed, executable under the current model', () => {
  it('extraction normalizes a stated date to fixed_date; confirming billability reaches full readiness and does not block Approve', () => {
    const extracted = extractOne({ billability_condition: { kind: 'fixed_date', date: '2026-10-15' } } as Partial<OneTimeFee>)
    expect(extracted.billability_condition).toEqual({ kind: 'fixed_date', date: '2026-10-15' })
    expect(extracted.due_date).toBe('2026-10-15')

    const amountConfirmed = buildOneTimeFeeConfirmation(extracted, { confirmAmount: true })
    const fullyConfirmed = buildOneTimeFeeConfirmation(amountConfirmed, { confirmBillability: true })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fullyConfirmed] }, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toEqual([])
    expect(workload.status).toBe('all_commercial_rules_confirmed')
    expect(approveWouldBlock(workload)).toBe(false)
  })
})

describe('Scenario 2 — immediate: explicit source meaning only, supported', () => {
  it('an explicit immediate condition, confirmed, reaches full readiness — executable, no operational evidence required', () => {
    const extracted = extractOne({ amount: 5000, billability_condition: { kind: 'immediate' } } as Partial<OneTimeFee>)
    expect(extracted.billability_condition).toEqual({ kind: 'immediate' })
    expect(extracted.due_date).toBeNull()
    expect(extracted.manual_trigger).toBe(false)

    const confirmed = buildOneTimeFeeConfirmation(buildOneTimeFeeConfirmation(extracted, { confirmAmount: true }), { confirmBillability: true })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [confirmed] }, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toEqual([])
    expect(approveWouldBlock(workload)).toBe(false)
  })
})

describe('Scenario 3 — contract signature: semantic condition represented, confirmed, execution blocked pending signature evidence', () => {
  it('"payable upon signing" normalizes to event/contract_signature; once confirmed, semantics are resolved but Approve stays blocked on operational evidence', () => {
    const extracted = extractOne({
      amount: 100000, due_date: '2026-09-01', // a stray effective-date guess must never leak through — see Scenario 6/contract-extractor.test.ts
      billability_condition: { kind: 'event', event_type: 'contract_signature' },
    } as Partial<OneTimeFee>)
    expect(extracted.billability_condition).toEqual({ kind: 'event', event_type: 'contract_signature' })
    expect(extracted.due_date).toBeNull() // the stray date never survives normalization

    const amountConfirmed = buildOneTimeFeeConfirmation(extracted, { confirmAmount: true })
    const stillBlocked = computeCommercialRuleWorkload({ one_time_fees: [amountConfirmed] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(stillBlocked)).toBe(true) // billability not yet confirmed at all

    const fullyConfirmed = buildOneTimeFeeConfirmation(amountConfirmed, { confirmBillability: true })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fullyConfirmed] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
    expect(workload.executionBlockers).toEqual([{
      type: 'required_operational_event_missing', rule_family: 'one_time_fee',
      event_type: 'contract_signature', field: 'one_time_fee:Fee',
      reason: expect.any(String),
    }])
    expect(approveWouldBlock(workload)).toBe(true)
  })
})

describe('Scenario 4 — customer acceptance: semantic condition represented, confirmed, execution blocked pending acceptance evidence', () => {
  it('"becomes billable upon customer acceptance" normalizes to event/customer_acceptance; confirmed interpretation still blocks Approve', () => {
    const extracted = extractOne({ billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>)
    const fullyConfirmed = buildOneTimeFeeConfirmation(buildOneTimeFeeConfirmation(extracted, { confirmAmount: true }), { confirmBillability: true })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fullyConfirmed] }, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers[0]).toMatchObject({ type: 'required_operational_event_missing', event_type: 'customer_acceptance' })
    expect(approveWouldBlock(workload)).toBe(true)
    // But the reviewer's decision IS recorded and visible — this is not the
    // same as unsupported_semantics (item 6).
    expect(fullyConfirmed.billability_provenance).toBe('reviewer_policy')
    expect(fullyConfirmed.unresolved_kind).not.toBe('unsupported_semantics')
  })
})

describe('Scenario 5 — delivery: distinct from acceptance', () => {
  it('event/delivery and event/customer_acceptance never collapse — different fees, different blockers', () => {
    const deliveryFee = buildOneTimeFeeConfirmation(
      buildOneTimeFeeConfirmation(extractOne({ fee_label: 'Delivery fee', billability_condition: { kind: 'event', event_type: 'delivery' } } as Partial<OneTimeFee>), { confirmAmount: true }),
      { confirmBillability: true },
    )
    const acceptanceFee = buildOneTimeFeeConfirmation(
      buildOneTimeFeeConfirmation(extractOne({ fee_label: 'Acceptance fee', billability_condition: { kind: 'event', event_type: 'customer_acceptance' } } as Partial<OneTimeFee>), { confirmAmount: true }),
      { confirmBillability: true },
    )
    const workload = computeCommercialRuleWorkload({ one_time_fees: [deliveryFee, acceptanceFee] }, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers).toHaveLength(2)
    const byField = Object.fromEntries(workload.executionBlockers.map(b => [b.field, b]))
    expect(byField['one_time_fee:Delivery fee']).toMatchObject({ event_type: 'delivery' })
    expect(byField['one_time_fee:Acceptance fee']).toMatchObject({ event_type: 'customer_acceptance' })
  })

  it('counterexample — "delivery shall constitute acceptance" uses the contract\'s own stated trigger (delivery), never a generic collapsed rule', () => {
    // The extraction PROMPT instructs the model to use the contract's own
    // stated equivalence rather than inventing "delivery always equals
    // acceptance" — this fixture proves the NORMALIZATION layer at least
    // faithfully preserves whichever event_type extraction (correctly)
    // returns for this clause, without further collapsing it itself.
    const fee = extractOne({ billability_condition: { kind: 'event', event_type: 'delivery' } } as Partial<OneTimeFee>)
    expect(fee.billability_condition).toEqual({ kind: 'event', event_type: 'delivery' })
  })
})

describe('Scenario 6 — silence: no timing language must not become immediate', () => {
  it('the model explicitly engages with billability_condition and answers null (genuine silence) — normalizes to null, not immediate — stays an ordinary needs-review item', () => {
    const fee = extractOne({ due_date: null, billability_condition: null } as Partial<OneTimeFee>)
    expect(fee.billability_condition).toBeNull()
    expect(fee.billability_condition).not.toEqual({ kind: 'immediate' })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(workload.totalToConfirm).toBeGreaterThan(0)
    expect(approveWouldBlock(workload)).toBe(true)
  })
})

describe('Scenario 7 — deemed acceptance: remains unsupported if the first primitive cannot faithfully represent it', () => {
  it('a hand-constructed deemed-acceptance fee (elapsed review window + rejection-state evidence — outside the closed 5-event ontology) stays a capability blocker, never forced into an event', () => {
    const fee: OneTimeFee = {
      fee_label: 'Deemed Acceptance Milestone', amount: 100000, due_date: null, description: null,
      manual_trigger: true, amount_provenance: 'contract_derived',
      billability_condition: null, requires_confirmation: true, unresolved_kind: 'unsupported_semantics',
    }
    // No ordinary confirmation can resolve it.
    expect(() => buildOneTimeFeeConfirmation(fee, { confirmBillability: true })).toThrow(/capability-blocked/)
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee] }, { total: 0, confirmed: 0 })
    expect(workload.executionBlockers[0].type).toBe('unsupported_commercial_semantics')
    expect(approveWouldBlock(workload)).toBe(true)
  })
})

describe('Scenario 8 — legacy fee: no new condition field, previous Step-11 compatibility preserved', () => {
  it('a genuinely pre-Step-12 fee (billability_condition never set) behaves exactly as Step 11 specified', () => {
    const legacy: OneTimeFee = { fee_label: 'Legacy fee', amount: 5000, due_date: null, description: null }
    expect(legacy.billability_condition).toBeUndefined()
    const workload = computeCommercialRuleWorkload({ one_time_fees: [legacy] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload)).toBe(false) // exact Step 11 backward-compatibility behavior

    const legacyManualTrigger: OneTimeFee = { fee_label: 'Legacy PS fee', amount: 0, due_date: null, description: null, manual_trigger: true, metric_name: 'hours', rate_per_unit: 150 }
    const workload2 = computeCommercialRuleWorkload({ one_time_fees: [legacyManualTrigger] }, { total: 0, confirmed: 0 })
    expect(approveWouldBlock(workload2)).toBe(false)
    expect(legacyManualTrigger.billability_condition).toBeUndefined()
  })
})
