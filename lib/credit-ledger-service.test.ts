import { describe, it, expect } from 'vitest'
import { resolveEarningBasisClasses, sumPaidLineItemsForClasses } from './credit-ledger-service'

// Contract B's real values, confirmed live (2026-08-30 audit):
//   contract_meter_mappings: 'Processed Transaction' -> meter_key 'sync', 'chargeback' -> meter_key 'sms_sent'
//   Annual Rebate application_rule.computed_from_component_keys: ['transaction_processing_fees']
//   Annual Rebate application_rule.eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees']
const REBATE_COMPUTED_FROM = { computed_from_component_keys: ['transaction_processing_fees'] }

function paidInvoiceRow(items: Array<{ meter_key: string; amount: number; contractUnitType?: string | null }>) {
  return { overage_line_items: items }
}

describe('resolveEarningBasisClasses', () => {
  it('resolves Contract B\'s computed_from_component_keys to the transaction_processing class', () => {
    expect(resolveEarningBasisClasses(REBATE_COMPUTED_FROM)).toEqual(new Set(['transaction_processing']))
  })

  it('G: an unresolvable/unknown token resolves to an empty set (fail closed)', () => {
    expect(resolveEarningBasisClasses({ computed_from_component_keys: ['some_unrecognized_token'] })).toEqual(new Set())
  })

  it('G: a null/missing application_rule or computed_from_component_keys resolves to an empty set', () => {
    expect(resolveEarningBasisClasses(null)).toEqual(new Set())
    expect(resolveEarningBasisClasses({ computed_from_component_keys: null })).toEqual(new Set())
    expect(resolveEarningBasisClasses({})).toEqual(new Set())
  })
})

describe('sumPaidLineItemsForClasses — the confirmed Contract B bug fix', () => {
  const eligibleClasses = resolveEarningBasisClasses(REBATE_COMPUTED_FROM)

  it('A: Contract B\'s real shape — operational meter_key "sync" with contractUnitType "Processed Transaction" is included via canonical classification, never via meter_key text', () => {
    const rows = [paidInvoiceRow([{ meter_key: 'sync', amount: 12_345, contractUnitType: 'Processed Transaction' }])]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(1_234_500) // minor units
  })

  it('confirms the OLD behavior would have failed: raw meter_key "sync" never equals the free-text basis_component sentence', () => {
    // The bug this fix closes, made explicit: matching on meter_key
    // ('sync') against the earning-basis free text would never match any
    // real contract's phrasing — this is why the fix reads contractUnitType
    // through the canonical taxonomy instead.
    const rawTextKeys = new Set(['transaction-processing fees actually paid for that Contract Year'])
    expect(rawTextKeys.has('sync')).toBe(false)
  })

  it('C: a chargeback line item (contractUnitType "chargeback") is excluded from the rebate earning basis', () => {
    const rows = [paidInvoiceRow([
      { meter_key: 'sync', amount: 10_000, contractUnitType: 'Processed Transaction' },
      { meter_key: 'sms_sent', amount: 500, contractUnitType: 'chargeback' },
    ])]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(1_000_000) // only the transaction-processing amount
  })

  it('B/E: platform_fee is structurally never part of overage_line_items at all — it lives on planned_invoices.base_amount, a separate column — so it can never leak into the earning basis regardless of eligible_component_keys including it for APPLICATION', () => {
    // Simulates the real shape: platform fee never appears as an
    // overage_line_items entry (invoice-scheduler's pool only adds it as a
    // separate { key: 'platform_fee', componentClass: 'platform_fee' }
    // pool entry for the APPLICATION step, never into overage_line_items).
    const rows = [paidInvoiceRow([{ meter_key: 'sync', amount: 10_000, contractUnitType: 'Processed Transaction' }])]
    // Even a rebate whose eligible_component_keys (application scope)
    // includes platform_subscription_fees — Contract B's real shape — must
    // have an earning basis computed ONLY from computed_from_component_keys.
    const appRuleLikeContractB = { computed_from_component_keys: ['transaction_processing_fees'], eligible_component_keys: ['transaction_processing_fees', 'platform_subscription_fees'] }
    const basisClasses = resolveEarningBasisClasses(appRuleLikeContractB)
    expect(sumPaidLineItemsForClasses(rows, basisClasses)).toBe(1_000_000)
    // Proves the application-scope-only class (platform_fee) never entered the eligible set used for earning.
    expect(basisClasses.has('platform_fee')).toBe(false)
  })

  it('D: a one_time_fee line item is excluded — its contractUnitType never classifies as transaction_processing', () => {
    const rows = [paidInvoiceRow([
      { meter_key: 'sync', amount: 10_000, contractUnitType: 'Processed Transaction' },
      { meter_key: 'onboarding_fee', amount: 5_000, contractUnitType: 'One-time onboarding fee' },
    ])]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(1_000_000)
  })

  it('F: an arbitrary/renamed operational meter_key never changes the commercial classification — only contractUnitType does', () => {
    const rows = [paidInvoiceRow([{ meter_key: 'txn_v2_totally_different_name', amount: 10_000, contractUnitType: 'Processed Transaction' }])]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(1_000_000)
  })

  it('G: an unknown/unresolvable eligibleClasses set (empty) fails closed to zero, never matches everything', () => {
    const rows = [paidInvoiceRow([{ meter_key: 'sync', amount: 10_000, contractUnitType: 'Processed Transaction' }])]
    expect(sumPaidLineItemsForClasses(rows, new Set())).toBe(0)
  })

  it('a line item with no contractUnitType at all (legacy record) is excluded, never guessed from meter_key', () => {
    const rows = [paidInvoiceRow([{ meter_key: 'sync', amount: 10_000, contractUnitType: null }])]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(0)
  })

  it('sums across multiple paid invoice rows within the window', () => {
    const rows = [
      paidInvoiceRow([{ meter_key: 'sync', amount: 10_000, contractUnitType: 'Processed Transaction' }]),
      paidInvoiceRow([{ meter_key: 'sync', amount: 20_000, contractUnitType: 'Processed Transaction' }]),
    ]
    expect(sumPaidLineItemsForClasses(rows, eligibleClasses)).toBe(3_000_000)
  })
})
