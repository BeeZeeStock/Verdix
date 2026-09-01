import { describe, it, expect } from 'vitest'
import { planCurrentLineItemReconciliation, type CurrentLineItemRow, type FreshLineItemLike, type ReconciliationTermsContext } from './current-line-item-reconciliation-plan'

function current(overrides: Partial<CurrentLineItemRow> & { id: string }): CurrentLineItemRow {
  return {
    product_name: 'Row', quantity: 1, unit_price: 10, billing_period: 'monthly', total_amount: 10,
    confidence_score: 0.95, currency: 'EUR', stripe_price_id: null, applied_rule: null, correction_reason: null,
    source_section: null, reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true,
    reviewer_corrected_at: null, fee_id: null, tier_id: null, recurring_fee_id: null,
    ...overrides,
  }
}

function fresh(overrides: Partial<FreshLineItemLike> = {}): FreshLineItemLike {
  return {
    product_name: 'Row', quantity: 1, unit_price: 10, billing_period: 'monthly', total_amount: 10,
    confidence_score: 0.95, source_section: null, fee_id: null, tier_id: null,
    ...overrides,
  }
}

const EMPTY_TERMS: ReconciliationTermsContext = { overage_tiers: [], additional_recurring_fees: [], base_fee_proration: null }

function termsWithTiers(tierLabels: Array<{ tier_id?: string | null; tier_label: string }>): ReconciliationTermsContext {
  return { ...EMPTY_TERMS, overage_tiers: tierLabels }
}

describe('planCurrentLineItemReconciliation — ONE-TIME strong-ID SAME (17H.4B0D4H1B1 §35)', () => {
  it('1. unique fee_id A <-> A: SAME, no update emitted — a no-op SAME pair is never an UPDATE operation', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, unit_price: 100, total_amount: 100, fee_id: 'A' })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, unit_price: 100, total_amount: 100, fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1']) // still fully accounted for despite no update
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('2. current fee_id=NULL + fresh fee_id=A, unique legacy bridge: SAME + promote fee_id=A', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: null })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([{ id: 'c1', changes: { fee_id: 'A' }, family: 'one_time', reason: 'same' }])
    expect(plan.blockers).toEqual([])
  })

  it('3. A vs B same label (different real fee_id): integrity_conflict blocker, no structural mutation', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'A' })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'B' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers).toEqual([{ family: 'one_time', reason: 'ambiguous', affectedCurrentIds: ['c1'] }])
    expect(plan.updates).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('4. duplicate current fee_id A across two rows: blocker, no structural mutation', () => {
    const c = [
      current({ id: 'c1', product_name: 'Setup fee A', billing_period: 'one_time', fee_id: 'A' }),
      current({ id: 'c2', product_name: 'Setup fee B', billing_period: 'one_time', fee_id: 'A' }),
    ]
    const f = [fresh({ product_name: 'Setup fee A', billing_period: 'one_time', fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers.length).toBe(1)
    expect(plan.blockers[0].family).toBe('one_time')
    expect(plan.blockers[0].affectedCurrentIds.sort()).toEqual(['c1', 'c2'])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('5. duplicate fresh fee_id A across two fresh rows: bijectivity conflict, blocker', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'A' })]
    const f = [
      fresh({ product_name: 'Setup fee X', billing_period: 'one_time', fee_id: 'A' }),
      fresh({ product_name: 'Setup fee Y', billing_period: 'one_time', fee_id: 'A' }),
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers.length).toBe(1)
    expect(plan.blockers[0].reason).toBe('ambiguous')
    expect(plan.inserts).toEqual([])
  })

  it('6. positive fee_id match survives a complete label change', () => {
    const c = [current({ id: 'c1', product_name: 'Old label entirely', billing_period: 'one_time', fee_id: 'A' })]
    const f = [fresh({ product_name: 'Brand new label after correction', billing_period: 'one_time', fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers).toEqual([])
    expect(plan.updates.length).toBe(1)
    expect(plan.updates[0].changes.product_name).toBe('Brand new label after correction') // complete=true, not reviewer-owned -> refreshed
  })
})

describe('planCurrentLineItemReconciliation — TIER strong-ID SAME (17H.4B0D4H1B1 §35)', () => {
  it('1. unique tier_id A <-> A: SAME, no update emitted — a no-op SAME pair is never an UPDATE operation', () => {
    const c = [current({ id: 'c1', product_name: 'Calls 1-10,000', quantity: 0, tier_id: 'A' })]
    const f = [fresh({ product_name: 'Calls 1-10,000', quantity: 0, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Calls 1-10,000' }]) })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
  })

  it('2. current tier_id=NULL + fresh tier_id=A, unique legacy bridge: SAME + promote tier_id=A', () => {
    const c = [current({ id: 'c1', product_name: 'Overage', quantity: 0, tier_id: null })]
    const f = [fresh({ product_name: 'Overage', quantity: 0, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Overage' }]) })
    expect(plan.updates).toEqual([{ id: 'c1', changes: { tier_id: 'A' }, family: 'tier', reason: 'same' }])
  })

  it('3. A vs B same label: integrity_conflict blocker', () => {
    const c = [current({ id: 'c1', product_name: 'Overage', quantity: 0, tier_id: 'A' })]
    const f = [fresh({ product_name: 'Overage', quantity: 0, tier_id: 'B' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'B', tier_label: 'Overage' }]) })
    expect(plan.blockers.length).toBe(1)
    expect(plan.blockers[0].family).toBe('tier')
  })

  it('4. duplicate current tier_id A: blocker', () => {
    const c = [
      current({ id: 'c1', product_name: 'Tier A', quantity: 0, tier_id: 'A' }),
      current({ id: 'c2', product_name: 'Tier B', quantity: 0, tier_id: 'A' }),
    ]
    const f = [fresh({ product_name: 'Tier A', quantity: 0, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Tier A' }]) })
    expect(plan.blockers.length).toBe(1)
    expect(plan.blockers[0].affectedCurrentIds.sort()).toEqual(['c1', 'c2'])
  })

  it('5. duplicate fresh tier_id A: blocker', () => {
    const c = [current({ id: 'c1', product_name: 'Overage', quantity: 0, tier_id: 'A' })]
    const f = [
      fresh({ product_name: 'Overage X', quantity: 0, tier_id: 'A' }),
      fresh({ product_name: 'Overage Y', quantity: 0, tier_id: 'A' }),
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Overage X' }, { tier_id: 'A', tier_label: 'Overage Y' }]) })
    expect(plan.blockers.length).toBe(1)
  })

  it('6. positive tier_id match survives label change', () => {
    const c = [current({ id: 'c1', product_name: 'Old tier label', quantity: 0, tier_id: 'A' })]
    const f = [fresh({ product_name: 'New tier label after correction', quantity: 0, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'New tier label after correction' }]) })
    expect(plan.blockers).toEqual([])
    expect(plan.updates[0].changes.product_name).toBe('New tier label after correction')
  })
})

describe('planCurrentLineItemReconciliation — residual lifecycle (17H.4B0D4H1B1 §36, both strong-ID families)', () => {
  for (const family of ['tier', 'one_time'] as const) {
    const isTier = family === 'tier'
    // source_section deliberately differs between current/fresh so every
    // genuine SAME pair below produces a REAL, verifiable update (proving
    // correct pairing, not merely "no error") rather than a pruned no-op —
    // see §7's no-op-pruning doctrine, tested directly elsewhere.
    const mk = (id: string, label: string, idVal: string | null) => isTier
      ? current({ id, product_name: label, quantity: 0, tier_id: idVal, source_section: 'Old clause' })
      : current({ id, product_name: label, billing_period: 'one_time', fee_id: idVal, source_section: 'Old clause' })
    const mkF = (label: string, idVal: string | null) => isTier
      ? fresh({ product_name: label, quantity: 0, tier_id: idVal, source_section: 'New clause' })
      : fresh({ product_name: label, billing_period: 'one_time', fee_id: idVal, source_section: 'New clause' })
    const termsFor = (ids: Array<{ id: string; label: string }>): ReconciliationTermsContext => isTier
      ? termsWithTiers(ids.map(({ id, label }) => ({ tier_id: id, tier_label: label })))
      : EMPTY_TERMS

    describe(`family=${family}`, () => {
      it('1. current A/B/C, fresh A/B/C/D -> A/B/C SAME, D NEW', () => {
        const c = [mk('c1', 'A', 'A'), mk('c2', 'B', 'B'), mk('c3', 'C', 'C')]
        const f = [mkF('A', 'A'), mkF('B', 'B'), mkF('C', 'C'), mkF('D', 'D')]
        const terms = termsFor([{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'C', label: 'C' }, { id: 'D', label: 'D' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
        expect(plan.updates.map(u => u.id).sort()).toEqual(['c1', 'c2', 'c3'])
        expect(plan.inserts.length).toBe(1)
        expect(plan.inserts[0].row.product_name).toBe('D')
        expect(plan.supersedes).toEqual([])
        expect(plan.blockers).toEqual([])
      })

      it('2. current A/B/C/D, fresh A/B/C -> A/B/C SAME, D REMOVED', () => {
        const c = [mk('c1', 'A', 'A'), mk('c2', 'B', 'B'), mk('c3', 'C', 'C'), mk('c4', 'D', 'D')]
        const f = [mkF('A', 'A'), mkF('B', 'B'), mkF('C', 'C')]
        const terms = termsFor([{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'C', label: 'C' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
        expect(plan.updates.map(u => u.id).sort()).toEqual(['c1', 'c2', 'c3'])
        expect(plan.supersedes).toEqual([{ id: 'c4', family, reason: 'removed' }])
        expect(plan.inserts).toEqual([])
        expect(plan.blockers).toEqual([])
      })

      it('3. current A/B/C, fresh A/B/X -> A/B SAME, C+X UNKNOWN (never remove+new) — and, per 17H.4B0D4H1B1.1 §3, the residual drift blocks the WHOLE family, so even A/B\'s otherwise-clean refresh is suppressed', () => {
        const c = [mk('c1', 'A', 'A'), mk('c2', 'B', 'B'), mk('c3', 'C', 'C')]
        const f = [mkF('A', 'A'), mkF('B', 'B'), mkF('X', 'X')]
        const terms = termsFor([{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'X', label: 'X' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
        // The family-wide block (proven by the residual_identity_drift
        // blocker below) suppresses ordinary refresh for A/B too — they
        // are still correctly paired (present in expectedCurrentRowIds,
        // absent from supersedes), just with no UPDATE emitted.
        expect(plan.updates).toEqual([])
        expect(plan.expectedCurrentRowIds).toEqual(['c1', 'c2', 'c3'])
        expect(plan.inserts).toEqual([])
        expect(plan.supersedes).toEqual([])
        expect(plan.blockers.length).toBe(1)
        expect(plan.blockers[0].reason).toBe('residual_identity_drift')
        expect(plan.blockers[0].affectedCurrentIds).toEqual(['c3'])
      })

      it('4. current empty, fresh A -> A NEW', () => {
        const f = [mkF('A', 'A')]
        const terms = termsFor([{ id: 'A', label: 'A' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: [], freshItems: f, terms })
        expect(plan.inserts.length).toBe(1)
        expect(plan.blockers).toEqual([])
      })

      it('5. current A, fresh empty -> A REMOVED', () => {
        const c = [mk('c1', 'A', 'A')]
        const terms = termsFor([{ id: 'A', label: 'A' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms })
        expect(plan.supersedes).toEqual([{ id: 'c1', family, reason: 'removed' }])
        expect(plan.blockers).toEqual([])
      })

      it('6. family ambiguity blocks residual lifecycle inference entirely', () => {
        const c = [mk('c1', 'A', 'A'), mk('c2', 'A-dup', 'A'), mk('c3', 'Standalone', 'STANDALONE')]
        const f = [mkF('A', 'A'), mkF('Standalone', 'STANDALONE'), mkF('New one', 'NEWONE')]
        const terms = termsFor([{ id: 'A', label: 'A' }, { id: 'STANDALONE', label: 'Standalone' }, { id: 'NEWONE', label: 'New one' }])
        const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
        // c1/c2 share tier_id A -> duplicate current id -> family blocked
        expect(plan.blockers.some(b => b.family === family)).toBe(true)
        // No structural mutation for this family despite the "New one" fresh row existing.
        expect(plan.inserts.filter(i => i.family === family)).toEqual([])
        expect(plan.supersedes.filter(s => s.family === family)).toEqual([])
        // c3/Standalone was itself a clean, unambiguous SAME pair (and
        // would ordinarily refresh source_section) — but the family is
        // blocked as a WHOLE (17H.4B0D4H1B1.1 §3), so even c3's ordinary
        // refresh is suppressed: no update for the entire family.
        expect(plan.updates.filter(u => u.family === family)).toEqual([])
      })
    })
  }
})

describe('planCurrentLineItemReconciliation — reviewer field merge (17H.4B0D4H1B1 §37)', () => {
  it('complete=true: explicitly marked unit_price is preserved, unmarked billing_period is refreshed', () => {
    const c = [current({
      id: 'c1', product_name: 'Support tier', billing_period: 'monthly', unit_price: 999, quantity: 1, total_amount: 999,
      reviewer_corrected_fields_complete: true, reviewer_corrected_fields: ['unit_price'],
    })]
    const f = [fresh({ product_name: 'Support tier', billing_period: 'quarterly', unit_price: 100, quantity: 1, total_amount: 100 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    const changes = plan.updates[0].changes
    expect(changes.unit_price).toBeUndefined() // preserved — reviewer-owned
    expect(changes.billing_period).toBe('quarterly') // refreshed — not reviewer-owned
    expect(changes.total_amount).toBe(100) // refreshed — not reviewer-owned
  })

  it('complete=true: multiple corrected fields are all preserved together (strong-ID family, since product_name itself is one of the corrected fields — identity must survive via fee_id, not label)', () => {
    const c = [current({
      id: 'c1', product_name: 'Old name', billing_period: 'one_time', unit_price: 50, quantity: 2, total_amount: 100, fee_id: 'A',
      reviewer_corrected_fields_complete: true, reviewer_corrected_fields: ['product_name', 'unit_price'],
    })]
    const f = [fresh({ product_name: 'New name', billing_period: 'one_time', unit_price: 999, quantity: 2, total_amount: 1998, fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    const changes = plan.updates[0].changes
    expect(changes.product_name).toBeUndefined()
    expect(changes.unit_price).toBeUndefined()
    expect(changes.total_amount).toBe(1998) // not reviewer-owned, refreshed
  })

  it('complete=false: equal current/fresh value -> no change proposed -> no update emitted at all', () => {
    const c = [current({ id: 'c1', product_name: 'Row', unit_price: 10, reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'Row', unit_price: 10 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('complete=false: differing unit_price -> current preserved -> the only possible field difference produces no update at all', () => {
    const c = [current({ id: 'c1', product_name: 'Row', unit_price: 10, reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'Row', unit_price: 15 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('complete=false: differing quantity -> current preserved -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Row', quantity: 3, reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'Row', quantity: 5 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
  })

  it('complete=false: differing billing_period -> current preserved -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Row', billing_period: 'monthly', reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'Row', billing_period: 'annual' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
  })

  it('complete=false: differing product_name -> current preserved -> no update emitted (strong-ID family — identity survives via fee_id, label alone could never pair these two rows)', () => {
    const c = [current({ id: 'c1', product_name: 'Old', billing_period: 'one_time', fee_id: 'A', reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'New', billing_period: 'one_time', fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1']) // still correctly paired as SAME, just no field diff worth writing
  })

  it('reviewer metadata itself is never part of a proposed change, even alongside a genuine refreshable field', () => {
    const c = [current({
      id: 'c1', product_name: 'Row', source_section: 'Old clause',
      reviewer_corrected_fields: ['unit_price'], reviewer_corrected_fields_complete: true, reviewer_corrected_at: '2026-01-01T00:00:00Z',
    })]
    const f = [fresh({ product_name: 'Row', source_section: 'New clause' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    const changes = plan.updates[0].changes as Record<string, unknown>
    expect('reviewer_corrected_fields' in changes).toBe(false)
    expect('reviewer_corrected_fields_complete' in changes).toBe(false)
    expect('reviewer_corrected_at' in changes).toBe(false)
  })

  it('confidence_score is never proposed as a change, even when it legitimately differs -> no update at all if nothing else differs', () => {
    const c = [current({ id: 'c1', product_name: 'Row', confidence_score: 1, reviewer_corrected_fields_complete: true, reviewer_corrected_fields: [] })]
    const f = [fresh({ product_name: 'Row', confidence_score: 0.6 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('source_section refreshes unconditionally on SAME (system-owned)', () => {
    const c = [current({ id: 'c1', product_name: 'Row', source_section: 'Old clause' })]
    const f = [fresh({ product_name: 'Row', source_section: 'New clause' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates[0].changes.source_section).toBe('New clause')
  })

  it('stripe_price_id/applied_rule/correction_reason/currency are never proposed as changes, even alongside a genuine refreshable field', () => {
    const c = [current({ id: 'c1', product_name: 'Row', source_section: 'Old clause', stripe_price_id: 'old', applied_rule: 'old-rule', correction_reason: 'old-reason', currency: 'USD' })]
    const f = [fresh({ product_name: 'Row', source_section: 'New clause' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    const changes = plan.updates[0].changes as Record<string, unknown>
    expect('stripe_price_id' in changes).toBe(false)
    expect('applied_rule' in changes).toBe(false)
    expect('correction_reason' in changes).toBe(false)
    expect('currency' in changes).toBe(false)
  })
})

describe('planCurrentLineItemReconciliation — weak-identity families (17H.4B0D4H1B1 §38)', () => {
  it('recurring_base_fee: exact unique SAME, no-op -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee', quantity: 12 })]
    const f = [fresh({ product_name: 'Recurring base fee', quantity: 12 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
  })

  it('recurring_base_fee: label drift -> UNKNOWN, never structural mutation', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee (periods 1–3)', quantity: 3 })]
    const f = [fresh({ product_name: 'Recurring base fee (periods 1–2)', quantity: 2 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.blockers.length).toBe(1)
    expect(plan.blockers[0].family).toBe('recurring_base_fee')
  })

  it('recurring_base_fee: 1 segment -> 2 segments population change is UNKNOWN, no insert/remove', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee', quantity: 12 })]
    const f = [
      fresh({ product_name: 'Recurring base fee (periods 1–6)', quantity: 6 }),
      fresh({ product_name: 'Recurring base fee (periods 7–12)', quantity: 6 }),
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.blockers.length).toBe(1)
  })

  it('legacy yearN-pricing-style mismatch remains UNKNOWN under the generic doctrine — no hardcoded alias', () => {
    const c = [
      current({ id: 'c1', product_name: 'year1 pricing', billing_period: 'annual', quantity: 1, unit_price: 436288, total_amount: 436288 }),
      current({ id: 'c2', product_name: 'year2 pricing', billing_period: 'annual', quantity: 1, unit_price: 481987, total_amount: 481987 }),
    ]
    const f = [
      fresh({ product_name: 'Recurring base fee (periods 1–1)', billing_period: 'annual', quantity: 1, unit_price: 436288, total_amount: 436288 }),
      fresh({ product_name: 'Recurring base fee (periods 2–2)', billing_period: 'annual', quantity: 1, unit_price: 481987, total_amount: 481987 }),
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    // Amounts align exactly, but labels never match under the generic
    // exact-label doctrine — no special-casing. The two sides don't even
    // land in the same family bucket ("yearN pricing" matches no
    // recurring-base-fee marker at all, so it classifies 'unknown' while
    // the fresh "(periods N–N)" rows classify 'recurring_base_fee') —
    // still zero structural mutation either way, across every blocker.
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    const allAffectedCurrentIds = plan.blockers.flatMap(b => b.affectedCurrentIds).sort()
    expect(allAffectedCurrentIds).toEqual(['c1', 'c2'])
  })

  it('additional_recurring_fixed: unique SAME, no-op -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Support tier', quantity: 12, unit_price: 200 })]
    const f = [fresh({ product_name: 'Support tier', quantity: 12, unit_price: 200 })]
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, additional_recurring_fees: [{ fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null }] }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
  })

  it('additional_recurring_fixed: renamed label -> UNKNOWN', () => {
    const c = [current({ id: 'c1', product_name: 'Support tier', quantity: 12 })]
    const f = [fresh({ product_name: 'Support package', quantity: 12 })]
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, additional_recurring_fees: [{ fee_label: 'Support package', metric_name: null, rate_per_unit: null, percentage_of_basis: null }] }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.length).toBeGreaterThan(0)
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('additional_recurring_variable: unique SAME, quantity=0 does NOT become tier, no-op -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'API overage surcharge', quantity: 0, unit_price: 0.01 })]
    const f = [fresh({ product_name: 'API overage surcharge', quantity: 0, unit_price: 0.01 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'API overage surcharge', metric_name: 'api_call', rate_per_unit: 0.01, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
  })

  it('additional_recurring_variable: label drift -> UNKNOWN', () => {
    const c = [current({ id: 'c1', product_name: 'API overage surcharge', quantity: 0 })]
    const f = [fresh({ product_name: 'API usage surcharge', quantity: 0 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'API usage surcharge', metric_name: 'api_call', rate_per_unit: 0.01, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.length).toBeGreaterThan(0)
    expect(plan.inserts).toEqual([])
  })

  it('17H.4B0D4H1B4E3.4 §21 — recurring_fee_id present on both sides: SAME survives wording drift, no blocker, no insert/supersede', () => {
    const c = [current({ id: 'c1', product_name: 'Success fee per completed payment', quantity: 0, recurring_fee_id: 'rf-abc' })]
    const f = [fresh({ product_name: 'Per-completed payment success fee', quantity: 0, recurring_fee_id: 'rf-abc' })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Per-completed payment success fee', metric_name: 'completed_payment', rate_per_unit: 1.7, percentage_of_basis: null, recurring_fee_id: 'rf-abc' }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.updates).toEqual([{ id: 'c1', changes: { product_name: 'Per-completed payment success fee' }, family: 'additional_recurring_variable', reason: 'same' }])
  })

  it('§19 mixed-state — ID current / DIFFERENT ID fresh: integrity_conflict, blocked, never silently repointed', () => {
    const c = [current({ id: 'c1', product_name: 'Fee A', quantity: 0, recurring_fee_id: 'rf-old' })]
    const f = [fresh({ product_name: 'Fee A', quantity: 0, recurring_fee_id: 'rf-new' })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Fee A', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-new' }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.blockers.some(b => (b.family === 'additional_recurring_variable') && b.affectedCurrentIds.includes('c1'))).toBe(true)
  })

  it('§19/§20 mixed-state — NULL current / ID fresh, unique label match: safe identity PROMOTION (legacy bridge), not a fresh insert', () => {
    const c = [current({ id: 'c1', product_name: 'Fee A', quantity: 0, recurring_fee_id: null })]
    const f = [fresh({ product_name: 'Fee A', quantity: 0, recurring_fee_id: 'rf-new' })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Fee A', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-new' }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.blockers).toEqual([])
    expect(plan.updates.find(u => u.id === 'c1')?.changes.recurring_fee_id).toBe('rf-new')
  })

  it('§19 mixed-state — NULL current / ID fresh, AMBIGUOUS (two legacy current rows share the label): fails closed, no promotion', () => {
    const c = [
      current({ id: 'c1', product_name: 'Fee A', quantity: 0, recurring_fee_id: null }),
      current({ id: 'c2', product_name: 'Fee A', quantity: 0, recurring_fee_id: null, unit_price: 5 }),
    ]
    const f = [fresh({ product_name: 'Fee A', quantity: 0, recurring_fee_id: 'rf-new' })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Fee A', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-new' }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates.some(u => u.changes.recurring_fee_id)).toBe(false)
    expect(plan.inserts).toEqual([])
    expect(plan.blockers.length).toBeGreaterThan(0)
  })

  it('§19 mixed-state — NULL/NULL (both legacy, label matches): SAME via the transitional label bridge, frozen weak-family-equivalent behavior', () => {
    const c = [current({ id: 'c1', product_name: 'Fee A', quantity: 0, recurring_fee_id: null })]
    const f = [fresh({ product_name: 'Fee A', quantity: 0 })] // recurring_fee_id omitted -> null, simulating pre-migration fresh data
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Fee A', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('§19 mixed-state — NULL/NULL, label does NOT match: frozen weak-family doctrine, blocked, never auto-inserted as new', () => {
    const c = [current({ id: 'c1', product_name: 'Old wording', quantity: 0, recurring_fee_id: null })]
    const f = [fresh({ product_name: 'New wording', quantity: 0 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'New wording', metric_name: 'm', rate_per_unit: 1, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.inserts).toEqual([]) // critical: must NOT silently insert as a new mechanism
    expect(plan.updates).toEqual([])
  })

  it('§22 genuine new fee: a real recurring_fee_id with zero current counterpart inserts safely as NEW', () => {
    const c: CurrentLineItemRow[] = []
    const f = [fresh({ product_name: 'Brand new fee', quantity: 0, recurring_fee_id: 'rf-genuinely-new' })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Brand new fee', metric_name: 'new_metric', rate_per_unit: 1, percentage_of_basis: null, recurring_fee_id: 'rf-genuinely-new' }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([{ row: f[0], family: 'additional_recurring_variable', reason: 'new' }])
  })

  it('escalator: unchanged population -> SAME/no-op, no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const f = [fresh({ product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('escalator: changed population -> blocker/preserve, never inferred NEW/REMOVED', () => {
    const c = [current({ id: 'c1', product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const f = [fresh({ product_name: 'Price escalator (7% CPI)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
    expect(plan.blockers.some(b => b.family === 'escalator')).toBe(true)
  })

  it('E3.2 §10/§25 audit — escalator confirm-rule (confirm-rule/route.ts only ever writes .interpretation, never escalator_pct/escalator_type) is representation-preserving: no continuity mechanism needed because the row never changes at all', () => {
    // product_name is built purely from escalator_pct/escalator_type
    // (lib/line-items.ts) — .interpretation is a SEPARATE field never read
    // by buildLineItems, so confirming it can never change this row. This
    // is the ordinary, unmodified "unchanged population -> SAME/no-op"
    // case above, exercised here under its own explicit E3.2-audit name.
    const c = [current({ id: 'c1', product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const f = [fresh({ product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
    expect(plan.blockers).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })
})

describe('planCurrentLineItemReconciliation — lifecycle artifacts (17H.4B0D4H1B1 §39)', () => {
  it('base_fee_proration: unresolved -> unresolved is SAME, no-op -> no update emitted', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, unit_price: 1000, total_amount: 0 })]
    const f = [fresh({ product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, unit_price: 1000, total_amount: 0 })]
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: true } }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
    expect(plan.blockers).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('E3.2 — base_fee_proration: now resolved, exactly 1 placeholder <-> exactly 1 fresh recurring_base_fee row: proven continuity, SAME-row UPDATE, no supersede, no insert, no blocker', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, unit_price: 2000, total_amount: 0, confidence_score: 0 })]
    const f = [fresh({ product_name: 'Recurring base fee (periods 4–12)', quantity: 9, unit_price: 2000, total_amount: 18000, confidence_score: 0.97 })]
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: false } }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    // Same physical row, not remove+invent — the whole point of E3.2.
    expect(plan.supersedes).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.blockers).toEqual([])
    expect(plan.updates).toEqual([{
      id: 'c1', family: 'recurring_base_fee', reason: 'same',
      changes: { product_name: 'Recurring base fee (periods 4–12)', quantity: 9, total_amount: 18000 },
    }])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('E3.2 — cardinality safeguard: 1 placeholder <-> 2 fresh recurring_base_fee rows (e.g. a mid-term rate change) falls back to the ORIGINAL legacy_stale + blocked-residual behavior, never guesses', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0 })]
    const f = [
      fresh({ product_name: 'Recurring base fee (periods 4–8)', quantity: 5, unit_price: 2000, total_amount: 10000 }),
      fresh({ product_name: 'Recurring base fee (periods 9–12)', quantity: 4, unit_price: 2200, total_amount: 8800 }),
    ]
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: false } }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.supersedes).toEqual([{ id: 'c1', family: 'base_fee_proration', reason: 'legacy_stale' }])
    expect(plan.updates).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.blockers.some(b => b.family === 'recurring_base_fee' && b.reason === 'unknown_identity')).toBe(true)
  })

  it('E3.2 — cardinality safeguard: 1 placeholder <-> 0 fresh recurring_base_fee rows falls back to plain legacy_stale supersede, no blocker, no update', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0 })]
    const f: FreshLineItemLike[] = []
    const terms: ReconciliationTermsContext = { ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: false } }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.supersedes).toEqual([{ id: 'c1', family: 'base_fee_proration', reason: 'legacy_stale' }])
    expect(plan.updates).toEqual([])
    expect(plan.blockers).toEqual([])
  })

  it('an unrelated row is not affected by the proration continuity/legacy-stale predicate', () => {
    const c = [
      current({ id: 'c1', product_name: 'Recurring base fee — partial-period treatment unresolved', quantity: 0, unit_price: 2000, total_amount: 0, confidence_score: 0 }),
      current({ id: 'c2', product_name: 'Support tier', quantity: 12, unit_price: 50 }),
    ]
    const f = [
      fresh({ product_name: 'Recurring base fee', quantity: 12, unit_price: 2000, total_amount: 24000, confidence_score: 0.97 }),
      fresh({ product_name: 'Support tier', quantity: 12, unit_price: 50 }),
    ]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: false },
      additional_recurring_fees: [{ fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    // c1 is now a proven-continuity UPDATE (E3.2), not a supersede.
    expect(plan.supersedes).toEqual([])
    expect(plan.updates.find(u => u.id === 'c1')).toBeDefined()
    // c2 is a clean, no-op SAME pair (exact match) -> no update emitted,
    // but it is neither superseded, blocked, nor left out of the snapshot.
    expect(plan.updates.find(u => u.id === 'c2')).toBeUndefined()
    expect(plan.supersedes.find(s => s.id === 'c2')).toBeUndefined()
    expect(plan.blockers.flatMap(b => b.affectedCurrentIds)).not.toContain('c2')
    expect(plan.expectedCurrentRowIds).toContain('c2')
  })

  it('E3.2 — scope safety: continuity never fires for an unrelated weak family merely because it also has a 1:1 shape', () => {
    // Two independent weak-family rows, neither touching base_fee_proration
    // at all — resolving proration must never pair these.
    const c = [current({ id: 'c1', product_name: 'Old support tier name', quantity: 12, unit_price: 50 })]
    const f = [fresh({ product_name: 'New support tier name', quantity: 12, unit_price: 50 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS, base_fee_proration: { requires_confirmation: false },
      additional_recurring_fees: [{ fee_label: 'New support tier name', metric_name: null, rate_per_unit: null, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates).toEqual([])
    expect(plan.inserts).toEqual([])
    // 17H.4B0D4H1B4E3.4 promoted additional_recurring_fixed to strong-ID
    // pairing — an id-less residual (both sides here predate recurring_fee_id)
    // still blocks (never silently paired), just under the strong-family
    // reason label now.
    expect(plan.blockers.some(b => b.family === 'additional_recurring_fixed' && b.reason === 'residual_identity_drift')).toBe(true)
  })

  it('percentage_of_basis legacy row: reuses the exact existing stale predicate -> legacy_stale supersede', () => {
    const c = [current({ id: 'c1', product_name: 'Performance share', quantity: 0, unit_price: 0 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Performance share', metric_name: null, rate_per_unit: null, percentage_of_basis: { basis: 'net_revenue', pct: 5 } as never }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms })
    expect(plan.supersedes).toEqual([{ id: 'c1', family: 'additional_recurring_fixed', reason: 'legacy_stale' }])
  })

  it('Performance Share terms do not generate a replacement line_item (never emitted by buildLineItems, confirmed: no fresh row for it means nothing inserted)', () => {
    const c = [current({ id: 'c1', product_name: 'Performance share', quantity: 0 })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'Performance share', metric_name: null, rate_per_unit: null, percentage_of_basis: { basis: 'net_revenue', pct: 5 } as never }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms })
    expect(plan.inserts).toEqual([])
  })
})

describe('planCurrentLineItemReconciliation — deterministic snapshots (17H.4B0D4H1B1 §40)', () => {
  it('every current row appears in expectedCurrentRows and expectedCurrentRowIds', () => {
    const c = [current({ id: 'c3', product_name: 'A' }), current({ id: 'c1', product_name: 'B' }), current({ id: 'c2', product_name: 'C' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })
    expect(plan.expectedCurrentRows.map(r => r.id).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(plan.expectedCurrentRowIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('expectedCurrentRowIds is sorted regardless of input order', () => {
    const c = [current({ id: 'z' }), current({ id: 'a' }), current({ id: 'm' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })
    expect(plan.expectedCurrentRowIds).toEqual(['a', 'm', 'z'])
  })

  it('an untouched weak-family row with no fresh counterpart is still snapshot-captured', () => {
    const c = [current({ id: 'c1', product_name: 'Orphaned row', quantity: 5 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('reviewer metadata is captured exactly — NULL and [] are distinct in the snapshot', () => {
    const c = [
      current({ id: 'c1', reviewer_corrected_fields: null }),
      current({ id: 'c2', reviewer_corrected_fields: [] }),
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })
    const row1 = plan.expectedCurrentRows.find(r => r.id === 'c1')!
    const row2 = plan.expectedCurrentRows.find(r => r.id === 'c2')!
    expect(row1.reviewer_corrected_fields).toBeNull()
    expect(row2.reviewer_corrected_fields).toEqual([])
  })

  it('fee_id/tier_id are captured exactly in the snapshot', () => {
    const c = [current({ id: 'c1', fee_id: 'F1', tier_id: null }), current({ id: 'c2', fee_id: null, tier_id: 'T1' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })
    expect(plan.expectedCurrentRows.find(r => r.id === 'c1')?.fee_id).toBe('F1')
    expect(plan.expectedCurrentRows.find(r => r.id === 'c2')?.tier_id).toBe('T1')
  })

  it('current-row input order never changes the semantic plan (updates/supersedes/blockers sorted deterministically)', () => {
    const cForward = [current({ id: 'c1', product_name: 'A', quantity: 12 }), current({ id: 'c2', product_name: 'B', quantity: 12 })]
    const cReversed = [current({ id: 'c2', product_name: 'B', quantity: 12 }), current({ id: 'c1', product_name: 'A', quantity: 12 })]
    const f = [fresh({ product_name: 'A', quantity: 12 }), fresh({ product_name: 'B', quantity: 12 })]
    const planForward = planCurrentLineItemReconciliation({ currentItems: cForward, freshItems: f, terms: EMPTY_TERMS })
    const planReversed = planCurrentLineItemReconciliation({ currentItems: cReversed, freshItems: f, terms: EMPTY_TERMS })
    expect(planForward.updates).toEqual(planReversed.updates)
    expect(planForward.expectedCurrentRowIds).toEqual(planReversed.expectedCurrentRowIds)
  })
})

describe('planCurrentLineItemReconciliation — cross-family blocker isolation (17H.4B0D4H1B1 §32)', () => {
  it('an escalator blocker never suppresses a clean tier/one-time result in the same plan', () => {
    const c = [
      current({ id: 'esc1', product_name: 'Price escalator (5% fixed_pct)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 }),
      current({ id: 'tier1', product_name: 'Overage', quantity: 0, tier_id: 'T1', source_section: 'Old clause' }),
      current({ id: 'ot1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'F1', source_section: 'Old clause' }),
    ]
    const f = [
      fresh({ product_name: 'Price escalator (7% CPI)', billing_period: 'annual', quantity: 1, unit_price: 0, total_amount: 0 }),
      fresh({ product_name: 'Overage', quantity: 0, tier_id: 'T1', source_section: 'New clause' }),
      fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'F1', source_section: 'New clause' }),
    ]
    const terms = termsWithTiers([{ tier_id: 'T1', tier_label: 'Overage' }])
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'escalator')).toBe(true)
    // tier1/ot1 have a genuine field difference (source_section), so a
    // real update is emitted, proving the clean families are unaffected —
    // not merely "not blocked" but actually correctly reconciled.
    expect(plan.updates.find(u => u.id === 'tier1')?.changes.source_section).toBe('New clause')
    expect(plan.updates.find(u => u.id === 'ot1')?.changes.source_section).toBe('New clause')
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(false)
    expect(plan.blockers.some(b => b.family === 'one_time')).toBe(false)
  })

  it('planner never throws merely because a blocker exists', () => {
    const c = [current({ id: 'c1', product_name: 'X', tier_id: 'A' }), current({ id: 'c2', product_name: 'Y', tier_id: 'A' })]
    expect(() => planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS })).not.toThrow()
  })
})

describe('planCurrentLineItemReconciliation — corrupt tier_id classification defense-in-depth (17H.4B0D4H1B1.1 §1/§2)', () => {
  it('one-time row + stray tier_id -> classifies one_time, never tier', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, fee_id: 'F1', tier_id: 'A' })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', quantity: 1, fee_id: 'F1', tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Setup fee' }]) })
    // Paired at all (proven by presence in expectedCurrentRowIds and
    // absence from any tier-family blocker) — and specifically as
    // one_time, never tier, despite carrying tier_id.
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(false)
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('recurring-base row + stray tier_id -> classifies recurring_base_fee, never tier', () => {
    const c = [current({ id: 'c1', product_name: 'Recurring base fee', quantity: 12, tier_id: 'A' })]
    const f = [fresh({ product_name: 'Recurring base fee', quantity: 12, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Recurring base fee' }]) })
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(false)
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('quantity != 0 non-tier row + stray tier_id -> classifies its own structural family, never tier', () => {
    const c = [current({ id: 'c1', product_name: 'Support tier', quantity: 12, tier_id: 'A' })]
    const f = [fresh({ product_name: 'Support tier', quantity: 12, tier_id: 'A' })]
    const terms: ReconciliationTermsContext = {
      ...termsWithTiers([{ tier_id: 'A', tier_label: 'Support tier' }]),
      additional_recurring_fees: [{ fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(false)
    // Lands in additional_recurring_fixed (its real structural family, per quantity!==0), not tier.
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('additional_recurring_variable quantity=0 + tier_id=NULL -> classified by structural evidence, not tier', () => {
    const c = [current({ id: 'c1', product_name: 'API overage surcharge', quantity: 0, tier_id: null })]
    const f = [fresh({ product_name: 'API overage surcharge', quantity: 0, tier_id: null })]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [{ fee_label: 'API overage surcharge', metric_name: 'api_call', rate_per_unit: 0.01, percentage_of_basis: null }],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(false)
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('real tier quantity=0 + tier_id=A -> classifies tier', () => {
    const c = [current({ id: 'c1', product_name: 'Overage', quantity: 0, tier_id: 'A' })]
    const f = [fresh({ product_name: 'Overage', quantity: 0, tier_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: termsWithTiers([{ tier_id: 'A', tier_label: 'Overage' }]) })
    // A real tier SAME pair — proven by zero tier blockers and (since
    // values match exactly) a pruned no-op update.
    expect(plan.blockers).toEqual([])
    expect(plan.updates).toEqual([])
    expect(plan.expectedCurrentRowIds).toEqual(['c1'])
  })

  it('a REMOVED tier (no longer in fresh terms at all) still classifies as tier via its own persisted tier_id, not unknown', () => {
    // The exact live scenario the classifier bug (fixed this pass) failed
    // on: a current tier row whose upstream tier no longer exists in fresh
    // terms must still classify 'tier' so it can correctly become a
    // residual REMOVED candidate.
    const c = [current({ id: 'c1', product_name: 'Old tier', quantity: 0, tier_id: 'GONE' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: [], terms: EMPTY_TERMS }) // no tiers at all in fresh terms
    expect(plan.supersedes).toEqual([{ id: 'c1', family: 'tier', reason: 'removed' }])
  })
})

describe('planCurrentLineItemReconciliation — blocked-family mutation policy (17H.4B0D4H1B1.1 §3/§14)', () => {
  it('strong family: one SAME pair would get an ordinary refresh, another pair in the same family creates residual drift -> the whole family is blocked, ordinary refresh suppressed', () => {
    const c = [
      current({ id: 'c1', product_name: 'Overage A', quantity: 0, tier_id: 'A', source_section: 'Old clause' }),
      current({ id: 'c2', product_name: 'Overage C', quantity: 0, tier_id: 'C' }),
    ]
    const f = [
      fresh({ product_name: 'Overage A', quantity: 0, tier_id: 'A', source_section: 'New clause' }), // would ordinarily refresh source_section
      fresh({ product_name: 'Overage X', quantity: 0, tier_id: 'X' }), // no current counterpart -> residual drift alongside c2
    ]
    const terms = termsWithTiers([{ tier_id: 'A', tier_label: 'Overage A' }, { tier_id: 'X', tier_label: 'Overage X' }])
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'tier' && b.reason === 'residual_identity_drift')).toBe(true)
    // c1's ordinary source_section refresh is suppressed — the whole tier family is blocked.
    expect(plan.updates.find(u => u.id === 'c1')).toBeUndefined()
    expect(plan.inserts).toEqual([])
    expect(plan.supersedes).toEqual([])
  })

  it('weak family: one exact SAME pair plus one label-drifted residual -> zero updates, zero inserts, zero supersedes for the family', () => {
    const c = [
      current({ id: 'c1', product_name: 'Support tier', quantity: 12, source_section: 'Old clause' }),
      current({ id: 'c2', product_name: 'Old renamed fee', quantity: 12 }),
    ]
    const f = [
      fresh({ product_name: 'Support tier', quantity: 12, source_section: 'New clause' }),
      fresh({ product_name: 'New renamed fee', quantity: 12 }),
    ]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [
        { fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
        { fee_label: 'New renamed fee', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
      ],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'additional_recurring_fixed')).toBe(true)
    expect(plan.updates.filter(u => u.family === 'additional_recurring_fixed')).toEqual([])
    expect(plan.inserts.filter(i => i.family === 'additional_recurring_fixed')).toEqual([])
    expect(plan.supersedes.filter(s => s.family === 'additional_recurring_fixed')).toEqual([])
  })

  it('a SAME pair that would normally refresh source_section produces no update once its family becomes blocked', () => {
    const c = [
      current({ id: 'c1', product_name: 'Support tier', quantity: 12, source_section: 'Old clause' }),
      current({ id: 'c2', product_name: 'Orphaned fee', quantity: 12 }),
    ]
    const f = [
      fresh({ product_name: 'Support tier', quantity: 12, source_section: 'New clause' }),
      fresh({ product_name: 'Brand new fee', quantity: 12 }),
    ]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [
        { fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
        { fee_label: 'Brand new fee', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
      ],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.updates.find(u => u.id === 'c1')).toBeUndefined()
  })
})

describe('planCurrentLineItemReconciliation — identity promotion survives a blocked family (17H.4B0D4H1B1.1 §4/§15)', () => {
  it('ONE-TIME: legacy-null current + modern fresh fee_id, safe SAME, alongside an unresolved pair in the same family -> fee_id promotion allowed, no commercial/source refresh', () => {
    const c = [
      current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: null, source_section: 'Old clause' }),
      current({ id: 'c2', product_name: 'Old integration fee', billing_period: 'one_time', fee_id: null }),
    ]
    const f = [
      fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'A', source_section: 'New clause' }),
      fresh({ product_name: 'New integration fee', billing_period: 'one_time', fee_id: 'B' }), // no current counterpart -> residual drift
    ]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers.some(b => b.family === 'one_time')).toBe(true)
    const c1Update = plan.updates.find(u => u.id === 'c1')
    expect(c1Update?.changes).toEqual({ fee_id: 'A' }) // promotion only — no source_section
  })

  it('TIER: legacy-null current + modern fresh tier_id, safe SAME, alongside an unresolved pair in the same family -> tier_id promotion allowed, no commercial/source refresh', () => {
    const c = [
      current({ id: 'c1', product_name: 'Overage', quantity: 0, tier_id: null, source_section: 'Old clause' }),
      // A genuinely removed tier: tier_id is non-null (classifies 'tier'
      // via the classifier's own tier_id-first fast path — 17H.4B0D4H1B1.1
      // §1/§2) but no longer present anywhere in fresh terms/fresh items.
      current({ id: 'c2', product_name: 'Old overage band', quantity: 0, tier_id: 'REMOVED' }),
    ]
    const f = [
      fresh({ product_name: 'Overage', quantity: 0, tier_id: 'A', source_section: 'New clause' }),
      fresh({ product_name: 'New overage band', quantity: 0, tier_id: 'B' }), // no current counterpart -> residual drift
    ]
    const terms = termsWithTiers([{ tier_id: 'A', tier_label: 'Overage' }, { tier_id: 'B', tier_label: 'New overage band' }])
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'tier')).toBe(true)
    const c1Update = plan.updates.find(u => u.id === 'c1')
    expect(c1Update?.changes).toEqual({ tier_id: 'A' }) // promotion only — no source_section
  })
})

describe('planCurrentLineItemReconciliation — clean-family regression (17H.4B0D4H1B1.1 §6/§16)', () => {
  it('a clean family still allows a complete=true unreviewed unit_price refresh, source_section refresh, AND semantic-ID promotion together', () => {
    const c = [current({
      id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', unit_price: 100, total_amount: 100,
      fee_id: null, source_section: 'Old clause', reviewer_corrected_fields_complete: true, reviewer_corrected_fields: [],
    })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', unit_price: 150, total_amount: 150, fee_id: 'A', source_section: 'New clause' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.blockers).toEqual([])
    const changes = plan.updates[0].changes
    expect(changes.unit_price).toBe(150)
    expect(changes.total_amount).toBe(150)
    expect(changes.source_section).toBe('New clause')
    expect(changes.fee_id).toBe('A')
  })
})

describe('planCurrentLineItemReconciliation — no-op pruning (17H.4B0D4H1B1.1 §7/§17)', () => {
  it('1. exact SAME, no changed fields at all -> no update entry', () => {
    const c = [current({ id: 'c1', product_name: 'Row' })]
    const f = [fresh({ product_name: 'Row' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
  })

  it('2. SAME with only a source_section difference -> exactly one update', () => {
    const c = [current({ id: 'c1', product_name: 'Row', source_section: 'Old' })]
    const f = [fresh({ product_name: 'Row', source_section: 'New' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates.length).toBe(1)
    expect(plan.updates[0].changes).toEqual({ source_section: 'New' })
  })

  it('3. SAME with only a semantic-ID promotion -> exactly one update', () => {
    const c = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: null })]
    const f = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'A' })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates.length).toBe(1)
    expect(plan.updates[0].changes).toEqual({ fee_id: 'A' })
  })

  it('4. complete=false value differences only -> no update at all', () => {
    const c = [current({ id: 'c1', product_name: 'Row', unit_price: 10, reviewer_corrected_fields_complete: false, reviewer_corrected_fields: null })]
    const f = [fresh({ product_name: 'Row', unit_price: 999 })]
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms: EMPTY_TERMS })
    expect(plan.updates).toEqual([])
  })

  it('5. blocked family with only ordinary changes available -> no update', () => {
    const c = [
      current({ id: 'c1', product_name: 'Support tier', quantity: 12, unit_price: 50 }),
      current({ id: 'c2', product_name: 'Orphaned fee', quantity: 12 }),
    ]
    const f = [
      fresh({ product_name: 'Support tier', quantity: 12, unit_price: 999 }), // would ordinarily refresh unit_price
      fresh({ product_name: 'Brand new fee', quantity: 12 }),
    ]
    const terms: ReconciliationTermsContext = {
      ...EMPTY_TERMS,
      additional_recurring_fees: [
        { fee_label: 'Support tier', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
        { fee_label: 'Brand new fee', metric_name: null, rate_per_unit: null, percentage_of_basis: null },
      ],
    }
    const plan = planCurrentLineItemReconciliation({ currentItems: c, freshItems: f, terms })
    expect(plan.blockers.some(b => b.family === 'additional_recurring_fixed')).toBe(true)
    expect(plan.updates.find(u => u.id === 'c1')).toBeUndefined()
  })
})
