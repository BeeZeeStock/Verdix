// DB-touching persistence for Step 16B.3's completeness + terminal
// finality layer — split from lib/billable-unit-candidate-finality.ts
// (pure) for the same next-auth-resolution reason as every other
// *-service.ts file in this codebase.
import { supabaseServer } from './supabase'
import { evaluateCandidateFinalDecision, type CandidateFinalDecision, type CandidateFinalityContext } from './billable-unit-candidate-finality'
import { getCandidate, listEvidenceForCandidate, listCandidatesForJob, rowToCandidate } from './billable-unit-candidate-service'
import { getQualificationRule } from './billable-unit-qualification-service'
import { listSourceRolesForJob } from './source-roles-service'
import { listSourceBindingsForRole } from './source-bindings-service'
import { listSourceCoverageForJob } from './source-coverage-service'
import type { BillableUnitCandidate } from './billable-unit-candidate'
import type { SourceBinding } from './source-bindings'

// Assembles the FULL historical evaluation context for one candidate —
// every prior candidate for the same job/unit_type (dedupe needs the
// whole historical set, not just this one candidate's own evidence), every
// source binding + role-key mapping registered for the job, and every
// coverage row recorded for the job. Not a hot path (no scheduler/
// production usage yet in this slice — see buildSourceBindingRoleKeyMap's
// own comment on the same tradeoff), so a straightforward set of list
// calls is an acceptable, honest cost here.
async function assembleFinalityContext(candidate: BillableUnitCandidate, asOf: string): Promise<CandidateFinalityContext> {
  const rule = await getQualificationRule(candidate.qualification_rule_id)
  if (!rule) throw new Error(`assembleFinalityContext: pinned rule ${candidate.qualification_rule_id} not found`)

  const evidence = await listEvidenceForCandidate(candidate.id)

  const allJobCandidates = await listCandidatesForJob(candidate.job_id, candidate.unit_type)
  const priorCandidates = await Promise.all(
    allJobCandidates
      .filter(c => c.id !== candidate.id)
      .map(async c => ({ candidate: c, evidence: await listEvidenceForCandidate(c.id) })),
  )

  const roles = await listSourceRolesForJob(candidate.job_id)
  const sourceBindingRoleKeys = new Map<string, string>()
  const sourceBindings: SourceBinding[] = []
  for (const role of roles) {
    const bindings = await listSourceBindingsForRole(role.id)
    for (const b of bindings) {
      sourceBindingRoleKeys.set(b.id, role.role_key)
      sourceBindings.push(b)
    }
  }

  const coverage = await listSourceCoverageForJob(candidate.job_id)

  return { candidate, rule, evidence, priorCandidates, sourceBindingRoleKeys, sourceBindings, coverage, asOf }
}

// Evaluates lib/billable-unit-candidate-finality.ts's pure decision
// function against a candidate's full current context and, ONLY if it
// reaches a terminal outcome, commits it via the one atomic RPC
// (finalize_billable_unit_candidate — supabase/migrations/
// 20260827000009_billable_unit_candidate_finality.sql). asOf defaults to
// "now" ONLY at this I/O boundary — every pure function underneath takes
// it explicitly, per this codebase's no-ambient-clock discipline.
//
// Item J (already-terminal candidates never change): a candidate that is
// already qualified/rejected is returned AS-IS, with NO re-evaluation and
// NO RPC call — not merely because the migration's own terminal-
// immutability trigger would reject any attempted rewrite regardless, but
// because re-running the evaluator against TODAY's evidence/coverage could
// produce a `decision` that disagrees with the permanently-recorded
// status (e.g. contradictory evidence discovered afterward) — returning
// that here would be actively misleading about what is actually
// persisted, not merely wasteful. `decision: null` signals "not evaluated
// this call," and must never be confused with a real 'pending' outcome.
export async function evaluateAndFinalizeCandidate(
  candidateId: string, asOf: string = new Date().toISOString(),
): Promise<{ candidate: BillableUnitCandidate; decision: CandidateFinalDecision | null }> {
  const candidate = await getCandidate(candidateId)
  if (!candidate) throw new Error(`evaluateAndFinalizeCandidate: candidate ${candidateId} not found`)

  if (candidate.status !== 'pending') {
    return { candidate, decision: null }
  }

  const ctx = await assembleFinalityContext(candidate, asOf)
  const decision = evaluateCandidateFinalDecision(ctx)

  if (decision.outcome === 'pending') {
    return { candidate, decision }
  }

  // Materiality-aware terminalization hardening (final pass) — persist
  // EXACTLY what the evaluator actually depended on, never a value
  // independently resolved just to fill the column. A fast criteria/
  // dedupe rejection legitimately has no deadline (decision.rejection is
  // the UNCOMPUTED_REJECTION placeholder, deadline.status 'unresolved') —
  // that is recorded as a genuine NULL, which now truthfully means "this
  // terminal decision did not require that contractual deadline," not
  // "we don't know it." The DB no longer requires a deadline on every
  // terminal row (billable_unit_candidates_pending_rejection_deadline_null
  // only constrains PENDING rows to have none — see the migration).
  const deadline = decision.rejection.deadline.status === 'resolved' ? decision.rejection.deadline.deadline : null

  // Defensive invariant, not a silent fallback: the evaluator's own
  // materialDependencies is authoritative about whether the deadline was
  // material to THIS decision. If it claims so ('rejection_deadline'
  // present) yet none was actually resolved, that is a genuine bug in the
  // evaluator, not a normal "unresolved deadline" case — surfaced loudly
  // rather than silently persisting a contradictory row.
  if (deadline === null && decision.materialDependencies.includes('rejection_deadline')) {
    throw new Error(`evaluateAndFinalizeCandidate: invariant violated — candidate ${candidateId} reached '${decision.outcome}' with rejection_deadline listed as material but no deadline was actually resolved`)
  }

  const { data, error } = await supabaseServer.rpc('finalize_billable_unit_candidate', {
    p_candidate_id: candidateId, p_status: decision.outcome, p_decided_at: asOf, p_rejection_deadline: deadline,
  })
  if (error) throw new Error(`evaluateAndFinalizeCandidate failed: ${error.message}`)
  const rows = Array.isArray(data) ? data : (data ? [data] : [])
  if (rows.length === 0) {
    // Lost a concurrent finalization race (or the candidate was already
    // finalized between the read above and this RPC call) — re-read and
    // return the winner's REAL persisted state rather than the
    // now-possibly-stale in-memory decision.
    const winner = await getCandidate(candidateId)
    if (!winner) throw new Error(`evaluateAndFinalizeCandidate: candidate ${candidateId} disappeared`)
    return { candidate: winner, decision }
  }
  return { candidate: rowToCandidate(rows[0]), decision }
}
