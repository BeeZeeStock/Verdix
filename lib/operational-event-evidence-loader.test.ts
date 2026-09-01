import { describe, it, expect } from 'vitest'
import { supabaseServer } from './supabase'
import { loadActiveOperationalEventEvidence } from './operational-event-evidence-loader'

// ═══════════════════════════════════════════════════════════════════════════
// Step 17H.2A item 2 — loadActiveOperationalEventEvidence is the ONE shared
// loader approve/route.ts, rebuild-schedule/route.ts, and billing-summary/
// route.ts all call (previously two independent inline copies in
// approve/route.ts, a third in billing-summary/route.ts, and no copy at all
// in rebuild-schedule/route.ts — the root cause of that route's bug:
// configureBilling always saw [] and incorrectly re-parked every
// event-gated fee on every rebuild, even ones already cleared to bill).
// This proves the loader itself is correct against a real database: only
// active rows for the requested job, mapped with the right field names,
// excluding revoked rows and other jobs' rows.
//
// Deliberately its own file, not folded into operational-event-evidence-
// rls.test.ts's table-level RLS suite: this module is a route-handler-only
// loader (imports supabaseServer) and must never be imported from
// lib/operational-event-evidence.ts or anything reachable from a client
// component — see this file's own header comment for the regression that
// happened when the loader briefly lived inside that pure module instead.
//
// SKIPPED BY DEFAULT — real network calls:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/operational-event-evidence-loader.test.ts
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
    .insert({ name: 'Evidence loader test job', module: 'BILLING_VERIFICATION', currency: 'SEK', org_id: orgId, user_id: 'evidence-loader-test@isolation-test.invalid' })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

describeIf('loadActiveOperationalEventEvidence (Step 17H.2A item 2)', () => {
  it('loads only active evidence for the requested job — excludes revoked rows and rows on a different job', async () => {
    const orgId = await createTestOrg('Evidence Loader Test')
    const jobId = await createTestJob(orgId)
    const otherJobId = await createTestJob(orgId)
    try {
      const { data: active } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-loader-active-1', event_type: 'customer_acceptance',
        occurred_at: '2026-08-20T00:00:00.000Z', source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      }).select('id').single()

      const { data: toRevoke } = await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: jobId, subject_id: 'fee-loader-revoked-1', event_type: 'delivery',
        occurred_at: '2026-08-21T00:00:00.000Z', source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      }).select('id').single()
      await supabaseServer.from('operational_event_evidence').update({
        status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: 'test@isolation-test.invalid',
      }).eq('id', toRevoke!.id)

      await supabaseServer.from('operational_event_evidence').insert({
        org_id: orgId, job_id: otherJobId, subject_id: 'fee-loader-other-job-1', event_type: 'customer_acceptance',
        occurred_at: '2026-08-22T00:00:00.000Z', source: 'reviewer_attestation', recorded_by: 'test@isolation-test.invalid',
      })

      const evidence = await loadActiveOperationalEventEvidence(jobId)
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({
        id: active!.id, subjectId: 'fee-loader-active-1', eventType: 'customer_acceptance',
        source: 'reviewer_attestation', status: 'active',
      })
    } finally {
      await supabaseServer.from('operational_event_evidence').delete().in('job_id', [jobId, otherJobId])
      await supabaseServer.from('jobs').delete().in('id', [jobId, otherJobId])
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a job with no evidence rows at all returns an empty array, never throws', async () => {
    const orgId = await createTestOrg('Evidence Loader Empty Test')
    const jobId = await createTestJob(orgId)
    try {
      const evidence = await loadActiveOperationalEventEvidence(jobId)
      expect(evidence).toEqual([])
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})
