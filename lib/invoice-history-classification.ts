// Step 17F.9, item 1 — the sole predicate deciding whether a billing-
// timeline entry belongs under "Invoice history" (a real object the
// provider created) or "Planned schedule" (a bare local planned_invoices
// projection, no provider object yet). Driven ENTIRELY by the entry's own
// lifecycle status — never by calendar date. A row held by the
// fixed-fee-timing scheduler gate (lib/fixed-fee-invoice-scheduling.ts)
// can carry a planned date already in the past while genuinely never
// having been transmitted; classifying by date alone would have promoted
// it into "Invoice history" the moment its date passed, contradicting
// what actually happened.
export function isGenuinelyIssuedInvoice(status: string | null | undefined): boolean {
  return status === 'paid' || status === 'failed' || status === 'open' || status === 'sent'
}

// Step 17H.2A item 18 — the sole discriminator app/api/jobs/[id]/manual-
// invoice/route.ts's push path writes and this predicate reads, so a
// presentation-only "Manual" badge on the billing timeline can never drift
// from what the route actually does. Confirmed by grep to be a single
// hardcoded literal written at exactly one call site in the codebase —
// reliable enough for a purely informational badge, but deliberately never
// used to gate anything billing-execution-related. If a genuinely
// contract-derived one-time fee could ever collide with this exact label,
// or if this needs to gate real behavior rather than just a display hint,
// promote it to a real persisted origin column instead of a label match.
export const MANUAL_INVOICE_FEE_LABEL = 'Manual verification invoice'

export function isManualOriginInvoice(feeLabel: string | null | undefined): boolean {
  return feeLabel === MANUAL_INVOICE_FEE_LABEL
}
