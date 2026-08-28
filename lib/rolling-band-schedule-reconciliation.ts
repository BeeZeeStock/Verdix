// Step 17C.2a items 4/5, revised 17C.2b items B/C/D — the smallest safe
// future-only reconciliation of the PREBUILT planned_invoices schedule
// (Stage A, lib/billing-writer.ts) once a rolling-band pricing transition's
// effective timing is known.
//
// Deliberately does NOT touch lib/billing-writer.ts's computeBillingSchedule/
// computeMonthlyBaseRate: not a full schedule rebuild, not a DB-aware pure
// function, not a contract_terms mutation. Instead this module reproduces,
// for ONE row at a time, the exact per-month formula Stage A's own two
// branches already use — item D removed the last copy of that formula:
// both computeBillingSchedule branches and this module now call the SAME
// exported lib/billing-writer.ts#computeFixedFeePeriodAmount, so there is
// exactly one place "(base + additional) * escalator * discount" is ever
// computed, never a second copy that could silently drift.
//
// Scope guard (item 4's "smallest safe"): only supported for the exact
// billing shape Stage A's periodsFlat branch itself uses — monthly
// cadence, no calendar-anchored base_fee_proration, no ramp_schedule/
// year_pricing (both of which already encode their own step-ups
// independent of base_fee_bands). Any other shape holds the WHOLE
// reconciliation with unsupportedShape set — never attempts a broader,
// unverified generalization of Stage A's multi-month/calendar-anchored
// math.
import { supabaseServer } from '@/lib/supabase'
import { computeEscalatorMultiplier, computeDiscountMultiplier, computeFixedFeePeriodAmount } from '@/lib/billing-writer'
import type { ContractTerms, FixedFeeBand } from '@/lib/types'

export interface ScheduleReconciliationResult {
  // Rows recomputed to the transition's new effective band (fully AFTER
  // effective_from — item 4/C's "future scheduled periods → recompute").
  recomputed: number
  // Rows straddling effective_from with no proration rule — held as
  // Decision Required, base_amount left untouched (item 5/C).
  held: number
  // Step 17C.2b, item B — previously-held ('decision_required') rows
  // ATTRIBUTABLE TO THIS TRANSITION that are now fully after effective_from
  // (no longer straddling, or never should have been under the corrected
  // boundary — item C) and were recovered: recomputed, hold cleared,
  // status returned to 'scheduled'.
  recovered: number
  // Rows examined but left alone: fully BEFORE effective_from (item 4's
  // "periods before effective_from → untouched"), already correctly held
  // by this same transition (no change needed), or claimed/processing/
  // sent between this reconciliation's read and write (item 4's "already
  // claimed/processing/finalized → do not rewrite it").
  skipped: number
  // Non-null only when the WHOLE job's billing shape isn't one this
  // reconciler supports (see the module header) — nothing was examined or
  // written at all.
  unsupportedShape: string | null
}

function isSupportedBillingShape(terms: ContractTerms): string | null {
  if (terms.billing_frequency !== 'monthly') {
    return `reconciliation only supports monthly cadence (this contract is ${terms.billing_frequency ?? 'unknown'})`
  }
  if (terms.base_fee_proration?.reset_anchor === 'calendar') {
    return 'reconciliation does not support calendar-anchored base-fee proration'
  }
  if (terms.ramp_schedule?.length) {
    return 'reconciliation does not support a ramp_schedule (it already encodes its own step-ups independent of base_fee_bands)'
  }
  if (terms.year_pricing) {
    return 'reconciliation does not support year_pricing (it already encodes its own step-ups independent of base_fee_bands)'
  }
  if (!terms.contract_start_date) {
    return 'no contract_start_date to anchor month indices'
  }
  return null
}

interface PlannedInvoiceRow {
  id: string
  period_start: string
  period_end: string
  base_amount: number
  status: string
  rolling_band_hold_transition_id: string | null
}

// Step 17C.2b, item C — a transition straddles a period ONLY when
// period_start < effective_from < period_end, strictly on both sides.
// effective_from === period_start means the new band governs the WHOLE
// period (there is no "old" portion left in it); effective_from ===
// period_end means the OLD band still governs the WHOLE period (the
// transition only takes hold starting the NEXT period, the first whole
// day after this one's own inclusive end date).
type PeriodClassification = 'before_or_at_effective' | 'after_or_at_effective' | 'straddling'

function classifyPeriod(periodStart: Date, periodEnd: Date, effectiveFromDate: Date): PeriodClassification {
  if (effectiveFromDate <= periodStart) return 'after_or_at_effective'
  if (effectiveFromDate >= periodEnd) return 'before_or_at_effective'
  return 'straddling'
}

// Atomic/idempotent by construction (item 4/8), not by advisory lock: the
// per-row target amount is a PURE function of (terms, transition,
// periodStart) — two concurrent reconciliation runs always compute the
// IDENTICAL target for the same row, so a last-write-wins race between
// them is harmless (both write the same value). The real safety property
// — never rewriting a row a concurrent scheduler run has already claimed
// — comes from the conditional `.eq('status', ...)` guard on every write
// below, the same optimistic-concurrency guard app/api/admin/invoice-
// scheduler/route.ts already uses to claim a row for real billing. Running
// this function twice in a row (or twice concurrently) against unchanged
// inputs always produces the same final planned_invoices state — including
// the recovery path (item B): a row already recovered by a concurrent run
// is simply not matched a second time (its status is no longer
// 'decision_required' with THIS transition's id).
export async function reconcileFutureScheduleForTransition(params: {
  jobId: string
  orgId: string
  terms: ContractTerms
  transition: { id: string; to_band: FixedFeeBand; effective_from: string }
}): Promise<ScheduleReconciliationResult> {
  const { jobId, terms, transition } = params

  const unsupportedShape = isSupportedBillingShape(terms)
  if (unsupportedShape) return { recomputed: 0, held: 0, recovered: 0, skipped: 0, unsupportedShape }

  const effectiveMonthlyFee = transition.to_band.monthly_fee
  if (effectiveMonthlyFee == null) {
    // Should never happen — only a REAL priced transition (never a
    // pricing_required row) is ever passed in as `transition` by the pull
    // layer's reconcileActiveRollingBandTransitions. Fail closed anyway
    // rather than silently charging a null fee as 0.
    return { recomputed: 0, held: 0, recovered: 0, skipped: 0, unsupportedShape: 'transition has no numeric effective_monthly_fee — cannot reconcile' }
  }

  const effectiveFromDate = new Date(transition.effective_from + 'T00:00:00')
  const additionalMonthlyFlat = (terms.additional_recurring_fees ?? []).reduce((s, f) => s + (f.amount ?? 0), 0)

  // Item B — considers BOTH ordinary future 'scheduled' rows AND
  // previously-'decision_required' rows, so a hold can be recovered once
  // this same transition's effective timing makes it no longer applicable.
  const { data: rows, error } = await supabaseServer
    .from('planned_invoices')
    .select('id, period_start, period_end, base_amount, status, rolling_band_hold_transition_id')
    .eq('job_id', jobId)
    .eq('invoice_type', 'period')
    .in('status', ['scheduled', 'decision_required'])
  if (error) {
    console.error(`[rolling-band-schedule-reconciliation] failed to load planned_invoices for job ${jobId}:`, error.message)
    return { recomputed: 0, held: 0, recovered: 0, skipped: 0, unsupportedShape: null }
  }

  let recomputed = 0, held = 0, recovered = 0, skipped = 0

  for (const row of (rows ?? []) as PlannedInvoiceRow[]) {
    // A 'decision_required' row not held BY THIS transition is never this
    // transition's to touch — untouched, regardless of what its own
    // classification would say (item B's "rows attributable to this
    // transition" scoping).
    if (row.status === 'decision_required' && row.rolling_band_hold_transition_id !== transition.id) {
      skipped++
      continue
    }

    const periodStart = new Date(row.period_start + 'T00:00:00')
    const periodEnd = new Date(row.period_end + 'T00:00:00')
    const classification = classifyPeriod(periodStart, periodEnd, effectiveFromDate)

    if (classification === 'before_or_at_effective') {
      // Fully before (or effective_from lands exactly on period_end, which
      // still means the OLD band governs this whole period — item C) —
      // untouched. A held row can't legitimately reach this branch under
      // the corrected boundary logic, but the guard costs nothing.
      skipped++
      continue
    }

    if (classification === 'after_or_at_effective') {
      // Fully after (or effective_from lands exactly on period_start,
      // which means the NEW band governs this whole period — item C).
      // Reuses Stage A's own exported multiplier + arithmetic functions
      // unchanged (item D); only the base-fee term is substituted.
      const escMult = computeEscalatorMultiplier(terms, periodStart)
      const discMult = computeDiscountMultiplier(terms, periodStart)
      const newBaseAmount = computeFixedFeePeriodAmount(effectiveMonthlyFee, additionalMonthlyFlat, escMult, discMult)

      if (row.status === 'decision_required') {
        // Item B — recovery: this row was held by THIS transition, and
        // under its (possibly re-resolved) effective_from it's no longer
        // straddling. Recompute, clear the hold, return to 'scheduled'.
        // Guard scoped to BOTH the exact status AND the exact holding
        // transition — never reopens a row 'processing'/'sent'/'paid'/
        // 'failed', and never touches a hold this transition didn't create.
        const { data: recoveredRows, error: recoverError } = await supabaseServer
          .from('planned_invoices')
          .update({ base_amount: newBaseAmount, status: 'scheduled', error_message: null, rolling_band_hold_transition_id: null })
          .eq('id', row.id)
          .eq('status', 'decision_required')
          .eq('rolling_band_hold_transition_id', transition.id)
          .select('id')
        if (recoverError) {
          console.error(`[rolling-band-schedule-reconciliation] failed to recover held planned_invoices row ${row.id}:`, recoverError.message)
          skipped++
          continue
        }
        if (!recoveredRows || recoveredRows.length === 0) {
          skipped++
          continue
        }
        recovered++
        continue
      }

      if (Math.abs(newBaseAmount - Number(row.base_amount)) < 1e-9) {
        // Already correct (a prior reconciliation run already wrote this
        // exact value, or it happens to coincide) — no write needed, and
        // still counts toward "recomputed" since the row genuinely
        // reflects the effective band right now.
        recomputed++
        continue
      }

      const { data: updated, error: updateError } = await supabaseServer
        .from('planned_invoices')
        .update({ base_amount: newBaseAmount })
        .eq('id', row.id)
        .eq('status', 'scheduled') // guards against a concurrent claim between read and write
        .select('id')
      if (updateError) {
        console.error(`[rolling-band-schedule-reconciliation] failed to update planned_invoices row ${row.id}:`, updateError.message)
        skipped++
        continue
      }
      if (!updated || updated.length === 0) {
        // Claimed by a concurrent scheduler run between our read and this
        // write — item 4's "already claimed/processing/finalized: do not
        // rewrite it". Never retried within this pass.
        skipped++
        continue
      }
      recomputed++
      continue
    }

    // Straddling (item C: period_start < effective_from < period_end) —
    // no proration rule governs a mid-period pricing transition (item 5) —
    // hold as Decision Required. base_amount is left exactly as-is
    // (neither the old nor the new full-month amount is asserted as
    // correct); the row is taken out of normal scheduling by its own
    // status change, so invoice-scheduler's `.eq('status','scheduled')`
    // selection query can never pick it up and bill it at either rate.
    if (row.status === 'decision_required' && row.rolling_band_hold_transition_id === transition.id) {
      // Already correctly held by this exact transition — nothing to do,
      // and re-running this pass produces no repeated write (idempotent).
      skipped++
      continue
    }

    const holdReason = `Decision required: pricing transition ${transition.id} takes effect ${transition.effective_from}, which falls inside this billing period (${row.period_start}–${row.period_end}) — no proration rule governs a mid-period transition. Neither the prior nor the new band's full-month fee is charged automatically.`
    const { data: held_, error: holdError } = await supabaseServer
      .from('planned_invoices')
      .update({ status: 'decision_required', error_message: holdReason, rolling_band_hold_transition_id: transition.id })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
    if (holdError) {
      console.error(`[rolling-band-schedule-reconciliation] failed to hold planned_invoices row ${row.id}:`, holdError.message)
      skipped++
      continue
    }
    if (!held_ || held_.length === 0) {
      skipped++
      continue
    }
    held++
  }

  return { recomputed, held, recovered, skipped, unsupportedShape: null }
}
