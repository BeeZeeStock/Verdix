// Billable Unit Qualification — Step 16B.3: completeness + terminal
// finality. Takes 16B.2's candidate/evidence/criteria/dedupe-observation
// evaluator (lib/billable-unit-candidate.ts, UNCHANGED by this file) and
// adds exactly the layer it explicitly deferred: SourceCoverage-backed
// dedupe completeness, business-day rejection-window/deadline resolution,
// structured rejection evidence + validity, rejection-source completeness,
// and the one terminal decision — pending -> qualified | rejected.
//
// Deliberately stops there. This file NEVER computes a billable/qualified
// UNIT COUNT, never touches usage-pull/schedulers/pricing/Stripe/
// Remembill/partner payouts/revenue-share, and never reselects "the
// current active rule" — every function below evaluates strictly against
// the candidate's already-pinned rule version (candidate.
// qualification_rule_id/qualification_rule_version), the caller-supplied
// asOf, and caller-supplied historical evidence/coverage. See the scope
// note at the bottom of this file.
//
// Naming discipline (16B.3 brief, architecture constraint): no branch
// anywhere in this file is named after "SQM," "meeting," "CRM rejection,"
// or "qualified contact" — every mechanism here (objection/rejection
// records, channel exceptions, discovery/rejection-source coverage) is
// generic enough to be reused for delivery acceptance, claim finality,
// conversion eligibility, dispute windows, partner entitlement finality,
// or revenue-share earning conditions. Domain specifics live ONLY in rule
// configuration (lib/os-2026-09-fixture.ts), never in this evaluator.
import {
  isFieldDecisionResolved, collectReasonPredicateFactKeys,
  type BillableUnitQualificationRule, type RejectionRule, type QualificationReasonPredicate,
} from './billable-unit-qualification'
import {
  isEvidenceActiveAsOf, evaluateCandidateCriteria, evaluateDedupeObservation, evaluateQualificationExpression, resolveCandidateFact,
  type BillableUnitCandidate, type CandidateUnitEvidence, type TriState, type DedupeObservationTrace, type FactResolutionOutcome,
  type EvaluationTrace, type CandidateCriteriaEvaluation,
} from './billable-unit-candidate'
import {
  evaluateRequiredSourcesCoverage,
  type SourceCoverage, type SourceCoverageKind, type IntervalCoverageResult,
} from './source-coverage'
import { computeBusinessDayDeadline, type HolidayCalendarId } from './business-days'
import { doesSourceBindingOverlapInterval, type SourceBinding } from './source-bindings'
import { RESERVED_SOURCE_ROLE_KEY } from './source-roles'

// ── Shared evaluation context ─────────────────────────────────────────────
export interface CandidateFinalityContext {
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  evidence: CandidateUnitEvidence[]
  priorCandidates: Array<{ candidate: BillableUnitCandidate; evidence: CandidateUnitEvidence[] }>
  sourceBindingRoleKeys: Map<string, string>
  sourceBindings: SourceBinding[]
  coverage: SourceCoverage[]
  asOf: string
}

// Resolves every SourceBinding that backed `roleKey` at any point during
// [from, through) — usually one, but a genuine re-platform mid-window can
// produce more than one (see lib/source-coverage.ts's own note on why
// evaluateUnionIntervalCoverage accepts a LIST of bindings for exactly
// this reason).
function resolveBindingIdsForRoleKeyOverInterval(
  roleKey: string, sourceBindings: SourceBinding[], sourceBindingRoleKeys: Map<string, string>, from: string, through: string,
): string[] {
  return sourceBindings
    .filter(b => sourceBindingRoleKeys.get(b.id) === roleKey)
    .filter(b => doesSourceBindingOverlapInterval(b, from, through))
    .map(b => b.id)
}

// ── Dedupe completeness — item 2 ────────────────────────────────────────
//
// evaluateDedupeObservation (16B.2) answers "did we FIND a duplicate."
// This answers the question 16B.2 explicitly deferred: is 'no_known_
// duplicate' backed by proof the relevant lookback window was fully
// observable, or is it merely "we haven't looked everywhere yet." Never
// promotes 'no_known_duplicate' to a clearance on its own — see
// evaluateDedupeObservation's own comment, still true and unchanged.
export type DedupeCompletenessOutcome = 'duplicate' | 'cleared' | 'pending'

export interface DedupeCompletenessResult {
  outcome: DedupeCompletenessOutcome
  reason: string
  observation: DedupeObservationTrace
  coverage?: IntervalCoverageResult
}

export function evaluateDedupeCompleteness(ctx: CandidateFinalityContext): DedupeCompletenessResult {
  const observation = evaluateDedupeObservation(ctx)
  if (observation.status === 'duplicate_found') {
    return { outcome: 'duplicate', reason: observation.reason, observation }
  }
  if (observation.status === 'unknown') {
    return { outcome: 'pending', reason: observation.reason, observation }
  }

  const dedupeRule = ctx.rule.dedupe_rule.value
  if (!dedupeRule) throw new Error('evaluateDedupeCompleteness: rule.dedupe_rule has no resolved value')
  if (dedupeRule.discovery_coverage_role_keys.length === 0) {
    return {
      outcome: 'pending',
      reason: "dedupe_rule.discovery_coverage_role_keys is empty — 'no_known_duplicate' can never clear dedupe without at least one configured coverage source",
      observation,
    }
  }
  if (dedupeRule.lookback.unit === 'business') {
    // Same explicit deferral as evaluateDedupeObservation's own — no
    // OS-2026-09 case needs it, so it is not implemented rather than
    // approximated. evaluateDedupeObservation already throws for this
    // case before this function would even be reached in practice.
    throw new Error('evaluateDedupeCompleteness: business-day dedupe lookback is not implemented — no fixture case requires it')
  }

  const requiredThrough = ctx.candidate.attribution_at
  const requiredFrom = new Date(new Date(requiredThrough).getTime() - dedupeRule.lookback.days * 86_400_000).toISOString()

  const requiredSources = dedupeRule.discovery_coverage_role_keys.map(roleKey => ({
    label: roleKey,
    sourceBindingIds: resolveBindingIdsForRoleKeyOverInterval(roleKey, ctx.sourceBindings, ctx.sourceBindingRoleKeys, requiredFrom, requiredThrough),
  }))

  const coverage = evaluateRequiredSourcesCoverage({
    requiredSources, coverageKind: 'candidate_discovery' satisfies SourceCoverageKind,
    requiredFrom, requiredThrough, coverage: ctx.coverage, asOf: ctx.asOf,
  })

  if (coverage.status !== 'complete') {
    return { outcome: 'pending', reason: `dedupe cleared observationally, but candidate-discovery coverage is incomplete: ${coverage.reason}`, observation, coverage }
  }
  return { outcome: 'cleared', reason: 'no_known_duplicate, and candidate-discovery coverage fully spans the lookback interval', observation, coverage }
}

// ── Rejection deadline — item 3 ─────────────────────────────────────────
export type RejectionDeadlineResult =
  | { status: 'resolved'; deadline: string; referenceTimestamp: string }
  | { status: 'unresolved'; reason: string }

export function resolveRejectionDeadline(candidate: BillableUnitCandidate, rule: BillableUnitQualificationRule): RejectionDeadlineResult {
  if (!isFieldDecisionResolved(rule.rejection_window)) return { status: 'unresolved', reason: 'rejection_window is not resolved on the pinned rule version' }
  if (!isFieldDecisionResolved(rule.deadline_convention)) return { status: 'unresolved', reason: 'deadline_convention is not resolved on the pinned rule version' }
  const window = rule.rejection_window.value
  const convention = rule.deadline_convention.value
  if (!window || !convention) return { status: 'unresolved', reason: 'rejection_window/deadline_convention resolved but has no value' }

  // Step 16B.3 hardening — 'end_of_business_day' is only computable with
  // an explicit, reviewer-confirmed local cutoff; without one this fails
  // closed to unresolved rather than silently meaning "end of calendar
  // day" (see lib/business-days.ts's own comment). Checked defensively
  // here too, not just at rule-activation time (isQualificationRuleReady)
  // — same "don't trust the invariant blindly" discipline as
  // pinQualificationRuleVersion's own defensive skip.
  let businessDayEndLocalTime: string | undefined
  if (convention === 'end_of_business_day') {
    if (!isFieldDecisionResolved(rule.business_day_end_local_time) || !rule.business_day_end_local_time.value) {
      return { status: 'unresolved', reason: "deadline_convention is 'end_of_business_day' but business_day_end_local_time is not resolved on the pinned rule version" }
    }
    businessDayEndLocalTime = rule.business_day_end_local_time.value
  }

  const referenceTimestamp = window.reference_time === 'booked_at' ? candidate.booked_at
    : window.reference_time === 'occurred_at' ? candidate.occurred_at
    : candidate.attribution_at
  if (!referenceTimestamp) return { status: 'unresolved', reason: `candidate has no '${window.reference_time}' timestamp to anchor the rejection window` }

  const deadline = computeBusinessDayDeadline({
    referenceTime: referenceTimestamp, businessDays: window.business_days,
    calendar: window.holiday_calendar as HolidayCalendarId, timezone: window.timezone, convention,
    businessDayEndLocalTime,
  })
  return { status: 'resolved', deadline, referenceTimestamp }
}

// ── Fact-evidence finality — 16B.3 contractual-finality hardening ────────
//
// The gap this closes: 16B.3's ORIGINAL slice proved candidate-discovery
// and rejection-source completeness, but a terminal decision could still
// rest on an OPERATIONAL FACT (e.g. contact.role) whose evidence set was
// never proven complete — a lower-priority source could resolve a fact
// today simply because a higher-priority source hasn't reported YET, not
// because it has nothing to report. This function answers, for ONE fact
// key, whether ITS OWN resolution is stable — i.e. no source capable of
// affecting that resolution could still produce new evidence that would
// change it.
//
// The required source set is NEVER inferred from whatever evidence
// happens to exist — it is read from two pieces of TYPED rule
// configuration only: fact_evidence_source_roles[factKey] (the closed
// universe of role_keys capable of affecting this fact at all) and, when
// present, evidence_precedence[factKey] (which of them actually matter
// for THIS resolution, given how conflicts are resolved):
//   authoritative_source(S)                  -> requires only S
//   source_precedence([...order])            -> requires the WINNING
//     source (its own coverage might still reveal a MORE RECENT,
//     different observation from itself) PLUS every higher-priority
//     source whose absence was relied upon (order prefix up to and
//     including the winner) — or the WHOLE order when nothing resolved,
//     since nothing can be nothing had every entry not actually reported
//   authoritative_if_fresh_else_latest(S, ...) -> requires only S when S
//     itself is what won (fresh); requires EVERY capable source when S is
//     stale/absent and resolution fell back to "the most recent reliable
//     source," since any of them could be that source
//   no strategy configured (implicit agreement-only default)
//                                             -> requires every capable
//     source, since an unseen source could still show up and disagree
//
// Reviewer-attested facts (fact_evidence_source_roles === exactly
// [RESERVED_SOURCE_ROLE_KEY]) are a structural exception: a human's own
// explicit, timestamped attestation IS final the moment it resolves — no
// SourceCoverage row is required or meaningful for a one-time human act
// (there is nothing further for a connector to "watch").
export type FactFinalityStatus = 'complete' | 'incomplete' | 'unknown'

export interface FactFinalityResult {
  factKey: string
  status: FactFinalityStatus
  reason: string
  requiredSources: string[]
  coverage?: IntervalCoverageResult
}

// Resolves the role's own binding-derived lower bound for the required
// coverage interval — SourceBinding.effective_from is real, typed
// registration data (never inferred from "whatever evidence happens to
// exist"), and is what makes a concrete requiredFrom possible at all
// without inventing an arbitrary lookback window for facts (which,
// unlike dedupe/rejection, have no contractual lookback period).
function resolveFactEvidenceRequiredSource(
  roleKey: string, sourceBindings: SourceBinding[], sourceBindingRoleKeys: Map<string, string>, referenceTime: string,
): { label: string; sourceBindingIds: string[]; requiredFrom?: string } {
  const refMs = new Date(referenceTime).getTime()
  const bindings = sourceBindings
    .filter(b => sourceBindingRoleKeys.get(b.id) === roleKey)
    .filter(b => new Date(b.effective_from).getTime() <= refMs)
  if (bindings.length === 0) return { label: roleKey, sourceBindingIds: [] }
  const earliestFrom = bindings.reduce((min, b) => (new Date(b.effective_from).getTime() < new Date(min).getTime() ? b.effective_from : min), bindings[0].effective_from)
  return { label: roleKey, sourceBindingIds: bindings.map(b => b.id), requiredFrom: earliestFrom }
}

export function evaluateFactFinality(params: {
  factKey: string
  resolution: FactResolutionOutcome
  ctx: CandidateFinalityContext
}): FactFinalityResult {
  const { factKey, resolution, ctx } = params
  const capableDecision = ctx.rule.fact_evidence_source_roles[factKey]
  if (!capableDecision || !isFieldDecisionResolved(capableDecision) || !capableDecision.value) {
    return { factKey, status: 'unknown', reason: `fact_evidence_source_roles has no resolved capable-source list for '${factKey}'`, requiredSources: [] }
  }
  const capableSources = capableDecision.value

  if (capableSources.length === 1 && capableSources[0] === RESERVED_SOURCE_ROLE_KEY) {
    return resolution.status === 'resolved'
      ? { factKey, status: 'complete', reason: 'reviewer attestation is inherently final once resolved — no connector coverage is meaningful for it', requiredSources: capableSources }
      : { factKey, status: 'unknown', reason: 'reviewer attestation not yet resolved', requiredSources: capableSources }
  }

  const referenceTime = resolution.referenceTime
  if (referenceTime === null) {
    return { factKey, status: 'unknown', reason: `'${factKey}' has no reference_time to check finality against`, requiredSources: capableSources }
  }

  const strategyDecision = ctx.rule.evidence_precedence[factKey]
  const strategy = strategyDecision && isFieldDecisionResolved(strategyDecision) ? strategyDecision.value : null

  let requiredRoleKeys: string[]
  let basis: string
  if (strategy === null) {
    requiredRoleKeys = capableSources
    basis = 'no evidence_precedence configured for this fact — every capable source must be complete'
  } else if (strategy.kind === 'authoritative_source') {
    requiredRoleKeys = [strategy.source]
    basis = `authoritative_source '${strategy.source}'`
  } else if (strategy.kind === 'source_precedence') {
    if (resolution.status === 'resolved') {
      const idx = strategy.order.indexOf(resolution.sourceRoleKey)
      requiredRoleKeys = idx >= 0 ? strategy.order.slice(0, idx + 1) : strategy.order
    } else {
      requiredRoleKeys = strategy.order
    }
    basis = `source_precedence [${strategy.order.join(' > ')}]`
  } else {
    // authoritative_if_fresh_else_latest
    if (resolution.status === 'resolved' && resolution.sourceRoleKey === strategy.source) {
      requiredRoleKeys = [strategy.source]
      basis = `authoritative_if_fresh_else_latest — '${strategy.source}' is fresh and won outright`
    } else {
      requiredRoleKeys = capableSources
      basis = `authoritative_if_fresh_else_latest — '${strategy.source}' is stale/absent; any capable source could be the fallback latest`
    }
  }

  const requiredSources = requiredRoleKeys.map(roleKey => resolveFactEvidenceRequiredSource(roleKey, ctx.sourceBindings, ctx.sourceBindingRoleKeys, referenceTime))
  const coverage = evaluateRequiredSourcesCoverage({
    requiredSources, coverageKind: 'fact_evidence' satisfies SourceCoverageKind,
    requiredFrom: referenceTime, requiredThrough: referenceTime, coverage: ctx.coverage, asOf: ctx.asOf,
  })
  if (coverage.status !== 'complete') {
    return { factKey, status: 'incomplete', reason: `${basis} — ${coverage.reason}`, requiredSources: requiredRoleKeys, coverage }
  }
  return { factKey, status: 'complete', reason: `${basis} — coverage complete through ${referenceTime}`, requiredSources: requiredRoleKeys, coverage }
}

// ── Material-fact collection — which facts a given decisive path relies on ─
//
// TRACE-based, not a static structural walk — this matters. 16B.2's
// evaluator never short-circuits at the EXECUTION level (every leaf in the
// expression tree is always evaluated — see evaluateQualificationExpression),
// but that does NOT mean every leaf is equally load-bearing for a given
// RESULT. Concretely: an any_of with one 'satisfied' child and one
// 'unknown' child (e.g. a directly-matched contact.role alongside a
// never-attested reviewer-attestation fallback) is itself 'satisfied' —
// and STAYS satisfied no matter what the unknown child's fact eventually
// resolves to, because combineAnyOf already gives satisfied priority. A
// naive "collect every static leaf" approach would incorrectly treat the
// unknown attestation fact as material and permanently block finality on
// a candidate that never needed it. This walker instead mirrors
// combineAllOf/combineAnyOf's own priority rules to collect ONLY the
// children that actually determined the OBSERVED result:
//   all_of, result 'not_satisfied' -> only the not_satisfied child(ren)
//     (combineAllOf gives not_satisfied priority; a still-open sibling
//     cannot change that this all_of is not_satisfied)
//   all_of, result 'satisfied'     -> every child (all had to agree)
//   any_of, result 'satisfied'     -> only the satisfied child(ren)
//     (combineAnyOf gives satisfied priority; an unresolved sibling cannot
//     change that this any_of is satisfied)
//   any_of, result 'not_satisfied' -> every child (all had to fail)
// ('unknown' results are never passed in here — a criteria/role result of
// 'unknown' always lands in the 'not yet decidable' pending bucket, which
// never calls the fact-finality gate at all.)
function collectMaterialFactKeysFromTrace(trace: EvaluationTrace): string[] {
  if (trace.kind === 'condition') return [trace.condition.field]
  if (trace.kind === 'all_of') {
    const relevant = trace.result === 'not_satisfied' ? trace.children.filter(c => c.result === 'not_satisfied') : trace.children
    return relevant.flatMap(collectMaterialFactKeysFromTrace)
  }
  // any_of
  const relevant = trace.result === 'satisfied' ? trace.children.filter(c => c.result === 'satisfied') : trace.children
  return relevant.flatMap(collectMaterialFactKeysFromTrace)
}

// Wraps criteria + qualified_contact_role as a synthetic 2-child all_of
// (exactly matching evaluateCandidateCriteria's own
// combineAllOf([criteriaEval.result, roleEval.result]) combination) so the
// SAME priority-aware walker applies uniformly to the combined result.
function collectMaterialCriteriaFactKeys(criteria: CandidateCriteriaEvaluation): string[] {
  const combined: EvaluationTrace = { kind: 'all_of', result: criteria.result, children: [criteria.criteriaTrace, criteria.qualifiedContactRoleTrace] }
  return collectMaterialFactKeysFromTrace(combined)
}

// Dedupe key_fields/scope are never a priority composition — matching a
// prior candidate genuinely requires EVERY key field to agree, so all of
// them are unconditionally material whenever a dedupe determination
// (either 'duplicate' or 'cleared') is actually relied upon.
function collectDedupeFactKeys(rule: BillableUnitQualificationRule): string[] {
  const dedupeRule = rule.dedupe_rule.value
  if (!dedupeRule) return []
  return [...dedupeRule.key_fields, ...dedupeRule.scope.map(c => c.field)]
}

// A reason predicate's 'qualified_contact_role'/'dedupe_observation'
// variants reuse an ALREADY-COMPUTED result rather than independently
// resolving facts (see evaluateReasonPredicate below) — but the facts
// THAT result itself depends on are still materially used by a decision
// substantiated through them, so they must still be included here. 'expression'
// gets the SAME priority-aware trace treatment as criteria/role (an any_of
// inside a predicate must not require a branch that wasn't actually
// needed for its observed result); 'temporal_relation' has no such
// ambiguity (both fields are unconditionally needed for the comparison),
// so the plain structural collector (collectReasonPredicateFactKeys) is
// exact for it already.
function collectReasonPredicateMaterialFactKeys(predicate: QualificationReasonPredicate, ctx: CandidateFinalityContext): string[] {
  switch (predicate.kind) {
    case 'expression': {
      const evalResult = evaluateQualificationExpression({
        expr: predicate.expression, candidate: ctx.candidate, rule: ctx.rule, evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf,
      })
      return collectMaterialFactKeysFromTrace(evalResult.trace)
    }
    case 'qualified_contact_role':
      return collectMaterialFactKeysFromTrace(evaluateCandidateCriteria(ctx).qualifiedContactRoleTrace)
    case 'dedupe_observation':
      return collectDedupeFactKeys(ctx.rule)
    case 'all_of':
      return predicate.predicates.flatMap(p => collectReasonPredicateMaterialFactKeys(p, ctx))
    case 'temporal_relation':
      return collectReasonPredicateFactKeys(predicate)
  }
}

function combinePredicateAllOf(results: TriState[]): TriState {
  if (results.some(r => r === 'not_satisfied')) return 'not_satisfied'
  if (results.some(r => r === 'unknown')) return 'unknown'
  return 'satisfied'
}

// ── Reason-predicate evaluation — item 2: a claimed reason is not proof ──
//
// Dispatches PURELY on predicate.kind — a closed set of five generic,
// reusable evaluation primitives (see QualificationReasonPredicate's own
// comment in lib/billable-unit-qualification.ts). No branch here is named
// after a specific reason code ('attendance', 'duplicate', ...); the
// mapping from a contract's actual reason vocabulary to one of these
// shapes is entirely rule CONFIGURATION (rejection_rule.reason_predicates).
export function evaluateReasonPredicate(predicate: QualificationReasonPredicate, ctx: CandidateFinalityContext): { result: TriState; detail: string } {
  switch (predicate.kind) {
    case 'expression': {
      const evalResult = evaluateQualificationExpression({
        expr: predicate.expression, candidate: ctx.candidate, rule: ctx.rule, evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf,
      })
      if (evalResult.result === 'unknown') return { result: 'unknown', detail: `expression is unknown; expected '${predicate.expect}'` }
      const matches = predicate.expect === 'satisfied' ? evalResult.result === 'satisfied' : evalResult.result === 'not_satisfied'
      return { result: matches ? 'satisfied' : 'not_satisfied', detail: `expression evaluated '${evalResult.result}'; expected '${predicate.expect}'` }
    }
    case 'qualified_contact_role': {
      const roleResult = evaluateCandidateCriteria(ctx).qualifiedContactRoleTrace.result
      if (roleResult === 'unknown') return { result: 'unknown', detail: `qualified_contact_role is unknown; expected '${predicate.expect}'` }
      const matches = predicate.expect === 'satisfied' ? roleResult === 'satisfied' : roleResult === 'not_satisfied'
      return { result: matches ? 'satisfied' : 'not_satisfied', detail: `qualified_contact_role evaluated '${roleResult}'; expected '${predicate.expect}'` }
    }
    case 'dedupe_observation': {
      const observation = evaluateDedupeObservation(ctx)
      if (observation.status === 'unknown') return { result: 'unknown', detail: 'dedupe observation is unknown' }
      return { result: observation.status === predicate.expect ? 'satisfied' : 'not_satisfied', detail: `dedupe observation is '${observation.status}'; expected '${predicate.expect}'` }
    }
    case 'temporal_relation': {
      const left = resolveCandidateFact({ candidate: ctx.candidate, rule: ctx.rule, factKey: predicate.left_field, evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf })
      const right = resolveCandidateFact({ candidate: ctx.candidate, rule: ctx.rule, factKey: predicate.right_field, evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf })
      if (left.status !== 'resolved' || right.status !== 'resolved') {
        return { result: 'unknown', detail: `temporal_relation: '${predicate.left_field}' or '${predicate.right_field}' is unresolved` }
      }
      const leftMs = new Date(left.value as string).getTime()
      const rightMs = new Date(right.value as string).getTime()
      const durationMs = predicate.duration_days * 86_400_000
      const satisfied = predicate.comparator === 'lte' ? leftMs <= rightMs - durationMs : leftMs >= rightMs + durationMs
      return {
        result: satisfied ? 'satisfied' : 'not_satisfied',
        detail: `${predicate.left_field} (${String(left.value)}) ${predicate.comparator} ${predicate.right_field} (${String(right.value)}) ${predicate.comparator === 'lte' ? '-' : '+'} ${predicate.duration_days}d`,
      }
    }
    case 'all_of': {
      const children = predicate.predicates.map(p => evaluateReasonPredicate(p, ctx))
      return { result: combinePredicateAllOf(children.map(c => c.result)), detail: `all_of: [${children.map(c => c.detail).join('; ')}]` }
    }
  }
}

// ── Structured objection/rejection evidence — items 4, 5 ────────────────
//
// Generic evidence-shape convention (applies to any "record of objection/
// rejection against an operational unit"), the same pattern as the
// existing 'account.*'/'contact.*'/'qualified_contact_role.*' fact-key
// prefixes. This evaluator has NO special knowledge of what a "meeting
// rejection" is — it only ever reads these four generically-named fact
// keys off ONE evidence row (never recombined across rows/sources — see
// extractObjectionRecords) and compares them against rule configuration.
export const OBJECTION_REASON_FACT_KEY = 'objection_or_rejection.reason'
export const OBJECTION_CHANNEL_FACT_KEY = 'objection_or_rejection.channel'
export const OBJECTION_TIMESTAMP_FACT_KEY = 'objection_or_rejection.timestamp'
export const OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY = 'objection_or_rejection.subject_external_id'

export interface ObjectionOrRejectionRecord {
  evidenceId: string
  sourceBindingId: string
  reason: string | null
  channel: string | null
  timestamp: string | null
  subjectExternalId: string | null
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// One CandidateUnitEvidence row IS one objection/rejection observation —
// deliberately NOT resolved fact-by-fact via resolveCandidateFact (which
// independently picks a winning SOURCE per fact key). A rejection's
// reason/channel/timestamp/identification were reported TOGETHER, by the
// same actor, in the same act of recording the objection, and must be
// read back together from the SAME evidence row — never recombined from
// different rows or sources via a precedence strategy.
export function extractObjectionRecords(candidate: BillableUnitCandidate, evidence: CandidateUnitEvidence[], asOf: string): ObjectionOrRejectionRecord[] {
  return evidence
    .filter(e => e.candidate_id === candidate.id && isEvidenceActiveAsOf(e, asOf))
    .filter(e => OBJECTION_REASON_FACT_KEY in e.facts || OBJECTION_CHANNEL_FACT_KEY in e.facts)
    .map(e => ({
      evidenceId: e.id,
      sourceBindingId: e.source_binding_id,
      reason: asStringOrNull(e.facts[OBJECTION_REASON_FACT_KEY]),
      channel: asStringOrNull(e.facts[OBJECTION_CHANNEL_FACT_KEY]),
      timestamp: asStringOrNull(e.facts[OBJECTION_TIMESTAMP_FACT_KEY]),
      subjectExternalId: asStringOrNull(e.facts[OBJECTION_SUBJECT_EXTERNAL_ID_FACT_KEY]),
    }))
}

// Item 2 trace requirement — claimed reason, the predicate configured for
// it, the evidence-derived result, and a human-readable detail of what
// was actually checked. Present whenever a reason label passed the
// allowlist check (so we got far enough to attempt substantiation) —
// absent when the record failed an earlier, structural check (unknown
// reason, missing timestamp/identification, invalid channel) where no
// predicate was ever consulted.
export interface ReasonSubstantiationTrace {
  reasonCode: string
  predicate: QualificationReasonPredicate
  result: TriState
  detail: string
}

export interface ObjectionOrRejectionRecordEvaluation {
  record: ObjectionOrRejectionRecord
  status: 'valid' | 'invalid'
  reason: string
  reasonSubstantiation?: ReasonSubstantiationTrace
}

// Validity is independent of timeliness — a record can be a valid
// rejection recorded LATE (item: "does not prevent initial
// qualification"); timeliness is judged separately by the caller against
// the resolved deadline.
function evaluateObjectionRecordValidity(
  record: ObjectionOrRejectionRecord, rejectionRule: RejectionRule, ctx: CandidateFinalityContext,
): ObjectionOrRejectionRecordEvaluation {
  if (record.reason === null || !rejectionRule.valid_reasons.includes(record.reason)) {
    return { record, status: 'invalid', reason: `reason ${JSON.stringify(record.reason)} is not one of rejection_rule.valid_reasons` }
  }
  if (rejectionRule.requires_timestamp && record.timestamp === null) {
    return { record, status: 'invalid', reason: 'rejection_rule.requires_timestamp is true but this record has no timestamp' }
  }
  if (rejectionRule.requires_identification && record.subjectExternalId === null) {
    return { record, status: 'invalid', reason: 'rejection_rule.requires_identification is true but this record has no subject_external_id' }
  }

  const channelValid = record.channel !== null && rejectionRule.valid_channels.includes(record.channel)
  let channelValidityReason: string
  if (channelValid) {
    channelValidityReason = `channel '${record.channel}' is a valid_channel`
  } else {
    // Not a directly-valid channel — the ONLY other path to validity is a
    // configured, evidence-backed exception (item 5): a written-agreement
    // evidence reference PLUS an explicit reviewer attestation linking it
    // to THIS candidate, both resolved as ORDINARY facts through the exact
    // same resolveCandidateFact machinery every other fact goes through —
    // no evaluator-level "email_exception" branch anywhere in this function.
    const exception = rejectionRule.channel_exception
    if (!exception || record.channel === null || !exception.applies_to_channels.includes(record.channel)) {
      return { record, status: 'invalid', reason: `channel ${JSON.stringify(record.channel)} is not a valid_channel, and no channel_exception applies to it` }
    }
    const evidenceRef = resolveCandidateFact({
      candidate: ctx.candidate, rule: ctx.rule, factKey: exception.evidence_reference_fact_key,
      evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf,
    })
    const attestation = resolveCandidateFact({
      candidate: ctx.candidate, rule: ctx.rule, factKey: exception.attestation_fact_key,
      evidence: ctx.evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf,
    })
    const hasWrittenReference = evidenceRef.status === 'resolved' && typeof evidenceRef.value === 'string' && evidenceRef.value.length > 0
    const isAttested = attestation.status === 'resolved' && attestation.value === true
    if (!hasWrittenReference || !isAttested) {
      return {
        record, status: 'invalid',
        reason: `channel '${record.channel}' is not otherwise valid, and the configured channel_exception is not both evidenced and attested (writtenReference=${hasWrittenReference}, attested=${isAttested})`,
      }
    }
    channelValidityReason = `channel '${record.channel}' is not otherwise valid, but a written-agreement exception is resolved and attested for this candidate`
  }

  // Step 16B.3 hardening (item 2) — the channel is valid and the reason
  // label is allowed, but a LABEL IS NOT PROOF. Substantiate it against
  // the rule's configured predicate before this record can ever be
  // treated as a valid, terminally-dispositive rejection.
  const predicate = rejectionRule.reason_predicates[record.reason]
  if (!predicate) {
    return { record, status: 'invalid', reason: `${channelValidityReason}, but reason '${record.reason}' has no configured reason_predicates entry to substantiate it` }
  }
  const { result, detail } = evaluateReasonPredicate(predicate, ctx)
  const reasonSubstantiation: ReasonSubstantiationTrace = { reasonCode: record.reason, predicate, result, detail }
  if (result !== 'satisfied') {
    return {
      record, status: 'invalid', reasonSubstantiation,
      reason: `${channelValidityReason}, but reason '${record.reason}' is allowed yet not substantiated (${result}): ${detail}`,
    }
  }
  return { record, status: 'valid', reasonSubstantiation, reason: `${channelValidityReason}; reason '${record.reason}' substantiated: ${detail}` }
}

// ── Rejection completeness — item 6 ─────────────────────────────────────
export type RejectionCompletenessOutcome = 'rejected' | 'cleared' | 'pending'

export interface RejectionCompletenessResult {
  outcome: RejectionCompletenessOutcome
  reason: string
  deadline: RejectionDeadlineResult
  validTimelyRecord?: ObjectionOrRejectionRecordEvaluation
  validLateRecords: ObjectionOrRejectionRecordEvaluation[]
  invalidRecords: ObjectionOrRejectionRecordEvaluation[]
  coverage?: IntervalCoverageResult
}

export function evaluateRejectionCompleteness(ctx: CandidateFinalityContext): RejectionCompletenessResult {
  const rejectionRule = ctx.rule.rejection_rule.value
  if (!rejectionRule) throw new Error('evaluateRejectionCompleteness: rule.rejection_rule has no resolved value')

  const deadline = resolveRejectionDeadline(ctx.candidate, ctx.rule)

  const records = extractObjectionRecords(ctx.candidate, ctx.evidence, ctx.asOf)
  const evaluated = records.map(r => evaluateObjectionRecordValidity(r, rejectionRule, ctx))
  const validRecords = evaluated.filter(e => e.status === 'valid')
  const invalidRecords = evaluated.filter(e => e.status === 'invalid')

  if (deadline.status !== 'resolved') {
    // Cannot judge timeliness at all without a deadline — fails closed to
    // pending regardless of what the records themselves look like (item 7:
    // "Terminal transition must fail closed unless all required rule
    // fields are ready").
    return { outcome: 'pending', reason: `rejection deadline is not resolvable: ${deadline.reason}`, deadline, validLateRecords: [], invalidRecords }
  }

  const deadlineMs = new Date(deadline.deadline).getTime()
  const validTimely = validRecords.find(r => r.record.timestamp !== null && new Date(r.record.timestamp).getTime() <= deadlineMs)
  if (validTimely) {
    return {
      outcome: 'rejected', reason: `valid rejection recorded at-or-before the deadline (${deadline.deadline})`,
      deadline, validTimelyRecord: validTimely, validLateRecords: validRecords.filter(r => r !== validTimely), invalidRecords,
    }
  }

  // Every valid record found (if any) is, by elimination, late — item:
  // "A late rejection -> does not prevent initial qualification."
  const validLateRecords = validRecords

  if (new Date(ctx.asOf).getTime() < deadlineMs) {
    return { outcome: 'pending', reason: `rejection deadline (${deadline.deadline}) has not yet passed as of ${ctx.asOf}`, deadline, validLateRecords, invalidRecords }
  }

  const requiredSources = rejectionRule.valid_channels.map(roleKey => ({
    label: roleKey,
    sourceBindingIds: resolveBindingIdsForRoleKeyOverInterval(roleKey, ctx.sourceBindings, ctx.sourceBindingRoleKeys, deadline.referenceTimestamp, deadline.deadline),
  }))
  const coverage = evaluateRequiredSourcesCoverage({
    requiredSources, coverageKind: 'rejection_source' satisfies SourceCoverageKind,
    requiredFrom: deadline.referenceTimestamp, requiredThrough: deadline.deadline, coverage: ctx.coverage, asOf: ctx.asOf,
  })
  if (coverage.status !== 'complete') {
    return { outcome: 'pending', reason: `rejection deadline passed but required rejection-source coverage is incomplete: ${coverage.reason}`, deadline, validLateRecords, invalidRecords, coverage }
  }
  return { outcome: 'cleared', reason: 'rejection deadline passed, required rejection-source coverage is complete, and no valid timely rejection was found', deadline, validLateRecords, invalidRecords, coverage }
}

// ── Terminal qualification decision — items 7, 8, 9 ─────────────────────
//
// The ONLY lifecycle transition this slice implements: pending ->
// qualified | rejected, or stays pending. Never re-selects "the current
// active rule" — every sub-evaluation above runs strictly against
// ctx.rule, which the caller must have already resolved to be the
// candidate's OWN pinned (qualification_rule_id, qualification_rule_version)
// — evaluateCandidateCriteria/evaluateDedupeObservation (16B.2) already
// assert this pin match; this function trusts the same assertion rather
// than duplicating it.
export type CandidateFinalDecisionOutcome = 'qualified' | 'rejected' | 'pending'

export interface CandidateFinalDecision {
  outcome: CandidateFinalDecisionOutcome
  reason: string
  criteria: TriState
  dedupe: DedupeCompletenessResult
  // Always computed and returned for full observability/diagnostics
  // (pure, no I/O — computing it costs nothing), but — per the
  // materiality-aware terminalization hardening below — its OUTCOME is
  // never itself consulted to decide a definitive criteria/dedupe
  // rejection; see materialDependencies for what this specific decision
  // actually relied on.
  rejection: RejectionCompletenessResult
  // Populated only when a terminal outcome was reached and the fact-
  // finality gate below actually ran against it — the facts materially
  // used by THAT specific decisive path, and whether each is final.
  factFinality?: FactFinalityResult[]
  // Materiality-aware terminalization hardening — an explicit,
  // deterministic trace of which sub-computations this SPECIFIC decision
  // actually depended on. A definitive criteria/dedupe rejection never
  // includes 'rejection_deadline'/'rejection_completeness' — those are
  // only material to an objection-based rejection or to 'qualified'
  // (the strictest path, which depends on everything). See this
  // function's own design note.
  materialDependencies: MaterialDependency[]
}

export type MaterialDependency =
  | 'criteria' | 'dedupe_observation' | 'dedupe_completeness'
  | 'rejection_deadline' | 'rejection_completeness' | 'fact_finality'

// Fact-evidence finality gate (16B.3 contractual-finality hardening,
// item 1) — evaluates finality for exactly the facts materially used by
// the ALREADY-DETERMINED decisive path (never the whole rule's fact
// universe unconditionally: a definitive duplicate/valid-timely-rejection
// never even needed criteria to be satisfied, so criteria's own facts
// were never "materially used" by THAT outcome — see this module's own
// design note on why this is path-specific, not global).
//
// `target` lets a caller check finality against a DIFFERENT candidate's
// own evidence than ctx.candidate — needed for positive-duplicate
// finality (final hardening pass, item 2): evaluateDedupeObservation
// resolves the MATCHED PRIOR candidate's key_fields dynamically (via
// resolveCandidateFact against that prior's own evidence, not some frozen
// identity), so the prior's resolution is exactly as capable of being
// unstable as the current candidate's own — both must be gated.
// evaluateFactFinality itself never reads ctx.candidate (only ctx.rule/
// sourceBindings/coverage/asOf, all job-level and identical for any
// candidate in the same job), so swapping in the target's resolution here
// is sufficient — no other plumbing needed.
function gateOnFactFinality(
  materialFactKeys: string[], ctx: CandidateFinalityContext,
  target?: { candidate: BillableUnitCandidate; evidence: CandidateUnitEvidence[] },
): { blocked: false; finality: FactFinalityResult[] } | { blocked: true; finality: FactFinalityResult[]; blockedReason: string } {
  const candidate = target?.candidate ?? ctx.candidate
  const evidence = target?.evidence ?? ctx.evidence
  const uniqueKeys = Array.from(new Set(materialFactKeys))
  const finality = uniqueKeys.map(factKey => {
    const resolution = resolveCandidateFact({ candidate, rule: ctx.rule, factKey, evidence, sourceBindingRoleKeys: ctx.sourceBindingRoleKeys, asOf: ctx.asOf })
    return evaluateFactFinality({ factKey, resolution, ctx })
  })
  const notFinal = finality.filter(f => f.status !== 'complete')
  if (notFinal.length > 0) {
    return { blocked: true, finality, blockedReason: `${notFinal.length} fact(s) materially used by this decision are not final: ${notFinal.map(f => `${f.factKey} (${f.status})`).join(', ')}` }
  }
  return { blocked: false, finality }
}

// Materiality-aware terminalization (16B.3 final hardening pass) — the
// decision depends ONLY on the sub-computations actually material to the
// SELECTED outcome, never on every input unconditionally. Concretely:
//   - a definitive duplicate (evaluateDedupeObservation already found a
//     match — candidate_discovery COMPLETENESS is irrelevant to a
//     positive match, only to promoting an ABSENCE into 'cleared') is
//     checked, and can reject, BEFORE the rejection deadline is ever
//     touched.
//   - a definitive criteria failure is likewise checked and can reject
//     before the deadline is touched.
//   - only once NEITHER of those fires does this function need to know
//     about objection-based rejection (which DOES need the deadline, to
//     judge timeliness) or 'qualified' (the strictest path, which
//     depends on everything: criteria satisfied, dedupe cleared —
//     WITH coverage, deadline resolved and passed, rejection-source
//     coverage complete, no valid timely objection).
// This mirrors a genuine contractual distinction, not an implementation
// shortcut: "the meeting conclusively failed the attendance floor" is
// true (and provable) independent of whether anyone ever gets around to
// watching for a rejection on it — the SAME reasoning a delivery-
// acceptance, claim-eligibility, or partner-entitlement primitive would
// need later (a conclusively-failed condition should never wait on an
// unrelated finality input).
//
// `rejection` (RejectionCompletenessResult) is still always computed —
// it's pure and side-effect-free, so there's no cost to full
// observability — but its OUTCOME is only ever consulted for the two
// branches that are genuinely material to it (objection-based rejection,
// and 'qualified'). materialDependencies records, per decision, exactly
// which of criteria/dedupe_observation/dedupe_completeness/
// rejection_deadline/rejection_completeness/fact_finality were actually
// relied upon — never a fixed list.
export function evaluateCandidateFinalDecision(ctx: CandidateFinalityContext): CandidateFinalDecision {
  if (ctx.candidate.qualification_rule_id !== ctx.rule.id) {
    throw new Error(`evaluateCandidateFinalDecision: candidate ${ctx.candidate.id} is pinned to rule ${ctx.candidate.qualification_rule_id}, not ${ctx.rule.id} — never evaluate a candidate against a rule it isn't pinned to`)
  }

  const criteria = evaluateCandidateCriteria(ctx)
  const dedupe = evaluateDedupeCompleteness(ctx)

  // ── Fast, materiality-scoped rejections — no deadline/coverage touched ──
  if (dedupe.outcome === 'duplicate') {
    // Positive-duplicate finality (final hardening pass, item 2) —
    // evaluateDedupeObservation resolves BOTH sides of the match
    // dynamically: the current candidate's own key_fields/scope AND the
    // matched PRIOR candidate's key_fields/scope (see
    // resolveKeyFieldValues's two call sites in lib/billable-unit-
    // candidate.ts). Neither side is a frozen/immutable identity — a
    // later-arriving, higher-priority observation could still change
    // EITHER candidate's resolved account.id and invalidate the match —
    // so both must independently satisfy fact-evidence finality before
    // 'duplicate_found' can become a terminal rejection. Discovery-
    // completeness (candidate_discovery coverage) is still never
    // required here — that remains exclusively about promoting an
    // ABSENCE into 'cleared', per evaluateDedupeCompleteness's own logic.
    const dedupeFactKeys = collectDedupeFactKeys(ctx.rule)
    const currentGate = gateOnFactFinality(dedupeFactKeys, ctx)
    const matchedPriorId = dedupe.observation.matchedPriorCandidateId
    const matchedPrior = matchedPriorId ? ctx.priorCandidates.find(p => p.candidate.id === matchedPriorId) : undefined
    const priorGate = matchedPrior
      ? gateOnFactFinality(dedupeFactKeys, ctx, matchedPrior)
      : { blocked: true as const, finality: [] as FactFinalityResult[], blockedReason: `matched prior candidate ${matchedPriorId ?? '(unknown)'} was not found in the supplied priorCandidates set — cannot verify its own fact finality` }
    const combinedFinality = [...currentGate.finality, ...priorGate.finality]
    const deps: MaterialDependency[] = ['dedupe_observation', 'fact_finality']
    if (currentGate.blocked || priorGate.blocked) {
      const reasons = [currentGate.blocked ? currentGate.blockedReason : null, priorGate.blocked ? `matched prior candidate: ${priorGate.blockedReason}` : null].filter((v): v is string => v !== null)
      return { outcome: 'pending', reason: `cannot finalize as rejected — ${reasons.join('; ')}`, criteria: criteria.result, dedupe, rejection: UNCOMPUTED_REJECTION, factFinality: combinedFinality, materialDependencies: deps }
    }
    return { outcome: 'rejected', reason: `rejected: ${dedupe.reason}`, criteria: criteria.result, dedupe, rejection: UNCOMPUTED_REJECTION, factFinality: combinedFinality, materialDependencies: deps }
  }
  if (criteria.result === 'not_satisfied') {
    const gate = gateOnFactFinality(collectMaterialCriteriaFactKeys(criteria), ctx)
    const deps: MaterialDependency[] = ['criteria', 'fact_finality']
    if (gate.blocked) return { outcome: 'pending', reason: `cannot finalize as rejected — ${gate.blockedReason}`, criteria: criteria.result, dedupe, rejection: UNCOMPUTED_REJECTION, factFinality: gate.finality, materialDependencies: deps }
    return { outcome: 'rejected', reason: 'rejected: criteria not_satisfied', criteria: criteria.result, dedupe, rejection: UNCOMPUTED_REJECTION, factFinality: gate.finality, materialDependencies: deps }
  }

  // Neither fast path fired — from here on, objection timeliness and/or
  // full completeness genuinely matter, so (and only so) the deadline is
  // now material.
  const rejection = evaluateRejectionCompleteness(ctx)

  if (rejection.outcome === 'rejected') {
    const materialFacts = rejection.validTimelyRecord?.reasonSubstantiation
      ? collectReasonPredicateMaterialFactKeys(rejection.validTimelyRecord.reasonSubstantiation.predicate, ctx)
      : []
    const gate = gateOnFactFinality(materialFacts, ctx)
    const deps: MaterialDependency[] = ['rejection_deadline', 'rejection_completeness', 'fact_finality']
    if (gate.blocked) return { outcome: 'pending', reason: `cannot finalize as rejected — ${gate.blockedReason}`, criteria: criteria.result, dedupe, rejection, factFinality: gate.finality, materialDependencies: deps }
    return { outcome: 'rejected', reason: `rejected: ${rejection.reason}`, criteria: criteria.result, dedupe, rejection, factFinality: gate.finality, materialDependencies: deps }
  }

  if (criteria.result === 'satisfied' && dedupe.outcome === 'cleared' && rejection.outcome === 'cleared') {
    const materialFacts = [...collectMaterialCriteriaFactKeys(criteria), ...collectDedupeFactKeys(ctx.rule)]
    const gate = gateOnFactFinality(materialFacts, ctx)
    const deps: MaterialDependency[] = ['criteria', 'dedupe_observation', 'dedupe_completeness', 'rejection_deadline', 'rejection_completeness', 'fact_finality']
    if (gate.blocked) return { outcome: 'pending', reason: `cannot finalize as qualified — ${gate.blockedReason}`, criteria: criteria.result, dedupe, rejection, factFinality: gate.finality, materialDependencies: deps }
    return { outcome: 'qualified', reason: 'criteria satisfied, dedupe cleared, and rejection window cleared', criteria: criteria.result, dedupe, rejection, factFinality: gate.finality, materialDependencies: deps }
  }

  const openConditions = [
    criteria.result !== 'satisfied' ? `criteria=${criteria.result}` : null,
    dedupe.outcome !== 'cleared' ? `dedupe=${dedupe.outcome}` : null,
    rejection.outcome !== 'cleared'
      // Surface the SPECIFIC deadline-unresolved reason when that's why
      // rejection never cleared — the single most common way this
      // fallback bucket is reached once criteria/dedupe are otherwise
      // fine, and a generic "rejection=pending" would bury it.
      ? (rejection.deadline.status !== 'resolved' ? `rejection deadline is not resolvable: ${rejection.deadline.reason}` : `rejection=${rejection.outcome}`)
      : null,
  ].filter((v): v is string => v !== null)
  const pendingDeps: MaterialDependency[] = ['criteria', 'dedupe_observation', 'dedupe_completeness', 'rejection_deadline', 'rejection_completeness']
  return { outcome: 'pending', reason: `not yet decidable: ${openConditions.join(', ')}`, criteria: criteria.result, dedupe, rejection, materialDependencies: pendingDeps }
}

// The two fast-reject branches above never need rejection completeness
// (that is the entire point of this hardening pass) but
// CandidateFinalDecision.rejection is a non-optional field for backward-
// compatible observability on every OTHER path. Rather than silently
// computing it anyway (which would quietly reintroduce the exact
// dependency this function exists to avoid — e.g. a candidate whose
// rejection_window is malformed would still fail to evaluate cleanly)
// this returns a clearly-labeled placeholder that was never consulted to
// reach the outcome; materialDependencies is the authoritative record of
// what was actually relied upon, not this field. Callers that need a real
// deadline for persistence (see lib/billable-unit-candidate-finality-
// service.ts) resolve it independently rather than reading this field.
const UNCOMPUTED_REJECTION: RejectionCompletenessResult = {
  outcome: 'pending',
  reason: 'not evaluated — this decision was reached without needing rejection completeness (see materialDependencies)',
  deadline: { status: 'unresolved', reason: 'not evaluated for this decision' },
  validLateRecords: [], invalidRecords: [],
}

// ── Out of scope in this slice (see the 16B.3 brief) ──────────────────────
//
// No qualified-unit billing counts, no usage-meter integration, no
// scheduler/period-hold logic, no pricing-engine linkage, no Invalid
// Meeting Credit linkage, no Stripe/Remembill/partner-payout/revenue-share
// code, and no AI/Bedrock interpretation anywhere in this file. A late
// valid rejection (validLateRecords above) is recorded and returned in the
// trace for a FUTURE Invalid Meeting Credit mechanism to consume — this
// file never wires that connection itself.
