// Stage-B recovery, point 5 — the provider-level idempotency identity for
// each Stripe call the scheduler makes, extracted into pure, named
// functions so "the same planned_invoice/operation always derives the
// same key, regardless of which worker or attempt computes it" is
// something real tests can prove, not just a comment. Every key is built
// ONLY from already-durable identifiers (planned_invoices.id, an overage
// line item's own meter_key/windowStart, a credit's credit_rule_id) —
// never from anything regenerated per attempt (a random UUID, a
// timestamp, a process id) — which is what "stable across recovery"
// actually requires: a retried call, from a different worker, after a
// crash, on the Nth reclaim, must derive the byte-identical string every
// single time for the SAME logical operation.
export function stripeInvoiceIdempotencyKey(plannedInvoiceId: string): string {
  return `verdix-sched-${plannedInvoiceId}`
}

export function stripeBaseItemIdempotencyKey(plannedInvoiceId: string): string {
  return `verdix-sched-${plannedInvoiceId}-base`
}

// windowStart is included (falling back to the item's own array index only
// when absent — the legacy client_pull path has no per-meter window) so
// two windows of the same meter within one invoice (a shorter-cadence
// meter measured more than once inside one billing period) each still get
// a distinct, but still deterministic, identity.
export function stripeOverageItemIdempotencyKey(
  plannedInvoiceId: string, meterKey: string, windowStart: string | undefined, fallbackIndex: number,
): string {
  return `verdix-sched-${plannedInvoiceId}-overage-${meterKey}-${windowStart ?? fallbackIndex}`
}

// Unchanged from the pre-existing convention (was already stable/correct
// before this pass) — included here only so the full set of keys used for
// one invoice can be reasoned about and tested together.
export function stripeCreditItemIdempotencyKey(plannedInvoiceId: string, creditRuleId: string): string {
  return `verdix-credit-${plannedInvoiceId}-${creditRuleId}`
}

export function stripeFinalizeIdempotencyKey(plannedInvoiceId: string): string {
  return `verdix-sched-${plannedInvoiceId}-finalize`
}

// Remembill's own invoice-creation Idempotency-Key header — unchanged from
// the pre-existing convention (already correctly used before this pass);
// included here for the same "reason about the whole set together" purpose.
// Remembill's row-creation/email endpoints have no equivalent (see the
// route's own ambiguous-recovery guard for why that gap is handled by
// failing closed instead of a key).
export function remembillInvoiceIdempotencyKey(plannedInvoiceId: string): string {
  return `verdix-sched-${plannedInvoiceId}`
}
