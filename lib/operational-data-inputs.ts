// Step 17B0, item G — extracted from app/api/jobs/[id]/meter-mappings/
// route.ts so it's directly unit-testable, same convention lib/line-items.ts
// and lib/discount-component-targeting.ts already established (pure logic
// in lib/, route files consume it — no precedent in this codebase for
// mocking supabaseServer to test a route handler directly).
//
// A required_operational_inputs entry that isn't represented by any
// overage_tiers unit_type at all (e.g. a monetary running total a
// derived-rate fee depends on) never becomes a meter-mapping suggestion —
// nothing in that route's existing meter-picker machinery fits a value
// that isn't a countable usage meter. This collects every
// required_operational_inputs entry across the WHOLE contract — not just
// overage_tiers, the only array the meter picker itself ever reads — so a
// real operational dependency on additional_recurring_fees/one_time_fees/
// unsupported_commercial_mechanisms is never silently invisible.
//
// This never decides HOW to map any of them (no meter abstraction fits a
// monetary running total, and building that mapping mechanism is out of
// scope here) — purely a visibility list.

export type OperationalDataInput = { key: string; kind: 'monetary' | 'countable'; sources: string[] }

// Bounded naming-convention heuristic, not a closed enum
// (required_operational_inputs are free-form extracted labels — see
// lib/types.ts) — errs toward 'countable' (the existing, already-handled
// shape) when genuinely ambiguous, only flagging the unmistakably monetary
// cases as needing a different kind of data source entirely.
export function isMonetaryOperationalInput(key: string): boolean {
  return /(_value|_amount|_total|_price)(_|$)/i.test(key)
}

export function collectOperationalDataInputs(terms: {
  overage_tiers?: Array<{ unit_type?: string; tier_label?: string; required_operational_inputs?: string[] | null }> | null
  additional_recurring_fees?: Array<{ fee_label?: string; required_operational_inputs?: string[] | null; derived_metric?: { raw_inputs?: string[] } | null }> | null
  one_time_fees?: Array<{ fee_label?: string; required_operational_inputs?: string[] | null }> | null
  unsupported_commercial_mechanisms?: Array<{ kind?: string; required_operational_inputs?: string[] | null }> | null
}): OperationalDataInput[] {
  const bySource = new Map<string, Set<string>>()
  const add = (inputs: string[] | null | undefined, source: string) => {
    for (const key of inputs ?? []) {
      if (!bySource.has(key)) bySource.set(key, new Set())
      bySource.get(key)!.add(source)
    }
  }
  for (const t of terms.overage_tiers ?? []) add(t.required_operational_inputs, `overage_tiers: ${t.tier_label ?? t.unit_type ?? 'unlabeled tier'}`)
  for (const f of terms.additional_recurring_fees ?? []) {
    add(f.required_operational_inputs, `additional_recurring_fees: ${f.fee_label ?? 'unlabeled fee'}`)
    add(f.derived_metric?.raw_inputs, `additional_recurring_fees: ${f.fee_label ?? 'unlabeled fee'} (derived_metric)`)
  }
  for (const f of terms.one_time_fees ?? []) add(f.required_operational_inputs, `one_time_fees: ${f.fee_label ?? 'unlabeled fee'}`)
  for (const m of terms.unsupported_commercial_mechanisms ?? []) add(m.required_operational_inputs, `unsupported_commercial_mechanisms: ${m.kind ?? 'unlabeled mechanism'}`)
  return Array.from(bySource.entries())
    .map(([key, sources]) => ({ key, kind: (isMonetaryOperationalInput(key) ? 'monetary' : 'countable') as 'monetary' | 'countable', sources: Array.from(sources) }))
    .sort((a, b) => a.key.localeCompare(b.key))
}
