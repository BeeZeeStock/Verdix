import { describe, it, expect } from 'vitest'
import { hasOperationalBillingModel, configuredBadgeSuffix } from './operational-section-visibility'

describe('hasOperationalBillingModel — Step 17F.8, item 1 (revised 17F.9, item 2)', () => {
  it('a configured contract (real persisted schedule exists) stays visible even when review reopens', () => {
    // The exact real Remembill scenario this step fixes: already pushed
    // (13 real planned_invoices rows), but new blockers (fixed_fee_billing_
    // timing, variable_invoice_timing) have made reviewComplete false again.
    expect(hasOperationalBillingModel({ reviewComplete: false, hasPersistedSchedule: true })).toBe(true)
  })

  it('a fully reviewed contract not yet pushed to any platform is still visible (original 17E.1 intent preserved)', () => {
    expect(hasOperationalBillingModel({ reviewComplete: true, hasPersistedSchedule: false })).toBe(true)
  })

  it('a contract neither reviewed nor with a persisted schedule is correctly hidden — nothing operational exists yet', () => {
    expect(hasOperationalBillingModel({ reviewComplete: false, hasPersistedSchedule: false })).toBe(false)
    expect(hasOperationalBillingModel({ reviewComplete: false, hasPersistedSchedule: null })).toBe(false)
    expect(hasOperationalBillingModel({ reviewComplete: false, hasPersistedSchedule: undefined })).toBe(false)
  })

  it('a fully resolved, pushed contract is of course visible', () => {
    expect(hasOperationalBillingModel({ reviewComplete: true, hasPersistedSchedule: true })).toBe(true)
  })

  // Step 17F.9, item 2 — the exact gap that made billing_customer_id too
  // weak: a customer was created remotely (billing_customer_id would be
  // set) but the push failed before any invoice/schedule row was ever
  // written — hasPersistedSchedule correctly stays false for this job,
  // never presenting a half-failed push as an operating contract.
  it('a job whose push created a remote customer but failed before any schedule row exists is NOT presented as operational', () => {
    expect(hasOperationalBillingModel({ reviewComplete: false, hasPersistedSchedule: false })).toBe(false)
  })
})

describe('configuredBadgeSuffix — Step 17F.8, item 10 (revised 17F.9, item 1)', () => {
  it('outstanding blockers -> "Configured in <platform>" gets the qualifier', () => {
    expect(configuredBadgeSuffix(3)).toBe(' · Action required')
  })

  it('fully resolved (zero outstanding across the SAME aggregate count) -> no qualifier', () => {
    expect(configuredBadgeSuffix(0)).toBe('')
  })

  // Step 17F.9, item 1's explicit required regression — reviewComplete
  // alone would have missed this: 0 commercial decisions outstanding but
  // a usage mapping still unresolved must still show the qualifier,
  // since configuredBadgeSuffix now takes the SAME aggregate total the
  // "N items to review" callout uses (commercial decisions + usage
  // mappings + ...), never reviewComplete alone.
  it('0 commercial decisions + 1 usage mapping outstanding -> still "Action required"', () => {
    const commercialDecisionsOutstanding = 0
    const usageMappingsOutstanding = 1
    const totalOutstanding = commercialDecisionsOutstanding + usageMappingsOutstanding
    expect(configuredBadgeSuffix(totalOutstanding)).toBe(' · Action required')
  })

  it('0 commercial decisions + 0 usage mappings outstanding -> no qualifier', () => {
    const commercialDecisionsOutstanding = 0
    const usageMappingsOutstanding = 0
    const totalOutstanding = commercialDecisionsOutstanding + usageMappingsOutstanding
    expect(configuredBadgeSuffix(totalOutstanding)).toBe('')
  })
})
