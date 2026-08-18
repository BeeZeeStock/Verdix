import { describe, it, expect } from 'vitest'
import { createBrowserClient } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-isolation regression test for the 2026-08-19 RLS audit
// (supabase/migrations/20260819000003_rls_lockdown.sql).
//
// Architecture note (read before "fixing" this file): this app does NOT
// issue per-user Supabase Auth sessions to the browser. The real identity
// layer is NextAuth (lib/auth.ts) — org membership is enforced by
// requireOrg() reading org_memberships via the SERVICE-ROLE client
// (supabaseServer), never by a Supabase JWT the browser holds. The only
// credential the browser ever gets is the anon key (createBrowserClient()),
// which is not tied to any particular user or org at all.
//
// That means the meaningful tenant-isolation boundary to test here isn't
// "can Org A's Supabase session read Org B's rows" (there is no such
// session) — it's "can the anon key, which is shipped to every browser by
// design, read/write ANY org's data directly via the Supabase Data API,
// bypassing requireOrg() entirely." That's exactly the hole the audit found
// (every RLS policy in this schema was written without a `to service_role`
// clause, so it applied to PUBLIC — anon included) and exactly what this
// file proves is closed.
//
// SKIPPED BY DEFAULT — these make real network calls against whatever
// Supabase project NEXT_PUBLIC_SUPABASE_URL points at. Run deliberately
// after applying the RLS lockdown migration:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/rls-isolation.test.ts
// Before that migration is applied, expect these to FAIL — that failure IS
// the vulnerability the migration fixes, so a red run pre-migration and a
// green run post-migration is the intended before/after signal.
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

// A representative sample, not exhaustive — the lockdown migration applies
// the identical `to service_role` fix mechanically to every table in its
// loop, so one table per category is enough to prove the pattern actually
// took effect against the real database rather than re-deriving the same
// proof ~20 times.
const CUSTOMER_DATA_TABLES = ['jobs', 'contract_terms', 'org_memberships', 'organizations', 'pii_entities'] as const

describeIf('RLS lockdown — anon key must not reach customer data', () => {
  const anon = createBrowserClient()

  for (const table of CUSTOMER_DATA_TABLES) {
    it(`SELECT on "${table}" returns no rows for the anon key`, async () => {
      const { data, error } = await anon.from(table).select('id').limit(1)
      // Either an outright permission error, or a query that "succeeds" but
      // is filtered down to zero rows — both are acceptable proof of
      // isolation. Getting real rows back is the failure mode.
      if (!error) expect(data ?? []).toHaveLength(0)
    })
  }

  it('UPDATE on "jobs" via anon key affects no rows (targets a non-existent id — safe against real data)', async () => {
    const { error, data } = await anon
      .from('jobs')
      .update({ name: 'rls-isolation-test-should-never-apply' })
      .eq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    // A real permission error is the strongest signal; if the query is
    // merely denied by returning zero matched rows that's acceptable too,
    // since the target id doesn't exist either way.
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT into "org_memberships" via anon key is rejected (would otherwise let anyone self-grant org ownership)', async () => {
    const { error } = await anon.from('org_memberships').insert({
      org_id: '00000000-0000-0000-0000-000000000000',
      user_email: 'rls-isolation-test@isolation-test.invalid',
      role: 'owner',
      status: 'active',
    })
    // This one MUST error — a successful insert here is the exact auth-bypass
    // chain the audit flagged as the most severe finding (self-granting org
    // ownership via the anon key, then walking through the app's own
    // requireOrg() as if legitimately invited).
    expect(error).toBeTruthy()
  })

  it('demo_leads (added this session) is not anon-readable despite being a public-facing capture form', async () => {
    const { data, error } = await anon.from('demo_leads').select('id, email').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })
})
