// Step E9B.1 §1/§2 — "Recheck this invoice now", not "Force send this
// invoice": a thin, best-effort trigger for the EXACT SAME server-side
// entry point the daily cron already uses (app/api/admin/invoice-
// scheduler/route.ts's runInvoiceSchedulerSweep, job_id-scoped — see
// lib/invoice-scheduler-scope.ts's own header for why job_id, not a single
// planned_invoice_id, is the right scope here: a manual input finalization
// can affect whichever of this job's due rows actually needed it, and the
// existing selection query — status='scheduled' AND period_start <= today
// — already limits the sweep to rows that are genuinely due, exactly as
// the daily cron itself would). Deliberately NOT a new invoice-computation
// path: every claim/billing_hold/execution_payload/credit-ledger/VAT/
// Stripe/Remembill decision still runs through the identical code the cron
// runs, in-process, with the exact same claim_scheduled_invoice atomic
// safety a concurrent cron run already relies on — two overlapping callers
// (this recheck firing at the same moment as the daily cron) simply race
// harmlessly for each row's claim, never double-process one.
//
// Never called from the browser directly — only from an authenticated
// server-side route (see app/api/jobs/[id]/operational-input-values/
// route.ts) after a value has already been durably finalized. Never
// throws: a failure here must never surface as a save error to the user
// and must never be the only path a blocked invoice can recover through —
// the daily cron remains the unconditional fallback (§3) regardless of
// whether this succeeds, times out, or the process recycles mid-request.
import { runInvoiceSchedulerSweep } from '@/app/api/admin/invoice-scheduler/route'

export interface InvoiceReadinessRecheckResult {
  ok: boolean
  processed?: number
  succeeded?: number
  failed?: number
}

export async function requestInvoiceReadinessRecheck(jobId: string): Promise<InvoiceReadinessRecheckResult> {
  try {
    const response = await runInvoiceSchedulerSweep({ kind: 'job_id', jobId })
    const body = await response.json().catch(() => null) as { processed?: number; succeeded?: number; failed?: number; error?: string } | null
    if (response.status !== 200) {
      console.error(`[invoice-readiness-recheck] job ${jobId} sweep returned ${response.status}: ${body?.error ?? 'unknown error'}`)
      return { ok: false }
    }
    return { ok: true, processed: body?.processed, succeeded: body?.succeeded, failed: body?.failed }
  } catch (err) {
    console.error(`[invoice-readiness-recheck] job ${jobId} sweep threw`, err)
    return { ok: false }
  }
}
