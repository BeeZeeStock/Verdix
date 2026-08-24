// Monetary basis recognition + paid-basis finalization (Contract B audit,
// 2026-08-24 -> 2026-08-30) — TWO separate, layered questions for any
// credit whose earn amount is a percentage of some named component:
//
//   1. isMonetaryBasisRecognitionApplicable / monetary_basis_recognition —
//      WHAT MONETARY STATE does the percentage apply to: amounts actually
//      PAID, the stated/invoiced COMPONENT_AMOUNT regardless of payment,
//      or genuinely UNCLEAR? This is a fact about the CONTRACT, resolved
//      via monetary_basis_recognition_provenance — never inferred from
//      credit_basis being percentage-typed, and never inferred from the
//      fact that lib/credit-ledger-service.ts's
//      sumPaidComponentAmountForWindow happens to query status='paid'
//      today. An execution-engine implementation detail is not evidence of
//      contract semantics — conflating the two was the exact bug this
//      correction fixes (it previously meant EVERY percentage-of-component
//      credit was treated as paid-basis, including synthetic fixtures
//      whose source never said "paid" at all).
//
//   2. isPaidBasisFinalizationApplicable / paid_basis_finalization_policy —
//      only reachable once (1) has resolved to 'paid': WHEN is that paid
//      basis complete enough to freeze? finalization_deadline_days
//      (lib/types.ts) is the source's own CALCULATION-TIMING obligation
//      ("calculate within N days") — it says nothing about which payments
//      belong in the basis; see this function's own header history below.
//
// This module is the single place both distinctions are computed, shared
// by the confirm-rule builder (lib/credit-earn-rule.ts /
// app/api/jobs/[id]/confirm-rule/route.ts), the readiness/workload
// computation (lib/commercial-rule-status.ts), and the earning engine's
// fail-closed gate (lib/credit-ledger-service.ts) — so all three can never
// independently disagree about which credits either question applies to.
//
// Deliberately does NOT import from lib/commercial-rule-status.ts (which
// itself imports these functions below) — that would create a module
// cycle. isProvenanceResolved is cheap enough that both of this module's
// consumers (commercial-rule-status.ts, credit-earn-rule.ts) just import
// it directly from its own canonical home instead of round-tripping
// through here.
import type { CreditEarnRule, ServiceCreditInterpretation, FieldProvenance } from './types'

type MonetaryBasisInterpretationLike = {
  credit_basis?: ServiceCreditInterpretation['credit_basis'] | string | null
  basis_component?: string | null
  monetary_basis_recognition?: ServiceCreditInterpretation['monetary_basis_recognition']
  monetary_basis_recognition_provenance?: FieldProvenance | null
  earn_rule?: Pick<CreditEarnRule, 'paid_basis_finalization_policy' | 'paid_basis_finalization_provenance'> | null
}

// True for any credit whose earn amount is a percentage of a named
// component — i.e. any credit that NEEDS a monetary_basis_recognition
// classification at all, regardless of what that classification turns out
// to be. A plain usage-threshold/flat/per-unit credit never asks this
// question — surfacing it there would ask a reviewer to resolve an
// ambiguity their contract doesn't actually have.
export function isMonetaryBasisRecognitionApplicable(interp: MonetaryBasisInterpretationLike): boolean {
  return !!interp.basis_component
    && (interp.credit_basis === 'pct_of_affected_component' || interp.credit_basis === 'pct_of_period_fee')
}

function isMonetaryBasisRecognitionResolved(interp: MonetaryBasisInterpretationLike): boolean {
  return interp.monetary_basis_recognition_provenance === 'contract_derived'
    || interp.monetary_basis_recognition_provenance === 'reviewer_policy'
    || interp.monetary_basis_recognition_provenance === 'organization_rulebook'
}

// True only once monetary_basis_recognition has been resolved to 'paid' —
// this is the sole trusted input; NEVER derived from credit_basis type
// alone (2026-08-30 correction). A credit whose basis is genuinely
// component_amount or unclear never asks the paid-basis-finalization
// question at all — it has its own, separate execution/capability gate
// (see canFreezeMonetaryBasisEarn below).
export function isPaidBasisFinalizationApplicable(interp: MonetaryBasisInterpretationLike): boolean {
  return isMonetaryBasisRecognitionApplicable(interp)
    && isMonetaryBasisRecognitionResolved(interp)
    && interp.monetary_basis_recognition === 'paid'
}

// The single fail-closed gate lib/credit-ledger-service.ts's runEarningPass
// consults before ever writing an immutable 'earn' row for a percentage-
// of-component credit. Pure and DB-free so the decision itself is unit-
// testable even though runEarningPass's actual insert is not (same
// DB-coupled/no-mocking-harness disclosure as every other imperative
// function in that file). Layered exactly as this module's own header
// describes:
//   - Not a percentage-of-component credit at all (isMonetaryBasisRecognition
//     Applicable false) -> nothing to gate here; true.
//   - monetary_basis_recognition unresolved (unclear/null/no provenance) ->
//     Verdix does not know what monetary state the basis even represents;
//     guessing payment behavior is exactly what this correction exists to
//     prevent. Never freeze. false.
//   - 'component_amount' -> a real, resolved decision, but Verdix has no
//     verified execution path for it today (see lib/commercial-rule-
//     status.ts's capability-blocker handling) — never silently computed
//     as if it were 'paid'. Never freeze. false.
//   - 'paid' -> defer to the paid-basis-finalization sub-question:
//       - 'deadline_cutoff' -> freeze at the calculation deadline using
//         whatever's paid by then; true.
//       - null (unresolved) -> the source is silent and no reviewer has
//         decided; never freeze — the sweep keeps rediscovering this
//         window every day until a decision exists. false.
//       - 'full_attribution' -> a real, preserved reviewer decision, but
//         Verdix has no invoice-terminality model to know when that basis
//         is complete. Never silently reinterpreted as "wait forever until
//         every invoice is somehow known to be settled." false.
export function canFreezeMonetaryBasisEarn(interp: MonetaryBasisInterpretationLike): boolean {
  if (!isMonetaryBasisRecognitionApplicable(interp)) return true
  if (!isMonetaryBasisRecognitionResolved(interp)) return false
  if (interp.monetary_basis_recognition !== 'paid') return false // 'component_amount' — capability-blocked, see above
  return interp.earn_rule?.paid_basis_finalization_policy === 'deadline_cutoff'
}
