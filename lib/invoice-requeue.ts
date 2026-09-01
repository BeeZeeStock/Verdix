// Step E9C §15/§16/§17 — the safe, explicit FAILED -> requeue recovery
// action. Never sends the invoice directly: moves the SAME planned_
// invoices row back into the existing 'scheduled' state so the existing,
// already-safe claim/execution machinery (claim_scheduled_invoice's own
// atomic jobs.billing_hold check, the fail-closed usage/performance
// throws, execution_payload persistence) decides what happens next —
// exactly like an ordinary scheduler retry, never a parallel send path.
import { supabaseServer } from '@/lib/supabase'
import { evaluateBillingGate } from '@/lib/billing-hold'
import { classifyRequeueEligibility } from '@/lib/invoice-requeue-eligibility'
import { requestInvoiceReadinessRecheck } from '@/lib/invoice-readiness-recheck'

export type RequeueResult =
  | { ok: true; invoiceId: string; recheck: Awaited<ReturnType<typeof requestInvoiceReadinessRecheck>> }
  | { ok: false; status: number; reason: string }

export async function requeueFailedInvoice(params: {
  jobId: string
  orgId: string
  plannedInvoiceId: string
  requestedBy: string
}): Promise<RequeueResult> {
  const { jobId, orgId, plannedInvoiceId, requestedBy } = params

  const { data: job } = await supabaseServer
    .from('jobs')
    .select('id, billing_platform, billing_hold')
    .eq('id', jobId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (!job) return { ok: false, status: 404, reason: 'Job not found' }

  // Step E9C §16 — reuses the SAME shared gate every other monetary-
  // adjacent route already checks (app/api/jobs/[id]/parked-invoices/
  // route.ts's identical call) — never a bespoke ad hoc boolean check.
  // Requeuing is a real monetary action (re-admits the row into the
  // pipeline that creates/sends provider invoices), never a hold-
  // resolving operation, so any non-null hold rejects unconditionally.
  const holdGate = evaluateBillingGate(job.billing_hold, 'monetary_action')
  if (!holdGate.allowed) return { ok: false, status: 409, reason: holdGate.reason }

  const { data: row } = await supabaseServer
    .from('planned_invoices')
    .select('id, job_id, org_id, status, invoice_type, stripe_invoice_id, error_message')
    .eq('id', plannedInvoiceId)
    .eq('job_id', jobId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (!row) return { ok: false, status: 404, reason: 'Invoice not found' }

  const eligibility = classifyRequeueEligibility({
    status: row.status, invoiceType: row.invoice_type,
    billingPlatform: (job.billing_platform as string | null),
    vendorInvoiceId: row.stripe_invoice_id,
  })
  if (!eligibility.eligible) return { ok: false, status: 409, reason: eligibility.reason }

  // Step E9C §17 — the prior failure reason is preserved WITHIN the same
  // error_message column (this codebase has no generic audit/event table
  // that could record this without a schema change — confirmed by
  // grepping supabase/migrations/ for one; reported as a real, honest
  // limitation in the closing report rather than inventing a new table
  // for a single field). Never starts with "Held: " — a requeued row is
  // NOT currently blocked by a known reason, it is simply back in the
  // ordinary retry queue, so lib/invoice-hold-status.ts's
  // isHeldScheduledInvoice correctly does NOT classify it as PARKED.
  const requeuedAt = new Date().toISOString()
  const auditNote = `Requeued ${requeuedAt} by ${requestedBy}. Previous failure: ${row.error_message ?? 'unknown'}`

  // Idempotent: the UPDATE's own .eq('status', 'failed') precondition
  // means a concurrent/duplicate requeue request (double-click, two open
  // tabs) can only ever succeed once — the second call affects zero rows
  // and is reported back as no-longer-eligible, never silently re-run.
  const { data: updated, error: updateError } = await supabaseServer
    .from('planned_invoices')
    .update({ status: 'scheduled', processing_started_at: null, error_message: auditNote })
    .eq('id', plannedInvoiceId)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle()

  if (updateError) return { ok: false, status: 500, reason: updateError.message }
  if (!updated) {
    return { ok: false, status: 409, reason: 'Invoice is no longer in a failed state — already requeued or resolved by another request.' }
  }

  // Step E9C §16 — "optionally request the existing job-scoped readiness
  // recheck": reuses the EXACT SAME mechanism E9B.1 built for manual-input
  // finalization (runInvoiceSchedulerSweep, job_id-scoped), never a direct
  // vendor send from this endpoint. Best-effort — a recheck failure here
  // never fails the requeue itself; the row is already safely back in
  // 'scheduled' and the daily scheduler remains the unconditional fallback.
  const recheck = await requestInvoiceReadinessRecheck(jobId)

  return { ok: true, invoiceId: plannedInvoiceId, recheck }
}
