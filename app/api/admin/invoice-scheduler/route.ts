/**
 * GET /api/admin/invoice-scheduler
 *
 * Daily cron: find planned_invoices whose period_start is today or earlier and
 * status is 'scheduled'. For each:
 *   1. Pull usage data for the closed period
 *   2. Compute overages
 *   3. Create a complete standalone Stripe invoice (base + overages)
 *   4. Finalize and send
 *   5. Mark the planned_invoice row as 'sent'
 *
 * Protected by x-cron-secret header (same CRON_SECRET env var as billing-cron).
 *
 * Vercel Cron: add to vercel.json —
 *   { "crons": [{ "path": "/api/admin/invoice-scheduler", "schedule": "0 6 * * *" }] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { REMEMBILL_BASE, remembillHeaders, remembillAppUrl } from '@/lib/billing-writer'
import { computeOverageForPeriod, type OverageLineItem } from '@/lib/usage-pull'
import { computePerformanceShareLineItemsForPeriod } from '@/lib/performance-share-pull'
import { computePerUnitFeeLineItemsForPeriod } from '@/lib/per-unit-fee-pull'
import { evaluateRollingBandMigrations, persistTriggeredRollingBandMigrations, reconcileActiveRollingBandTransitions } from '@/lib/rolling-band-migration-pull'
import { resolveUsageQuantityForPeriod } from '@/lib/usage-quantity-resolver'
import { QuantitySourceNotReadyError } from '@/lib/commercial-quantity-source'
import { applyCreditLedgerForPeriod } from '@/lib/credit-ledger-service'
import type { ContractTerms } from '@/lib/types'
import { isAuthorizedCronRequest } from '@/lib/cron-auth'
import { resolveSchedulerScope } from '@/lib/invoice-scheduler-scope'
import { isHeldHistoricalTerminalSettlement } from '@/lib/terminal-settlement-guard'
import { resolveFixedFeeSchedulingDecision } from '@/lib/fixed-fee-invoice-scheduling'
import { resolveVatTreatment, computeVat, reconcileGrossAmount } from '@/lib/vat'
import { unwrapEmbedded } from '@/lib/postgrest-helpers'
import { getCustomerVatConfig, getInvoiceVatOverride } from '@/lib/vat-service'
import { evaluateParkedOneTimeFeeEligibility } from '@/lib/parked-one-time-fee-eligibility'
import type { OperationalEventEvidence } from '@/lib/operational-event-evidence'
import { classifyContractUnitType } from '@/lib/commercial-component-scope'
import {
  stripeInvoiceIdempotencyKey, stripeBaseItemIdempotencyKey, stripeOverageItemIdempotencyKey,
  stripeCreditItemIdempotencyKey, stripeFinalizeIdempotencyKey, remembillInvoiceIdempotencyKey,
} from '@/lib/invoice-scheduler-idempotency'

// Contract B pre-approval pass — maps a raw operational_event_evidence row
// onto the domain type, identical to the mapping already used at
// lib/billing-reconciliation.ts and app/api/jobs/[id]/approve/route.ts, so
// there is only ever one shape this conversion produces.
function mapEvidenceRows(rows: Record<string, unknown>[] | null): OperationalEventEvidence[] {
  return (rows ?? []).map(r => ({
    id: r.id as string, subjectId: r.subject_id as string, eventType: r.event_type as OperationalEventEvidence['eventType'],
    occurredAt: r.occurred_at as string, source: r.source as OperationalEventEvidence['source'],
    recordedAt: r.recorded_at as string, recordedBy: r.recorded_by as string, status: r.status as OperationalEventEvidence['status'],
  }))
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Manual/test scope — see lib/invoice-scheduler-scope.ts. Requires its
  // own secret, checked IN ADDITION TO the cron auth above; a normal
  // Vercel Cron invocation never sends planned_invoice_id/job_id/the scope
  // header at all, so this is a strict no-op for the whole-platform sweep.
  const scopeResolution = resolveSchedulerScope({
    plannedInvoiceIdParam: req.nextUrl.searchParams.get('planned_invoice_id'),
    jobIdParam: req.nextUrl.searchParams.get('job_id'),
    scopeSecretHeader: req.headers.get('x-scheduler-scope-secret'),
    configuredScopeSecret: process.env.SCHEDULER_SCOPE_SECRET,
  })
  if (!scopeResolution.ok) {
    return NextResponse.json({ error: scopeResolution.error }, { status: scopeResolution.status })
  }
  const scope = scopeResolution.scope

  // Captured exactly once for the whole run, not re-read per row — the
  // same explicit "as of" reference threads through period selection,
  // usage calculation, and the closure invariant below, so a single
  // scheduler run is internally consistent even if it takes a while to
  // process every due row.
  const billingAsOf = new Date()
  const today = billingAsOf.toISOString().slice(0, 10)

  // Declared here (not just before the main loop) so the stale-processing
  // reclaim block below can also report into it — an exhausted row is
  // marked 'failed' directly by reclaim_stale_processing_row and never
  // enters the main per-row loop at all, so it needs its own result entry.
  const results: { id: string; ok: boolean; stripe_invoice_id?: string; error?: string; held?: boolean }[] = []

  // ── Find all due planned invoices ─────────────────────────────────────────
  // status='scheduled' structurally excludes 'backfill_review' by
  // construction — a migration-created historical terminal-settlement row
  // held in that state (see lib/terminal-settlement.ts's
  // classifyBackfillTerminalSettlementStatus) is never selected here, and
  // needs no separate exclusion filter.
  let scheduledQuery = supabaseServer
    .from('planned_invoices')
    .select('*')
    .eq('status', 'scheduled')
    .lte('period_start', today)
  if (scope.kind === 'planned_invoice_id') scheduledQuery = scheduledQuery.eq('id', scope.plannedInvoiceId)
  else if (scope.kind === 'job_id') scheduledQuery = scheduledQuery.eq('job_id', scope.jobId)
  const { data: scheduledRows, error: fetchError } = await scheduledQuery.order('period_start', { ascending: true })

  if (fetchError) {
    console.error('[invoice-scheduler] failed to fetch due rows', fetchError)
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }

  // ── Scheduler-side historical-terminal-settlement guard ──────────────────
  // Defense-in-depth, independent of migration status: re-derives
  // "historical/late-created" directly from each row's own created_at vs.
  // period_start, at read time, rather than trusting that a backfill/
  // corrective migration correctly set status='backfill_review'. Catches
  // the case where that migration was never applied, was applied out of
  // order in some other environment, or a future bug reintroduces the same
  // unconditional-'scheduled' backfill shape. Applied here — BEFORE the
  // scope filter has any chance to matter — so a manually scoped request
  // (?planned_invoice_id=<a held row>) cannot bypass this either; scope
  // only narrows WHICH rows are considered, never whether a matched row
  // still has to pass this invariant.
  const heldRows: DueRow[] = []
  const scheduledRowsAfterGuard = ((scheduledRows ?? []) as DueRow[]).filter(row => {
    if (isHeldHistoricalTerminalSettlement(row as unknown as Parameters<typeof isHeldHistoricalTerminalSettlement>[0])) {
      heldRows.push(row)
      return false
    }
    return true
  })
  for (const held of heldRows) {
    results.push({
      id: held.id, ok: false,
      error: 'Held: historical/late-created terminal_settlement row (created_at >= period_start, no backfill_released_at) — scheduler-side defense-in-depth, independent of migration status.',
    })
  }

  // ── Contract B pre-approval pass, Part A — event-gated parked one-time
  // fees, discovered freshly each run ─────────────────────────────────────
  // Structural discriminator only, never fee_label/description matching:
  // status='parked' AND invoice_type='one_time' AND fee_id populated.
  // fee_id is populated ONLY at Stage A (lib/billing-writer.ts) for a fee
  // whose billability_condition.kind === 'event' — an ordinary quantity x
  // rate manual-trigger parked fee never has fee_id set, so it can never
  // appear in this query and is completely unaffected (still exclusively
  // human-driven via POST /parked-invoices).
  let parkedEventFeeQuery = supabaseServer
    .from('planned_invoices')
    .select('*')
    .eq('status', 'parked')
    .eq('invoice_type', 'one_time')
    .not('fee_id', 'is', null)
  if (scope.kind === 'planned_invoice_id') parkedEventFeeQuery = parkedEventFeeQuery.eq('id', scope.plannedInvoiceId)
  else if (scope.kind === 'job_id') parkedEventFeeQuery = parkedEventFeeQuery.eq('job_id', scope.jobId)
  const { data: parkedEventFeeCandidates, error: parkedFetchError } = await parkedEventFeeQuery

  if (parkedFetchError) {
    console.error('[invoice-scheduler] failed to fetch parked event-fee candidates', parkedFetchError)
  }

  // A2 — freshly re-evaluate every candidate right now, against CURRENT
  // contract_terms.one_time_fees and CURRENT active evidence. Never trust
  // the historical 'parked' status as proof either way. This in-process
  // evaluation is a cheap PRE-FILTER/diagnostic only, never itself the
  // authorization to execute — evidence could still be revoked in the gap
  // between this read and the DB write that follows it. Final
  // authorization is the atomic claim_parked_event_fee SQL function
  // (supabase/migrations/20260828000001_claim_parked_event_fee.sql): it
  // re-verifies row state AND evidence itself, inside one transaction,
  // immediately before the parked -> processing transition — closing that
  // gap entirely rather than narrowing it. A candidate this pre-filter (or
  // the atomic claim) finds ineligible is left completely untouched below
  // — no write, zero provider mutation — and simply remains parked for a
  // future run to reconsider once evidence changes. Only a row whose claim
  // actually succeeds is admitted into the main processing loop below,
  // where it flows through the exact same invoicing/VAT/status-transition
  // machinery as every other due row.
  // Matches this file's existing style: planned_invoices rows are read via
  // .select('*') with no dedicated row type anywhere in this codebase (see
  // lib/billing-writer.ts's own PlannedRow comment), so every field access
  // below was already effectively `any` before this change.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type DueRow = Record<string, any> & { id: string; job_id: string; base_amount: number }
  const eligibleParkedRows: DueRow[] = []
  for (const candidate of (parkedEventFeeCandidates ?? []) as DueRow[]) {
    const { data: candidateJob } = await supabaseServer
      .from('jobs')
      .select('contract_terms ( one_time_fees )')
      .eq('id', candidate.job_id)
      .maybeSingle()
    const candidateTermsRaw = unwrapEmbedded(
      candidateJob?.contract_terms as unknown as ContractTerms | ContractTerms[] | null | undefined,
    )
    const { data: evidenceRows } = await supabaseServer
      .from('operational_event_evidence')
      .select('*')
      .eq('job_id', candidate.job_id)
      .eq('status', 'active')

    const decision = evaluateParkedOneTimeFeeEligibility({
      candidateFeeId: candidate.fee_id as string | null | undefined,
      oneTimeFees: candidateTermsRaw?.one_time_fees ?? [],
      evidence: mapEvidenceRows(evidenceRows),
      asOf: billingAsOf,
    })
    if (!decision.eligible) continue // pre-filter says no — remains parked, zero DB write

    // Final authorization — a single atomic DB claim, not this process's
    // own stale read. Re-verifies row status/invoice_type/fee_id AND
    // evidence (active/subject/event_type/occurred_at) together, inside
    // one transaction, then performs the parked -> processing transition
    // — persisting the canonical base_amount in the SAME atomic write —
    // only if every predicate still holds at that instant. Row-level
    // locking on BOTH the planned_invoice row AND the qualifying evidence
    // row itself (see the migration's own header comment for the exact
    // lock mode and why it genuinely conflicts with the real revoke
    // implementation) is what makes a concurrent second scheduler worker's
    // claim on the same row, AND a concurrent revoke of the evidence that
    // authorized it, both fail/wait cleanly rather than racing (A4/point
    // 4 — the existing per-row provider idempotency key remains the
    // second, independent layer). The application never computes or
    // writes base_amount itself — p_amount is passed straight through as
    // an opaque, already-resolved fact; SQL persists it, never interprets
    // it.
    const { data: claimed, error: claimError } = await supabaseServer.rpc('claim_parked_event_fee', {
      p_planned_invoice_id: candidate.id,
      p_fee_id: decision.feeId,
      p_event_type: decision.eventType,
      p_execution_as_of: billingAsOf.toISOString(),
      p_amount: decision.amount,
    })
    if (claimError) {
      console.error('[invoice-scheduler] claim_parked_event_fee RPC failed', claimError)
      continue
    }
    if (!claimed) continue // evidence changed (or a concurrent worker won) between discovery and the atomic claim — remains parked

    // The claim succeeded — status and base_amount are already correctly
    // persisted together, atomically, by the RPC above. This worker now
    // exclusively owns the row (status is no longer 'parked', so no
    // concurrent claim can succeed against it).
    eligibleParkedRows.push({ ...candidate, status: 'processing', base_amount: decision.amount, __alreadyLocked: true })
  }

  // ── Stage-B crash recovery — stranded 'processing' rows ─────────────────
  // Neither the 'scheduled' nor the 'parked' candidate queries above ever
  // select status='processing' — a worker that claims a row and then
  // crashes/times out before reaching the final 'sent'/'failed' write
  // leaves it permanently un-selectable by any other existing path. This
  // is a Stage-B row-lifecycle fix, not specific to any row's origin: it
  // applies identically to an ordinary scheduled base-fee row and to the
  // new event-gated one-time-fee claim path.
  //
  // Stale threshold: this route has no explicit `maxDuration` export, so
  // it runs under the platform default — documented as 300s (Vercel's
  // current default function execution timeout on all plans). A row still
  // 'processing' more than 300s after its lease began can therefore never
  // still be the original worker (the platform would already have killed
  // it) — STALE_PROCESSING_MS uses double that (10 minutes) as a
  // deliberately conservative margin, not an invented number: it can never
  // reclaim a row a legitimately-running attempt still owns under this
  // platform's own enforced ceiling, while still recovering promptly once
  // a row is genuinely abandoned. This cron itself only runs once daily,
  // so there is no risk of the NEXT scheduled invocation overlapping a
  // still-running one at this timescale either.
  const STALE_PROCESSING_MS = 10 * 60 * 1000
  // A row failing this many independent, lease-interval-spaced reclaim
  // cycles is far more likely a deterministic failure than a transient
  // crash/timeout — marked 'failed' (visible, reviewable) rather than
  // retried forever. reclaim_stale_processing_row enforces this
  // atomically, in the same statement that decides exhaustion (see the
  // migration and the 'exhausted' handling below).
  const MAX_PROCESSING_ATTEMPTS = 5
  const staleCutoffIso = new Date(billingAsOf.getTime() - STALE_PROCESSING_MS).toISOString()

  let staleProcessingQuery = supabaseServer
    .from('planned_invoices')
    .select('*')
    .eq('status', 'processing')
    .lte('processing_started_at', staleCutoffIso)
  if (scope.kind === 'planned_invoice_id') staleProcessingQuery = staleProcessingQuery.eq('id', scope.plannedInvoiceId)
  else if (scope.kind === 'job_id') staleProcessingQuery = staleProcessingQuery.eq('job_id', scope.jobId)
  const { data: staleProcessingCandidates, error: staleFetchError } = await staleProcessingQuery

  if (staleFetchError) {
    console.error('[invoice-scheduler] failed to fetch stale processing candidates', staleFetchError)
  }

  const recoveredRows: DueRow[] = []
  for (const candidate of (staleProcessingCandidates ?? []) as DueRow[]) {
    // Atomic lease refresh/exhaustion decision — see the migration's own
    // comment. reclaim_stale_processing_row now returns one of three
    // outcomes, decided atomically under a single row lock, so exhaustion
    // can never race with a concurrent reclaim attempt:
    //   'reclaimed'  — lease refreshed; admitted into the main loop below.
    //   'exhausted'  — processing_attempt_count already hit the cap; the
    //                  RPC itself transitioned the row directly to
    //                  'failed' with a clear error_message (in the SAME
    //                  atomic statement) rather than leaving it stuck in
    //                  'processing' forever, invisible to every existing
    //                  status query/UI (confirmed by audit: a permanently-
    //                  processing row falls through billing-summary's own
    //                  status mapping straight to the generic 'draft'
    //                  display — indistinguishable from "not due yet",
    //                  with no error shown at all). 'failed' already has a
    //                  real review surface (BillingSummaryCard renders
    //                  row.error_message for status='failed') — reused
    //                  here rather than inventing a new lifecycle state.
    //   'not_stale'  — no longer stale (already reclaimed by another
    //                  worker, or a legitimate concurrent execution is
    //                  still within its lease) — left untouched.
    const { data: reclaimResult, error: reclaimError } = await supabaseServer.rpc('reclaim_stale_processing_row', {
      p_planned_invoice_id: candidate.id,
      p_stale_cutoff: staleCutoffIso,
      p_max_attempts: MAX_PROCESSING_ATTEMPTS,
    })
    if (reclaimError) {
      console.error('[invoice-scheduler] reclaim_stale_processing_row RPC failed', reclaimError)
      continue
    }
    if (reclaimResult === 'exhausted') {
      results.push({
        id: candidate.id, ok: false,
        error: `Stage-B recovery attempt limit (${MAX_PROCESSING_ATTEMPTS}) reached — marked failed for manual reconciliation.`,
      })
      continue
    }
    if (reclaimResult !== 'reclaimed') continue // 'not_stale'

    // Recovery never re-evaluates Customer Acceptance (or any other
    // contract/evidence fact) — the row is already 'processing', meaning
    // execution formally began at the ORIGINAL claim; evidence was that
    // claim's authorization, not something recovery re-checks. Below,
    // candidate.execution_payload (if present) is what actually prevents
    // recomputation of any commercial figure on recovery.
    recoveredRows.push({ ...candidate, __alreadyLocked: true })
  }

  const dueRows: DueRow[] = [...scheduledRowsAfterGuard, ...eligibleParkedRows, ...recoveredRows]

  // Note: `results` may already be non-empty here (an attempt-exhausted
  // row marked 'failed' directly by reclaim_stale_processing_row, never
  // entering dueRows at all) even when dueRows itself is empty — report
  // what actually happened rather than hardcoding an empty summary.
  if (!dueRows.length) {
    const succeeded = results.filter(r => r.ok).length
    const failed    = results.filter(r => !r.ok).length
    return NextResponse.json({ processed: results.length, succeeded, failed, results })
  }

  for (const row of dueRows) {
    // A4/A5 — a row admitted above via the parked-event-fee path was
    // already locked (parked -> processing) at the exact moment its
    // eligibility was confirmed, using the same conditional-update
    // concurrency guard as the 'scheduled' path below; re-locking it here
    // would be redundant and would incorrectly require status='scheduled'.
    if (!(row as Record<string, unknown>).__alreadyLocked) {
      // Mark as processing so concurrent runs skip it, and stamp the
      // execution lease's start time in the SAME write (Stage-B recovery
      // — see the stale-processing reclaim block above). Checking `!locked`
      // rather than only `error` is a real fix found while auditing this:
      // a plain UPDATE whose WHERE clause matches zero rows (because
      // another worker already won the race) is NOT a PostgREST error —
      // `error` stays null regardless — so the old `if (lockError)` check
      // could never actually detect "another run already grabbed this
      // row"; only `.select().maybeSingle()` returning null reliably does.
      const { data: locked, error: lockError } = await supabaseServer
        .from('planned_invoices')
        .update({ status: 'processing', processing_started_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'scheduled')
        .select('*')
        .maybeSingle()

      if (lockError || !locked) {
        // Another run already grabbed this row
        continue
      }
    }

    try {
      // ── Fetch job + contract terms ────────────────────────────────────────
      const { data: job } = await supabaseServer
        .from('jobs')
        .select('id, org_id, billing_customer_id, billing_platform, contract_terms ( * )')
        .eq('id', row.job_id)
        .single()

      if (!job) throw new Error(`Job ${row.job_id} not found`)

      const terms = unwrapEmbedded(job.contract_terms as unknown as ContractTerms | ContractTerms[])
      if (!terms) throw new Error(`No contract terms for job ${row.job_id}`)

      // Step 17F.6 — scheduler-side fail-closed gate for the fixed
      // recurring component, independent of and in addition to the
      // review-readiness UI. The bulk fetch above (period_start <= today)
      // is a superset — it's the only SQL-level filter available and
      // period_start <= period_end always, so it never excludes a row this
      // check would otherwise need to see. 'hold' releases the row back to
      // 'scheduled' for a later run once a reviewer resolves the timing;
      // 'not_yet_due' does the same when a CONFIRMED bill_at_period_end
      // means the row's real trigger date hasn't arrived yet even though
      // its period_start has. Neither path ever touches an already-'sent'
      // row (excluded by the scheduler's own query, never re-enters here).
      const fixedFeeDecision = resolveFixedFeeSchedulingDecision(
        { invoice_type: row.invoice_type, period_start: row.period_start, period_end: row.period_end },
        terms.fixed_fee_billing_timing,
        today,
      )
      if (fixedFeeDecision.action === 'hold') {
        await supabaseServer.from('planned_invoices').update({ status: 'scheduled', processing_started_at: null }).eq('id', row.id)
        results.push({ id: row.id, ok: false, held: true, error: fixedFeeDecision.reason })
        continue
      }
      if (fixedFeeDecision.action === 'not_yet_due') {
        await supabaseServer.from('planned_invoices').update({ status: 'scheduled', processing_started_at: null }).eq('id', row.id)
        continue
      }

      const customerId = (job.billing_customer_id as string | null)
        ?? (typeof job === 'object' && 'billing_customer_id' in job ? String(job.billing_customer_id) : null)

      if (!customerId) throw new Error(`No billing_customer_id for job ${row.job_id}`)

      const billingPlatform = (job.billing_platform as string | null) ?? 'stripe'
      const cur             = (terms.currency ?? 'EUR').toLowerCase()
      const periodStart     = new Date(row.period_start + 'T00:00:00')
      const periodEnd       = new Date(row.period_end   + 'T23:59:59')
      const fmtPeriod       = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
      const daysUntilDue    = terms.payment_terms_days ?? 30
      // Real per-unit breakdown (from the approved line_items row, e.g. "4
      // connectors @ 45,000"), when one was captured at push/parked-confirm
      // time — null for period rows and one-time fees without a real quantity.
      const rowQuantity  = row.quantity  != null ? Number(row.quantity)   : null
      const rowUnitPrice = row.unit_price != null ? Number(row.unit_price) : null
      const hasBreakdown = rowQuantity != null && rowUnitPrice != null && rowQuantity > 0 && rowUnitPrice > 0

      const description = (row.fee_label
        ?? (row.invoice_type === 'terminal_settlement'
          ? `Final period settlement (${fmtPeriod(new Date(row.settlement_period_start + 'T00:00:00'))} – ${fmtPeriod(new Date(row.settlement_period_end + 'T00:00:00'))})`
          : `Base subscription — Year ${row.year_num ?? 1} (${fmtPeriod(periodStart)} – ${fmtPeriod(periodEnd)})`))
        + (hasBreakdown ? ` — ${rowQuantity.toLocaleString()} × ${cur.toUpperCase()} ${rowUnitPrice.toLocaleString()}` : '')

      let sentInvoiceId:  string | null = null
      let sentInvoiceUrl: string | null = null

      // ── Durable execution payload — point 7 of the Stage-B recovery fix ──
      // Everything below that depends on MUTABLE external state (meter
      // usage, credit ledger balances, VAT config) is computed ONCE and
      // persisted BEFORE any provider call. A row reclaimed from stale
      // 'processing' with a non-null execution_payload reuses it verbatim
      // — never recomputed, regardless of what usage/credits/org policy/
      // contract/evidence/clock look like at recovery time. This is
      // distinct from (and does not replace) computeOverageForPeriod and
      // applyCreditLedgerForPeriod's OWN individual idempotency — those
      // protect against a mid-computation crash (nothing durable yet, so
      // recomputing IS the first real computation); this payload protects
      // the case where computation already completed once, by making sure
      // it's never asked again.
      type ExecutionPayload = {
        overageLineItems: OverageLineItem[]
        creditLineItems: import('@/lib/credit-ledger-service').CreditLineItem[]
        netAmount: number
        vatNetAmount: number
        vatRatePct: number
        vatAmount: number
        expectedGrossAmount: number
        vatModeUsed: 'rate' | 'zero_rated' | 'not_configured'
        vatSourceUsed: 'override' | 'customer_default'
      }

      let payload: ExecutionPayload
      if (row.execution_payload) {
        payload = row.execution_payload as ExecutionPayload
      } else {
        // Overage is billed in arrears, on the same invoice as the next
        // period's advance base fee — this row's own period_start/period_end
        // describe the period the BASE FEE covers (prepaid, hence due the
        // moment it starts). Usage for that period doesn't exist yet at that
        // point, so overage must be computed for the period that just closed
        // (the one immediately before this row), not this row's own period —
        // querying it fresh each run rather than trusting whatever was
        // recorded on that period's own (necessarily $0, prematurely-computed)
        // invoice.
        let overageLineItems: OverageLineItem[] = []
        let scanStart: string | null = null
        let scanEnd: string | null = null
        if (row.invoice_type === 'period') {
          const { data: prevPeriod } = await supabaseServer
            .from('planned_invoices')
            .select('period_start, period_end')
            .eq('job_id', row.job_id)
            .eq('invoice_type', 'period')
            .lt('period_end', row.period_start)
            .order('period_end', { ascending: false })
            .limit(1)
            .maybeSingle()

          // No prior invoice (this is the job's first) — scan from the
          // contract's own start date instead of skipping outright. A meter
          // with a shorter measurement cadence than the deal's first invoice
          // period (e.g. a monthly-measured metric inside a quarterly-billed
          // first invoice) can still have closed windows to bill even before
          // any invoice has ever gone out.
          scanStart = prevPeriod?.period_start ?? terms.contract_start_date
          // toISOString() converts to UTC first — on a server not running in
          // UTC that silently shifts this a day off from the local calendar
          // date d was built from. Format from d's own local fields instead.
          scanEnd    = prevPeriod?.period_end
            ?? (() => {
              const d = new Date(row.period_start + 'T00:00:00')
              d.setDate(d.getDate() - 1)
              const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
              return `${y}-${m}-${day}`
            })()

          // Terminal settlement, point 4 — future-renewal double-settlement
          // guard. If a terminal_settlement row for this job already claims
          // this exact candidate period (by its deterministic
          // settlement_period_end identity, never by description matching)
          // as its settlement target, that period's arrears are/will be
          // settled via the dedicated terminal row — this ordinary period
          // row's own backward-scan must not ALSO settle it. Only relevant
          // once renewal support is ever added and generates a new period
          // row whose own backward-scan would otherwise rediscover the same
          // final period; harmless/never matches for any ordinary period.
          if (scanEnd) {
            const { data: alreadyTerminallySettled } = await supabaseServer
              .from('planned_invoices')
              .select('id')
              .eq('job_id', row.job_id)
              .eq('invoice_type', 'terminal_settlement')
              .eq('settlement_period_end', scanEnd)
              .maybeSingle()
            if (alreadyTerminallySettled) {
              scanStart = null
              scanEnd = null
            }
          }

          if (scanStart) {
            overageLineItems = await computeOverageForPeriod({
              orgId: job.org_id, jobId: row.job_id, terms, customerId,
              periodStartUnix: Math.floor(new Date(scanStart + 'T00:00:00').getTime() / 1000),
              periodEndUnix:   Math.floor(new Date(scanEnd   + 'T23:59:59').getTime() / 1000),
              currency: cur,
              billingAsOfUnix: Math.floor(billingAsOf.getTime() / 1000),
            })
            // Step 17C.1 — same closed-period arrears scan, a separate
            // producer of the SAME OverageLineItem shape (never a separate
            // "performance billing engine"); concatenated so every
            // downstream consumer (credit-ledger pool, netAmount, VAT,
            // provider push) sees it exactly like any other computed-in-
            // arrears line item without needing its own branch. scanEnd is
            // always set alongside scanStart above (never independently
            // null) — the extra check here is purely for TypeScript
            // narrowing, not a real runtime possibility.
            if (scanEnd) {
              overageLineItems = overageLineItems.concat(
                await computePerformanceShareLineItemsForPeriod({
                  jobId: row.job_id, terms, currency: cur, periodStart: scanStart, periodEnd: scanEnd,
                  asOf: billingAsOf.toISOString(),
                }),
              )
              // Step 17D, item 10 — same additive, never-blocks-the-invoice
              // producer pattern as performance-share above; a generic
              // per-unit additional_recurring_fee (e.g. the €0.38 request
              // fee) now has a real quantity source instead of never being
              // billable at all.
              overageLineItems = overageLineItems.concat(
                await computePerUnitFeeLineItemsForPeriod({
                  jobId: row.job_id, orgId: job.org_id, terms, currency: cur, periodStart: scanStart, periodEnd: scanEnd,
                  asOf: billingAsOf.toISOString(), finalize: true,
                }),
              )
            }
          }

          // Step 17D.2, item D — a usage fact that feeds ONLY a rolling
          // volume-band migration (no overage tier, no per-unit fee
          // referencing the same semantic_input_key) would otherwise never
          // get its closed-period value pinned by anything:
          // computeOverageForPeriod/computePerUnitFeeLineItemsForPeriod
          // above only finalize the semantic keys that actually produced a
          // line item on THIS invoice. Finalizing the rolling migration's
          // own required input(s) here, for the SAME closed window this
          // tick just billed, closes that gap. Idempotent
          // (finalizeClosedPeriodUsageQuantity never rewrites an existing
          // pin) — when the key was ALREADY finalized above (because it
          // also feeds an overage tier or per-unit fee), this is a pure
          // snapshot-table read, never a second meter/API pull; when it
          // wasn't, this is that input's one and only pull for this
          // period, done through the authoritative finalize path rather
          // than left to drift as an unpinned 'closed_period_read' forever
          // (which evaluateRollingBandMigrations below only ever performs).
          if (scanStart && scanEnd) {
            const rollingInputKeys = new Set(
              (terms.unsupported_commercial_mechanisms ?? [])
                .filter(m => m.execution_status === 'executable' && m.rolling_band_migration?.aggregate?.input_key)
                .map(m => m.rolling_band_migration!.aggregate.input_key),
            )
            for (const inputKey of rollingInputKeys) {
              await resolveUsageQuantityForPeriod({
                jobId: row.job_id, orgId: job.org_id, semanticInputKey: inputKey,
                periodStart: new Date(scanStart + 'T00:00:00'), periodEnd: new Date(scanEnd + 'T23:59:59'),
                asOf: billingAsOf, mode: 'closed_period_finalize',
              }).catch(err => console.error(`[invoice-scheduler] failed to finalize rolling-migration input '${inputKey}' for job ${row.job_id}:`, err))
            }
          }

          // Step 17C.2 (revised 17C.2a) — rolling-window volume-band
          // pricing transition detection + future-schedule reconciliation.
          // Purely additive: never touches overageLineItems, never affects
          // THIS invoice's own amount, and failure here must never block
          // the invoice this loop iteration is actually building.
          // detect_rolling_band_pricing_transition/_pricing_required_event
          // (item 12) are themselves advisory-locked/idempotent, so a
          // second scheduler run safely converges on the same persisted
          // row rather than creating a duplicate. reconcileActiveRollingBandTransitions
          // (17C.2a items 4/5) is itself idempotent by construction — see
          // its own header — so running it on every tick is safe.
          try {
            const rollingBandEvaluations = await evaluateRollingBandMigrations({
              jobId: row.job_id, orgId: job.org_id, terms, asOf: billingAsOf.toISOString(),
            })
            await persistTriggeredRollingBandMigrations({
              jobId: row.job_id, orgId: job.org_id, terms, evaluations: rollingBandEvaluations,
            })
            await reconcileActiveRollingBandTransitions({
              jobId: row.job_id, orgId: job.org_id, terms, asOf: billingAsOf,
            })
          } catch (rollingBandErr) {
            console.error(`[invoice-scheduler] rolling-band migration detection failed for job ${row.job_id}:`, rollingBandErr)
          }
        } else if (row.invoice_type === 'terminal_settlement') {
          // Deterministic settlement target — never a backward "previous
          // period" lookup. row.settlement_period_start/end were persisted
          // at schedule-generation time (lib/terminal-settlement.ts) as the
          // contract's real final service period; the scheduler reads them
          // directly rather than inferring anything.
          scanStart = row.settlement_period_start
          scanEnd   = row.settlement_period_end
          if (scanStart && scanEnd) {
            overageLineItems = await computeOverageForPeriod({
              orgId: job.org_id, jobId: row.job_id, terms, customerId,
              periodStartUnix: Math.floor(new Date(scanStart + 'T00:00:00').getTime() / 1000),
              periodEndUnix:   Math.floor(new Date(scanEnd   + 'T23:59:59').getTime() / 1000),
              currency: cur,
              // Same closed-window invariant as every other real-billing
              // caller — computeOverageForPeriod's own isBillingWindowClosed
              // check (point 5) still fails closed if this row's own due-
              // date eligibility (period_start <= today, the trigger date)
              // were ever somehow reached before the settlement window
              // itself has genuinely closed.
              billingAsOfUnix: Math.floor(billingAsOf.getTime() / 1000),
            })
            overageLineItems = overageLineItems.concat(
              await computePerformanceShareLineItemsForPeriod({
                jobId: row.job_id, terms, currency: cur, periodStart: scanStart, periodEnd: scanEnd,
                asOf: billingAsOf.toISOString(),
              }),
            )
            overageLineItems = overageLineItems.concat(
              await computePerUnitFeeLineItemsForPeriod({
                jobId: row.job_id, orgId: job.org_id, terms, currency: cur, periodStart: scanStart, periodEnd: scanEnd,
                asOf: billingAsOf.toISOString(), finalize: true,
              }),
            )
          }
        }

        // ── Credits/rebates ────────────────────────────────────────────────
        // Computed once, platform-agnostically, before either downstream
        // branch runs — the fail-closed capability gate must be checked (and
        // must be able to throw) BEFORE a Remembill invoice is ever created,
        // not after. Zero reservation happens in the blocked case, so a
        // credit whose invoice can't be sent correctly is never consumed.
        // Also runs for terminal_settlement rows — point 8/9: this is what
        // makes the full Contract Year window visible to the Annual
        // Rebate's earning pass, and what applies any already-eligible
        // balance against September's real components.
        let creditLineItems: import('@/lib/credit-ledger-service').CreditLineItem[] = []
        if (row.invoice_type === 'period' || row.invoice_type === 'terminal_settlement') {
          // componentClass is the canonical commercial classification a
          // credit's eligible_component_keys actually matches against (see
          // lib/commercial-component-scope.ts) — resolved here from the
          // contract's own contractUnitType, NEVER from the operational
          // meter_key (which stays on the pool entry's own `key` field only
          // for ledger consumption bookkeeping/audit, unchanged). The
          // 'platform_fee' entry's class is the literal constant itself —
          // no resolution needed, it's already canonical.
          const fullComponentPool = [
            { key: 'platform_fee', amountMinor: Math.round(Number(row.base_amount) * 100), componentClass: 'platform_fee' as const },
            ...overageLineItems.map(i => ({
              key: i.meter_key, amountMinor: Math.round(i.amount * 100),
              componentClass: classifyContractUnitType(i.contractUnitType),
            })),
          ]
          const outcome = await applyCreditLedgerForPeriod({
            jobId: row.job_id, orgId: job.org_id, terms, customerId, billingPlatform,
            plannedInvoiceId: row.id, periodStart: row.period_start, periodEnd: row.period_end,
            fullComponentPool,
            scanStart: new Date((scanStart ?? row.period_start) + 'T00:00:00'),
            scanEnd: new Date((scanEnd ?? row.period_end) + 'T00:00:00'),
          })
          if (outcome.status === 'blocked') {
            // Fail closed — do not create/send an invoice missing a
            // contractual credit. Nothing was reserved, so the balance stays
            // fully available for the next attempt (e.g. once a verified
            // Remembill representation exists). Verdix's own calculated
            // figures (gross/available/proposed/net) remain inspectable via
            // the credit_ledger_entries rows the earning pass already wrote,
            // independent of this delivery block.
            throw new Error(outcome.reason)
          }
          if (outcome.status === 'applied') creditLineItems = outcome.creditLineItems
        }

        // ── VAT ─────────────────────────────────────────────────────────────
        // Verdix owns the complete invoice instruction — net/VAT/gross is
        // calculated here, once, platform-agnostically, before either
        // downstream branch runs (same placement discipline as the credit
        // ledger's fail-closed gate above). Neither Remembill nor Stripe ever
        // decides which rate applies; they only mechanically apply the value
        // already resolved here. Invoice-level override (if ever set for this
        // specific planned_invoice) wins over the customer's standing default.
        const netAmount = Number(row.base_amount)
          + overageLineItems.reduce((s, i) => s + i.amount, 0)
          + creditLineItems.reduce((s, i) => s + i.amount, 0)
        const [customerVat, invoiceVatOverride] = await Promise.all([
          getCustomerVatConfig(job.org_id, customerId),
          getInvoiceVatOverride(row.id),
        ])
        const vatTreatment = resolveVatTreatment(customerVat, invoiceVatOverride)
        const vatResult = computeVat(netAmount, vatTreatment)
        if (!vatResult.ok) {
          // Fail closed — do not create/send an invoice with an unconfirmed
          // VAT treatment. Mirrors the credit ledger's identical throw-before-
          // either-platform-branch pattern above.
          throw new Error(`Billing blocked: ${vatResult.reason}`)
        }
        const { netAmount: vatNetAmount, vatRatePct, vatAmount, grossAmount: expectedGrossAmount } = vatResult.calculation

        payload = {
          overageLineItems, creditLineItems, netAmount, vatNetAmount, vatRatePct, vatAmount, expectedGrossAmount,
          vatModeUsed: vatTreatment.mode, vatSourceUsed: invoiceVatOverride ? 'override' : 'customer_default',
        }

        // Persisted BEFORE any provider call — this is what a later
        // reclaim reads back instead of recomputing. Logged, not thrown,
        // on failure: we still have the correct in-memory payload to
        // proceed with this attempt; only a crash from here onward would
        // force a genuine recompute on the next reclaim.
        const { error: payloadError } = await supabaseServer
          .from('planned_invoices')
          .update({ execution_payload: payload })
          .eq('id', row.id)
        if (payloadError) {
          console.error(`[invoice-scheduler] failed to persist execution_payload for ${row.id}`, payloadError)
        }
      }
      const {
        overageLineItems, creditLineItems, vatNetAmount, vatRatePct, vatAmount, expectedGrossAmount,
        vatModeUsed, vatSourceUsed,
      } = payload

      // Ambiguous-recovery guard, Remembill only — a non-null stripe_invoice_id
      // here means a PRIOR attempt already got far enough to create a real
      // provider invoice (persisted immediately after creation below, on
      // every attempt). Stripe's own idempotency-key coverage (added below,
      // on every invoice/item/finalize call, all stable across recovery)
      // makes retrying past that point safe. Remembill's is NOT: per this
      // codebase's own established finding (lib/credit-ledger-service.ts's
      // Remembill row-posting comment), its Idempotency-Key header is only
      // honored on invoice CREATION, never on the row-creation endpoint — a
      // blind retry past a successful create could duplicate line items on
      // an invoice that already exists. Preserving existing Remembill
      // verification behavior means not touching how those calls work;
      // instead, fail closed here rather than ever risk it — this is
      // exactly the "provider-specific/manual reconciliation" path point 6
      // explicitly allows for a provider lacking a sufficiently strong
      // idempotency guarantee at every step.
      if (billingPlatform === 'remembill' && row.stripe_invoice_id) {
        throw new Error(
          `Row already has a Remembill provider reference (${row.stripe_invoice_id}) from a prior attempt — ` +
          `ambiguous state (rows/email may have partially sent), requires manual reconciliation before retry.`,
        )
      }

      // Stripe Tax Rate objects are reused across invoices (one per unique
      // percentage), not recreated every run — created lazily just before
      // the Stripe branch needs one, so the Remembill branch never touches
      // the Stripe SDK/API at all.
      let stripeTaxRateId: string | null = null
      // The platform's own returned total for the created invoice, when
      // fetchable — compared against expectedGrossAmount below to detect a
      // real VAT/rounding divergence rather than assuming they match.
      let actualGrossAmount: number | null = null

      // Terminal settlement, points 6/7 — a row with genuinely nothing to
      // charge (no base amount, no overage/minimum, no credits) must never
      // create a pointless empty/zero provider invoice — real for a
      // terminal_settlement row whose final period had zero usage and no
      // minimum commitment; a no-op check for every other row type, which
      // always has base_amount > 0 by construction.
      const hasSomethingToBill = Number(row.base_amount) > 0 || overageLineItems.length > 0 || creditLineItems.length > 0

      if (!hasSomethingToBill) {
        // sentInvoiceId/sentInvoiceUrl/actualGrossAmount stay null — the row
        // is marked 'sent' below with zero amounts and no provider call at all.
      } else if (billingPlatform === 'remembill') {
        const { data: rbIntegration } = await supabaseServer
          .from('org_integrations')
          .select('config')
          .eq('org_id', job.org_id)
          .eq('connector_name', 'remembill')
          .eq('is_active', true)
          .maybeSingle()

        const rbKey = (rbIntegration?.config as Record<string, string>)?.api_key ?? process.env.REMEMBILL_API_KEY!
        const rbH   = remembillHeaders(rbKey)
        const today = new Date()
        const fmtDate = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

        // Create draft invoice
        const invRes = await fetch(`${REMEMBILL_BASE}/invoices`, {
          method: 'POST', headers: { ...rbH, 'Idempotency-Key': remembillInvoiceIdempotencyKey(row.id) },
          body: JSON.stringify({
            customer_id:   customerId,
            currency:      cur.toUpperCase(),
            issue_date:    fmtDate(today),
            due_date:      fmtDate(new Date(today.getTime() + daysUntilDue * 86_400_000)),
            payment_terms: `Net ${daysUntilDue}`,
          }),
        })
        if (!invRes.ok) {
          const rawBody = await invRes.text()
          console.error('[invoice-scheduler/remembill] invoice creation failed', invRes.status, rawBody)
          throw new Error(`Remembill invoice creation failed (${invRes.status}): ${rawBody}`)
        }
        const invoiceId = ((await invRes.json()) as { id: string }).id

        // Persisted immediately — durable proof a provider invoice now
        // exists, BEFORE any further (non-idempotency-protected) row/email
        // calls. This is the exact signal the ambiguous-recovery guard
        // above checks on any future reclaim of this row.
        await supabaseServer.from('planned_invoices').update({ stripe_invoice_id: invoiceId }).eq('id', row.id)

        // Add line item row (amount in minor units, e.g. öre for SEK).
        // Real quantity/unit_price when we have a per-unit breakdown, else
        // the previous flat quantity=1/total-as-price behavior.
        // vat: integer percent (0-100), per Remembill's row schema — never
        // omitted (was previously hardcoded to 0 elsewhere in this
        // codebase; this row body simply never included the field at all).
        // Remembill only accepts a per-row percentage, not an invoice-level
        // VAT object or a "code" — the same resolved rate is applied to
        // every row of a given invoice; Verdix's own net/VAT/gross figures
        // (computed above, persisted below) remain the authoritative record
        // regardless of how Remembill's own totals present it.
        const rbVat = Math.round(vatRatePct)
        await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
          method: 'POST', headers: rbH,
          body: JSON.stringify(hasBreakdown
            ? { description, quantity: rowQuantity, unit_price: Math.round(rowUnitPrice * 100), vat: rbVat }
            : { description, quantity: 1, unit_price: Math.round(Number(row.base_amount) * 100), vat: rbVat }),
        })

        // Overage rows — one per metered item with usage above its included allowance
        for (const item of overageLineItems) {
          await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/rows`, {
            method: 'POST', headers: rbH,
            body: JSON.stringify({ description: item.description, quantity: 1, unit_price: Math.round(item.amount * 100), vat: rbVat }),
          }).catch(err => console.error(`[invoice-scheduler/remembill] overage row failed for meter '${item.meter_key}'`, err))
        }

        // Deliver via email
        await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}/email`, {
          method: 'POST', headers: rbH, body: JSON.stringify({}),
        }).catch(err => console.error('[invoice-scheduler/remembill] email delivery failed', err))

        sentInvoiceId  = invoiceId
        sentInvoiceUrl = remembillAppUrl(`/invoices/${invoiceId}`)

        // Reconcile: read the invoice back and compare Remembill's own
        // returned total against Verdix's expected gross — never assumed
        // to match just because the calls above succeeded.
        try {
          const getRes = await fetch(`${REMEMBILL_BASE}/invoices/${invoiceId}`, { headers: rbH })
          if (getRes.ok) {
            const invJson = await getRes.json() as Record<string, unknown>
            const invObj = (invJson.invoice ?? invJson.data ?? invJson) as Record<string, unknown>
            const rawTotal = invObj.total ?? invObj.total_amount ?? invObj.amount_total
            if (typeof rawTotal === 'number') actualGrossAmount = rawTotal / 100
          }
        } catch (err) {
          console.error('[invoice-scheduler/remembill] post-send reconciliation fetch failed', err)
        }

      // ── Stripe path (default) ─────────────────────────────────────────────
      } else {
        const { data: integration } = await supabaseServer
          .from('org_integrations')
          .select('config')
          .eq('org_id', job.org_id)
          .eq('connector_name', 'stripe')
          .eq('is_active', true)
          .maybeSingle()

        const stripeKey = (integration?.config as Record<string, string>)?.secret_key
          ?? process.env.STRIPE_SECRET_KEY!

        const { default: Stripe } = await import('stripe')
        const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' })

        // A Stripe Tax Rate object, reused across invoices for the same
        // percentage rather than recreated every run — this is purely a
        // mechanical container for a rate Verdix already decided, not tax
        // determination: Stripe never picks the percentage, it only applies
        // the one already resolved above. zero_rated needs no tax_rates
        // attachment at all (no monetary effect either way).
        if (vatModeUsed === 'rate' && vatRatePct > 0) {
          const existing = await stripe.taxRates.list({ active: true, limit: 100 })
          const match = existing.data.find(tr => tr.display_name === 'VAT' && tr.percentage === vatRatePct && !tr.inclusive)
          stripeTaxRateId = match?.id
            ?? (await stripe.taxRates.create({ display_name: 'VAT', percentage: vatRatePct, inclusive: false })).id
        }
        const taxRates = stripeTaxRateId ? [stripeTaxRateId] : undefined

        // Every call below carries a real Stripe idempotency key, stable
        // across recovery (derived only from row.id and other already-
        // durable identifiers — never anything regenerated per attempt).
        // Previously only the credit-adjustment items had one; invoice
        // creation, the base/overage items, and finalization did not —
        // found and fixed while auditing this exact recovery path.
        //
        // invoiceId resolution — prefer Verdix's own durable knowledge
        // over re-deriving it from Stripe. row.stripe_invoice_id is
        // persisted immediately below, the instant invoice creation
        // succeeds, before any further Stripe call — so on a later
        // reclaim it is Verdix's authoritative record that creation
        // already happened. Calling invoices.create() again WOULD still
        // be safe (Stripe's own idempotency key returns the identical
        // object rather than a duplicate), but it's an unnecessary
        // round-trip and treats already-known state as unknown; the
        // known reference is used directly instead. The idempotency key
        // remains essential for the one window this can't cover — a
        // request sent, the provider may have created the invoice, but
        // the process crashed before row.stripe_invoice_id itself got
        // persisted — that case still falls into the `else` branch below
        // and relies on the key exactly as before.
        let invoiceId: string
        if (row.stripe_invoice_id) {
          invoiceId = row.stripe_invoice_id as string
        } else {
          const inv = await stripe.invoices.create({
            customer:                       customerId,
            collection_method:              'send_invoice',
            days_until_due:                 daysUntilDue,
            pending_invoice_items_behavior: 'exclude',
            metadata: {
              verdix_job:      row.job_id,
              invoice_type:    row.invoice_type,
              year:            String(row.year_num ?? ''),
              scheduled_date:  row.period_start,
              planned_invoice: row.id,
            },
          }, { idempotencyKey: stripeInvoiceIdempotencyKey(row.id) })
          invoiceId = inv.id

          // Persisted immediately — durable proof a provider invoice now
          // exists, before any further Stripe calls. Mirrors the
          // Remembill branch's identical early persist above.
          await supabaseServer.from('planned_invoices').update({ stripe_invoice_id: invoiceId }).eq('id', row.id)
        }

        // Remaining operations (items, finalize) resume idempotently
        // regardless of which branch above supplied invoiceId — each call
        // below carries its own stable, row.id-derived key, so Stripe
        // transparently returns the already-completed result for any
        // operation a prior attempt finished, and genuinely executes only
        // what's still outstanding. This is what makes partial-completion
        // recovery (base item done, overage not yet; or every item done
        // but not yet finalized) safe without a second execution ledger —
        // the durable row (stripe_invoice_id + execution_payload) plus
        // these stable per-operation identities are sufficient.
        if (row.base_amount > 0) {
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     invoiceId,
            amount:      Math.round(Number(row.base_amount) * 100),
            currency:    cur,
            description,
            tax_rates:   taxRates,
          }, { idempotencyKey: stripeBaseItemIdempotencyKey(row.id) })
        }

        // ── Overage line items (already pulled + computed above) ────────────
        // Keyed by meter_key + windowStart (falling back to the item's
        // index when windowStart is absent — the legacy client_pull path
        // has no per-meter window) so two windows of the same meter within
        // one invoice each get a distinct, but still deterministic/stable,
        // identity across recovery.
        for (const [i, item] of overageLineItems.entries()) {
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     invoiceId,
            amount:      Math.round(item.amount * 100),
            currency:    cur,
            description: item.description,
            tax_rates:   taxRates,
            metadata: { metric_source: item.metric_source, meter_key: item.meter_key, total_units: String(item.total_units), verdix_job: row.job_id },
          }, { idempotencyKey: stripeOverageItemIdempotencyKey(row.id, item.meter_key, item.windowStart, i) })
        }

        // ── Credit/rebate adjustments (Stripe supports negative invoice-item
        // amounts natively — standard, well-documented behavior). Remembill
        // never reaches this point with a non-empty creditLineItems: the
        // fail-closed gate above already threw before either platform branch
        // if a Remembill job needed one.
        for (const item of creditLineItems) {
          await stripe.invoiceItems.create({
            customer:    customerId,
            invoice:     invoiceId,
            amount:      Math.round(item.amount * 100),
            currency:    cur,
            description: item.description,
            tax_rates:   taxRates,
            metadata: { credit_rule_id: item.credit_rule_id, verdix_job: row.job_id },
          }, { idempotencyKey: stripeCreditItemIdempotencyKey(row.id, item.credit_rule_id) })
        }

        const finalized = await stripe.invoices.finalizeInvoice(invoiceId, {}, { idempotencyKey: stripeFinalizeIdempotencyKey(row.id) })
        sentInvoiceId  = invoiceId
        sentInvoiceUrl = finalized.hosted_invoice_url ?? null
        // Reconcile: Stripe's own computed total (net + its own tax
        // calculation off the attached tax_rates) against Verdix's expected
        // gross — never assumed to match just because finalization succeeded.
        if (typeof finalized.total === 'number') actualGrossAmount = finalized.total / 100
      }

      // ── Mark planned_invoice as sent ──────────────────────────────────────
      await supabaseServer
        .from('planned_invoices')
        .update({
          status:                    'sent',
          stripe_invoice_id:         sentInvoiceId,
          stripe_invoice_url:        sentInvoiceUrl,
          sent_at:                   new Date().toISOString(),
          error_message:             null,
          overage_line_items:        overageLineItems,
          overage_total:             overageLineItems.reduce((s, i) => s + i.amount, 0),
          credit_line_items:         creditLineItems,
          credit_total:              creditLineItems.reduce((s, i) => s + i.amount, 0),
          vat_mode:                  vatModeUsed,
          vat_rate_pct:              vatModeUsed === 'rate' ? vatRatePct : null,
          vat_source:                vatSourceUsed,
          net_amount:                vatNetAmount,
          vat_amount:                vatAmount,
          gross_amount:              expectedGrossAmount,
          vat_reconciliation_status: reconcileGrossAmount(expectedGrossAmount, actualGrossAmount),
        })
        .eq('id', row.id)

      results.push({ id: row.id, ok: true, stripe_invoice_id: sentInvoiceId ?? undefined })
    } catch (err) {
      // Scheduler retry/hold audit (16B.4) — a commercial-quantity source
      // that isn't ready yet (e.g. a September meeting's rejection window
      // still open) is an EXPECTED, temporary hold, never a genuine
      // execution failure. status='failed' above is a TERMINAL state — the
      // scheduler's own selection query only ever matches status='scheduled'
      // (see the top of this file), so a row left 'failed' would never be
      // reconsidered by any later run even once its window closes and the
      // quantity becomes ready. Reusing this file's own existing "Held:"
      // convention (see the historical-terminal-settlement guard above,
      // which never even claims a held row in the first place) — this row
      // WAS already claimed to 'processing' before this try block started,
      // so unlike that guard, reverting the claim back to 'scheduled' is
      // required here for the next run to naturally re-select and retry it.
      // Generic — nothing here or in QuantitySourceNotReadyError itself
      // knows what a qualified unit, an SQM, or a meeting is.
      if (err instanceof QuantitySourceNotReadyError) {
        console.log(`[invoice-scheduler] planned_invoice ${row.id} held — commercial quantity source not yet ready: ${err.message}`)
        await supabaseServer
          .from('planned_invoices')
          .update({ status: 'scheduled', processing_started_at: null, error_message: `Held: ${err.message}` })
          .eq('id', row.id)
        results.push({ id: row.id, ok: false, held: true, error: `Held: ${err.message}` })
        continue
      }

      const message = err instanceof Error ? err.message : String(err)
      console.error(`[invoice-scheduler] failed for planned_invoice ${row.id}`, err)

      await supabaseServer
        .from('planned_invoices')
        .update({ status: 'failed', error_message: message })
        .eq('id', row.id)

      results.push({ id: row.id, ok: false, error: message })
    }
  }

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.filter(r => !r.ok).length
  console.log(`[invoice-scheduler] processed ${results.length}: ${succeeded} ok, ${failed} failed`)

  return NextResponse.json({ processed: results.length, succeeded, failed, results })
}
