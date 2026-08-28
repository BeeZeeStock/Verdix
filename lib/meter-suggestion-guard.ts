// Step 17C.3b, item B — a real, observed false-positive suggestion:
// "payment request" (a payment-PROCESSING transaction count) was AI-
// matched to a meter named "Invoices Sent" purely because both clauses
// happen to mention "invoices"/"payments" in casual language. An
// "Invoices Sent" meter counts a NOTIFICATION/DISPATCH event (the vendor's
// own system sending an invoice document) — a structurally different
// countable event from a customer-facing payment request being issued.
// Loose keyword co-occurrence is not semantic equivalence.
//
// This is a small, deterministic, unit-testable SAFETY NET layered on top
// of app/api/jobs/[id]/meter-mappings/route.ts's own AI-based aiMatch() —
// it never replaces the AI call, it only caps the confidence of a
// suggestion that falls into this specific, documented mismatch shape,
// regardless of what the model itself returned. Narrow and explicit (a
// short, curated set of term buckets), never a general-purpose classifier
// — same "narrow explicit registry over generic heuristic" discipline
// already established for operational-input-key canonicalization (see
// lib/operational-input-canonicalization.ts's own header).
const TRANSACTIONAL_METRIC_TERMS = ['payment request', 'payment', 'transaction', 'charge']
const NOTIFICATION_DISPATCH_TERMS = ['email', 'sms', 'letter', 'reminder', 'notification']
// "Invoices Sent"/"Invoice Dispatch" etc. — an invoice-related meter is
// only treated as a dispatch/notification channel (not a payment-
// processing meter that merely has "invoice" in its name) when it also
// carries a dispatch-shaped qualifier.
const INVOICE_DISPATCH_RE = /\binvoice(s)?\b[^|]*\b(sent|dispatch(ed)?)\b|\b(sent|dispatch(ed)?)\b[^|]*\binvoice(s)?\b/i

export function isNotificationChannelMismatch(
  unitType: string,
  meter: { meter_key: string; display_name: string; unit_label?: string | null },
): boolean {
  const metric = unitType.toLowerCase()
  const meterText = `${meter.meter_key} | ${meter.display_name} | ${meter.unit_label ?? ''}`.toLowerCase()

  const metricIsTransactional = TRANSACTIONAL_METRIC_TERMS.some(t => metric.includes(t))
  if (!metricIsTransactional) return false

  return NOTIFICATION_DISPATCH_TERMS.some(t => meterText.includes(t)) || INVOICE_DISPATCH_RE.test(meterText)
}

// The confidence an AI-guessed mismatch is capped to — well below the
// route's own no_match threshold (0.4), so the client always renders "No
// suitable meter found" for this shape rather than a semantically wrong
// pre-selected meter, regardless of how confident the model claimed to be.
export const NOTIFICATION_CHANNEL_MISMATCH_CONFIDENCE_CAP = 0.1
