// Step 17H.4B0B — fail-safe replacement for the one-time-fee↔line_items
// text-match bridge (buildLineItems sets product_name = fee_label for a
// one-time fee, exactly the same fragile-but-only-available bridge tiers
// used before 17H.4A hardened it). The 17H.4B0A lifecycle audit found this
// bridge resolved via a bare `.find()` in THREE independent places
// (lib/billing-execution-plan.ts's due-now snapshot, and two symmetric
// scheduled-row builders each in configureStripe/configureRemembill,
// lib/billing-writer.ts) — silently picking whichever row Postgres happens
// to return first when a job's re-extraction has duplicated a one-time-fee
// line item (see the 17H.4B0A report). That is real, live, unmitigated
// money risk: the due-now snapshot's `amount = li?.total_amount ?? fee.amount`
// can become the literal Stripe/Remembill invoice amount.
//
// Step 17H.4B0D4B0B — now ID-FIRST: line_items.fee_id (populated by
// buildLineItems from contract_terms.one_time_fees[].fee_id, see
// lib/line-items.ts) is the preferred positive association key once it
// exists. product_name/fee_label matching remains the transitional
// fallback for legacy rows that predate fee_id, exactly as
// resolveTierIndexForLineItem/tier_id will eventually parallel for tiers.
// Root cause (line_items duplication itself) is NOT fixed here — that
// remains 17H.4B0A's own follow-up (Model B+ reconciliation). This module
// converts every ambiguity/conflict class into an explicit, safe block,
// never a guess — no new heuristic, no fuzzy matching, no amount/rate
// comparison used for identity.
export type OneTimeLineItemCandidate = {
  id?: string
  product_name: string
  billing_period: string
  unit_price: number
  total_amount: number
  quantity: number
  fee_id?: string | null
}

// The fee this pass resolves against — both the (preferred) positive
// identity and the (transitional fallback) label, always supplied
// together. The resolver owns precedence centrally; callers never choose
// between id-first and label-first themselves.
export interface OneTimeFeeTarget {
  feeId: string | null
  feeLabel: string
}

export type OneTimeLineItemAssociation<T extends OneTimeLineItemCandidate> =
  | { status: 'matched'; item: T }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: T[] }
  // Distinct from 'ambiguous': ambiguous means multiple EQUALLY PLAUSIBLE
  // candidates with no way to prefer one. integrity_conflict means
  // CONTRADICTORY identity evidence exists — a candidate is positively
  // identified as a DIFFERENT fee (a non-null fee_id that isn't the
  // target's). Text can never be trusted to resolve that disagreement; an
  // explicit, non-null identity mismatch is worse than absence, and must
  // never fall back to label matching once it's found.
  | { status: 'integrity_conflict'; candidates: T[] }

// Exactly the case matrix specified for 17H.4B0D4B0B — restated here as
// the implementation, not re-derived at each call site:
//
//   target.feeId present:
//     - exactly one item.fee_id === target.feeId, and no label-matching
//       item has fee_id === null            -> matched (that item)
//     - >1 item.fee_id === target.feeId      -> ambiguous
//     - exactly one item.fee_id === target.feeId, PLUS >=1 label-matching
//       item(s) with fee_id === null         -> ambiguous (an unidentified
//       legacy row could be an older representation of the same fee —
//       execute still inserts unconditionally, so this is real, not
//       hypothetical)
//     - zero item.fee_id === target.feeId, and >=1 label-matching item has
//       a DIFFERENT non-null fee_id          -> integrity_conflict (never
//       falls back to the label-matching NULL rows even if some exist
//       too — an explicit disagreement is never resolved by text)
//     - zero item.fee_id === target.feeId, exactly one label-matching item
//       has fee_id === null, no conflicting non-null label match -> matched
//       (legacy fallback — the intended transitional case)
//     - zero item.fee_id === target.feeId, >1 label-matching items with
//       fee_id === null                      -> ambiguous
//     - none of the above                     -> missing
//
//   target.feeId null (the fee itself predates fee_id):
//     - exactly one label-matching item, fee_id === null -> matched
//       (legacy fallback, both sides unidentified)
//     - exactly one label-matching item, fee_id !== null -> integrity_
//       conflict (the CURRENT fee has no identity to verify an identified
//       row against — never silently borrow a line-item identity by label)
//     - >1 label-matching items (any fee_id)  -> ambiguous
//     - 0 label-matching items                -> missing
//
// A candidate must always be billing_period === 'one_time' — a non-one-time
// row is never considered, id or no id (item 5's structural predicate,
// unchanged from before this pass).
export function resolveOneTimeLineItemAssociation<T extends OneTimeLineItemCandidate>(
  target: OneTimeFeeTarget,
  items: T[],
): OneTimeLineItemAssociation<T> {
  const oneTimeItems = items.filter(item => item.billing_period === 'one_time')
  const labelMatches = oneTimeItems.filter(item => item.product_name === target.feeLabel)
  const labelMatchesNull = labelMatches.filter(item => item.fee_id == null)
  const labelMatchesConflicting = target.feeId
    ? labelMatches.filter(item => item.fee_id != null && item.fee_id !== target.feeId)
    : labelMatches.filter(item => item.fee_id != null)

  if (target.feeId) {
    const idMatches = oneTimeItems.filter(item => item.fee_id === target.feeId)
    if (idMatches.length > 1) return { status: 'ambiguous', candidates: idMatches }
    if (idMatches.length === 1) {
      if (labelMatchesNull.length > 0) return { status: 'ambiguous', candidates: [...idMatches, ...labelMatchesNull] }
      return { status: 'matched', item: idMatches[0] }
    }
    // idMatches.length === 0
    if (labelMatchesConflicting.length > 0) return { status: 'integrity_conflict', candidates: labelMatchesConflicting }
    if (labelMatchesNull.length === 1) return { status: 'matched', item: labelMatchesNull[0] }
    if (labelMatchesNull.length > 1) return { status: 'ambiguous', candidates: labelMatchesNull }
    return { status: 'missing' }
  }

  // target.feeId is null — the current fee itself predates identity.
  if (labelMatches.length === 0) return { status: 'missing' }
  if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches }
  const only = labelMatches[0]
  if (only.fee_id != null) return { status: 'integrity_conflict', candidates: [only] }
  return { status: 'matched', item: only }
}

export const ONE_TIME_ASSOCIATION_BLOCKED_REASON = 'Multiple billing line items match this one-time fee. Billing cannot proceed safely.'
export const ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON = 'A billing line item with a different fee identity matches this one-time fee. Billing cannot proceed safely.'

export interface BlockedOneTimeFee {
  feeLabel: string
  reason: string
}

// The event-gated/manual-trigger "parked" row shape (configureStripe/
// configureRemembill's isHeld loop) — base_amount is ALWAYS fee.amount
// (contract_terms-authoritative, never derived from the line item), so a
// MISSING association never needs to block: it only affects the
// traceability/display fields (line_item_id, unit_price fallback), which
// already degrade gracefully to null/fee.rate_per_unit today. AMBIGUOUS and
// integrity_conflict both still block — never guess which of several
// candidate (or contradictory) rows' unit_price/id to attach.
export type ParkedOneTimeFeeRowResolution =
  | { status: 'ok'; lineItemId: string | null; unitPrice: number | null }
  | { status: 'blocked'; reason: string }

export function resolveParkedOneTimeFeeRowFields<T extends OneTimeLineItemCandidate>(params: {
  feeId: string | null
  feeLabel: string
  fallbackRatePerUnit: number | null
  lineItems: T[]
}): ParkedOneTimeFeeRowResolution {
  const { feeId, feeLabel, fallbackRatePerUnit, lineItems } = params
  const association = resolveOneTimeLineItemAssociation({ feeId, feeLabel }, lineItems)
  if (association.status === 'ambiguous') return { status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON }
  if (association.status === 'integrity_conflict') return { status: 'blocked', reason: ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON }
  const item = association.status === 'matched' ? association.item : null
  return { status: 'ok', lineItemId: item?.id ?? null, unitPrice: item?.unit_price ?? fallbackRatePerUnit ?? null }
}

// The "scheduled" row shape (configureStripe/configureRemembill's
// not-yet-due loop) — here the line item's own total_amount CAN become the
// row's base_amount (`li?.total_amount ?? fee.amount`), so ambiguous AND
// integrity_conflict are both treated as unresolvable: fall through to
// `blocked` rather than letting an arbitrary or contradictory candidate's
// total_amount silently become the charged figure.
export type ScheduledOneTimeFeeRowResolution =
  | { status: 'ok'; baseAmount: number; lineItemId: string | null; quantity: number | null; unitPrice: number | null }
  | { status: 'blocked'; reason: string }

export function resolveScheduledOneTimeFeeRowFields<T extends OneTimeLineItemCandidate>(params: {
  feeId: string | null
  feeLabel: string
  fallbackAmount: number
  lineItems: T[]
}): ScheduledOneTimeFeeRowResolution {
  const { feeId, feeLabel, fallbackAmount, lineItems } = params
  const association = resolveOneTimeLineItemAssociation({ feeId, feeLabel }, lineItems)
  if (association.status === 'ambiguous') return { status: 'blocked', reason: ONE_TIME_ASSOCIATION_BLOCKED_REASON }
  if (association.status === 'integrity_conflict') return { status: 'blocked', reason: ONE_TIME_ASSOCIATION_INTEGRITY_CONFLICT_REASON }
  const item = association.status === 'matched' ? association.item : null
  const hasBreakdown = !!item && item.quantity > 0 && item.unit_price > 0
  return {
    status: 'ok',
    baseAmount: item?.total_amount ?? fallbackAmount,
    lineItemId: item?.id ?? null,
    quantity: hasBreakdown ? item.quantity : null,
    unitPrice: hasBreakdown ? item.unit_price : null,
  }
}
