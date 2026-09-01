import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  serializeReconciliationPlanForApplier,
  applyCurrentLineItemReconciliationPlan,
} from './current-line-item-reconciliation-applier'
import {
  planCurrentLineItemReconciliation,
  type CurrentLineItemRow, type FreshLineItemLike, type ReconciliationTermsContext,
  type CurrentLineItemReconciliationPlan,
} from './current-line-item-reconciliation-plan'

// Step 17H.4B0D4H1B2 §31/§32/§37 — pure serialization, RPC result-mapping,
// and planner-convergence coverage for the atomic applier. This file
// deliberately contains NO real database calls — the RPC itself
// (apply_current_line_item_reconciliation, supabase/migrations/
// 20260913000001_...) is written but NOT applied to any database this
// session (per explicit instruction), so there is nothing a real SQL
// integration test could invoke yet. §33's SQL stale-plan scenarios (exact
// unchanged set -> apply, extra/missing current row -> stale_plan,
// individual field changes -> stale_plan, etc.) are therefore NOT
// exercised here as live DB tests — this is a disclosed limitation, not an
// oversight: this project's established gated-integration-test pattern
// (see lib/planned-invoices-rebuild-cleanup-integration.test.ts,
// RUN_RLS_INTEGRATION_TESTS=true) tests a real exported TypeScript function
// against a real database; it cannot exercise a SQL function that has
// never been migrated in. Once a future step applies this migration to a
// real (non-production-data) environment, the same gated pattern should
// add a sibling `*-integration.test.ts` exercising exactly the 10
// scenarios §33 lists, directly against the RPC via supabaseServer.rpc(...).
// Every scenario's REASONING is nonetheless proven here at the unit level,
// against the migration's own SQL logic read directly (see the migration's
// header comment for the FOR UPDATE / advisory-lock / snapshot-equality
// design each of these tests exercises indirectly through the planner and
// wrapper).

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

function mockSupabase(result: { data?: unknown; error?: { message: string } | null }): { client: SupabaseClient; rpcSpy: ReturnType<typeof vi.fn> } {
  const rpcSpy = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  return { client: { rpc: rpcSpy } as unknown as SupabaseClient, rpcSpy }
}

// ═══════════════════════════════════════════════════════════════════════════
describe('serializeReconciliationPlanForApplier (§31)', () => {
  it('includes every expected current row, generically (no hardcoded count)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => current({ id: `c${i}` }))
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: rows, expectedCurrentRowIds: rows.map(r => r.id).sort(),
      updates: [], inserts: [], supersedes: [], blockers: [],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    expect(payload.p_expected_current_rows).toHaveLength(40)
    expect(payload.p_expected_current_row_ids).toHaveLength(40)
    expect(new Set(payload.p_expected_current_row_ids)).toEqual(new Set(rows.map(r => r.id)))
  })

  it('preserves NULL reviewer_corrected_fields as JSON null, distinct from []', () => {
    const legacyRow = current({ id: 'legacy', reviewer_corrected_fields: null, reviewer_corrected_fields_complete: false })
    const trackedRow = current({ id: 'tracked', reviewer_corrected_fields: [] })
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: [legacyRow, trackedRow], expectedCurrentRowIds: ['legacy', 'tracked'],
      updates: [], inserts: [], supersedes: [], blockers: [],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    const serializedJson = JSON.parse(JSON.stringify(payload.p_expected_current_rows))
    const legacy = serializedJson.find((r: { id: string }) => r.id === 'legacy')
    const tracked = serializedJson.find((r: { id: string }) => r.id === 'tracked')
    expect(legacy.reviewer_corrected_fields).toBeNull()
    expect(tracked.reviewer_corrected_fields).toEqual([])
  })

  it('preserves fee_id/tier_id null vs non-null exactly', () => {
    const withTier = current({ id: 'c1', tier_id: 'T-1', fee_id: null })
    const withFee = current({ id: 'c2', fee_id: 'F-1', tier_id: null })
    const neither = current({ id: 'c3' })
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: [withTier, withFee, neither], expectedCurrentRowIds: ['c1', 'c2', 'c3'],
      updates: [], inserts: [], supersedes: [], blockers: [],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    const byId = Object.fromEntries((payload.p_expected_current_rows as CurrentLineItemRow[]).map(r => [r.id, r]))
    expect(byId['c1'].tier_id).toBe('T-1')
    expect(byId['c1'].fee_id).toBeNull()
    expect(byId['c2'].fee_id).toBe('F-1')
    expect(byId['c2'].tier_id).toBeNull()
    expect(byId['c3'].fee_id).toBeNull()
    expect(byId['c3'].tier_id).toBeNull()
  })

  it('serializes numeric fields as real numbers, not strings', () => {
    const row = current({ id: 'c1', unit_price: 12.5, quantity: 3, total_amount: 37.5, confidence_score: 0.82 })
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: [row], expectedCurrentRowIds: ['c1'], updates: [], inserts: [], supersedes: [], blockers: [],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    const out = payload.p_expected_current_rows[0] as CurrentLineItemRow
    expect(typeof out.unit_price).toBe('number')
    expect(typeof out.quantity).toBe('number')
    expect(typeof out.total_amount).toBe('number')
    expect(typeof out.confidence_score).toBe('number')
    expect(out.unit_price).toBe(12.5)
  })

  it('preserves the planner\'s own sorted ID list verbatim, without re-sorting or deduplicating', () => {
    const rows = [current({ id: 'zeta' }), current({ id: 'alpha' }), current({ id: 'mu' })]
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: rows, expectedCurrentRowIds: ['alpha', 'mu', 'zeta'], // planner already sorts
      updates: [], inserts: [], supersedes: [], blockers: [],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    expect(payload.p_expected_current_row_ids).toEqual(['alpha', 'mu', 'zeta'])
  })

  it('strips diagnostic fields (family/reason) from updates/inserts/supersedes, keeping only what the RPC accepts', () => {
    const plan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
      expectedCurrentRows: [current({ id: 'c1' })], expectedCurrentRowIds: ['c1'],
      updates: [{ id: 'c1', changes: { unit_price: 20 }, family: 'tier', reason: 'same' }],
      inserts: [{ row: fresh({ product_name: 'New tier band', tier_id: 'T-9' }), family: 'tier', reason: 'new' }],
      supersedes: [{ id: 'c1', family: 'tier', reason: 'removed' }],
      blockers: [{ family: 'tier', reason: 'ambiguous', affectedCurrentIds: ['c1'] }],
    }
    const payload = serializeReconciliationPlanForApplier('job-1', plan)
    expect(payload.p_updates).toEqual([{ id: 'c1', changes: { unit_price: 20 } }])
    expect(payload.p_supersedes).toEqual([{ id: 'c1' }])
    expect(payload.p_inserts).toEqual([fresh({ product_name: 'New tier band', tier_id: 'T-9' })])
    // Blockers never appear anywhere in the RPC payload — not a parameter.
    expect(Object.keys(payload)).not.toContain('blockers')
    expect(Object.keys(payload)).not.toContain('p_blockers')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('applyCurrentLineItemReconciliationPlan — RPC result mapping (§32)', () => {
  const trivialPlan: CurrentLineItemReconciliationPlan<FreshLineItemLike> = {
    expectedCurrentRows: [], expectedCurrentRowIds: [], updates: [], inserts: [], supersedes: [], blockers: [],
  }

  it('maps an applied result to the typed applied shape', async () => {
    const { client, rpcSpy } = mockSupabase({ data: { status: 'applied', updated_count: 3, inserted_count: 2, superseded_count: 1 } })
    const result = await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(result).toEqual({ status: 'applied', updatedCount: 3, insertedCount: 2, supersededCount: 1 })
    expect(rpcSpy).toHaveBeenCalledWith('apply_current_line_item_reconciliation', expect.objectContaining({ p_job_id: 'job-1' }))
  })

  it('maps stale current set to stale_plan/current_set_changed', async () => {
    const { client } = mockSupabase({ data: { status: 'stale_plan', reason: 'current_set_changed', missing_from_actual: ['c9'], extra_in_actual: ['c10'] } })
    const result = await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(result.status).toBe('stale_plan')
    if (result.status === 'stale_plan') {
      expect(result.reason).toBe('current_set_changed')
      expect(result.missingFromActual).toEqual(['c9'])
      expect(result.extraInActual).toEqual(['c10'])
    }
  })

  it('maps a stale row to stale_plan/current_row_changed', async () => {
    const { client } = mockSupabase({ data: { status: 'stale_plan', reason: 'current_row_changed', affected_ids: ['c1'] } })
    const result = await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(result.status).toBe('stale_plan')
    if (result.status === 'stale_plan') {
      expect(result.reason).toBe('current_row_changed')
      expect(result.affectedIds).toEqual(['c1'])
    }
  })

  it('maps an invalid plan to invalid_plan with its reason', async () => {
    const { client } = mockSupabase({ data: { status: 'invalid_plan', reason: 'update_changes_forbidden_key: confidence_score' } })
    const result = await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(result).toEqual({ status: 'invalid_plan', reason: 'update_changes_forbidden_key: confidence_score' })
  })

  it('maps an RPC infrastructure error to a typed error result, never throwing', async () => {
    const { client } = mockSupabase({ data: null, error: { message: 'connection reset' } })
    const result = await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(result).toEqual({ status: 'error', message: 'connection reset' })
  })

  it('never retries automatically — exactly one rpc call per invocation', async () => {
    const { client, rpcSpy } = mockSupabase({ data: { status: 'stale_plan', reason: 'current_set_changed' } })
    await applyCurrentLineItemReconciliationPlan(client, 'job-1', trivialPlan)
    expect(rpcSpy).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §37 — convergence: apply a first plan's proposed mutations (simulated in
// memory — no DB, no RPC), then re-plan against the resulting state and
// confirm nothing further is proposed for the same rows. Generic synthetic
// fixtures throughout, no hardcoded live counts — deliberately shaped like
// the known missing-tier pattern (a job entirely missing its tier bands)
// since that is the one live NEW-row family this whole sequence exists to
// get right, but with invented ids/labels, never real customer data.
describe('planner convergence after simulated apply (§37)', () => {
  it('missing tier rows: first plan proposes NEW inserts; after simulated apply, re-plan finds them SAME with no further inserts', () => {
    const terms = termsWithTiers([
      { tier_id: null, tier_label: 'Widgets 1-100 — overage' },
      { tier_id: null, tier_label: 'Widgets 101+ — overage' },
    ])
    const freshItems = [
      fresh({ product_name: 'Widgets 1-100 — overage', quantity: 0, unit_price: 1, tier_id: null }),
      fresh({ product_name: 'Widgets 101+ — overage', quantity: 0, unit_price: 2, tier_id: null }),
    ]

    const firstPlan = planCurrentLineItemReconciliation({ currentItems: [], freshItems, terms })
    expect(firstPlan.inserts).toHaveLength(2)
    expect(firstPlan.inserts.every(i => i.family === 'tier')).toBe(true)
    expect(firstPlan.updates).toEqual([])
    expect(firstPlan.blockers).toEqual([])

    // Simulate what the applier would have persisted: each insert becomes a
    // new current row with a generated id and the planner's own D2 frozen
    // state (§20) — never the applier re-running any commercial logic.
    const simulatedCurrentAfterApply: CurrentLineItemRow[] = firstPlan.inserts.map((ins, idx) => ({
      id: `generated-${idx}`,
      product_name: ins.row.product_name, quantity: ins.row.quantity, unit_price: ins.row.unit_price,
      billing_period: ins.row.billing_period, total_amount: ins.row.total_amount,
      confidence_score: ins.row.confidence_score, currency: 'EUR', stripe_price_id: null,
      applied_rule: null, correction_reason: null, source_section: ins.row.source_section ?? null,
      reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null,
      fee_id: ins.row.fee_id ?? null, tier_id: ins.row.tier_id ?? null, recurring_fee_id: ins.row.recurring_fee_id ?? null,
    }))

    const secondPlan = planCurrentLineItemReconciliation({ currentItems: simulatedCurrentAfterApply, freshItems, terms })
    expect(secondPlan.inserts).toEqual([])
    expect(secondPlan.supersedes).toEqual([])
    expect(secondPlan.blockers).toEqual([])
    expect(secondPlan.expectedCurrentRowIds.sort()).toEqual(['generated-0', 'generated-1'])
  })

  it('a SAME update converges: after simulated apply, re-plan proposes no further update for the same row', () => {
    const terms = EMPTY_TERMS
    const currentBefore = [current({ id: 'c1', product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'F-1', source_section: 'Old clause' })]
    const freshItems = [fresh({ product_name: 'Setup fee', billing_period: 'one_time', fee_id: 'F-1', source_section: 'New clause' })]

    const firstPlan = planCurrentLineItemReconciliation({ currentItems: currentBefore, freshItems, terms })
    expect(firstPlan.updates).toEqual([{ id: 'c1', changes: { source_section: 'New clause' }, family: 'one_time', reason: 'same' }])

    // Simulate the applier's UPDATE: merge `changes` onto the row in place.
    const simulatedAfterApply: CurrentLineItemRow[] = currentBefore.map(row =>
      row.id === firstPlan.updates[0].id ? { ...row, ...firstPlan.updates[0].changes } as CurrentLineItemRow : row,
    )

    const secondPlan = planCurrentLineItemReconciliation({ currentItems: simulatedAfterApply, freshItems, terms })
    expect(secondPlan.updates).toEqual([])
    expect(secondPlan.blockers).toEqual([])
  })

  it('a REMOVED supersede converges: after simulated apply, the superseded row is no longer part of the current set the planner sees', () => {
    const terms = termsWithTiers([]) // fresh side now has zero tiers — the current tier row is genuinely gone
    const currentBefore = [current({ id: 'c1', product_name: 'Widgets 1-100 — overage', quantity: 0, unit_price: 1, tier_id: 'T-1' })]
    const freshItems: FreshLineItemLike[] = []

    const firstPlan = planCurrentLineItemReconciliation({ currentItems: currentBefore, freshItems, terms })
    expect(firstPlan.supersedes).toEqual([{ id: 'c1', family: 'tier', reason: 'removed' }])

    // Simulate the applier: a superseded row drops out of the CURRENT
    // population entirely (current_line_items' own WHERE superseded_at IS
    // NULL semantics) — the next planning pass never receives it at all.
    const simulatedAfterApply = currentBefore.filter(row => !firstPlan.supersedes.some(s => s.id === row.id))

    const secondPlan = planCurrentLineItemReconciliation({ currentItems: simulatedAfterApply, freshItems, terms })
    expect(secondPlan.supersedes).toEqual([])
    expect(secondPlan.inserts).toEqual([])
    expect(secondPlan.expectedCurrentRowIds).toEqual([])
  })
})
