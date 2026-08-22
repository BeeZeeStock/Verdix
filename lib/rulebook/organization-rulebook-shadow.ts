// Organization Rulebook — shadow resolution (Step 5B).
//
// Connects Step 5A's approved organization rules to Verdix's normalized
// commercial interpretation, field by field, in SHADOW MODE ONLY. Answers
// exactly one question per field: "given this normalized commercial field,
// this organization, and this effective date, is there an approved
// organization rule that would resolve it, and is that rule allowed to
// apply under Verdix precedence?" It never mutates a persisted commercial
// value, never writes FieldProvenance, never changes readiness, and is not
// called from any production route/calculation path.
//
// Reuses, unmodified:
//   - lib/rulebook/organization-rules.ts's matchOrganizationRules (Step 5A)
//     for organization scope, status=active, effective_from, and semantic
//     condition matching — no parallel matcher.
//   - lib/rulebook/resolution.ts's resolveFieldAuthority (Step 4) for
//     precedence — no parallel precedence implementation.
// The Verdix Global Rulebook (lib/rulebook/rules.ts / activation.ts)
// remains a fully separate, independent layer — this module never reads
// or calls it directly; a caller MAY hand it a pre-built verdix_rulebook
// candidate via `verdixCandidates` for composition, but this module has no
// idea how that candidate was produced.
//
// This is a pure function: no supabaseServer import, no fetch, no
// database call of any kind. The caller (a test, or eventually a real
// route handler) is responsible for loading `organizationRules` first —
// see loadAndResolveOrganizationRulebookShadow at the bottom of this file
// for the (equally inert, not production-wired) DB-touching convenience
// wrapper that does that loading.
import type { FieldProvenance } from '@/lib/types'
import {
  matchOrganizationRules, organizationRuleToCandidate,
  type OrganizationRuleRecord, type OrganizationRuleMatchContext,
} from './organization-rules'
import { resolveFieldAuthority, type RuleResolutionCandidate } from './resolution'

// The currently-normalized state of one commercial field, as it exists in
// production today — an echo of what confirm-rule/isProvenanceResolved
// already track, never re-derived here. provenance: null means genuinely
// unresolved (no FieldProvenance assigned at all yet).
export interface CurrentFieldState {
  value: unknown
  provenance: FieldProvenance | null
}

// Bundles the two different kinds of input a field needs for organization-
// rule evaluation — deliberately two separate maps, not one, because they
// answer different questions: `current` is per-FIELD (what does THIS field
// currently say), `match` is per-CONTEXT (what semantic facts describe the
// commercial item as a whole, e.g. rule_type/application.timing — the same
// shape Step 5A's matcher already consumes as OrganizationRuleMatchContext).
export interface CommercialFieldContext {
  current: Record<string, CurrentFieldState | undefined>
  match: OrganizationRuleMatchContext
}

export interface OrganizationRulebookShadowInput {
  organizationId: string
  commercialContext: CommercialFieldContext
  organizationRules: OrganizationRuleRecord[]
  asOf: Date
  // Optional Verdix Global Rulebook candidates (authority: 'verdix_
  // rulebook') a caller wants composed into precedence alongside the
  // organization candidates for the SAME fields — see this module's own
  // header comment on why this module never generates these itself.
  verdixCandidates?: RuleResolutionCandidate[]
}

export type OrganizationRulebookShadowStatus = 'candidate' | 'precedence_blocked' | 'conflict' | 'no_match'

export interface OrganizationRulebookFieldShadowResult {
  field: string
  current: CurrentFieldState
  // Present only when result === 'candidate'.
  organizationCandidate?: { value: unknown; ruleId: string; ruleVersion: number }
  result: OrganizationRulebookShadowStatus
  // Present only when result === 'precedence_blocked'. Can only ever be
  // contract_derived or reviewer_policy — organization_rulebook always
  // outranks verdix_rulebook/verdix_recommends in RESOLUTION_AUTHORITY_
  // PRECEDENCE, so nothing else can be the blocker.
  blockedBy?: 'contract_derived' | 'reviewer_policy'
  reason: string
}

// Maps a CurrentFieldState into (at most) one RuleResolutionCandidate.
// provenance: null (genuinely unresolved) produces NO candidate at all —
// there is nothing to represent as "the current value's source", which is
// exactly right: an unresolved field has no authority to defend.
function currentFieldCandidate(field: string, current: CurrentFieldState): RuleResolutionCandidate | null {
  if (!current.provenance) return null
  return { field, value: current.value, authority: current.provenance, method: 'existing_normalized_state' }
}

// Specificity — Step 5A's schema does not have a dedicated priority field,
// so this uses the one dimension already present that legitimately
// measures how narrowly a rule targets a situation: the number of match
// conditions it declares. A rule with MORE conditions is more specific
// (rule_type + component + field > rule_type + field > a bare field-level
// default with zero conditions). Only rules at the MAXIMUM specificity
// found among a field's matches proceed to precedence resolution — a
// broader, less-specific match that also happens to match is superseded
// before precedence is even considered, exactly like a more specific CSS
// selector or route pattern would be. Two rules tied at the max
// specificity are NOT arbitrarily broken by array order — they both
// proceed to resolveFieldAuthority, which fails closed as 'conflict' if
// their values disagree (the existing, unmodified same-authority-conflict
// behavior), or resolves normally if they agree.
function mostSpecificOrgRules(rulesForField: OrganizationRuleRecord[]): OrganizationRuleRecord[] {
  if (rulesForField.length <= 1) return rulesForField
  const maxSpecificity = Math.max(...rulesForField.map(r => r.matchConditions.length))
  return rulesForField.filter(r => r.matchConditions.length === maxSpecificity)
}

function resolveOneField(
  field: string,
  current: CurrentFieldState,
  orgRulesForField: OrganizationRuleRecord[],
  verdixCandidatesForField: RuleResolutionCandidate[],
): OrganizationRulebookFieldShadowResult {
  if (orgRulesForField.length === 0) {
    return { field, current, result: 'no_match', reason: `No active organization rule matched field "${field}".` }
  }

  const specificRules = mostSpecificOrgRules(orgRulesForField)
  const supersededBySpecificityCount = orgRulesForField.length - specificRules.length
  const ruleById = new Map(specificRules.map(r => [r.id, r]))

  const candidates: RuleResolutionCandidate[] = []
  const currentCandidate = currentFieldCandidate(field, current)
  if (currentCandidate) candidates.push(currentCandidate)
  candidates.push(...specificRules.map(organizationRuleToCandidate))
  candidates.push(...verdixCandidatesForField)

  const resolved = resolveFieldAuthority(candidates)

  if (resolved.status === 'conflict') {
    return {
      field, current, result: 'conflict',
      reason: `${specificRules.length} equally-specific active organization rule(s) for "${field}" propose conflicting values — failed closed rather than picking one arbitrarily.`,
    }
  }

  if (resolved.selected?.authority === 'organization_rulebook') {
    // resolved.selected may be the CURRENT-STATE echo candidate itself,
    // not one of the rule-sourced candidates — this happens when the
    // field's already-persisted provenance is ALREADY organization_
    // rulebook and a live matching rule agrees with the same value:
    // resolveWithinBand picks whichever same-authority candidate appears
    // first in `candidates` (the echo is pushed first), and the echo
    // carries no rule_id. Every candidate inside a 'resolved' same-
    // authority band is guaranteed to agree in value (resolveWithinBand's
    // own precondition), so any rule-sourced candidate in that band
    // identifies the exact same winning value/rule for reporting purposes
    // — look one up explicitly rather than assuming resolved.selected
    // itself carries a rule_id.
    const ruleSourced = resolved.selected.rule_id ? resolved.selected : candidates.find(c => c.authority === 'organization_rulebook' && c.rule_id)
    const winningRule = ruleById.get(ruleSourced!.rule_id!)!
    const specificityNote = supersededBySpecificityCount > 0
      ? ` (${supersededBySpecificityCount} broader, less-specific matching rule(s) were superseded by specificity before precedence)`
      : ''
    return {
      field, current,
      organizationCandidate: { value: winningRule.value, ruleId: winningRule.id, ruleVersion: winningRule.version },
      result: 'candidate',
      reason: `Organization rule "${winningRule.name}" (v${winningRule.version}) matched and no higher-precedence source blocks it${specificityNote}.`,
    }
  }

  // resolved.status is 'resolved' with a non-organization_rulebook winner
  // (contract_derived, reviewer_policy, or verdix_rulebook/verdix_recommends
  // — the latter two are structurally impossible here: organization_
  // rulebook always outranks both in RESOLUTION_AUTHORITY_PRECEDENCE, so
  // if an org candidate is present it can only ever be beaten by
  // contract_derived or reviewer_policy). resolved.status === 'unresolved'
  // is likewise unreachable here: that only occurs when the top authority
  // band is verdix_recommends, which an organization_rulebook candidate
  // (guaranteed present in this branch) always outranks.
  const blockedBy = resolved.selected?.authority as 'contract_derived' | 'reviewer_policy'
  return {
    field, current, result: 'precedence_blocked', blockedBy,
    reason: `${specificRules.length} matching active organization rule(s) for "${field}" were blocked by higher-precedence ${blockedBy}.`,
  }
}

// The pure Step 5B entry point. Deterministic: identical inputs (including
// asOf) always produce identical output, in the same field order every
// time — never reads ambient Date.now(), never mutates organizationRules,
// commercialContext, or verdixCandidates.
//
// Resolves every field that appears EITHER in commercialContext.current OR
// as the target_field of at least one semantically-matching organization
// rule (matched via the unmodified Step 5A matcher, called with an EMPTY
// contractResolvedFields set deliberately — see below) OR in
// verdixCandidates — field-by-field, per item 3, never rule-object-by-
// rule-object.
//
// Deliberate choice: Step 5A's matchOrganizationRules accepts a
// contractResolvedFields set that EXCLUDES an already-contract/reviewer-
// resolved field from matching at all — the right behavior for a caller
// that only wants a final candidate and doesn't itself run precedence
// resolution afterward. Step 5B always calls it with an EMPTY set instead
// (the matcher itself is untouched — this is just choosing not to use one
// of its optional exclusions) because Step 5B's entire purpose is to
// REPORT when a match exists but is precedence-blocked (item 5's worked
// example explicitly requires "organization rule matched semantically BUT
// result = precedence_blocked" — not silent exclusion). The actual
// contract/reviewer-always-wins enforcement still happens, correctly and
// exclusively, via resolveFieldAuthority below — never re-implemented here.
export function resolveOrganizationRulebookShadow(input: OrganizationRulebookShadowInput): OrganizationRulebookFieldShadowResult[] {
  const { organizationId, commercialContext, organizationRules, asOf, verdixCandidates = [] } = input

  const matchedOrgRules = matchOrganizationRules(
    organizationId,
    { context: commercialContext.match, contractResolvedFields: new Set() },
    organizationRules,
    asOf,
  )

  const fields = new Set<string>([
    ...Object.keys(commercialContext.current),
    ...matchedOrgRules.map(r => r.targetField),
    ...verdixCandidates.map(c => c.field),
  ])

  return [...fields].sort().map(field => resolveOneField(
    field,
    commercialContext.current[field] ?? { value: null, provenance: null },
    matchedOrgRules.filter(r => r.targetField === field),
    verdixCandidates.filter(c => c.field === field),
  ))
}
