import type { CreditEarnRule, FieldProvenance, ServiceCreditInterpretation } from './types'
import { isProvenanceResolved } from './commercial-rule-status'
import { sanitizeAssertedProvenance } from './credit-application-rule'
import { isPaidBasisFinalizationApplicable } from './paid-basis-finalization'

// earn_rule: when/how this credit is earned. Extracted out of
// confirm-rule/route.ts (2026-08-24 audit) — same reason lib/credit-
// application-rule.ts was: route.ts transitively imports next-auth, which
// fails to resolve under plain vitest, so any logic that needs a unit test
// has to live in a plain module. Every field except paid_basis_
// finalization_* keeps the exact explicit-fields/existing-fallback
// discipline it always had, with requires_confirmation hardcoded false —
// trigger/rate/window/deadline have no separate ambiguity gate of their
// own the way application_rule's eligibility/survival do.
//
// paid_basis_finalization_policy/provenance are the one exception, and are
// gated exactly like CreditApplicationRule's eligibility_provenance/
// survival_provenance: requires_confirmation is DERIVED from provenance,
// not hardcoded, but ONLY when the question is even applicable to this
// credit (see lib/paid-basis-finalization.ts) — a credit with no paid
// monetary basis at all must never show as needing this decision. Never
// invents provenance server-side: `paidBasisFinalizationProvenance` mirrors
// exactly what THIS submission claims (only ever 'reviewer_policy', minted
// by the dedicated Paid-basis finalization review card — there is no AI
// proposal pipeline for this question, so nothing ever asserts
// 'verdix_recommends' or 'contract_derived' through this parameter), never
// invented from the mere presence of a calculation-deadline clause.
export function buildCreditEarnRule(
  approved: Record<string, unknown>,
  existing: CreditEarnRule | null | undefined,
  // The interpretation-level facts that decide whether paid-basis
  // finalization is even a live question for this credit — passed in
  // rather than re-derived here, since credit_basis/basis_component live
  // one level up, on ServiceCreditInterpretation, not on CreditEarnRule
  // itself.
  context: {
    creditBasis?: string | null; basisComponent?: string | null
    // 2026-08-30 correction — isPaidBasisFinalizationApplicable now gates
    // on monetary_basis_recognition (resolved to 'paid'), never on
    // credit_basis type alone. These two are threaded through unchanged
    // from whatever buildServiceCreditInterpretation already resolved for
    // this same submission — this function never re-derives them.
    monetaryBasisRecognition?: ServiceCreditInterpretation['monetary_basis_recognition']
    monetaryBasisRecognitionProvenance?: FieldProvenance | null
  },
  paidBasisFinalizationProvenance?: FieldProvenance,
): CreditEarnRule | null {
  const source = approved.earn_rule as Record<string, unknown> | undefined
  if (!source && !existing) return null

  const finalization_deadline_days = typeof source?.finalization_deadline_days === 'number' ? source.finalization_deadline_days : existing?.finalization_deadline_days ?? null

  const paid_basis_finalization_policy =
    (source?.paid_basis_finalization_policy as CreditEarnRule['paid_basis_finalization_policy'] | undefined) ?? existing?.paid_basis_finalization_policy ?? null
  // 'organization_rulebook' is structurally excluded by sanitizeAssertedProvenance
  // — there is no organization-resolution path for this field (it is not in
  // PRODUCTION_ORGANIZATION_RULEBOOK_ALLOWLIST), so a client asserting it would
  // be entirely unfounded, exactly like buildCreditApplicationRule's own guard.
  const paid_basis_finalization_provenance = sanitizeAssertedProvenance(paidBasisFinalizationProvenance) ?? existing?.paid_basis_finalization_provenance ?? null

  const paidBasisApplicable = isPaidBasisFinalizationApplicable({
    credit_basis: context.creditBasis, basis_component: context.basisComponent,
    monetary_basis_recognition: context.monetaryBasisRecognition,
    monetary_basis_recognition_provenance: context.monetaryBasisRecognitionProvenance,
    earn_rule: { paid_basis_finalization_policy: paid_basis_finalization_policy ?? null, paid_basis_finalization_provenance: paid_basis_finalization_provenance ?? null },
  })
  const requiresConfirmation = paidBasisApplicable && !isProvenanceResolved(paid_basis_finalization_provenance)

  return {
    trigger_metric_key: (source?.trigger_metric_key as string | null | undefined) ?? existing?.trigger_metric_key ?? null,
    trigger_quantity: typeof source?.trigger_quantity === 'number' ? source.trigger_quantity : existing?.trigger_quantity ?? null,
    trigger_comparator: (source?.trigger_comparator as CreditEarnRule['trigger_comparator']) ?? existing?.trigger_comparator ?? 'gt',
    trigger_window: (source?.trigger_window as CreditEarnRule['trigger_window']) ?? existing?.trigger_window ?? 'billing_period',
    consecutive_windows_required: typeof source?.consecutive_windows_required === 'number' ? source.consecutive_windows_required : existing?.consecutive_windows_required ?? 1,
    window_anchor: (source?.window_anchor as CreditEarnRule['window_anchor']) ?? existing?.window_anchor ?? 'contract_start',
    finalization_deadline_days,
    quantity_treatment: (source?.quantity_treatment as CreditEarnRule['quantity_treatment']) ?? existing?.quantity_treatment,
    paid_basis_finalization_policy,
    paid_basis_finalization_provenance,
    requires_confirmation: requiresConfirmation,
    confirmation_reason: requiresConfirmation
      ? 'The contract does not specify how to treat Contract-Year fees paid after the calculation deadline.'
      : null,
  }
}
