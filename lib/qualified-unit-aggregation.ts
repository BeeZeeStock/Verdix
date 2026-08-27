// Step 16B.4 — connects terminal qualified candidates (16B.3) to the
// existing commercial calculation path (lib/tariff.ts, UNCHANGED by this
// file). Pure evaluator layer, same split as every other 16B module: this
// file never touches the database, never calls Date.now(), and never
// computes a price. It answers exactly two questions —
//   1. is a billing period's qualified-unit quantity KNOWN yet
//      (evaluatePeriodReadiness), and
//   2. if so, what is it (aggregateQualifiedUnits) —
// and stops there. lib/commercial-quantity-source.ts is what lets the
// existing pricing engine consume the answer without caring where it came
// from.
//
// Naming discipline (unchanged from 16B.3's own brief): nothing in this
// file is named after "SQM," "meeting," or any other single agreement's
// vocabulary — a qualified unit is a generic, contractually-defined
// economic event. Domain specifics live only in rule configuration (lib/
// os-2026-09-fixture.ts) and in the caller-supplied unit_type string.
import type { BillableUnitQualificationRule } from './billable-unit-qualification'
import type { BillableUnitCandidate } from './billable-unit-candidate'
import {
  evaluateRequiredSourcesCoverage,
  type SourceCoverage, type SourceCoverageKind, type IntervalCoverageResult,
} from './source-coverage'
import { doesSourceBindingOverlapInterval, type SourceBinding } from './source-bindings'

// ── Historical candidate visibility — hardening item 1 ───────────────────
//
// A candidate row's CURRENT status/decided_at/created_at describes reality
// as of NOW — but a historical replay at some earlier billingAsOf must only
// ever see what was actually true AT THAT TIME, in TWO independent ways:
//
//   1. Existence — a candidate Verdix hadn't yet discovered/created as of
//      asOf (created_at > asOf) must be genuinely INVISIBLE to that replay,
//      not present-but-pending. A pending candidate actively BLOCKS period
//      readiness (it could still resolve either way); a not-yet-created one
//      must not, or a later-discovered/backfilled candidate would silently
//      re-open and change an already-evaluated historical period the moment
//      its row happens to exist — exactly the "current rows time-travel
//      backward" failure mode this predicate exists to forbid. The ONLY
//      sanctioned way to correct a historical completeness conclusion is
//      the existing SourceCoverage revoke/re-assert lifecycle (16B.3),
//      never a candidate row simply appearing later.
//   2. Decision timing — a candidate that IS qualified/rejected today was,
//      as of any asOf strictly before its own decided_at, still pending —
//      the decision simply hadn't happened yet.
//
// SourceCoverage's own established_at/revoked_at gating (16B.3) is
// necessary but NOT sufficient on its own: it protects against coverage
// rows created after the historical asOf, but says nothing about a
// CANDIDATE's own existence/decision timing, which is exactly what this
// predicate closes. Never mutates the candidate or persists a second
// table — this is a pure replay of already-immutable facts (created_at and
// decided_at never change once set).
export type EffectiveCandidateStatus = 'not_yet_created' | 'pending' | 'qualified' | 'rejected'

export function effectiveCandidateStatusAsOf(candidate: BillableUnitCandidate, asOf: string): EffectiveCandidateStatus {
  const asOfMs = new Date(asOf).getTime()
  // created_at is optional on the type (observability-only historically) —
  // every real DB row has it populated; a fixture that omits it is treated
  // as always-visible (unchanged, pre-existing behavior) rather than
  // failing closed on missing test scaffolding.
  if (candidate.created_at) {
    const createdMs = new Date(candidate.created_at).getTime()
    if (createdMs > asOfMs) return 'not_yet_created'
  }
  if (candidate.status === 'pending') return 'pending'
  if (candidate.decided_at === null) {
    // Same invariant projectQualifiedUnit itself guards — a terminal status
    // with no decided_at is data corruption, never silently tolerated.
    throw new Error(`effectiveCandidateStatusAsOf: candidate ${candidate.id} is '${candidate.status}' but has no decided_at — violates the terminal-decision invariant`)
  }
  const decidedMs = new Date(candidate.decided_at).getTime()
  if (decidedMs > asOfMs) return 'pending'
  return candidate.status
}

// ── Qualified-unit projection — item 1 ──────────────────────────────────
//
// Deliberately NOT persisted (see this module's own header and the
// service-layer file's comment on why) — computed fresh from an already-
// terminal, immutable candidate row every time. quantity is always exactly
// 1: a terminal qualified candidate IS one commercially qualified economic
// unit, never a reviewer-typed or LLM-derived number.
export interface QualifiedUnitProjection {
  candidate_id: string
  job_id: string
  org_id: string
  unit_type: string
  qualification_rule_id: string
  qualification_rule_version: number
  attribution_at: string
  billing_period: { start: string; end: string } // half-open [start, end)
  quantity: 1
  terminal_decided_at: string
}

// A candidate contributes exactly one projection only when its EFFECTIVE
// status as of `asOf` (see effectiveCandidateStatusAsOf above — never the
// raw, current-day row status) is 'qualified' AND its attribution_at falls
// inside [periodStart, periodEnd). Never derives quantity from decided_at/
// created_at/now — see the module header.
export function projectQualifiedUnit(
  candidate: BillableUnitCandidate, periodStart: string, periodEnd: string, asOf: string,
): QualifiedUnitProjection | null {
  if (effectiveCandidateStatusAsOf(candidate, asOf) !== 'qualified') return null
  const attributionMs = new Date(candidate.attribution_at).getTime()
  if (attributionMs < new Date(periodStart).getTime() || attributionMs >= new Date(periodEnd).getTime()) return null
  // decided_at is guaranteed non-null here — effectiveCandidateStatusAsOf
  // already returned 'qualified', which is impossible without it.
  return {
    candidate_id: candidate.id, job_id: candidate.job_id, org_id: candidate.org_id, unit_type: candidate.unit_type,
    qualification_rule_id: candidate.qualification_rule_id, qualification_rule_version: candidate.qualification_rule_version,
    attribution_at: candidate.attribution_at,
    billing_period: { start: periodStart, end: periodEnd },
    quantity: 1,
    terminal_decided_at: candidate.decided_at as string,
  }
}

// ── Rule-effective segmentation — hardening item 4 ───────────────────────
//
// A billing period is NOT required to be governed by one single rule
// version. The rule model already supports effective-dated amendments
// (lib/billable-unit-qualification.ts), and each CANDIDATE is permanently
// pinned to its own rule version at creation time regardless — the only
// genuine problem a mid-period amendment creates is deciding which rule's
// dedupe_rule.discovery_coverage_role_keys governs candidate-discovery
// completeness for which sub-interval. This partitions [periodStart,
// periodEnd) into the smallest set of contiguous segments, each governed
// by EXACTLY one rule version, and fails closed (never "pick the current
// active rule") the moment any sub-interval has zero or more than one
// covering rule version.
export interface RulePeriodSegment {
  start: string
  end: string // half-open, same convention as the period itself
  rule: BillableUnitQualificationRule
}

export type ResolveRuleSegmentsResult =
  | { status: 'resolved'; segments: RulePeriodSegment[] }
  | { status: 'gap'; reason: string; gaps: Array<{ from: string; through: string }> }
  | { status: 'ambiguous'; reason: string; conflicts: Array<{ from: string; through: string; matches: BillableUnitQualificationRule[] }> }

export function resolveRuleSegmentsForPeriod(
  candidateRuleVersions: BillableUnitQualificationRule[], unitType: string, periodStart: string, periodEnd: string,
): ResolveRuleSegmentsResult {
  const periodStartMs = new Date(periodStart).getTime()
  const periodEndMs = new Date(periodEnd).getTime()
  const relevant = candidateRuleVersions.filter(r => r.unit_type === unitType && (r.status === 'active' || r.status === 'superseded'))

  // Every point any rule's own effective_from/effective_to crosses INSIDE
  // the period is a potential segment boundary — walking the sorted union
  // of these (plus the period's own bounds) is the standard sweep-line
  // technique for "partition an interval by a set of overlapping ranges."
  const boundarySet = new Set<number>([periodStartMs, periodEndMs])
  for (const r of relevant) {
    const fromMs = new Date(r.effective_from).getTime()
    const toMs = r.effective_to === null ? Infinity : new Date(r.effective_to).getTime()
    if (fromMs > periodStartMs && fromMs < periodEndMs) boundarySet.add(fromMs)
    if (toMs > periodStartMs && toMs < periodEndMs) boundarySet.add(toMs)
  }
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b)

  const rawSegments: Array<{ startMs: number; endMs: number; rule: BillableUnitQualificationRule }> = []
  const gaps: Array<{ from: string; through: string }> = []
  const conflicts: Array<{ from: string; through: string; matches: BillableUnitQualificationRule[] }> = []

  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStartMs = boundaries[i]
    const segEndMs = boundaries[i + 1]
    if (segStartMs >= segEndMs) continue
    // A rule covers this WHOLE sub-segment iff its own window spans both
    // boundary points — the boundary construction above guarantees no
    // rule's own from/to falls strictly inside a segment, so a partial/
    // straddling match is structurally impossible here.
    const covering = relevant.filter(r => {
      const fromMs = new Date(r.effective_from).getTime()
      const toMs = r.effective_to === null ? Infinity : new Date(r.effective_to).getTime()
      return fromMs <= segStartMs && toMs >= segEndMs
    })
    if (covering.length === 0) {
      gaps.push({ from: new Date(segStartMs).toISOString(), through: new Date(segEndMs).toISOString() })
    } else if (covering.length > 1) {
      conflicts.push({ from: new Date(segStartMs).toISOString(), through: new Date(segEndMs).toISOString(), matches: covering })
    } else {
      rawSegments.push({ startMs: segStartMs, endMs: segEndMs, rule: covering[0] })
    }
  }

  if (conflicts.length > 0) {
    return { status: 'ambiguous', reason: `${conflicts.length} sub-interval(s) of [${periodStart}, ${periodEnd}) are simultaneously covered by more than one rule version for unit_type '${unitType}' — refusing to pick arbitrarily`, conflicts }
  }
  if (gaps.length > 0) {
    return { status: 'gap', reason: `${gaps.length} sub-interval(s) of [${periodStart}, ${periodEnd}) are not covered by any active/superseded rule version for unit_type '${unitType}'`, gaps }
  }

  // Cosmetic merge — adjacent sub-segments governed by the identical rule
  // id collapse into one segment (a boundary introduced by a DIFFERENT
  // rule's own from/to can otherwise slice through one rule's single
  // governing window for no semantic reason).
  const merged: RulePeriodSegment[] = []
  for (const seg of rawSegments) {
    const last = merged[merged.length - 1]
    if (last && last.rule.id === seg.rule.id && new Date(last.end).getTime() === seg.startMs) {
      last.end = new Date(seg.endMs).toISOString()
    } else {
      merged.push({ start: new Date(seg.startMs).toISOString(), end: new Date(seg.endMs).toISOString(), rule: seg.rule })
    }
  }
  return { status: 'resolved', segments: merged }
}

// ── Shared evaluation context ─────────────────────────────────────────────
//
// Same context-bundling pattern as lib/billable-unit-candidate-finality.ts's
// CandidateFinalityContext — candidates/sourceBindings/coverage are
// expected to already be fetched by the caller (service layer); this file
// never performs I/O and never mutates any of them.
export interface QualifiedUnitAggregationContext {
  jobId: string
  orgId: string
  unitType: string
  periodStart: string // ISO timestamp, inclusive
  periodEnd: string   // ISO timestamp, EXCLUSIVE — same half-open convention as SourceCoverage
  asOf: string
  // ALL rule versions (any status/effective window) known for this
  // unit_type — resolveRuleSegmentsForPeriod (above) determines which
  // one(s) actually govern the period, never a single pre-selected rule.
  ruleVersions: BillableUnitQualificationRule[]
  // Every candidate known for this job+unitType, of ANY status/attribution —
  // this function does its own filtering to [periodStart, periodEnd)
  // rather than trusting a caller to have pre-scoped it, same defensive
  // discipline as recordCandidateEvidence's own job/org re-checks.
  candidates: BillableUnitCandidate[]
  sourceBindings: SourceBinding[]
  sourceBindingRoleKeys: Map<string, string>
  coverage: SourceCoverage[]
}

function candidatesAttributedToPeriod(ctx: QualifiedUnitAggregationContext): BillableUnitCandidate[] {
  const startMs = new Date(ctx.periodStart).getTime()
  const endMs = new Date(ctx.periodEnd).getTime()
  return ctx.candidates.filter(c => {
    if (c.unit_type !== ctx.unitType) return false
    const at = new Date(c.attribution_at).getTime()
    return at >= startMs && at < endMs
  })
}

function resolveBindingIdsForRoleKeyOverInterval(
  roleKey: string, sourceBindings: SourceBinding[], sourceBindingRoleKeys: Map<string, string>, from: string, through: string,
): string[] {
  return sourceBindings
    .filter(b => sourceBindingRoleKeys.get(b.id) === roleKey)
    .filter(b => doesSourceBindingOverlapInterval(b, from, through))
    .map(b => b.id)
}

// ── Candidate-discovery completeness at period level — item 4 ───────────
//
// Semantic audit (hardening item 5): dedupe_rule.discovery_coverage_role_
// keys is named, and documented in lib/billable-unit-qualification.ts, as
// the source-role universe CAPABLE OF DISCOVERING a candidate at all — not
// "sources consulted for a dedupe lookup." The coverage_kind it gates is
// itself literally named 'candidate_discovery' (lib/source-coverage.ts),
// and 16B.3's own OS-2026-09 grounding note says plainly: "the source that
// would have surfaced a duplicate meeting" is the same source that would
// have surfaced ANY meeting for this account — dedupe was simply the
// FIRST consumer of that proof, not its defining purpose. Reusing it here
// for period-level discovery completeness is therefore the field's own
// intended, general meaning applied to its second legitimate use case, not
// a semantic stretch — see this function's own reuse of dedupe's exact
// mechanics (evaluateRequiredSourcesCoverage) as the evidence.
//
// Evaluated PER RULE-EFFECTIVE SEGMENT (hardening item 4): a mid-period
// amendment means different sub-intervals can legitimately require
// different discovery sources (whatever each segment's own governing rule
// configured) — the period as a whole is complete only when EVERY segment
// independently proves complete discovery over its own sub-interval.
export function evaluatePeriodDiscoveryCompletenessAcrossSegments(params: {
  segments: RulePeriodSegment[]
  sourceBindings: SourceBinding[]
  sourceBindingRoleKeys: Map<string, string>
  coverage: SourceCoverage[]
  asOf: string
}): IntervalCoverageResult {
  const { segments, sourceBindings, sourceBindingRoleKeys, coverage, asOf } = params
  if (segments.length === 0) {
    return { status: 'incomplete', reason: 'no rule-effective segment was resolved for this period', gaps: [], consideredCoverageIds: [] }
  }

  const perSegment = segments.map(seg => {
    const dedupeRule = seg.rule.dedupe_rule.value
    if (!dedupeRule) {
      return { status: 'incomplete' as const, reason: `segment [${seg.start}, ${seg.end}) governed by rule ${seg.rule.id} has no resolved dedupe_rule`, gaps: [{ from: seg.start, through: seg.end }], consideredCoverageIds: [] }
    }
    if (dedupeRule.discovery_coverage_role_keys.length === 0) {
      return { status: 'incomplete' as const, reason: `segment [${seg.start}, ${seg.end}) governed by rule ${seg.rule.id} has no configured candidate-discovery source roles`, gaps: [{ from: seg.start, through: seg.end }], consideredCoverageIds: [] }
    }
    const requiredSources = dedupeRule.discovery_coverage_role_keys.map(roleKey => ({
      label: `${roleKey}@${seg.rule.id}`,
      sourceBindingIds: resolveBindingIdsForRoleKeyOverInterval(roleKey, sourceBindings, sourceBindingRoleKeys, seg.start, seg.end),
    }))
    return evaluateRequiredSourcesCoverage({
      requiredSources, coverageKind: 'candidate_discovery' satisfies SourceCoverageKind,
      requiredFrom: seg.start, requiredThrough: seg.end, coverage, asOf,
    })
  })

  const incomplete = perSegment.filter(r => r.status !== 'complete')
  if (incomplete.length > 0) {
    return {
      status: 'incomplete',
      reason: `${incomplete.length}/${perSegment.length} rule-effective segment(s) lack complete candidate-discovery coverage: ${incomplete.map(r => r.reason).join(' | ')}`,
      gaps: incomplete.flatMap(r => r.gaps),
      consideredCoverageIds: perSegment.flatMap(r => r.consideredCoverageIds),
    }
  }
  return {
    status: 'complete',
    reason: `all ${perSegment.length} rule-effective segment(s) have complete candidate-discovery coverage`,
    gaps: [],
    consideredCoverageIds: perSegment.flatMap(r => r.consideredCoverageIds),
  }
}

// ── Period readiness — item 3 ────────────────────────────────────────────
//
// A period is 'ready' only when BOTH: (a) discovery is provably complete
// for the whole period across every rule-effective segment, and (b) no
// in-period candidate's EFFECTIVE status as of asOf remains pending — ANY
// such candidate could still resolve to 'qualified' and change the
// quantity, so its mere existence blocks readiness regardless of how many
// candidates are already terminal. Fails closed by construction: the
// default/empty case (zero known candidates, or an unresolved rule
// segmentation) is 'pending' unless discovery completeness is separately,
// affirmatively proven (item J — absence of rows is never proof of
// absence).
export type PeriodReadinessOutcome = 'ready' | 'pending'

export interface PeriodReadinessResult {
  outcome: PeriodReadinessOutcome
  reason: string
  discoveryCompleteness: IntervalCoverageResult
  segments: RulePeriodSegment[]
  qualifiedCandidateIds: string[]
  rejectedCandidateIds: string[]
  pendingCandidateIds: string[]
}

function segmentGoverning(segments: RulePeriodSegment[], instant: string): RulePeriodSegment | undefined {
  const ms = new Date(instant).getTime()
  return segments.find(seg => ms >= new Date(seg.start).getTime() && ms < new Date(seg.end).getTime())
}

// Candidates not yet created as of asOf are excluded entirely — see
// effectiveCandidateStatusAsOf's own header for why this must NOT be the
// same thing as "present but pending."
function candidatesVisibleAsOf(candidates: BillableUnitCandidate[], asOf: string): BillableUnitCandidate[] {
  return candidates.filter(c => effectiveCandidateStatusAsOf(c, asOf) !== 'not_yet_created')
}

export function evaluatePeriodReadiness(ctx: QualifiedUnitAggregationContext): PeriodReadinessResult {
  const segmentation = resolveRuleSegmentsForPeriod(ctx.ruleVersions, ctx.unitType, ctx.periodStart, ctx.periodEnd)
  const inPeriod = candidatesAttributedToPeriod(ctx)
  const visibleInPeriod = candidatesVisibleAsOf(inPeriod, ctx.asOf)

  if (segmentation.status !== 'resolved') {
    // Zero match or ambiguous rule coverage for any sub-interval fails the
    // WHOLE period closed — never bill off a partially-governed period.
    return {
      outcome: 'pending',
      reason: `cannot resolve which rule version(s) govern this period: ${segmentation.reason}`,
      discoveryCompleteness: { status: 'incomplete', reason: segmentation.reason, gaps: segmentation.status === 'gap' ? segmentation.gaps : [], consideredCoverageIds: [] },
      segments: [],
      qualifiedCandidateIds: [], rejectedCandidateIds: [], pendingCandidateIds: visibleInPeriod.map(c => c.id),
    }
  }
  const { segments } = segmentation

  for (const c of visibleInPeriod) {
    const governingSegment = segmentGoverning(segments, c.attribution_at)
    if (!governingSegment) {
      // Structurally unreachable — inPeriod already guarantees
      // attribution_at falls inside [periodStart, periodEnd), and segments
      // partition that exact range with no gaps once segmentation.status
      // === 'resolved'. Thrown, not silently skipped, since it would
      // indicate a real bug in the segmentation sweep above.
      throw new Error(`evaluatePeriodReadiness: candidate ${c.id} (attribution_at ${c.attribution_at}) falls inside the period but no resolved segment covers it`)
    }
    if (c.qualification_rule_id !== governingSegment.rule.id) {
      throw new Error(`evaluatePeriodReadiness: candidate ${c.id} is attributed to [${governingSegment.start}, ${governingSegment.end}) but pinned to rule ${c.qualification_rule_id}, not that segment's governing rule ${governingSegment.rule.id} — a candidate must always be pinned to the rule version that actually governs its own attribution_at`)
    }
  }

  const qualifiedCandidateIds = visibleInPeriod.filter(c => effectiveCandidateStatusAsOf(c, ctx.asOf) === 'qualified').map(c => c.id)
  const rejectedCandidateIds = visibleInPeriod.filter(c => effectiveCandidateStatusAsOf(c, ctx.asOf) === 'rejected').map(c => c.id)
  const pendingCandidateIds = visibleInPeriod.filter(c => effectiveCandidateStatusAsOf(c, ctx.asOf) === 'pending').map(c => c.id)

  const discoveryCompleteness = evaluatePeriodDiscoveryCompletenessAcrossSegments({
    segments, sourceBindings: ctx.sourceBindings, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, coverage: ctx.coverage, asOf: ctx.asOf,
  })

  const reasons: string[] = []
  if (pendingCandidateIds.length > 0) {
    reasons.push(`${pendingCandidateIds.length} candidate(s) attributed to this period are effectively pending as of ${ctx.asOf} and could still change the quantity: ${pendingCandidateIds.join(', ')}`)
  }
  if (discoveryCompleteness.status !== 'complete') {
    reasons.push(`candidate-discovery coverage is not complete for the whole period: ${discoveryCompleteness.reason}`)
  }

  if (reasons.length > 0) {
    return { outcome: 'pending', reason: reasons.join('; '), discoveryCompleteness, segments, qualifiedCandidateIds, rejectedCandidateIds, pendingCandidateIds }
  }
  return {
    outcome: 'ready',
    reason: `discovery is complete for [${ctx.periodStart}, ${ctx.periodEnd}) across ${segments.length} rule-effective segment(s) and no in-period candidate is effectively pending as of ${ctx.asOf} — ${qualifiedCandidateIds.length} qualified, ${rejectedCandidateIds.length} rejected`,
    discoveryCompleteness, segments, qualifiedCandidateIds, rejectedCandidateIds, pendingCandidateIds,
  }
}

// ── Deterministic aggregation — item 5 ───────────────────────────────────
//
// Pure and read-only — never mutates any candidate row. Because terminal
// candidates are immutable and SourceCoverage is append/revoke-only,
// calling this twice with the same inputs (including the same asOf) always
// returns the identical quantity and candidate set (item H) — there is no
// hidden mutable state anywhere in this function.
export interface QualifiedUnitAggregateResult {
  readiness: PeriodReadinessResult
  // null whenever the period is not 'ready' — fail closed, never a
  // guessed/partial number (item 8's "no guessed invoice").
  quantity: number | null
  projections: QualifiedUnitProjection[]
  candidateIdsConsidered: string[]
}

export function aggregateQualifiedUnits(ctx: QualifiedUnitAggregationContext): QualifiedUnitAggregateResult {
  const readiness = evaluatePeriodReadiness(ctx)
  // "Considered" means visible to THIS historical replay — a candidate not
  // yet created as of asOf was never part of it (hardening item 1).
  const candidateIdsConsidered = candidatesVisibleAsOf(candidatesAttributedToPeriod(ctx), ctx.asOf).map(c => c.id)

  if (readiness.outcome !== 'ready') {
    return { readiness, quantity: null, projections: [], candidateIdsConsidered }
  }

  const projections = ctx.candidates
    .map(c => projectQualifiedUnit(c, ctx.periodStart, ctx.periodEnd, ctx.asOf))
    .filter((p): p is QualifiedUnitProjection => p !== null)

  return { readiness, quantity: projections.length, projections, candidateIdsConsidered }
}
