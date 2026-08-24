/**
 * Scheduler-side defense-in-depth for terminal_settlement rows —
 * independent of, and in addition to, whatever a migration/backfill
 * process wrote into `status`. Migration state is not the sole safety
 * control: this check re-derives "is this row historical/late-created"
 * from the row's own already-durable timestamps at read time, so it still
 * holds even if a status-correction migration was never applied, was
 * applied out of order relative to the original backfill in some other
 * environment, or a future code path inserts a terminal_settlement row
 * directly.
 *
 * Invariant: a `status='scheduled'` terminal_settlement row whose
 * `created_at` (the moment the row itself came into existence) is already
 * on/after its own `period_start` (the trigger date the scheduler uses for
 * due-row selection) was, by construction, born already-due or overdue —
 * exactly the shape of a historical backfill artifact, never of an
 * ordinary freshly-approved contract (whose terminal row is created at
 * approval time, with a trigger date derived from the contract's real
 * final period — always in the future relative to approval, for any
 * contract whose term hasn't already fully elapsed before it was
 * approved). Held rows are never auto-executed unless `backfill_released_at`
 * is set — the one trusted, explicit signal that a human deliberately
 * reviewed and reactivated this specific row (see
 * supabase/migrations/20260830000005_terminal_settlement_backfill_released_at.sql;
 * no code path sets this column yet in this pass — a future deliberate
 * activation mechanism is what would set it, exactly as this repo already
 * defers "explicit activation" to later work for backfill_review).
 *
 * Known legitimate exception, reported rather than silently special-cased:
 * approving a contract whose full term has already elapsed before
 * approval (a genuinely backdated/expired contract pushed through review
 * late) can also produce a freshly-created terminal_settlement row whose
 * trigger date is already in the past — created_at >= period_start would
 * be true for that row too, on its very first, otherwise-ordinary
 * creation. This function does not — and should not — distinguish that
 * case from a backfill artifact: an already-overdue settlement is exactly
 * the shape of row that deserves a deliberate human look before any
 * provider call, regardless of which code path created it, so the guard
 * intentionally holds it rather than being weakened to wave it through.
 */
export function isHeldHistoricalTerminalSettlement(row: {
  invoice_type: string
  status: string
  created_at: string
  period_start: string
  backfill_released_at?: string | null
}): boolean {
  if (row.invoice_type !== 'terminal_settlement') return false
  if (row.status !== 'scheduled') return false
  if (row.backfill_released_at) return false // explicit trusted activation

  // Calendar-date comparison — created_at's UTC calendar date vs.
  // period_start (already a plain YYYY-MM-DD date), matching this
  // codebase's established string-comparison convention for date
  // boundaries (lib/terminal-settlement.ts's
  // classifyBackfillTerminalSettlementStatus).
  const createdDate = row.created_at.slice(0, 10)
  return createdDate >= row.period_start
}
