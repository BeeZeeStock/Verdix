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

type UnresolvedFlag = { requires_confirmation: boolean } | null | undefined

type TierLike = {
  unit_type?: string
  rate_per_unit?: number
  minimum_commitment?: UnresolvedFlag
  tier_calculation?: UnresolvedFlag
}

type DiscountLike = {
  discount_rule_id?: string
  interpretation?: UnresolvedFlag
}

type CreditLike = {
  credit_rule_id?: string
  interpretation?: (UnresolvedFlag & { interaction_note?: string | null }) | null
}

export type CommercialRuleTerms = {
  overage_tiers?: TierLike[] | null
  escalators?: EscalatorLike[] | null
  discounts?: DiscountLike[] | null
  service_credits?: CreditLike[] | null
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
): CommercialRuleWorkload {
  const tiers = terms?.overage_tiers ?? []
  const groups = groupTiersByUnitType(tiers)

  let totalItems = 0
  let totalToConfirm = 0
  let readyToConfirm = 0
  let decisionRequired = 0

  const countItem = (key: string, unresolved: boolean) => {
    totalItems++
    if (!unresolved) return
    totalToConfirm++
    if (flaggedAsAmbiguous.has(key)) decisionRequired++
    else readyToConfirm++
  }

  for (const [unitType, group] of groups) {
    if (group.some(t => t.minimum_commitment !== undefined && t.minimum_commitment !== null)) {
      const mc = group.find(t => t.minimum_commitment)?.minimum_commitment
      countItem(`minimum_commitment:${unitType}`, !!mc?.requires_confirmation)
    }
    const paidCount = group.filter(t => (t.rate_per_unit ?? 0) > 0).length
    if (paidCount >= 2) {
      const tc = group.find(t => t.tier_calculation)?.tier_calculation
      countItem(`tier_calculation:${unitType}`, !tc || tc.requires_confirmation)
    }
  }

  const escalator = terms?.escalators?.[0]
  if (escalator) countItem('escalator', isEscalatorUnresolved(escalator))

  for (const d of terms?.discounts ?? []) {
    if (!d.discount_rule_id) continue
    countItem(`discount:${d.discount_rule_id}`, !d.interpretation || d.interpretation.requires_confirmation)
  }

  for (const c of terms?.service_credits ?? []) {
    if (!c.credit_rule_id) continue
    countItem(`service_credit:${c.credit_rule_id}`, !c.interpretation || c.interpretation.requires_confirmation)
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
  if (commercialRulesConfirmed && meterMappingOk) status = 'all_commercial_rules_confirmed'
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
  }
}
