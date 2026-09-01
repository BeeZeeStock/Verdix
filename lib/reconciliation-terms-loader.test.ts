import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FULL_RECONCILIATION_TERMS_COLUMNS, loadFullReconciliationTermsForJob, buildFreshLineItemsFromPersistedTerms } from './reconciliation-terms-loader'

// Step 17H.4B0D4H1B3.2 — the canonical full-terms column list must include
// every field buildLineItems' own call graph reads, including discounts
// (computeDiscountMultiplier, lib/tariff.ts) — the exact field confirm-
// rule's own hand-picked select omitted before this pass.
describe('FULL_RECONCILIATION_TERMS_COLUMNS', () => {
  it('includes every field buildLineItems and its calculation primitives read', () => {
    for (const field of [
      'base_monthly_fee', 'base_annual_fee', 'ramp_schedule', 'year_pricing',
      'contract_start_date', 'contract_end_date', 'contract_term_months', 'billing_frequency',
      'currency', 'field_sources', 'extraction_confidence',
      'base_fee_proration', 'additional_recurring_fees', 'overage_tiers', 'one_time_fees', 'escalators',
      'discounts', // the field this pass found missing from confirm-rule's own select
    ]) {
      expect(FULL_RECONCILIATION_TERMS_COLUMNS).toContain(field)
    }
  })
})

function mockSupabase(termsRow: unknown, jobRow: unknown = { currency: 'EUR' }): SupabaseClient {
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'contract_terms') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: termsRow, error: null }) }) }) }
    }
    if (table === 'jobs') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: jobRow, error: null }) }) }) }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { from } as unknown as SupabaseClient
}

describe('loadFullReconciliationTermsForJob', () => {
  it('returns null when no contract_terms row exists', async () => {
    const client = mockSupabase(null)
    const result = await loadFullReconciliationTermsForJob(client, 'job-1')
    expect(result).toBeNull()
  })

  it('prefers jobs.currency, falling back to contract_terms.currency, then USD', async () => {
    const client1 = mockSupabase({ currency: 'SEK' }, { currency: 'EUR' })
    expect((await loadFullReconciliationTermsForJob(client1, 'job-1'))!.currency).toBe('EUR')

    const client2 = mockSupabase({ currency: 'SEK' }, { currency: null })
    expect((await loadFullReconciliationTermsForJob(client2, 'job-1'))!.currency).toBe('SEK')

    const client3 = mockSupabase({}, { currency: null })
    expect((await loadFullReconciliationTermsForJob(client3, 'job-1'))!.currency).toBe('USD')
  })
})

describe('buildFreshLineItemsFromPersistedTerms', () => {
  it('returns null when the underlying load returns null', async () => {
    const client = mockSupabase(null)
    const result = await buildFreshLineItemsFromPersistedTerms(client, 'job-1')
    expect(result).toBeNull()
  })
})
