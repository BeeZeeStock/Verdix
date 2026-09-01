// Step 17H.4B0D4H1B4E3.4 — ID-first association bridge for the
// additional_recurring_fixed/additional_recurring_variable line-item
// families, mirroring lib/one-time-line-item-resolution.ts's
// resolveOneTimeLineItemAssociation exactly (same case matrix, same
// ambiguous/integrity_conflict distinction, same fail-closed discipline) —
// a deliberately separate module, not a generalization of that one, per
// this codebase's own established convention (see lib/rule-id-stability.ts's
// preserveTierIdentity: "Deliberately NOT a copy of ... — different family,
// different available typed evidence").
//
// recurring_fee_id (contract_terms.additional_recurring_fees[].
// recurring_fee_id, projected onto line_items.recurring_fee_id by
// buildLineItems) is the preferred positive association key once it
// exists — assigned unconditionally at extraction time (assignRecurringFeeIds)
// and restored across re-extraction via a typed structural fingerprint
// (lib/rule-id-stability.ts's preserveRecurringFeeIdentity), never by label.
// product_name/fee_label matching remains ONLY the transitional fallback for
// line_items rows that predate this column (created before this migration) —
// once a row has a real recurring_fee_id, that id is authoritative forever;
// label is never consulted again for that row.
export type RecurringFeeLineItemCandidate = {
  id?: string
  product_name: string
  billing_period: string
  quantity: number
  recurring_fee_id?: string | null
}

export interface RecurringFeeTarget {
  recurringFeeId: string | null
  feeLabel: string
}

export type RecurringFeeLineItemAssociation<T extends RecurringFeeLineItemCandidate> =
  | { status: 'matched'; item: T }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'integrity_conflict'; candidates: T[] }

// Candidates are restricted to non-one_time, non-tier rows the caller has
// already classified into an additional_recurring_* family — this module
// does not itself re-derive family membership (that stays
// classifyLineItemFamily's own job in the planner).
export function resolveRecurringFeeLineItemAssociation<T extends RecurringFeeLineItemCandidate>(
  target: RecurringFeeTarget,
  items: T[],
): RecurringFeeLineItemAssociation<T> {
  const labelMatches = items.filter(item => item.product_name === target.feeLabel)
  const labelMatchesNull = labelMatches.filter(item => item.recurring_fee_id == null)
  const labelMatchesConflicting = target.recurringFeeId
    ? labelMatches.filter(item => item.recurring_fee_id != null && item.recurring_fee_id !== target.recurringFeeId)
    : labelMatches.filter(item => item.recurring_fee_id != null)

  if (target.recurringFeeId) {
    const idMatches = items.filter(item => item.recurring_fee_id === target.recurringFeeId)
    if (idMatches.length > 1) return { status: 'ambiguous', candidates: idMatches }
    if (idMatches.length === 1) {
      if (labelMatchesNull.length > 0) return { status: 'ambiguous', candidates: [...idMatches, ...labelMatchesNull] }
      return { status: 'matched', item: idMatches[0] }
    }
    if (labelMatchesConflicting.length > 0) return { status: 'integrity_conflict', candidates: labelMatchesConflicting }
    if (labelMatchesNull.length === 1) return { status: 'matched', item: labelMatchesNull[0] }
    if (labelMatchesNull.length > 1) return { status: 'ambiguous', candidates: labelMatchesNull }
    return { status: 'missing' }
  }

  // target.recurringFeeId is null — the fresh fee itself has no id (should
  // not happen for a modern extraction; defensive only).
  if (labelMatches.length === 0) return { status: 'missing' }
  if (labelMatches.length > 1) return { status: 'ambiguous', candidates: labelMatches }
  const only = labelMatches[0]
  if (only.recurring_fee_id != null) return { status: 'integrity_conflict', candidates: [only] }
  return { status: 'matched', item: only }
}
