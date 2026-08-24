-- Terminal settlement — SCHEMA ONLY (expand phase). Closes the billing-
-- completeness gap where a finite-term contract's final service period has
-- no next advance-period row to trigger its own arrears usage/minimum/
-- chargeback settlement. See lib/terminal-settlement.ts for the full
-- rationale.
--
-- Release-order audit (2026-08-30) — deliberately split from the terminal-
-- settlement DATA backfill (supabase/migrations/
-- 20260830000003_terminal_settlement_backfill.sql), which must only ever
-- run AFTER this schema change has been applied AND the application code
-- that understands invoice_type='terminal_settlement' has been fully
-- deployed. Confirmed necessary, not just cautious:
--   - lib/billing-writer.ts's computeBillingSchedule INSERTs
--     settlement_period_start/settlement_period_end on every eligible NEW
--     job approval going forward — deploying that code against a database
--     that doesn't have these columns yet would hard-fail every such
--     approval with a Postgres "column does not exist" error.
--   - Symmetrically, the OLD (pre-this-feature) invoice-scheduler cron's
--     own due-row query (`.select('*').eq('status','scheduled')
--     .lte('period_start', today)`) has NO invoice_type filter at all — it
--     would pick up a real terminal_settlement row (a genuine zero-length
--     period_start=period_end day) and attempt to process it as an
--     ordinary period invoice, with no branch anywhere in the old code
--     that knows what a terminal_settlement row even is.
-- This schema-only migration is safe to apply well ahead of the code
-- deploy — it only adds nullable columns and an index/constraint; no
-- existing row is touched, no existing query's behavior changes (no
-- terminal_settlement rows exist yet). The data backfill is not safe until
-- the code is live.
--
-- settlement_period_start/settlement_period_end give a terminal_settlement
-- row a deterministic settlement-target identity, independent of the
-- backward "previous period" lookup ordinary period rows rely on — the
-- scheduler reads these directly rather than inferring the target.
-- period_start/period_end on a terminal_settlement row are used purely as
-- the existing due-row eligibility mechanism (.lte('period_start', today))
-- already expects of every row type — the trigger date (day after
-- settlement_period_end), never a second "October period."
alter table planned_invoices add column if not exists settlement_period_start date;
alter table planned_invoices add column if not exists settlement_period_end date;

comment on column planned_invoices.settlement_period_start is
  'Only set for invoice_type=''terminal_settlement'' rows — the real, final contract-service-period start being settled (e.g. 2027-09-01 for Contract B), never re-derived via backward lookup at execution time.';
comment on column planned_invoices.settlement_period_end is
  'Only set for invoice_type=''terminal_settlement'' rows — the real, final contract-service-period end being settled (e.g. 2027-09-30 for Contract B). Also what a future renewal row''s own prior-period backward-scan must check against to avoid re-settling the same window (see the invoice-scheduler''s own guard).';

-- At most one terminal_settlement row per job, ever — the deterministic
-- guard preventing double settlement (a contract's final period has
-- exactly one real end date, so it needs exactly one terminal row; this
-- is also what protects against a FUTURE renewal-support pass accidentally
-- creating a second one for the same job). Safe to create now — it only
-- constrains future rows, and no row of this invoice_type exists yet.
create unique index if not exists planned_invoices_one_terminal_settlement_per_job_uidx
  on planned_invoices (job_id)
  where invoice_type = 'terminal_settlement';
