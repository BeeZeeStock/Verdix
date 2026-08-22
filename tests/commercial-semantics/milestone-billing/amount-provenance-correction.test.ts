// Step 11 final correction, item 1 — amount readiness now canonically
// driven by amount_provenance, symmetric with billability_provenance.
// The five required regression cases, each pinned exactly as specified.
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import type { OneTimeFee } from '@/lib/types'

function fee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
  return { fee_label: 'Milestone fee', amount: 100000, due_date: null, description: null, ...overrides }
}

describe('amount readiness matrix (Step 11 final correction, item 1)', () => {
  it('concrete amount + null provenance → unresolved', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee({ amount_provenance: null })] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('one_time_fee:Milestone fee')
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('concrete amount + verdix_recommends → unresolved (AI confidence is not provenance, same doctrine as every other field)', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee({ amount_provenance: 'verdix_recommends' })] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('one_time_fee:Milestone fee')
  })

  it('concrete amount + contract_derived → resolved', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee({ amount_provenance: 'contract_derived' })] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('concrete amount + reviewer_policy → resolved', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee({ amount_provenance: 'reviewer_policy' })] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('legacy concrete amount + undefined provenance → preserves historical compatibility (not retroactively reopened)', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee()] }, { total: 0, confirmed: 0 }) // amount_provenance: undefined
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })

  it('legacy fee with requires_confirmation: true and amount_provenance undefined still blocks via the legacy fallback (original Step 11 behavior preserved)', () => {
    const workload = computeCommercialRuleWorkload({ one_time_fees: [fee({ requires_confirmation: true })] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('one_time_fee:Milestone fee')
  })

  it('requires_confirmation never substitutes for provenance once amount_provenance has actually been evaluated (item 1) — a resolved provenance wins even if requires_confirmation is stale/true', () => {
    const workload = computeCommercialRuleWorkload(
      { one_time_fees: [fee({ amount_provenance: 'contract_derived', requires_confirmation: true })] },
      { total: 0, confirmed: 0 },
    )
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
  })

})
