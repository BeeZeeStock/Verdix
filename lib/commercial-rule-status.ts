// Single shared place that decides whether a contract's commercial rules
// are fully resolved — replaces two previously-independent, disagreeing
// computations: configure/[id]/page.tsx's confidence-score-only `needsReview`
// count (blind to discounts/service credits/interactions entirely) and its
// separate `allCommercialRulesConfirmed` boolean (which never checked
// discounts at all — a contract could show "All commercial rules confirmed"
// with an unresolved introductory discount). Both the workload breakdown and
// the status banner must derive from this one object so they can't disagree
// with each other the way two hand-rolled booleans could.
import { isEscalatorUnresolved, type EscalatorLike } from './escalator-status'
import { findCadenceWindowContaining, isPartialWindow } from './tariff'
import type { FieldProvenance, BillabilityCondition, BillabilityEventType } from './types'
import { getBillabilityExecutionCapability } from './billability-condition'
import { resolveOperationalEventEvidence, type OperationalEventEvidence } from './operational-event-evidence'
import { isMonetaryBasisRecognitionApplicable, isPaidBasisFinalizationApplicable } from './paid-basis-finalization'

// The single place "is this field actually resolved" is decided, for any
// field carrying a FieldProvenance. AI confidence is not provenance: a
// model can return a concrete value ('verdix_recommends' included) without
// that value being grounded in the contract or confirmed by a reviewer —
// only 'contract_derived' (the source states/unambiguously implies it),
// 'reviewer_policy' (a human explicitly confirmed or chose it), or —
// Step 5C — 'organization_rulebook' (an active, applicable Organization
// Rulebook policy filled a field the contract and reviewer left genuinely
// silent on — see lib/rulebook/organization-rulebook-production.ts) clear
// a billing blocker. 'organization_rulebook' is only ever WRITTEN by
// lib/credit-application-rule.ts's buildCreditApplicationRule, and only
// after that same field already failed to resolve via contract_derived/
// reviewer_policy — so accepting it here as resolved does not create a
// second, competing readiness path; it is exactly as authoritative as the
// other two once it is actually present, by construction. Deliberately
// does NOT look at whether a value is present/concrete — see
// CreditApplicationRule's requires_confirmation comment in lib/types.ts
// for why value-presence was the actual bug.
export function isProvenanceResolved(provenance: FieldProvenance | null | undefined): boolean {
  return provenance === 'contract_derived' || provenance === 'reviewer_policy' || provenance === 'organization_rulebook'
}

type UnresolvedFlag = { requires_confirmation: boolean } | null | undefined

// A metric's minimum_commitment record bundles several genuinely
// independent questions behind extraction's own single requires_confirmation
// flag: whether the MODE itself is stated, how the minimum interacts with an
// included allowance (only meaningful if the metric actually has one), and
// whether a partial first/last calendar period prorates. Folding all three
// into one flag meant a metric with an explicit floor and NO allowance at
// all still showed a "how does the minimum interact with the allowance"
// review card, purely because the unrelated partial-period question was
// open — real extracted TEST-PAY-002 data set included_allowance_interaction
// to "unclear" despite there being no allowance tier for the metric at all,
// because the extraction prompt's schema has nowhere else to put "I'm not
// sure this minimum's mechanics are fully settled." isMinimumCommitment
// ModeUnresolved/ProrationUnresolved below split it back into the two
// questions this codebase actually asks as two separate review cards.
type MinimumCommitmentLike = {
  mode?: string | null
  included_allowance_interaction?: 'before_allowance' | 'after_allowance' | 'unclear' | null
  prorate_partial_periods?: boolean | 'unclear' | null
  requires_confirmation: boolean
} | null | undefined

export function isMinimumCommitmentModeUnresolved(mc: MinimumCommitmentLike, hasAllowance: boolean): boolean {
  if (!mc) return false
  if (!mc.mode) return true
  if (hasAllowance && (!mc.included_allowance_interaction || mc.included_allowance_interaction === 'unclear')) return true
  return false
}

// Date-aware: a calendar-anchored metric with prorate_partial_periods still
// unset only genuinely blocks readiness if the contract's own start/end
// dates actually create a partial window under that anchoring — the same
// window check page.tsx's computePartialPeriodMetrics always used, now
// shared here so client and server can never disagree about which metrics
// have a real partial-period question. Without both dates known yet, fails
// toward "ask" rather than assuming resolved, consistent with every other
// confirmation gate in this pipeline.
export function isMinimumCommitmentProrationUnresolved(
  mc: MinimumCommitmentLike,
  hasCalendarAnchor: boolean,
  measurementPeriod: string | null | undefined,
  contractStartDate: string | null | undefined,
  contractEndDate: string | null | undefined,
): boolean {
  if (!mc || !hasCalendarAnchor) return false
  const prorationUnset = mc.prorate_partial_periods == null || mc.prorate_partial_periods === 'unclear'
  if (!prorationUnset) return false
  if (!contractStartDate || !contractEndDate) return true
  const start = new Date(contractStartDate + 'T00:00:00')
  const end   = new Date(contractEndDate + 'T00:00:00')
  const cadence = measurementPeriod ?? 'monthly'
  const firstWindow = findCadenceWindowContaining(start, cadence, start, 'calendar')
  const lastWindow  = findCadenceWindowContaining(start, cadence, end, 'calendar')
  return isPartialWindow(firstWindow, start, end) || isPartialWindow(lastWindow, start, end)
}

type TierLike = {
  unit_type?: string
  rate_per_unit?: number
  minimum_commitment?: MinimumCommitmentLike
  tier_calculation?: UnresolvedFlag
  // Only set to 'calendar' when the contract text explicitly ties this
  // metric's measurement window to calendar boundaries — see OverageTier's
  // own field comment in lib/types.ts. Drives whether a partial-period
  // question exists for this metric's minimum at all.
  reset_anchor?: 'contract_start' | 'calendar' | null
  measurement_period?: string | null
}

type DiscountLike = {
  discount_rule_id?: string
  interpretation?: UnresolvedFlag
}

type CreditLike = {
  credit_rule_id?: string
  // application_rule carries its OWN independent requires_confirmation,
  // separate from the interpretation's own top-level flag — a credit whose
  // trigger/rate/cap are confirmed but whose application scope (what it may
  // reduce, carry-forward) the contract never stated remains a live,
  // unresolved decision even once the top-level flag flips false. See
  // buildCreditApplicationRule (confirm-rule/route.ts) for where this gets
  // set, and the two-state (state/application_state) proposal split in
  // lib/rule-interpretation.ts for where a reviewer can confirm one without
  // the other.
  interpretation?: (UnresolvedFlag & {
    interaction_note?: string | null
    application_rule?: UnresolvedFlag
    // Step 1.5: cash_redeemable's own provenance, gated the same way
    // application_rule's eligibility/survival are — see
    // isServiceCreditUnresolved below and lib/types.ts's
    // ServiceCreditInterpretation.cash_redeemable_provenance.
    cash_redeemable_provenance?: FieldProvenance | null
    // Monetary basis recognition + paid-basis finalization (2026-08-24 ->
    // 2026-08-30 audit) — TWO layered, independent sub-questions, same
    // discipline as application_rule's own eligibility/survival split.
    // credit_basis/basis_component are needed alongside monetary_basis_
    // recognition/earn_rule to decide whether either question even applies
    // (see lib/paid-basis-finalization.ts) — a plain usage-threshold
    // credit never asks either.
    credit_basis?: string | null
    basis_component?: string | null
    monetary_basis_recognition?: 'paid' | 'component_amount' | 'unclear' | null
    monetary_basis_recognition_provenance?: FieldProvenance | null
    earn_rule?: {
      paid_basis_finalization_policy?: 'deadline_cutoff' | 'full_attribution' | null
      paid_basis_finalization_provenance?: FieldProvenance | null
    } | null
  }) | null
}

// Step 1.5.1 — the beginning of a generic "which fields does THIS execution
// path actually need" concept, deliberately small (not a Rulebook). A field
// can be semantically incomplete (unresolved provenance) without that
// incompleteness ever mattering to the execution Verdix is actually
// performing — cash_redeemable is the first real example: Verdix's only
// execution path today applies a service credit against a future invoice,
// which never depends on whether the customer could ALSO have requested
// cash instead. Silence on that separate question is real, honest metadata
// (cash_redeemable stays 'unclear', never manufactured into a reviewer
// decision) — it just isn't a blocker for the path being executed. Add a
// value to this union (and a branch below) the day a real execution path
// actually needs it — e.g. a future 'cash_settlement' context, or a
// reviewer/org-policy request to pay out in cash instead of crediting the
// next invoice — rather than hardcoding "cash never blocks" as a permanent
// special case.
export type ServiceCreditExecutionContext = 'invoice_credit' | 'cash_settlement'

// Which of a service credit's independently-graded sub-questions are
// load-bearing for a GIVEN execution context. eligibility/survival are
// required for every context this codebase can currently execute — you
// cannot apply a credit against a future invoice without knowing what it
// may offset and whether it survives past this application. cash_redeemable
// is only required once the execution context is actually about cash
// settlement — which nothing in this codebase performs today (no code path
// disburses cash; the credit ledger only ever applies against future
// invoices). Once a real cash_settlement execution path exists, whether
// Verdix can actually CARRY OUT a known cash entitlement is a separate,
// not-yet-built capability question (analogous to
// getCreditRepresentationCapability for credit representation) — distinct
// from whether the CONTRACT's own answer is known, which is all this
// function and isServiceCreditUnresolved are about.
export function requiredServiceCreditFields(context: ServiceCreditExecutionContext): Array<'eligibility' | 'survival' | 'cash_redeemable'> {
  if (context === 'cash_settlement') return ['eligibility', 'survival', 'cash_redeemable']
  return ['eligibility', 'survival']
}

// Exported so page.tsx's "Service credits"/"Discounts" section card
// visibility calls this SAME function rather than a separately-written
// (even if currently identical) copy of the expression — the same
// shared-predicate discipline isMinimumCommitmentModeUnresolved/
// isMinimumCommitmentProrationUnresolved already use. Two independent
// implementations of "is this unresolved" is exactly how a card can go
// missing while the canonical count still blocks on it (or vice versa) —
// sharing the function makes that drift impossible by construction rather
// than by both sides happening to agree today.
//
// context defaults to 'invoice_credit' — the only execution path this
// product actually performs today — so every existing caller that doesn't
// pass one keeps behaving correctly without having to know this concept
// exists yet.
export function isServiceCreditUnresolved(credit: CreditLike, context: ServiceCreditExecutionContext = 'invoice_credit'): boolean {
  if (!credit.interpretation || credit.interpretation.requires_confirmation) return true
  // A null/missing application_rule means eligibility/survival were never
  // even asked about — e.g. confirmed via the free-text Override path
  // before it asked these questions (buildServiceCreditPrompt) — distinct
  // from a populated object that's actually resolved. Treating null the
  // same as "resolved" silently hid a real, still-open decision (found
  // live: an Annual Rebate confirmed via Override, whose own AI proposal
  // had separately found survival genuinely unstated, vanished from the
  // review panel entirely once application_rule came back null). Never
  // treat "never asked" as equivalent to "nothing to ask." eligibility and
  // survival are required for every execution context this product can
  // currently produce, so this check is unconditional, not gated by
  // requiredServiceCreditFields.
  if (!credit.interpretation.application_rule || !!credit.interpretation.application_rule.requires_confirmation) return true
  // cash_redeemable_provenance (Step 1.5, refined Step 1.5.1) — only a
  // readiness blocker when THIS execution context actually needs it. For
  // the default/only real context today (invoice_credit), cash_redeemable
  // is never in requiredServiceCreditFields's list, so an unresolved/
  // 'unclear' cash treatment never blocks — it remains visible, honest
  // metadata (never collapsed into false) without reopening an otherwise
  // fully-resolved, already-billing credit. Historical records with no
  // cash_redeemable_provenance at all are therefore safe under the default
  // context — this is what makes the Step 1.5 fix backwards-compatible
  // without lying about their provenance.
  if (requiredServiceCreditFields(context).includes('cash_redeemable') && !isProvenanceResolved(credit.interpretation.cash_redeemable_provenance)) {
    return true
  }
  // Monetary basis recognition (2026-08-30 correction) — WHAT monetary
  // state (paid / component_amount / unclear) a percentage-of-component
  // credit's basis represents is a genuinely separate, PRIOR question to
  // paid-basis-finalization below: never inferred from credit_basis being
  // percentage-typed, and never inferred from the earning engine's own
  // status='paid' query — only monetary_basis_recognition_provenance
  // settles it (contract_derived/reviewer_policy/organization_rulebook).
  // Unresolved (unclear/null/no provenance) is a live blocker whenever the
  // question applies at all — Verdix must not guess payment behavior.
  // 'component_amount' IS itself a resolved answer (never re-blocks
  // ordinary review here) even though it has no verified execution path
  // yet — that distinction, like full_attribution below, is handled
  // separately as a capability blocker in computeCommercialRuleWorkload.
  if (isMonetaryBasisRecognitionApplicable(credit.interpretation) && !isProvenanceResolved(credit.interpretation.monetary_basis_recognition_provenance)) {
    return true
  }
  // Paid-basis finalization (2026-08-24 audit) — a genuinely separate
  // question from whether trigger/rate/cap are settled: WHEN an "actually
  // paid" monetary basis is complete enough to freeze into an immutable
  // earn (see lib/paid-basis-finalization.ts). Only a live blocker when the
  // question actually applies to this credit — isPaidBasisFinalizationApplicable
  // is itself gated on monetary_basis_recognition === 'paid' (resolved), so
  // a component_amount/unclear credit never reaches this check at all.
  // 'full_attribution' IS a resolved reviewer decision (isProvenanceResolved
  // sees 'reviewer_policy') even though Verdix can't yet EXECUTE it — that
  // distinction is handled separately, as a capability blocker, in
  // computeCommercialRuleWorkload below; it must never re-block ordinary
  // review here, or a reviewer's explicit decision would look like it
  // silently reverted.
  if (isPaidBasisFinalizationApplicable(credit.interpretation) && !isProvenanceResolved(credit.interpretation.earn_rule?.paid_basis_finalization_provenance)) {
    return true
  }
  return false
}

export function isDiscountUnresolved(discount: DiscountLike): boolean {
  return !discount.interpretation || !!discount.interpretation.requires_confirmation
}

// Step 17A hardening (review pass 3), item 1 — exported standalone so the
// committed-fixed-fee resolver (lib/committed-fixed-fee-resolver.ts) can
// gate on it exactly like isDiscountUnresolved, without duplicating the
// inline check computeCommercialRuleWorkload already does below. Unlike
// isDiscountUnresolved, ABSENCE (base_fee_proration null/undefined) is NOT
// unresolved — most contracts genuinely have no partial-period question at
// all (see ProrationLike's own field comment); only an EXPLICIT
// requires_confirmation: true counts, whether that question was triggered
// by calendar/contract-start misalignment or by a discount/waiver's own
// stated expiry landing mid-cycle (see lib/contract-extractor.ts's
// base_fee_proration guidance, trigger (b)).
export function isBaseFeeProrationUnresolved(proration: ProrationLike): boolean {
  return !!proration?.requires_confirmation
}

// Step 11 (+ amendments) — OneTimeFee brought into the same readiness
// discipline every sibling commercial-rule type already has, as TWO
// independent questions (item 2/7), never conflated, BOTH now governed by
// the SAME canonical isProvenanceResolved() (no bespoke predicate) and the
// SAME three-state backward-compatibility discriminator:
//   `undefined` — never evaluated under the Step 11(+) lifecycle at all
//                 (every historical record, and any record only ever
//                 touched by an older safety-net revision that predates
//                 this specific field) — NOT reopened; falls back to
//                 requires_confirmation for amount (the original, narrower
//                 Step 11 signal) and is simply not load-bearing for
//                 billability (see below).
//   `null`      — evaluated, genuinely unresolved — a real blocker (unless
//                 manual_trigger is true, for billability specifically —
//                 see below).
//   concrete    — evaluated via isProvenanceResolved(), exactly like any
//                 other FieldProvenance field in this codebase.
//
//   - amount: amount_provenance is now the CANONICAL trust signal (this
//     correction). requires_confirmation remains real UI/workflow
//     metadata (lib/contract-extractor.ts's flagAmbiguousOneTimeFees still
//     sets it for the one genuinely-ambiguous shape, and a route/UI may
//     still read it to decide what to show) but never SUBSTITUTES for
//     provenance once amount_provenance has actually been evaluated
//     (!== undefined) for this record.
//   - billability (the manual_trigger + due_date timing/gating decision):
//     governed by billability_provenance. A concrete due_date is NEVER
//     itself treated as evidence (item 3) — only a real, explicit
//     FieldProvenance value resolves it. manual_trigger: true fees never
//     need this resolved at all (item 6: execution is already safely held
//     by the parked-invoice mechanism — there is no automatic timing
//     decision being made for this shape to gate in the first place).
// A fee flagged unresolved_kind: 'unsupported_semantics' is NOT counted by
// this function at all, regardless of either field above — that case is a
// capability blocker (see oneTimeFeeCapabilityBlockers below), structurally
// separate from an ordinary, reviewer-resolvable ambiguity.
type OneTimeFeeLike = {
  fee_label?: string
  amount?: number
  amount_provenance?: FieldProvenance | null
  manual_trigger?: boolean
  due_date?: string | null
  requires_confirmation?: boolean
  unresolved_kind?: 'needs_review' | 'unsupported_semantics'
  billability_provenance?: FieldProvenance | null
  // Step 12 — see lib/types.ts's OneTimeFee.billability_condition for the
  // full three-state discriminator this drives below.
  billability_condition?: BillabilityCondition | null
  // Step 13 — stable subject identity for operational_event_evidence
  // lookups (lib/types.ts's own comment has the full rationale). Absent
  // for any fee that never entered the Step-12 lifecycle.
  fee_id?: string
}

function isOneTimeFeeAmountUnresolved(fee: OneTimeFeeLike): boolean {
  // Canonically provenance-driven once evaluated; legacy requires_
  // confirmation fallback only for records amount_provenance never touched
  // at all (backward compatibility, item 1).
  if (fee.amount_provenance !== undefined) return !isProvenanceResolved(fee.amount_provenance)
  return !!fee.requires_confirmation
}

// Step 12 — once a record has entered the Step-12 lifecycle
// (billability_condition !== undefined), whether billability still needs a
// reviewer decision is governed by billability_provenance ALONE — never
// gated by manual_trigger. manual_trigger is now purely an execution
// projection (lib/billability-condition.ts), not a semantic signal, so it
// must never be read here to decide whether a Step-12 fee's contractual
// meaning is resolved (item 3: "these meanings must no longer be
// conflated"). Legacy records (billability_condition still undefined) keep
// the EXACT pre-Step-12 manual_trigger-gated check, byte for byte, so
// nothing about this change reopens a historical record (item 19).
function isOneTimeFeeBillabilityUnresolved(fee: OneTimeFeeLike): boolean {
  if (fee.billability_condition !== undefined) {
    return fee.billability_provenance !== undefined && !isProvenanceResolved(fee.billability_provenance)
  }
  return !fee.manual_trigger && fee.billability_provenance !== undefined && !isProvenanceResolved(fee.billability_provenance)
}

export function isOneTimeFeeUnresolved(fee: OneTimeFeeLike): boolean {
  if (fee.unresolved_kind === 'unsupported_semantics') return false
  return isOneTimeFeeAmountUnresolved(fee) || isOneTimeFeeBillabilityUnresolved(fee)
}

export type ProrationLike = { requires_confirmation: boolean } | null | undefined

export type CommercialRuleTerms = {
  overage_tiers?: TierLike[] | null
  escalators?: EscalatorLike[] | null
  discounts?: DiscountLike[] | null
  service_credits?: CreditLike[] | null
  // Job-level (base_fee_proration) and per-fee (additional_recurring_fees[].proration)
  // partial-period ambiguities — genuinely separate from the tier-scoped
  // minimum_commitment/tier_calculation checks above (this can apply even
  // to a contract with no usage-based tiers at all, a flat-fee-only deal).
  base_fee_proration?: ProrationLike
  additional_recurring_fees?: Array<{ fee_label?: string; amount?: number; proration?: ProrationLike }> | null
  // Step 11 — optional so every existing caller/fixture that predates
  // OneTimeFee-awareness keeps behaving identically (absent/empty means
  // zero one-time-fee items counted, exactly like today).
  one_time_fees?: OneTimeFeeLike[] | null
  // Only needed for isMinimumCommitmentProrationUnresolved's date-aware
  // window check — optional so every existing caller/fixture that predates
  // this field keeps working unchanged (missing dates just fail toward
  // "ask", same as an explicitly-unconfirmed rule).
  contract_start_date?: string | null
  contract_end_date?: string | null
}

export type CommercialRuleStatus =
  | 'extraction_complete'
  | 'review_required'
  | 'partially_confirmed'
  | 'ready_for_billing_configuration'
  | 'all_commercial_rules_confirmed'
  // Step 3 (Verdix Global Rulebook activation) — an ACTIVE Rulebook
  // invariant (lib/rulebook/activation.ts's VERDIX_RULEBOOK_ACTIVATION)
  // found the real execution result contradicting the normalized
  // commercial rule (e.g. a normalized floor whose real computed result
  // behaved additively). This is a genuine engine contradiction, never a
  // customer-specific ambiguity — no amount of reviewer confirmation can
  // clear it, so it is never folded into 'review_required' (which implies
  // "a reviewer can pick an option here"). Fails closed until the
  // underlying contradiction is fixed; never silently repaired. Never
  // emitted unless a caller explicitly supplies executionBlockers to
  // computeCommercialRuleWorkload — nothing in production does yet (see
  // that parameter's own comment below), so this status is unreachable
  // today and every existing caller is unaffected.
  | 'execution_blocked'

export type CommercialRuleWorkload = {
  status: CommercialRuleStatus
  // Every rule-level item still needing a reviewer decision (minimum
  // commitments/tier calculations grouped per metric, escalator, discounts,
  // service credits) — does NOT include meter/usage mapping, which item U
  // requires to stay separately labeled ("Usage mapping") rather than mixed
  // into commercial-rule counts.
  totalToConfirm: number
  // Split of totalToConfirm by whether extraction itself flagged the item as
  // genuinely undecidable (confirmation_reason present at extraction time,
  // the same signal flagAmbiguous*'s safety nets already write) vs. left
  // unflagged, which in practice means a reviewer opening it will typically
  // get a Verdix recommendation rather than hit a dead end. A deterministic,
  // no-AI-call approximation — the authoritative state per item is whatever
  // the propose-rule pipeline actually returns when a reviewer opens it.
  readyToConfirm: number
  decisionRequired: number
  interactionsToConfirm: number
  meterMapping: { total: number; confirmed: number }
  // Same treatment as meterMapping — kept as its own bucket rather than
  // folded into totalToConfirm, since VAT is never a contract-derived
  // "commercial rule" (no AI proposal, no Clear-from-source/Verdix-
  // recommendation state; it's a plain user-provided operational input —
  // see lib/vat.ts). Callers combine totalToConfirm + interactionsToConfirm
  // + (meterMapping outstanding) + (vat outstanding) into one canonical
  // "N items to review" count, but each stays separately labeled.
  vat: { configured: boolean }
  // The exact addressing keys behind totalToConfirm — e.g.
  // "service_credit:f2da66fe", "base_fee_proration",
  // "minimum_commitment:transaction" — so a caller (or a debugging session)
  // can see precisely WHICH items make up the count instead of only its
  // size. Does not include meterMapping/vat, which are separate buckets.
  blockers: string[]
  // Step 3 (RulebookInvariantViolationLike) + Step 11
  // (UnsupportedCommercialSemanticsBlocker) — two kinds of "no reviewer
  // confirmation can fix this," kept structurally separate from
  // `blockers`/`totalToConfirm` on purpose: those are reviewer-facing
  // commercial ambiguities a human resolves by picking an option; both
  // items here are cases where picking an option isn't available. A
  // rulebook violation is an engine CONTRADICTION (something computed
  // wrong); an unsupported-semantics blocker is a modeling CAPABILITY GAP
  // (nothing computed wrong — Verdix's schema just can't represent what
  // the source describes yet). Rulebook violations are always [] unless a
  // caller explicitly passes them; unsupported-semantics blockers ARE
  // derived internally, from terms.one_time_fees, by this function itself
  // (see below) — but nothing in production sets unresolved_kind:
  // 'unsupported_semantics' on a real OneTimeFee yet (lib/rulebook/
  // MILESTONE_BILLING_FINDINGS.md), so this is currently always [] too.
  executionBlockers: CommercialRuleExecutionBlocker[]
  // The canonical split of executionBlockers — see classifyExecutionBlockers
  // below for the single implementation both fields are derived from.
  // approvalBlockers genuinely block Approve (rulebook_invariant_violation,
  // unsupported_commercial_semantics) — status becomes 'execution_blocked'
  // if and only if this is non-empty. executionHolds
  // (RequiredOperationalEventMissingBlocker) do NOT block approval — the
  // agreement may still be approved; the affected fee(s) simply park
  // instead of pushing to the provider (lib/billing-writer.ts's
  // isOneTimeFeeHeldForExecution). Every consumer of this workload —
  // server preflight/post-claim recheck, and the UI's readiness/Approve
  // gate — must branch on approvalBlockers, never on the raw
  // executionBlockers array, so they can never diverge again.
  approvalBlockers: CommercialRuleExecutionBlocker[]
  executionHolds: RequiredOperationalEventMissingBlocker[]
  // Convenience booleans over the two arrays above — deliberately BOTH
  // exposed, deliberately NOT interchangeable. See computeCommercialRuleWorkload's
  // own comment for the full rationale.
  //   executionBlocked = executionBlockers.length > 0 — true whenever ANY
  //     execution blocker or hold exists, INCLUDING a plain missing-
  //     evidence hold. An execution-oriented reader asking "is everything
  //     on this contract currently executable" reads this, never
  //     approvalBlocked/status — setting this false is the only thing that
  //     would correctly mean "yes, fully executable."
  //   approvalBlocked = approvalBlockers.length > 0 — true only for a
  //     genuine rulebook contradiction or unsupported-semantics capability
  //     gap; false for a pure execution hold. This is what status/the
  //     Approve gates derive from — approving is safe even when
  //     executionBlocked is still true (the held fee simply parks).
  executionBlocked: boolean
  approvalBlocked: boolean
}

// A rulebook-detected engine contradiction, structurally compatible with
// lib/rulebook/activation.ts's RulebookInvariantExecutionBlocker — but
// intentionally NOT imported from there. This module (already depended on
// by every commercial-rule readiness computation in the product) has zero
// dependency on the optional, removable lib/rulebook/ layer; a real
// RulebookInvariantExecutionBlocker[] is accepted here as-is, by
// structural typing, with no cast required. Same "*Like" convention this
// file already uses for TierLike/DiscountLike/CreditLike.
export type RulebookInvariantViolationLike = {
  type: 'rulebook_invariant_violation'
  rule_id: string
  field: string
  reason: string
}

// Step 11, item 7 — "prefer an execution-capability blocker analogous to
// other unsupported billing capabilities" (see lib/connectors/billing/
// types.ts's CreditRepresentationCapability for the existing small,
// explicit-lookup convention this mirrors) rather than inventing a new
// generic blocker framework, and rather than reusing RulebookInvariantViolationLike
// (a genuinely different kind of "unfixable" — see executionBlockers' own
// comment above). `reason` is always a short, generic, structural
// description — never raw source text (item 7: "do not store raw source
// text in the blocker").
export type UnsupportedCommercialSemanticsBlocker = {
  type: 'unsupported_commercial_semantics'
  rule_family: string
  missing_capability: string
  field: string
  reason: string
}

// Step 12, item 6 — deliberately NOT 'unsupported_commercial_semantics':
// after Step 12, the CONTRACTUAL MEANING of an 'event' condition IS
// supported and, in this state, has already been confirmed
// (billability_provenance is resolved) — see isOneTimeFeeBillabilityUnresolved
// above, which stops counting it as a reviewer decision the moment
// provenance resolves. What's missing is real-world EVIDENCE that the
// event occurred, which is a structurally different kind of "cannot
// execute" than "Verdix cannot represent this at all." `reason` is always a
// short, generic, structural description — never raw source text, same
// discipline as UnsupportedCommercialSemanticsBlocker's own `reason`.
export type RequiredOperationalEventMissingBlocker = {
  type: 'required_operational_event_missing'
  rule_family: string
  event_type: BillabilityEventType
  field: string
  reason: string
}

export type CommercialRuleExecutionBlocker = RulebookInvariantViolationLike | UnsupportedCommercialSemanticsBlocker | RequiredOperationalEventMissingBlocker

function groupTiersByUnitType(tiers: TierLike[]): Map<string, TierLike[]> {
  const groups = new Map<string, TierLike[]>()
  for (const t of tiers) {
    const key = t.unit_type ?? 'Other'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }
  return groups
}

export function computeCommercialRuleWorkload(
  terms: CommercialRuleTerms | null | undefined,
  meterMapping: { total: number; confirmed: number },
  interactionsToConfirm = 0,
  // Extraction-time confirmation_reason presence per item, keyed the same
  // way the item is addressed elsewhere (unit_type for tiers, 'escalator'
  // for the escalator, discount_rule_id/credit_rule_id for those) — passed
  // in rather than re-derived here, since it comes from raw jsonb fields
  // this structural type deliberately doesn't carry.
  flaggedAsAmbiguous: Set<string> = new Set(),
  // Defaults to "configured" so every pre-existing caller/fixture that
  // predates VAT-awareness keeps its exact prior behavior unless it
  // explicitly opts in by passing the job's real VAT status.
  vat: { configured: boolean } = { configured: true },
  // Step 3 — real Rulebook invariant violations (typically produced via
  // lib/rulebook/activation.ts's resolveVerdixRulebookActivation +
  // toRulebookExecutionBlockers), when a caller has them. Defaults to []
  // so every pre-existing caller/fixture — nothing in production computes
  // these yet — keeps its exact prior behavior and status byte-for-byte;
  // this parameter is additive-only. Non-empty forces status to
  // 'execution_blocked' regardless of how resolved every other item is
  // (see the status computation below) — a genuine engine contradiction
  // fails closed even when every reviewer-facing decision is confirmed.
  // Step 11 widened the element type to also accept
  // UnsupportedCommercialSemanticsBlocker — this parameter is still purely
  // caller-supplied Rulebook-side input; the ONE-TIME-FEE capability
  // blockers below are derived internally from `terms` and merged in,
  // never expected here.
  executionBlockers: CommercialRuleExecutionBlocker[] = [],
  // Step 13 — real operational_event_evidence rows for this job, when a
  // caller has them (a route loads them via supabaseServer; a pre-Step-13
  // caller/fixture passing nothing keeps exact Step 12 behavior — every
  // resolved event condition shows the operational-evidence blocker,
  // since no evidence can ever be found in an empty array). Not scoped to
  // one fee — this function itself matches each fee's own fee_id via
  // resolveOperationalEventEvidence.
  operationalEventEvidence: OperationalEventEvidence[] = [],
  // Step 13 — explicit, caller-supplied "now" for evidence future-dating
  // checks (never ambient Date.now() inside this function). Defaults to a
  // fresh Date() only so pre-Step-13 callers/fixtures don't need to know
  // this concept exists yet; every real production call site and every
  // Step 13 test passes an explicit value.
  asOf: Date = new Date(),
): CommercialRuleWorkload {
  const tiers = terms?.overage_tiers ?? []
  const groups = groupTiersByUnitType(tiers)

  let totalItems = 0
  let totalToConfirm = 0
  let readyToConfirm = 0
  let decisionRequired = 0
  const blockers: string[] = []

  const countItem = (key: string, unresolved: boolean) => {
    totalItems++
    if (!unresolved) return
    totalToConfirm++
    blockers.push(key)
    if (flaggedAsAmbiguous.has(key)) decisionRequired++
    else readyToConfirm++
  }

  for (const [unitType, group] of groups) {
    if (group.some(t => t.minimum_commitment !== undefined && t.minimum_commitment !== null)) {
      const mc = group.find(t => t.minimum_commitment)?.minimum_commitment
      const hasAllowance = group.some(t => (t.rate_per_unit ?? 0) === 0)
      const anchorTier = group.find(t => t.reset_anchor === 'calendar')
      // Two independent items, not one — a metric can have its mode/
      // allowance mechanics fully settled while its partial-period
      // treatment is still open, or vice versa. Counting them as a single
      // conflated item is what previously let a genuinely explicit,
      // allowance-free minimum ("max(usage, 66,000) per calendar month")
      // show up as an unresolved allowance-interaction question.
      countItem(`minimum_commitment:${unitType}`, isMinimumCommitmentModeUnresolved(mc, hasAllowance))
      countItem(`partial_period:${unitType}`, isMinimumCommitmentProrationUnresolved(
        mc, !!anchorTier, anchorTier?.measurement_period, terms?.contract_start_date, terms?.contract_end_date,
      ))
    }
    const paidCount = group.filter(t => (t.rate_per_unit ?? 0) > 0).length
    if (paidCount >= 2) {
      const tc = group.find(t => t.tier_calculation)?.tier_calculation
      countItem(`tier_calculation:${unitType}`, !tc || tc.requires_confirmation)
    }
  }

  if (terms?.base_fee_proration) {
    countItem('base_fee_proration', !!terms.base_fee_proration.requires_confirmation)
  }
  for (const fee of terms?.additional_recurring_fees ?? []) {
    if (!fee.proration) continue
    countItem(`recurring_fee_proration:${fee.fee_label}`, !!fee.proration.requires_confirmation)
  }

  const escalator = terms?.escalators?.[0]
  if (escalator) countItem('escalator', isEscalatorUnresolved(escalator))

  for (const d of terms?.discounts ?? []) {
    if (!d.discount_rule_id) continue
    countItem(`discount:${d.discount_rule_id}`, isDiscountUnresolved(d))
  }

  // Paid-basis finalization capability gap (2026-08-24 audit) — structurally
  // distinct from the ordinary review-decision case: 'full_attribution' IS
  // a resolved reviewer decision (isServiceCreditUnresolved never re-blocks
  // it, above), but Verdix has no invoice-terminality model (no cancelled/
  // written-off/void terminal status on planned_invoices) to know when an
  // "all Contract-Year-attributable payments, even late ones" basis is
  // actually complete. This is never silently executed as "wait forever" —
  // it surfaces as the same UnsupportedCommercialSemanticsBlocker shape
  // one_time_fee's unresolved_kind: 'unsupported_semantics' already uses,
  // so it forces status to 'execution_blocked' (never
  // 'all_commercial_rules_confirmed') until the payment-finality model
  // exists, exactly like item 7 of Step 11 above.
  // Monetary basis recognition capability gap (2026-08-30 correction) —
  // same structural shape: 'component_amount' IS a resolved decision
  // (isServiceCreditUnresolved never re-blocks it, above) — the contract
  // is clear that the basis is the stated/invoiced component amount, not a
  // payment-contingent one — but Verdix has no verified execution path for
  // computing that amount today (see lib/credit-ledger-service.ts's
  // runEarningPass, which only implements the paid-status-gated path).
  // Never silently computed as if it were 'paid'.
  const serviceCreditCapabilityBlockers: UnsupportedCommercialSemanticsBlocker[] = []
  for (const c of terms?.service_credits ?? []) {
    if (!c.credit_rule_id) continue
    if (c.interpretation?.monetary_basis_recognition === 'component_amount') {
      serviceCreditCapabilityBlockers.push({
        type: 'unsupported_commercial_semantics',
        rule_family: 'service_credit',
        missing_capability: 'component_amount_monetary_basis',
        field: `service_credit:${c.credit_rule_id}`,
        reason: 'The basis is the stated component amount rather than a payment-contingent one, but Verdix has no verified execution path for computing it yet.',
      })
    }
    if (c.interpretation?.earn_rule?.paid_basis_finalization_policy === 'full_attribution') {
      serviceCreditCapabilityBlockers.push({
        type: 'unsupported_commercial_semantics',
        rule_family: 'service_credit',
        missing_capability: 'paid_basis_full_attribution_finalization',
        field: `service_credit:${c.credit_rule_id}`,
        reason: 'The reviewer chose to include Contract-Year-attributable payments received after the calculation deadline, but Verdix has no invoice-terminality model to determine when that basis is complete.',
      })
    }
    // Unresolved if EITHER the top-level interpretation is still open OR —
    // once that's confirmed — its independent application_rule still is.
    // A credit can be fully confirmed on trigger/rate/cap while its
    // application scope (what it may reduce) remains a real, separate,
    // outstanding decision; the readiness count must not drop it just
    // because the main flag flipped.
    countItem(`service_credit:${c.credit_rule_id}`, isServiceCreditUnresolved(c))
  }

  // Step 11 — OneTimeFee readiness. Addressed by fee_label, the same
  // (documented, imperfect) key lib/billing-writer.ts already uses to
  // identify a specific fee — not a new id scheme; see this codebase's own
  // audit in lib/rulebook/MILESTONE_BILLING_FINDINGS.md for why that's a
  // real, known limitation, not something this step introduces or fixes.
  // Two structurally different outcomes, deliberately not conflated:
  //   - unresolved_kind !== 'unsupported_semantics': an ordinary,
  //     reviewer-resolvable ambiguity — counted exactly like every other
  //     item above (totalToConfirm/blockers/readyToConfirm/decisionRequired).
  //   - unresolved_kind === 'unsupported_semantics': Verdix cannot
  //     represent what the source describes at all — never counted as a
  //     reviewer decision (nothing to pick between); becomes a capability
  //     blocker instead, merged into executionBlockers below.
  //   - Step 12/13: billability_condition.kind === 'event', semantically
  //     RESOLVED (billability_provenance already isProvenanceResolved) —
  //     the contractual meaning is understood, so this is never an
  //     unsupported-semantics capability gap. Whether it still blocks now
  //     depends on Step 13's operational evidence: satisfied trusted
  //     evidence for this fee's own fee_id clears the blocker entirely;
  //     anything else (no evidence, wrong event, wrong subject, revoked,
  //     future-dated) produces RequiredOperationalEventMissingBlocker —
  //     real-world evidence of the event is missing, not the semantics.
  //     Amount is still checked and counted independently either way —
  //     resolving billability's blocker status must never hide an
  //     outstanding amount decision (item 5's independence requirement,
  //     still true post-Step-12/13).
  const oneTimeFeeCapabilityBlockers: Array<UnsupportedCommercialSemanticsBlocker | RequiredOperationalEventMissingBlocker> = []
  for (const fee of terms?.one_time_fees ?? []) {
    if (!fee.fee_label) continue
    if (fee.unresolved_kind === 'unsupported_semantics') {
      oneTimeFeeCapabilityBlockers.push({
        type: 'unsupported_commercial_semantics',
        rule_family: 'one_time_fee',
        missing_capability: 'event_based_billability',
        field: `one_time_fee:${fee.fee_label}`,
        reason: 'The source describes a billability condition this fee shape cannot yet represent.',
      })
      continue
    }
    const capability = fee.billability_condition ? getBillabilityExecutionCapability(fee.billability_condition) : null
    if (capability && !capability.executable && capability.reason === 'requires_operational_event' && isProvenanceResolved(fee.billability_provenance)) {
      // fee.fee_id absent (a Step-12-lifecycle fee predating fee_id, or a
      // defensive gap) means evidence can never be matched — fails closed
      // to "still blocked" rather than risk matching against an empty
      // subjectId.
      const satisfaction = fee.fee_id
        ? resolveOperationalEventEvidence({ condition: fee.billability_condition ?? null, subjectId: fee.fee_id, evidence: operationalEventEvidence, asOf })
        : { required: true as const, satisfied: false as const }
      if (!satisfaction.satisfied) {
        oneTimeFeeCapabilityBlockers.push({
          type: 'required_operational_event_missing',
          rule_family: 'one_time_fee',
          event_type: capability.event_type,
          field: `one_time_fee:${fee.fee_label}`,
          reason: 'Billability is confirmed to depend on an operational event Verdix has not yet observed evidence for.',
        })
      }
      countItem(`one_time_fee:${fee.fee_label}`, isOneTimeFeeAmountUnresolved(fee))
      continue
    }
    countItem(`one_time_fee:${fee.fee_label}`, isOneTimeFeeUnresolved(fee))
  }
  const allExecutionBlockers = [...executionBlockers, ...oneTimeFeeCapabilityBlockers, ...serviceCreditCapabilityBlockers]

  const meterMappingOk = meterMapping.total === 0 || meterMapping.confirmed >= meterMapping.total
  const commercialRulesConfirmed = totalToConfirm === 0 && interactionsToConfirm === 0

  // 'extraction_complete' (nothing has been reviewed at all yet) is not
  // distinguishable from 'review_required' (reviewed, nothing confirmed)
  // from persisted rule state alone — both look identical here. This
  // function never emits 'extraction_complete'; a caller with its own
  // "has anyone opened the review panel yet" signal may downgrade
  // 'review_required' to it for copy purposes.
  //
  // Contract B semantic audit (2026-08-29) — TWO deliberately distinct
  // booleans, never conflated again after the live incident this session
  // already fixed once:
  //   executionBlocked — the ORIGINAL, broader concept ("does ANY current
  //     execution blocker or hold exist" — allExecutionBlockers.length > 0).
  //     True whenever an event-gated fee is currently non-executable for
  //     ANY reason, including a plain missing-evidence hold. An execution-
  //     oriented reader (e.g. a future caller wanting "is everything on
  //     this contract executable right now") should read THIS, not
  //     approvalBlocked — it intentionally still includes holds.
  //   approvalBlocked — status ('execution_blocked'/'all_commercial_rules_
  //     confirmed'/etc.) is an APPROVAL/READINESS signal, not a general
  //     execution status (confirmed by its only two real production
  //     consumers, both approval-time: approve/route.ts's preflight/post-
  //     claim gates, and the Configure page's Approve-button readiness
  //     computation — nothing execution-time, e.g. lib/billing-writer.ts
  //     or the invoice-scheduler, has ever read this workload at all).
  //     approvalBlocked (Step 3, widened Step 11, narrowed Step 13 to
  //     exclude execution holds) is what status derives from, and is
  //     checked FIRST, short-circuiting every other branch, including an
  //     otherwise-fully-confirmed contract — fail closed, per lib/rulebook/
  //     activation.ts's enforce_invariant contract, and per the same
  //     reasoning for a capability gap: no amount of reviewer confirmation
  //     elsewhere can make an unsupported-semantics fee safe to bill.
  // Setting `executionBlocked = false` here NEVER means "everything is
  // executable" — a caller wanting that answer reads executionBlocked
  // (still true for a pure hold) or executionHolds directly, never status/
  // approvalBlocked, which only ever answer the approval question.
  //
  // classifyExecutionBlockers is the ONE canonical split every consumer
  // must use — approve/route.ts's preflight and post-claim fresh check,
  // and app/(dashboard)/configure/[id]/page.tsx's readiness/Approve-button
  // gate — so UI and API can never diverge on this again the way they did
  // live: the UI already correctly surfaced holds as non-blocking
  // ("Ready to approve · N billing condition(s) pending"), while the API's
  // preflight rejected the same job outright.
  const { approvalBlockers, executionHolds } = classifyExecutionBlockers(allExecutionBlockers)
  const executionBlocked = allExecutionBlockers.length > 0
  const approvalBlocked = approvalBlockers.length > 0
  let status: CommercialRuleStatus
  if (approvalBlocked) status = 'execution_blocked'
  else if (commercialRulesConfirmed && meterMappingOk && vat.configured) status = 'all_commercial_rules_confirmed'
  else if (commercialRulesConfirmed) status = 'ready_for_billing_configuration'
  else if (totalToConfirm < totalItems) status = 'partially_confirmed'
  else status = 'review_required'

  return {
    status,
    totalToConfirm,
    readyToConfirm,
    decisionRequired,
    interactionsToConfirm,
    meterMapping,
    vat,
    blockers,
    executionBlockers: allExecutionBlockers,
    approvalBlockers,
    executionHolds,
    executionBlocked,
    approvalBlocked,
  }
}

// The one canonical split of CommercialRuleExecutionBlocker[] into what
// genuinely blocks approval vs. what's merely an execution-time hold —
// see the Contract B comment above computeCommercialRuleWorkload's own use
// of this for the full rationale. Exported separately (not just embedded
// in computeCommercialRuleWorkload) so a caller already holding an
// executionBlockers array (e.g. from a stored/serialized workload) can
// classify it without recomputing the whole workload, and so this is the
// literal single implementation every consumer — server preflight, fresh
// post-claim recheck, and the UI's readiness/Approve-button gate — shares,
// never a second hand-rolled allowlist/filter.
export function classifyExecutionBlockers(executionBlockers: CommercialRuleExecutionBlocker[]): {
  approvalBlockers: CommercialRuleExecutionBlocker[]
  executionHolds: RequiredOperationalEventMissingBlocker[]
} {
  const executionHolds: RequiredOperationalEventMissingBlocker[] = []
  const approvalBlockers: CommercialRuleExecutionBlocker[] = []
  for (const b of executionBlockers) {
    if (b.type === 'required_operational_event_missing') executionHolds.push(b)
    else approvalBlockers.push(b)
  }
  return { approvalBlockers, executionHolds }
}

// Deterministic, extraction-time signal for whether a service credit's
// application scope AND survival/repeatability are ALREADY textually
// resolved in its own persisted source_clause/description — computed from
// already-extracted data alone, never from an AI proposal or review-panel
// interaction. This is what makes the classification stable from the very
// first page load: it does not matter whether, or in what order, a
// reviewer has opened any card, because nothing about opening a card
// changes source_clause/description. Deliberately conservative — modeled
// on the same "require explicit textual grounding" discipline as
// EXCLUSION_LANGUAGE_RE (lib/contract-extractor.ts) and
// buildServiceCreditProposalPrompt's own carry_forward/one_time guidance —
// a false negative (still shown as a "decision" when it could have been a
// confirmation) is the safe failure mode; a false positive is not, so ALL
// of eligibility, carry-forward, and repeatability must have an explicit
// textual marker before this returns true. Verified against TEST-PAY-002's
// real three credits: Growth Credit's clause contains "one-time" (in its
// description), "may be applied only against" (eligibility), and "will
// carry forward" (survival) — all three markers, so it classifies as
// resolved. The Annual Rebate and Service Credit clauses both state
// eligibility explicitly but contain no carry-forward language at all —
// genuinely silent on that question — so neither classifies as resolved,
// matching their real decision_required survival_state.
const ONE_TIME_MARKER_RE = /\bone[\s-]time\b/i
// A trigger window the contract itself defines as recurring (e.g. "each
// consecutive 12-month period... or an anniversary") is textual grounding
// that the SAME earning event is not a single, one-off occurrence — see
// buildServiceCreditProposalPrompt's identical guidance for why this is
// evidence, not silence.
const RECURRING_DEFINED_TERM_RE = /\beach\s+consecutive\b|\bany\s+calendar\b|\bthe\s+applicable\s+calendar\b/i
const CARRY_FORWARD_MARKER_RE = /\bcarr(?:y|ies)\s+forward\b/i
const ELIGIBILITY_MARKER_RE = /\bapplies?\s+only\s+to\b|\bapplied\s+only\s+against\b|\bmay\s+be\s+applied\s+(?:only\s+)?against\b|\bapplied\s+against\b|\bdoes\s+not\s+apply\s+to\b/i

export function isServiceCreditFullySourceResolved(credit: { source_clause?: string | null; description?: string | null }): boolean {
  const text = `${credit.description ?? ''} ${credit.source_clause ?? ''}`
  const hasEligibilityMarker = ELIGIBILITY_MARKER_RE.test(text)
  const hasSurvivalMarker = CARRY_FORWARD_MARKER_RE.test(text) && (ONE_TIME_MARKER_RE.test(text) || RECURRING_DEFINED_TERM_RE.test(text))
  return hasEligibilityMarker && hasSurvivalMarker
}

// Presentational split of an already-computed blocker count — never changes
// totalToConfirm/blockers itself, only distinguishes "genuinely needs a
// reviewer decision among options" from "already fully source-resolved,
// just needs a single Confirm & apply click" (e.g. Growth Credit). Scoped
// to service_credit keys today, the exact case this distinction exists
// for; other item types (base_fee_proration, partial_period, ...) don't
// yet have an equivalent deterministic textual-resolution signal, so they
// stay classified as decisions rather than risk a wrong guess.
export function countSourceConfirmations(
  blockers: string[],
  serviceCredits: Array<{ credit_rule_id?: string; source_clause?: string | null; description?: string | null }> | null | undefined,
): number {
  if (!serviceCredits) return 0
  let count = 0
  for (const key of blockers) {
    if (!key.startsWith('service_credit:')) continue
    const id = key.slice('service_credit:'.length)
    const credit = serviceCredits.find(c => c.credit_rule_id === id)
    if (credit && isServiceCreditFullySourceResolved(credit)) count++
  }
  return count
}
