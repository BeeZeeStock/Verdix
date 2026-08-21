// Verdix commercial-decision precedence (Step 3).
//
// Documents, centrally, the order in which competing sources of a
// commercial-rule field's value take priority:
//
//   explicit contract semantics
//        v
//   explicit reviewer decision for this contract
//        v
//   organization rulebook        [future — not implemented]
//        v
//   verdix global rulebook
//        v
//   verdix recommendation
//        v
//   decision required
//
// A Rulebook (today: Verdix Global; later: Organization) may never
// override explicit contract language, and must not silently overwrite an
// explicit reviewer decision. It may only ever fill a slot that is
// currently 'decision_required' — nothing has claimed it yet — or update a
// value it itself previously produced.
//
// Step 3 activates enforcement for only the sources that already exist in
// this codebase — see FIELD_PROVENANCE_TO_DECISION_SOURCE below, which maps
// today's real FieldProvenance values ('contract_derived', 'reviewer_
// policy', 'verdix_recommends') onto this ordering. 'organization_rulebook'
// and 'verdix_global_rulebook' are defined here ONLY so this ordering
// doesn't need to be redesigned later: 'organization_rulebook' because no
// Organization Rulebook exists yet (explicitly out of scope, per Step 3's
// instructions), and 'verdix_global_rulebook' because — even though
// lib/rulebook/rules.ts and lib/rulebook/activation.ts exist — no rule is
// activated at 'resolve_semantic' authority yet (see activation.ts), so
// nothing in this codebase actually produces a value AT this precedence
// level today. isPrecedenceViolation below is a general-purpose pure
// function, usable once either of those two slots is real, but currently
// only ever exercised with the three FieldProvenance-backed sources.
export type CommercialDecisionSource =
  | 'explicit_contract_semantics'
  | 'explicit_reviewer_decision'
  | 'organization_rulebook'
  | 'verdix_global_rulebook'
  | 'verdix_recommendation'
  | 'decision_required'

// Highest precedence first.
export const COMMERCIAL_DECISION_PRECEDENCE: readonly CommercialDecisionSource[] = [
  'explicit_contract_semantics',
  'explicit_reviewer_decision',
  'organization_rulebook',
  'verdix_global_rulebook',
  'verdix_recommendation',
  'decision_required',
]

// How today's real FieldProvenance values (lib/types.ts) map onto this
// ordering. This mapping documents WHY, in precedence terms,
// isProvenanceResolved() (lib/commercial-rule-status.ts) treats
// 'contract_derived' and 'reviewer_policy' as resolved and
// 'verdix_recommends' as not — it does not change that gate, and nothing
// here is wired into it. The canonical resolved/unresolved gate remains
// isProvenanceResolved alone.
export const FIELD_PROVENANCE_TO_DECISION_SOURCE: Record<'contract_derived' | 'reviewer_policy' | 'verdix_recommends', CommercialDecisionSource> = {
  contract_derived: 'explicit_contract_semantics',
  reviewer_policy: 'explicit_reviewer_decision',
  verdix_recommends: 'verdix_recommendation',
}

// True when attemptedSource is NOT permitted to silently override a value
// already established at existingSource's precedence — i.e. attemptedSource
// is STRICTLY lower precedence than existingSource. Filling a genuinely
// empty slot ('decision_required') is always allowed, from any source. A
// source updating its OWN prior value (equal precedence) is also allowed —
// e.g. a reviewer revising their own earlier reviewer_policy decision, or
// the Rulebook re-running and updating its own prior finding — precedence
// is about cross-source overrides, not same-source revision.
export function isPrecedenceViolation(existingSource: CommercialDecisionSource, attemptedSource: CommercialDecisionSource): boolean {
  if (existingSource === 'decision_required') return false
  const existingRank = COMMERCIAL_DECISION_PRECEDENCE.indexOf(existingSource)
  const attemptedRank = COMMERCIAL_DECISION_PRECEDENCE.indexOf(attemptedSource)
  return attemptedRank > existingRank
}
