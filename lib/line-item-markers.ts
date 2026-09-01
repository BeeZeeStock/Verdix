// Step 17H.4B0D1.1 fix — isRecurringBaseFeeLineItem was originally defined
// in lib/line-items.ts, which imports lib/billing-writer.ts (for
// computeMonthlyBaseRate/computeEscalatorMultiplier/etc.), which in turn
// imports lib/supabase.ts and eagerly constructs `supabaseServer` — a
// service-role Supabase client built from SUPABASE_SERVICE_ROLE_KEY, a
// server-only secret with no NEXT_PUBLIC_ prefix.
//
// lib/tier-escalator-correction.ts is imported directly by
// app/(dashboard)/configure/[id]/page.tsx (a Client Component) and had
// always been safe to import from a client bundle — until 17H.4B0D1.1
// added `import { isRecurringBaseFeeLineItem } from './line-items'` there,
// for classifyTierCorrectionTarget's own base-fee exclusion check. That
// single import transitively pulled the ENTIRE lib/line-items.ts ->
// lib/billing-writer.ts -> lib/supabase.ts chain into the client bundle:
// `supabaseServiceKey` resolves to `undefined` in the browser (only
// NEXT_PUBLIC_* vars are ever inlined client-side), so createClient() threw
// "supabaseKey is required." the moment the module evaluated — a real,
// live runtime crash on the Configure page, not a false alarm.
//
// isRecurringBaseFeeLineItem itself has zero dependencies of its own (pure
// string/regex matching against buildLineItems' own generated marker
// strings) — the problem was purely which FILE it lived in, not the
// function itself. Extracted here, into a module with no imports at all,
// so both lib/line-items.ts (server-side, via buildLineItems) and
// lib/tier-escalator-correction.ts (imported by a client component) can
// depend on it without either pulling server-only code across the client
// boundary. lib/line-items.ts re-exports it from here so every existing
// importer of `isRecurringBaseFeeLineItem` from './line-items' is
// unaffected.
//
// Step 17E, item 4 — the recurring-base-fee block in buildLineItems (the
// ONLY block with a genuinely stale-row risk: an unresolved
// base_fee_proration emits a placeholder row keyed by a fixed product_name
// string, so once the reviewer confirms the proration, the STORED copy of
// that placeholder row must be replaced with the real, now-computable
// schedule) — every product_name that specific block (and only that block —
// never additional_recurring_fees/overage_tiers/one_time_fees/escalators)
// can ever produce, so a caller can identify exactly which stored rows are
// safe to delete-and-replace without touching any other row (including a
// reviewer's own manual per-row corrections on unrelated line items).
export function isRecurringBaseFeeLineItem(productName: string): boolean {
  return productName === 'Base subscription'
    || productName === 'Recurring base fee'
    || productName === 'Recurring base fee — partial-period treatment unresolved'
    || /^Recurring base fee \(periods \d+–\d+\)$/.test(productName)
}
