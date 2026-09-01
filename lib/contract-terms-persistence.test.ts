import { describe, it, expect } from 'vitest'
import { buildContractTermsUpsertPayload } from './contract-terms-persistence'
import type { ContractTerms } from './types'

const MINIMAL_TERMS = {} as ContractTerms

describe('buildContractTermsUpsertPayload — fixed_fee_billing_timing (17H.4B0D4H1B4E3.3 §7)', () => {
  it('is included in the payload — previously omitted entirely, silently never persisted by any extraction pass', () => {
    const terms: ContractTerms = {
      ...MINIMAL_TERMS,
      fixed_fee_billing_timing: { timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'clause X' },
    }
    const payload = buildContractTermsUpsertPayload('job-1', terms)
    expect(payload.fixed_fee_billing_timing).toEqual({ timing: 'bill_at_period_start', requires_confirmation: false, confirmation_reason: null, source_clause: 'clause X' })
  })

  it('defaults to null when absent, matching base_fee_proration\'s own null-default convention', () => {
    const payload = buildContractTermsUpsertPayload('job-1', MINIMAL_TERMS)
    expect(payload.fixed_fee_billing_timing).toBeNull()
    expect(payload.base_fee_proration).toBeNull()
  })
})
