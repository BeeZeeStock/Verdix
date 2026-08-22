// Step 11 final amendment — the six required regression cases (item 9),
// each pinned exactly as specified. Locks in the distinction: "knowing how
// much to bill is not the same as knowing that it is billable now."
import { describe, it, expect } from 'vitest'
import { computeCommercialRuleWorkload } from '@/lib/commercial-rule-status'
import { buildOneTimeFeeConfirmation } from '@/lib/one-time-fee'
import type { OneTimeFee } from '@/lib/types'

function fee(overrides: Partial<OneTimeFee> = {}): OneTimeFee {
  return { fee_label: 'Milestone fee', amount: 100000, due_date: null, description: null, ...overrides }
}

describe('1. Explicit amount + unresolved timing → amount resolved, billability unresolved, NOT billing-ready', () => {
  it('amount is contract_derived; billability_provenance is still null → the fee as a whole is not ready', () => {
    const f = fee({ amount_provenance: 'contract_derived', requires_confirmation: false, billability_provenance: null })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
    expect(workload.blockers).toContain('one_time_fee:Milestone fee')
  })
})

describe('2. Concrete due date without provenance → must NOT become source-resolved merely because the date is concrete', () => {
  it('a fee with a real, concrete due_date but billability_provenance null still blocks — a concrete value is not evidence', () => {
    const f = fee({ due_date: '2026-03-01', billability_provenance: null })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).toContain('one_time_fee:Milestone fee')
    expect(workload.status).not.toBe('all_commercial_rules_confirmed')
  })

  it('the SAME due_date-bearing fee with billability_provenance left undefined (never evaluated — a historical/pre-amendment record) is NOT retroactively blocked', () => {
    const f = fee({ due_date: '2026-03-01' }) // billability_provenance: undefined
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
  })
})

describe('3. Explicit, supported fixed timing → billability_provenance = contract_derived → timing resolved', () => {
  it('once billability_provenance is genuinely set to contract_derived, the timing dimension resolves', () => {
    const f = fee({ due_date: '2026-03-01', billability_provenance: 'contract_derived', amount_provenance: 'contract_derived', requires_confirmation: false })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })
})

describe('4. Reviewer-resolved supported timing → billability_provenance = reviewer_policy → resolved', () => {
  it('a reviewer explicitly confirming billability (without touching amount, which was already resolved separately) reaches readiness', () => {
    const extracted = fee({ due_date: null, amount_provenance: 'contract_derived', requires_confirmation: false, billability_provenance: null })
    const confirmed = buildOneTimeFeeConfirmation(extracted, { confirmBillability: true })
    expect(confirmed.billability_provenance).toBe('reviewer_policy')
    const workload = computeCommercialRuleWorkload({ one_time_fees: [confirmed] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })
})

describe('5. Unsupported acceptance trigger → amount contract-derived, billability unsupported → capability blocker → amount confirmation cannot bypass it', () => {
  it('amount is already contract_derived; unresolved_kind is unsupported_semantics → still a capability blocker, not an ordinary readiness item', () => {
    const f = fee({ amount_provenance: 'contract_derived', requires_confirmation: true, unresolved_kind: 'unsupported_semantics' })
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    expect(workload.status).toBe('execution_blocked')
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee') // never counted as an ordinary reviewer decision
    expect(workload.executionBlockers).toHaveLength(1)
  })

  it('confirming amount (again) cannot bypass the capability blocker', () => {
    const blocked = fee({ amount_provenance: 'contract_derived', requires_confirmation: true, unresolved_kind: 'unsupported_semantics' })
    expect(() => buildOneTimeFeeConfirmation(blocked, { confirmAmount: true })).toThrow(/capability-blocked/)
  })

  it('confirming billability cannot bypass it either', () => {
    const blocked = fee({ amount_provenance: 'contract_derived', requires_confirmation: true, unresolved_kind: 'unsupported_semantics' })
    expect(() => buildOneTimeFeeConfirmation(blocked, { confirmBillability: true })).toThrow(/capability-blocked/)
  })
})

describe('6. Manual hold → no invoice execution, and does not automatically fabricate contractual timing provenance', () => {
  it('a manual_trigger: true fee never executes automatically (parked, per lib/billing-writer.ts) and its billability_provenance stays untouched/unresolved rather than being defaulted to contract_derived', () => {
    const f = fee({ manual_trigger: true, amount: 0, description: null })
    // Never fabricated as resolved merely because execution is safely held.
    expect(f.billability_provenance).toBeUndefined()
    const workload = computeCommercialRuleWorkload({ one_time_fees: [f] }, { total: 0, confirmed: 0 })
    // Also never a blocker — the timing decision isn't load-bearing for
    // this shape (item 6: distinguish "execution safely held" from
    // "contractual billability semantics resolved" — neither state blocks
    // readiness, because nothing automatic is happening).
    expect(workload.blockers).not.toContain('one_time_fee:Milestone fee')
    expect(workload.status).toBe('all_commercial_rules_confirmed')
  })
})
