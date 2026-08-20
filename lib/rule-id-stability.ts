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
