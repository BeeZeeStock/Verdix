// DB-touching persistence for source_bindings — split from
// lib/source-bindings.ts (pure) for the same next-auth-resolution reason as
// every other *-service.ts file in this codebase.
import { supabaseServer } from './supabase'
import { resolveSourceBindingFromCandidates, type SourceBinding, type ResolveSourceBindingResult } from './source-bindings'
import { ensureReviewerAttestationRole } from './source-roles-service'

const TABLE = 'source_bindings'

function rowToBinding(row: Record<string, unknown>): SourceBinding {
  return {
    id: row.id as string,
    source_role_id: row.source_role_id as string,
    job_id: row.job_id as string,
    org_id: row.org_id as string,
    label: row.label as string,
    effective_from: row.effective_from as string,
    effective_to: (row.effective_to as string | null) ?? null,
    supersedes_binding_id: (row.supersedes_binding_id as string | null) ?? null,
    status: row.status as SourceBinding['status'],
    created_at: row.created_at as string | undefined,
  }
}

// The one write path for this table — either creates the FIRST binding for
// a role, or atomically supersedes its current active binding, per
// create_source_binding (supabase/migrations/
// 20260830000008_billable_unit_candidates_evidence.sql). Never two
// separate application-level writes: a caller can never observe a role
// with zero active bindings mid-transition.
export async function createSourceBinding(
  sourceRoleId: string, jobId: string, orgId: string, label: string, effectiveFrom: string,
): Promise<SourceBinding> {
  const { data, error } = await supabaseServer.rpc('create_source_binding', {
    p_source_role_id: sourceRoleId, p_job_id: jobId, p_org_id: orgId, p_label: label, p_effective_from: effectiveFrom,
  })
  if (error) throw new Error(`createSourceBinding failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error(`createSourceBinding: no row returned for source_role ${sourceRoleId}`)
  return rowToBinding(row)
}

export async function listSourceBindingsForRole(sourceRoleId: string): Promise<SourceBinding[]> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('source_role_id', sourceRoleId)
  if (error) throw new Error(`listSourceBindingsForRole failed: ${error.message}`)
  return (data ?? []).map(rowToBinding)
}

export async function getSourceBinding(id: string): Promise<SourceBinding | null> {
  const { data, error } = await supabaseServer.from(TABLE).select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getSourceBinding failed: ${error.message}`)
  return data ? rowToBinding(data) : null
}

// Fetches the role's full binding history (active + superseded — never
// just the active one, see lib/source-bindings.ts's own comment on why)
// and applies the pure resolver. Throws on anything but a clean single
// match — callers that need to branch on the failure mode should use
// resolveSourceBindingDetailed instead.
export async function resolveSourceBinding(
  sourceRole: { id: string; job_id: string; org_id: string }, referenceTime: string,
): Promise<SourceBinding> {
  const result = await resolveSourceBindingDetailed(sourceRole, referenceTime)
  if (result.status !== 'resolved') throw new Error(`resolveSourceBinding: ${result.reason}`)
  return result.binding
}

export async function resolveSourceBindingDetailed(
  sourceRole: { id: string; job_id: string; org_id: string }, referenceTime: string,
): Promise<ResolveSourceBindingResult> {
  const candidates = await listSourceBindingsForRole(sourceRole.id)
  return resolveSourceBindingFromCandidates(sourceRole, referenceTime, candidates)
}

// Closes the reviewer-attestation SourceBinding loop (16B.2 hardening).
// 16B.1's reviewer_attestation SourceRole is a structural capability of
// the product itself — every job should have it registered so
// reviewer-attested evidence always has a real source identity, never an
// implicit null-source exception. But 16B.2's CandidateUnitEvidence
// requires a real source_binding_id, and a SourceRole alone isn't a
// binding — without this function, every caller wanting to record
// reviewer evidence would have to manually fabricate a generic binding
// for the reserved role, which is exactly the kind of ad hoc, easy-to-
// get-wrong step this codebase avoids elsewhere (see
// ensureReviewerAttestationRole's own idempotent pattern, which this
// mirrors one layer up). Idempotent: returns the existing active binding
// if one already exists for the job's reviewer_attestation role, never
// creates a second one. effectiveFrom is caller-supplied, not server
// "now()" — same no-ambient-clock discipline as every other timestamp in
// this DB service layer; callers needing "today" pass it explicitly.
// Concurrency: two overlapping calls for the same job can both observe
// zero active bindings for the role and both call createSourceBinding.
// Real-Postgres discovery (this turn) — the loser can surface EITHER of
// two different errors depending on exact timing, not just one:
//   1. Both callers' `for update` SELECTs see no existing row before
//      either INSERT commits -> both INSERT -> source_bindings_one_
//      active_per_role_idx lets one win, the other gets a raw 23505
//      duplicate-key violation.
//   2. Caller A's SELECT+INSERT commits first; caller B's `for update`
//      SELECT then genuinely FINDS A's now-committed row (there was
//      nothing to block B's SELECT on, since A had no predecessor row to
//      lock) and hits create_source_binding's own business-rule check
//      instead ("effective_from must be strictly after the current
//      active binding's effective_from") — a clean exception, not a raw
//      constraint violation, but it means exactly the same thing here:
//      "I lost the race."
// Both are the identical idempotency race from this caller's point of
// view; re-read and return the winner in either case rather than letting
// either propagate as an unnecessary error — same idiom as
// createOrGetCandidate/createSuccessorDraft/ensureReviewerAttestationRole.
export async function ensureReviewerAttestationBinding(
  jobId: string, orgId: string, effectiveFrom: string,
): Promise<SourceBinding> {
  const role = await ensureReviewerAttestationRole(jobId, orgId)
  const existing = await listSourceBindingsForRole(role.id)
  const active = existing.find(b => b.status === 'active')
  if (active) return active
  try {
    return await createSourceBinding(role.id, jobId, orgId, 'Reviewer attestation', effectiveFrom)
  } catch (err) {
    if (err instanceof Error && /duplicate key value|must be strictly after/.test(err.message)) {
      const winner = (await listSourceBindingsForRole(role.id)).find(b => b.status === 'active')
      // Explicit verification, not implicit trust — before this error is
      // ever treated as "I merely lost the race," the reread row must
      // genuinely be an active binding for THIS exact role/job/org.
      // listSourceBindingsForRole(role.id) already filters by role, and
      // the composite FK chain (source_bindings_role_ownership_fk)
      // already guarantees job_id/org_id match the role's own — but this
      // function must not silently convert a genuine lifecycle/
      // effective-date error into success by relying solely on those
      // structural guarantees holding; it re-asserts them directly, so
      // the safety property is visible here, not just inferred from
      // elsewhere. Anything that fails this check falls through to the
      // ORIGINAL error, unmodified — never a new/rewritten one.
      if (winner && winner.source_role_id === role.id && winner.job_id === jobId && winner.org_id === orgId) {
        return winner
      }
    }
    throw err
  }
}
