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
  interpretation?: (UnresolvedFlag & { interaction_note?: string | null; application_rule?: UnresolvedFlag }) | null
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
export function isServiceCreditUnresolved(credit: CreditLike): boolean {
  return !credit.interpretation || credit.interpretation.requires_confirmation || !!credit.interpretation.application_rule?.requires_confirmation
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
  let status: CommercialRuleStatus
  if (commercialRulesConfirmed && meterMappingOk && vat.configured) status = 'all_commercial_rules_confirmed'
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
  }
}
