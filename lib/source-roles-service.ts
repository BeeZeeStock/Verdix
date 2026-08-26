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
export async function ensureReviewerAttestationRole(job_id: string, org_id: string): Promise<SourceRole> {
  const existing = (await listSourceRolesForJob(job_id)).find(r => r.role_key === RESERVED_SOURCE_ROLE_KEY)
  if (existing) return existing
  return registerSourceRole(job_id, org_id, RESERVED_SOURCE_ROLE_KEY)
}
