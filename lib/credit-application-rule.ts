import type { CreditApplicationRule, FieldProvenance } from './types'
import { isProvenanceResolved } from './commercial-rule-status'

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
// states/implies it) or 'reviewer_policy' (a human explicitly confirmed or
// chose it) can clear this gate — see isProvenanceResolved and
// FieldProvenance's own doc comment in lib/types.ts.
//
// Extracted into its own pure lib module (rather than living inline in
// confirm-rule/route.ts) specifically so it's directly unit-testable
// without importing the route — route.ts transitively pulls in next-auth,
// which fails to resolve under plain vitest (no Next.js runtime).
export function buildCreditApplicationRule(
  approved: Record<string, unknown>,
  existing: CreditApplicationRule | null | undefined,
  provenance?: { eligibility?: FieldProvenance; survival?: FieldProvenance },
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
  const eligibility_provenance = provenance?.eligibility ?? existing?.eligibility_provenance ?? null
  const survival_provenance = provenance?.survival ?? existing?.survival_provenance ?? null
  // Belt-and-braces: resolution requires BOTH good provenance AND an
  // actual value — a 'contract_derived'/'reviewer_policy' claim paired
  // with a still-null/'unclear' value should never happen (validateProposalState
  // already enforces this upstream), but this is billing-critical enough to
  // check both rather than trust either alone.
  const requiresConfirmation =
    !isProvenanceResolved(eligibility_provenance) || eligible_component_keys === null ||
    !isProvenanceResolved(survival_provenance) || one_time === 'unclear' || carry_forward === 'unclear'
  return {
    computed_from_component_keys: (source?.computed_from_component_keys as string[] | null | undefined) ?? existing?.computed_from_component_keys ?? null,
    eligible_component_keys,
    eligibility_provenance,
    excluded_component_keys: (source?.excluded_component_keys as string[] | undefined) ?? existing?.excluded_component_keys ?? [],
    one_time,
    carry_forward,
    survival_provenance,
    expiry_periods: (source?.expiry_periods as number | null | undefined) ?? existing?.expiry_periods ?? null,
    availability: 'next_period',
    requires_confirmation: requiresConfirmation,
    confirmation_reason: requiresConfirmation
      ? ((source?.confirmation_reason as string | null | undefined) ?? existing?.confirmation_reason ?? 'Application scope not fully resolved by the contract')
      : null,
  }
}
