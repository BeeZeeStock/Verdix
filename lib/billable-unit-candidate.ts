// Billable Unit Qualification — Step 16B.2: candidate, evidence, and the
// deterministic evaluator layer between an operational event and a
// terminal billing decision.
//
// Preserves 16B.1's rule/provenance/versioning model exactly (lib/
// billable-unit-qualification.ts is never redesigned here, only consumed).
// This slice implements:
//   operational candidate -> pinned rule version -> structured evidence
//   -> deterministic evidence resolution -> provisional evaluation
// and deliberately stops there — see "Deferred design notes" at the
// bottom of this file for what 16B.3/16B.4 own instead.
import {
  isFieldDecisionResolved,
  type BillableUnitQualificationRule, type QualificationExpression, type QualificationCondition,
  type QualificationFactDefinition, type EvidencePrecedenceStrategy, type FreshnessReferenceTime,
} from './billable-unit-qualification'

// ── BillableUnitCandidate ────────────────────────────────────────────────
//
// status/rejection_deadline/decided_at were constrained to exactly their
// 16B.2 values by the 16B.2 migration's own check constraints; Step 16B.3
// widened those same columns (supabase/migrations/
// 20260827000009_billable_unit_candidate_finality.sql) to the full
// pending/qualified/rejected lifecycle, still enforced at the database
// level — decided_at/rejection_deadline populated iff status is terminal,
// and terminal once set is immutable (see that migration's own comment).
// The one allowed transition (pending -> qualified | rejected) happens
// ONLY through finalize_billable_unit_candidate (lib/billable-unit-
// candidate-finality-service.ts) — never a plain application-level UPDATE.
export interface BillableUnitCandidateExternalIdentity {
  source_binding_id: string
  external_id: string
}

export type BillableUnitCandidateStatus = 'pending' | 'qualified' | 'rejected'

export interface BillableUnitCandidate {
  id: string
  job_id: string
  org_id: string
  unit_type: string

  external_identity: BillableUnitCandidateExternalIdentity

  booked_at: string | null
  occurred_at: string | null
  attribution_at: string

  qualification_rule_id: string
  qualification_rule_version: number

  rejection_deadline: string | null
  status: BillableUnitCandidateStatus
  decided_at: string | null

  created_at?: string
}

// ── CandidateUnitEvidence ────────────────────────────────────────────────
//
// Append/revoke, never in-place mutation of `facts` — see the migration's
// own comment on candidate_unit_evidence. A "correction" is always a new
// row plus a revocation of the old one, never an UPDATE of facts.
export interface CandidateUnitEvidence {
  id: string
  candidate_id: string
  job_id: string
  org_id: string
  source_binding_id: string

  facts: Record<string, unknown>

  occurred_at: string
  recorded_at: string
  recorded_by: string

  status: 'active' | 'revoked'
  revoked_at: string | null
  revoked_by: string | null

  created_at?: string
}

// ── Evidence fact validation (write-time gate) ───────────────────────────
//
// Strict, whitelist-only — same discipline as
// validateQualificationCondition in lib/billable-unit-qualification.ts.
// `facts` is normally a PARTIAL set (one evidence row rarely reports every
// fact_schema key), so only keys actually PRESENT in `facts` are checked;
// a key's absence is never an error here (it just means this fact isn't
// resolvable from this particular evidence row).
export interface EvidenceFactValidationError { path: string; reason: string }

export function validateEvidenceFacts(
  facts: Record<string, unknown>,
  factSchema: Record<string, QualificationFactDefinition>,
): EvidenceFactValidationError[] {
  const errors: EvidenceFactValidationError[] = []
  for (const [key, value] of Object.entries(facts)) {
    const def = factSchema[key]
    if (!def) {
      errors.push({ path: key, reason: `references undeclared fact_schema key '${key}'` })
      continue
    }
    switch (def.type) {
      case 'string':
        if (typeof value !== 'string') errors.push({ path: key, reason: `expected a string, got ${typeof value}` })
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push({ path: key, reason: `expected a finite number, got ${JSON.stringify(value)}` })
        break
      case 'boolean':
        if (typeof value !== 'boolean') errors.push({ path: key, reason: `expected a boolean, got ${typeof value}` })
        break
      case 'timestamp':
        if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) errors.push({ path: key, reason: `expected a valid ISO timestamp string, got ${JSON.stringify(value)}` })
        break
      case 'enum':
        if (typeof value !== 'string' || !(def.enumValues ?? []).includes(value)) errors.push({ path: key, reason: `value ${JSON.stringify(value)} is not a declared enum value for '${key}'` })
        break
    }
  }
  return errors
}

// ── Historical evidence safety — asOf visibility ─────────────────────────
//
// A row is usable at asOf iff it was ALREADY RECORDED by asOf and NOT YET
// REVOKED as of asOf — evidence revoked on 10 Sep is still correctly
// visible when replaying asOf 5 Sep. Deliberately does not look at the
// row's CURRENT status at all — "revoked" today does not erase what an
// earlier asOf legitimately saw. This is the one predicate every fact
// resolution/criteria/dedupe function below filters through; there is no
// other path to "is this evidence usable."
export function isEvidenceActiveAsOf(evidence: CandidateUnitEvidence, asOf: string): boolean {
  const recordedAt = new Date(evidence.recorded_at).getTime()
  const asOfMs = new Date(asOf).getTime()
  if (recordedAt > asOfMs) return false
  if (evidence.revoked_at === null) return true
  return new Date(evidence.revoked_at).getTime() > asOfMs
}

// ── Rule-version pinning (candidate creation only) ───────────────────────
//
// The subtle dependency the brief calls out: attribution_at depends on
// rule.attribution_basis, and rule-version SELECTION depends on
// attribution_at. Resolved by trying each candidate rule version on its
// OWN terms — deriving attribution_at from THAT version's resolved
// attribution_basis, then checking whether that self-derived timestamp
// actually falls inside that same version's effective range. This is not
// a fixed-point search (there is no iteration) — it is a bounded
// self-consistency check across a finite, already-known list of rule
// versions, which is exactly why "zero matches" and "more than one match"
// are both real, fail-closed outcomes rather than edge cases to paper
// over: a rule amendment that changes attribution_basis can, in
// principle, make a candidate's booked_at and occurred_at diverge across
// the version boundary in a way that is genuinely ambiguous, and this
// must never be resolved by guessing.
//
// candidateRuleVersions is expected to be every active/superseded row for
// the candidate's (job_id, unit_type) — draft rows are silently ignored
// here (a draft was never validated ready and can never govern a
// candidate). Every active/superseded row is guaranteed ready by
// construction (activateQualificationRule/activateQualificationRuleSuccessor
// both hard-enforce isQualificationRuleReady before the status transition,
// and an active rule's fields are immutable) — this function still
// defensively skips any row whose attribution_basis isn't resolved,
// rather than assuming that invariant can never be violated.
export type PinQualificationRuleVersionResult =
  | { status: 'pinned'; ruleId: string; ruleVersion: number; attribution_at: string }
  | { status: 'no_match'; reason: string }
  | { status: 'ambiguous'; reason: string; matches: Array<{ ruleId: string; ruleVersion: number; attribution_at: string }> }

export function pinQualificationRuleVersion(
  candidateRawTimes: { booked_at: string | null; occurred_at: string | null },
  candidateRuleVersions: BillableUnitQualificationRule[],
): PinQualificationRuleVersionResult {
  const matches: Array<{ rule: BillableUnitQualificationRule; attribution_at: string }> = []
  const consideredBases: Array<'occurred_at' | 'booked_at' | 'qualified_at'> = []

  for (const rule of candidateRuleVersions) {
    if (rule.status !== 'active' && rule.status !== 'superseded') continue
    if (!isFieldDecisionResolved(rule.attribution_basis) || rule.attribution_basis.value === null) continue

    const basis = rule.attribution_basis.value
    consideredBases.push(basis)
    const candidateAttributionAt =
      basis === 'occurred_at' ? candidateRawTimes.occurred_at :
      basis === 'booked_at' ? candidateRawTimes.booked_at :
      // 'qualified_at' cannot be derived before a terminal decision exists
      // (16B.3 owns that) — this rule version simply cannot
      // self-consistently match a candidate in 16B.2, which is correct:
      // it is not an error, just a version this slice can never pin to.
      null

    if (candidateAttributionAt === null) continue

    const from = new Date(rule.effective_from).getTime()
    const to = rule.effective_to === null ? Infinity : new Date(rule.effective_to).getTime()
    const at = new Date(candidateAttributionAt).getTime()
    if (at >= from && at < to) matches.push({ rule, attribution_at: candidateAttributionAt })
  }

  if (matches.length === 0) {
    // A more specific, actionable reason for the one sub-case that isn't
    // really "unmatched" so much as "not yet supported": every version
    // this candidate could possibly have pinned to uses attribution_basis
    // 'qualified_at', which 16B.2 structurally cannot derive (a pending
    // candidate has no terminal decision yet). Distinguishing this from
    // the generic "no version covers this time range" case matters — the
    // fix for one is "wait for 16B.3," the fix for the other is "check
    // the rule's effective ranges."
    if (consideredBases.length > 0 && consideredBases.every(b => b === 'qualified_at')) {
      return {
        status: 'no_match',
        reason: "unsupported: every candidate rule version's attribution_basis is 'qualified_at', which cannot be derived before a terminal qualification decision exists (16B.3) — pinning is unavailable for this candidate until then, not merely unmatched",
      }
    }
    return { status: 'no_match', reason: 'no active/superseded rule version self-consistently governs this candidate for its derivable attribution time(s)' }
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      reason: `${matches.length} rule versions self-consistently match this candidate — refusing to pick arbitrarily`,
      matches: matches.map(m => ({ ruleId: m.rule.id, ruleVersion: m.rule.version, attribution_at: m.attribution_at })),
    }
  }
  return { status: 'pinned', ruleId: matches[0].rule.id, ruleVersion: matches[0].rule.version, attribution_at: matches[0].attribution_at }
}

// ── Deterministic fact resolution ────────────────────────────────────────

export interface FactResolutionAlternative {
  evidenceId: string
  sourceRoleKey: string
  sourceBindingId: string
  occurredAt: string
  value: unknown
}

export type FactResolutionOutcome =
  | {
      status: 'resolved'
      value: unknown
      evidenceId: string
      sourceRoleKey: string
      sourceBindingId: string
      referenceTime: string
      reason: string
      consideredAlternatives: FactResolutionAlternative[]
    }
  | {
      status: 'unresolved'
      reason: string
      referenceTime: string | null
      consideredAlternatives: FactResolutionAlternative[]
    }

function referenceTimeForFact(candidate: BillableUnitCandidate, kind: FreshnessReferenceTime): string | null {
  switch (kind) {
    case 'booked_at': return candidate.booked_at
    case 'occurred_at': return candidate.occurred_at
    case 'attribution_at': return candidate.attribution_at
    // Populated only once a terminal decision has been recorded (16B.3's
    // finalize_billable_unit_candidate) — a fact anchored to
    // finality_deadline on a still-pending candidate correctly resolves
    // to 'unresolved' here, not an error.
    case 'finality_deadline': return candidate.rejection_deadline
  }
}

// No ambient clock, no model call, no free-text interpretation — every
// input is caller-supplied (evidence, asOf, the role-key lookup), so this
// function is pure and trivially reproducible.
//
// Point-in-time discipline applies uniformly, BEFORE any precedence
// strategy runs: for each source, only that source's observation
// at-or-nearest-before the fact's contractual reference timestamp is even
// a candidate — a later re-snapshot from the same source is invisible to
// a booking-anchored fact no matter how the strategy is configured (Case
// E in the fixture tests this directly).
export function resolveCandidateFact(params: {
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  factKey: string
  evidence: CandidateUnitEvidence[]
  sourceBindingRoleKeys: Map<string, string>
  asOf: string
}): FactResolutionOutcome {
  const { candidate, rule, factKey, evidence, sourceBindingRoleKeys, asOf } = params
  const factDef = rule.fact_schema[factKey]
  if (!factDef) {
    return { status: 'unresolved', reason: `fact_schema has no declaration for '${factKey}'`, referenceTime: null, consideredAlternatives: [] }
  }

  const referenceTime = referenceTimeForFact(candidate, factDef.reference_time)
  if (referenceTime === null) {
    return { status: 'unresolved', reason: `reference_time '${factDef.reference_time}' is not available on this candidate in 16B.2`, referenceTime: null, consideredAlternatives: [] }
  }

  const relevantEvidence = evidence.filter(e =>
    e.candidate_id === candidate.id &&
    isEvidenceActiveAsOf(e, asOf) &&
    Object.prototype.hasOwnProperty.call(e.facts, factKey),
  )

  const bySource = new Map<string, CandidateUnitEvidence[]>()
  for (const e of relevantEvidence) {
    const roleKey = sourceBindingRoleKeys.get(e.source_binding_id)
    if (!roleKey) continue
    const list = bySource.get(roleKey) ?? []
    list.push(e)
    bySource.set(roleKey, list)
  }

  const refMs = new Date(referenceTime).getTime()
  const nearestBeforeBySource = new Map<string, CandidateUnitEvidence>()
  // Sources whose OWN nearest-before observation is itself ambiguous —
  // two-or-more active, equally-eligible rows tied for nearest with
  // conflicting values. Never resolved by array/insertion order (Array
  // .sort is stable, so a naive "sort then take [0]" would silently pick
  // whichever tied row happened to appear first in the input) — tracked
  // separately so the precedence strategy below can fail closed with a
  // real conflict signal instead of silently treating the source as
  // absent (which would let a lower-priority source win unnoticed).
  const perSourceConflicts = new Set<string>()
  for (const [roleKey, list] of bySource) {
    const eligible = list.filter(e => new Date(e.occurred_at).getTime() <= refMs)
    if (eligible.length === 0) continue
    let maxMs = -Infinity
    for (const e of eligible) {
      const ms = new Date(e.occurred_at).getTime()
      if (ms > maxMs) maxMs = ms
    }
    const tiedForNearest = eligible.filter(e => new Date(e.occurred_at).getTime() === maxMs)
    const distinctValues = new Set(tiedForNearest.map(e => JSON.stringify(e.facts[factKey])))
    if (distinctValues.size > 1) {
      perSourceConflicts.add(roleKey)
      continue
    }
    nearestBeforeBySource.set(roleKey, tiedForNearest[0])
  }

  // Scope boundary: `alternatives` is built only from sources WITHOUT a
  // same-time internal conflict, so a conflicted source never enters
  // authoritative_if_fresh_else_latest's cross-source "freshest reliable
  // source" fallback pool either — that fallback can only ever pick among
  // sources that were themselves unambiguous. The strategy-level checks
  // below (sameSourceConflictOutcome) cover the case explicitly asked
  // for: a conflict on the source a strategy would actually consult by
  // name/priority position.
  const alternatives: FactResolutionAlternative[] = Array.from(nearestBeforeBySource.entries()).map(([roleKey, e]) => ({
    evidenceId: e.id, sourceRoleKey: roleKey, sourceBindingId: e.source_binding_id, occurredAt: e.occurred_at, value: e.facts[factKey],
  }))

  if (nearestBeforeBySource.size === 0 && perSourceConflicts.size === 0) {
    return { status: 'unresolved', reason: `no evidence observation at-or-before ${referenceTime} was found for '${factKey}'`, referenceTime, consideredAlternatives: [] }
  }

  const strategyDecision = rule.evidence_precedence[factKey]
  const strategy = strategyDecision && isFieldDecisionResolved(strategyDecision) ? strategyDecision.value : null

  return applyEvidencePrecedenceStrategy({ strategy: strategy ?? null, nearestBeforeBySource, perSourceConflicts, alternatives, referenceTime, factKey })
}

// Implements exactly the three closed, already-approved strategies — no
// scripts/eval/custom expressions. Every branch returns full trace
// information (chosen evidence id, chosen source, reference time,
// considered alternatives, why the strategy picked this value) and NEVER
// picks arbitrarily between conflicting candidates — a genuine,
// deterministically-undecidable conflict always returns 'unresolved'.
//
// perSourceConflicts (a source whose own two active, equally-eligible
// observations disagree) is checked EXPLICITLY at the point each
// strategy would have consulted that source — never silently treated as
// "source absent," which would let a strategy quietly fall through to a
// lower-priority source and mask the conflict entirely.
function applyEvidencePrecedenceStrategy(params: {
  strategy: EvidencePrecedenceStrategy | null
  nearestBeforeBySource: Map<string, CandidateUnitEvidence>
  perSourceConflicts: Set<string>
  alternatives: FactResolutionAlternative[]
  referenceTime: string
  factKey: string
}): FactResolutionOutcome {
  const { strategy, nearestBeforeBySource, perSourceConflicts, alternatives, referenceTime, factKey } = params

  const sameSourceConflictOutcome = (roleKey: string): FactResolutionOutcome => ({
    status: 'unresolved',
    reason: `source '${roleKey}' has multiple active evidence rows tied for the nearest-eligible observation of '${factKey}' with conflicting values at the same point in time — cannot resolve without a deterministic tiebreaker`,
    referenceTime, consideredAlternatives: alternatives,
  })

  if (strategy === null) {
    // No evidence_precedence entry configured for this fact (most
    // fact_schema keys in a real contract have none — only the facts a
    // contract actually calls out a conflict rule for get an entry). The
    // implicit default: agreement-only. All eligible sources agreeing is
    // unambiguous; disagreement with no configured tiebreaker must return
    // unresolved, never an arbitrary pick. A source with an internal
    // same-time conflict can never count as "agreeing," so it forces
    // unresolved too.
    if (perSourceConflicts.size > 0) {
      return sameSourceConflictOutcome([...perSourceConflicts][0])
    }
    const distinctValues = new Set(alternatives.map(a => JSON.stringify(a.value)))
    if (distinctValues.size === 1) {
      const chosen = alternatives[0]
      return { status: 'resolved', value: chosen.value, evidenceId: chosen.evidenceId, sourceRoleKey: chosen.sourceRoleKey, sourceBindingId: chosen.sourceBindingId, referenceTime, reason: `no evidence_precedence configured for '${factKey}'; all ${alternatives.length} source(s) agree`, consideredAlternatives: alternatives }
    }
    return { status: 'unresolved', reason: `no evidence_precedence configured for '${factKey}' and sources disagree (${distinctValues.size} distinct values) — cannot resolve without a configured strategy`, referenceTime, consideredAlternatives: alternatives }
  }

  if (strategy.kind === 'authoritative_source') {
    if (perSourceConflicts.has(strategy.source)) return sameSourceConflictOutcome(strategy.source)
    const chosen = nearestBeforeBySource.get(strategy.source)
    if (!chosen) {
      return { status: 'unresolved', reason: `authoritative_source '${strategy.source}' has no eligible observation at-or-before ${referenceTime}`, referenceTime, consideredAlternatives: alternatives }
    }
    return { status: 'resolved', value: chosen.facts[factKey], evidenceId: chosen.id, sourceRoleKey: strategy.source, sourceBindingId: chosen.source_binding_id, referenceTime, reason: `authoritative_source '${strategy.source}'`, consideredAlternatives: alternatives }
  }

  if (strategy.kind === 'source_precedence') {
    // §3.2's exact shape: the first source in order with an eligible
    // observation wins outright — a lower-priority source's conflicting
    // value is never even compared, it simply never gets consulted (Case
    // D: conferencing controls whenever present; calendar is only used
    // when conferencing is absent, not "when they conflict"). A
    // same-source conflict is checked at the moment that source would
    // have been consulted — never skipped as if merely absent, since a
    // lower-priority source silently winning would hide the conflict.
    for (const roleKey of strategy.order) {
      if (perSourceConflicts.has(roleKey)) return sameSourceConflictOutcome(roleKey)
      const chosen = nearestBeforeBySource.get(roleKey)
      if (chosen) {
        return { status: 'resolved', value: chosen.facts[factKey], evidenceId: chosen.id, sourceRoleKey: roleKey, sourceBindingId: chosen.source_binding_id, referenceTime, reason: `source_precedence: '${roleKey}' is the highest-priority source with an eligible observation (order: ${strategy.order.join(' > ')})`, consideredAlternatives: alternatives }
      }
    }
    return { status: 'unresolved', reason: `none of the source_precedence order [${strategy.order.join(', ')}] has an eligible observation at-or-before ${referenceTime}`, referenceTime, consideredAlternatives: alternatives }
  }

  // authoritative_if_fresh_else_latest
  if (perSourceConflicts.has(strategy.source)) return sameSourceConflictOutcome(strategy.source)
  const authoritative = nearestBeforeBySource.get(strategy.source)
  if (authoritative) {
    const ageDays = (new Date(referenceTime).getTime() - new Date(authoritative.occurred_at).getTime()) / 86_400_000
    if (ageDays <= strategy.freshness_window_days) {
      return { status: 'resolved', value: authoritative.facts[factKey], evidenceId: authoritative.id, sourceRoleKey: strategy.source, sourceBindingId: authoritative.source_binding_id, referenceTime, reason: `authoritative_if_fresh_else_latest: '${strategy.source}' is fresh (${ageDays.toFixed(1)}d <= ${strategy.freshness_window_days}d window)`, consideredAlternatives: alternatives }
    }
  }
  // "the most recent reliable source" — across ALL sources, still
  // point-in-time constrained (never a future observation, since
  // `alternatives` was already filtered to at-or-before referenceTime).
  let freshest: FactResolutionAlternative[] = []
  let freshestMs = -Infinity
  for (const alt of alternatives) {
    const ms = new Date(alt.occurredAt).getTime()
    if (ms > freshestMs) { freshestMs = ms; freshest = [alt] }
    else if (ms === freshestMs) freshest.push(alt)
  }
  if (freshest.length === 0) {
    return { status: 'unresolved', reason: `authoritative_if_fresh_else_latest: '${strategy.source}' is stale or absent, and no other source has any eligible observation`, referenceTime, consideredAlternatives: alternatives }
  }
  const distinctFreshestValues = new Set(freshest.map(a => JSON.stringify(a.value)))
  if (distinctFreshestValues.size > 1) {
    // Explicit tie semantics: two-or-more sources share the single
    // freshest occurred_at but disagree on value — never pick arbitrarily.
    return { status: 'unresolved', reason: `authoritative_if_fresh_else_latest: '${strategy.source}' is stale/absent, and ${freshest.length} sources tie for most-recent observation with conflicting values — cannot resolve without a deterministic tiebreaker`, referenceTime, consideredAlternatives: alternatives }
  }
  const chosen = freshest[0]
  return { status: 'resolved', value: chosen.value, evidenceId: chosen.evidenceId, sourceRoleKey: chosen.sourceRoleKey, sourceBindingId: chosen.sourceBindingId, referenceTime, reason: `authoritative_if_fresh_else_latest: '${strategy.source}' is stale/absent; '${chosen.sourceRoleKey}' is the most recent reliable source`, consideredAlternatives: alternatives }
}

// ── Tri-state criteria evaluation ────────────────────────────────────────

export type TriState = 'satisfied' | 'not_satisfied' | 'unknown'

export interface LeafEvaluationTrace {
  kind: 'condition'
  condition: QualificationCondition
  result: TriState
  resolution: FactResolutionOutcome
}
export interface CompositeEvaluationTrace {
  kind: 'all_of' | 'any_of'
  result: TriState
  children: EvaluationTrace[]
}
export type EvaluationTrace = LeafEvaluationTrace | CompositeEvaluationTrace

function toComparable(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = new Date(v).getTime()
    return Number.isNaN(t) ? null : t
  }
  return null
}

// 'exists' deliberately never returns 'not_satisfied': the absence of
// evidence proves only that nothing was observed, not that the fact is
// affirmatively false — that is honestly 'unknown', not a positive claim.
function evaluateCondition(condition: QualificationCondition, resolution: FactResolutionOutcome): TriState {
  if (condition.operator === 'exists') {
    return resolution.status === 'resolved' ? 'satisfied' : 'unknown'
  }
  if (resolution.status !== 'resolved') return 'unknown'
  const value = resolution.value
  switch (condition.operator) {
    case 'eq': return value === condition.value ? 'satisfied' : 'not_satisfied'
    case 'in': return Array.isArray(condition.value) && (condition.value as unknown[]).includes(value) ? 'satisfied' : 'not_satisfied'
    case 'gte': {
      const a = toComparable(value); const b = toComparable(condition.value)
      if (a === null || b === null) return 'unknown'
      return a >= b ? 'satisfied' : 'not_satisfied'
    }
    case 'lte': {
      const a = toComparable(value); const b = toComparable(condition.value)
      if (a === null || b === null) return 'unknown'
      return a <= b ? 'satisfied' : 'not_satisfied'
    }
  }
}

function combineAllOf(results: TriState[]): TriState {
  if (results.some(r => r === 'not_satisfied')) return 'not_satisfied'
  if (results.some(r => r === 'unknown')) return 'unknown'
  return 'satisfied'
}
function combineAnyOf(results: TriState[]): TriState {
  if (results.some(r => r === 'satisfied')) return 'satisfied'
  if (results.some(r => r === 'unknown')) return 'unknown'
  return 'not_satisfied'
}

export function evaluateQualificationExpression(params: {
  expr: QualificationExpression
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  evidence: CandidateUnitEvidence[]
  sourceBindingRoleKeys: Map<string, string>
  asOf: string
}): { result: TriState; trace: EvaluationTrace } {
  const { expr } = params
  if (expr.kind === 'condition') {
    const resolution = resolveCandidateFact({
      candidate: params.candidate, rule: params.rule, factKey: expr.condition.field,
      evidence: params.evidence, sourceBindingRoleKeys: params.sourceBindingRoleKeys, asOf: params.asOf,
    })
    const result = evaluateCondition(expr.condition, resolution)
    return { result, trace: { kind: 'condition', condition: expr.condition, result, resolution } }
  }
  const children = expr.expressions.map(child => evaluateQualificationExpression({ ...params, expr: child }))
  const result = expr.kind === 'all_of' ? combineAllOf(children.map(c => c.result)) : combineAnyOf(children.map(c => c.result))
  return { result, trace: { kind: expr.kind, result, children: children.map(c => c.trace) } }
}

// qualified_contact_role's mixed authority (16B.1's own design note: base
// is contract_derived, extensions is reviewer-curated) is NOT inlined
// into rule.criteria — this is the "16B.2 evaluator concern" that type's
// comment explicitly defers to here. extensions widens the SAME
// field/operator's acceptable values; it is not a second, independent
// condition — only 'in'/'eq' bases are meaningful to widen this way.
function combineQualifiedContactRoleCondition(base: QualificationCondition, extensions: string[]): QualificationCondition {
  if (base.operator === 'in' && Array.isArray(base.value)) {
    return { field: base.field, operator: 'in', value: [...(base.value as unknown[]), ...extensions] }
  }
  if (base.operator === 'eq') {
    return { field: base.field, operator: 'in', value: [base.value, ...extensions] }
  }
  throw new Error(`combineQualifiedContactRoleCondition: base operator '${base.operator}' cannot be combined with extensions — only 'in'/'eq' are supported`)
}

// Pre-commit hardening audit (16B.2, revised) — Case F semantic fix,
// generalized. A reviewer judging "this specific attendee's title,
// though not one of the six named roles, satisfies §2.2's 'or an
// equivalent role' provision for THIS candidate" is a per-candidate
// commercial judgment, not a factual observation — it must never be
// represented by rewriting/canonicalizing the factually-reported
// contact.role value (that would merge factual evidence with commercial
// interpretation, and permanently falsify the audit trail), and it must
// never mutate qualified_contact_role.extensions (a REUSABLE, rule-level
// list — a one-off candidate judgment is not a standing interpretation
// that should apply to every future candidate too).
//
// This evaluator has NO special knowledge of "Qualified Contact,"
// "equivalent role," attestation, or any other SQM-specific concept — it
// only ever understands condition/all_of/any_of/resolved facts, exactly
// like every other expression it evaluates. The optional extra condition
// is pure RULE CONFIGURATION:
// rule.qualified_contact_role.attestation_fact_key names a fact_schema
// key (declared by the rule author, meaning whatever they intend it to
// mean) that, when resolved true for a candidate, ALSO satisfies this
// check. When unset (the common case — most contracts have no "or
// equivalent role" language), the check is exactly 16B.1's original
// base-∪-extensions-only condition, unchanged. When set, it's composed
// via the SAME any_of tri-state machinery used everywhere else — the
// "attestation" is just one more leaf condition, structurally
// indistinguishable to this function from any other fact reference.
export interface CandidateCriteriaEvaluation {
  result: TriState
  criteriaTrace: EvaluationTrace
  qualifiedContactRoleTrace: EvaluationTrace
}

export function evaluateCandidateCriteria(params: {
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  evidence: CandidateUnitEvidence[]
  sourceBindingRoleKeys: Map<string, string>
  asOf: string
}): CandidateCriteriaEvaluation {
  const { rule } = params
  if (!rule.criteria.value) throw new Error('evaluateCandidateCriteria: rule.criteria has no resolved expression')
  const criteriaEval = evaluateQualificationExpression({ ...params, expr: rule.criteria.value })

  const baseCondition = rule.qualified_contact_role.base.value
  if (!baseCondition) throw new Error('evaluateCandidateCriteria: rule.qualified_contact_role.base has no resolved condition')
  const extensions = rule.qualified_contact_role.extensions.value ?? []
  const combinedRoleCondition = combineQualifiedContactRoleCondition(baseCondition, extensions)
  const roleLeaf: QualificationExpression = { kind: 'condition', condition: combinedRoleCondition }

  const attestationFactKey = isFieldDecisionResolved(rule.qualified_contact_role.attestation_fact_key)
    ? rule.qualified_contact_role.attestation_fact_key.value
    : null
  const roleExpr: QualificationExpression = attestationFactKey
    ? { kind: 'any_of', expressions: [roleLeaf, { kind: 'condition', condition: { field: attestationFactKey, operator: 'eq', value: true } }] }
    : roleLeaf
  const roleEval = evaluateQualificationExpression({ ...params, expr: roleExpr })

  return {
    result: combineAllOf([criteriaEval.result, roleEval.result]),
    criteriaTrace: criteriaEval.trace,
    qualifiedContactRoleTrace: roleEval.trace,
  }
}

// ── Dedupe — observation only, never a completeness proof ───────────────
//
// 16B.2 implements only the deterministic POSITIVE side of DedupeRule:
// scanning the currently-persisted candidate set for a match is real
// evidence of a duplicate when found, but finding none is NOT proof no
// duplicate exists — that requires SourceCoverage (16B.3) establishing
// that historical discovery for the relevant window is actually complete.
// 'no_known_duplicate' must never be silently promoted to "dedupe
// satisfied" anywhere in this file or its callers.
export type DedupeObservationStatus = 'duplicate_found' | 'no_known_duplicate' | 'unknown'

export interface DedupeObservationTrace {
  status: DedupeObservationStatus
  reason: string
  keyFieldValues?: Record<string, unknown>
  matchedPriorCandidateId?: string
  consideredPriorCandidateIds: string[]
}

function resolveKeyFieldValues(
  candidate: BillableUnitCandidate, rule: BillableUnitQualificationRule, evidence: CandidateUnitEvidence[],
  sourceBindingRoleKeys: Map<string, string>, asOf: string, keyFields: string[],
): Record<string, unknown> | null {
  const values: Record<string, unknown> = {}
  for (const key of keyFields) {
    const resolution = resolveCandidateFact({ candidate, rule, factKey: key, evidence, sourceBindingRoleKeys, asOf })
    if (resolution.status !== 'resolved') return null
    values[key] = resolution.value
  }
  return values
}

function keyValuesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

export function evaluateDedupeObservation(params: {
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  evidence: CandidateUnitEvidence[]
  priorCandidates: Array<{ candidate: BillableUnitCandidate; evidence: CandidateUnitEvidence[] }>
  sourceBindingRoleKeys: Map<string, string>
  asOf: string
}): DedupeObservationTrace {
  const { candidate, rule, evidence, priorCandidates, sourceBindingRoleKeys, asOf } = params
  const dedupeRule = rule.dedupe_rule.value
  if (!dedupeRule) throw new Error('evaluateDedupeObservation: rule.dedupe_rule has no resolved value')
  if (dedupeRule.lookback.unit === 'business') {
    // Business-day lookback needs holiday-calendar arithmetic —
    // explicitly out of scope for 16B.2 (see the rejection_window/
    // business-day items deferred to 16B.3). Fails closed rather than
    // silently treating business days as calendar days.
    throw new Error('evaluateDedupeObservation: business-day lookback requires holiday-calendar arithmetic, which is explicitly deferred to 16B.3 — not implemented in 16B.2')
  }

  const currentKeyValues = resolveKeyFieldValues(candidate, rule, evidence, sourceBindingRoleKeys, asOf, dedupeRule.key_fields)
  if (currentKeyValues === null) {
    return { status: 'unknown', reason: "this candidate's own dedupe key_fields could not all be resolved as of the evaluation time — cannot search for duplicates without them", consideredPriorCandidateIds: [] }
  }

  const lookbackMs = dedupeRule.lookback.days * 86_400_000
  const currentAttributionMs = new Date(candidate.attribution_at).getTime()
  const considered: string[] = []

  for (const prior of priorCandidates) {
    if (prior.candidate.id === candidate.id) continue
    if (prior.candidate.job_id !== candidate.job_id || prior.candidate.unit_type !== candidate.unit_type) continue
    const priorAttributionMs = new Date(prior.candidate.attribution_at).getTime()
    if (!(priorAttributionMs < currentAttributionMs)) continue
    if (!(priorAttributionMs >= currentAttributionMs - lookbackMs)) continue

    considered.push(prior.candidate.id)

    const priorKeyValues = resolveKeyFieldValues(prior.candidate, rule, prior.evidence, sourceBindingRoleKeys, asOf, dedupeRule.key_fields)
    if (priorKeyValues === null) continue // an unresolved prior can never count as POSITIVE duplicate evidence
    if (!keyValuesEqual(currentKeyValues, priorKeyValues)) continue

    if (dedupeRule.scope.length > 0) {
      const scopeSatisfied = dedupeRule.scope.every(cond => {
        const resolution = resolveCandidateFact({ candidate: prior.candidate, rule, factKey: cond.field, evidence: prior.evidence, sourceBindingRoleKeys, asOf })
        return evaluateCondition(cond, resolution) === 'satisfied'
      })
      if (!scopeSatisfied) continue
    }

    return {
      status: 'duplicate_found',
      reason: `prior candidate ${prior.candidate.id} matches dedupe key_fields within the ${dedupeRule.lookback.days}-day lookback and satisfies scope`,
      keyFieldValues: currentKeyValues, matchedPriorCandidateId: prior.candidate.id, consideredPriorCandidateIds: considered,
    }
  }

  return {
    status: 'no_known_duplicate',
    reason: 'no persisted prior candidate matched dedupe key_fields/lookback/scope — this is NOT proof of completeness; SourceCoverage (16B.3) is required before this can support a dedupe-satisfied determination',
    keyFieldValues: currentKeyValues, consideredPriorCandidateIds: considered,
  }
}

// ── Provisional candidate evaluation — read-only, never terminal ────────
//
// Never returns qualified/billable/rejected and never mutates candidate —
// 16B.3 owns terminal finality (business-day rejection-window closure,
// SourceCoverage-backed completeness, and the actual status/decided_at
// transition). This function's entire contract is: given a snapshot of
// evidence as of some point in time, what does it currently show.
export interface CandidateEvidenceSnapshot {
  candidate_id: string
  rule_id: string
  rule_version: number
  evaluated_as_of: string
  criteria_status: TriState
  criteria_trace: { criteria: EvaluationTrace; qualified_contact_role: EvaluationTrace }
  dedupe_observation: DedupeObservationStatus
  dedupe_trace: DedupeObservationTrace
  unresolved_facts: string[]
  conflicts: string[]
}

export function evaluateCandidateEvidenceSnapshot(params: {
  candidate: BillableUnitCandidate
  rule: BillableUnitQualificationRule
  evidence: CandidateUnitEvidence[]
  priorCandidates: Array<{ candidate: BillableUnitCandidate; evidence: CandidateUnitEvidence[] }>
  sourceBindingRoleKeys: Map<string, string>
  asOf: string
}): CandidateEvidenceSnapshot {
  if (params.candidate.qualification_rule_id !== params.rule.id) {
    throw new Error(`evaluateCandidateEvidenceSnapshot: candidate ${params.candidate.id} is pinned to rule ${params.candidate.qualification_rule_id}, not ${params.rule.id} — never evaluate a candidate against a rule it isn't pinned to`)
  }
  const criteria = evaluateCandidateCriteria(params)
  const dedupe = evaluateDedupeObservation(params)

  const unresolvedFacts: string[] = []
  const conflicts: string[] = []
  const collectFromTrace = (trace: EvaluationTrace): void => {
    if (trace.kind === 'condition') {
      if (trace.resolution.status === 'unresolved') {
        if (/disagree|conflicting|tie/i.test(trace.resolution.reason)) conflicts.push(trace.condition.field)
        else unresolvedFacts.push(trace.condition.field)
      }
    } else {
      trace.children.forEach(collectFromTrace)
    }
  }
  collectFromTrace(criteria.criteriaTrace)
  collectFromTrace(criteria.qualifiedContactRoleTrace)

  return {
    candidate_id: params.candidate.id,
    rule_id: params.rule.id,
    rule_version: params.rule.version,
    evaluated_as_of: params.asOf,
    criteria_status: criteria.result,
    criteria_trace: { criteria: criteria.criteriaTrace, qualified_contact_role: criteria.qualifiedContactRoleTrace },
    dedupe_observation: dedupe.status,
    dedupe_trace: dedupe,
    unresolved_facts: Array.from(new Set(unresolvedFacts)),
    conflicts: Array.from(new Set(conflicts)),
  }
}

// ── Deferred design notes ─────────────────────────────────────────────────
//
// 16B.3 implemented SourceCoverage/completeness (lib/source-coverage.ts),
// business-day/holiday-calendar deadline arithmetic (lib/business-days.ts),
// rejection evidence + completeness, and the terminal pending ->
// qualified/rejected transition — see lib/billable-unit-candidate-
// finality.ts (pure evaluator, built strictly ON TOP of this file's
// evaluateCandidateCriteria/evaluateDedupeObservation, neither of which
// this file itself changed) and lib/billable-unit-candidate-finality-
// service.ts (the one atomic transition). evaluateDedupeObservation's
// 'no_known_duplicate' in THIS file is still never equivalent to "no
// duplicate exists" on its own — that remains true; 16B.3's completeness
// layer is what's allowed to combine it with coverage to reach a real
// dedupe-cleared conclusion, never this file. The 'business' dedupe
// lookback unit above still throws — no OS-2026-09 case needs it, and
// business-day arithmetic now existing elsewhere (lib/business-days.ts)
// doesn't by itself justify wiring it into dedupe lookback without a
// concrete fixture need.
//
// 16B.4 TODO — computeQualifiedUnitCount, usage-pull integration,
// scheduler changes, and wiring terminal qualified units into the meter
// all depend on 16B.3's terminal decision existing first.
