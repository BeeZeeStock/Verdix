import { describe, it, expect } from 'vitest'
import { applyExtractionSafetyNets } from './contract-extractor'
import type { ContractTerms } from './types'

// Step 17F.3, item 2/8/15 (acceptance scenarios A/B/C) — fixed_fee_billing_
// timing must never be silently defaulted; a blanket safety net (unlike
// base_fee_proration, which only fires under specific trigger conditions)
// attaches an UNRESOLVED default whenever a base fee exists and the model
// produced no structured answer, and never overrides a genuine explicit
// extraction.
function baseTerms(overrides: Partial<ContractTerms> = {}): ContractTerms {
  return {
    customer_name: 'Test AB', currency: 'EUR', one_time_fees: [],
    discounts: [], service_credits: [], overage_tiers: [], escalators: [],
    additional_recurring_fees: [],
    ...overrides,
  } as ContractTerms
}

describe('applyExtractionSafetyNets — fixed_fee_billing_timing (Step 17F.3, item 2)', () => {
  it('scenario A — the model explicitly extracted bill_at_period_start (contract states "billed monthly in advance") is preserved verbatim, never overridden', () => {
    const terms = baseTerms({
      base_monthly_fee: 2000,
      fixed_fee_billing_timing: {
        timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null,
        source_clause: 'Fees are billed monthly in advance.',
      },
    })
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing).toEqual({
      timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null,
      source_clause: 'Fees are billed monthly in advance.',
    })
  })

  it('scenario B — the model explicitly extracted bill_at_period_end (contract states fee is invoiced at month-end) is preserved verbatim', () => {
    const terms = baseTerms({
      base_monthly_fee: 2000,
      fixed_fee_billing_timing: {
        timing: 'bill_at_period_end', requires_confirmation: false, confirmation_reason: null,
        source_clause: 'The monthly fee is invoiced at the end of each calendar month.',
      },
    })
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing?.timing).toBe('bill_at_period_end')
    expect(out.fixed_fee_billing_timing?.requires_confirmation).toBe(false)
  })

  it('scenario C — the contract only states "monthly fee" + "30-day payment terms" (no explicit timing at all): the model produces nothing, the safety net defaults to unresolved, never bill_at_period_start', () => {
    const terms = baseTerms({ base_monthly_fee: 2000, payment_terms_days: 30 })
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing).toMatchObject({ timing: 'unclear', requires_confirmation: true })
  })

  it('never inferred from "monthly" cadence alone, or from payment_terms_days, even when both are present — same as scenario C', () => {
    const terms = baseTerms({ base_monthly_fee: 5000, billing_frequency: 'monthly', payment_terms_days: 30, payment_terms_text: 'Net 30' } as Partial<ContractTerms>)
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing?.timing).toBe('unclear')
    expect(out.fixed_fee_billing_timing?.requires_confirmation).toBe(true)
  })

  it('a contract with no fixed fee at all (base_monthly_fee and base_annual_fee both unset) gets no rule attached — nothing to time', () => {
    const terms = baseTerms()
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing).toBeUndefined()
  })

  it('a base_annual_fee (not monthly) also triggers the safety net', () => {
    const terms = baseTerms({ base_annual_fee: 24000 } as Partial<ContractTerms>)
    const out = applyExtractionSafetyNets(terms)
    expect(out.fixed_fee_billing_timing?.timing).toBe('unclear')
  })
})
