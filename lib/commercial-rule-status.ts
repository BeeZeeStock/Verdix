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
import type { FieldProvenance } from './types'

// The single place "is this field actually resolved" is decided, for any
// field carrying a FieldProvenance. AI confidence is not provenance: a
// model can return a concrete value ('verdix_recommends' included) without
// that value being grounded in the contract or confirmed by a reviewer —
// only 'contract_derived' (the source states/unambiguously implies it) or
// 'reviewer_policy' (a human explicitly confirmed or chose it) clear a
// billing blocker. Deliberately does NOT look at whether a value is
// present/concrete — see CreditApplicationRule's requires_confirmation
// comment in lib/types.ts for why value-presence was the actual bug.
export function isProvenanceResolved(provenance: FieldProvenance | null | undefined): boolean {
  return provenance === 'contract_derived' || provenance === 'reviewer_policy'
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
  return false
}

export function isDiscountUnresolved(discount: DiscountLike): boolean {
  return !discount.interpretation || !!discount.interpretation.requires_confirmation
}

type ProrationLike = { requires_confirmation: boolean } | null | undefined

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
  // Step 3 — a rulebook-detected engine contradiction (see
  // lib/rulebook/activation.ts's RulebookInvariantExecutionBlocker), kept
  // structurally separate from `blockers`/`totalToConfirm` on purpose:
  // those are reviewer-facing commercial ambiguities a human resolves by
  // picking an option; this is an execution contradiction no reviewer
  // confirmation can fix. Always [] unless a caller explicitly passes real
  // violations via computeCommercialRuleWorkload's executionBlockers
  // parameter — nothing in production does yet.
  executionBlockers: RulebookInvariantViolationLike[]
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
  executionBlockers: RulebookInvariantViolationLike[] = [],
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

  for (const c of terms?.service_credits ?? []) {
    if (!c.credit_rule_id) continue
    // Unresolved if EITHER the top-level interpretation is still open OR —
    // once that's confirmed — its independent application_rule still is.
    // A credit can be fully confirmed on trigger/rate/cap while its
    // application scope (what it may reduce) remains a real, separate,
    // outstanding decision; the readiness count must not drop it just
    // because the main flag flipped.
    countItem(`service_credit:${c.credit_rule_id}`, isServiceCreditUnresolved(c))
  }

  const meterMappingOk = meterMapping.total === 0 || meterMapping.confirmed >= meterMapping.total
  const commercialRulesConfirmed = totalToConfirm === 0 && interactionsToConfirm === 0

  // 'extraction_complete' (nothing has been reviewed at all yet) is not
  // distinguishable from 'review_required' (reviewed, nothing confirmed)
  // from persisted rule state alone — both look identical here. This
  // function never emits 'extraction_complete'; a caller with its own
  // "has anyone opened the review panel yet" signal may downgrade
  // 'review_required' to it for copy purposes.
  //
  // executionBlocked (Step 3) is checked FIRST and short-circuits every
  // other branch, including an otherwise-fully-confirmed contract — fail
  // closed, per lib/rulebook/activation.ts's enforce_invariant contract.
  // Always false unless a caller explicitly passes real executionBlockers.
  const executionBlocked = executionBlockers.length > 0
  let status: CommercialRuleStatus
  if (executionBlocked) status = 'execution_blocked'
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
    executionBlockers,
  }
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
