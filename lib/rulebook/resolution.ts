// Verdix rule resolution, authority & precedence (Step 4).
//
// Pure, shadow-mode architecture for how competing sources of a commercial
// field's value will eventually coexist: explicit contract semantics,
// contract-specific reviewer decisions, a future private Organization
// Rulebook, the Verdix Global Rulebook, and Verdix recommendations. Step 4
// does NOT let any of this fill production commercial fields, does NOT
// create Organization Rulebook storage, and does NOT change invoice
// calculation or readiness. resolveFieldAuthority is exercised only by
// tests/commercial-semantics/rulebook/resolution.test.ts and by future
// steps this one deliberately does not build yet.
//
// No production route handler or page imports this module.

// --- Authority vs. method -----------------------------------------------
//
// AUTHORITY answers "whose decision counts, and how much": the precedence
// tier a value's source occupies. This is a superset of today's real
// FieldProvenance ('contract_derived' | 'reviewer_policy' |
// 'verdix_recommends', lib/types.ts) — Step 4 does not touch that
// persisted union; it just gives the shadow resolution domain two slots
// FieldProvenance doesn't have yet ('organization_rulebook',
// 'verdix_rulebook'), for architecture purposes only.
//
// METHOD answers a different question: "how was this specific value
// actually produced" — which is NOT the same axis as authority. The
// canonical illustration:
//   Contract explicitly says "next invoice", Verdix Rulebook deterministically
//   interprets that clause -> authority: contract_derived, method: verdix_rulebook
//   (the CONTRACT is why this is authoritative; the Rulebook is merely HOW
//   Verdix arrived at the normalized value)
//
//   Contract is silent, Verdix has an out-of-box default
//   -> authority: verdix_rulebook, method: verdix_rulebook
//   (here the Rulebook is BOTH why it counts and how it was produced,
//   because nothing higher-precedence supplied an answer)
//
// Conflating the two would make it impossible to ever say "the Rulebook
// helped read the contract" without that also silently downgrading the
// resulting value's authority to "just a Rulebook default" — which is
// exactly the confusion this split exists to prevent.
export type ResolutionAuthority =
  | 'contract_derived'
  | 'reviewer_policy'
  | 'organization_rulebook'
  | 'verdix_rulebook'
  | 'verdix_recommends'

export type ResolutionMethod =
  | 'existing_normalized_state'
  | 'verdix_rulebook'
  | 'organization_rulebook'
  | 'reviewer'
  | 'ai_recommendation'

// Describes future POLICY overrideability for a default/candidate value —
// deliberately NOT a mechanism for expressing structural invariants (e.g.
// "all-units cannot execute as graduated" is not a commercial policy
// choice at all, it's a fact about what a normalized rule MEANS). That
// class of constraint is enforced entirely by the existing Step 3
// activation layer — resolveVerdixRulebookActivation's execution-target
// violations and evaluateFieldPromotion's promotion-target denials — and
// deliberately has NO representation here; see resolveFieldAuthority's own
// comment for why a second invariant-precedence mechanism inside the field
// resolver would be wrong. 'organization_overrideable' is the ordinary
// case — it needs no special resolver handling at all, since normal
// precedence (organization_rulebook outranks verdix_rulebook) already
// gives an organization the ability to override a plain Verdix default.
// 'contract_override_only' is defined so the TYPE exists and a future step
// doesn't have to redesign this union, but is deliberately left INERT —
// no test or concrete scenario requires real behavior for it yet, and
// Step 4 explicitly says not to assign speculative commercial semantics.
export type Overrideability =
  | 'organization_overrideable'
  | 'contract_override_only'

// A proposal to the precedence resolver — never a mutation, never
// persisted, never containing raw contract text. `field` uses the same
// dotted addressing convention as lib/rulebook/types.ts's RulebookFinding
// (e.g. "creditApplication.carryForward"), so a shadow finding can be
// adapted into a candidate without inventing a second field-naming scheme.
export interface RuleResolutionCandidate {
  field: string
  value: unknown
  authority: ResolutionAuthority
  method: ResolutionMethod
  // Which rule/policy produced this candidate, when applicable (a Verdix
  // Rulebook rule_id, or a future organization-policy id) — omitted for
  // contract_derived/reviewer_policy, which aren't rule-driven.
  rule_id?: string
  confidence?: number
  evidence?: {
    // Mirrors lib/rulebook/types.ts's ProvenancedField.sourceTextPresent —
    // never the source text itself, only whether it exists.
    source_present?: boolean
  }
  // Descriptive policy metadata only — see Overrideability's own comment.
  // Never consulted to let one authority band beat a higher-ranked one;
  // that would be a second invariant-precedence mechanism duplicating
  // Step 3's activation layer, which resolveFieldAuthority deliberately
  // does not do. Absent means "no special overrideability behavior" (the
  // ordinary case).
  overrideability?: Overrideability
}

export type FieldResolutionStatus = 'resolved' | 'unresolved' | 'conflict'

export interface FieldResolutionResult {
  field: string
  // Present only when status === 'resolved'.
  selected?: RuleResolutionCandidate
  // Every candidate that was NOT selected — including, in a 'conflict',
  // ALL candidates (there is no winner to exclude one of them from this
  // list) and, in the 'unresolved' verdix_recommends-only case, the
  // recommendation itself (a recommendation is never "selected", even
  // when it's the only candidate present).
  suppressed: RuleResolutionCandidate[]
  status: FieldResolutionStatus
}

// Highest precedence first. Applies when candidates compete for the SAME
// field. contract_derived always wins (Step 4 item 7 — tested explicitly,
// including against both an Organization and the Verdix Global Rulebook).
// reviewer_policy overrides organization/Verdix defaults but loses to an
// explicit contract reading. organization_rulebook overrides an
// out-of-box verdix_rulebook default. verdix_recommends never resolves a
// field on its own, regardless of rank — see resolveFieldAuthority.
export const RESOLUTION_AUTHORITY_PRECEDENCE: readonly ResolutionAuthority[] = [
  'contract_derived',
  'reviewer_policy',
  'organization_rulebook',
  'verdix_rulebook',
  'verdix_recommends',
]

function authorityRank(authority: ResolutionAuthority): number {
  return RESOLUTION_AUTHORITY_PRECEDENCE.indexOf(authority)
}

// Best-effort structural equality for a candidate's `value` — sufficient
// for the small primitive/short-array/short-object commercial values this
// domain deals with (booleans, enum strings, small string[] scopes,
// numbers). Never applied to raw contract text (candidates never carry
// any — see RuleResolutionCandidate's own comment), so stringify-based
// comparison is a deliberate, adequate simplification here, not a general
// deep-equal utility.
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Resolves within a single authority "band" — same-authority candidates
// that agree produce a resolved winner; same-authority candidates that
// DISAGREE fail closed as 'conflict', never picked by array order.
function resolveWithinBand(field: string, band: RuleResolutionCandidate[], outsideBand: RuleResolutionCandidate[]): FieldResolutionResult {
  const allAgree = band.every(c => valuesEqual(c.value, band[0].value))
  if (!allAgree) {
    return { field, selected: undefined, suppressed: [...band, ...outsideBand], status: 'conflict' }
  }
  return { field, selected: band[0], suppressed: outsideBand, status: 'resolved' }
}

// The central precedence resolver — pure, no mutation, no database, no
// LLM call, no side effects. Operates on candidates for a SINGLE field
// (every candidate must share the same `field`; mixed input throws rather
// than silently misbehaving).
//
// resolveFieldAuthority resolves COMPETING COMMERCIAL VALUES/POLICIES —
// it does not, and must never, enforce universal invariants. A structural
// fact like "all-units cannot execute as graduated" is not a candidate
// competing for a field's value; it is a constraint on whatever value
// eventually gets selected/executed, and belongs entirely to the existing
// Step 3 activation layer (resolveVerdixRulebookActivation's execution-
// target violations, evaluateFieldPromotion's promotion-target denials).
// This function has exactly one job: given a field's candidates, apply
// RESOLUTION_AUTHORITY_PRECEDENCE — contract_derived always wins; a top
// band of verdix_recommends candidates NEVER resolves the field on its own
// (mirrors lib/commercial-rule-status.ts's isProvenanceResolved — "AI
// confidence is not provenance": even as the sole or highest-ranked
// candidate, a recommendation stays 'unresolved'); multiple candidates
// within the SAME winning band that disagree with each other fail closed
// as 'conflict', never picked by array order. Whether the RESULTING
// selected state is actually valid to execute is a separate question,
// checked separately, after this function returns — see
// tests/commercial-semantics/rulebook/resolution.test.ts's "architectural
// separation" section for the worked example.
export function resolveFieldAuthority(candidates: RuleResolutionCandidate[]): FieldResolutionResult {
  if (candidates.length === 0) return { field: '', selected: undefined, suppressed: [], status: 'unresolved' }

  const fields = new Set(candidates.map(c => c.field))
  if (fields.size > 1) {
    throw new Error(`resolveFieldAuthority: all candidates must address the same field, got: ${[...fields].join(', ')}`)
  }
  const field = candidates[0].field

  const topRank = Math.min(...candidates.map(c => authorityRank(c.authority)))
  if (RESOLUTION_AUTHORITY_PRECEDENCE[topRank] === 'verdix_recommends') {
    return { field, selected: undefined, suppressed: candidates, status: 'unresolved' }
  }
  const topBand = candidates.filter(c => authorityRank(c.authority) === topRank)
  const outsideBand = candidates.filter(c => authorityRank(c.authority) !== topRank)
  return resolveWithinBand(field, topBand, outsideBand)
}
