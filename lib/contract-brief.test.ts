import { describe, it, expect } from 'vitest'
import { buildContractBrief, type ContractBriefTerms } from './contract-brief'

describe('buildContractBrief — Step 17G.2', () => {
  it('returns nothing when there are no terms', () => {
    expect(buildContractBrief(undefined, 'EUR')).toEqual([])
  })

  // The real Remembill/NordicFit contract — job a4459e99-f920-41ff-9c8b-
  // 0789f1100b0f. Fixed (base_monthly_fee) + usage (flat per-unit fees +
  // overage tier) + performance (percentage_of_basis) + a 90-day pilot
  // waiver + auto-renewal with 3 months' notice — every category present
  // at once, matching Step 17G.2's own worked example.
  it('Remembill: fixed + usage + performance, pilot waiver, auto-renewal — matches the required factual content', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'NordicFit Test AB',
      contract_term_months: 12,
      contract_start_date: '2026-10-01',
      contract_end_date: '2027-09-30',
      base_monthly_fee: 2000,
      additional_recurring_fees: [
        { rate_per_unit: 0.38 },
        { rate_per_unit: 1.70 },
        { percentage_of_basis: { schedule: 'x' } },
      ],
      overage_tiers: [{ rate_per_unit: 0.60 }],
      discounts: [{
        discount_pct: 100, duration_days: 90, affected_components: ['base_recurring_fee'],
      }],
      auto_renews: true,
      renewal_notice_months: 3,
    }
    const lines = buildContractBrief(terms, 'SEK')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('12-month agreement with NordicFit Test AB from 1 Oct 2026 to 30 Sept 2027.')
    expect(lines[1]).toContain('SEK')
    expect(lines[1]).toContain('2,000')
    expect(lines[1]).toContain('usage-based charges')
    expect(lines[1]).toContain('a performance-based fee')
    expect(lines[2]).toBe('90-day pilot: fixed platform fee waived.')
    expect(lines[3]).toBe("The agreement renews automatically unless terminated with 3 months' notice.")
    // Target range: 40-80 words for a normal agreement.
    const wordCount = lines.join(' ').split(/\s+/).length
    expect(wordCount).toBeGreaterThanOrEqual(30)
    expect(wordCount).toBeLessThanOrEqual(80)
  })

  it('fixed-fee-only contract: no usage, no performance, no pilot, no renewal mention', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'Company A',
      contract_term_months: 24,
      contract_start_date: '2026-01-01',
      contract_end_date: '2027-12-31',
      base_monthly_fee: 10000,
    }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('24-month agreement with Company A')
    expect(lines[1]).toMatch(/^The customer pays €10,000\.00\/month platform fee\.$/)
    // Never invent categories that aren't present.
    expect(lines.join(' ')).not.toContain('usage')
    expect(lines.join(' ')).not.toContain('performance')
  })

  it('fixed + usage contract (no performance): generic "fixed subscription" phrasing when no single monthly figure is stated', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'Company B',
      contract_term_months: 12,
      year_pricing: { year1: 12000 },
      overage_tiers: [{ rate_per_unit: 1 }],
    }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines[0]).toContain('Company B')
    expect(lines.some(l => l.includes('fixed subscription') && l.includes('usage-based charges'))).toBe(true)
    expect(lines.join(' ')).not.toContain('performance')
  })

  it('outcome/performance-only contract: no fixed fee, no usage', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'Company C',
      additional_recurring_fees: [{ percentage_of_basis: { schedule: 'x' } }],
    }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines).toContain('Commercial consideration is primarily performance/outcome based.')
    expect(lines.join(' ')).not.toContain('usage-based')
    expect(lines.join(' ')).not.toMatch(/platform fee/)
  })

  it('usage-only contract (no fixed fee, no performance)', () => {
    const terms: ContractBriefTerms = { customer_name: 'Company D', overage_tiers: [{ rate_per_unit: 2 }] }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines).toContain('Pricing is usage-based.')
  })

  it('contract with no renewal clause stated (auto_renews null/undefined): renewal sentence omitted entirely, not an "unclear" disclaimer', () => {
    const terms: ContractBriefTerms = { customer_name: 'Company E', base_monthly_fee: 500 }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines.join(' ')).not.toMatch(/renew/i)
    expect(lines.join(' ')).not.toMatch(/unclear/i)
  })

  it('contract that explicitly does not auto-renew states so plainly', () => {
    const terms: ContractBriefTerms = { customer_name: 'Company F', base_monthly_fee: 500, contract_term_months: 12, auto_renews: false }
    const lines = buildContractBrief(terms, 'EUR')
    expect(lines).toContain('The agreement does not auto-renew.')
  })

  it('never mentions internal/raw field-name jargon', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'Company G', base_monthly_fee: 1000,
      additional_recurring_fees: [{ percentage_of_basis: { schedule: 'x' } }],
      overage_tiers: [{ rate_per_unit: 1 }],
      discounts: [{ discount_pct: 50, affected_components: ['base_recurring_fee'] }],
    }
    const text = buildContractBrief(terms, 'EUR').join(' ')
    for (const jargon of ['base_recurring_fee', 'percentage_of_basis', 'derived_metric', 'semantic_input_key', 'affected_components']) {
      expect(text).not.toContain(jargon)
    }
  })

  it('a 100% pilot discount scoped to the fixed component never reads as "the whole contract is free"', () => {
    const terms: ContractBriefTerms = {
      customer_name: 'Company H', base_monthly_fee: 1000,
      additional_recurring_fees: [{ percentage_of_basis: { schedule: 'x' } }],
      discounts: [{ discount_pct: 100, duration_days: 90, affected_components: ['base_recurring_fee'] }],
    }
    const text = buildContractBrief(terms, 'EUR').join(' ')
    expect(text).not.toMatch(/100% (introductory )?discount/)
    expect(text).toContain('fixed platform fee waived')
  })
})
