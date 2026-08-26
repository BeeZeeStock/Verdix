// Organization Rulebook — controlled production resolution (Step 5C).
//
// The first step where an ACTIVE Organization Rulebook policy may resolve
// a production commercial field, not just a shadow diagnostic. Proceeds
// conservatively: only the fields in PRODUCTION_ORGANIZATION_RULEBOOK_
// ALLOWLIST below may ever have their shadow result applied for real — an
// organization rule targeting any other allowlisted-for-MATCHING (Step 5A)
// field continues to participate in shadow diagnostics only, exactly as
// before this step.
//
// Deliberately reuses Step 5B's resolveOrganizationRulebookShadow (which
// itself reuses Step 5A's matchOrganizationRules and Step 4's
// resolveFieldAuthority) UNCHANGED — this module invents no new matching
// logic and no new precedence hierarchy. It is a thin, allowlist-gated
// interpreter of that same shadow result: 'candidate' becomes a real
// resolution, 'precedence_blocked' and 'no_match' become 'not_applicable'
// (nothing to do — contract/reviewer already resolved it, or no rule
// applies), and 'conflict' stays 'conflict' — never silently resolved to
// any value. Still pure: no database access of its own.
import { resolveOrganizationRulebookShadow, type OrganizationRulebookShadowInput } from './organization-rulebook-shadow'
import { sourceClauseStatesExplicitNonAgreement, type UnresolvedReason, type UnresolvedReasonField } from '../rule-interpretation'

// Start with only the one field the Step 5C spec calls out as safe to
// activate first. 'partial_period_treatment' was evaluated and deferred —
// see this module's own note in the deliverables report: the existing
// normalized model has no single field by that name (proration lives
// across MinimumCommitment.prorate_partial_periods, base_fee_proration,
// and per-fee recurring_fee_proration — three distinct rule shapes with
// their own confirm-rule call sites), so activating it "cleanly" would
// mean picking one of three different production fields to wire, which
// this step's own "proceed conservatively" instruction argues against
// doing speculatively. Add a field here only when a specific, reviewed
// scenario needs it — never expand this list to "cover more ground."
export const PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST = ['survival.carry_forward'] as const
export type ProductionActivatedOrganizationField = typeof PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST[number]

export function isProductionActivatedOrganizationField(field: string): field is ProductionActivatedOrganizationField {
  return (PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST as readonly string[]).includes(field)
}

// Step 5D final amendment — the allowed match-condition SCOPE DIMENSIONS
// for each production-activated field's canonical organization-policy
// slot (organization + target_field + these dimensions only). Deliberately
// per-field, not a single universal match_conditions recipe applied to
// every promotable field — a future field may legitimately need different
// or additional dimensions.
//
// survival.carry_forward concerns UNUSED-BALANCE SURVIVAL — a genuinely
// different commercial dimension from WHEN a credit first becomes
// applicable (application.timing). The Verdix Global Rulebook already
// keeps these distinct (credit.next_invoice_timing_ne_carry_forward), and
// this Organization Rulebook field must too: a rebate carry-forward
// default should apply the same way whether the specific rebate is timed
// next_invoice or future_invoices, since the contract being silent on
// survival doesn't depend on that. application.timing may still be shown
// to a reviewer as CONTEXT about the specific credit being promoted (see
// organization-rulebook-promotion.ts's scopeSummary), but it must never be
// written into match_conditions for this field.
//
// Add an entry here — never expand an existing one speculatively — only
// when a concrete, reviewed scenario needs a field with different scope
// dimensions than what's already defined.
export const ORGANIZATION_POLICY_SCOPE_DIMENSIONS: Record<ProductionActivatedOrganizationField, readonly string[]> = {
  'survival.carry_forward': ['rule_type'],
}

export type ProductionOrganizationResolutionStatus = 'resolved' | 'not_applicable' | 'conflict'

export interface ProductionOrganizationResolution {
  status: ProductionOrganizationResolutionStatus
  // Present only when status === 'resolved'.
  value?: unknown
  ruleId?: string
  ruleVersion?: number
  reason: string
}

// The production entry point. Still pure — the caller (a route handler)
// is responsible for loading `organizationRules` first (via
// organization-rules-service.ts's listMatchableOrganizationRules, exactly
// like the Step 5B shadow loader) and for supplying an explicit asOf
// (Step 5C item 9 — historical determinism; never ambient Date.now()
// inside this function).
//
// Returns 'not_applicable' — never 'resolved' — for any field outside
// PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST, regardless of what the
// shadow resolver would have said for it. This is the ONE new gate this
// step adds on top of the unmodified Step 4/5A/5B machinery; every other
// outcome (contract/reviewer precedence, conflict, no match, temporal
// eligibility) is exactly whatever resolveOrganizationRulebookShadow
// already, correctly, computes.
export function resolveProductionOrganizationField(
  field: string,
  shadowInput: OrganizationRulebookShadowInput,
): ProductionOrganizationResolution {
  if (!isProductionActivatedOrganizationField(field)) {
    return { status: 'not_applicable', reason: `"${field}" is not in the Step 5C production activation allowlist — it remains shadow-only.` }
  }

  const shadow = resolveOrganizationRulebookShadow(shadowInput)
  const fieldResult = shadow.find(r => r.field === field)

  if (!fieldResult || fieldResult.result === 'no_match') {
    return { status: 'not_applicable', reason: 'No active, applicable organization rule matched this field.' }
  }
  if (fieldResult.result === 'precedence_blocked') {
    return { status: 'not_applicable', reason: `A matching organization rule exists but is blocked by higher-precedence ${fieldResult.blockedBy}.` }
  }
  if (fieldResult.result === 'conflict') {
    // Fail closed — never select a policy on conflict, never fall back to
    // newest/oldest/first. The caller must leave the field unresolved.
    return { status: 'conflict', reason: fieldResult.reason }
  }

  // fieldResult.result === 'candidate'
  return {
    status: 'resolved',
    value: fieldResult.organizationCandidate!.value,
    ruleId: fieldResult.organizationCandidate!.ruleId,
    ruleVersion: fieldResult.organizationCandidate!.ruleVersion,
    reason: fieldResult.reason,
  }
}

// The exact policy metadata handed to a client as evidence of what it was
// shown at proposal time — see RuleProposal.survival_organization_policy's
// own comment (lib/rule-interpretation.ts) for the full TOCTOU rationale.
// NEVER trusted as authority — confirm-rule/route.ts always independently
// re-derives org, loads rules, matches, and resolves precedence itself
// (item 4 of the pre-commit review); this is comparison evidence only.
export interface SeenOrganizationPolicy {
  ruleId: string
  ruleVersion: number
  value: unknown
}

// TOCTOU/staleness guard (pre-commit review, item 3) — the organization-
// policy availability check in propose-rule is advisory only; confirm-rule
// is the sole authoritative resolution point (item 4) and ALREADY fails
// closed by construction whenever a fresh re-resolution doesn't land on
// 'resolved' (a disabled/superseded/now-conflicting rule naturally produces
// 'not_applicable'/'conflict', and buildCreditApplicationRule never applies
// anything but a 'resolved' result — see lib/credit-application-rule.ts).
// This function adds ONE further, narrower check on top: even when the
// FRESH resolution IS 'resolved', it may now point at a genuinely
// DIFFERENT policy (a different rule, a new version, or the same rule
// edited to a different value) than what the reviewer was actually shown
// in the proposal they confirmed against — silently substituting one
// organization policy for another between review and confirmation would
// be a live product-trust bug, not a security one (confirm-rule's own
// resolution is still correct either way), so this treats any mismatch as
// stale and lets the caller refuse to apply it this submission, rather
// than ever silently swapping the reviewer's understanding out from
// under them.
export function isOrganizationPolicyStale(
  fresh: ProductionOrganizationResolution,
  seen: SeenOrganizationPolicy,
): boolean {
  return !(
    fresh.status === 'resolved' &&
    fresh.ruleId === seen.ruleId &&
    fresh.ruleVersion === seen.ruleVersion &&
    fresh.value === seen.value
  )
}

// Step 16A — the organization-policy availability/application predicate.
// A field graded 'decision_required' collapses two different facts: the
// contract simply never raising the question (silence — organization
// policy MAY fill it in), versus the contract affirmatively stating the
// parties did NOT reach agreement on it (explicit unresolvedness — a
// stronger, still-contract-derived fact that outranks an org-wide default
// under the same authority hierarchy that already puts contract-derived
// above organization policy: contract-derived > reviewer policy >
// organization policy > Verdix rulebook > Verdix recommendation). This is
// the single shared gate both propose-rule (advisory preview) and
// confirm-rule (the sole authoritative resolution point) call before ever
// attempting an organization-policy resolution — never duplicated ad hoc
// at either call site. Takes a definite UnresolvedReason, never `undefined`
// directly — see resolveAuthoritativeUnresolvedReason below, which is what
// every caller must run first to turn a possibly-missing cached value into
// one of the two real classifications before this predicate ever sees it.
export function organizationPolicyAvailableForUnresolvedReason(
  unresolvedReason: UnresolvedReason,
): boolean {
  return unresolvedReason !== 'explicit_non_agreement'
}

// Step 16A amendment (item 3 — legacy proposal caches must be safe).
// `storedReason` is whatever a cached RuleProposal happens to carry for
// this field — which may be `undefined` for any cache entry written
// before this field existed at all. Never treat `undefined` as 'silent'
// by default: that would let a pre-existing cache for an agreement that
// genuinely states explicit non-agreement silently start auto-applying
// organization policy the moment this code shipped, purely because the
// field didn't exist yet when the cache was written — exactly the
// regression this function exists to prevent.
//
// A stored 'explicit_non_agreement' is still independently validated
// against the real source clause (never trusted on its own) — a cache
// entry could in principle have been written by a since-corrected code
// path, and per item 2, reasoning-derived signals must never be the last
// word on something that gates an organization policy. The two checks are
// combined with OR, not "prefer the fresher one": either signal finding
// explicit non-agreement is enough to keep the field Decision Required,
// consistent with this codebase's existing fail-closed convention
// (resolveProductionOrganizationField's own 'conflict' handling never
// picks a value either) — wrongly blocking an org-policy default for one
// extra reviewer decision is recoverable; wrongly auto-applying one over a
// real negotiated non-agreement is the bug this feature exists to fix.
// A stored 'silent' does not short-circuit the source-clause check either,
// for the same reason.
// field: which question the caller is resolving — required, not defaulted,
// so this can never silently reuse one field's clause-level match for a
// different field (the second amendment's own fix — see
// sourceClauseStatesExplicitNonAgreement's own comment for why field
// scoping matters).
export function resolveAuthoritativeUnresolvedReason(
  storedReason: UnresolvedReason | undefined,
  sourceClause: string | null | undefined,
  field: UnresolvedReasonField,
): UnresolvedReason {
  if (storedReason === 'explicit_non_agreement') return 'explicit_non_agreement'
  return sourceClauseStatesExplicitNonAgreement(sourceClause, field) ? 'explicit_non_agreement' : 'silent'
}
