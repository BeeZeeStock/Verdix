// Step E9C §15/§16 — the PURE eligibility decision behind the FAILED ->
// requeue recovery action, audited against the real scheduler code before
// being written (app/api/admin/invoice-scheduler/route.ts), not assumed:
//
//   - Stripe: every invoice/item/finalize call carries a stable
//     idempotency key across recovery attempts (that file's own comment,
//     "Ambiguous-recovery guard, Remembill only") — retrying a Stripe row
//     past a partially-completed prior attempt is structurally safe.
//   - Remembill: its Idempotency-Key header is only honored on invoice
//     CREATION, never on row-creation — the scheduler's OWN existing code
//     already refuses to retry a row whose stripe_invoice_id (the shared
//     vendor-reference column) is already set for a Remembill job,
//     throwing an "ambiguous state...requires manual reconciliation"
//     error. This module enforces the IDENTICAL rule up front, so a user
//     gets a clear rejection here rather than a confusing requeue-then-
//     immediately-fail-again loop; it is a UX improvement layered on top
//     of an existing safety guarantee, not a substitute for it — even if
//     this check were somehow bypassed, the scheduler's own guard still
//     holds.
//   - one_time invoices: a structurally different lifecycle (the existing
//     parked/event mechanism), never routed through this recovery path.
export type RequeueEligibility =
  | { eligible: true }
  | { eligible: false; reason: string }

export function classifyRequeueEligibility(params: {
  status: string
  invoiceType: string
  billingPlatform: string | null
  vendorInvoiceId: string | null
}): RequeueEligibility {
  if (params.status !== 'failed') {
    return { eligible: false, reason: `Invoice is not in a failed state (current status: '${params.status}').` }
  }
  if (params.invoiceType === 'one_time') {
    return { eligible: false, reason: 'One-time/event fee invoices use the existing parked-invoice release mechanism, not requeue.' }
  }
  const platform = params.billingPlatform ?? 'stripe'
  if (platform === 'remembill' && params.vendorInvoiceId) {
    return {
      eligible: false,
      reason: `A Remembill provider invoice (${params.vendorInvoiceId}) already exists from a prior attempt — ambiguous state, requires manual reconciliation before retry.`,
    }
  }
  return { eligible: true }
}
