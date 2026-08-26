// DB-touching persistence for source_coverage — split from
// lib/source-coverage.ts (pure) for the same next-auth-resolution reason
// as every other *-service.ts file in this codebase.
//
// The substantive payload is append-only — there is deliberately no
// EDIT function for it. The one narrow exception is revokeSourceCoverage
// below, which touches ONLY status/revoked_at/revoked_by (see
// lib/source-coverage.ts's own comment on why that's a lifecycle, not a
// correction-in-place). The migration's own trigger
// (source_coverage_immutable_payload — supabase/migrations/
// 20260831000001_billable_unit_candidate_finality.sql) is the real
// barrier for the payload; this file's own shape (one function per write
// path) is the second layer.
import { supabaseServer } from './supabase'
import type { SourceCoverage } from './source-coverage'

const TABLE = 'source_coverage'

function rowToCoverage(row: Record<string, unknown>): SourceCoverage {
  return {
    id: row.id as string,
    job_id: row.job_id as string,
    org_id: row.org_id as string,
    source_binding_id: row.source_binding_id as string,
    coverage_kind: row.coverage_kind as SourceCoverage['coverage_kind'],
    covered_from: row.covered_from as string,
    covered_through: row.covered_through as string,
    established_at: row.established_at as string,
    completeness_basis: row.completeness_basis as SourceCoverage['completeness_basis'],
    established_by: row.established_by as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    status: row.status as SourceCoverage['status'],
    revoked_at: (row.revoked_at as string | null) ?? null,
    revoked_by: (row.revoked_by as string | null) ?? null,
    created_at: row.created_at as string | undefined,
  }
}

export async function recordSourceCoverage(input: {
  job_id: string
  org_id: string
  source_binding_id: string
  coverage_kind: SourceCoverage['coverage_kind']
  covered_from: string
  covered_through: string
  established_at: string
  completeness_basis: SourceCoverage['completeness_basis']
  established_by: string
  metadata?: Record<string, unknown>
}): Promise<SourceCoverage> {
  if (!input.established_by.trim()) {
    throw new Error('recordSourceCoverage: established_by is required — a coverage assertion must never be anonymous')
  }
  const { data, error } = await supabaseServer.from(TABLE).insert({
    job_id: input.job_id, org_id: input.org_id, source_binding_id: input.source_binding_id,
    coverage_kind: input.coverage_kind, covered_from: input.covered_from, covered_through: input.covered_through,
    established_at: input.established_at, completeness_basis: input.completeness_basis,
    established_by: input.established_by, metadata: input.metadata ?? {},
  }).select().single()
  if (error || !data) throw new Error(`recordSourceCoverage failed: ${error?.message}`)
  return rowToCoverage(data)
}

export async function listSourceCoverageForJob(jobId: string): Promise<SourceCoverage[]> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('job_id', jobId)
  if (error) throw new Error(`listSourceCoverageForJob failed: ${error.message}`)
  return (data ?? []).map(rowToCoverage)
}

export async function listSourceCoverageForBinding(sourceBindingId: string): Promise<SourceCoverage[]> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('source_binding_id', sourceBindingId)
  if (error) throw new Error(`listSourceCoverageForBinding failed: ${error.message}`)
  return (data ?? []).map(rowToCoverage)
}

// The ONE correction path for a mistaken coverage assertion: revoke the
// old row (this function), then record a NEW, corrected one
// (recordSourceCoverage) — never edit the old interval in place. Routed
// through revoke_source_coverage (supabase/migrations/
// 20260831000001_billable_unit_candidate_finality.sql), atomic and
// re-checking status = 'active' in its own WHERE clause, so a concurrent
// double-revoke cannot clobber the first revocation's revoked_at/
// revoked_by — same idiom as revokeCandidateEvidence (lib/billable-unit-
// candidate-service.ts). revokedAt is caller-supplied, not server "now()"
// — a correction is routinely applied to a historical assertion with a
// real, specific revocation timestamp.
export async function revokeSourceCoverage(
  coverageId: string, revokedAt: string, revokedBy: string,
): Promise<SourceCoverage> {
  if (!revokedBy.trim()) {
    throw new Error('revokeSourceCoverage: revoked_by is required — a revocation must never be anonymous')
  }
  const { data, error } = await supabaseServer.rpc('revoke_source_coverage', {
    p_coverage_id: coverageId, p_revoked_at: revokedAt, p_revoked_by: revokedBy,
  })
  if (error) throw new Error(`revokeSourceCoverage failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error(`revokeSourceCoverage: coverage ${coverageId} was not revoked — it may already be revoked, or may not exist`)
  return rowToCoverage(row)
}
