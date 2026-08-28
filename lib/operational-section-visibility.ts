// Step 17F.8, item 1/10 (revised 17F.9, items 1/2) — pure, testable
// predicates behind the contract GUI's persistent operating sections
// (Billing periods, Operational inputs, Performance share, Commercial
// monitoring) and the "Configured in <platform>" badge.
//
// hasOperationalBillingModel answers "has this contract reached a real
// operational billing model" — a STICKY fact, distinct from
// reviewComplete (a point-in-time snapshot that can flip back to false
// the moment ANY new review item surfaces, e.g. a re-extraction or a
// newly-typed decision like fixed_fee_billing_timing).
//
// Step 17F.9, item 2 — hasPersistedSchedule (at least one real
// planned_invoices row exists), NOT billing_customer_id, is the sticky
// signal: traced through lib/billing-writer.ts and confirmed
// billing_customer_id is persisted the moment a Remembill/Stripe
// CUSTOMER is created — the very FIRST push operation — before any
// invoice/schedule row exists. A push that fails on the next operation
// (e.g. the first invoice-creation call) leaves billing_customer_id set
// with zero planned_invoices rows: a job in that state has NOT entered
// operational billing, and must not be presented as one. A real,
// persisted schedule is the durable fact that means "operational" —
// reused from GET /api/jobs/[id]'s own existence check, no new schema
// field. OR-ed with reviewComplete so a contract that has never been
// pushed but IS fully reviewed still sees these (the original 17E.1
// intent, preserved).
export function hasOperationalBillingModel(params: {
  reviewComplete: boolean
  hasPersistedSchedule: boolean | null | undefined
}): boolean {
  return params.reviewComplete || !!params.hasPersistedSchedule
}

// Step 17F.9, item 1 — "Configured in Remembill" states a fact about the
// EXTERNAL platform (a push already happened) that must never be
// retracted once true — but must not read as "current Verdix commercial
// configuration is fully executable" when it isn't. Reuses the SAME
// aggregate blocker count already driving the page's "N items to
// review" callout (commercial decisions + usage mappings + VAT + etc,
// lib/commercial-rule-status.ts-derived) — never a second, narrower,
// independently-computed count. reviewComplete alone under-counted: a
// contract with 0 commercial decisions outstanding but 1 unmapped usage
// source is NOT fully configured, yet reviewComplete (commercial-rule
// status only) would have called it done. Suffix-only (never replaces
// the base label) so "Configured in Remembill" stays true and visible;
// only the qualifier changes.
export function configuredBadgeSuffix(totalOutstanding: number): string {
  return totalOutstanding > 0 ? ' · Action required' : ''
}
