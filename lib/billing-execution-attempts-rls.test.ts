import { describe, it, expect } from 'vitest'
import { createBrowserClient, supabaseServer } from './supabase'

// ═══════════════════════════════════════════════════════════════════════════
// Tenant-isolation + immutability regression tests for Step 14's execution-
// safety tables (supabase/migrations/20260825000001-3_billing_execution_*).
// Same architecture note as lib/operational-event-evidence-rls.test.ts: this
// app never issues per-user Supabase Auth sessions to the browser, so the
// database-layer boundary tested here is "can the anon key (shipped to
// every browser) reach these tables at all" — answer must be no. The
// per-organization/per-job isolation boundary (item 17/26's "crafted
// attempt/operation id from another org/job -> rejected") is application
// code — reconcile-billing-operation's own ownership chain, proven
// separately via real HTTP in the Step 14 report.
//
// SKIPPED BY DEFAULT — real network calls. Run deliberately after applying
// all three migrations:
//   RUN_RLS_INTEGRATION_TESTS=true npx vitest run lib/billing-execution-attempts-rls.test.ts
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
    .insert({ name: 'RLS test job', module: 'AUTO_CONFIGURE', currency: 'EUR', org_id: orgId })
    .select('id').single()
  if (error || !data) throw new Error(`createTestJob failed: ${error?.message}`)
  return data.id as string
}

async function createTestAttempt(orgId: string, jobId: string, fingerprint = 'test-fingerprint-1'): Promise<string> {
  const { data, error } = await supabaseServer
    .from('billing_execution_attempts')
    .insert({ org_id: orgId, job_id: jobId, provider: 'stripe', attempt_number: 1, billing_plan_fingerprint: fingerprint, billing_plan_snapshot: { lines: [] } })
    .select('id').single()
  if (error || !data) throw new Error(`createTestAttempt failed: ${error?.message}`)
  return data.id as string
}

describeIf('billing_execution_attempts/operations/admin_actions — deliberately service-role-only; anon key must not reach them at all', () => {
  const anon = createBrowserClient()

  it('SELECT via anon key returns no rows on all three tables', async () => {
    for (const table of ['billing_execution_attempts', 'billing_execution_operations', 'billing_execution_admin_actions'] as const) {
      const { data, error } = await anon.from(table).select('id').limit(1)
      if (!error) expect(data ?? []).toHaveLength(0)
    }
  })

  it('INSERT via anon key cannot manufacture an execution attempt', async () => {
    const { error } = await anon.from('billing_execution_attempts').insert({
      org_id: '00000000-0000-0000-0000-000000000000', job_id: '00000000-0000-0000-0000-000000000000',
      provider: 'stripe', attempt_number: 1, billing_plan_fingerprint: 'x', billing_plan_snapshot: {},
    })
    expect(error).toBeTruthy()
  })

  it('INSERT via anon key cannot manufacture an execution operation', async () => {
    const { error } = await anon.from('billing_execution_operations').insert({
      attempt_id: '00000000-0000-0000-0000-000000000000', operation_key: 'x', operation_type: 'x',
      request_fingerprint: 'x', retry_capability: 'idempotent_retry',
    })
    expect(error).toBeTruthy()
  })

  it('INSERT via anon key cannot manufacture an admin action (cannot forge a retry authorization)', async () => {
    const { error } = await anon.from('billing_execution_admin_actions').insert({
      attempt_id: '00000000-0000-0000-0000-000000000000', action: 'retry_authorized', actor_email: 'anon@isolation-test.invalid',
    })
    expect(error).toBeTruthy()
  })

  it('UPDATE via anon key affects no rows on any of the three tables', async () => {
    for (const table of ['billing_execution_attempts', 'billing_execution_operations', 'billing_execution_admin_actions'] as const) {
      const { error, data } = await anon.from(table).update({ status: 'succeeded' }).eq('id', '00000000-0000-0000-0000-000000000000').select('id')
      if (!error) expect(data ?? []).toHaveLength(0)
    }
  })

  it('DELETE via anon key affects no rows on any of the three tables', async () => {
    for (const table of ['billing_execution_attempts', 'billing_execution_operations', 'billing_execution_admin_actions'] as const) {
      const { error, data } = await anon.from(table).delete().eq('id', '00000000-0000-0000-0000-000000000000').select('id')
      if (!error) expect(data ?? []).toHaveLength(0)
    }
  })
})

describeIf('billing_execution_attempts — identity immutability (item 19), even for a direct service-role write', () => {
  it('billing_plan_fingerprint cannot be changed once created', async () => {
    const orgId = await createTestOrg('Attempt Immutability Fingerprint')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { error } = await supabaseServer.from('billing_execution_attempts').update({ billing_plan_fingerprint: 'CHANGED' }).eq('id', attemptId)
      expect(error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('job_id, provider, attempt_number cannot be changed once created', async () => {
    const orgId = await createTestOrg('Attempt Immutability Identity')
    const jobId = await createTestJob(orgId)
    const otherJobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const r1 = await supabaseServer.from('billing_execution_attempts').update({ job_id: otherJobId }).eq('id', attemptId)
      expect(r1.error).toBeTruthy()
      const r2 = await supabaseServer.from('billing_execution_attempts').update({ provider: 'remembill' }).eq('id', attemptId)
      expect(r2.error).toBeTruthy()
      const r3 = await supabaseServer.from('billing_execution_attempts').update({ attempt_number: 99 }).eq('id', attemptId)
      expect(r3.error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('jobs').delete().eq('id', otherJobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('status IS mutable — the trigger only blocks identity fields, not state transitions', async () => {
    const orgId = await createTestOrg('Attempt Status Mutable')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { error } = await supabaseServer.from('billing_execution_attempts').update({ status: 'executing' }).eq('id', attemptId)
      expect(error).toBeFalsy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('at most one active (created/executing) attempt per (job, provider) — the partial unique index', async () => {
    const orgId = await createTestOrg('Attempt Uniqueness')
    const jobId = await createTestJob(orgId)
    try {
      await createTestAttempt(orgId, jobId, 'fp-1')
      const { error } = await supabaseServer.from('billing_execution_attempts').insert({
        org_id: orgId, job_id: jobId, provider: 'stripe', attempt_number: 2, billing_plan_fingerprint: 'fp-2', billing_plan_snapshot: {},
      })
      expect(error).toBeTruthy() // unique index violation — a second ACTIVE attempt for the same job+provider
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('a terminal (succeeded) attempt does NOT block a new active one for the same job+provider', async () => {
    const orgId = await createTestOrg('Attempt Uniqueness Terminal')
    const jobId = await createTestJob(orgId)
    try {
      const first = await createTestAttempt(orgId, jobId, 'fp-1')
      await supabaseServer.from('billing_execution_attempts').update({ status: 'succeeded' }).eq('id', first)
      const { error } = await supabaseServer.from('billing_execution_attempts').insert({
        org_id: orgId, job_id: jobId, provider: 'stripe', attempt_number: 2, billing_plan_fingerprint: 'fp-2', billing_plan_snapshot: {},
      })
      expect(error).toBeFalsy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('billing_execution_operations — identity immutability + one-way external_object_id (item 19/20)', () => {
  it('operation_key, operation_type, idempotency_key, request_fingerprint, retry_capability cannot be changed once created', async () => {
    const orgId = await createTestOrg('Operation Immutability')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { data: op } = await supabaseServer.from('billing_execution_operations').insert({
        attempt_id: attemptId, operation_key: 'create_invoice', operation_type: 'create_invoice',
        idempotency_key: 'verdix:x:stripe:create_invoice', request_fingerprint: 'fp', retry_capability: 'idempotent_retry',
      }).select('id').single()
      const r1 = await supabaseServer.from('billing_execution_operations').update({ operation_key: 'changed' }).eq('id', op!.id)
      expect(r1.error).toBeTruthy()
      const r2 = await supabaseServer.from('billing_execution_operations').update({ retry_capability: 'manual_verification_required' }).eq('id', op!.id)
      expect(r2.error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('external_object_id can be set once (null -> value), then never changed again', async () => {
    const orgId = await createTestOrg('Operation External Id')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { data: op } = await supabaseServer.from('billing_execution_operations').insert({
        attempt_id: attemptId, operation_key: 'create_invoice', operation_type: 'create_invoice',
        request_fingerprint: 'fp', retry_capability: 'idempotent_retry',
      }).select('id').single()
      const first = await supabaseServer.from('billing_execution_operations').update({ external_object_id: 'in_real123', status: 'succeeded' }).eq('id', op!.id)
      expect(first.error).toBeFalsy()
      const second = await supabaseServer.from('billing_execution_operations').update({ external_object_id: 'in_different456' }).eq('id', op!.id)
      expect(second.error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('unique(attempt_id, operation_key) — two operations cannot share a key within the same attempt', async () => {
    const orgId = await createTestOrg('Operation Key Uniqueness')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      await supabaseServer.from('billing_execution_operations').insert({
        attempt_id: attemptId, operation_key: 'create_invoice', operation_type: 'create_invoice', request_fingerprint: 'fp', retry_capability: 'idempotent_retry',
      })
      const { error } = await supabaseServer.from('billing_execution_operations').insert({
        attempt_id: attemptId, operation_key: 'create_invoice', operation_type: 'create_invoice', request_fingerprint: 'fp2', retry_capability: 'idempotent_retry',
      })
      expect(error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })
})

describeIf('billing_execution_admin_actions — append-only (item 24), corrected across three iterations found live', () => {
  it('UPDATE is rejected unconditionally, even for service_role (RLS alone does not enforce this — service_role bypasses RLS entirely; the real enforcement is a trigger)', async () => {
    const orgId = await createTestOrg('AdminAction Update Blocked')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { data: action } = await supabaseServer.from('billing_execution_admin_actions').insert({
        attempt_id: attemptId, action: 'retry_authorized', actor_email: 'admin@test.local',
      }).select('id').single()
      const { error } = await supabaseServer.from('billing_execution_admin_actions').update({ actor_email: 'someone-else@test.local' }).eq('id', action!.id)
      expect(error).toBeTruthy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('DELETE is deliberately NOT blocked at the database level (only UPDATE is) — the second, over-aggressive design was reverted specifically because it broke the existing job-cascade-delete feature; the real guarantee is that no application code path ever calls .delete() directly on this table (only lib/billing-execution-store.ts writes to it at all, and it never deletes)', async () => {
    const orgId = await createTestOrg('AdminAction Direct Delete Allowed')
    const jobId = await createTestJob(orgId)
    try {
      const attemptId = await createTestAttempt(orgId, jobId)
      const { data: action } = await supabaseServer.from('billing_execution_admin_actions').insert({
        attempt_id: attemptId, action: 'retry_authorized', actor_email: 'admin@test.local',
      }).select('id').single()
      const { error } = await supabaseServer.from('billing_execution_admin_actions').delete().eq('id', action!.id)
      expect(error).toBeFalsy()
    } finally {
      await supabaseServer.from('jobs').delete().eq('id', jobId)
      await supabaseServer.from('organizations').delete().eq('id', orgId)
    }
  })

  it('deleting the owning job DOES cascade-delete the admin action, as a whole record, via the existing job-delete feature', async () => {
    const orgId = await createTestOrg('AdminAction Cascade Delete')
    const jobId = await createTestJob(orgId)
    const attemptId = await createTestAttempt(orgId, jobId)
    const { data: action } = await supabaseServer.from('billing_execution_admin_actions').insert({
      attempt_id: attemptId, action: 'retry_authorized', actor_email: 'admin@test.local',
    }).select('id').single()
    const { error: delErr } = await supabaseServer.from('jobs').delete().eq('id', jobId)
    expect(delErr).toBeFalsy()
    const { data: gone } = await supabaseServer.from('billing_execution_admin_actions').select('id').eq('id', action!.id)
    expect(gone ?? []).toHaveLength(0)
    await supabaseServer.from('organizations').delete().eq('id', orgId)
  })
})
