// Re-extraction previously assigned every discount/service-credit a brand
// new random id every time (lib/contract-extractor.ts's assign*RuleIds only
// ever backfills a MISSING id — nothing upstream of it ever looked at what a
// prior extraction already had). That silently orphaned any already-reviewed
// .interpretation and the commercial_rule_interpretations audit rows that
// address their subject via discount:{id}/credit:{id}. This is the fix: match
// a newly-extracted item back to an existing one by exact description text
// (the same deterministic key mergeExtractions' own dedupe already uses — no
// fuzzy matching, no new heuristic) and carry its id + interpretation
// forward. An item whose description changed materially is treated as a new
// item — it gets a fresh id and no interpretation, which is what correctly
// blocks it from billing until a reviewer re-confirms it (never silently
// continuing to bill under the old, now-stale interpretation).
export function preserveStableRuleIds<
  T extends { description: string; interpretation?: unknown },
  K extends 'discount_rule_id' | 'credit_rule_id',
>(existingItems: T[], newItems: (T & Partial<Record<K, string>>)[], idField: K): (T & Record<K, string | undefined>)[] {
  const existingByDescription = new Map(existingItems.map(item => [item.description, item]))
  return newItems.map(item => {
    const existing = existingByDescription.get(item.description) as (T & Partial<Record<K, string>>) | undefined
    if (!existing || !existing[idField]) return item
    return { ...item, [idField]: existing[idField], interpretation: existing.interpretation }
  })
}

// Step 13 final amendment — the identical problem, for OneTimeFee.fee_id.
// Step 13 introduced fee_id specifically so operational_event_evidence has
// a stable subject to key against; without this function, EVERY
// re-extraction assigned a fresh fee_id (lib/contract-extractor.ts's
// normalizeBillabilityCondition only ever backfills a MISSING id, exactly
// like assignDiscountRuleIds/assignServiceCreditRuleIds), silently
// orphaning any already-recorded evidence and already-confirmed billability
// interpretation the moment a job was re-extracted.
//
// Reuses the EXACT same technique as preserveStableRuleIds above — match by
// exact description text, the same deterministic key mergeExtractions' own
// dedupe uses — never fee_label (Step 11 already documented fee_label as
// collision-prone; Step 13's final amendment explicitly forbids solving
// this with label matching), and never fuzzy/heuristic matching of any
// kind. A OneTimeFee has no nested `.interpretation` the way a discount/
// credit does — its reviewed state is several discrete fields — so this
// carries all of them forward together, atomically, rather than just one id
// field.
//
// The chosen invariant, REVISED (Step 13 final amendment, Part B / item 12
// — "whether reviewed-state preservation was too broad"). The first version
// of this function preserved ALL reviewed state unconditionally on an exact
// description match — but a match on description text is NOT a guarantee
// that the new extraction's concrete amount/condition are still what a
// reviewer actually reviewed. lib/commercial-rule-status.ts's
// isOneTimeFeeAmountUnresolved and isOneTimeFeeBillabilityUnresolved treat
// amount_provenance and billability_provenance/billability_condition as two
// fully INDEPENDENT axes (a fee can be amount-resolved while billability
// stays unresolved, and vice versa) — so this function now grants
// preservation per axis, not as one all-or-nothing bundle:
//
//   - fee_id ALWAYS carries forward on a description match. This is
//     contractual-CLAUSE identity ("same clause slot"), not a claim that
//     its reviewed state still holds — evidence stays addressable under a
//     stable subject id regardless of what changed about the fee's other
//     fields. If the condition's event_type changes (below), old evidence
//     naturally, correctly stops matching via resolveOperationalEventEvidence's
//     own subjectId+eventType check — no special-casing needed here.
//   - amount_provenance/requires_confirmation/unresolved_kind/
//     confirmation_reason (the amount axis) carry forward ONLY when the
//     newly extracted `amount` is IDENTICAL to what was reviewed. A
//     reviewer confirmed a SPECIFIC number; if re-extraction (LLM
//     non-determinism, or a genuine contract amendment) produces a
//     different number under the same description text, that new number
//     was never reviewed and must re-enter review with a reset state —
//     exactly like a changed description does, just scoped to this axis.
//   - billability_provenance/billability_condition (the billability axis)
//     carry forward ONLY when the newly extracted condition is
//     STRUCTURALLY IDENTICAL to what was reviewed. Same reasoning: a
//     reviewer confirmed a specific trigger (e.g. customer_acceptance), not
//     "whatever event this clause implies next time."
//
// A fee whose description changed materially is still treated as fully new
// (existing.fee_id is never found, so neither axis nor fee_id carries
// forward) — unchanged from the original invariant. This is NOT a silent
// loss in any case: the OLD fee_id's operational_event_evidence rows remain
// permanently, immutably preserved in the database (append-only, never
// deleted) — simply no longer reachable/matching once the concrete fact
// they attest to has changed — and any reset axis cannot accept new
// evidence or reach billing until a reviewer re-confirms it from scratch
// (lib/commercial-rule-status.ts's readiness gate, and the attest route's
// own commercial_interpretation_unresolved check, both already require this
// regardless). The reviewer is always presented with a fresh, visibly
// unconfirmed item for whichever axis changed — nothing pretends stale
// review still applies to new facts.
export function preserveOneTimeFeeIdentity<
  T extends {
    description: string | null
    amount: number
    fee_id?: string
    amount_provenance?: unknown
    billability_provenance?: unknown
    billability_condition?: unknown
    requires_confirmation?: boolean
    unresolved_kind?: unknown
    confirmation_reason?: string | null
  },
>(existingItems: T[], newItems: T[]): T[] {
  const existingByDescription = new Map(existingItems.map(item => [item.description, item]))
  return newItems.map(item => {
    const existing = existingByDescription.get(item.description)
    if (!existing || !existing.fee_id) return item

    const result: T = { ...item, fee_id: existing.fee_id }

    if (existing.amount === item.amount) {
      result.amount_provenance = existing.amount_provenance
      result.requires_confirmation = existing.requires_confirmation
      result.unresolved_kind = existing.unresolved_kind
      result.confirmation_reason = existing.confirmation_reason
    }

    if (JSON.stringify(existing.billability_condition ?? null) === JSON.stringify(item.billability_condition ?? null)) {
      result.billability_provenance = existing.billability_provenance
      result.billability_condition = existing.billability_condition
    }

    return result
  })
}
