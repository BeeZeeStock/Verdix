import type { CreditApplicationRule } from './types'

type PriorityCredit = { credit_rule_id: string; application_rule: CreditApplicationRule }

export type CreditPriorityNeed =
  | { needed: false }
  | { needed: true; conflictingIds: string[]; recommendedOrder: string[] | null }

// Effective eligible set for overlap purposes: 'all' is a wildcard (matches
// anything not explicitly excluded); a concrete list is exactly that list
// minus whatever it explicitly excludes. excluded is kept alongside 'all'
// rules too (not just folded into keys) since an 'all' rule has no concrete
// key list to fold it into.
type Eligibility = { isAll: boolean; keys: Set<string>; excluded: Set<string> }

function effectiveEligible(rule: CreditApplicationRule): Eligibility {
  const excluded = new Set(rule.excluded_component_keys)
  if (rule.eligible_component_keys === 'all') {
    return { isAll: true, keys: new Set(), excluded }
  }
  const keys = new Set(rule.eligible_component_keys ?? [])
  for (const key of excluded) keys.delete(key)
  return { isAll: false, keys, excluded }
}

function overlaps(a: Eligibility, b: Eligibility): boolean {
  if (a.isAll && b.isAll) return true // can't prove disjoint without knowing the full component universe
  if (a.isAll) return [...b.keys].some(key => !a.excluded.has(key))
  if (b.isAll) return [...a.keys].some(key => !b.excluded.has(key))
  for (const key of a.keys) if (b.keys.has(key)) return true
  return false
}

// true when `narrow` is entirely contained within `broad`'s reach — 'all' is
// broader than any concrete set; a concrete set is narrower than 'all' and
// than any concrete superset of itself.
function isNarrowerThan(narrow: ReturnType<typeof effectiveEligible>, broad: ReturnType<typeof effectiveEligible>): boolean {
  if (narrow.isAll) return false // 'all' is never narrower than anything
  if (broad.isAll) return true
  for (const key of narrow.keys) if (!broad.keys.has(key)) return false
  return narrow.keys.size < broad.keys.size
}

// Array order in ContractTerms.service_credits is NOT a business rule — this
// is the deterministic replacement: only credits with a fully-resolved
// application_rule are considered (an unresolved one is already blocked from
// application on its own, so it can't yet compete for anything), and
// priority is only ever "needed" when two or more of THOSE credits could
// actually draw from the same component.
export function detectCreditPriorityNeed(credits: PriorityCredit[]): CreditPriorityNeed {
  const resolvable = credits.filter(c => !c.application_rule.requires_confirmation)
  if (resolvable.length < 2) return { needed: false }

  const eligibility = new Map(resolvable.map(c => [c.credit_rule_id, effectiveEligible(c.application_rule)]))

  const conflicting = new Set<string>()
  for (let i = 0; i < resolvable.length; i++) {
    for (let j = i + 1; j < resolvable.length; j++) {
      const a = resolvable[i], b = resolvable[j]
      if (overlaps(eligibility.get(a.credit_rule_id)!, eligibility.get(b.credit_rule_id)!)) {
        conflicting.add(a.credit_rule_id)
        conflicting.add(b.credit_rule_id)
      }
    }
  }
  if (conflicting.size === 0) return { needed: false }

  const conflictingIds = [...conflicting]

  // Only ever recommend an order for the simple, unambiguous two-credit
  // case where one is a strict subset of the other (nowhere else it could
  // draw from). Three or more conflicting credits, or two whose scopes
  // aren't in a clean subset relationship, is a genuine Decision required —
  // never guessed by trying to construct a total order across an ambiguous
  // set.
  let recommendedOrder: string[] | null = null
  if (conflictingIds.length === 2) {
    const [idA, idB] = conflictingIds
    const a = eligibility.get(idA)!, b = eligibility.get(idB)!
    if (isNarrowerThan(a, b)) recommendedOrder = [idA, idB]
    else if (isNarrowerThan(b, a)) recommendedOrder = [idB, idA]
  }

  return { needed: true, conflictingIds, recommendedOrder }
}
