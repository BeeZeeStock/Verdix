// The canonical constructor for ServiceCreditInterpretation — extracted out
// of confirm-rule/route.ts (2026-08-30 follow-up audit) for the same reason
// lib/credit-application-rule.ts / lib/credit-earn-rule.ts were: route.ts
// transitively imports next-auth, which fails to resolve under plain
// vitest, so any logic that needs a direct unit/integration test has to
// live in a plain module.
//
// This is not just "a" builder — grepping the codebase confirms it is the
// ONLY place a ServiceCreditInterpretation object is ever constructed
// (contract-terms.ts/lib/contract-extractor.ts deliberately never
// populates `interpretation` at extraction time — see that file's own
// prompt instruction "Do NOT populate an 'interpretation' field — that is
// filled in only after human review"). Every call site that ends up
// persisting a resolved interpretation — the main "Confirm & apply" flow,
// a "Clear from source" one-click confirm, a free-text Override — funnels
// through this same function, in app/api/jobs/[id]/confirm-rule/route.ts's
// service_credit branch. That means monetary-basis-recognition resolution
// (see below) is not merely "defense in depth" alongside some other path —
// there is no other path, so it is unconditionally exercised every single
// time an interpretation is (re)persisted.
import type { FieldProvenance, ServiceCreditInterpretation } from './types'
import { buildCreditApplicationRule, sanitizeAssertedProvenance } from './credit-application-rule'
import { buildCreditEarnRule } from './credit-earn-rule'
import { resolveMonetaryBasisRecognition } from './monetary-basis-recognition'
import { sourceClauseStatesExplicitNonAgreement } from './rule-interpretation'
import type { ProductionOrganizationResolution } from './rulebook/organization-rulebook-production'

// cash_redeemable (Step 1.5): a three-way value (true / false / 'unclear'),
// never defaulted to false on silence — the exact gap the regression corpus
// surfaced (explicit "not paid in cash" and genuine contract silence
// previously collapsed to the identical false with no way to tell them
// apart). 'unclear' is the correct, honest result of "nothing usable was
// submitted and nothing was already on file" — never silently coerced to
// false. Provenance follows the same never-invent-server-side discipline as
// buildCreditApplicationRule's eligibility_provenance: exactly what THIS
// submission claims, falling back to whatever was already persisted so an
// unrelated later confirm can't downgrade an earlier resolved grading.
export function resolveCashRedeemable(
  approved: Record<string, unknown>,
  existing: ServiceCreditInterpretation | null | undefined,
  cashRedeemableProvenance: FieldProvenance | undefined,
  // Step 16A.1 — the credit's own persisted, extraction-derived
  // source_clause (contract_terms.service_credits[].source_clause), passed
  // by the caller. Never approved.source_clause/existing.source_clause —
  // this must be the one authoritative, unconfirmable-by-a-client text,
  // exactly the same value confirm-rule/route.ts's survival guard already
  // uses (currentCreditSourceClause), not something a request body can
  // shape.
  sourceClause: string | null | undefined,
): { cash_redeemable: ServiceCreditInterpretation['cash_redeemable']; cash_redeemable_provenance: FieldProvenance | null } {
  let cash_redeemable: ServiceCreditInterpretation['cash_redeemable'] =
    typeof approved.cash_redeemable === 'boolean' ? approved.cash_redeemable
      : approved.cash_redeemable === 'unclear' ? 'unclear'
      : existing?.cash_redeemable ?? 'unclear'
  // Step 5C — cash_redeemable has no organization-resolution path at all
  // (not in PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST), so a client
  // claiming 'organization_rulebook' here would be entirely unfounded —
  // same sanitizeAssertedProvenance guard buildCreditApplicationRule uses.
  let cash_redeemable_provenance = sanitizeAssertedProvenance(cashRedeemableProvenance) ?? existing?.cash_redeemable_provenance ?? null

  // Step 16A.1 — authoritative, source-grounded re-validation. Everything
  // above this point trusts client input (today's only reachable path for
  // this field — no reviewer picker exists for cash_redeemable in the UI,
  // unlike survival's explicit carry-forward picker), which means a stale
  // browser tab, a lost proposal-cache write, or any future bug that
  // leaves a stale concrete true/false in a client's in-memory proposal
  // could otherwise get silently and permanently persisted as
  // cash_redeemable: false/true, cash_redeemable_provenance:
  // 'contract_derived' — exactly the original bug this whole effort exists
  // to prevent, just reachable through a different, previously-unguarded
  // door. A reviewer's OWN explicit choice (cash_redeemable_provenance
  // already 'reviewer_policy') is exempt — a human decision resolving a
  // decision_required field is the intended outcome, not something to
  // block; this exemption is forward-looking since no UI path submits
  // 'reviewer_policy' for cash today.
  if (cash_redeemable_provenance !== 'reviewer_policy' && sourceClauseStatesExplicitNonAgreement(sourceClause, 'cash_redeemability')) {
    cash_redeemable = 'unclear'
    cash_redeemable_provenance = null
  }
  return { cash_redeemable, cash_redeemable_provenance }
}

export function buildServiceCreditInterpretation(
  approved: Record<string, unknown>,
  existing: ServiceCreditInterpretation | null | undefined,
  applicationRuleProvenance?: { eligibility?: FieldProvenance; survival?: FieldProvenance },
  cashRedeemableProvenance?: FieldProvenance,
  // Step 5C — pre-computed by the caller (which owns the org-scoped DB
  // lookup) and threaded straight through to buildCreditApplicationRule,
  // the actual enforcement point. See that function's own comment.
  organizationResolution?: ProductionOrganizationResolution,
  // 2026-08-24 audit — provenance for earn_rule.paid_basis_finalization_policy,
  // same never-invent-server-side discipline as applicationRuleProvenance/
  // cashRedeemableProvenance. Only ever 'reviewer_policy' in practice — there
  // is no AI proposal pipeline for this question (see lib/credit-earn-rule.ts).
  earnRuleProvenance?: { paidBasisFinalization?: FieldProvenance },
  // Step 16A.1 — the credit's own persisted source_clause, threaded to
  // resolveCashRedeemable's authoritative re-validation. See that
  // function's own comment for why this must be the caller's
  // server-fetched value, never derived from `approved`.
  sourceClause?: string | null,
): ServiceCreditInterpretation {
  const { cash_redeemable, cash_redeemable_provenance } = resolveCashRedeemable(approved, existing, cashRedeemableProvenance, sourceClause)
  const credit_basis = (approved.credit_basis as ServiceCreditInterpretation['credit_basis']) ?? existing?.credit_basis ?? 'flat_amount'
  const basis_component = (approved.basis_component as string | null) ?? existing?.basis_component ?? null
  // 2026-08-30 correction, widened by the follow-up audit — monetary_basis_
  // recognition (paid vs. component_amount vs. unclear) has NO confirm-
  // rule-driven REVIEWER resolution path: no client-supplied value/
  // provenance is ever accepted here, matching every other never-invent-
  // server-side field in this module. Instead, resolveMonetaryBasisRecognition
  // (lib/monetary-basis-recognition.ts) deterministically re-derives it
  // from the JUST-CONFIRMED basis_component/source_clause on every
  // submission — the same "extraction-time, textual-grounding-only"
  // discipline isServiceCreditFullySourceResolved already uses elsewhere —
  // unless a value is already resolved (contract_derived from a prior
  // derivation, or a one-time reviewed data correction like Contract B's
  // migration), in which case it is NEVER re-derived or overwritten: an
  // unrelated later confirm on this same credit (e.g. resolving paid_
  // basis_finalization_policy) must leave an already-'paid'/
  // 'contract_derived' fact untouched. Because this function is the SOLE
  // constructor of ServiceCreditInterpretation (see this file's own
  // header), this call is not one of several possible paths to
  // resolution — it is unconditionally reached on every single
  // interpretation (re)persistence, fresh or not.
  const { monetary_basis_recognition, monetary_basis_recognition_provenance } = resolveMonetaryBasisRecognition(
    existing,
    { basisComponent: basis_component, sourceClause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null },
  )
  return {
    trigger_type: (approved.trigger_type as ServiceCreditInterpretation['trigger_type']) ?? existing?.trigger_type ?? 'other',
    trigger_description: (approved.trigger_description as string | null) ?? existing?.trigger_description ?? null,
    credit_basis,
    basis_component,
    monetary_basis_recognition,
    monetary_basis_recognition_provenance,
    credit_value: typeof approved.credit_value === 'number' ? approved.credit_value : existing?.credit_value ?? null,
    currency: existing?.currency ?? null,
    cap_amount: (approved.cap_amount as number | null) ?? existing?.cap_amount ?? null,
    cap_pct: (approved.cap_pct as number | null) ?? existing?.cap_pct ?? null,
    settlement_period: (approved.settlement_period as ServiceCreditInterpretation['settlement_period']) ?? existing?.settlement_period ?? null,
    cash_redeemable,
    cash_redeemable_provenance,
    interaction_note: existing?.interaction_note ?? null,
    source_clause: (approved.source_clause as string | undefined) ?? existing?.source_clause ?? null,
    requires_confirmation: false,
    confirmation_reason: null,
    earn_rule: buildCreditEarnRule(
      approved, existing?.earn_rule,
      { creditBasis: credit_basis, basisComponent: basis_component, monetaryBasisRecognition: monetary_basis_recognition, monetaryBasisRecognitionProvenance: monetary_basis_recognition_provenance },
      earnRuleProvenance?.paidBasisFinalization,
    ),
    application_rule: buildCreditApplicationRule(approved, existing?.application_rule, applicationRuleProvenance, organizationResolution),
  }
}
