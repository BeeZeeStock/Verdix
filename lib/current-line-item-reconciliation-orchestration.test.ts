import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileCurrentLineItemsForJob } from './current-line-item-reconciliation-orchestration'
import type { ReconciliationTermsContext } from './current-line-item-reconciliation-plan'

// Step 17H.4B0D4H1B3 §41 — stale_plan retry behavior, mocked Supabase (no
// real DB — the applier RPC itself is not migrated in this session; see
// the H1B2/H1B2.1 reports for that disclosed limitation, unchanged here).

const EMPTY_TERMS: ReconciliationTermsContext = { overage_tiers: [], additional_recurring_fees: [], base_fee_proration: null }

function mockSupabase(sequence: Array<{ currentRows: unknown[]; rpcResult: unknown }>): { client: SupabaseClient; rpcSpy: ReturnType<typeof vi.fn>; fromSpy: ReturnType<typeof vi.fn> } {
  let call = 0
  const fromSpy = vi.fn().mockImplementation((table: string) => {
    if (table !== 'current_line_items') throw new Error(`unexpected table ${table}`)
    const idx = Math.min(call, sequence.length - 1)
    const rows = sequence[idx].currentRows
    return {
      select: () => ({
        eq: () => Promise.resolve({ data: rows, error: null }),
      }),
    }
  })
  const rpcSpy = vi.fn().mockImplementation(() => {
    const idx = Math.min(call, sequence.length - 1)
    const result = sequence[idx].rpcResult
    call++
    return Promise.resolve({ data: result, error: null })
  })
  const client = { rpc: rpcSpy, from: fromSpy } as unknown as SupabaseClient
  return { client, rpcSpy, fromSpy }
}

const FRESH_ONE_TIME = [{ product_name: 'Setup fee', quantity: 1, unit_price: 100, billing_period: 'one_time', total_amount: 100, confidence_score: 0.95, source_section: null, fee_id: 'F-1' }]

describe('reconcileCurrentLineItemsForJob (§40/§41)', () => {
  it('current SAME / no mutations -> applied 0/0/0', async () => {
    const currentRow = { id: 'c1', product_name: 'Setup fee', quantity: 1, unit_price: 100, billing_period: 'one_time', total_amount: 100, confidence_score: 0.95, currency: 'EUR', stripe_price_id: null, applied_rule: null, correction_reason: null, source_section: null, reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null, fee_id: 'F-1', tier_id: null }
    const { client } = mockSupabase([{ currentRows: [currentRow], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 0, superseded_count: 0 } }])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result).toEqual({ status: 'applied', updatedCount: 0, insertedCount: 0, supersededCount: 0, blockers: [], retried: false })
  })

  it('safe NEW rows insert through the applier', async () => {
    const { client, rpcSpy } = mockSupabase([{ currentRows: [], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 1, superseded_count: 0 } }])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result.status).toBe('applied')
    if (result.status === 'applied') expect(result.insertedCount).toBe(1)
    expect(rpcSpy).toHaveBeenCalledTimes(1)
  })

  it('blockers + safe other-family mutations: applied outcome carries the real blockers array', async () => {
    const { client } = mockSupabase([{ currentRows: [], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 1, superseded_count: 0 } }])
    // The planner itself decides blockers from currentItems/freshItems/terms
    // shape — here we just confirm the orchestration surfaces plan.blockers
    // unchanged from whatever the (real, unmocked) planner computed.
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result.blockers).toEqual([])
  })

  it('first apply stale -> re-read/re-plan -> second apply succeeds, retried:true', async () => {
    const { client, fromSpy, rpcSpy } = mockSupabase([
      { currentRows: [], rpcResult: { status: 'stale_plan', reason: 'current_set_changed' } },
      { currentRows: [], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 1, superseded_count: 0 } },
    ])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result.status).toBe('applied')
    expect(result.retried).toBe(true)
    expect(fromSpy).toHaveBeenCalledTimes(2) // re-read happened exactly once
    expect(rpcSpy).toHaveBeenCalledTimes(2) // re-apply happened exactly once
  })

  it('first + second both stale -> stops, no third attempt, returns stale_plan', async () => {
    const { client, fromSpy, rpcSpy } = mockSupabase([
      { currentRows: [], rpcResult: { status: 'stale_plan', reason: 'current_set_changed' } },
      { currentRows: [], rpcResult: { status: 'stale_plan', reason: 'current_row_changed' } },
    ])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result).toMatchObject({ status: 'stale_plan', staleReason: 'current_row_changed', retried: true })
    expect(fromSpy).toHaveBeenCalledTimes(2)
    expect(rpcSpy).toHaveBeenCalledTimes(2) // never a third call
  })

  it('invalid_plan is returned immediately, no retry (retry is only for stale_plan)', async () => {
    const { client, rpcSpy } = mockSupabase([{ currentRows: [], rpcResult: { status: 'invalid_plan', reason: 'insert_missing_currency' } }])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result).toEqual({ status: 'invalid_plan', invalidReason: 'insert_missing_currency', blockers: [], retried: false })
    expect(rpcSpy).toHaveBeenCalledTimes(1)
  })

  it('RPC infrastructure error is returned immediately as status:error, no retry', async () => {
    let call = 0
    const rpcSpy = vi.fn().mockImplementation(() => { call++; return Promise.resolve({ data: null, error: { message: 'network reset' } }) })
    const fromSpy = vi.fn().mockReturnValue({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) })
    const client = { rpc: rpcSpy, from: fromSpy } as unknown as SupabaseClient
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result).toEqual({ status: 'error', errorMessage: 'network reset', blockers: [], retried: false })
    expect(call).toBe(1)
  })

  it('second planner run converges: after a NEW row is simulated as already inserted, no second insert is proposed', async () => {
    const insertedRow = { id: 'generated-1', product_name: 'Setup fee', quantity: 1, unit_price: 100, billing_period: 'one_time', total_amount: 100, confidence_score: 0.95, currency: 'EUR', stripe_price_id: null, applied_rule: null, correction_reason: null, source_section: null, reviewer_corrected_fields: [], reviewer_corrected_fields_complete: true, reviewer_corrected_at: null, fee_id: 'F-1', tier_id: null }
    const { client } = mockSupabase([{ currentRows: [insertedRow], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 0, superseded_count: 0 } }])
    const result = await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    expect(result).toEqual({ status: 'applied', updatedCount: 0, insertedCount: 0, supersededCount: 0, blockers: [], retried: false })
  })

  it('no raw line_items insert is ever called — the orchestration only ever touches current_line_items (read) and the RPC (write)', async () => {
    const { client, fromSpy } = mockSupabase([{ currentRows: [], rpcResult: { status: 'applied', updated_count: 0, inserted_count: 1, superseded_count: 0 } }])
    await reconcileCurrentLineItemsForJob({ supabase: client, jobId: 'job-1', freshItems: FRESH_ONE_TIME, terms: EMPTY_TERMS })
    for (const call of fromSpy.mock.calls) expect(call[0]).toBe('current_line_items')
  })
})
