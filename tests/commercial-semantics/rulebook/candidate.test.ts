// Verdix Global Rulebook — candidate domain model (Step 9). Pure tests for
// lib/rulebook/candidate.ts: origin guards making customer-derived
// candidates structurally impossible, and the lifecycle status union.
import { describe, it, expect } from 'vitest'
import {
  isAllowedCandidateOrigin, assertNotCustomerDerivedOrigin,
  FORBIDDEN_CANDIDATE_ORIGINS, type VerdixCandidateOrigin,
} from '@/lib/rulebook/candidate'

const ALLOWED: VerdixCandidateOrigin[] = ['verdix_synthetic_test', 'verdix_internal_test', 'public_commercial_research']

describe('candidate origin — customer-derived data structurally cannot enter the Global Rulebook lifecycle (item 2)', () => {
  it('accepts exactly the three Verdix-controlled origins', () => {
    for (const origin of ALLOWED) {
      expect(isAllowedCandidateOrigin(origin)).toBe(true)
      expect(() => assertNotCustomerDerivedOrigin(origin)).not.toThrow()
    }
  })

  it('rejects every explicitly forbidden origin string', () => {
    for (const origin of FORBIDDEN_CANDIDATE_ORIGINS) {
      expect(isAllowedCandidateOrigin(origin)).toBe(false)
      expect(() => assertNotCustomerDerivedOrigin(origin)).toThrow(/not allowed/)
    }
  })

  it('the forbidden list is exactly the four named in the spec — customer_contract, organization_rulebook, customer_reviewer_pattern, cross_customer_pattern', () => {
    expect([...FORBIDDEN_CANDIDATE_ORIGINS].sort()).toEqual(
      ['cross_customer_pattern', 'customer_contract', 'customer_reviewer_pattern', 'organization_rulebook'].sort(),
    )
  })

  it('rejects an arbitrary unknown origin string too, not just the four named ones', () => {
    expect(isAllowedCandidateOrigin('some_new_customer_source')).toBe(false)
    expect(() => assertNotCustomerDerivedOrigin('some_new_customer_source')).toThrow()
  })

  it('the assertion error names the allowed set, so a rejection is actionable, not opaque', () => {
    try {
      assertNotCustomerDerivedOrigin('customer_contract', 'test context')
      expect.unreachable()
    } catch (err) {
      expect(String(err)).toMatch(/verdix_synthetic_test/)
      expect(String(err)).toMatch(/test context/)
    }
  })
})
