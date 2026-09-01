import { describe, it, expect, afterAll } from 'vitest'
import { createServerClient } from './supabase'

// Step 17H.4B0D4H1B4E3.1 §32-36 — real-Postgres validation for the
// initialization lifecycle/concurrency authority (establish_initial_
// commercial_snapshot, migration 20260915000001_commercial_snapshot_
// initialization.sql). Proves atomicity, one-time initialization, and
// concurrent-attempt safety against the ACTUAL database — not mocked —
// per this project's own established opt-in pattern
// (lib/rls-isolation.test.ts).
//
// SKIPPED BY DEFAULT. Requires the above migration to be applied first:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/initial-commercial-snapshot-integration.test.ts
// Before that migration is applied, every test here fails with
// "column jobs.commercial_snapshot_initialized_at does not exist" /
// "Could not find the function public.establish_initial_commercial_snapshot"
// — that failure means the migration genuinely has not been applied yet,
// not a code defect in this test file or in lib/initial-commercial-
// snapshot.ts.

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

// Reused real test org from this session's E3 acceptance pass
// (Lynora AB) — org scoping is irrelevant to this RPC (it never reads
// org_id), reused only so throwaway jobs are attributable/cleanable.
const TEST_ORG_ID = 'b911acab-03b1-48fd-8195-e2b2731ed69a'

const supabase = createServerClient()

async function createThrowawayJob(name: string): Promise<string> {
  const { data, error } = await supabase
    .from('jobs')
    .insert({ name, module: 'AUTO_CONFIGURE', org_id: TEST_ORG_ID, currency: 'EUR' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create throwaway test job: ${error?.message}`)
  return data.id as string
}

const WEAK_FAMILY_INSERT = {
  product_name: 'Recurring base fee (periods 1–12)',
  quantity: 12, unit_price: 2000, billing_period: 'monthly', total_amount: 24000,
  currency: 'EUR', confidence_score: 0.97, source_section: 'Bilaga 1, Section 4',
  fee_id: null, tier_id: null,
}

const createdJobIds: string[] = []

describeIf('establish_initial_commercial_snapshot — real Postgres', () => {
  afterAll(async () => {
    if (createdJobIds.length === 0) return
    // Throwaway TEST jobs only, never a regression fixture — cleaned up
    // where practical, per §36's own instruction.
    await supabase.from('line_items').delete().in('job_id', createdJobIds)
    await supabase.from('jobs').delete().in('id', createdJobIds)
  })

  it('§14/§24 — initializes cleanly for a weak-identity fresh batch on a genuine first extraction', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — clean weak-family init')
    createdJobIds.push(jobId)

    const { data, error } = await supabase.rpc('establish_initial_commercial_snapshot', {
      p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT],
    })
    expect(error).toBeNull()
    expect(data.status).toBe('applied')
    expect(data.inserted_count).toBe(1)

    const { data: rows } = await supabase.from('line_items').select('*').eq('job_id', jobId)
    expect(rows).toHaveLength(1)
    expect(rows![0].reviewer_corrected_fields).toEqual([])
    expect(rows![0].reviewer_corrected_fields_complete).toBe(true)
    expect(rows![0].reviewer_corrected_at).toBeNull()
    expect(rows![0].superseded_at).toBeNull()

    const { data: jobRow } = await supabase.from('jobs').select('commercial_snapshot_initialized_at').eq('id', jobId).single()
    expect(jobRow?.commercial_snapshot_initialized_at).not.toBeNull()
  })

  it('§16 — a second call on the same job returns already_initialized and inserts nothing further', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — one-time-only init')
    createdJobIds.push(jobId)

    const first = await supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT] })
    expect(first.data.status).toBe('applied')

    const second = await supabase.rpc('establish_initial_commercial_snapshot', {
      p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT, { ...WEAK_FAMILY_INSERT, product_name: 'A second, different row' }],
    })
    expect(second.data.status).toBe('already_initialized')

    const { data: rows } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rows).toHaveLength(1)
  })

  it('§13 — two concurrent first-execute attempts on the same job: exactly one winner, no duplicate rows', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — concurrent init race')
    createdJobIds.push(jobId)

    const [a, b] = await Promise.all([
      supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT] }),
      supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT] }),
    ])
    const statuses = [a.data?.status, b.data?.status].sort()
    expect(statuses).toEqual(['already_initialized', 'applied'])

    const { data: rows } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rows).toHaveLength(1)
  })

  it('§5/§17 — refuses (not_eligible) when the marker is null but a prior line_items row already exists', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — ambiguous legacy evidence')
    createdJobIds.push(jobId)

    // Simulates a legacy/established job: a line_items row present through
    // some path other than this RPC, with the marker never set.
    await supabase.from('line_items').insert({
      job_id: jobId, product_name: 'Pre-existing legacy row', quantity: 1, unit_price: 100,
      billing_period: 'monthly', total_amount: 100, currency: 'EUR', confidence_score: 1,
    })

    const { data } = await supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT] })
    expect(data.status).toBe('not_eligible')

    const { data: rows } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rows).toHaveLength(1) // still only the pre-existing row — nothing added

    const { data: jobRow } = await supabase.from('jobs').select('commercial_snapshot_initialized_at').eq('id', jobId).single()
    expect(jobRow?.commercial_snapshot_initialized_at).toBeNull()
  })

  it('§7 — rejects an intrinsically malformed batch (duplicate tier_id within the same initial insert set)', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — intrinsic duplicate tier_id')
    createdJobIds.push(jobId)

    const duplicateTierRows = [
      { product_name: 'Requests 5,001+', quantity: 0, unit_price: 0.6, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, tier_id: 'same-tier-id', fee_id: null },
      { product_name: 'Requests 15,001+', quantity: 0, unit_price: 0.5, billing_period: 'monthly', total_amount: 0, currency: 'EUR', confidence_score: 0.9, tier_id: 'same-tier-id', fee_id: null },
    ]
    const { data } = await supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: duplicateTierRows })
    expect(data.status).toBe('invalid_plan')
    expect(data.reason).toBe('duplicate_tier_id_in_initial_batch')

    const { data: rows } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rows).toHaveLength(0)
    const { data: jobRow } = await supabase.from('jobs').select('commercial_snapshot_initialized_at').eq('id', jobId).single()
    expect(jobRow?.commercial_snapshot_initialized_at).toBeNull()
  })

  it('§3 (user follow-up) — a legitimate zero-line-item commercial model still establishes its snapshot exactly once', async () => {
    const jobId = await createThrowawayJob('E3.1 integration — zero-line-item initial snapshot')
    createdJobIds.push(jobId)

    // A job whose extracted commercial model genuinely produces no billable
    // line items yet (e.g. a contract that is 100% usage-priced with no
    // meter mappings resolved, or a pure pilot-waiver period with nothing
    // currently billable) must still be able to establish "snapshot 1" —
    // an empty current configuration is a legitimate state, not an error.
    const first = await supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [] })
    expect(first.error).toBeNull()
    expect(first.data.status).toBe('applied')
    expect(first.data.inserted_count).toBe(0)

    const { data: rows } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rows).toHaveLength(0)

    const { data: jobRowAfterFirst } = await supabase.from('jobs').select('commercial_snapshot_initialized_at').eq('id', jobId).single()
    expect(jobRowAfterFirst?.commercial_snapshot_initialized_at).not.toBeNull()

    // A later execute (even one that would now produce real fresh items)
    // must NOT re-enter initialization mode merely because current rows
    // are still empty — the marker alone governs.
    const second = await supabase.rpc('establish_initial_commercial_snapshot', { p_job_id: jobId, p_inserts: [WEAK_FAMILY_INSERT] })
    expect(second.data.status).toBe('already_initialized')

    const { data: rowsAfterSecond } = await supabase.from('line_items').select('id').eq('job_id', jobId)
    expect(rowsAfterSecond).toHaveLength(0) // still empty — the second call correctly inserted nothing
  })

  // Step 17H.4B0D4H1B4E3.5.1 — real live-reproduced gap (E3.5's acceptance
  // pass): this RPC predated recurring_fee_id and never carried it through
  // its own INSERT, so a job's genuine FIRST extraction always persisted
  // recurring_fee_id: null on every additional_recurring_fixed/variable
  // row, silently relying on the NEXT re-extraction's NULL->ID promotion
  // to backfill it one generation late. Fixed in migration
  // 20260917000001 (CREATE OR REPLACE, identical 2-arg signature). This
  // test is the direct, permanent regression guard for that fix.
  it('17H.4B0D4H1B4E3.5.1 — a recurring_fee_id-bearing additional_recurring_variable/fixed row persists its id on GENERATION 1, no promotion required', async () => {
    const jobId = await createThrowawayJob('E3.5.1 integration — generation-1 recurring_fee_id')
    createdJobIds.push(jobId)

    const variableInsert = {
      product_name: 'Per-completed payment success fee', quantity: 0, unit_price: 1.7, billing_period: 'monthly', total_amount: 0,
      currency: 'EUR', confidence_score: 0.97, source_section: 'Bilaga 1, Section 2',
      fee_id: null, tier_id: null, recurring_fee_id: 'rf-e351-variable-gen1',
    }
    const fixedInsert = {
      product_name: 'Support tier', quantity: 12, unit_price: 200, billing_period: 'monthly', total_amount: 2400,
      currency: 'EUR', confidence_score: 0.97, source_section: 'Bilaga 1, Section 4',
      fee_id: null, tier_id: null, recurring_fee_id: 'rf-e351-fixed-gen1',
    }
    const { data, error } = await supabase.rpc('establish_initial_commercial_snapshot', {
      p_job_id: jobId, p_inserts: [variableInsert, fixedInsert],
    })
    expect(error).toBeNull()
    expect(data.status).toBe('applied')
    expect(data.inserted_count).toBe(2)

    const { data: rows } = await supabase.from('line_items').select('product_name, recurring_fee_id').eq('job_id', jobId)
    console.log('E3.5.1_GENERATION1_ROWS:', JSON.stringify(rows))
    const variableRow = rows!.find(r => r.product_name === 'Per-completed payment success fee')
    const fixedRow = rows!.find(r => r.product_name === 'Support tier')
    // The central acceptance criterion — NON-NULL on generation 1, no
    // second extraction/promotion cycle required.
    expect(variableRow?.recurring_fee_id).toBe('rf-e351-variable-gen1')
    expect(fixedRow?.recurring_fee_id).toBe('rf-e351-fixed-gen1')
  })
})
