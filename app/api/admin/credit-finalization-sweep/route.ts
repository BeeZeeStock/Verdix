/**
 * GET /api/admin/credit-finalization-sweep
 *
 * Closes a real lifecycle gap in the credit/rebate engine: runEarningPass
 * (lib/credit-ledger-service.ts) — the function that decides whether a
 * credit's trigger window has both met its threshold AND reached its
 * finalization_deadline_days — was previously only ever invoked as a side
 * effect of a planned_invoices row becoming due (via
 * applyCreditLedgerForPeriod, called from invoice-scheduler). A credit
 * whose finalization deadline falls AFTER the last invoice that will ever
 * exist for a job (the exact Contract B case: the Annual Rebate's 30-day
 * deadline lands ~29 days after the terminal_settlement row — the last row
 * that will ever be due for a finite-term, non-renewing contract — already
 * fires and completes) would sit in 'trigger_check' (provisional) forever,
 * since nothing would ever call runEarningPass for that window again.
 *
 * This route is commercial-ledger work ONLY — it never creates a provider
 * invoice, never touches Stripe/Remembill, and never generates a
 * planned_invoices row. It exists specifically so credit finalization does
 * not depend on billing execution happening to fire again.
 *
 * Deliberately reuses the SAME runEarningPass function
 * applyCreditLedgerForPeriod already calls — not a duplicated finalization
 * engine — and relies entirely on that function's own, already-idempotent
 * behavior (checks for an existing 'earn' row before ever writing one; the
 * credit_ledger_earn_window_uidx unique index is the DB-level backstop). A
 * repeated sweep for the same window is a safe no-op once finalized.
 *
 * No new scheduler/queue table — candidates are derived entirely from
 * credit_ledger_entries' own existing durable state (trigger_check rows
 * with threshold_met=true and no corresponding earn row yet), per the
 * explicit instruction to prefer existing ledger identity/state over a
 * parallel table.
 *
 * Protected by x-cron-secret header, same convention as every other admin
 * cron in this project.
 *
 * Vercel Cron: add to vercel.json —
 *   { "crons": [{ "path": "/api/admin/credit-finalization-sweep", "schedule": "0 9 * * *" }] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'
import { runEarningPass } from '@/lib/credit-ledger-service'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import type { ContractTerms } from '@/lib/types'
import { computeSweepCandidates } from '@/lib/credit-finalization-sweep'

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const today = new Date()

  // Candidate windows — every (job, credit, window) whose most recent
  // trigger_check said the threshold was met. Deliberately does not filter
  // by evaluation_date freshness: an OLDER trigger_check with
  // threshold_met=true is still a valid candidate for re-evaluation (a
  // credit that qualified once and was never finalized doesn't stop being
  // a candidate just because no one re-checked it since).
  const { data: thresholdMetRows, error: thresholdMetError } = await supabaseServer
    .from('credit_ledger_entries')
    .select('job_id, credit_rule_id, window_start, window_end')
    .eq('entry_type', 'trigger_check')
    .eq('threshold_met', true)

  if (thresholdMetError) {
    console.error('[credit-finalization-sweep] failed to fetch threshold-met trigger_check rows', thresholdMetError)
    return NextResponse.json({ error: thresholdMetError.message }, { status: 500 })
  }

  // Already-finalized windows — excluded regardless of anything else.
  // credit_ledger_earn_window_uidx (job_id, credit_rule_id, window_start)
  // is the same identity this exclusion is keyed on, so it can never
  // disagree with what the DB itself considers "already earned."
  const { data: earnedRows, error: earnedError } = await supabaseServer
    .from('credit_ledger_entries')
    .select('job_id, credit_rule_id, window_start')
    .eq('entry_type', 'earn')

  if (earnedError) {
    console.error('[credit-finalization-sweep] failed to fetch earn rows', earnedError)
    return NextResponse.json({ error: earnedError.message }, { status: 500 })
  }

  // Pure set-difference (lib/credit-finalization-sweep.ts) — de-duplicates
  // repeated trigger_check snapshots for the same window and excludes
  // anything already permanently earned. See that module for the full
  // idempotency rationale.
  const candidates = computeSweepCandidates(
    (thresholdMetRows ?? []).map(r => ({
      jobId: r.job_id, creditRuleId: r.credit_rule_id, windowStart: r.window_start, windowEnd: r.window_end,
    })),
    (earnedRows ?? []).map(r => ({ jobId: r.job_id, creditRuleId: r.credit_rule_id, windowStart: r.window_start })),
  )

  const results: { jobId: string; creditRuleId: string; windowStart: string; ok: boolean; error?: string }[] = []

  for (const candidate of candidates) {
    try {
      const { data: job } = await supabaseServer
        .from('jobs')
        .select('id, org_id, billing_customer_id, contract_terms ( * )')
        .eq('id', candidate.jobId)
        .maybeSingle()
      if (!job) throw new Error(`Job ${candidate.jobId} not found`)

      const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
      if (!terms) throw new Error(`No contract terms for job ${candidate.jobId}`)

      const customerId = job.billing_customer_id as string | null
      if (!customerId) throw new Error(`No billing_customer_id for job ${candidate.jobId}`)

      const credit = (terms.service_credits ?? []).find(c => c.credit_rule_id === candidate.creditRuleId)
      if (!credit) throw new Error(`credit_rule_id ${candidate.creditRuleId} no longer present on job ${candidate.jobId}'s contract_terms`)

      // Re-invokes the EXACT SAME earning pass applyCreditLedgerForPeriod
      // calls per due invoice — scanStart/scanEnd set to precisely this
      // window's own bounds (not re-derived), so enumerateCadenceWindows
      // rediscovers exactly this one window and nothing else. Freshly
      // re-reads paid planned_invoices state (sumPaidComponentAmountForWindow
      // queries status='paid' live, every call) — this is what makes a
      // payment landing after the terminal settlement run visible on the
      // next sweep, with no webhook-side coupling required.
      await runEarningPass({
        jobId: candidate.jobId, orgId: job.org_id, terms, customerId,
        credit, scanStart: new Date(candidate.windowStart + 'T00:00:00'),
        scanEnd: new Date(candidate.windowEnd + 'T00:00:00'), today,
      })

      results.push({ jobId: candidate.jobId, creditRuleId: candidate.creditRuleId, windowStart: candidate.windowStart, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[credit-finalization-sweep] failed for job ${candidate.jobId} credit ${candidate.creditRuleId}`, err)
      results.push({ jobId: candidate.jobId, creditRuleId: candidate.creditRuleId, windowStart: candidate.windowStart, ok: false, error: message })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`[credit-finalization-sweep] processed ${results.length} candidate window(s): ${succeeded} ok, ${failed} failed`)

  return NextResponse.json({ processed: results.length, succeeded, failed, results })
}
