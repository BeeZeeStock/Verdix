// DB-touching persistence for source_roles — split from lib/source-roles.ts
// (pure) for the same next-auth-resolution reason as
// lib/billable-unit-qualification-service.ts. No connector logic here —
// identity registration only, per lib/source-roles.ts's own scope note.
import { supabaseServer } from './supabase'
import { RESERVED_SOURCE_ROLE_KEY, isValidSourceRoleKey, type SourceRole } from './source-roles'

const TABLE = 'source_roles'

export async function registerSourceRole(job_id: string, org_id: string, role_key: string): Promise<SourceRole> {
  if (!isValidSourceRoleKey(role_key)) throw new Error(`registerSourceRole: invalid role_key '${role_key}'`)
  const { data, error } = await supabaseServer.from(TABLE)
    .insert({ job_id, org_id, role_key })
    .select().single()
  if (error || !data) throw new Error(`registerSourceRole failed: ${error?.message}`)
  return data as SourceRole
}

export async function listSourceRolesForJob(job_id: string): Promise<SourceRole[]> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('job_id', job_id)
  if (error) throw new Error(`listSourceRolesForJob failed: ${error.message}`)
  return (data ?? []) as SourceRole[]
}

// Idempotent — safe to call whenever a job's source roles are first set up.
// Every job should have this registered so reviewer-attested evidence
// always has a real source identity, never an implicit null-binding
// exception.
//
// Pre-commit hardening audit (16B.2) — two concurrent first-time callers
// for the same job (e.g. two overlapping ensureReviewerAttestationBinding
// calls, lib/source-bindings-service.ts) can both observe zero existing
// rows and both attempt to register the role; source_roles' own
// unique(job_id, role_key) constraint (migration 20260830000007) lets
// only one INSERT win, and the loser previously surfaced that as a raw
// 23505 error instead of the idempotent result callers actually expect.
// Fixed the same way as every other idempotency race in this codebase
// (createOrGetCandidate, createSuccessorDraft): catch the duplicate-key
// error and re-read the winner rather than surfacing an unnecessary
// error — necessary here because 16B.2's ensureReviewerAttestationBinding
// concurrency guarantee depends on this layer already being race-safe.
export async function ensureReviewerAttestationRole(job_id: string, org_id: string): Promise<SourceRole> {
  const existing = (await listSourceRolesForJob(job_id)).find(r => r.role_key === RESERVED_SOURCE_ROLE_KEY)
  if (existing) return existing
  try {
    return await registerSourceRole(job_id, org_id, RESERVED_SOURCE_ROLE_KEY)
  } catch (err) {
    if (err instanceof Error && /duplicate key value/.test(err.message)) {
      const winner = (await listSourceRolesForJob(job_id)).find(r => r.role_key === RESERVED_SOURCE_ROLE_KEY)
      if (winner) return winner
    }
    throw err
  }
}
