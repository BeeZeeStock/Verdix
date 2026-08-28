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
