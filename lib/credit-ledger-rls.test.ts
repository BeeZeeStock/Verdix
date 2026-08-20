import { describe, it, expect } from 'vitest'
import { createBrowserClient } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-isolation regression test for credit_ledger_entries and the
// reserve_credit_balance RPC (supabase/migrations/20260821000001_credit_ledger.sql).
//
// Same architecture note as lib/rls-isolation.test.ts: the meaningful
// boundary here is "can the anon key (shipped to every browser) read/write
// ledger rows or invoke the reservation RPC directly via the Supabase Data
// API" — not a per-user Supabase session, which this app doesn't issue.
//
// The RPC needs its own explicit REVOKE/GRANT beyond the table's RLS policy
// — a `security definer` function runs with the function owner's privileges
// regardless of the caller's RLS standing, so table-level RLS alone would
// not have been sufficient to lock it down.
//
// SKIPPED BY DEFAULT — real network calls against whatever Supabase project
// NEXT_PUBLIC_SUPABASE_URL points at. Run after applying the migration:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/credit-ledger-rls.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

describeIf('credit_ledger_entries + reserve_credit_balance — anon/authenticated must not reach the ledger', () => {
  const anon = createBrowserClient()

  it('SELECT on credit_ledger_entries returns no rows for the anon key', async () => {
    const { data, error } = await anon.from('credit_ledger_entries').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT into credit_ledger_entries via anon key is rejected', async () => {
    const { error } = await anon.from('credit_ledger_entries').insert({
      job_id: '00000000-0000-0000-0000-000000000000',
      org_id: '00000000-0000-0000-0000-000000000000',
      credit_rule_id: 'anon-test',
      entry_type: 'earn',
      window_start: '2026-01-01',
      window_end: '2026-01-31',
      currency: 'SEK',
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE on credit_ledger_entries via anon key affects no rows', async () => {
    const { error, data } = await anon
      .from('credit_ledger_entries')
      .update({ amount_minor: 999999999 })
      .eq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('reserve_credit_balance RPC is not callable with the anon key (revoked from anon and public)', async () => {
    const { error } = await anon.rpc('reserve_credit_balance', {
      p_job_id: '00000000-0000-0000-0000-000000000000',
      p_credit_rule_id: 'anon-test',
      p_planned_invoice_id: '00000000-0000-0000-0000-000000000000',
      p_period_start: '2026-01-01',
      p_requested_amount_minor: 1000,
      p_currency: 'SEK',
      p_details: {},
      p_is_one_time: false,
      p_source_clause: null,
      p_commercial_rule_interpretation_id: null,
    })
    // Must error — EXECUTE was explicitly revoked from anon/authenticated/public
    // in the migration; a successful call here would mean the RPC's own grant
    // (not just the table's RLS) failed to take effect.
    expect(error).toBeTruthy()
  })
})
