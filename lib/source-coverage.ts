// SourceCoverage — Step 16B.3's historical completeness primitive.
//
// Generic and reusable ANYWHERE a terminal decision needs to prove "we
// watched the right window of a source completely," not just "we
// currently see nothing" — candidate-discovery completeness (dedupe) and
// rejection-source completeness in THIS slice, but structurally identical
// to what a future delivery-acceptance, claim-finality, or dispute-window
// primitive would need. Nothing here is SQM/meeting-specific.
//
// SourceBinding-scoped, not SourceRole-scoped — completeness is a
// property of a concrete pulled instance, exactly like CandidateUnitEvidence
// itself (lib/billable-unit-candidate.ts) is source_binding-scoped, never
// source_role-scoped.
//
// established_at is the mandatory discovery-time safety rail every asOf
// replay in this schema already depends on (see CandidateUnitEvidence's
// own recorded_at/revoked_at discipline): a coverage assertion may only be
// CONSULTED by an evaluation running at some asOf when
// established_at <= asOf — otherwise a coverage row created/extended
// AFTER the historical asOf being replayed could leak future completeness
// knowledge into that replay. This is exactly the note
// lib/billable-unit-qualification.ts's 16B.1 design section left for
// 16B.3 to implement.
// Step 16B.3 hardening — 'fact_evidence' is deliberately the SAME closed,
// generic vocabulary as the other two kinds (not a new subsystem): it
// proves a source was watched completely enough to make a FACT'S
// resolution stable, exactly as 'candidate_discovery'/'rejection_source'
// already prove completeness for dedupe/rejection. Reusable for any
// future domain (delivery acceptance, claims, partner entitlement,
// revenue-share earning conditions) exactly like the other two kinds.
export type SourceCoverageKind = 'candidate_discovery' | 'rejection_source' | 'fact_evidence'

// Bounded, closed vocabulary for THIS slice — "no generic connector
// framework" per the 16B.3 brief. A basis describes HOW completeness was
// established, for audit purposes; it plays no role in the completeness
// arithmetic itself (that is purely covered_from/covered_through/
// established_at), so widening this set later is additive, not a redesign.
export type SourceCoverageCompletenessBasis = 'connector_high_watermark' | 'bounded_lag_policy' | 'reviewer_attestation'

export interface SourceCoverage {
  id: string
  job_id: string
  org_id: string
  source_binding_id: string
  coverage_kind: SourceCoverageKind
  covered_from: string      // ISO timestamp, inclusive
  covered_through: string   // ISO timestamp, EXCLUSIVE — same convention as SourceBinding.effective_to
  established_at: string
  completeness_basis: SourceCoverageCompletenessBasis
  // Step 16B.3 hardening — coverage can now enable an IRREVERSIBLE terminal
  // decision (fact-evidence finality), so every row must carry real audit
  // identity: who/what established it. Never optional/anonymous — a
  // 'reviewer_attestation'-basis row asserted by nobody in particular is
  // exactly the gap this closes. Free-form but mandatory, non-empty
  // (e.g. 'connector:crm-sync-job-42', 'reviewer:alice@example.com') —
  // deliberately not a foreign key to a users table (this schema has no
  // single canonical identity table every basis could reference; a
  // connector job has no user row at all) — smallest generic field that
  // answers the audit question without a new subsystem.
  established_by: string
  // Structured reference/evidence detail specific to HOW established_by's
  // claim was formed (e.g. { watermark: '...' } for a connector, or
  // { reviewed_evidence_id: '...' } for a reviewer attestation) — already
  // existed as a general-purpose bag; reused here rather than adding a
  // second metadata field.
  metadata: Record<string, unknown>
  // Final hardening pass — a narrow, evidence-like correction lifecycle.
  // The SUBSTANTIVE payload above (source_binding_id, coverage_kind,
  // covered_from/through, completeness_basis, established_at,
  // established_by, metadata) stays permanently immutable once inserted —
  // a mistaken assertion is never edited in place, only revoked and
  // replaced by a NEW row (append + revoke, exactly
  // CandidateUnitEvidence's own discipline — see lib/billable-unit-
  // candidate.ts). status/revoked_at/revoked_by are the only fields this
  // lifecycle ever touches.
  status: 'active' | 'revoked'
  revoked_at: string | null
  revoked_by: string | null
  created_at?: string
}

// Historical semantics — established_at <= asOf AND (revoked_at IS NULL OR
// revoked_at > asOf) — mirrors CandidateUnitEvidence's own
// isEvidenceActiveAsOf EXACTLY (see lib/billable-unit-candidate.ts): a
// coverage row revoked on 10 Sep is still correctly visible when replaying
// asOf 5 Sep, so a later-discovered correction can never retroactively
// rewrite an already-decided historical evaluation. This is the ONE
// predicate every completeness check in this module filters through.
export function isCoverageUsableAsOf(coverage: SourceCoverage, asOf: string): boolean {
  const establishedMs = new Date(coverage.established_at).getTime()
  const asOfMs = new Date(asOf).getTime()
  if (establishedMs > asOfMs) return false
  if (coverage.revoked_at === null) return true
  return new Date(coverage.revoked_at).getTime() > asOfMs
}

export interface CoverageGap { from: string; through: string }

export interface IntervalCoverageResult {
  status: 'complete' | 'incomplete'
  reason: string
  gaps: CoverageGap[]
  consideredCoverageIds: string[]
}

// Evaluates whether the UNION of coverage across the given set of
// source_binding_ids fully spans [requiredFrom, requiredThrough) with no
// gaps, using only coverage rows usable as of `asOf`. Multiple bindings
// are accepted here (not just one) because ONE logical source's identity
// can legitimately change mid-window on a genuine re-platform (see
// lib/source-bindings.ts's own external-ID-namespace note) — a later
// binding's coverage picking up exactly where an earlier binding's
// coverage for the SAME role_key left off is a real, valid way to prove
// that ONE logical source was watched completely across the whole window,
// even though the two coverage rows reference different source_binding_ids.
export function evaluateUnionIntervalCoverage(params: {
  sourceBindingIds: string[]
  coverageKind: SourceCoverageKind
  requiredFrom: string
  requiredThrough: string
  coverage: SourceCoverage[]
  asOf: string
}): IntervalCoverageResult {
  const { sourceBindingIds, coverageKind, requiredFrom, requiredThrough, coverage, asOf } = params
  const requiredFromMs = new Date(requiredFrom).getTime()
  const requiredThroughMs = new Date(requiredThrough).getTime()
  const bindingIdSet = new Set(sourceBindingIds)

  const relevant = coverage
    .filter(c => bindingIdSet.has(c.source_binding_id) && c.coverage_kind === coverageKind && isCoverageUsableAsOf(c, asOf))
    .filter(c => new Date(c.covered_through).getTime() > requiredFromMs && new Date(c.covered_from).getTime() < requiredThroughMs)
    .sort((a, b) => new Date(a.covered_from).getTime() - new Date(b.covered_from).getTime())

  if (sourceBindingIds.length === 0) {
    return { status: 'incomplete', reason: 'no source_binding was resolved to check coverage against', gaps: [{ from: requiredFrom, through: requiredThrough }], consideredCoverageIds: [] }
  }
  if (relevant.length === 0) {
    return { status: 'incomplete', reason: `no usable coverage of kind '${coverageKind}' overlaps the required interval for any of [${sourceBindingIds.join(', ')}]`, gaps: [{ from: requiredFrom, through: requiredThrough }], consideredCoverageIds: [] }
  }

  const gaps: CoverageGap[] = []
  const consideredIds: string[] = []
  let cursorMs = requiredFromMs
  for (const c of relevant) {
    consideredIds.push(c.id)
    const fromMs = new Date(c.covered_from).getTime()
    const throughMs = new Date(c.covered_through).getTime()
    if (fromMs > cursorMs) gaps.push({ from: new Date(cursorMs).toISOString(), through: c.covered_from })
    if (throughMs > cursorMs) cursorMs = throughMs
    if (cursorMs >= requiredThroughMs) break
  }
  if (cursorMs < requiredThroughMs) gaps.push({ from: new Date(cursorMs).toISOString(), through: requiredThrough })

  if (gaps.length > 0) {
    return { status: 'incomplete', reason: `coverage of kind '${coverageKind}' has ${gaps.length} gap(s) within the required interval`, gaps, consideredCoverageIds: consideredIds }
  }
  return { status: 'complete', reason: `coverage of kind '${coverageKind}' fully spans [${requiredFrom}, ${requiredThrough})`, gaps: [], consideredCoverageIds: consideredIds }
}

// Evaluates whether EVERY required "logical source" (e.g. every rejection
// channel, or every dedupe discovery role) is independently, completely
// covered. Union WITHIN one logical source's own binding history is
// allowed (see evaluateUnionIntervalCoverage above) — union ACROSS
// different required logical sources is never sufficient: a complete CRM
// feed does not prove a portal channel was watched, so each entry in
// `requiredSources` is checked on its own and ALL must be complete.
export function evaluateRequiredSourcesCoverage(params: {
  // requiredFrom may be overridden PER SOURCE (fact-evidence finality
  // needs this — each capable source's own required lower bound is that
  // source's own SourceBinding.effective_from, which genuinely differs
  // across sources; dedupe/rejection completeness never override it, so
  // every source shares the one top-level requiredFrom, unchanged
  // behavior for both existing call sites).
  requiredSources: Array<{ label: string; sourceBindingIds: string[]; requiredFrom?: string }>
  coverageKind: SourceCoverageKind
  requiredFrom: string
  requiredThrough: string
  coverage: SourceCoverage[]
  asOf: string
}): IntervalCoverageResult {
  const { requiredSources, coverageKind, requiredFrom, requiredThrough, coverage, asOf } = params
  if (requiredSources.length === 0) {
    return { status: 'incomplete', reason: 'no required source is configured to check coverage against', gaps: [{ from: requiredFrom, through: requiredThrough }], consideredCoverageIds: [] }
  }
  const perSource = requiredSources.map(s => ({
    label: s.label,
    result: evaluateUnionIntervalCoverage({ sourceBindingIds: s.sourceBindingIds, coverageKind, requiredFrom: s.requiredFrom ?? requiredFrom, requiredThrough, coverage, asOf }),
  }))
  const incomplete = perSource.filter(s => s.result.status === 'incomplete')
  if (incomplete.length > 0) {
    return {
      status: 'incomplete',
      reason: `${incomplete.length}/${perSource.length} required source(s) lack complete '${coverageKind}' coverage: ${incomplete.map(s => s.label).join(', ')}`,
      gaps: incomplete.flatMap(s => s.result.gaps),
      consideredCoverageIds: perSource.flatMap(s => s.result.consideredCoverageIds),
    }
  }
  return {
    status: 'complete',
    reason: `all ${perSource.length} required source(s) have complete '${coverageKind}' coverage`,
    gaps: [],
    consideredCoverageIds: perSource.flatMap(s => s.result.consideredCoverageIds),
  }
}
