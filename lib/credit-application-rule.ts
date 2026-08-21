import type { CreditApplicationRule, FieldProvenance } from './types'
import { isProvenanceResolved } from './commercial-rule-status'
import type { ProductionOrganizationResolution } from './rulebook/organization-rulebook-production'

// Step 5C — the ONE sanctioned place a caller-asserted (i.e. ultimately
// client-supplied) FieldProvenance value gets to reach persisted state.
// 'organization_rulebook' is structurally excluded: it may only ever be
// minted by this module's own organizationResolution branch, which is
// computed server-side against a real, matching, active organization rule
// (see lib/rulebook/organization-rulebook-production.ts) — never accepted
// as a bare claim. Exported so this exact guard is independently testable
// (route.ts itself can't be unit-tested — see this file's own header
// comment) and reusable by any other call site that threads client-
// supplied provenance toward a *_provenance field (e.g. confirm-rule's
// cash_redeemable_provenance, which has no organization-resolution path
// of its own today but must never accept this claim either).
export function sanitizeAssertedProvenance(p: FieldProvenance | null | undefined): FieldProvenance | null | undefined {
  return p === 'organization_rulebook' ? undefined : p
}

// application_rule: what a service credit may reduce, and its one-time/
// carry-forward semantics. Unlike every other confirm-rule field,
// requires_confirmation here is DERIVED, not hardcoded false on confirm —
// a reviewer confirming "this is a rebate worth 5% of X" does not, by
// itself, resolve "and it may reduce which future charges" if the contract
// genuinely doesn't say. Those are separate questions; this stays a live
// gate on the credit-ledger's application step even after the interpretation
// itself is confirmed.
//
// requires_confirmation is gated on PROVENANCE (isProvenanceResolved), not
// on whether eligible_component_keys/one_time/carry_forward happen to hold
// a concrete value — a live A/B test (Opus vs Sonnet, TEST-PAY-002,
// 2026-08-20/21) showed a reasoning-tier model return confident, concrete
// values (carry_forward: false/true) for questions the contract never
// actually answers, tagged only as its own recommendation. Gating on
// value-presence alone would have silently cleared that blocker. AI
// confidence is not provenance: only 'contract_derived' (the source
// states/implies it), 'reviewer_policy' (a human explicitly confirmed or
// chose it), or — Step 5C — 'organization_rulebook' (an active,
// applicable Organization Rulebook policy filled genuine silence) can
// clear this gate — see isProvenanceResolved and FieldProvenance's own
// doc comment in lib/types.ts.
//
// Extracted into its own pure lib module (rather than living inline in
// confirm-rule/route.ts) specifically so it's directly unit-testable
// without importing the route — route.ts transitively pulls in next-auth,
// which fails to resolve under plain vitest (no Next.js runtime). This
// function itself makes no database calls — organizationResolution (Step
// 5C) is computed by the caller (confirm-rule/route.ts, using
// lib/rulebook/organization-rulebook-production.ts's
// resolveProductionOrganizationField against rules it already loaded) and
// handed in as plain data, exactly like `provenance` already is.
export function buildCreditApplicationRule(
  approved: Record<string, unknown>,
  existing: CreditApplicationRule | null | undefined,
  provenance?: { eligibility?: FieldProvenance; survival?: FieldProvenance },
  // Step 5C — only ever consulted for carry_forward specifically (the sole
  // field in PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST today), and only
  // as a FALLBACK once contract/reviewer-derived data has already been
  // considered and STILL leaves it genuinely silent. Passing a 'resolved'
  // resolution never overwrites an explicit contract or reviewer answer —
  // see the gate below, the actual enforcement point (the caller does not
  // need to pre-check this; it is safe to always pass through whatever
  // resolveProductionOrganizationField returned).
  organizationResolution?: ProductionOrganizationResolution,
): CreditApplicationRule | null {
  const source = approved.application_rule as Record<string, unknown> | undefined
  if (!source && !existing) return null
  const eligible_component_keys = (source?.eligible_component_keys as string[] | 'all' | null | undefined) ?? existing?.eligible_component_keys ?? null
  const one_time = (source?.one_time as boolean | 'unclear' | undefined) ?? existing?.one_time ?? 'unclear'
  const carry_forward = (source?.carry_forward as boolean | 'unclear' | undefined) ?? existing?.carry_forward ?? 'unclear'
  // Never invents provenance server-side — takes exactly what THIS
  // submission claims (the client's own aiProposal.application_state/
  // survival_state grading, or 'reviewer_policy' when the reviewer
  // explicitly confirmed a recommendation or used free-text Override),
  // falling back to whatever was already persisted so an unrelated later
  // confirm on this same credit never silently downgrades an earlier
  // reviewer_policy back to unresolved.
  //
  // Hardening (Step 5C, pre-commit review): `provenance` mirrors a
  // CALLER-supplied value — in the real call site (confirm-rule/route.ts)
  // that caller is, transitively, the client's own request body
  // (applicationRuleProvenance). 'organization_rulebook' must NEVER be
  // accepted through this channel: it is only ever legitimate when it
  // comes with a matching, active organization rule and an audit trail
  // (ruleId/ruleVersion) — exactly what the organizationResolution
  // parameter below (computed server-side via
  // resolveProductionOrganizationField, never client-supplied) provides.
  // Without this guard, a crafted request body asserting
  // `{ survival: 'organization_rulebook' }` would mint that provenance
  // for ANY value with NO matching rule and NO audit trail, defeating the
  // entire "why did this field resolve" guarantee the rest of Step 5C
  // depends on. Sanitizing here — at the one function that actually
  // writes *_provenance — protects every current and future caller
  // structurally, rather than relying on each call site to remember.
  const eligibility_provenance = sanitizeAssertedProvenance(provenance?.eligibility) ?? existing?.eligibility_provenance ?? null
  let survival_provenance = sanitizeAssertedProvenance(provenance?.survival) ?? existing?.survival_provenance ?? null

  // Step 5C — organization resolution as a fallback for genuine silence
  // ONLY. Both halves of this condition matter: carry_forward === 'unclear'
  // means neither this submission nor any prior persisted state supplied a
  // concrete value, and !isProvenanceResolved(survival_provenance) means
  // nothing has already graded this question resolved either (belt-and-
  // braces with the first check, same discipline as the requiresConfirmation
  // check below). An organization policy NEVER overwrites a value that is
  // already contract_derived or reviewer_policy — those cases never reach
  // here 'unclear', so this branch is structurally unreachable for them.
  let survivalOrganizationRuleId: string | null = existing?.survival_organization_rule_id ?? null
  let survivalOrganizationRuleVersion: number | null = existing?.survival_organization_rule_version ?? null
  let resolvedCarryForward = carry_forward
  if (carry_forward === 'unclear' && !isProvenanceResolved(survival_provenance) && organizationResolution?.status === 'resolved') {
    resolvedCarryForward = organizationResolution.value as boolean
    survival_provenance = 'organization_rulebook'
    survivalOrganizationRuleId = organizationResolution.ruleId ?? null
    survivalOrganizationRuleVersion = organizationResolution.ruleVersion ?? null
  }

  // Belt-and-braces: resolution requires BOTH good provenance AND an
  // actual value — a 'contract_derived'/'reviewer_policy'/'organization_
  // rulebook' claim paired with a still-null/'unclear' value should never
  // happen (validateProposalState already enforces this upstream for the
  // first two; the Step 5C branch above only ever sets both together), but
  // this is billing-critical enough to check both rather than trust either
  // alone.
  const requiresConfirmation =
    !isProvenanceResolved(eligibility_provenance) || eligible_component_keys === null ||
    !isProvenanceResolved(survival_provenance) || one_time === 'unclear' || resolvedCarryForward === 'unclear'
  return {
    computed_from_component_keys: (source?.computed_from_component_keys as string[] | null | undefined) ?? existing?.computed_from_component_keys ?? null,
    eligible_component_keys,
    eligibility_provenance,
    excluded_component_keys: (source?.excluded_component_keys as string[] | undefined) ?? existing?.excluded_component_keys ?? [],
    one_time,
    carry_forward: resolvedCarryForward,
    survival_provenance,
    survival_organization_rule_id: survivalOrganizationRuleId,
    survival_organization_rule_version: survivalOrganizationRuleVersion,
    expiry_periods: (source?.expiry_periods as number | null | undefined) ?? existing?.expiry_periods ?? null,
    expiry_date: (source?.expiry_date as string | null | undefined) ?? existing?.expiry_date ?? null,
    availability: 'next_period',
    requires_confirmation: requiresConfirmation,
    confirmation_reason: requiresConfirmation
      ? ((source?.confirmation_reason as string | null | undefined) ?? existing?.confirmation_reason ?? 'Application scope not fully resolved by the contract')
      : null,
  }
}
