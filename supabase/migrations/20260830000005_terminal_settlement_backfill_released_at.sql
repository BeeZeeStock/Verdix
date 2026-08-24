-- Trusted-activation marker for the scheduler-side historical-terminal-
-- settlement guard (lib/terminal-settlement-guard.ts's
-- isHeldHistoricalTerminalSettlement, wired into
-- app/api/admin/invoice-scheduler/route.ts). That guard fail-closes on
-- every terminal_settlement row shaped like a historical/late-created
-- backfill artifact (status='scheduled' AND created_at >= period_start) —
-- but a fail-closed guard with no release path would hold such a row
-- forever, even after a human has genuinely reviewed it and decided it
-- should bill. This column is that release path's data half: a nullable
-- timestamp, set ONLY by a future, explicit admin action (deliberately NOT
-- built in this pass — same deferral already stated for backfill_review's
-- own "explicit activation mechanism" in the migration that introduced
-- it) that a human used to deliberately reactivate one specific row.
--
-- Until that action exists, this column is always NULL for every row, and
-- the scheduler guard's behavior is unaffected by this migration — it
-- already treats a missing/undefined value as "not released" (fail
-- closed by default, safe to deploy before this migration is ever
-- applied, and safe to leave with no admin UI for an arbitrarily long
-- time).
alter table planned_invoices
  add column if not exists backfill_released_at timestamptz;

comment on column planned_invoices.backfill_released_at is
  'Set only by a deliberate human admin action reactivating a terminal_settlement row the scheduler-side historical guard (lib/terminal-settlement-guard.ts) would otherwise hold. NULL means not released — the guard fails closed by default.';
