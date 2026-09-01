// Step E9B.1 §6 — the ONE place "is this ordinary period invoice held/
// PARKED, and why" is decided, so app/_components/BillingSummaryCard.tsx
// (Timeline's PARKED badge/blocker copy) and a future Dashboard action
// queue (E9C) can never diverge on the answer, and no caller has to
// re-derive it from a raw `error_message LIKE 'Held: %'` check of its own.
//
// Persistence is UNCHANGED from Step E9B: a held period row is still
// exactly `planned_invoices.status = 'scheduled'` with
// `error_message` beginning `'Held: '` — the same convention
// app/api/admin/invoice-scheduler/route.ts's QuantitySourceNotReadyError
// catch block already writes. This file only centralizes how that shape
// is *read*, never changes what's written.
export interface InvoiceHoldLike {
  status: string | null
  errorMessage?: string | null
}

const HOLD_PREFIX = /^Held:\s*/

/** True for an ordinary period/terminal-settlement invoice the scheduler
 *  reverted to 'scheduled' because a required commercial-quantity source
 *  wasn't ready yet (lib/commercial-quantity-source.ts's
 *  QuantitySourceNotReadyError) — the retryable, self-recovering PARKED
 *  state. Deliberately the SAME shape a plain "not yet due" scheduled row
 *  has MINUS the error_message — a row with no error_message at all is
 *  just an ordinary future draft, never PARKED. */
export function isHeldScheduledInvoice(row: InvoiceHoldLike): boolean {
  return row.status === 'scheduled' && !!row.errorMessage && HOLD_PREFIX.test(row.errorMessage)
}

export interface InvoiceHoldDescription {
  held: boolean
  /** Safe for primary Timeline/Dashboard copy — never raw meter keys,
   *  stack text, function names, or Supabase error strings (§7). */
  businessReason: string
  /** The scheduler's own persisted message, prefix stripped — offered
   *  ONLY as secondary/diagnostic detail (an expandable "Technical
   *  details" disclosure, audit log, etc.), never as primary copy. */
  technicalReason: string | null
}

// Step E9B.1 §7 — matched on stable tags DELIBERATELY embedded at each
// throw site (lib/usage-pull.ts's "[usage_source]", lib/performance-
// share-pull.ts's "[performance_input]") or on the fixed, non-prose
// portion of QuantitySourceNotReadyError's own message template
// (lib/commercial-quantity-source.ts's "quantity source (<provenance>)
// is not ready" — <provenance> is a closed enum, never free text) —
// never on a metric key, fee label, or the free-text `reason` a pull/
// calculation function supplies, none of which are safe to pattern-match
// on for meaning. Unrecognized text (a future throw site that forgets to
// tag itself, or a truly generic error) falls back to a still-honest,
// still-generic business phrase — never a guess dressed up as specific.
function classifyHoldReason(technicalReason: string): string {
  if (technicalReason.includes('[usage_source]')) return 'Usage measurement not yet final'
  if (technicalReason.includes('[performance_input]')) return 'Performance inputs required'
  if (technicalReason.includes('quantity source (qualified_unit_aggregate)')) return 'Billing source temporarily unavailable'
  return 'Awaiting a required billing input'
}

export function describeInvoiceHold(row: InvoiceHoldLike): InvoiceHoldDescription {
  if (!isHeldScheduledInvoice(row)) {
    return { held: false, businessReason: '', technicalReason: null }
  }
  const technicalReason = (row.errorMessage as string).replace(HOLD_PREFIX, '')
  return { held: true, businessReason: classifyHoldReason(technicalReason), technicalReason }
}

// Step E9B.1 §11 — PARKED (retryable, self-recovering) and FAILED
// (non-retryable, needs operational correction — see lib/performance-
// share-pull.ts's currency-mismatch/invalid throws, which deliberately
// throw a plain Error rather than QuantitySourceNotReadyError specifically
// so they land here, not in 'parked') are DIFFERENT states with different
// required actions; a caller must never fold them into one generic
// "blocked" bucket. 'normal' covers every other status this module has no
// opinion on (paid/open/sent/draft/an ordinary not-yet-due scheduled row).
export type InvoiceLifecycleState = 'parked' | 'failed' | 'normal'

export function classifyInvoiceLifecycleState(row: InvoiceHoldLike): InvoiceLifecycleState {
  if (isHeldScheduledInvoice(row)) return 'parked'
  if (row.status === 'failed') return 'failed'
  return 'normal'
}

// Step E9B.1 §7/§8 — the FAILED-path counterpart to describeInvoiceHold.
// A FAILED row (lib/performance-share-pull.ts's currency-mismatch/invalid
// throws — deliberately plain Error, not QuantitySourceNotReadyError,
// exactly because this data won't self-correct merely by waiting; see
// those throw sites' own comments) needs the SAME "never raw technical
// text as primary copy" treatment §7 requires for a held row, via the
// SAME kind of stable, deliberately-embedded tag
// ([currency_mismatch]/[invalid_data]) rather than prose pattern-matching.
export interface InvoiceFailureDescription {
  failed: boolean
  businessReason: string
  technicalReason: string | null
}

function classifyFailureReason(technicalReason: string): string {
  if (technicalReason.includes('[currency_mismatch]')) return 'Billing currency mismatch — needs correction'
  if (technicalReason.includes('[invalid_data]')) return 'Invalid billing data — needs correction'
  return 'Operational correction required'
}

export function describeInvoiceFailure(row: InvoiceHoldLike): InvoiceFailureDescription {
  if (row.status !== 'failed' || !row.errorMessage) {
    return { failed: false, businessReason: '', technicalReason: null }
  }
  return { failed: true, businessReason: classifyFailureReason(row.errorMessage), technicalReason: row.errorMessage }
}
