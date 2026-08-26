// Billable Unit Qualification — Step 16B.1: rule model, readiness, and
// reviewer-confirmation semantics only. Deliberately does NOT implement
// candidates, evidence ingestion, business-day arithmetic, source
// coverage, actual criteria evaluation, dedupe execution, or anything
// meter/billing-facing — see the design notes at the bottom of this file
// for what's explicitly deferred to 16B.2/16B.3/16B.4.
//
// Reuses existing Verdix vocabulary rather than inventing parallel
// semantics: ProposalState (lib/rule-interpretation.ts) and FieldProvenance
// (lib/types.ts) are used verbatim, and isFieldDecisionResolved below is a
// thin wrapper over the EXISTING isProvenanceResolved (lib/commercial-rule-
// status.ts) — no new "is this resolved" logic, just applied at the
// per-field granularity this rule type needs.
import type { ProposalState } from './rule-interpretation'
import type { FieldProvenance } from './types'
import { isProvenanceResolved } from './commercial-rule-status'

// ── FieldDecision<T> ─────────────────────────────────────────────────────
//
// The smallest reusable shape separating VALUE from CONFIDENCE (state) from
// AUTHORITY (provenance) — see this module's own design history for why a
// flat "provenance-only" or "value-only" field cannot represent readiness:
// a decision_required field must never appear authoritative merely because
// a value happens to be populated (e.g. a verdix_recommends guess sitting
// in `value`), and confirming one field must never be inferable from, or
// bleed into, another field's state.
//
// provenance is `null` for EVERY field until an explicit reviewer action —
// including a 'clear_from_source' field — matching this codebase's
// standing HITL discipline (CLAUDE.md: "AI confidence is not provenance");
// nothing here bypasses the review gate every other commercial rule already
// goes through. Once acted on:
//   - state 'clear_from_source', reviewer accepts as-is -> provenance 'contract_derived'
//   - state 'verdix_recommends',  reviewer accepts the recommendation -> provenance 'reviewer_policy'
//     (never 'contract_derived' — accepting a recommendation is still an
//     affirmative reviewer act; 'verdix_recommends' can never resolve
//     passively, per isProvenanceResolved's own exclusion of it)
//   - state 'decision_required',  reviewer supplies a value -> provenance 'reviewer_policy'
//   - any explicit override (regardless of prior state) -> provenance 'reviewer_policy'
export interface FieldDecision<T> {
  value: T | null
  state: ProposalState
  provenance: FieldProvenance | null
}

export function isFieldDecisionResolved<T>(decision: FieldDecision<T>): boolean {
  return isProvenanceResolved(decision.provenance)
}

// ── Qualification expressions — bounded Boolean composition ────────────
//
// Independent of lib/rulebook/organization-rules.ts's MatchOperator/
// MatchCondition on purpose (design decision, not an oversight): that type
// is scoped and already reviewed for organization-policy matching only
// ("add an operator only when a real Rulebook scenario needs one" is that
// file's own stated discipline) — qualification criteria are a different
// domain (operational evidence thresholds) with genuinely different
// operator needs (gte/lte for numeric criteria like attendance minutes),
// and widening the Rulebook's own operator set was never asked for and
// isn't justified by this domain's needs.
export type QualificationOperator = 'eq' | 'in' | 'exists' | 'gte' | 'lte'

export interface QualificationCondition {
  field: string
  operator: QualificationOperator
  value?: unknown
}

// No `not` — nothing in the approved OS-2026-09 fixture needs exclusion
// logic, and it isn't justified by a concrete fixture (same "smallest
// primitive justified by evidence" discipline as everywhere else in this
// design). No eval, no expression strings, no scripts, no per-contract
// code — exactly these three closed shapes.
export type QualificationExpression =
  | { kind: 'condition'; condition: QualificationCondition }
  | { kind: 'all_of'; expressions: QualificationExpression[] }
  | { kind: 'any_of'; expressions: QualificationExpression[] }

export const MAX_QUALIFICATION_EXPRESSION_DEPTH = 2

// depth of a leaf `condition` is 0; an all_of/any_of wrapping only
// conditions is depth 1; nesting one further all_of/any_of inside that is
// depth 2 (the approved bound). AND is associative, so a rule author
// should flatten sibling conditions into one all_of rather than nesting
// unnecessarily — see this module's OS-2026-09 fixture (in the test file)
// for a worked example of flattening to stay within the bound.
export function computeQualificationExpressionDepth(expr: QualificationExpression): number {
  if (expr.kind === 'condition') return 0
  if (expr.expressions.length === 0) return 1
  return 1 + Math.max(...expr.expressions.map(computeQualificationExpressionDepth))
}

// ── Fact schema — bounded evidence vocabulary ───────────────────────────
export type QualificationFactType = 'string' | 'number' | 'boolean' | 'timestamp' | 'enum'

// No ambient "now" anywhere in this module. Every fact that can vary over
// time must declare which contractual moment it's evaluated as of — see
// the OS-2026-09 fixture for how booked_at vs occurred_at is assigned per
// fact, straight from the source text (§2.1–§3.3, Schedule 1).
export type FreshnessReferenceTime = 'booked_at' | 'occurred_at' | 'attribution_at' | 'finality_deadline'

export interface QualificationFactDefinition {
  type: QualificationFactType
  enumValues?: string[]
  reference_time: FreshnessReferenceTime
}

export interface QualificationValidationError {
  path: string
  reason: string
}

// Strict, whitelist-only validation — same discipline as
// lib/billability-condition.ts's parseBillabilityCondition ("returns null/
// an error for anything that doesn't match exactly," never a permissive
// passthrough). A condition may only reference a declared fact_schema key,
// and gte/lte are only meaningful against number/timestamp facts.
export function validateQualificationCondition(
  condition: QualificationCondition,
  factSchema: Record<string, QualificationFactDefinition>,
): QualificationValidationError[] {
  const errors: QualificationValidationError[] = []
  const fact = factSchema[condition.field]
  if (!fact) {
    errors.push({ path: condition.field, reason: `references undeclared fact_schema key '${condition.field}'` })
    return errors
  }
  if ((condition.operator === 'gte' || condition.operator === 'lte') && fact.type !== 'number' && fact.type !== 'timestamp') {
    errors.push({ path: condition.field, reason: `operator '${condition.operator}' requires a number or timestamp fact; '${condition.field}' is '${fact.type}'` })
  }
  if (fact.type === 'enum' && fact.enumValues) {
    const candidateValues = condition.operator === 'in' && Array.isArray(condition.value) ? condition.value
      : condition.operator === 'eq' ? [condition.value]
      : []
    for (const v of candidateValues) {
      if (typeof v === 'string' && !fact.enumValues.includes(v)) {
        errors.push({ path: condition.field, reason: `value '${v}' is not a declared enum value for '${condition.field}'` })
      }
    }
  }
  return errors
}

export function validateQualificationExpression(
  expr: QualificationExpression,
  factSchema: Record<string, QualificationFactDefinition>,
): QualificationValidationError[] {
  const errors: QualificationValidationError[] = []
  const depth = computeQualificationExpressionDepth(expr)
  if (depth > MAX_QUALIFICATION_EXPRESSION_DEPTH) {
    errors.push({ path: '$', reason: `expression nesting depth ${depth} exceeds the maximum of ${MAX_QUALIFICATION_EXPRESSION_DEPTH}` })
  }
  const walk = (e: QualificationExpression): void => {
    if (e.kind === 'condition') {
      errors.push(...validateQualificationCondition(e.condition, factSchema))
    } else {
      for (const child of e.expressions) walk(child)
    }
  }
  walk(expr)
  return errors
}

// ── Dedupe ───────────────────────────────────────────────────────────────
export interface DedupeRule {
  key_fields: string[]
  lookback: { days: number; unit: 'calendar' | 'business' }
  // Narrows which prior candidates participate in dedup comparison at all
  // (e.g. "supplier-sourced meetings only" for a different contract). Reuses
  // QualificationCondition rather than a second filter language. Empty for
  // OS-2026-09 — every candidate in this system is Supplier-sourced by
  // definition (§2.3), so no filter is needed for this contract specifically.
  scope: QualificationCondition[]
}

// ── Rejection ────────────────────────────────────────────────────────────
export type RejectionEmailException = 'candidate_level_reviewer_override' | 'none'
export type LateRejectionBehavior = 'ignored_for_initial_qualification'

export interface RejectionRule {
  valid_reasons: string[]
  valid_channels: string[]        // source_role role_keys, e.g. ['crm', 'portal']
  requires_timestamp: boolean
  requires_identification: boolean
  email_alone_valid: boolean
  email_exception: RejectionEmailException
  late_rejection_behavior: LateRejectionBehavior
}

// ── Evidence precedence ───────────────────────────────────────────────────
// reference_time is deliberately NOT carried on the strategy itself — it
// lives once, canonically, on the fact's own QualificationFactDefinition
// (reused by both condition evaluation and freshness math in 16B.2), so the
// two can never disagree about which contractual moment governs a fact.
export type EvidencePrecedenceStrategy =
  | { kind: 'authoritative_source'; source: string }
  | { kind: 'source_precedence'; order: string[] }
  | { kind: 'authoritative_if_fresh_else_latest'; source: string; freshness_window_days: number }

// ── Rejection window / finality calendar ─────────────────────────────────
export interface RejectionWindowCalendar {
  business_days: number
  holiday_calendar: string   // jurisdiction identifier, e.g. 'SE-stockholm'
  timezone: string           // IANA identifier, e.g. 'Europe/Stockholm'
}

// Kept as an INDEPENDENT FieldDecision from RejectionWindowCalendar (not a
// sub-property of it) — the calendar facts (business_days/holiday_calendar/
// timezone) can be fully contract_derived while this specific convention is
// genuinely unstated. Bundling them into one FieldDecision would force them
// to share one state/provenance, which cannot represent "three explicit
// facts plus one open question" simultaneously — a real inconsistency
// caught and fixed during this implementation pass.
export type DeadlineConvention = 'same_clock_time' | 'end_of_business_day'

export type AttributionBasis = 'occurred_at' | 'booked_at' | 'qualified_at'

// ── Qualified Contact — mixed-authority split ────────────────────────────
//
// The contract's own "...or an equivalent role" opening is the ONLY reason
// this split exists — checked against every other closed list in the
// OS-2026-09 fixture (geography, business category, rejection reasons,
// dedupe scope) and none of them has a similar textual opening, so this
// pattern is applied exactly once here, not speculatively everywhere.
export interface QualifiedContactRoleDecision {
  // The six named roles from source text — contract_derived once confirmed.
  base: FieldDecision<QualificationCondition>
  // Reviewer-curated additions for "an equivalent role with material
  // responsibility" — starts empty (a complete, valid, non-blocking state:
  // "no exceptions granted yet"), grows independently over time, and is
  // NEVER folded into `base` — adding an entry here can never make the six
  // contract-derived roles look reviewer-authored, and vice versa.
  // Deliberately excluded from rule readiness (see isQualificationRuleReady).
  extensions: FieldDecision<string[]>
  // Pre-commit hardening audit (16B.2) — names an OPTIONAL fact_schema key
  // (a boolean fact) that, when resolved true for a specific candidate,
  // ALSO satisfies this check, independent of base/extensions. This is
  // configuration, not evaluator logic: lib/billable-unit-candidate.ts's
  // evaluateCandidateCriteria composes it as one more any_of leaf
  // condition and has NO special knowledge of what the key represents or
  // why a rule author chose it — it only ever understands condition/
  // all_of/any_of/resolved facts, same as everywhere else in this
  // evaluator. This is how a candidate-specific reviewer judgment (e.g.
  // "this attendee's title satisfies the contract's equivalent-role
  // language") gets represented WITHOUT rewriting the factual contact
  // role and WITHOUT mutating `extensions` (a reusable, rule-level list)
  // for a one-off case — see OS-2026-09's own fixture for a worked
  // example. null = this rule has no such mechanism configured (the
  // common case — most contracts have no "or equivalent role" language at
  // all). Included in rule readiness (unlike extensions) because,
  // resolved or not, WHETHER a rule supports this mechanism and WHICH key
  // it points to is itself a real commercial decision that must go
  // through the same provenance discipline as every other field here —
  // never silently defaulted.
  attestation_fact_key: FieldDecision<string | null>
}

// ── The rule itself ───────────────────────────────────────────────────────
export interface BillableUnitQualificationRule {
  id: string
  job_id: string
  org_id: string
  unit_type: string
  fact_schema: Record<string, QualificationFactDefinition>

  // Target-Account-cluster + attendance criteria, flattened into one
  // expression tree (AND is associative — see MAX_QUALIFICATION_EXPRESSION_
  // DEPTH's own comment). Qualified Contact's role check is deliberately
  // NOT inlined here — it lives in qualified_contact_role below, split for
  // mixed-authority reasons; how the two combine into one evaluable
  // expression is a 16B.2 evaluator concern, not a 16B.1 data-model concern.
  criteria: FieldDecision<QualificationExpression>
  qualified_contact_role: QualifiedContactRoleDecision

  dedupe_rule: FieldDecision<DedupeRule>
  rejection_rule: FieldDecision<RejectionRule>
  rejection_window: FieldDecision<RejectionWindowCalendar>
  deadline_convention: FieldDecision<DeadlineConvention>
  attribution_basis: FieldDecision<AttributionBasis>
  evidence_precedence: Record<string, FieldDecision<EvidencePrecedenceStrategy>>

  // field path -> VERBATIM (or lightly-paraphrased) quoted clause text,
  // one or more per field. Deliberately NOT ContractTerms.field_sources's
  // heading-lookup convention (a single section-heading string, resolved
  // later via lib/contract-extractor.ts's extractSectionClause against a
  // re-fetched copy of the raw document): that mechanism only resolves at
  // TOP-LEVEL heading granularity (its own boundary regex matches "2." but
  // not "2.1"/"2.5") and degrades to null on any mismatch — not precise or
  // reliable enough for qualification-rule fields, which routinely need
  // sub-clause precision (criteria grounded in §2.1+§2.3, rejection_rule
  // in §2.5, rejection_window in §2.7 — all under the SAME top-level "2."
  // heading, which the heading mechanism cannot tell apart) and, per the
  // pre-commit hardening audit, "one field may reference multiple
  // clauses" — a single Record<string,string> string cannot represent
  // that at all.
  //
  // Instead reuses this codebase's much more common source_clause
  // convention (ServiceCredit.source_clause, OneTimeFee.source_clause,
  // etc. — verbatim text captured directly at extraction time, no further
  // resolution step, no dependency on re-matching against a live
  // document), just pluralized per field. The stored string IS the
  // immutable source evidence — self-contained, always resolvable, never
  // requiring a lookup that can silently degrade to null.
  //
  // Populated once at extraction/rule-authoring time; a reviewer
  // confirmation NEVER writes to this map (see confirmQualificationRuleField
  // below) — a reviewer decision may reference the original source but
  // must never rewrite it. A field with no entry here (deadline_convention,
  // attribution_basis, the unstated evidence_precedence entries) has no
  // source clause backing it, by construction — the absence itself is
  // meaningful. Model reasoning (an AI's own explanatory text) is never
  // stored here — only text the extractor asserts is actually quoted from
  // the agreement.
  field_sources: Record<string, string[]>

  version: number

  // Activation TOCTOU hardening — an optimistic-concurrency counter,
  // DISTINCT from `version` above: `version` identifies which contractual
  // amendment lineage this row belongs to (supersession/versioning);
  // `revision` counts edits to THIS one row while it's still a draft.
  // Starts at 1. Every semantic write to a draft rule (each confirmation
  // path — an ordinary top-level field, a qualified_contact_role
  // sub-field, an evidence_precedence sub-key) increments it atomically
  // as part of the SAME database write, never as a separate step (see
  // lib/billable-unit-qualification-service.ts's confirm* functions and
  // the confirm_qualification_rule_field/set_qualification_rule_*
  // RPCs — supabase/migrations/20260830000007_billable_unit_qualification.sql).
  // Activation itself never increments it — activating doesn't change a
  // rule's semantic content, only its status. The activation flow reads
  // this value, validates readiness/source-roles against it, and passes
  // it back to the activation RPC as `expected_revision`: if anything
  // changed the row between the read and the atomic activation attempt,
  // the RPC's revision check fails closed rather than activating a rule
  // different from the one that was actually validated.
  revision: number

  supersedes_rule_id: string | null
  effective_from: string
  effective_to: string | null
  status: 'draft' | 'active' | 'superseded'
  created_at?: string
  updated_at?: string
}

// ── Readiness — derived, never persisted ─────────────────────────────────
//
// Deliberately not a stored boolean anywhere (no requires_confirmation
// column on the table) — this is the ONE function that computes it, so it
// can never drift from the underlying field decisions the way two
// independently-hand-maintained flags could.
export function isQualificationRuleReady(rule: BillableUnitQualificationRule): boolean {
  if (!isFieldDecisionResolved(rule.criteria)) return false
  if (!isFieldDecisionResolved(rule.qualified_contact_role.base)) return false
  // qualified_contact_role.extensions is deliberately NOT checked — an
  // empty or partially-populated extensions list never blocks readiness.
  if (!isFieldDecisionResolved(rule.qualified_contact_role.attestation_fact_key)) return false
  if (!isFieldDecisionResolved(rule.dedupe_rule)) return false
  if (!isFieldDecisionResolved(rule.rejection_rule)) return false
  if (!isFieldDecisionResolved(rule.rejection_window)) return false
  if (!isFieldDecisionResolved(rule.deadline_convention)) return false
  if (!isFieldDecisionResolved(rule.attribution_basis)) return false
  for (const decision of Object.values(rule.evidence_precedence)) {
    if (!isFieldDecisionResolved(decision)) return false
  }
  return true
}

// ── Reviewer confirmation ─────────────────────────────────────────────────
export interface ConfirmFieldDecisionInput<T> {
  // Present -> the reviewer is choosing/overriding a value explicitly,
  // regardless of the field's current state -> always 'reviewer_policy'.
  // Absent -> the reviewer is accepting the CURRENT value as proposed,
  // which only means something for 'clear_from_source' (-> contract_derived)
  // and 'verdix_recommends' (-> reviewer_policy, never contract_derived —
  // see this module's FieldDecision comment). A 'decision_required' field
  // has nothing to accept and must be called with an explicit overrideValue.
  overrideValue?: T
}

export function confirmFieldDecision<T>(
  decision: FieldDecision<T>,
  input: ConfirmFieldDecisionInput<T> = {},
): FieldDecision<T> {
  if (input.overrideValue !== undefined) {
    return { value: input.overrideValue, state: decision.state, provenance: 'reviewer_policy' }
  }
  if (decision.state === 'clear_from_source') {
    return { ...decision, provenance: 'contract_derived' }
  }
  if (decision.state === 'verdix_recommends') {
    return { ...decision, provenance: 'reviewer_policy' }
  }
  throw new Error('confirmFieldDecision: a decision_required field cannot be confirmed without an explicit overrideValue')
}

// One string per confirmable field on the rule — every path a reviewer
// action can target, and no others. evidence_precedence's dynamic keys are
// addressed via the 'evidence_precedence.<factKey>' template.
export type QualificationRuleFieldPath =
  | 'criteria'
  | 'qualified_contact_role.base'
  | 'qualified_contact_role.extensions'
  | 'qualified_contact_role.attestation_fact_key'
  | 'dedupe_rule'
  | 'rejection_rule'
  | 'rejection_window'
  | 'deadline_convention'
  | 'attribution_basis'
  | `evidence_precedence.${string}`

// Confirms EXACTLY one named field and returns a new rule object — every
// other field's FieldDecision is referentially untouched. This is what
// makes "confirming deadline_convention must not change provenance of
// criteria" hold structurally, not just by convention: each branch below
// shallow-copies `rule` and replaces only the one targeted key.
//
// Pre-commit hardening audit — once a rule is 'active', its commercial
// meaning is immutable: neither the six named Qualified Contact roles nor
// any other field decision may be changed in place, including growing
// qualified_contact_role.extensions. A genuine change (a reviewer decides
// "Chief Growth Officer" should count as an equivalent role going
// forward, or any other reusable reinterpretation) must go through
// createSuccessorDraft + activateQualificationRuleSuccessor
// (lib/billable-unit-qualification-service.ts) — a new versioned rule
// with its own effective_from, activated only once ready, never a
// rewrite of the active row. This check is deliberately duplicated at
// the service layer's own draft-status guard (defense in depth: this
// pure function is directly callable/testable on its own, so it must not
// rely solely on a caller remembering the guard).
export function confirmQualificationRuleField(
  rule: BillableUnitQualificationRule,
  fieldPath: QualificationRuleFieldPath,
  overrideValue?: unknown,
): BillableUnitQualificationRule {
  if (rule.status !== 'draft') {
    throw new Error(`confirmQualificationRuleField: rule ${rule.id} is '${rule.status}', not 'draft' — an active rule's commercial meaning is immutable; use createSuccessorDraft/activateQualificationRuleSuccessor to create a new version instead`)
  }
  if (fieldPath === 'criteria') {
    return { ...rule, criteria: confirmFieldDecision(rule.criteria, { overrideValue: overrideValue as QualificationExpression | undefined }) }
  }
  if (fieldPath === 'qualified_contact_role.base') {
    return {
      ...rule,
      qualified_contact_role: {
        ...rule.qualified_contact_role,
        base: confirmFieldDecision(rule.qualified_contact_role.base, { overrideValue: overrideValue as QualificationCondition | undefined }),
      },
    }
  }
  if (fieldPath === 'qualified_contact_role.extensions') {
    return {
      ...rule,
      qualified_contact_role: {
        ...rule.qualified_contact_role,
        extensions: confirmFieldDecision(rule.qualified_contact_role.extensions, { overrideValue: overrideValue as string[] | undefined }),
      },
    }
  }
  if (fieldPath === 'qualified_contact_role.attestation_fact_key') {
    return {
      ...rule,
      qualified_contact_role: {
        ...rule.qualified_contact_role,
        attestation_fact_key: confirmFieldDecision(rule.qualified_contact_role.attestation_fact_key, { overrideValue: overrideValue as string | null | undefined }),
      },
    }
  }
  if (fieldPath === 'dedupe_rule') {
    return { ...rule, dedupe_rule: confirmFieldDecision(rule.dedupe_rule, { overrideValue: overrideValue as DedupeRule | undefined }) }
  }
  if (fieldPath === 'rejection_rule') {
    return { ...rule, rejection_rule: confirmFieldDecision(rule.rejection_rule, { overrideValue: overrideValue as RejectionRule | undefined }) }
  }
  if (fieldPath === 'rejection_window') {
    return { ...rule, rejection_window: confirmFieldDecision(rule.rejection_window, { overrideValue: overrideValue as RejectionWindowCalendar | undefined }) }
  }
  if (fieldPath === 'deadline_convention') {
    return { ...rule, deadline_convention: confirmFieldDecision(rule.deadline_convention, { overrideValue: overrideValue as DeadlineConvention | undefined }) }
  }
  if (fieldPath === 'attribution_basis') {
    return { ...rule, attribution_basis: confirmFieldDecision(rule.attribution_basis, { overrideValue: overrideValue as AttributionBasis | undefined }) }
  }
  if (fieldPath.startsWith('evidence_precedence.')) {
    const key = fieldPath.slice('evidence_precedence.'.length)
    const existing = rule.evidence_precedence[key]
    if (!existing) throw new Error(`confirmQualificationRuleField: unknown evidence_precedence key '${key}'`)
    return {
      ...rule,
      evidence_precedence: {
        ...rule.evidence_precedence,
        [key]: confirmFieldDecision(existing, { overrideValue: overrideValue as EvidencePrecedenceStrategy | undefined }),
      },
    }
  }
  throw new Error(`confirmQualificationRuleField: unrecognized field path '${fieldPath}'`)
}

// ── Source-role reference extraction (activation-time validation) ───────
//
// The only two places a role_key can appear inside a rule: rejection_rule's
// valid_channels, and an evidence_precedence strategy's source/order.
// criteria/dedupe_rule/qualified_contact_role reference FACT keys
// (fact_schema), never source roles. Deliberately a pure, deterministic
// extraction — the actual "is this role_key registered for this job"
// check needs a database read (source_roles), so it lives in the service
// layer (lib/billable-unit-qualification-service.ts); this function only
// answers "what role_keys does this rule's data actually reference,"
// which requires no I/O.
export function extractReferencedSourceRoleKeys(rule: BillableUnitQualificationRule): string[] {
  const keys = new Set<string>()
  const rejectionRule = rule.rejection_rule.value
  if (rejectionRule) {
    for (const channel of rejectionRule.valid_channels) keys.add(channel)
  }
  for (const decision of Object.values(rule.evidence_precedence)) {
    const strategy = decision.value
    if (!strategy) continue
    if (strategy.kind === 'authoritative_source' || strategy.kind === 'authoritative_if_fresh_else_latest') {
      keys.add(strategy.source)
    } else if (strategy.kind === 'source_precedence') {
      for (const source of strategy.order) keys.add(source)
    }
  }
  return Array.from(keys)
}

// ── Fact-reference completeness (activation-time validation) ────────────
//
// Pre-commit hardening audit (16B.2) — the OS-2026-09 fixture exposed a
// genuine production invariant that was never checked: dedupe_rule named
// key_fields: ['account.id'], but 'account.id' was never declared in
// fact_schema, and 16B.1 had no validator that would have caught this
// (validateQualificationExpression only walks the CRITERIA expression
// tree — it has no visibility into dedupe_rule, qualified_contact_role,
// or evidence_precedence at all). A rule can reach 'active' with a
// dedupe/precedence/contact-role field that no fact_schema entry backs,
// and 16B.2's resolveCandidateFact would then fail at CANDIDATE
// EVALUATION time instead of at RULE ACTIVATION time — exactly the kind
// of latent, activation-time-catchable defect this function exists to
// close.
//
// Deliberately pure and structural, same shape as
// validateQualificationExpression (no I/O, no database) — every field
// slot an EXECUTABLE rule can reference (16B.2's evaluator actually
// dereferences these against fact_schema at runtime) is checked here:
// criteria conditions, qualified_contact_role.base's condition (16B.2's
// evaluator resolves this exactly like a criteria leaf — see
// lib/billable-unit-candidate.ts's evaluateCandidateCriteria),
// dedupe_rule.key_fields, dedupe_rule.scope conditions, and every
// evidence_precedence key. Unlike source-role references
// (extractReferencedSourceRoleKeys/assertReferencedSourceRolesRegistered,
// which need a per-job database read), fact_schema membership is fully
// determined by the rule's own data — no reason this needs a DB round
// trip, so unlike source-role checking it stays entirely in this pure
// module and is called directly from the service layer's activation
// preconditions rather than needing its own async wrapper.
//
// evidence_precedence keys are checked STRICTLY against fact_schema — no
// exception for a non-field-scoped "general default" placeholder. (An
// earlier fixture had one such placeholder, 'icp_contact_default'; per
// explicit product decision it was removed from the canonical OS-2026-09
// fixture and replaced with fact-scoped entries for the actual affected
// facts — see lib/os-2026-09-fixture.ts.)
export interface QualificationRuleFieldReferenceError { path: string; reason: string }

export function validateQualificationRuleFieldReferences(rule: BillableUnitQualificationRule): QualificationRuleFieldReferenceError[] {
  const errors: QualificationRuleFieldReferenceError[] = []

  if (rule.criteria.value) {
    for (const e of validateQualificationExpression(rule.criteria.value, rule.fact_schema)) {
      errors.push({ path: `criteria.${e.path}`, reason: e.reason })
    }
  }

  const roleCondition = rule.qualified_contact_role.base.value
  if (roleCondition) {
    for (const e of validateQualificationCondition(roleCondition, rule.fact_schema)) {
      errors.push({ path: `qualified_contact_role.base.${e.path}`, reason: e.reason })
    }
  }

  // null is valid (no reviewer-attestation alternate path configured).
  // When set, evaluateCandidateCriteria composes it as `field == true`
  // (lib/billable-unit-candidate.ts) — so the referenced fact must exist
  // AND be declared boolean; anything else would be a condition that can
  // never meaningfully evaluate to the eq-true check it's actually run
  // through.
  const attestationFactKey = rule.qualified_contact_role.attestation_fact_key.value
  if (attestationFactKey) {
    const attestationFact = rule.fact_schema[attestationFactKey]
    if (!attestationFact) {
      errors.push({ path: 'qualified_contact_role.attestation_fact_key', reason: `references undeclared fact_schema key '${attestationFactKey}'` })
    } else if (attestationFact.type !== 'boolean') {
      errors.push({ path: 'qualified_contact_role.attestation_fact_key', reason: `references fact_schema key '${attestationFactKey}' of type '${attestationFact.type}', but the attestation condition is evaluated as 'field == true' and requires a 'boolean' fact` })
    }
  }

  const dedupe = rule.dedupe_rule.value
  if (dedupe) {
    for (const key of dedupe.key_fields) {
      if (!rule.fact_schema[key]) {
        errors.push({ path: `dedupe_rule.key_fields.${key}`, reason: `references undeclared fact_schema key '${key}'` })
      }
    }
    for (const condition of dedupe.scope) {
      for (const e of validateQualificationCondition(condition, rule.fact_schema)) {
        errors.push({ path: `dedupe_rule.scope.${e.path}`, reason: e.reason })
      }
    }
  }

  for (const key of Object.keys(rule.evidence_precedence)) {
    if (!rule.fact_schema[key]) {
      errors.push({ path: `evidence_precedence.${key}`, reason: `references undeclared fact_schema key '${key}'` })
    }
  }

  return errors
}

// ── Deferred design notes (NOT implemented in this slice) ────────────────
//
// 16B.3 TODO — SourceCoverage (not implemented here) must include an
// evidence-ESTABLISHMENT timestamp, e.g. `established_at`, distinct from
// the covered_from/covered_through interval itself. Historical evaluation
// may use a coverage assertion only when `established_at <= billingAsOf` —
// otherwise a coverage row created/extended AFTER the historical asOf being
// replayed could leak future knowledge into that replay (the same
// "asOf must not time-travel" invariant already enforced on
// BillableUnitCandidate.decided_at applies equally to coverage proofs, and
// needs its own timestamp to enforce). Recorded here as a note for 16B.3's
// design, not implemented — SourceCoverage does not exist yet.
