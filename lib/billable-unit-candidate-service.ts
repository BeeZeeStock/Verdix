// DB-touching persistence for billable_unit_candidates/
// candidate_unit_evidence — split from lib/billable-unit-candidate.ts
// (pure) for the same next-auth-resolution reason as every other
// *-service.ts file in this codebase.
import { supabaseServer } from './supabase'
import {
  validateEvidenceFacts, pinQualificationRuleVersion,
  type BillableUnitCandidate, type CandidateUnitEvidence,
} from './billable-unit-candidate'
import { listQualificationRulesForJob, getQualificationRule } from './billable-unit-qualification-service'
import { getSourceBinding, listSourceBindingsForRole } from './source-bindings-service'
import { listSourceRolesForJob } from './source-roles-service'

const CANDIDATE_TABLE = 'billable_unit_candidates'
const EVIDENCE_TABLE = 'candidate_unit_evidence'

function rowToCandidate(row: Record<string, unknown>): BillableUnitCandidate {
  return {
    id: row.id as string,
    job_id: row.job_id as string,
    org_id: row.org_id as string,
    unit_type: row.unit_type as string,
    external_identity: {
      source_binding_id: row.source_binding_id as string,
      external_id: row.external_id as string,
    },
    booked_at: (row.booked_at as string | null) ?? null,
    occurred_at: (row.occurred_at as string | null) ?? null,
    attribution_at: row.attribution_at as string,
    qualification_rule_id: row.qualification_rule_id as string,
    qualification_rule_version: row.qualification_rule_version as number,
    rejection_deadline: null,
    status: 'pending',
    decided_at: null,
    created_at: row.created_at as string | undefined,
  }
}

function rowToEvidence(row: Record<string, unknown>): CandidateUnitEvidence {
  return {
    id: row.id as string,
    candidate_id: row.candidate_id as string,
    job_id: row.job_id as string,
    org_id: row.org_id as string,
    source_binding_id: row.source_binding_id as string,
    facts: row.facts as Record<string, unknown>,
    occurred_at: row.occurred_at as string,
    recorded_at: row.recorded_at as string,
    recorded_by: row.recorded_by as string,
    status: row.status as CandidateUnitEvidence['status'],
    revoked_at: (row.revoked_at as string | null) ?? null,
    revoked_by: (row.revoked_by as string | null) ?? null,
    created_at: row.created_at as string | undefined,
  }
}

export async function getCandidate(id: string): Promise<BillableUnitCandidate | null> {
  const { data, error } = await supabaseServer.from(CANDIDATE_TABLE).select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getCandidate failed: ${error.message}`)
  return data ? rowToCandidate(data) : null
}

export async function getCandidateByExternalIdentity(
  jobId: string, sourceBindingId: string, externalId: string,
): Promise<BillableUnitCandidate | null> {
  const { data, error } = await supabaseServer.from(CANDIDATE_TABLE).select('*')
    .eq('job_id', jobId).eq('source_binding_id', sourceBindingId).eq('external_id', externalId)
    .maybeSingle()
  if (error) throw new Error(`getCandidateByExternalIdentity failed: ${error.message}`)
  return data ? rowToCandidate(data) : null
}

export async function listCandidatesForJob(jobId: string, unitType?: string): Promise<BillableUnitCandidate[]> {
  let query = supabaseServer.from(CANDIDATE_TABLE).select('*').eq('job_id', jobId)
  if (unitType) query = query.eq('unit_type', unitType)
  const { data, error } = await query
  if (error) throw new Error(`listCandidatesForJob failed: ${error.message}`)
  return (data ?? []).map(rowToCandidate)
}

// Idempotent — repeated pulls of the same real-world event (same
// job_id/source_binding_id/external_id) resolve to the SAME row, never a
// duplicate. Reads first to avoid the common case paying for a
// constraint-violation round trip; the unique index
// (billable_unit_candidates_identity_uidx) is the real guarantee, so a
// concurrent creator losing the insert race is handled by re-reading
// rather than treated as failure.
//
// Pins qualification_rule_id/qualification_rule_version PERMANENTLY at
// creation via pinQualificationRuleVersion (lib/billable-unit-candidate.ts)
// — never "whichever rule is active right now." A later amendment can
// never change an already-created candidate's pinned rule version; see
// that function's own comment for why the self-consistency check exists.
export async function createOrGetCandidate(input: {
  job_id: string
  org_id: string
  unit_type: string
  source_binding_id: string
  external_id: string
  booked_at: string | null
  occurred_at: string | null
}): Promise<BillableUnitCandidate> {
  const existing = await getCandidateByExternalIdentity(input.job_id, input.source_binding_id, input.external_id)
  if (existing) return existing

  const ruleVersions = await listQualificationRulesForJob(input.job_id, input.unit_type)
  const pin = pinQualificationRuleVersion({ booked_at: input.booked_at, occurred_at: input.occurred_at }, ruleVersions)
  if (pin.status !== 'pinned') {
    throw new Error(`createOrGetCandidate: cannot pin a qualification rule version for job ${input.job_id}/unit_type '${input.unit_type}' — ${pin.reason}`)
  }

  const { data, error } = await supabaseServer.from(CANDIDATE_TABLE).insert({
    job_id: input.job_id, org_id: input.org_id, unit_type: input.unit_type,
    source_binding_id: input.source_binding_id, external_id: input.external_id,
    booked_at: input.booked_at, occurred_at: input.occurred_at, attribution_at: pin.attribution_at,
    qualification_rule_id: pin.ruleId, qualification_rule_version: pin.ruleVersion,
  }).select().single()

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const winner = await getCandidateByExternalIdentity(input.job_id, input.source_binding_id, input.external_id)
      if (winner) return winner
    }
    throw new Error(`createOrGetCandidate failed: ${error.message}`)
  }
  if (!data) throw new Error('createOrGetCandidate: no row returned')
  return rowToCandidate(data)
}

export async function listEvidenceForCandidate(candidateId: string): Promise<CandidateUnitEvidence[]> {
  const { data, error } = await supabaseServer.from(EVIDENCE_TABLE).select('*').eq('candidate_id', candidateId)
  if (error) throw new Error(`listEvidenceForCandidate failed: ${error.message}`)
  return (data ?? []).map(rowToEvidence)
}

// Validates facts against the candidate's PINNED rule's fact_schema
// (never "whatever rule is active now") and rejects cross-job/org
// mismatches between the candidate, the source binding, and the caller's
// own job_id/org_id before ever touching the database. Append-only — this
// is the only INSERT path for candidate_unit_evidence; correcting a fact
// means calling this again with a new value and separately revoking the
// old row (revokeCandidateEvidence), never editing `facts` in place (the
// table has no UPDATE path for that column at all).
export async function recordCandidateEvidence(input: {
  candidate_id: string
  job_id: string
  org_id: string
  source_binding_id: string
  facts: Record<string, unknown>
  occurred_at: string
  recorded_at: string
  recorded_by: string
}): Promise<CandidateUnitEvidence> {
  const candidate = await getCandidate(input.candidate_id)
  if (!candidate) throw new Error(`recordCandidateEvidence: candidate ${input.candidate_id} not found`)
  if (candidate.job_id !== input.job_id || candidate.org_id !== input.org_id) {
    throw new Error(`recordCandidateEvidence: candidate ${input.candidate_id} belongs to job ${candidate.job_id}/org ${candidate.org_id}, not ${input.job_id}/${input.org_id} — evidence must never be attached across job/org boundaries`)
  }

  const binding = await getSourceBinding(input.source_binding_id)
  if (!binding) throw new Error(`recordCandidateEvidence: source_binding ${input.source_binding_id} not found`)
  if (binding.job_id !== input.job_id || binding.org_id !== input.org_id) {
    throw new Error(`recordCandidateEvidence: source_binding ${input.source_binding_id} belongs to job ${binding.job_id}/org ${binding.org_id}, not ${input.job_id}/${input.org_id}`)
  }

  const rule = await getQualificationRule(candidate.qualification_rule_id)
  if (!rule) throw new Error(`recordCandidateEvidence: pinned rule ${candidate.qualification_rule_id} not found`)
  const errors = validateEvidenceFacts(input.facts, rule.fact_schema)
  if (errors.length > 0) {
    throw new Error(`recordCandidateEvidence: invalid facts — ${errors.map(e => `${e.path}: ${e.reason}`).join('; ')}`)
  }

  const { data, error } = await supabaseServer.from(EVIDENCE_TABLE).insert({
    candidate_id: input.candidate_id, job_id: input.job_id, org_id: input.org_id, source_binding_id: input.source_binding_id,
    facts: input.facts, occurred_at: input.occurred_at, recorded_at: input.recorded_at, recorded_by: input.recorded_by,
  }).select().single()
  if (error || !data) throw new Error(`recordCandidateEvidence failed: ${error?.message}`)
  return rowToEvidence(data)
}

// The one UPDATE path for candidate_unit_evidence, via
// revoke_candidate_evidence (supabase/migrations/
// 20260830000008_billable_unit_candidates_evidence.sql) — atomic,
// re-checks status = 'active' in the WHERE clause so a concurrent
// double-revoke cannot clobber the first revocation's revoked_at/
// revoked_by. revokedAt is caller-supplied, not server "now()" — evidence
// in this model is routinely backfilled/pulled with real historical
// timestamps, and tests need to construct exact historical revocation
// scenarios (see the OS-2026-09 fixture's evidence-revocation case).
export async function revokeCandidateEvidence(
  evidenceId: string, revokedAt: string, revokedBy: string,
): Promise<CandidateUnitEvidence> {
  const { data, error } = await supabaseServer.rpc('revoke_candidate_evidence', {
    p_evidence_id: evidenceId, p_revoked_at: revokedAt, p_revoked_by: revokedBy,
  })
  if (error) throw new Error(`revokeCandidateEvidence failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error(`revokeCandidateEvidence: evidence ${evidenceId} was not revoked — it may already be revoked, or may not exist`)
  return rowToEvidence(row)
}

// Convenience for callers assembling resolveCandidateFact's
// sourceBindingRoleKeys map — walks every source_role registered for a
// job and every binding ever created for each role. Not a hot path in
// 16B.2 (no scheduler/production usage yet), so a straightforward N+1 is
// an acceptable, honest cost here rather than a premature optimization.
export async function buildSourceBindingRoleKeyMap(jobId: string): Promise<Map<string, string>> {
  const roles = await listSourceRolesForJob(jobId)
  const map = new Map<string, string>()
  for (const role of roles) {
    const bindings = await listSourceBindingsForRole(role.id)
    for (const binding of bindings) map.set(binding.id, role.role_key)
  }
  return map
}
