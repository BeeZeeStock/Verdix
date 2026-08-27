// Step 17A hardening (review pass 2, 3 + 4) — the single, reusable
// readiness-aware resolver for an agreement's committed fixed fees. Every
// user-facing surface that presents this figure (the per-job Contract page,
// the "New contracts" list, the Agreements dashboard, the admin customers
// page) must go through this function so they can never disagree — one
// surface can never show "Not yet determinable" while another shows a raw
// €24,000 for the same agreement.
//
// Deliberately a thin composition, not new logic: computeCommittedFixedFees
// (lib/contract-tcv-calc.ts) stays the dumb summation it always was, and
// isDiscountUnresolved/isBaseFeeProrationUnresolved (lib/commercial-rule-
// status.ts) stay the existing, already-established "does this rule still
// need a reviewer decision" predicates used everywhere else in this
// codebase.
//
// Review pass 4, item 1 — MATERIALITY, not blanket blocking: an unresolved
// decision withholds this figure only when it is genuinely CAPABLE of
// changing it. A discount's own scope ambiguity (e.g. "does this pilot
// waiver also cover the performance component?") does not affect the
// fixed-fee component's own value when that component's rate is already
// concretely stated (a 100% waiver of a named component is 100% regardless
// of what else might also be covered) — see
// discountMateriallyAffectsFixedFee. The pilot's own EXISTENCE/duration and
// the separate partial-period-treatment question (base_fee_proration)
// remain fully blocking, since those genuinely do change the amount.
//
// Review pass 4, item 2 — once ready, the amount returned is whatever
// `items` (built by the SAME buildLineItems/computeMonthlyBaseRate/
// computeDiscountMultiplier the real billing schedule uses — see
// lib/billing-writer.ts) actually computed — never a value invented here.
// If a CONFIRMED decision selects a treatment the deterministic engine
// cannot yet compute (day-level proration for a non-calendar-anchored fee
// — see requiresUnsupportedDayLevelProration), status stays 'unresolved'
// with an honest capability-gap reason rather than silently reusing a
// number that doesn't reflect the confirmed choice.
import { assessCommittedFixedFeeReadiness, type BaseTcvItem } from './contract-tcv-calc'
import { isDiscountUnresolved, isBaseFeeProrationUnresolved } from './commercial-rule-status'

export interface CommittedFixedFeeResolution {
  status: 'ready' | 'unresolved'
  amount: number | null
  reasons: string[]
}

// Deliberately structural, not lib/types.ts's Discount — callers include
// both the canonical ContractTerms shape and looser page-local client-side
// Discount shapes (which predate/duplicate it with optional fields); both
// satisfy this minimal shape without needing type unification.
export interface CommittedFixedFeeDiscountLike {
  interpretation?: { requires_confirmation: boolean } | null
  description?: string | null
  applies_to?: string | null
  discount_pct?: number | null
  discount_amount?: number | null
  // Step 17A hardening (review pass 6 + 7) — TYPED component targeting
  // (see lib/types.ts's Discount.affected_components/
  // possibly_affected_components doc). This pair, never applies_to's free
  // text, is the sole authority for materiality below.
  affected_components?: string[] | null
  possibly_affected_components?: string[] | null
}

// The stable component key this resolver cares about — kept as a single
// named constant (not repeated string literals) so any other module
// wiring in affected_components uses the identical key.
export const BASE_RECURRING_FEE_COMPONENT = 'base_recurring_fee'

export interface CommittedFixedFeeProrationLike {
  requires_confirmation: boolean
  reset_anchor?: 'contract_start' | 'calendar' | null
  prorate_partial_periods?: boolean | 'unclear' | null
}

// Step 17A hardening (review pass 7), item 1 — FAIL-CLOSED tri-state
// classification, not a binary "does it reference the component" check.
// Three states:
//   'definitely_affects'         — affected_components includes the
//                                  component: the contract/a reviewer has
//                                  positively confirmed this discount
//                                  touches it.
//   'definitely_does_not_affect' — TYPED targeting is present (at least
//                                  one of affected_components/
//                                  possibly_affected_components is a real
//                                  array, even an empty one) and NEITHER
//                                  names the component: a positive,
//                                  structural statement that this discount
//                                  has nothing to do with it.
//   'unknown'                    — either the component is only in
//                                  possibly_affected_components (a live,
//                                  unresolved scope question), OR neither
//                                  typed field was ever populated at all
//                                  (a legacy/pre-typed-targeting discount
//                                  — this MUST fail closed rather than be
//                                  read as "not material," which would
//                                  silently under-protect every agreement
//                                  extracted before these fields existed).
export type FixedFeeMaterialityClassification = 'definitely_affects' | 'definitely_does_not_affect' | 'unknown'

export function classifyFixedFeeMateriality(discount: CommittedFixedFeeDiscountLike): FixedFeeMaterialityClassification {
  if (discount.affected_components?.includes(BASE_RECURRING_FEE_COMPONENT)) return 'definitely_affects'
  if (discount.possibly_affected_components?.includes(BASE_RECURRING_FEE_COMPONENT)) return 'unknown'
  const typedTargetingPresent = discount.affected_components != null || discount.possibly_affected_components != null
  return typedTargetingPresent ? 'definitely_does_not_affect' : 'unknown'
}

// Materiality is decided STRUCTURALLY from typed component targeting,
// never inferred from applies_to's wording at calculation time.
// affected_components/possibly_affected_components are set at extraction
// time (when the contract text unambiguously names a component) or by a
// reviewer's confirmed interpretation (natural-language input compiled
// into this same typed shape during the propose/confirm flow — see
// lib/rule-interpretation.ts and app/api/jobs/[id]/confirm-rule/route.ts)
// — this function only reads the result.
export function discountMateriallyAffectsFixedFee(discount: CommittedFixedFeeDiscountLike): boolean {
  const classification = classifyFixedFeeMateriality(discount)
  if (classification === 'definitely_does_not_affect') return false
  if (classification === 'unknown') return true // fail closed
  // 'definitely_affects' — a concrete discount_pct/discount_amount already
  // determines the exact effect on this NAMED, definitely-included
  // component, regardless of any remaining ambiguity about whether the
  // discount also extends to some OTHER component (tracked separately in
  // possibly_affected_components) — that remaining ambiguity is a real,
  // separate open question (it can still block broader things: overall
  // agreement approval, a performance-fee component, total economic
  // value), just not THIS specific, already-determined figure.
  const rateIsConcrete = discount.discount_pct != null || discount.discount_amount != null
  return !rateIsConcrete
}

// Even once CONFIRMED (requires_confirmation: false), a
// prorate_partial_periods: true choice for a non-calendar-anchored fee
// needs DAY-level granularity the deterministic engine's month-cursor-based
// evaluation (lib/billing-writer.ts's computeMonthlyBaseRate/
// computeDiscountMultiplier, one cursor date per whole month) cannot
// produce — only the calendar-anchored schedule path has real day-level
// proration (applyProrationRule, gated on reset_anchor === 'calendar').
// Rather than silently reusing the coarser month-toggle number for a
// choice that was actually supposed to be finer-grained, this keeps the
// figure unresolved with an honest capability-gap reason.
export function requiresUnsupportedDayLevelProration(proration: CommittedFixedFeeProrationLike | null | undefined): boolean {
  if (!proration || proration.requires_confirmation) return false
  return proration.reset_anchor !== 'calendar' && proration.prorate_partial_periods === true
}

export function resolveCommittedFixedFeeValue(
  items: BaseTcvItem[],
  discounts: CommittedFixedFeeDiscountLike[] | null | undefined,
  baseFeeProration?: CommittedFixedFeeProrationLike | null,
  recurringFeeProrations?: Array<{ fee_label?: string | null; proration?: CommittedFixedFeeProrationLike | null }> | null,
): CommittedFixedFeeResolution {
  const reasons = (discounts ?? [])
    .filter(isDiscountUnresolved)
    .filter(discountMateriallyAffectsFixedFee)
    .map(d => `"${d.description}" (${d.applies_to}) is Decision Required — materially affects the fixed platform fee`)

  if (isBaseFeeProrationUnresolved(baseFeeProration)) {
    reasons.push('Partial-period treatment for the fixed platform fee is Decision Required — how the fee applies once a waiver/discount period ends mid-cycle is not yet confirmed')
  } else if (requiresUnsupportedDayLevelProration(baseFeeProration)) {
    reasons.push('Confirmed day-level proration for the fixed platform fee is not yet supported by the billing engine for a non-calendar-anchored fee')
  }
  for (const fee of recurringFeeProrations ?? []) {
    if (isBaseFeeProrationUnresolved(fee.proration)) {
      reasons.push(`Partial-period treatment for "${fee.fee_label ?? 'a recurring fee'}" is Decision Required`)
    } else if (requiresUnsupportedDayLevelProration(fee.proration)) {
      reasons.push(`Confirmed day-level proration for "${fee.fee_label ?? 'a recurring fee'}" is not yet supported by the billing engine`)
    }
  }

  const readiness = assessCommittedFixedFeeReadiness(items, reasons)
  return {
    status: readiness.status === 'unresolved' ? 'unresolved' : 'ready',
    amount: readiness.amount,
    reasons: readiness.reasons,
  }
}
