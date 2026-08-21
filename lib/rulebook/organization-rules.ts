// Private Organization Rulebook — pure domain (Step 5A, shadow mode only).
//
// A tenant-private rule source that will eventually sit between contract-
// specific decisions and the Verdix Global Rulebook in field-authority
// precedence (lib/rulebook/resolution.ts). Step 5A gives it real,
// tenant-isolated storage (see organization-rules-service.ts and
// supabase/migrations/20260822000001_organization_rulebook_rules.sql) and
// a deterministic matcher, but ZERO production authority: nothing in
// app/api or app/(dashboard) reads this module or the table it backs.
//
// Core safety rules this file enforces structurally, not just by
// convention:
//   - an organization rule is never visible to another organization — see
//     matchOrganizationRules's own organizationId defense-in-depth check
//     (the real boundary is the DB query in organization-rules-service.ts,
//     which is org-scoped by construction; this is a second, cheap check);
//   - an organization rule is NEVER promoted into the Verdix Global
//     Rulebook — this module has no code path that writes to
//     lib/rulebook/rules.ts's verdixCommercialRulebook, and never will;
//   - an organization rule applies only where the target field is NOT
//     already resolved by the contract or a contract-specific reviewer
//     decision — matchOrganizationRules excludes a rule whose target_field
//     appears in the caller's contractResolvedFields set, entirely
//     independent of (and in addition to) Step 4's own precedence, which
//     would suppress it anyway;
//   - a rule is never active without an explicit approver, regardless of
//     source_kind — enforced primarily by the database CHECK constraint
//     (belt-and-braces: see the migration), and by this module's matcher
//     only ever considering status === 'active' rules;
//   - there is NO function anywhere in this module that takes a history of
//     reviewer decisions (or an AI-detected pattern) and produces an
//     active organization rule — creation always requires an explicit
//     createdBy, and activation always requires an explicit approvedBy,
//     supplied by a caller, never derived here.
import type { RuleResolutionCandidate } from './resolution'

// ── Structured matching — no eval, no arbitrary expressions, no SQL ────────
//
// Deliberately minimal, per Step 5A's instruction to add operators only
// when a real Rulebook scenario needs them.
export type MatchOperator = 'eq' | 'in' | 'exists'

export interface MatchCondition {
  field: string
  operator: MatchOperator
  // Required for 'eq'/'in', irrelevant (and ignored) for 'exists'.
  value?: unknown
}

// The ONLY field paths a target_field or match condition may reference —
// a small, explicit, code-defined allowlisted vocabulary, not an
// unrestricted JSON path into arbitrary contract/normalized data. Dotted
// paths, matching the same addressing convention already used elsewhere in
// lib/rulebook (RulebookFinding.field, RuleResolutionCandidate.field), so
// a real future adapter can build consistent field names across the whole
// Rulebook subsystem. Add entries only when a concrete scenario needs
// them — this is not meant to eventually cover every normalized field.
//
// Known schema capability gap (Step 5B review): there is deliberately NO
// field here for "how long a carried-forward balance survives" / "expiry
// treatment" (e.g. the concept behind lib/types.ts's CreditApplicationRule
// .expiry_periods/.expiry_date) — that is a genuinely different commercial
// dimension from BOTH survival.carry_forward (does an unused balance
// survive to another period AT ALL) and survival.one_time (can the
// credit/benefit be EARNED once vs. repeatedly). An organization rule
// cannot yet express "carry forward, AND specifically until fully used"
// as a single decision — only the plain carry_forward boolean. Do not
// overload survival.carry_forward or survival.one_time to stand in for
// this; add a real allowlisted field (e.g. 'survival.expiry_periods')
// once a concrete scenario needs it, rather than approximating it here.
export const ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS = [
  'rule_type',
  'application.timing',
  'application.eligible_component_keys',
  'survival.carry_forward',
  'survival.one_time',
  'cash_redeemable',
] as const
export type OrganizationRulebookAllowlistedField = typeof ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS[number]

export function isAllowlistedOrganizationRuleField(field: string): field is OrganizationRulebookAllowlistedField {
  return (ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS as readonly string[]).includes(field)
}

const SUPPORTED_MATCH_OPERATORS: readonly MatchOperator[] = ['eq', 'in', 'exists']

export type OrganizationRuleValidation = { valid: true } | { valid: false; reason: string }

// Called by organization-rules-service.ts before any insert — a rule whose
// target_field or any match condition's field falls outside the allowlist,
// or whose operator isn't one of the small supported set, is rejected
// before it ever reaches storage. This is the enforcement point for "do
// not use eval, arbitrary JavaScript expressions, SQL fragments, or
// unrestricted JSON paths" — nothing downstream ever interprets a
// field/operator this function hasn't already validated.
export function validateOrganizationRuleShape(input: { targetField: string; matchConditions: MatchCondition[] }): OrganizationRuleValidation {
  if (!isAllowlistedOrganizationRuleField(input.targetField)) {
    return { valid: false, reason: `target_field "${input.targetField}" is not in the allowlisted commercial vocabulary` }
  }
  for (const condition of input.matchConditions) {
    if (!isAllowlistedOrganizationRuleField(condition.field)) {
      return { valid: false, reason: `match condition field "${condition.field}" is not in the allowlisted commercial vocabulary` }
    }
    if (!SUPPORTED_MATCH_OPERATORS.includes(condition.operator)) {
      return { valid: false, reason: `unsupported match operator "${condition.operator}"` }
    }
  }
  return { valid: true }
}

// ── Rule record (mirrors organization_rulebook_rules, camelCased) ─────────

export type OrganizationRuleStatus = 'draft' | 'active' | 'disabled' | 'superseded'
export type OrganizationRuleSourceKind = 'manual' | 'reviewer_promotion' | 'verdix_pattern_suggestion'

export interface OrganizationRuleRecord {
  id: string
  organizationId: string
  name: string
  description: string | null
  targetField: string
  value: unknown
  matchConditions: MatchCondition[]
  status: OrganizationRuleStatus
  version: number
  supersedesRuleId: string | null
  // Groups every version of the "same logical rule" together — the
  // original rule and everything that transitively supersedes it.
  // Distinct from id (this specific version) and supersedesRuleId (only
  // the immediately prior version). Assigned once at creation (Step 5B.5)
  // and never changes across a supersession chain.
  lineageId: string
  // How this rule originated — descriptive only, NEVER a source of
  // authority. Once a rule is active: 'organization_rulebook' is its
  // resolution authority regardless of source_kind (Step 5A item 9). A
  // verdix_pattern_suggestion that hasn't been approved stays 'draft' and
  // is therefore excluded from matchOrganizationRules entirely — see that
  // function's status check.
  sourceKind: OrganizationRuleSourceKind
  createdBy: string
  approvedBy: string | null
  createdAt: string
  updatedAt: string
  // Validity window — [effectiveFrom, effectiveTo), inclusive lower bound,
  // exclusive upper bound (Step 5B.5). effectiveFrom: null means "always
  // valid from the beginning of time"; effectiveTo: null means "still
  // valid, no end yet" for an 'active' row, but see matchOrganizationRules'
  // own comment for why a 'superseded' row with effectiveTo: null is
  // treated as ambiguous legacy data and excluded, not as infinitely valid.
  effectiveFrom: string | null
  effectiveTo: string | null
}

// ── Matching ────────────────────────────────────────────────────────────

// The normalized facts a single commercial item (e.g. one service credit)
// presents for organization-rule matching — addressed via the SAME dotted
// paths as ORGANIZATION_RULEBOOK_ALLOWLISTED_FIELDS. Built by a future
// adapter from real normalized data; Step 5A does not build that adapter
// (no production wiring yet) — tests use plain fixture objects.
export type OrganizationRuleMatchContext = Record<string, unknown>

export interface OrganizationRuleMatchInput {
  context: OrganizationRuleMatchContext
  // Which target fields are ALREADY resolved by contract_derived or
  // reviewer_policy for the specific contract/rule instance being
  // evaluated. An organization rule whose target_field appears here is
  // never matched, regardless of how well its conditions match — item 2:
  // "an organization policy supplies a DEFAULT, not a contract rewrite."
  // This is enforced HERE, at the matcher, as the first of two independent
  // layers of protection — Step 4's resolveFieldAuthority precedence
  // (contract_derived/reviewer_policy always outrank organization_
  // rulebook) is the second, so a bug in one layer alone can't let an
  // organization default silently override an explicit contract term.
  contractResolvedFields: ReadonlySet<string>
}

function getAtPath(obj: OrganizationRuleMatchContext, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function conditionMatches(condition: MatchCondition, context: OrganizationRuleMatchContext): boolean {
  const actual = getAtPath(context, condition.field)
  switch (condition.operator) {
    case 'eq': return actual === condition.value
    case 'in': return Array.isArray(condition.value) && condition.value.includes(actual)
    case 'exists': return actual !== undefined && actual !== null
  }
}

// Deterministic, pure, no AI involvement whatsoever — Step 5A item 4: "No
// AI should decide whether a policy matches." Given the SAME organizationId,
// input, rules array, and asOf, always returns the SAME set of matching
// rules, in the SAME order (the order `rules` was supplied in — this
// function does not sort or otherwise pick a "best" match; see
// resolveFieldAuthority in lib/rulebook/resolution.ts for how multiple
// matches for the same field are reconciled, including same-authority
// conflict).
//
// `rules` is expected to already be organization-scoped (fetched via
// organization-rules-service.ts's listActiveOrganizationRules(organizationId),
// which filters by organization_id at the database query itself — the
// real tenant boundary). The organizationId check below is defense in
// depth, not the primary boundary: it protects against a caller mistakenly
// passing an unfiltered/mixed-org collection, but a caller should never
// rely on it as the ONLY isolation mechanism.
//
// `asOf` is a REQUIRED, explicit parameter — never read from an ambient
// Date.now() inside this pure function, so a given (organizationId, input,
// rules, asOf) tuple always produces the identical result no matter when
// it's called, including for a HISTORICAL asOf in the past (Step 5B.5).
//
// Temporal eligibility — [effectiveFrom, effectiveTo), inclusive lower
// bound, exclusive upper bound:
//   effectiveFrom is null OR effectiveFrom <= asOf   (already started)
//   AND
//   effectiveTo is null OR asOf < effectiveTo         (not yet ended)
// This means a rule that has since been SUPERSEDED can still match a
// historical asOf that falls within the window it was actually active
// for — status alone (Step 5B.5 item 2/5) is no longer sufficient to
// exclude a rule from matching; a 'superseded' row is eligible exactly
// like an 'active' one, gated only by its validity window. 'draft' and
// 'disabled' remain unconditionally excluded regardless of asOf — neither
// was ever authoritative for any point in time.
//
// One deliberate fail-closed exception: a 'superseded' row with
// effectiveTo: null is ambiguous legacy data (a row that was retired
// without recording when) — rather than treat it as infinitely valid, it
// is excluded entirely. This can only occur for rows superseded before
// this temporal model existed; every row superseded through
// activate_organization_rule_supersession (organization-rules-service.ts)
// always has effectiveTo set atomically with the retirement itself.
export function matchOrganizationRules(
  organizationId: string,
  input: OrganizationRuleMatchInput,
  rules: OrganizationRuleRecord[],
  asOf: Date,
): OrganizationRuleRecord[] {
  return rules.filter(rule => {
    if (rule.organizationId !== organizationId) return false
    if (rule.status !== 'active' && rule.status !== 'superseded') return false
    if (rule.status === 'superseded' && rule.effectiveTo === null) return false
    if (input.contractResolvedFields.has(rule.targetField)) return false
    if (rule.effectiveFrom !== null && new Date(rule.effectiveFrom) > asOf) return false
    if (rule.effectiveTo !== null && asOf >= new Date(rule.effectiveTo)) return false
    return rule.matchConditions.every(condition => conditionMatches(condition, input.context))
  })
}

// Adapts a matched, active organization rule into a Step 4 resolution
// candidate — shadow-only (lib/rulebook/resolution.ts's resolveFieldAuthority
// consumes this the same way it consumes any other candidate; nothing here
// mutates a normalized commercial rule or persists a selected result).
export function organizationRuleToCandidate(rule: OrganizationRuleRecord): RuleResolutionCandidate {
  return {
    field: rule.targetField,
    value: rule.value,
    authority: 'organization_rulebook',
    method: 'organization_rulebook',
    rule_id: rule.id,
  }
}
