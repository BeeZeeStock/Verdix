// Deterministic pre-filter for rule interactions — finds pairs of
// money-affecting commercial rules that reference the same fee component
// over an overlapping period (e.g. a service credit computed as "10% of
// that month's platform subscription fee" while a 25% introductory discount
// is also active on the platform subscription). Pure, client-safe, same
// discipline as lib/tariff.ts.
//
// Scope for this pass: service_credit vs discount, and service_credit vs
// escalator. The detection logic itself is pairwise/generic (keyword +
// date-window overlap, not hardcoded to any one contract or rule pair), but
// only ServiceCreditInterpretation currently has an interaction_note field
// to resolve into (see lib/types.ts) — a discount/escalator ordering check
// with nowhere to persist its resolution isn't wired up yet.
// Structural, minimal shapes — only the fields this detector actually reads.
// Deliberately NOT imported from lib/types.ts: a couple of call sites (e.g.
// configure/[id]/page.tsx) keep their own locally-defined Discount/Escalator/
// ServiceCredit types that are structurally close but not identical, and
// this detector should work against either without forcing them into one
// shared type.
type CreditLike = {
  credit_rule_id?: string
  description?: string | null
  interpretation?: { basis_component?: string | null } | null
}
type DiscountLike = {
  discount_rule_id?: string
  description?: string | null
  applies_to?: string | null
  start_date?: string | null
  end_date?: string | null
  interpretation?: { applies_to?: string | null } | null
}
type EscalatorLike = {
  description?: string | null
  effective_date?: string | null
  interpretation?: { calculation_method?: string | null } | null
}

export type RuleInteractionTerms = {
  service_credits?: CreditLike[] | null
  discounts?: DiscountLike[] | null
  escalators?: EscalatorLike[] | null
}

export type InteractionRuleRef =
  | { ruleType: 'discount'; id: string; label: string }
  | { ruleType: 'escalator'; id: string; label: string }

export type RuleInteractionCandidate = {
  // Stable, order-independent key so re-running detection against the same
  // contract state always produces the same address for the same pair —
  // used as the synthetic contract_unit_type in the audit table, same
  // pattern as `discount:{id}` / `credit:{id}`.
  interactionKey: string
  creditId: string
  creditLabel: string
  otherRule: InteractionRuleRef
  overlapReason: string
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'from', 'this', 'fee', 'fees', 'charge', 'charges',
  'amount', 'amounts', 'month', 'monthly', 'period', 'applicable', 'applies', 'apply',
  'shall', 'will', 'contract', 'agreement', 'customer', 'service', 'services',
])

function significantWords(text: string | null | undefined): Set<string> {
  if (!text) return new Set()
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? []
  return new Set(words.filter(w => !STOPWORDS.has(w)))
}

function textsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = significantWords(a)
  if (wa.size === 0) return false
  const wb = significantWords(b)
  for (const w of wa) if (wb.has(w)) return true
  return false
}

// Null bounds are treated as unbounded (-Infinity / +Infinity) — a service
// credit has no date fields of its own (it's an ongoing clause), so its
// "window" is always open-ended and the check reduces to "is the other
// rule's window non-empty", which is trivially true for anything with a
// defined date. Kept as an explicit range check (rather than skipped) so it
// generalizes correctly if ServiceCredit ever gains its own date bounds.
function rangesOverlap(aStart: string | null | undefined, aEnd: string | null | undefined, bStart: string | null | undefined, bEnd: string | null | undefined): boolean {
  const toTime = (d: string | null | undefined, fallback: number) => (d ? new Date(d).getTime() : fallback)
  const aS = toTime(aStart, -Infinity)
  const aE = toTime(aEnd, Infinity)
  const bS = toTime(bStart, -Infinity)
  const bE = toTime(bEnd, Infinity)
  return aS <= bE && bS <= aE
}

export function detectRuleInteractionCandidates(terms: RuleInteractionTerms): RuleInteractionCandidate[] {
  const candidates: RuleInteractionCandidate[] = []
  const credits = terms.service_credits ?? []
  const discounts = terms.discounts ?? []
  const escalators = terms.escalators ?? []

  for (const credit of credits) {
    const creditId = credit.credit_rule_id
    if (!creditId) continue
    // Prefer the resolved basis_component once interpreted, but fall back
    // to the raw extracted description so a candidate can surface even
    // before the credit's own interpretation is confirmed — the interaction
    // review doesn't require either side to be locked in first.
    const creditDescription = credit.description ?? ''
    const creditText = credit.interpretation?.basis_component ?? creditDescription

    for (const discount of discounts) {
      const discountId = discount.discount_rule_id
      if (!discountId) continue
      const discountText = discount.interpretation?.applies_to ?? discount.applies_to ?? discount.description
      if (!textsOverlap(creditText, discountText)) continue
      if (!rangesOverlap(null, null, discount.start_date, discount.end_date)) continue
      candidates.push({
        interactionKey: `service_credit:${creditId}|discount:${discountId}`,
        creditId,
        creditLabel: creditDescription,
        otherRule: { ruleType: 'discount', id: discountId, label: discount.description ?? '' },
        overlapReason: `Service credit "${creditDescription}" and discount "${discount.description ?? ''}" both reference the same fee component, and the discount is active during an overlapping period.`,
      })
    }

    for (const escalator of escalators) {
      const escalatorDescription = escalator.description ?? ''
      const escalatorText = escalator.interpretation?.calculation_method ?? escalatorDescription
      if (!textsOverlap(creditText, escalatorText)) continue
      const escId = escalator.effective_date ?? escalatorDescription.slice(0, 24) ?? 'unscheduled'
      candidates.push({
        interactionKey: `service_credit:${creditId}|escalator:${escId}`,
        creditId,
        creditLabel: creditDescription,
        otherRule: { ruleType: 'escalator', id: escId, label: escalatorDescription },
        overlapReason: `Service credit "${creditDescription}" and the price escalator both reference the same fee component.`,
      })
    }
  }

  return candidates
}
