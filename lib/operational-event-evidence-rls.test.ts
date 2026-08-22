import { describe, it, expect } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-isolation regression test for operational_event_evidence
// (supabase/migrations/20260824000001_operational_event_evidence.sql).
// Same architecture note as lib/rls-isolation.test.ts / lib/credit-ledger-
// rls.test.ts / lib/organization-rulebook-rls.test.ts: this app never issues
// per-user Supabase Auth sessions to the browser, so the database-layer
// boundary tested here is "can the anon key (shipped to every browser)
// reach this table at all" — answer must be no. The table is deliberately
// service-role-only (item 1: "if the table is deliberately service-role-
// only, prove that explicitly") — there is no per-organization RLS policy
// to test at the database layer because there is no non-service-role access
// path at all. The REAL per-organization isolation boundary (Org A can
// never read/write Org B's evidence) is application code — the attest/
// revoke routes' own job-scoped queries, always filtered by a trusted,
// session-derived organization_id — proven separately via real HTTP
// requests against the running dev server (see the Step 13 final amendment
// report for that run's results; route handlers themselves cannot be
// imported into vitest — next-auth import failure, established constraint).
//
// SKIPPED BY DEFAULT — real network calls. Run deliberately after applying
// the migration:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/operational-event-evidence-rls.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const RUN = process.env.RUN_RLS_INTEGRATION_TESTS === 'true'
const describeIf = RUN ? describe : describe.skip

async function createTestOrg(name: string): Promise<string> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await supabaseServer.from('organizations').insert({ name, slug }).select('id').single()
  if (error || !data) throw new Error(`createTestOrg failed: ${error?.message}`)
  return data.id as string
}

async function createTestJob(orgId: string): Promise<string> {
  const { data, error } = await supabaseServer
    .from('jobs')
    .insert({ name: 'RLS test job', module: 'BILLING_VERIFICATION', currency: 'SEK', org_id: orgId, user_id: 'rls-test@isolation-test.invalid' })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

describeIf('operational_event_evidence — deliberately service-role-only; anon key must not reach it at all', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows (RLS denies, or the query itself errors — either way, no data)', async () => {
    const { data, error } = await anon.from('operational_event_evidence').select('id').limit(1)
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('INSERT via anon key cannot manufacture reviewer_attestation evidence', async () => {
    const { error } = await anon.from('operational_event_evidence').insert({
      org_id: '00000000-0000-0000-0000-000000000000',
      job_id: '00000000-0000-0000-0000-000000000000',
      subject_id: 'anon-test-subject',
      event_type: 'customer_acceptance',
      occurred_at: new Date().toISOString(),
      source: 'reviewer_attestation',
      recorded_by: 'anon-test@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('INSERT via anon key cannot manufacture trusted_system_event evidence either — item 8', async () => {
    const { error } = await anon.from('operational_event_evidence').insert({
      org_id: '00000000-0000-0000-0000-000000000000',
      job_id: '00000000-0000-0000-0000-000000000000',
      subject_id: 'anon-test-subject',
      event_type: 'customer_acceptance',
      occurred_at: new Date().toISOString(),
      source: 'trusted_system_event',
      recorded_by: 'anon-test@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE via anon key affects no rows (cannot forge a revocation or flip status back to active)', async () => {
    const { error, data } = await anon
      .from('operational_event_evidence')
      .update({ status: 'revoked' })
      .eq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })

  it('DELETE via anon key affects no rows', async () => {
    const { error, data } = await anon
      .from('operational_event_evidence')
      .delete()
      .eq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    if (!error) expect(data ?? []).toHaveLength(0)
  })
})

describeIf('operational_event_evidence — database-level constraints hold even for a direct service-role write bypassing the routes', () => {
  it('the partial unique index rejects a second active row for the same (job_id, subject_id, event_type)', async () => {
    const orgId = await createTestOrg('Evidence Uniqueness Test')
    const jobId = await createTestJob(orgId)
    try {
      const base = {
        org_id: orgId, job_id: jobId, subject_id: 'fee-uniqueness-1', event_type: 'customer_acceptance',
        occurred_at: new Date().toISOString(), source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      }
      const { error: firstError } = await supabaseServer.from('operational_event_evidence').insert(base)
      expect(firstError).toBeFalsy()
      const { error: secondError } = await supabaseServer.from('operational_event_evidence').insert(base)
      expect(secondError).toBeTruthy() // unique index violation
    } finally {
      await supabaseServer.from('operational_event_evidence').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a revoked row does NOT block a fresh active row for the same subject+event (partial index scoping)', async () => {
    const orgId = await createTestOrg('Evidence Revoke-Reinsert Test')
    const jobId = await createTestJob(orgId)
    try {
      const { data: first } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-revoke-reinsert-1', event_type: 'customer_acceptance',
        occurred_at: new Date().toISOString(), source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      }).select('id').single()
      await supabaseServer.from('operational_event_evidence').update({
        status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: 'test@isolation-test.invalid',
      }).eq('id', first!.id)

      const { error: secondError } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-revoke-reinsert-1', event_type: 'customer_acceptance',
        occurred_at: new Date().toISOString(), source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      })
      expect(secondError).toBeFalsy()
    } finally {
      await supabaseServer.from('operational_event_evidence').delete().eq('job_id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('the event_type CHECK constraint rejects a value outside the closed BillabilityEventType set, even written directly', async () => {
    const orgId = await createTestOrg('Evidence Event-Type Constraint Test')
    const jobId = await createTestJob(orgId)
    try {
      const { error } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-bad-event-1', event_type: 'deemed_acceptance',
        occurred_at: new Date().toISOString(), source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      })
      expect(error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('the revoked-shape CHECK constraint rejects status=revoked without revoked_at/revoked_by', async () => {
    const orgId = await createTestOrg('Evidence Revoked-Shape Constraint Test')
    const jobId = await createTestJob(orgId)
    try {
      const { error } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-bad-revoke-1', event_type: 'customer_acceptance',
        occurred_at: new Date().toISOString(), source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
        status: 'revoked',
      })
      expect(error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})
